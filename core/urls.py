from django.contrib.auth import views as auth_views
from django.urls import path

from . import views

urlpatterns = [
	path("healthz/", views.health_check, name="health-check"),
    path("", views.dashboard, name="dashboard"),
    path("signup/", views.employee_signup, name="employee-signup"),
    path("login/", auth_views.LoginView.as_view(template_name="core/login.html"), name="login"),
    path("logout/", auth_views.LogoutView.as_view(), name="logout"),
    path("admin-portal/", views.admin_portal, name="admin-portal"),
    path("onsite-update/submit/", views.submit_onsite_update, name="submit-onsite-update"),
    path("site-issue/submit/", views.submit_site_issue, name="submit-site-issue"),
    path("messages/submit/", views.submit_direct_message, name="submit-direct-message"),
    path("client-claim/<uuid:token>/", views.claim_client_invite, name="claim-client-invite"),
]
