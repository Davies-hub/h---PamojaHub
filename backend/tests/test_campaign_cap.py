"""FREE-tier active-campaign cap (spec §6: Free = 3 active campaigns).

Drives the LIVE create route POST /campaigns/ (reverse('campaign-create')) and
proves the cap on the wire:

  * a FREE church is blocked at the 4th ACTIVE campaign (400),
  * under the cap it still creates (201),
  * PAUSED / CLOSED campaigns do NOT count toward the cap,
  * GROWTH (a paid tier) is uncapped.

Clones the fixture helpers + force_authenticate + reverse('campaign-create')
pattern from tests/test_church_scoped_endpoints.py. Each test seeds its OWN
fresh church (not the shared two-church fixture) so the active-campaign count
is exactly what it seeds — no pre-seeded campaigns to subtract.
"""

from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import SubscriptionTier
from tests.test_church_scoped_endpoints import (
    _make_campaign,
    _make_church,
    _make_treasurer,
)


# A complete, valid create payload (mirrors SlugCollisionTest._create).
VALID_CREATE_PAYLOAD = {
    'title': 'Roof Fund',
    'description': 'desc',
    'goal_amount': '50000',
    'banner_image_url': 'https://example.org/x.png',
    'category': CampaignCategory.BUILDING,
    'treasurer_phone': '0712345678',
    'treasurer_name': 'T U',
}


class FreeTierActiveCampaignCapTest(TestCase):
    def setUp(self):
        self.client = APIClient()

    # ── seeding helpers ──────────────────────────────────────────────────────
    def _seed_church(self, *, tier, email):
        church = _make_church(name='Cap Church', email=email)
        if tier != SubscriptionTier.FREE:
            church.subscription_tier = tier
            church.save(update_fields=['subscription_tier'])
        treasurer = _make_treasurer(church, f'cap-treasurer-{email}')
        return church, treasurer

    def _seed_campaigns(self, church, treasurer, *, status_, n, prefix):
        for k in range(n):
            _make_campaign(church, treasurer, slug=f'{prefix}-{k}', status_=status_)

    def _post_create(self, treasurer):
        self.client.force_authenticate(user=treasurer)
        return self.client.post(
            reverse('campaign-create'), VALID_CREATE_PAYLOAD, format='json',
        )

    def _active_count(self, church):
        return Campaign.objects.filter(
            church=church, status=CampaignStatus.ACTIVE,
        ).count()

    # ── tests ────────────────────────────────────────────────────────────────
    def test_free_church_blocked_at_active_cap(self):
        """FREE church with exactly 3 ACTIVE → a 4th create is rejected (400)."""
        church, treasurer = self._seed_church(
            tier=SubscriptionTier.FREE, email='free-at-cap@example.org',
        )
        self._seed_campaigns(church, treasurer, status_=CampaignStatus.ACTIVE,
                             n=3, prefix='free-active')
        self.assertEqual(self._active_count(church), 3)

        resp = self._post_create(treasurer)

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertEqual(self._active_count(church), 3)  # no 4th was created

    def test_free_church_under_cap_allowed(self):
        """FREE church with 2 ACTIVE → create succeeds (201); now 3 ACTIVE."""
        church, treasurer = self._seed_church(
            tier=SubscriptionTier.FREE, email='free-under-cap@example.org',
        )
        self._seed_campaigns(church, treasurer, status_=CampaignStatus.ACTIVE,
                             n=2, prefix='free-active')

        resp = self._post_create(treasurer)

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertEqual(self._active_count(church), 3)

    def test_paused_and_closed_do_not_count(self):
        """FREE church with 2 ACTIVE + 1 PAUSED + 1 CLOSED → create succeeds.

        Active count is 2 (< 3); PAUSED/CLOSED must NOT count toward the cap.
        """
        church, treasurer = self._seed_church(
            tier=SubscriptionTier.FREE, email='free-mixed@example.org',
        )
        self._seed_campaigns(church, treasurer, status_=CampaignStatus.ACTIVE,
                             n=2, prefix='free-active')
        self._seed_campaigns(church, treasurer, status_=CampaignStatus.PAUSED,
                             n=1, prefix='free-paused')
        self._seed_campaigns(church, treasurer, status_=CampaignStatus.CLOSED,
                             n=1, prefix='free-closed')

        resp = self._post_create(treasurer)

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertEqual(self._active_count(church), 3)

    def test_growth_church_uncapped(self):
        """GROWTH church with 3 ACTIVE → a 4th create still succeeds (201)."""
        church, treasurer = self._seed_church(
            tier=SubscriptionTier.GROWTH, email='growth-uncapped@example.org',
        )
        self._seed_campaigns(church, treasurer, status_=CampaignStatus.ACTIVE,
                             n=3, prefix='growth-active')

        resp = self._post_create(treasurer)

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertEqual(self._active_count(church), 4)
