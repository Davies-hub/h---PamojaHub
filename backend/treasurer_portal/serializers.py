"""Campaign Treasurer phone-portal serializers (OTP request/verify + campaign picker).

PortalCampaignSerializer is church-facing (post-OTP authenticated), so wallet_balance
IS allowed here — unlike PublicCampaignSerializer. treasurer_phone / treasurer_name
are NOT included: the treasurer already knows their own phone, and keeping the
sensitive field out of yet another serializer reduces leak surface.
"""

from rest_framework import serializers

from common.validators import validate_safaricom_phone
from campaigns.models import Campaign


class OTPRequestSerializer(serializers.Serializer):
    """POST /api/v1/treasurer/request-otp/.

    Request and verify MUST normalize phone identically — the OTP record is keyed by
    normalized phone; a format mismatch between request and verify breaks the lookup.
    Both serializers route phone_number through validate_safaricom_phone via the
    method form (validators=[...] would discard the normalization return value).
    """

    phone_number = serializers.CharField(max_length=20)

    def validate_phone_number(self, value):
        return validate_safaricom_phone(value)


class OTPVerifySerializer(serializers.Serializer):
    """POST /api/v1/treasurer/verify-otp/.

    Phone normalization must use the SAME function as OTPRequestSerializer (see comment
    on that class). The OTP lookup is `phone_number=normalized_value`; any drift
    between the two normalizations (e.g. one normalized, one not) produces a silent
    no-match and the user sees an invalid-OTP error for a code that's actually correct.
    """

    phone_number = serializers.CharField(max_length=20)
    otp_code = serializers.CharField(min_length=6, max_length=6)

    def validate_phone_number(self, value):
        return validate_safaricom_phone(value)


class PortalCampaignSerializer(serializers.ModelSerializer):
    """Campaign picker / scoped campaign view after OTP verification.

    raised_amount and wallet_balance are both NET per Net-Everywhere.
    treasurer_phone / treasurer_name explicitly NOT in the allowlist.
    """

    church_name = serializers.CharField(source='church.name', read_only=True)

    class Meta:
        model = Campaign
        fields = [
            'id',
            'title',
            'church_name',
            'status',
            'raised_amount',
            'wallet_balance',
        ]
        read_only_fields = fields
