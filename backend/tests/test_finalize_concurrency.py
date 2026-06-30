"""Real-concurrency regression for finalize_withdrawal_paid's exactly-once
contract (post-2.10c hardening).

WHY TransactionTestCase + threads (NOT TestCase + mocks): finalize's exactly-once
property is enforced by a REAL PostgreSQL SELECT FOR UPDATE row lock held by the
CALLER, plus the in-finalizer `if status == PAID: return False` guard
(services.py:107-108). Django's TestCase wraps each test in ONE transaction, so
every "connection" would share that transaction and select_for_update would not
serialize anything — the race would be fake. TransactionTestCase commits for real
(and truncates between tests), so two worker threads each running their OWN
committed transaction on their OWN connection genuinely contend the row lock.

A threading.Barrier releases both workers into the contended section together so
the contention is real WITHOUT any sleep-scripted interleave — Postgres's row
lock, not a timer, decides the winner. Correctness does not depend on the two
locks overlapping in time: select_for_update SERIALIZES the workers, so the
second always observes the first's committed result. The Barrier only maximizes
the chance of genuine overlap.

REQUIRES PostgreSQL (sqlite ignores select_for_update). setUp skips otherwise so
the suite can never give a false green on the wrong backend.
"""

import threading
from decimal import Decimal

from django.db import connection, transaction
from django.test import TransactionTestCase

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from withdrawals.models import (
    Withdrawal,
    WithdrawalDispatchOutcome,
    WithdrawalStatus,
)
from withdrawals.services import finalize_withdrawal_paid
from withdrawals.tasks import _is_still_candidate


# services.finalize_withdrawal_paid:123 writes this action on each finalize.
PAID_AUDIT_ACTION = 'WITHDRAWAL_PAID'


class _FinalizeConcurrencyBase(TransactionTestCase):
    """Shared arrangement + the real concurrent-caller runner."""

    def setUp(self):
        if connection.vendor != 'postgresql':
            self.skipTest(
                'Real select_for_update row-lock concurrency requires PostgreSQL '
                f'(got vendor={connection.vendor!r}); the test is meaningless '
                'on a backend that ignores SELECT FOR UPDATE.'
            )
        self.church = Church.objects.create(
            name='Conc Church', official_email='conc@example.org',
            phone='254700000001', address='addr', county='Nairobi',
            denomination='PCEA', status=ChurchStatus.ACTIVE,
        )
        self.treasurer = User.objects.create_user(
            email='conc-treas@example.org', password='unused', first_name='F',
            last_name='L', role=UserRole.CHURCH_TREASURER, church=self.church,
        )
        self.campaign = Campaign.objects.create(
            slug='conc-c1', church=self.church, title='Conc Campaign',
            description='desc', goal_amount=Decimal('1000000'),
            raised_amount=Decimal('1000'), wallet_balance=Decimal('1000'),
            banner_image_url='https://example.org/x.png',
            category=CampaignCategory.BUILDING, treasurer_phone='254712345678',
            treasurer_name='Treas Urer', created_by=self.treasurer,
            status=CampaignStatus.ACTIVE,
        )
        self.withdrawal = Withdrawal.objects.create(
            campaign=self.campaign, requested_by_phone='254712345678',
            destination_phone='254712345678', destination_name='Treas Urer',
            amount=Decimal('100'), reason='materials',
            status=WithdrawalStatus.PROCESSING,
        )

    def _run_two_finalizers(self, src_a, src_b):
        """Two threads, each reproducing the REAL caller sequence:
            own connection -> transaction.atomic()
              -> Withdrawal.objects.select_for_update().get(id=...)
              -> finalize_withdrawal_paid(withdrawal=row, source=<src>, ...)
        A Barrier releases both together. Returns {0:(tag,val), 1:(tag,val)}
        where tag is 'ok' (val = finalize's return) or 'err' (val = repr(exc))."""
        wid = self.withdrawal.id
        barrier = threading.Barrier(2)
        results = {}

        def worker(idx, src):
            try:
                # Poise both threads at the contended section together. No sleep,
                # no scripted interleave — the row lock arbitrates.
                barrier.wait(timeout=20)
                try:
                    with transaction.atomic():
                        row = Withdrawal.objects.select_for_update().get(id=wid)
                        res = finalize_withdrawal_paid(
                            withdrawal=row, actor=None, source=src,
                            payout_reference=f'REF-{src}',
                        )
                    results[idx] = ('ok', res)
                except Exception as exc:  # capture; asserted on the main thread
                    results[idx] = ('err', repr(exc))
            finally:
                # Each thread owns its connection (django.db.connection is
                # thread-local). Close it so the teardown TRUNCATE can't block on
                # a leaked open transaction.
                connection.close()

        t0 = threading.Thread(target=worker, args=(0, src_a))
        t1 = threading.Thread(target=worker, args=(1, src_b))
        t0.start()
        t1.start()
        t0.join(timeout=30)
        t1.join(timeout=30)
        self.assertFalse(
            t0.is_alive() or t1.is_alive(),
            'a finalizer worker thread hung — possible deadlock / lock not released',
        )
        return results

    def _assert_exactly_once(self, results):
        # 1) Neither worker raised.
        for idx in (0, 1):
            self.assertIn(idx, results, f'worker {idx} produced no result')
            tag, val = results[idx]
            self.assertEqual(tag, 'ok', f'worker {idx} raised: {val}')

        # 2) Exactly one finalize returned True (did the work) and one False
        #    (saw PAID under the lock and no-opped).
        returns = sorted([results[0][1], results[1][1]])
        self.assertEqual(
            returns, [False, True],
            f'expected exactly one True + one False from finalize, got {returns}',
        )

        # 3) Wallet decremented EXACTLY once: 1000 - 100 = 900.
        campaign = Campaign.objects.get(id=self.campaign.id)
        self.assertEqual(
            campaign.wallet_balance, Decimal('900'),
            f'wallet should be 900 (one decrement), is {campaign.wallet_balance}',
        )

        # 4) Status PAID.
        withdrawal = Withdrawal.objects.get(id=self.withdrawal.id)
        self.assertEqual(withdrawal.status, WithdrawalStatus.PAID)

        # 5) Exactly ONE WITHDRAWAL_PAID audit row for this withdrawal.
        n_audit = AuditLog.objects.filter(
            action=PAID_AUDIT_ACTION,
            entity_type='Withdrawal',
            entity_id=self.withdrawal.id,
        ).count()
        self.assertEqual(
            n_audit, 1,
            f'expected exactly 1 WITHDRAWAL_PAID audit row, got {n_audit}',
        )


