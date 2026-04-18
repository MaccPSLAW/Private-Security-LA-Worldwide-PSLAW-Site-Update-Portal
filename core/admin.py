from django.contrib import admin

from .models import ClientInvite, Company, DirectMessage, OnsiteUpdate, Profile, Site, SiteAccess, SiteIssue


@admin.register(Company)
class CompanyAdmin(admin.ModelAdmin):
	list_display = ("name", "created_at")
	search_fields = ("name",)


@admin.register(Site)
class SiteAdmin(admin.ModelAdmin):
	list_display = ("name", "company", "manager_representative", "is_active")
	list_filter = ("company", "is_active")
	search_fields = ("name", "address", "manager_representative")


@admin.register(Profile)
class ProfileAdmin(admin.ModelAdmin):
	list_display = ("user", "company", "role", "created_at")
	list_filter = ("role", "company")
	search_fields = ("user__username", "user__email")


@admin.register(SiteAccess)
class SiteAccessAdmin(admin.ModelAdmin):
	list_display = ("profile", "site", "approved_by", "created_at")
	list_filter = ("site__company",)


@admin.register(OnsiteUpdate)
class OnsiteUpdateAdmin(admin.ModelAdmin):
	list_display = ("title", "site", "created_by", "visibility", "occurrence_datetime")
	list_filter = ("site__company", "visibility")
	search_fields = ("title", "details", "general_location")


@admin.register(SiteIssue)
class SiteIssueAdmin(admin.ModelAdmin):
	list_display = ("title", "site", "reported_by", "priority", "status", "created_at")
	list_filter = ("priority", "status", "site__company")
	search_fields = ("title", "description")


@admin.register(DirectMessage)
class DirectMessageAdmin(admin.ModelAdmin):
	list_display = ("subject", "company", "site", "sender", "priority", "is_read", "created_at")
	list_filter = ("priority", "is_read", "company")
	search_fields = ("subject", "body", "sender__user__username")


@admin.register(ClientInvite)
class ClientInviteAdmin(admin.ModelAdmin):
	list_display = ("email", "company", "site", "is_used", "expires_at", "created_at")
	list_filter = ("company", "is_used")
	search_fields = ("email",)
