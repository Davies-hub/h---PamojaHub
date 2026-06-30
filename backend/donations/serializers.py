"""Donation serializers — three distinct surfaces with different Net-Everywhere semantics:

  * DonationInitiateSerializer  → donor input;            amount = GROSS
  * DonationStatusSerializer    → donor success screen;   amount = GROSS (matches SMS)
  * AdminDonationSerializer     → admin/treasurer view;   exposes gross/fee/net
  * PortalDonationReportSerializer → treasurer portal;    amount = NET (Net-Everywhere)
"""

from rest_framework import serializers

from common.validators import validate_safaricom_phone
from donations.models import Donation


class DonationInitiateSerializer(serializers.Serializer):
    """POST /donations/initiate/ — donor inputs that kick off STK push.

    amount is GROSS (what the donor sends from M-Pesa). platform_fee/net_amount are
    NOT computed here — they stay null until the STK callback confirms and reads
    the live PlatformSettings.fee_percent.
    """

    campaign_slug = serializers.SlugField()
    # NOTE: phone normalization uses validate_<field> method form (NOT validators=[...]).
    # DRF discards the return value from field-level validators; only validate_<field>
    # methods replace the field value with the normalized return — required so the
    # donor's M-Pesa-bound number is the 254XXXXXXXXX form STK push expects.
    phone_number = serializers.CharField(max_length=20)
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=5)
    donor_name = serializers.CharField(max_length=255, required=False, allow_blank=True)
    donor_email = serializers.EmailField(required=False, allow_blank=True)

    def validate_phone_number(self, value):
        return validate_safaricom_phone(value)


class DonationStatusSerializer(serializers.ModelSerializer):
    """GET /donations/{id}/status/ — polled by the donor's success screen.

    GROSS amount — donor-facing success screen, Net-Everywhere exception (must match
    the donor's M-Pesa SMS).

    MUST NOT include: platform_fee, net_amount, checkout_request_id, b2c_conversation_id.
    """

    class Meta:
        model = Donation
        fields = [
            'id',
            'status',
            'mpesa_receipt_number',
            'amount',
        ]


class AdminDonationSerializer(serializers.ModelSerializer):
    """Church Treasurer donation history + Super Admin donations table.

    D1 NARROW (was '__all__'): explicit allowlist. The Super Admin Donations table
    needs the gross / platform_fee / net_amount breakdown per PRD §8.6, plus
    campaign_title + church_name (read-only, via the campaign FK) to label each row.
    It does NOT need the donor's contact details or internal correlation ids, so the
    over-emitted fields are DROPPED at the serializer: phone_number, donor_email,
    checkout_request_id (Coding Rule 3), the raw campaign FK id, and confirmed_at.
    This is a read-only surface (donations are written via DonationInitiateSerializer
    + the STK callback, never here), so read_only_fields = fields mirrors
    WithdrawalSerializer's style. (Contrast PortalDonationReportSerializer, the
    donor-privacy-limited treasurer feed, which also omits gross/fee/phone.)
    """

    campaign_title = serializers.CharField(source='campaign.title', read_only=True)
    church_name = serializers.CharField(source='campaign.church.name', read_only=True)

    class Meta:
        model = Donation
        fields = (
            'id',
            'campaign_title',
            'church_name',
            'mpesa_receipt_number',
            'donor_name',
            'status',
            'created_at',
            'amount',
            'platform_fee',
            'net_amount',
        )
        read_only_fields = fields


class PortalDonationReportSerializer(serializers.ModelSerializer):
    """Campaign Treasurer portal donation report (GET /treasurer/campaigns/{id}/report/).

    amount = net_amount per Net-Everywhere; portal is church-facing. The phone-gated
    Campaign Treasurer sees what the church is keeping, not what the donor sent.

    MUST NOT include: phone_number (donor privacy — donor_name only), platform_fee,
    gross amount, checkout_request_id, b2c_conversation_id.

    campaign_title (read-only, via the campaign FK) is added so the treasurer
    dashboard's recent-donations feed can label which campaign each gift went to.
    It exposes only the public-safe title — no new donor/money disclosure.
    """

    amount = serializers.DecimalField(
        source='net_amount',
        max_digits=12,
        decimal_places=2,
        read_only=True,
    )
    campaign_title = serializers.CharField(source='campaign.title', read_only=True)

    class Meta:
        model = Donation
        fields = [
            'mpesa_receipt_number',
            'donor_name',
            'amount',
            'campaign_title',
            'created_at',
        ]
