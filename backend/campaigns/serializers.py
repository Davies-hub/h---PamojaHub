"""Campaign serializers. Public allowlist is the sharpest boundary in the system —
forbidden public fields per Coding Rule 3: treasurer_phone, treasurer_name,
wallet_balance, checkout_request_id, b2c_conversation_id.
"""

import bleach
from rest_framework import serializers

from common.validators import validate_safaricom_phone
from campaigns.models import Campaign, CampaignUpdate, GroupLabel
from donations.models import Donation, DonationStatus


# HTML sanitization allowlist for AdminCampaignSerializer.description (Coding Rule 7).
# Strip-mode True drops disallowed tags rather than escaping them so the stored text is
# always renderable. CampaignUpdate.body uses tags=[] to enforce plain text.
ALLOWED_TAGS = ['p', 'b', 'i', 'strong', 'em', 'ul', 'ol', 'li', 'a', 'h2', 'h3', 'br']
ALLOWED_ATTRS = {'a': ['href']}
ALLOWED_PROTOCOLS = ['http', 'https']


class PublicCampaignSerializer(serializers.ModelSerializer):
    """GET /campaigns/ and GET /campaigns/{slug}/. Allowlist only.

    raised_amount here is the NET figure per Net-Everywhere (model stores net at write
    time — sum of donation.net_amount). No transformation needed; donor sees the same
    net total the church sees on its dashboard.

    ABSOLUTELY NOT in fields: treasurer_phone, treasurer_name, wallet_balance,
    checkout_request_id, b2c_conversation_id, church (raw FK id), created_by.
    """

    church_name = serializers.CharField(source='church.name', read_only=True)
    group_label_name = serializers.CharField(
        source='group_label.name',
        read_only=True,
        allow_null=True,
    )
    donor_count = serializers.SerializerMethodField()

    class Meta:
        model = Campaign
        fields = [
            'id',
            'slug',
            'church_name',
            'group_label_name',
            'title',
            'description',
            'goal_amount',
            'raised_amount',
            'donor_count',
            'status',
            'banner_image_url',
            'category',
            'created_at',
        ]

    def get_donor_count(self, obj):
        return Donation.objects.filter(
            campaign=obj,
            status=DonationStatus.SUCCESSFUL,
        ).count()


class AdminCampaignSerializer(serializers.ModelSerializer):
    """Church Treasurer's own campaign management surface. '__all__' is appropriate —
    treasurer_phone / treasurer_name / wallet_balance are the user's own data.

    slug, raised_amount, wallet_balance are server-managed (never client-supplied).

    group_label_name (read-only) mirrors PublicCampaignSerializer so the treasurer
    campaign list can show the group's NAME, not just the FK id. With fields='__all__'
    an explicitly-declared field is included in addition to every model field, so
    group_label (the id) and all existing fields remain present.
    """

    group_label_name = serializers.CharField(
        source='group_label.name',
        read_only=True,
        allow_null=True,
    )
    # church_name + donor_count mirror PublicCampaignSerializer so the Super Admin
    # campaigns list (/super/campaigns/) can label the owning church and show the
    # supporter count. With fields='__all__' these declared fields are ADDED to
    # every model field, so church (FK id), wallet_balance, treasurer_phone,
    # group_label_name, etc. ALL remain present. donor_count reuses the EXACT
    # public logic (count of SUCCESSFUL donations).
    church_name = serializers.CharField(source='church.name', read_only=True)
    donor_count = serializers.SerializerMethodField()

    # goal_amount: clean serializer-level floor. Without min_value a goal of 0/negative
    # passes serializer validation and only trips the DB CheckConstraint
    # (campaign_goal_positive) inside the create view's slug-retry loop, which swallows
    # the IntegrityError and surfaces a misleading 503. min_value gives a 400
    # {"goal_amount": [...]} field-error instead. Mirrors donations/withdrawals
    # serializer amount bounds (min_value style).
    goal_amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=1)
    # banner_image_url: SERVER-SET-ONLY. Image upload is a server-side feature (a
    # later slice adds the upload endpoint that sets this URL). The client must never
    # write it — a client-supplied URL would let a treasurer point a public campaign
    # banner at an arbitrary external image (phishing / content injection). read_only=True
    # on the declaration makes DRF silently DROP any client value (no 400), so create/edit
    # bodies that still include the key keep working — the URL is just ignored.
    banner_image_url = serializers.URLField(read_only=True)  # server-set only (upload endpoint); never client-writable

    class Meta:
        model = Campaign
        fields = '__all__'
        # Server-controlled fields — never client-supplied. `church` is set from
        # request.user.church in the create view; allowing it to be writable would
        # let a treasurer claim a campaign belongs to another church (their own
        # creation would still go to their church via the view override, but
        # making it read-only is defence-in-depth and removes the "required" check
        # that was breaking creates). Status transitions go through dedicated
        # pause/resume/close endpoints — `status` is writable here only so the
        # admin serializer can REPRESENT status; the edit view rejects status in
        # request.data explicitly.
        read_only_fields = [
            'id',
            'slug',
            'raised_amount',
            'wallet_balance',
            'created_at',
            'closed_at',
            'created_by',
            'church',
            # document_url: SERVER-SET-ONLY (same rationale as banner_image_url above).
            # A treasurer-writable URL rendered on the public campaign page is an
            # arbitrary-URL injection vector; DRF silently drops any client value.
            'document_url',
        ]

    def get_donor_count(self, obj):
        # Identical behavior to PublicCampaignSerializer.get_donor_count.
        return Donation.objects.filter(
            campaign=obj,
            status=DonationStatus.SUCCESSFUL,
        ).count()

    def validate_description(self, value):
        return bleach.clean(
            value,
            tags=ALLOWED_TAGS,
            attributes=ALLOWED_ATTRS,
            protocols=ALLOWED_PROTOCOLS,
            strip=True,
        )

    def validate_treasurer_phone(self, value):
        return validate_safaricom_phone(value)


