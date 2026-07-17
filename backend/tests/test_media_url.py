"""Store object keys, mint media URLs at serialization time (2026-07-18).

Unit — integrations.object_storage.media_url():
  * None / '' pass through unchanged (no media).
  * Absolute http(s) URLs pass through BYTE-IDENTICAL — old rows stored the full
    URL at upload time and stay absolute forever (no backfill by design).
  * A bare object key is prefixed with settings.S3_PUBLIC_URL_BASE at call time.

Integration — the wire contract is FROZEN: banner_image_url / logo_url keep
their names and emit absolute URL strings whether the row holds a key (new) or
an absolute URL (old).
"""

from django.test import SimpleTestCase, override_settings
from rest_framework import status
from rest_framework.test import APITestCase

from accounts.models import User, UserRole
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from integrations.object_storage import media_url


BASE = 'http://test.local/pamoja-media'


@override_settings(S3_PUBLIC_URL_BASE=BASE)
class MediaUrlUnitTests(SimpleTestCase):
    def test_none_passthrough(self):
        self.assertIsNone(media_url(None))

    def test_empty_string_passthrough(self):
        self.assertEqual(media_url(''), '')

    def test_absolute_minio_url_passthrough_byte_identical(self):
        old = 'http://127.0.0.1:9000/pamoja-media/campaign/1/banner/abc.jpg'
        self.assertEqual(media_url(old), old)

    def test_absolute_https_url_passthrough_byte_identical(self):
        old = 'https://example.org/x.png'
        self.assertEqual(media_url(old), old)

    def test_bare_key_prefixed_with_public_base(self):
        key = 'campaign/1/banner/0123456789abcdef0123456789abcdef.jpg'
        self.assertEqual(media_url(key), f'{BASE}/{key}')

    @override_settings(S3_PUBLIC_URL_BASE=BASE + '/')
    def test_trailing_slash_base_no_double_slash(self):
        key = 'church/1/logo/a.png'
        self.assertEqual(media_url(key), f'{BASE}/{key}')


@override_settings(S3_PUBLIC_URL_BASE=BASE)
class MediaUrlSerializationTests(APITestCase):
    """A KEY row serializes to the full URL; an ABSOLUTE row serializes unchanged."""

    KEY = 'campaign/key-row/banner/0123456789abcdef0123456789abcdef.jpg'
    LOGO_KEY = 'church/key-row/logo/0123456789abcdef0123456789abcdef.png'
    OLD_ABSOLUTE = 'http://127.0.0.1:9000/pamoja-media/campaign/old/banner/old.jpg'

    @classmethod
    def setUpTestData(cls):
        cls.church = Church.objects.create(
            name='Church A', official_email='a@example.org', phone='254700000001',
            address='addr', county='Nairobi', denomination='PCEA',
            status=ChurchStatus.ACTIVE, logo_url=cls.LOGO_KEY,
        )
        cls.treasurer = User.objects.create_user(
            email='ta@example.org', password='UnusedForTest!', first_name='F',
            last_name='L', role=UserRole.CHURCH_TREASURER, church=cls.church,
        )
        common = dict(
            church=cls.church, description='desc', goal_amount='100000',
            raised_amount='0', wallet_balance='0', category=CampaignCategory.BUILDING,
            treasurer_phone='254712345678', treasurer_name='Treas Urer',
            created_by=cls.treasurer, status=CampaignStatus.ACTIVE,
        )
        cls.key_campaign = Campaign.objects.create(
            slug='key-row', title='Key Row', banner_image_url=cls.KEY, **common,
        )
        cls.old_campaign = Campaign.objects.create(
            slug='old-row', title='Old Row', banner_image_url=cls.OLD_ABSOLUTE, **common,
        )

    def test_key_row_emits_full_url_on_public_detail(self):
        resp = self.client.get('/api/v1/campaigns/key-row/')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(resp.data['banner_image_url'], f'{BASE}/{self.KEY}')

    def test_absolute_row_emits_unchanged_on_public_detail(self):
        resp = self.client.get('/api/v1/campaigns/old-row/')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(resp.data['banner_image_url'], self.OLD_ABSOLUTE)

    def test_church_logo_key_row_emits_full_url(self):
        resp = self.client.get(f'/api/v1/churches/{self.church.id}/')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.assertEqual(resp.data['logo_url'], f'{BASE}/{self.LOGO_KEY}')
