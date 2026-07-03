"""SLICE 1 — banner_image_url + logo_url are server-set-only.

Image upload is a server-side feature (a later slice introduces the upload
endpoint that sets these URLs). The client must NEVER be able to write them via
the ordinary create/edit/profile surfaces — otherwise a treasurer could point a
campaign banner or church logo at an arbitrary external URL (phishing / content
injection on public pages).

These tests drive the REAL endpoints via APIClient as an authenticated
CHURCH_TREASURER of an ACTIVE church, send a hostile client-supplied URL, and
assert the field is SILENTLY IGNORED (request still succeeds; the field stays
None on reload). The fix is asymmetric:
  * Campaign.banner_image_url  -> declared field read_only=True (serializer)
  * Church.logo_url            -> added to AdminChurchSerializer.read_only_fields

Style mirrors tests/test_church_scoped_endpoints.py (APIClient +
force_authenticate, reverse(), format='json').
"""

from decimal import Decimal

from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus


EVIL_URL = 'https://evil.example.com/x.png'
EVIL_DOC_URL = 'http://evil.example.com/x'


class ImageFieldLockTest(TestCase):
    """One ACTIVE church + its treasurer; logo_url and a campaign banner both None."""

    @classmethod
    def setUpTestData(cls):
        cls.church = Church.objects.create(
            name='Church A',
            official_email='a@example.org',
            phone='254700000001',
            address='addr',
            county='Nairobi',
            denomination='PCEA',
            status=ChurchStatus.ACTIVE,
            logo_url=None,
        )
        cls.treasurer = User.objects.create_user(
            email='ta@example.org',
            password='UnusedForTest!',
            first_name='F',
            last_name='L',
            role=UserRole.CHURCH_TREASURER,
            church=cls.church,
        )
        # An owned campaign with NO banner — the edit-test target.
        cls.campaign = Campaign.objects.create(
            slug='a-active',
            church=cls.church,
            title='Campaign a-active',
            description='desc',
            goal_amount=Decimal('100000'),
            raised_amount=Decimal('0'),
            wallet_balance=Decimal('0'),
            banner_image_url=None,
            category=CampaignCategory.BUILDING,
            treasurer_phone='254712345678',
            treasurer_name='Treas Urer',
            created_by=cls.treasurer,
            status=CampaignStatus.ACTIVE,
        )

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.treasurer)

    def _create_payload(self, **overrides):
        base = {
            'title': 'Roofing Drive',
            'description': 'desc',
            'goal_amount': '50000',
            'category': CampaignCategory.BUILDING,
            'treasurer_phone': '0712345678',
            'treasurer_name': 'T U',
        }
        base.update(overrides)
        return base

    def test_create_ignores_client_banner(self):
        """T1: POST campaign-create with a client banner -> 201, but row banner is None."""
        resp = self.client.post(
            reverse('campaign-create'),
            self._create_payload(banner_image_url=EVIL_URL),
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        camp = Campaign.objects.get(slug=resp.data['slug'])
        self.assertIsNone(camp.banner_image_url)

    def test_edit_ignores_client_banner(self):
        """T2: PATCH the edit route with a client banner -> 200, but row banner stays None."""
        resp = self.client.patch(
            reverse('campaign-mine-detail', args=['a-active']),
            {'banner_image_url': EVIL_URL},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.campaign.refresh_from_db()
        self.assertIsNone(self.campaign.banner_image_url)

    def test_edit_ignores_client_document_url(self):
        """T4: PATCH the edit route with a client document_url -> 200, but row stays None.

        Same class of hole as banner_image_url: a treasurer-writable URL rendered on a
        public campaign is an arbitrary-URL injection vector (phishing / content
        injection). Locking it read_only makes DRF silently drop the client value.
        """
        resp = self.client.patch(
            reverse('campaign-mine-detail', args=['a-active']),
            {'document_url': EVIL_DOC_URL},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.campaign.refresh_from_db()
        self.assertIsNone(self.campaign.document_url)

    def test_church_patch_ignores_client_logo(self):
        """T3: PATCH /churches/me/ with a client logo_url -> 200, but row logo stays None."""
        resp = self.client.patch(
            reverse('church-me'),
            {'logo_url': EVIL_URL},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.church.refresh_from_db()
        self.assertIsNone(self.church.logo_url)
