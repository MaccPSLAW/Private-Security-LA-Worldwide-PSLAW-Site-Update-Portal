import uuid
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone


def default_invite_expiry():
	return timezone.now() + timedelta(days=14)


class TimestampedModel(models.Model):
	created_at = models.DateTimeField(auto_now_add=True)
	updated_at = models.DateTimeField(auto_now=True)

	class Meta:
		abstract = True


class Company(TimestampedModel):
	name = models.CharField(max_length=180, unique=True)
	description = models.TextField(blank=True)

	class Meta:
		ordering = ["name"]

	def __str__(self) -> str:
		return self.name


class Site(TimestampedModel):
	company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name="sites")
	name = models.CharField(max_length=180)
	address = models.CharField(max_length=300)
	manager_representative = models.CharField(max_length=180)
	is_active = models.BooleanField(default=True)

	class Meta:
		unique_together = ("company", "name")
		ordering = ["company__name", "name"]

	def __str__(self) -> str:
		return f"{self.company.name} - {self.name}"


class Profile(TimestampedModel):
	ROLE_COMPANY_ADMIN = "company_admin"
	ROLE_MANAGER = "manager"
	ROLE_EMPLOYEE = "employee"
	ROLE_CLIENT = "client"
	ROLE_CHOICES = [
		(ROLE_COMPANY_ADMIN, "Company Admin"),
		(ROLE_MANAGER, "Manager"),
		(ROLE_EMPLOYEE, "Employee"),
		(ROLE_CLIENT, "Client"),
	]

	user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="profile")
	company = models.ForeignKey(Company, on_delete=models.SET_NULL, null=True, blank=True, related_name="profiles")
	role = models.CharField(max_length=24, choices=ROLE_CHOICES, default=ROLE_EMPLOYEE)

	class Meta:
		ordering = ["user__username"]

	def __str__(self) -> str:
		company_name = self.company.name if self.company else "No Company"
		return f"{self.user.get_username()} ({self.role}) @ {company_name}"


class SiteAccess(TimestampedModel):
	profile = models.ForeignKey(Profile, on_delete=models.CASCADE, related_name="site_access")
	site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="approved_profiles")
	approved_by = models.ForeignKey(
		settings.AUTH_USER_MODEL,
		on_delete=models.SET_NULL,
		null=True,
		blank=True,
		related_name="site_approvals",
	)

	class Meta:
		unique_together = ("profile", "site")
		ordering = ["site__name", "profile__user__username"]

	def __str__(self) -> str:
		return f"{self.profile.user.get_username()} -> {self.site}"


class OnsiteUpdate(TimestampedModel):
	VISIBILITY_CLIENT = "client_visible"
	VISIBILITY_INTERNAL = "internal_only"
	VISIBILITY_CHOICES = [
		(VISIBILITY_CLIENT, "Client Visible"),
		(VISIBILITY_INTERNAL, "Internal Only"),
	]

	created_by = models.ForeignKey(Profile, on_delete=models.CASCADE, related_name="onsite_updates")
	site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="onsite_updates")
	occurrence_datetime = models.DateTimeField()
	general_location = models.CharField(max_length=180)
	notified_client_staff = models.CharField(max_length=180, blank=True)
	title = models.CharField(max_length=200)
	details = models.TextField()
	image = models.ImageField(upload_to="onsite_updates/", blank=True, null=True)
	visibility = models.CharField(max_length=24, choices=VISIBILITY_CHOICES, default=VISIBILITY_INTERNAL)

	class Meta:
		ordering = ["-occurrence_datetime", "-created_at"]

	def __str__(self) -> str:
		return f"{self.site.name}: {self.title}"


class SiteIssue(TimestampedModel):
	PRIORITY_HIGH = "high"
	PRIORITY_MED = "med"
	PRIORITY_LOW = "low"
	PRIORITY_GENERAL = "general"
	PRIORITY_CHOICES = [
		(PRIORITY_HIGH, "High"),
		(PRIORITY_MED, "Medium"),
		(PRIORITY_LOW, "Low"),
		(PRIORITY_GENERAL, "General"),
	]

	STATUS_OPEN = "open"
	STATUS_RESOLVED = "resolved"
	STATUS_CHOICES = [
		(STATUS_OPEN, "Open"),
		(STATUS_RESOLVED, "Resolved"),
	]

	reported_by = models.ForeignKey(Profile, on_delete=models.CASCADE, related_name="site_issues")
	site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="site_issues")
	title = models.CharField(max_length=200)
	description = models.TextField()
	priority = models.CharField(max_length=12, choices=PRIORITY_CHOICES, default=PRIORITY_GENERAL)
	status = models.CharField(max_length=12, choices=STATUS_CHOICES, default=STATUS_OPEN)

	class Meta:
		ordering = ["-created_at"]

	def __str__(self) -> str:
		return f"[{self.priority}] {self.site.name}: {self.title}"


class DirectMessage(TimestampedModel):
	PRIORITY_HIGH = "high"
	PRIORITY_MED = "med"
	PRIORITY_LOW = "low"
	PRIORITY_GENERAL = "general"
	PRIORITY_CHOICES = [
		(PRIORITY_HIGH, "High"),
		(PRIORITY_MED, "Medium"),
		(PRIORITY_LOW, "Low"),
		(PRIORITY_GENERAL, "General"),
	]

	sender = models.ForeignKey(Profile, on_delete=models.CASCADE, related_name="sent_messages")
	company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name="messages")
	site = models.ForeignKey(Site, on_delete=models.SET_NULL, null=True, blank=True, related_name="messages")
	subject = models.CharField(max_length=200)
	body = models.TextField()
	priority = models.CharField(max_length=12, choices=PRIORITY_CHOICES, default=PRIORITY_GENERAL)
	is_read = models.BooleanField(default=False)

	class Meta:
		ordering = ["is_read", "-created_at"]

	def __str__(self) -> str:
		return f"{self.sender.user.get_username()} - {self.subject}"


class ClientInvite(TimestampedModel):
	email = models.EmailField()
	company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name="client_invites")
	site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="client_invites")
	token = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
	created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True)
	expires_at = models.DateTimeField(default=default_invite_expiry)
	is_used = models.BooleanField(default=False)

	class Meta:
		ordering = ["-created_at"]
		unique_together = ("email", "site", "is_used")

	@property
	def is_expired(self) -> bool:
		return timezone.now() > self.expires_at

	def __str__(self) -> str:
		return f"Invite for {self.email} ({self.site.name})"
