from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import User
from django.core.mail import send_mail
from django.http import HttpResponseForbidden, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils.dateparse import parse_date

from .forms import (
	ClientClaimForm,
	ClientInviteForm,
	CompanyForm,
	DirectMessageForm,
	EmployeeSignupForm,
	OnsiteUpdateForm,
	SiteAccessForm,
	SiteForm,
	SiteIssueForm,
)
from .models import ClientInvite, Company, DirectMessage, OnsiteUpdate, Profile, SiteAccess, SiteIssue


def health_check(request):
	return JsonResponse({"status": "ok"})


def get_profile(user: User) -> Profile | None:
	if not user.is_authenticated:
		return None
	profile, _ = Profile.objects.get_or_create(user=user, defaults={"role": Profile.ROLE_EMPLOYEE})
	return profile


def employee_signup(request):
	if request.user.is_authenticated:
		return redirect("dashboard")
	form = EmployeeSignupForm(request.POST or None)
	if request.method == "POST" and form.is_valid():
		user = form.save()
		login(request, user)
		messages.success(request, "Welcome. Your employee portal is ready.")
		return redirect("dashboard")
	return render(request, "core/employee_signup.html", {"form": form})


def claim_client_invite(request, token):
	invite = get_object_or_404(ClientInvite, token=token)
	if invite.is_used:
		messages.error(request, "This invite link has already been used.")
		return redirect("login")
	if invite.is_expired:
		messages.error(request, "This invite link has expired.")
		return redirect("login")

	form = ClientClaimForm(request.POST or None)
	if request.method == "POST" and form.is_valid():
		name_parts = form.cleaned_data["full_name"].split(" ", 1)
		first_name = name_parts[0]
		last_name = name_parts[1] if len(name_parts) > 1 else ""
		username = invite.email

		if User.objects.filter(username=username).exists():
			user = User.objects.get(username=username)
			user.set_password(form.cleaned_data["password1"])
			user.first_name = first_name
			user.last_name = last_name
			user.email = invite.email
			user.save()
		else:
			user = User.objects.create_user(
				username=username,
				email=invite.email,
				password=form.cleaned_data["password1"],
				first_name=first_name,
				last_name=last_name,
			)

		profile, _ = Profile.objects.get_or_create(
			user=user,
			defaults={"company": invite.company, "role": Profile.ROLE_CLIENT},
		)
		profile.company = invite.company
		profile.role = Profile.ROLE_CLIENT
		profile.save()

		SiteAccess.objects.get_or_create(profile=profile, site=invite.site)
		invite.is_used = True
		invite.save(update_fields=["is_used"])

		login(request, user)
		messages.success(request, "Your client portal has been created.")
		return redirect("dashboard")

	return render(request, "core/claim_client_invite.html", {"form": form, "invite": invite})


