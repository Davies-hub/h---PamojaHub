"""Church serializers — public surface uses strict allowlist; admin surface uses '__all__'.

Public/admin split is a SECURITY boundary (Build Guide Coding Rule 3, Compressed Context
Section 11 item 8). Public allowlists fail safe — a new sensitive Church field added
later cannot leak through PublicChurchSerializer because the allowlist won't mention it.
"""

from decimal import Decimal

from django.contrib.auth.password_validation import validate_password
from django.db.models import Sum
from django.db.models.functions import Coalesce
from rest_framework import serializers

from campaigns.models import Campaign, CampaignStatus
from churches.models import Church, SubscriptionTier
from common.validators import validate_safaricom_phone


class ChurchRegistrationSerializer(serializers.Serializer):
    """Registers a Church (status=PENDING) AND a Church Treasurer user in one POST.

    Field validation only — the view (Step 2.7) splits these into Church.create()
    plus User.objects.create_user() inside a transaction. No model instances are
    created here.
    """

    # Church fields. REQUIRED: name, official_email, phone, address, denomination.
    # county is OPTIONAL (decision: not collected at registration).
    # NOTE: `address` stays REQUIRED here — the frontend labels it "(optional)" but
    # the backend has always required it; not silently changed (flagged at checkpoint).
    name = serializers.CharField(max_length=255)
    official_email = serializers.EmailField()
    phone = serializers.CharField(max_length=20)
    address = serializers.CharField()
    county = serializers.CharField(max_length=100, required=False, allow_null=True, allow_blank=True)
    denomination = serializers.CharField(max_length=100)

    # User fields (Church Treasurer being created alongside the Church). first/last
    # name are OPTIONAL (B3 — only the church name is collected at registration).
    first_name = serializers.CharField(max_length=100, required=False, allow_blank=True, default='')
    last_name = serializers.CharField(max_length=100, required=False, allow_blank=True, default='')
    password = serializers.CharField(write_only=True, style={'input_type': 'password'})

    def validate_official_email(self, value):
        # User check first — User.email is the LOGIN CREDENTIAL and is independently
        # unique=True. A pre-existing User without a matching Church (Super Admin
        # account, manual creation, prior partial state) would otherwise pass this
        # serializer and crash at User.objects.create_user with IntegrityError → 500.
        # The Church check stays as defence in depth; both branches give a clean 400.
        # Local import: avoids a module-load cycle between churches.serializers and
        # accounts.models. The import is cached on first call so the per-request cost
        # is negligible.
        from accounts.models import User
        if User.objects.filter(email=value).exists():
            raise serializers.ValidationError(
                "An account with this email already exists."
            )
        if Church.objects.filter(official_email=value).exists():
            raise serializers.ValidationError(
                "A church with this official email is already registered."
            )
        return value

    def validate_phone(self, value):
        # Normalize to the bare 254XXXXXXXXX form the rest of the system uses
        # (campaign.treasurer_phone, donations, B2C). Fixes the register-stores-raw
        # bug where church.phone kept 0712… while everything else was 254….
        return validate_safaricom_phone(value)

    def validate_password(self, value):
        validate_password(value)
        return value


class PublicChurchSerializer(serializers.ModelSerializer):
    """Used by GET /churches/ and GET /churches/{id}/. Allowlist only.

    MUST NOT include: official_email, phone, address, status, subscription_tier,
    subscription_expires_at — church-internal fields. The donor browsing the public
    directory has no need for the church's email or subscription state.
    """

    active_campaign_count = serializers.SerializerMethodField()

    class Meta:
        model = Church
        fields = [
            'id',
            'name',
            'county',
            'denomination',
            'logo_url',
            'description',
            'active_campaign_count',
        ]

    def get_active_campaign_count(self, obj):
        return Campaign.objects.filter(church=obj, status=CampaignStatus.ACTIVE).count()


