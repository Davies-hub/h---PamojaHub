"""Account/auth serializers. UserSerializer uses strict allowlist — password,
is_superuser, is_staff, user_permissions, groups must never serialize out.
"""

from django.contrib.auth.password_validation import validate_password as django_validate_password
from rest_framework import serializers

from accounts.models import User


class LoginSerializer(serializers.Serializer):
    """POST /auth/login/. Input validation only; token issuance is the view's job."""

    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, style={'input_type': 'password'})


class PasswordResetRequestSerializer(serializers.Serializer):
    """POST /auth/password-reset/request/."""

    email = serializers.EmailField()


class PasswordResetConfirmSerializer(serializers.Serializer):
    """POST /auth/password-reset/confirm/."""

    email = serializers.EmailField()
    otp_code = serializers.CharField(max_length=10)
    new_password = serializers.CharField(write_only=True, style={'input_type': 'password'})

    def validate_new_password(self, value):
        django_validate_password(value)
        return value


class UserSerializer(serializers.ModelSerializer):
    """Authenticated user representation (login response body, /auth/me).

    MUST NOT include: password, is_superuser, is_staff, user_permissions, groups.
    """

    church_name = serializers.CharField(source='church.name', read_only=True, allow_null=True)

    class Meta:
        model = User
        fields = [
            'id',
            'email',
            'first_name',
            'last_name',
            'role',
            'church',
            'church_name',
        ]
        read_only_fields = fields