@login_required
def dashboard(request):
	profile = get_profile(request.user)
	if not profile:
		return HttpResponseForbidden("Profile unavailable.")

	approved_sites = [item.site for item in SiteAccess.objects.select_related("site").filter(profile=profile)]
	selected_site_id = request.GET.get("site", "").strip()
	start_date = request.GET.get("start_date", "").strip()
	end_date = request.GET.get("end_date", "").strip()
	issue_priority = request.GET.get("issue_priority", "").strip()
	message_priority = request.GET.get("message_priority", "").strip()

	def apply_date_filters(queryset, field_name: str):
		start = parse_date(start_date) if start_date else None
		end = parse_date(end_date) if end_date else None
		if start:
			queryset = queryset.filter(**{f"{field_name}__date__gte": start})
		if end:
			queryset = queryset.filter(**{f"{field_name}__date__lte": end})
		return queryset

	if profile.role in [Profile.ROLE_COMPANY_ADMIN, Profile.ROLE_MANAGER]:
		updates = OnsiteUpdate.objects.select_related("site", "created_by__user").filter(site__company=profile.company)
		issues = SiteIssue.objects.select_related("site", "reported_by__user").filter(site__company=profile.company)
		admin_messages = DirectMessage.objects.select_related("sender__user", "site").filter(company=profile.company)
		if selected_site_id:
			updates = updates.filter(site_id=selected_site_id)
			issues = issues.filter(site_id=selected_site_id)
			admin_messages = admin_messages.filter(site_id=selected_site_id)
		if issue_priority:
			issues = issues.filter(priority=issue_priority)
		if message_priority:
			admin_messages = admin_messages.filter(priority=message_priority)
		updates = apply_date_filters(updates, "occurrence_datetime")
		issues = apply_date_filters(issues, "created_at")
		admin_messages = apply_date_filters(admin_messages, "created_at")
		context = {
			"profile": profile,
			"updates": updates[:15],
			"issues": issues[:15],
			"direct_messages": admin_messages[:20],
			"company_sites": profile.company.sites.filter(is_active=True),
			"selected_site_id": selected_site_id,
			"start_date": start_date,
			"end_date": end_date,
			"issue_priority": issue_priority,
			"message_priority": message_priority,
			"site_access_count": SiteAccess.objects.filter(site__company=profile.company).count(),
		}
		return render(request, "core/dashboard_admin.html", context)

	if profile.role == Profile.ROLE_CLIENT:
		updates = OnsiteUpdate.objects.select_related("site", "created_by__user").filter(
			site__in=approved_sites,
			visibility=OnsiteUpdate.VISIBILITY_CLIENT,
		)
		sent_messages = DirectMessage.objects.select_related("site").filter(sender=profile)
		if selected_site_id:
			updates = updates.filter(site_id=selected_site_id)
			sent_messages = sent_messages.filter(site_id=selected_site_id)
		if message_priority:
			sent_messages = sent_messages.filter(priority=message_priority)
		updates = apply_date_filters(updates, "occurrence_datetime")
		sent_messages = apply_date_filters(sent_messages, "created_at")
		message_form = DirectMessageForm()
		message_form.fields["site"].queryset = profile.company.sites.filter(id__in=[s.id for s in approved_sites])
		context = {
			"profile": profile,
			"approved_sites": approved_sites,
			"updates": updates[:30],
			"sent_messages": sent_messages[:15],
			"message_form": message_form,
			"selected_site_id": selected_site_id,
			"start_date": start_date,
			"end_date": end_date,
			"message_priority": message_priority,
		}
		return render(request, "core/dashboard_client.html", context)

	updates = OnsiteUpdate.objects.select_related("site").filter(site__in=approved_sites)
	issues = SiteIssue.objects.select_related("site").filter(site__in=approved_sites)
	if selected_site_id:
		updates = updates.filter(site_id=selected_site_id)
		issues = issues.filter(site_id=selected_site_id)
	if issue_priority:
		issues = issues.filter(priority=issue_priority)
	updates = apply_date_filters(updates, "occurrence_datetime")
	issues = apply_date_filters(issues, "created_at")
	update_form = OnsiteUpdateForm()
	issue_form = SiteIssueForm()
	update_form.fields["site"].queryset = profile.company.sites.filter(id__in=[s.id for s in approved_sites])
	issue_form.fields["site"].queryset = profile.company.sites.filter(id__in=[s.id for s in approved_sites])

	context = {
		"profile": profile,
		"approved_sites": approved_sites,
		"updates": updates[:20],
		"issues": issues[:20],
		"update_form": update_form,
		"issue_form": issue_form,
		"selected_site_id": selected_site_id,
		"start_date": start_date,
		"end_date": end_date,
		"issue_priority": issue_priority,
	}
	return render(request, "core/dashboard_employee.html", context)


