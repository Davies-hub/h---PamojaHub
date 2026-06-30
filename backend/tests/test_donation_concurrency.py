"""Real-concurrency regression for finalize_donation_successful's exactly-once
contract (the reason the inline callback credit was extracted into a shared helper).

WHY TransactionTestCase + threads (NOT TestCase + mocks): the exactly-once property is
enforced by a REAL PostgreSQL SELECT FOR UPDATE row lock held by the CALLER on the
donation row, plus the in-helper `if status in (SUCCESSFUL, FAILED): return False`
guard. Django's TestCase wraps each test in ONE transaction, so every "connection" would
share it and select_for_update would serialize nothing — a fake race. TransactionTestCase
commits for real (truncates between tests), so two workers each in their OWN committed
transaction on their OWN connection genuinely contend the row lock.

A threading.Barrier releases both workers together so contention is real without a
sleep-scripted interleave — Postgres's row lock, not a timer, picks the winner. The
second worker, once it acquires the donation lock, observes the first's committed
SUCCESSFUL status and the helper's guard makes it a no-op — exactly one credit.

REQUIRES PostgreSQL (sqlite ignores select_for_update). setUp skips otherwise so the
suite can't false-green on the wrong backend. Mirrors test_finalize_concurrency.py.
"""

import threading
from decimal import Decimal

from django.db import connection, transaction
from django.test import TransactionTestCase

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from donations.models import Donation, DonationStatus
from donations.services import _compute_fee, finalize_donation_successful
from superadmin.models import PlatformSettings


CONFIRMED_AUDIT_ACTION = 'DONATION_CONFIRMED'
GROSS = Decimal('100')
CHECKOUT_ID = 'ws_CO_CONC_TEST'


class FinalizeDonationConcurrencyTest(TransactionTestCase):
    def setUp(self):
        if connection.vendor != 'postgresql':
            self.skipTest(
                'Real select_for_update row-lock concurrency requires PostgreSQL '
                f'(got vendor={connection.vendor!r}); meaningless on a backend that '
                'ignores SELECT FOR UPDATE.'
            )
        self.church = Church.objects.create(
            name='Conc Church', official_email='conc-d@example.org',
            phone='254700000001', address='addr', county='Nairobi',
            denomination='PCEA', status=ChurchStatus.ACTIVE,
        )
        self.treasurer = User.objects.create_user(
            email='conc-d-treas@example.org', password='unused', first_name='F',
            last_name='L', role=UserRole.CHURCH_TREASURER, church=self.church,
        )
        # Arrange: campaign at ZERO so a double-credit is unmistakable.
        self.campaign = Campaign.objects.create(
            slug='conc-d-c1', church=self.church, title='Conc Donation Campaign',
            description='desc', goal_amount=Decimal('1000000'),
            raised_amount=Decimal('0'), wallet_balance=Decimal('0'),
            banner_image_url='https://example.org/x.png',
            category=CampaignCategory.BUILDING, treasurer_phone='254712345678',
            treasurer_name='Treas Urer', created_by=self.treasurer,
            status=CampaignStatus.ACTIVE,
        )
        self.donation = Donation.objects.create(
            campaign=self.campaign, phone_number='254712345678',
            amount=GROSS, status=DonationStatus.PENDING,
            checkout_request_id=CHECKOUT_ID,
        )
        # Expected NET for a single credit, at the live platform fee.
        _, self.expected_net = _compute_fee(GROSS, PlatformSettings.load().fee_percent)

    def _run_two_finalizers(self, src_a, src_b):
        """Two threads, each reproducing the REAL caller sequence:
            own connection -> transaction.atomic()
              -> Donation.objects.select_for_update().get(checkout_request_id=...)
              -> finalize_donation_successful(donation=row, gross=GROSS, ...)
        A Barrier releases both together. Returns {0:(tag,val), 1:(tag,val)}."""
        barrier = threading.Barrier(2)
        results = {}

        def worker(idx, src):
            try:
                barrier.wait(timeout=20)
                try:
                    with transaction.atomic():
                        row = (Donation.objects.select_for_update()
                               .get(checkout_request_id=CHECKOUT_ID))
                        res = finalize_donation_successful(
                            donation=row, gross=GROSS, receipt=f'R-{src}',
                            source=src,
                        )
                    results[idx] = ('ok', res)
                except Exception as exc:  # captured; asserted on the main thread
                    results[idx] = ('err', repr(exc))
            finally:
                connection.close()  # thread-local conn; free it for teardown TRUNCATE

        t0 = threading.Thread(target=worker, args=(0, src_a))
        t1 = threading.Thread(target=worker, args=(1, src_b))
        t0.start(); t1.start()
        t0.join(timeout=30); t1.join(timeout=30)
        self.assertFalse(
            t0.is_alive() or t1.is_alive(),
            'a finalizer worker hung — possible deadlock / lock not released',
        )
        return results

    def test_two_concurrent_finalizers_credit_once(self):
        """The callback and a (future) resolver could both fire for the same donation;
        the shared helper's locked guard must credit the campaign EXACTLY once."""
        results = self._run_two_finalizers('callback', 'resolver')

        # 1) Neither worker raised.
        for idx in (0, 1):
            self.assertIn(idx, results, f'worker {idx} produced no result')
            tag, val = results[idx]
            self.assertEqual(tag, 'ok', f'worker {idx} raised: {val}')

        # 2) Exactly one finalize returned True (did the work), one False (saw the
        #    committed terminal status under the lock and no-opped).
        returns = sorted([results[0][1], results[1][1]])
        self.assertEqual(
            returns, [False, True],
            f'expected exactly one True + one False, got {returns}',
        )

        # 3) raised_amount AND wallet_balance each moved by NET EXACTLY once (0 -> net).
        campaign = Campaign.objects.get(id=self.campaign.id)
        self.assertEqual(
            campaign.raised_amount, self.expected_net,
            f'raised_amount should be {self.expected_net} (one credit), is '
            f'{campaign.raised_amount}',
        )
        self.assertEqual(
            campaign.wallet_balance, self.expected_net,
            f'wallet_balance should be {self.expected_net} (one credit), is '
            f'{campaign.wallet_balance}',
        )

        # 4) Status SUCCESSFUL.
        donation = Donation.objects.get(id=self.donation.id)
        self.assertEqual(donation.status, DonationStatus.SUCCESSFUL)

        # 5) Exactly ONE DONATION_CONFIRMED audit row for this donation.
        n_audit = AuditLog.objects.filter(
            action=CONFIRMED_AUDIT_ACTION, entity_type='Donation',
            entity_id=self.donation.id,
        ).count()
        self.assertEqual(n_audit, 1, f'expected exactly 1 DONATION_CONFIRMED audit, got {n_audit}')
