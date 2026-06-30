"""Withdrawal serializers. Note b2c_conversation_id is EXCLUDED — internal Daraja
correlation id, no user value, Coding Rule 3 lists it as sensitive. payout_reference
IS included (success receipt the treasurer wants to see).

Masking decision: requested_by_phone is NOT masked here. The serializer returns true
data to authenticated Church Treasurers; masking is a presentation concern handled by
the frontend (already built in payouts.tsx).

AUTHORIZED-SURFACE-ONLY TRIPWIRE — WithdrawalSerializer exposes destination_phone and
requested_by_phone in full. This is CORRECT for authorized surfaces (Church Treasurer
approval dialog, portal pending list per PRD 8.5.5), but it means this serializer
MUST NEVER be wired to a public, unauthenticated, or cross-church endpoint.
Authorization is enforced at the view/permission layer in Step 2.8, NOT here. The
sensitive data hides under non-forbidden field names (destination_phone /
requested_by_phone), so the public-surface leak test cannot catch a misuse — the
guardrail is the view layer.
"""

from rest_framework import serializers

from withdrawals.models import Withdrawal


class WithdrawalSerializer(serializers.ModelSerializer):
    """Church Treasurer payouts panel + portal pending list (read-mostly).

    Excluded by design: b2c_conversation_id (internal Daraja correlation id).
    """

    campaign = serializers.CharField(source='campaign.title', read_only=True)
    # SHARED SERIALIZER: both /withdrawals/ (treasurer payouts) and /super/withdrawals/
    # (platform oversight) use this. church_name labels the owning church on the
    # Super Admin oversight list (campaign→church→name). HARMLESS on the treasurer
    # side — a treasurer only ever sees their own church's name on their own
    # withdrawal (redundant, not a disclosure). Same declared-read-only pattern as
    # `campaign` above (in fields + covered by read_only_fields = fields).
    church_name = serializers.CharField(source='campaign.church.name', read_only=True)

    class Meta:
        model = Withdrawal
        fields = [
            'id',
            'campaign',
            'church_name',
            'amount',
            'destination_phone',
            'destination_name',
            'requested_by_phone',
            'reason',
            'rejection_reason',
            'status',
            'retry_count',
            'failure_reason',
            'dispatch_outcome',  # FE-needed: gates the Retry button (AMBIGUOUS_FAILURE
                                 # hides Retry). A future D1-narrowing pass must KEEP this.
            'payout_reference',
            'created_at',
            'updated_at',
        ]
        read_only_fields = fields  # read surface — writes go through WithdrawalRequestSerializer


class WithdrawalRequestSerializer(serializers.Serializer):
    """POST /treasurer/campaigns/{id}/request-disbursement/ — write-only.

    Every other field (campaign, requested_by_phone, destination_phone, destination_name)
    is set server-side from the portal token + campaign record. wallet_balance
    sufficiency is checked in the view with SELECT FOR UPDATE (Step 2.8), not here.
    """

    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=1)
    reason = serializers.CharField()