class AdminChurchSerializer(serializers.ModelSerializer):
    """Authenticated Church Treasurer's own church (GET/PATCH /churches/me/).

    Full fields appropriate here, but: official_email is read-only on PATCH
    (login email changes are a separate flow); status / subscription_tier /
    subscription_expires_at are Super-Admin-only.

    Two derived per-row aggregates for the Super-Admin Churches screen:
    `active_campaign_count` and `total_raised`. SHARED serializer — used by the
    Super churches LIST (annotated queryset), the pending queue, the church
    approve/reject/suspend/reinstate write-responses, AND the treasurer's own
    /churches/me/. Only the LIST annotates, so these are SerializerMethodFields
    that PREFER the queryset annotation and fall back to a per-object query when
    it is absent (single church / low-volume pending) — never AttributeError, and
    a church with no campaigns yields 0 / "0.00", not null. total_raised is a
    Decimal string (2dp), consistent with every other money field on the wire.
    """

    active_campaign_count = serializers.SerializerMethodField()
    total_raised = serializers.SerializerMethodField()

    class Meta:
        model = Church
        # D1 NARROW (was '__all__'): explicit allowlist. Drops rejection_reason ONLY —
        # it is sensitive (set on reject), unread by the FE on any church object (the
        # rejected treasurer reads it via the dedicated church_rejection_reason field
        # on /auth/me/, accounts.views._auth_user_payload, NOT through this serializer),
        # and because '__all__' left it OUT of read_only_fields it was a treasurer
        # write-hole on PATCH /churches/me/ — narrowing closes that. Every other model
        # field is RETAINED, including the writable profile fields (name, denomination,
        # phone, address, county, description, logo_url) so the treasurer PATCH still
        # works, plus subscription_expires_at + logo_url (kept per product decision).
        # active_campaign_count + total_raised are SerializerMethodFields — read-only by
        # construction; they are NOT listed in read_only_fields (DRF rejects a declared
        # field that also appears there).
        fields = (
            'id',
            'name',
            'denomination',
            'official_email',
            'phone',
            'address',
            'county',
            'description',
            'status',
            'subscription_tier',
            'subscription_expires_at',
            # Auto-renew opt-out flag — surfaced so the treasurer's own subscription card
            # can render its CANCELLED state. READ-ONLY here (in read_only_fields below):
            # the flag is set ONLY through the dedicated, audited POST /subscriptions/cancel/
            # endpoint, never via a PATCH /churches/me/ profile write (would be a write-hole
            # bypassing the audit, same class the rejection_reason narrowing closed).
            'subscription_cancel_requested',
            'logo_url',
            'created_at',
            'active_campaign_count',
            'total_raised',
        )
        read_only_fields = [
            'id',
            'created_at',
            'official_email',
            'status',
            'subscription_tier',
            'subscription_expires_at',
            'subscription_cancel_requested',
            # logo_url is SERVER-SET-ONLY (uploaded via a dedicated endpoint, a later
            # slice). Locking it here closes the PATCH /churches/me/ write-hole that
            # would otherwise let a treasurer point the public church logo at an
            # arbitrary external URL. logo_url is NOT a declared field on this
            # serializer, so read_only_fields is the correct lever (vs read_only= on a
            # declaration, used for campaign banner_image_url).
            'logo_url',
        ]

    def validate_phone(self, value):
        # Parity with registration (ChurchRegistrationSerializer.validate_phone): a
        # treasurer profile PATCH must store phone in the same normalized 254XXXXXXXXX
        # form as everything else (campaign.treasurer_phone, donations, B2C) instead of
        # the raw 0712… it was keeping. Reuses the SAME shared helper — no second copy of
        # the rule. DRF only calls validate_<field> when the field is PRESENT in the
        # payload, so a partial PATCH that omits phone never reaches here (won't 400).
        # An invalid number raises a field-keyed ValidationError → 400 {"phone": [...]}.
        return validate_safaricom_phone(value)

    def get_active_campaign_count(self, obj):
        annotated = getattr(obj, 'annotated_active_campaign_count', None)
        if annotated is not None:
            return annotated
        return obj.campaigns.filter(status=CampaignStatus.ACTIVE).count()

    def get_total_raised(self, obj):
        annotated = getattr(obj, 'annotated_total_raised', None)
        if annotated is None:
            annotated = obj.campaigns.aggregate(
                total=Coalesce(Sum('raised_amount'), Decimal('0.00')),
            )['total']
        return str(Decimal(annotated).quantize(Decimal('0.01')))


class SubscriptionInitiateSerializer(serializers.Serializer):
    """POST /subscriptions/initiate/ — input that kicks off a subscription STK push.

    `tier` is the target paid tier. ChoiceField accepts any SubscriptionTier value
    (so 'GOLD' → clean 400 here); the VIEW rejects FREE specifically — it is a valid
    enum value but never a payment target. `phone_number` is REQUIRED: the M-Pesa
    number to charge, normalized to 254XXXXXXXXX (clone of DonationInitiateSerializer).
    There is NO fallback to the treasurer's own User.phone — the renew flow always
    collects an explicit number, so a missing/blank/invalid phone is a clean 400.
    """

    tier = serializers.ChoiceField(choices=SubscriptionTier.choices)
    phone_number = serializers.CharField(max_length=20)

    def validate_phone_number(self, value):
        return validate_safaricom_phone(value)
