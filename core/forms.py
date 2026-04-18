from django import forms
from django.contrib.auth.models import User

from .models import ClientInvite, Company, DirectMessage, OnsiteUpdate, Profile, Site, SiteAccess, SiteIssue


class EmployeeSignupForm(forms.Form):
    first_name = forms.CharField(max_length=150)
    last_name = forms.CharField(max_length=150)
    email = forms.EmailField()
    username = forms.CharField(max_length=150)
    company = forms.ModelChoiceField(queryset=Company.objects.all())
    password1 = forms.CharField(widget=forms.PasswordInput)
    password2 = forms.CharField(widget=forms.PasswordInput)

    def clean_username(self):
        username = self.cleaned_data["username"]
        if User.objects.filter(username=username).exists():
            raise forms.ValidationError("Username already exists.")
        return username

    def clean(self):
        cleaned = super().clean()
        if cleaned.get("password1") != cleaned.get("password2"):
            raise forms.ValidationError("Passwords do not match.")
        return cleaned

    def save(self):
        user = User.objects.create_user(
            username=self.cleaned_data["username"],
            email=self.cleaned_data["email"],
            password=self.cleaned_data["password1"],
            first_name=self.cleaned_data["first_name"],
            last_name=self.cleaned_data["last_name"],
        )
        Profile.objects.create(user=user, company=self.cleaned_data["company"], role=Profile.ROLE_EMPLOYEE)
        return user


class OnsiteUpdateForm(forms.ModelForm):
    occurrence_datetime = forms.DateTimeField(widget=forms.DateTimeInput(attrs={"type": "datetime-local"}))

    class Meta:
        model = OnsiteUpdate
        fields = [
            "site",
            "occurrence_datetime",
            "general_location",
            "notified_client_staff",
            "title",
            "details",
            "image",
            "visibility",
        ]


class SiteIssueForm(forms.ModelForm):
    class Meta:
        model = SiteIssue
        fields = ["site", "title", "description", "priority"]


class DirectMessageForm(forms.ModelForm):
    class Meta:
        model = DirectMessage
        fields = ["site", "subject", "body", "priority"]


class CompanyForm(forms.ModelForm):
    class Meta:
        model = Company
        fields = ["name", "description"]


class SiteForm(forms.ModelForm):
    class Meta:
        model = Site
        fields = ["company", "name", "address", "manager_representative", "is_active"]


class SiteAccessForm(forms.ModelForm):
    class Meta:
        model = SiteAccess
        fields = ["profile", "site"]


class ClientInviteForm(forms.ModelForm):
    class Meta:
        model = ClientInvite
        fields = ["email", "company", "site", "expires_at"]
        widgets = {
            "expires_at": forms.DateTimeInput(attrs={"type": "datetime-local"}),
        }


class ClientClaimForm(forms.Form):
    full_name = forms.CharField(max_length=255)
    password1 = forms.CharField(widget=forms.PasswordInput)
    password2 = forms.CharField(widget=forms.PasswordInput)

    def clean(self):
        cleaned = super().clean()
        if cleaned.get("password1") != cleaned.get("password2"):
            raise forms.ValidationError("Passwords do not match.")
        return cleaned
