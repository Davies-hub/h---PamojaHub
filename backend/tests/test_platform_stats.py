"""Public platform-totals endpoint tests (PH4-02).

GET /api/v1/stats/ is AllowAny and feeds the public landing hero. It returns
all-time platform figures:
  * total_raised  — Sum of Donation.net_amount over SUCCESSFUL donations
                    (money on record; net_amount is NULL until the STK callback
                    confirms, so PENDING/FAILED contribute nothing).
  * campaign_count — Campaign.objects.count() across ALL statuses.
  * church_count   — Church.objects.count() across ALL statuses.

Expected values are derived from the seeded fixtures via the ORM — never
hardcoded. The fixtures deliberately include non-ACTIVE campaigns / churches and
non-SUCCESSFUL donations so the test proves the endpoint is ALL-TIME (not
active-only) and money-on-record (not pending/failed).

Run: python manage.py test tests.test_platform_stats
"""

from decimal import Decimal

from django.db.models import Sum
from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from donations.models import Donation, DonationStatus


def _make_church(name, email, status_):
    return Church.objects.create(
        name=name, official_email=email,
        phone='254700000001', address='addr',
        county='Nairobi', denomination='PCEA',
        status=status_,
    )


def _make_treasurer(church):
    return User.objects.create_user(
        email='t@example.org', password='unused',
        first_name='F', last_name='L',
        role=UserRole.CHURCH_TREASURER, church=church,
    )


def _make_campaign(church, treasurer, slug, status_):
    return Campaign.objects.create(
        slug=slug, church=church,
        title=f'Campaign {slug}', description='desc',
        goal_amount=Decimal('100000'),
        raised_amount=Decimal('0'), wallet_balance=Decimal('0'),
        banner_image_url='https://example.org/x.png',
        category=CampaignCategory.BUILDING,
        treasurer_phone='254712345678', treasurer_name='Treas Urer',
        created_by=treasurer,
        status=status_,
    )


def _make_donation(campaign, amount, net, status_):
    return Donation.objects.create(
        campaign=campaign,
        phone_number='254712345678',
        amount=Decimal(amount),
        platform_fee=None,
        net_amount=None if net is None else Decimal(net),
        status=status_,
    )


class PlatformStatsPublicTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        # Churches across statuses — church_count must include ALL of them.
        active = _make_church('Active Ch', 'active@example.org', ChurchStatus.ACTIVE)
        _make_church('Pending Ch', 'pending@example.org', ChurchStatus.PENDING)
        _make_church('Suspended Ch', 'susp@example.org', ChurchStatus.SUSPENDED)

        treasurer = _make_treasurer(active)

        # Campaigns across statuses — campaign_count must include ALL of them.
        c_active = _make_campaign(active, treasurer, 'c-active', CampaignStatus.ACTIVE)
        c_closed = _make_campaign(active, treasurer, 'c-closed', CampaignStatus.CLOSED)
        _make_campaign(active, treasurer, 'c-paused', CampaignStatus.PAUSED)

        # Donations: SUCCESSFUL (incl. one on a CLOSED campaign) count toward
        # total_raised; PENDING/FAILED (net_amount NULL) must NOT.
        _make_donation(c_active, '1000', '975.00', DonationStatus.SUCCESSFUL)
        _make_donation(c_closed, '2000', '1950.00', DonationStatus.SUCCESSFUL)
        _make_donation(c_active, '500', None, DonationStatus.PENDING)
        _make_donation(c_active, '300', None, DonationStatus.FAILED)

    def setUp(self):
        self.client = APIClient()

    def test_anon_platform_stats_match_seeded_totals(self):
        resp = self.client.get(reverse('platform-stats'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        body = resp.json()

        expected_total = Donation.objects.filter(
            status=DonationStatus.SUCCESSFUL,
        ).aggregate(s=Sum('net_amount'))['s']
        expected_campaigns = Campaign.objects.count()
        expected_churches = Church.objects.count()

        # total_raised is a STRING on the wire (rule #11) equal to the DB Sum.
        self.assertIsInstance(body['total_raised'], str)
        self.assertEqual(Decimal(body['total_raised']), expected_total)
        self.assertEqual(body['campaign_count'], expected_campaigns)
        self.assertEqual(body['church_count'], expected_churches)

        # All-time, not active-only: totals exceed the ACTIVE-only subset, and the
        # raised total includes a donation on a CLOSED campaign.
        self.assertGreater(
            expected_campaigns,
            Campaign.objects.filter(status=CampaignStatus.ACTIVE).count(),
        )
        self.assertGreater(
            expected_churches,
            Church.objects.filter(status=ChurchStatus.ACTIVE).count(),
        )