class SuperCampaignSerializer(serializers.ModelSerializer):
    """READ-ONLY serializer for the Super Admin campaigns LIST (/super/campaigns/).

    D1: AdminCampaignSerializer ('__all__') is the treasurer create/edit WRITE
    serializer and MUST keep treasurer_phone/treasurer_name/group_label in fields,
    so it cannot be narrowed. This separate read-only serializer closes the
    over-emission on the super surface instead: treasurer_phone / treasurer_name /
    created_by / the raw church + group_label FK ids / closed_at are NOT included.

    wallet_balance IS kept (it is in the union KEEP); the FE's mapPublicCampaign
    drops it at the boundary anyway, so retaining it server-side is harmless.

    group_label_name / church_name / donor_count mirror AdminCampaignSerializer's
    declarations verbatim so they resolve identically (group label NAME not id,
    owning church name, SUCCESSFUL-only supporter count).
    """

    group_label_name = serializers.CharField(
        source='group_label.name',
        read_only=True,
        allow_null=True,
    )
    church_name = serializers.CharField(source='church.name', read_only=True)
    donor_count = serializers.SerializerMethodField()

    class Meta:
        model = Campaign
        fields = (
            'id',
            'slug',
            'title',
            'status',
            'description',
            'category',
            'goal_amount',
            'raised_amount',
            'wallet_balance',
            'group_label_name',
            'church_name',
            'donor_count',
            'banner_image_url',
            'document_url',
            'created_at',
        )
        read_only_fields = fields

    def get_donor_count(self, obj):
        # Identical behavior to PublicCampaignSerializer/AdminCampaignSerializer.
        return Donation.objects.filter(
            campaign=obj,
            status=DonationStatus.SUCCESSFUL,
        ).count()


class GroupLabelSerializer(serializers.ModelSerializer):
    """Church-Treasurer-only (not public). Single serializer; no public counterpart."""

    active_campaign_count = serializers.SerializerMethodField()

    class Meta:
        model = GroupLabel
        fields = [
            'id',
            'name',
            'parent_label',
            'is_archived',
            'active_campaign_count',
            'created_at',
        ]
        read_only_fields = ['id', 'created_at']

    def get_active_campaign_count(self, obj):
        return Campaign.objects.filter(
            group_label=obj,
            status='ACTIVE',
        ).count()


class CampaignUpdateSerializer(serializers.ModelSerializer):
    """Campaign progress updates (PRD 9.7). Body is plain text — stripped of all HTML
    in validate_body() because it is rendered on the public campaign page.
    """

    posted_by = serializers.SerializerMethodField()

    class Meta:
        model = CampaignUpdate
        fields = [
            'id',
            'body',
            'posted_by',
            'created_at',
        ]
        read_only_fields = ['id', 'posted_by', 'created_at']

    def get_posted_by(self, obj):
        if obj.posted_by is None:
            return None
        return f"{obj.posted_by.first_name} {obj.posted_by.last_name}".strip()

    def validate_body(self, value):
        # Plain text only — strip every tag. Defence-in-depth against an admin pasting
        # rich HTML into what the PRD specifies as a plain-text body.
        return bleach.clean(value, tags=[], strip=True)