@login_required
def admin_portal(request):
	profile = get_profile(request.user)
	if not profile or profile.role not in [Profile.ROLE_COMPANY_ADMIN, Profile.ROLE_MANAGER]:
		return HttpResponseForbidden("Only managers or company admins can access this area.")

	company_form = CompanyForm(request.POST or None, prefix="company")
	site_form = SiteForm(request.POST or None, prefix="site")
	access_form = SiteAccessForm(request.POST or None, prefix="access")
	invite_form = ClientInviteForm(request.POST or None, prefix="invite")

	if request.method == "POST":
		action = request.POST.get("action")
		if action == "company" and company_form.is_valid():
			company_form.save()
			messages.success(request, "Company created.")
			return redirect("admin-portal")
		if action == "site" and site_form.is_valid():
			site_form.save()
			messages.success(request, "Site created.")
			return redirect("admin-portal")
		if action == "access" and access_form.is_valid():
			access = access_form.save(commit=False)
			access.approved_by = request.user
			access.save()
			messages.success(request, "User approved for site.")
			return redirect("admin-portal")
		if action == "invite" and invite_form.is_valid():
			invite = invite_form.save(commit=False)
			invite.created_by = request.user
			invite.save()
			claim_url = request.build_absolute_uri(f"/client-claim/{invite.token}/")
			send_mail(
				subject="Your PSLAW Client Portal Invite",
				message=(
					"You have been invited to access the PSLAW client portal.\n\n"
					f"Company: {invite.company.name}\n"
					f"Approved Site: {invite.site.name}\n"
					f"Activate your account here: {claim_url}\n\n"
					"If you did not expect this invite, please contact your security provider."
				),
				from_email=None,
				recipient_list=[invite.email],
				fail_silently=True,
			)
			messages.success(request, f"Client invite created and emailed. Claim link: {claim_url}")
			return redirect("admin-portal")

	company_scope = profile.company

	if company_scope:
		site_form.fields["company"].queryset = type(company_scope).objects.filter(pk=company_scope.pk)
		access_form.fields["profile"].queryset = Profile.objects.filter(company=company_scope)
		access_form.fields["site"].queryset = company_scope.sites.all()
		invite_form.fields["company"].queryset = type(company_scope).objects.filter(pk=company_scope.pk)
		invite_form.fields["site"].queryset = company_scope.sites.all()

	context = {
		"profile": profile,
		"company_form": company_form,
		"site_form": site_form,
		"access_form": access_form,
		"invite_form": invite_form,
		"companies": Company.objects.filter(pk=company_scope.pk) if company_scope else Company.objects.none(),
		"sites": profile.company.sites.all() if company_scope else [],
		"site_access": SiteAccess.objects.select_related("profile__user", "site").filter(site__company=company_scope) if company_scope else [],
		"invites": ClientInvite.objects.filter(company=company_scope) if company_scope else [],
	}
	return render(request, "core/admin_portal.html", context)


@login_required
def submit_onsite_update(request):
	profile = get_profile(request.user)
	if not profile or profile.role not in [Profile.ROLE_EMPLOYEE, Profile.ROLE_MANAGER, Profile.ROLE_COMPANY_ADMIN]:
		return HttpResponseForbidden("Not allowed.")
	if request.method != "POST":
		return HttpResponseForbidden("Invalid request method.")
	form = OnsiteUpdateForm(request.POST, request.FILES)
	if form.is_valid():
		update = form.save(commit=False)
		if not profile.company or update.site.company_id != profile.company_id:
			return HttpResponseForbidden("Site is outside your company scope.")
		if not SiteAccess.objects.filter(profile=profile, site=update.site).exists() and profile.role == Profile.ROLE_EMPLOYEE:
			return HttpResponseForbidden("You are not approved for this site.")
		update.created_by = profile
		update.save()
		messages.success(request, "Onsite update posted.")
	else:
		messages.error(request, "Unable to post update. Please check the form.")
	return redirect("dashboard")


@login_required
def submit_site_issue(request):
	profile = get_profile(request.user)
	if not profile or profile.role not in [Profile.ROLE_EMPLOYEE, Profile.ROLE_MANAGER, Profile.ROLE_COMPANY_ADMIN]:
		return HttpResponseForbidden("Not allowed.")
	if request.method != "POST":
		return HttpResponseForbidden("Invalid request method.")
	form = SiteIssueForm(request.POST)
	if form.is_valid():
		issue = form.save(commit=False)
		if not profile.company or issue.site.company_id != profile.company_id:
			return HttpResponseForbidden("Site is outside your company scope.")
		if not SiteAccess.objects.filter(profile=profile, site=issue.site).exists() and profile.role == Profile.ROLE_EMPLOYEE:
			return HttpResponseForbidden("You are not approved for this site.")
		issue.reported_by = profile
		issue.save()
		messages.success(request, "Site issue submitted.")
	else:
		messages.error(request, "Unable to submit issue. Please check the form.")
	return redirect("dashboard")


@login_required
def submit_direct_message(request):
	profile = get_profile(request.user)
	if not profile:
		return HttpResponseForbidden("Profile unavailable.")
	if request.method != "POST":
		return HttpResponseForbidden("Invalid request method.")

	form = DirectMessageForm(request.POST)
	if form.is_valid():
		message = form.save(commit=False)
		if profile.role == Profile.ROLE_CLIENT:
			approved = SiteAccess.objects.filter(profile=profile, site=message.site).exists()
			if not approved:
				return HttpResponseForbidden("You are not approved for this site.")
		else:
			if not profile.company or message.site.company_id != profile.company_id:
				return HttpResponseForbidden("Site is outside your company scope.")
		message.sender = profile
		message.company = profile.company
		message.save()
		messages.success(request, "Message sent to management.")
	else:
		messages.error(request, "Unable to send message.")
	return redirect("dashboard")
