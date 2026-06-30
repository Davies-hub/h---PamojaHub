import uuid

from django.db import models


# Retry ceiling (single source of truth — imported by views, services, sweep).
# FAILED is retriable while retry_count < MAX_RETRIES; at >= MAX_RETRIES a failure
# escalates to FAILED_FINAL (terminal, non-blocking).
MAX_RETRIES = 5


class WithdrawalStatus(models.TextChoices):
    PENDING_APPROVAL = 'PENDING_APPROVAL', 'Pending Approval'
    PROCESSING = 'PROCESSING', 'Processing'
    PAID = 'PAID', 'Paid'
    FAILED = 'FAILED', 'Failed'
    FAILED_FINAL = 'FAILED_FINAL', 'Failed Final'
    REJECTED = 'REJECTED', 'Rejected'
    # Step 2.10c — terminal floor for a withdrawal the sweep could not safely
    # resolve (Transaction Status persistently INCONCLUSIVE). Money is in limbo:
    # the campaign stays frozen for this withdrawal (BLOCKING) and the ONLY exit
    # is a Super Admin who checked M-Pesa (resolve-paid / resolve-retry). There
    # is deliberately NO force-retry from here — blind re-dispatch is the unsafe
    # action for exactly these rows. Distinct from PROCESSING so the freeze reads
    # as "needs a human", not "healthy in-flight payout".
    NEEDS_RECONCILIATION = 'NEEDS_RECONCILIATION', 'Needs Reconciliation'


# ── block-on-FAILED blocking set (single source of truth) ──────────────────────
# A campaign with a withdrawal in any of these statuses BLOCKS a new disbursement
# request — the money is outstanding or in-limbo and a second payout could
# double-spend. PROCESSING/PENDING_APPROVAL = in-flight; FAILED = money-in-limbo
# until the sweep/callback drives it to PAID or escalates to FAILED_FINAL;
# NEEDS_RECONCILIATION = persistently-inconclusive money-in-limbo, frozen pending
# a human. PAID / REJECTED / FAILED_FINAL are TERMINAL and do NOT block.
#
# Safety invariant: FAILED must never be a permanent resting state (the sweep
# resolves it or escalation moves it to FAILED_FINAL), and NEEDS_RECONCILIATION
# is the explicit, legible freeze for the rows where even that isn't safe.
BLOCKING_WITHDRAWAL_STATUSES = (
    WithdrawalStatus.PENDING_APPROVAL,
    WithdrawalStatus.PROCESSING,
    WithdrawalStatus.FAILED,
    WithdrawalStatus.NEEDS_RECONCILIATION,
)


# States in which an incoming B2C *result callback* must NOT finalize the
# row. NOTE: this is NOT the same as BLOCKING_WITHDRAWAL_STATUSES (which
# includes PROCESSING/FAILED — still-resolvable) and NOT the same as the
# finalize idempotency guard (which is == PAID only, because resolve-paid
# legitimately finalizes a NEEDS_RECONCILIATION row). Do not merge these.
RESULT_CALLBACK_IGNORED_STATUSES = (
    WithdrawalStatus.PAID,
    WithdrawalStatus.FAILED_FINAL,
    WithdrawalStatus.REJECTED,
    WithdrawalStatus.NEEDS_RECONCILIATION,   # ← the (3) fix: was missing
)


class WithdrawalDispatchOutcome(models.TextChoices):
    """Machine-readable B2C dispatch-failure class, set in the Phase-2 (unlocked)
    position when DarajaClient().b2c_payout() raises. Distinguishes the two
    failure certainties so Step 2.10c's sweep can branch WITHOUT re-parsing a
    human-readable failure_reason (a copy edit must never silently flip the
    sweep's decision):

      CLEAN_FAILURE     — request provably never queued → MAY re-dispatch.
      AMBIGUOUS_FAILURE — request may be queued → MUST verify (Daraja status
                          query / Occasion=withdrawal.id correlation) before any
                          retry; NEVER blind-re-dispatch.

    Null when the withdrawal has not suffered a dispatch failure (it never
    dispatched, dispatched cleanly, or was re-dispatched and cleared).
    """

    CLEAN_FAILURE = 'CLEAN_FAILURE', 'Clean dispatch failure (provably never queued)'
    AMBIGUOUS_FAILURE = 'AMBIGUOUS_FAILURE', 'Ambiguous dispatch failure (may be queued)'


class Withdrawal(models.Model):
    """Backend model name stays `Withdrawal`; UI strings use "Payout" (Section 14)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    campaign = models.ForeignKey(
        'campaigns.Campaign',
        on_delete=models.PROTECT,
        related_name='withdrawals',
    )
    # NOT a FK — Campaign Treasurers are phone-gated and have no accounts (PRD 9.3).
    requested_by_phone = models.CharField(max_length=20)
    approved_by = models.ForeignKey(
        'accounts.User',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='approved_withdrawals',
    )
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    destination_phone = models.CharField(max_length=20)
    destination_name = models.CharField(max_length=255)
    reason = models.TextField()
    rejection_reason = models.TextField(null=True, blank=True)
    status = models.CharField(
        max_length=20,
        choices=WithdrawalStatus.choices,
        default=WithdrawalStatus.PENDING_APPROVAL,
    )
    payout_reference = models.CharField(max_length=100, null=True, blank=True)
    # ConversationID is returned BY Daraja on a clean B2C ack. OriginatorConversationID
    # is generated BY US and sent in the payload — stored BEFORE the HTTP call so
    # even a clean strand (crash mid-dispatch, no ConversationID) still carries a
    # lookup handle for the M-Pesa back-office / Transaction Status query (2.10c).
    b2c_conversation_id = models.CharField(max_length=100, null=True, blank=True)
    originator_conversation_id = models.CharField(max_length=100, null=True, blank=True)
    failure_reason = models.CharField(max_length=255, null=True, blank=True)
    # Set on B2C dispatch failure (Phase-2). Null otherwise. 2.10c branches on it.
    dispatch_outcome = models.CharField(
        max_length=20,
        choices=WithdrawalDispatchOutcome.choices,
        null=True,
        blank=True,
    )
    retry_count = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['campaign', 'status'], name='idx_withdrawal_campaign_status'),
            # B2C result-callback / reconciliation correlate rows by these handles.
            models.Index(fields=['b2c_conversation_id'], name='idx_withdrawal_b2c_conv'),
            models.Index(fields=['originator_conversation_id'], name='idx_withdrawal_orig_conv'),
        ]
        constraints = [
            models.CheckConstraint(condition=models.Q(amount__gt=0),
                                   name='withdrawal_amount_positive'),
            models.CheckConstraint(condition=models.Q(retry_count__lte=5),
                                   name='withdrawal_max_retries'),
        ]