class TwoCallbackRaceTest(_FinalizeConcurrencyBase):
    def test_two_concurrent_callbacks_decrement_once(self):
        """T1 — the reachable real-world race: Safaricom retries the B2C result
        on a non-200, so duplicate result callbacks arrive. Two concurrent
        source='callback' finalizers on the same PROCESSING row must produce
        exactly one wallet decrement and one PAID transition."""
        results = self._run_two_finalizers('callback', 'callback')
        self._assert_exactly_once(results)


class CallbackRacesSweepFinalizeTest(_FinalizeConcurrencyBase):
    def test_callback_vs_sweep_finalize_decrement_once(self):
        """T2 — two finalizers race at the FINALIZER level (one source='callback',
        one source='sweep'). Proves finalize_withdrawal_paid is exactly-once
        regardless of the racing `source` label.

        NOTE (2026-06-07, A2): the sweep no longer finalizes — it is escalate-only
        (the wire-disproven CONFIRMED_PAID / Transaction Status query path was
        removed; see §14.1 "DISPROVEN 2026-06-07"). The 'sweep' source is exercised
        here purely as an arbitrary second label to prove the finalizer is
        source-independent; the reachable real-world race is two duplicate result
        callbacks (T1), and this asserts the same exactly-once wallet decrement
        under any concurrent double-finalize."""
        results = self._run_two_finalizers('callback', 'sweep')
        self._assert_exactly_once(results)


class SweepRecheckDoorTest(TransactionTestCase):
    """T3 — the sweep's under-lock recheck door, _is_still_candidate
    (withdrawals/tasks.py:72-80), refuses an already-resolved row INDEPENDENTLY
    of the finalizer guard. Faithful to the traced logic:

        if withdrawal.status == WithdrawalStatus.PROCESSING:
            return True
        return (
            withdrawal.status == WithdrawalStatus.FAILED
            and withdrawal.dispatch_outcome == WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE
        )

    The function reads only .status and .dispatch_outcome, so unsaved instances
    exercise it exactly."""

    def test_recheck_door_status_matrix(self):
        def w(status, outcome=None):
            return Withdrawal(status=status, dispatch_outcome=outcome)

        # PROCESSING -> True
        self.assertTrue(_is_still_candidate(w(WithdrawalStatus.PROCESSING)))
        # FAILED + AMBIGUOUS_FAILURE -> True
        self.assertTrue(_is_still_candidate(
            w(WithdrawalStatus.FAILED, WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE)))
        # FAILED without AMBIGUOUS_FAILURE -> False
        self.assertFalse(_is_still_candidate(w(WithdrawalStatus.FAILED)))
        self.assertFalse(_is_still_candidate(
            w(WithdrawalStatus.FAILED, WithdrawalDispatchOutcome.CLEAN_FAILURE)))
        # PAID -> False
        self.assertFalse(_is_still_candidate(w(WithdrawalStatus.PAID)))
        # NEEDS_RECONCILIATION -> False
        self.assertFalse(_is_still_candidate(w(WithdrawalStatus.NEEDS_RECONCILIATION)))
