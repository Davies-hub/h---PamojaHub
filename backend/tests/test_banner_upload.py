"""Slice 2b-iii — campaign banner upload endpoint tests (storage PATCHED, no MinIO).

The two headline REDs:
  * RED-A — cross-tenant IDOR: treasurer B uploading to church A's campaign dies at
    authz (403) BEFORE the validator or storage is touched.
  * RED-B — the endpoint stores the RE-ENCODED validator output, never the raw upload
    (a JPEG with an appended <script> tail comes out clean).

Storage is patched at 'campaigns.views.ObjectStorageClient' in every test — this slice
never talks to MinIO/S3 (that is 2b-iv). Auth uses force_authenticate, matching
tests/test_church_scoped_endpoints.py.
"""

import io
import re
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.urls import reverse
from PIL import Image
from rest_framework import status
from rest_framework.test import APITestCase

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from integrations.object_storage import ObjectStorageError
from media.models import MediaAsset


def _jpeg():
    b = io.BytesIO()
    Image.new('RGB', (8, 8), (237, 143, 28)).save(b, 'JPEG')
    return b.getvalue()


def _upload(b, name='banner.jpg', ct='image/jpeg'):
    return SimpleUploadedFile(name, b, content_type=ct)


def _stub_put(mock_cls):
    """Make the patched ObjectStorageClient echo a deterministic url; return the spy."""
    mock_cls.return_value.put_object.side_effect = lambda key, data, content_type: {
        'key': key, 'url': f'http://test.local/pamoja-media/{key}'}
    return mock_cls.return_value.put_object


@override_settings(S3_BUCKET_NAME='pamoja-media')
class BannerUploadTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.church_a = Church.objects.create(
            name='Church A', official_email='a@example.org', phone='254700000001',
            address='addr', county='Nairobi', denomination='PCEA', status=ChurchStatus.ACTIVE,
        )
        cls.church_b = Church.objects.create(
            name='Church B', official_email='b@example.org', phone='254700000002',
            address='addr', county='Nairobi', denomination='PCEA', status=ChurchStatus.ACTIVE,
        )
        cls.treasurer_a = User.objects.create_user(
            email='ta@example.org', password='UnusedForTest!', first_name='F', last_name='L',
            role=UserRole.CHURCH_TREASURER, church=cls.church_a,
        )
        cls.treasurer_b = User.objects.create_user(
            email='tb@example.org', password='UnusedForTest!', first_name='F', last_name='L',
            role=UserRole.CHURCH_TREASURER, church=cls.church_b,
        )
        cls.campaign_a = Campaign.objects.create(
            slug='a-active', church=cls.church_a, title='Campaign A', description='desc',
            goal_amount='100000', raised_amount='0', wallet_balance='0',
            banner_image_url=None, category=CampaignCategory.BUILDING,
            treasurer_phone='254712345678', treasurer_name='Treas Urer',
            created_by=cls.treasurer_a, status=CampaignStatus.ACTIVE,
        )
        # campaign_b under church_b — the other-owner asset that replace must NEVER touch.
        cls.campaign_b = Campaign.objects.create(
            slug='b-active', church=cls.church_b, title='Campaign B', description='desc',
            goal_amount='100000', raised_amount='0', wallet_balance='0',
            banner_image_url=None, category=CampaignCategory.BUILDING,
            treasurer_phone='254712345679', treasurer_name='Treas Urer B',
            created_by=cls.treasurer_b, status=CampaignStatus.ACTIVE,
        )

    def _url(self):
        return reverse('campaign-banner-upload', args=[self.campaign_a.slug])

    # ── RED-A — cross-tenant IDOR (headline) ─────────────────────────────────────
    @patch('campaigns.views.validate_and_reencode')
    @patch('campaigns.views.ObjectStorageClient')
    def test_red_a_cross_tenant_idor_dies_before_content_or_storage(self, mock_cls, mock_validate):
        put_spy = _stub_put(mock_cls)
        self.client.force_authenticate(user=self.treasurer_b)
        resp = self.client.post(
            self._url(), {'file': _upload(_jpeg())}, format='multipart',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        put_spy.assert_not_called()
        mock_validate.assert_not_called()
        self.assertEqual(MediaAsset.objects.filter(campaign=self.campaign_a).count(), 0)
        self.campaign_a.refresh_from_db()
        self.assertIsNone(self.campaign_a.banner_image_url)

    # ── RED-B — endpoint stores RE-ENCODED bytes, not raw (real validator) ────────
    @patch('campaigns.views.ObjectStorageClient')
    def test_red_b_stores_reencoded_not_raw(self, mock_cls):
        put_spy = _stub_put(mock_cls)
        payload = _jpeg() + b'<script>alert(document.cookie)</script>'
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(
            self._url(), {'file': _upload(payload)}, format='multipart',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        put_spy.assert_called_once()
        stored = put_spy.call_args.args[1]  # (key, data, content_type)
        self.assertNotIn(b'<script>', stored)
        self.assertNotIn(b'alert', stored)

    # ── RED-C — missing file ─────────────────────────────────────────────────────
    @patch('campaigns.views.ObjectStorageClient')
    def test_red_c_missing_file(self, mock_cls):
        put_spy = _stub_put(mock_cls)
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(self._url(), {}, format='multipart')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        put_spy.assert_not_called()

    # ── RED-D — oversized rejected by the .size gate BEFORE read/validate ─────────
    @patch('campaigns.views.validate_and_reencode')
    @patch('campaigns.views.ObjectStorageClient')
    def test_red_d_oversized_rejected_early(self, mock_cls, mock_validate):
        put_spy = _stub_put(mock_cls)
        big = b'\xFF\xD8\xFF' + b'\x00' * (6 * 1024 * 1024)  # 6 MB, >5 MB cap
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(
            self._url(), {'file': _upload(big)}, format='multipart',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        put_spy.assert_not_called()
        mock_validate.assert_not_called()

    # ── GREEN — happy path (real validator, patched storage) ─────────────────────
    @patch('campaigns.views.ObjectStorageClient')
    def test_green_happy_path(self, mock_cls):
        put_spy = _stub_put(mock_cls)
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(
            self._url(), {'file': _upload(_jpeg())}, format='multipart',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        put_spy.assert_called_once()
        call_key, call_data, call_ct = (
            put_spy.call_args.args[0], put_spy.call_args.args[1], put_spy.call_args.args[2],
        )
        self.assertEqual(call_ct, 'image/jpeg')

        assets = MediaAsset.objects.filter(campaign=self.campaign_a)
        self.assertEqual(assets.count(), 1)
        asset = assets.get()
        self.assertEqual(asset.kind, 'BANNER')
        self.assertEqual(asset.campaign_id, self.campaign_a.id)
        self.assertIsNone(asset.church_id)
        self.assertRegex(
            asset.object_key,
            r'^campaign/%s/banner/[0-9a-f]{32}\.jpg$' % re.escape(str(self.campaign_a.id)),
        )
        self.assertEqual(asset.bucket, 'pamoja-media')
        self.assertEqual(asset.size_bytes, len(call_data))
        self.assertEqual(asset.uploaded_by_id, self.treasurer_a.id)

        self.campaign_a.refresh_from_db()
        self.assertEqual(
            self.campaign_a.banner_image_url,
            f'http://test.local/pamoja-media/{call_key}',
        )
        self.assertTrue(
            AuditLog.objects.filter(
                action='CAMPAIGN_BANNER_UPLOADED', entity_id=self.campaign_a.id,
            ).exists()
        )

    # ── Sub-slice 2: replace/dedup ───────────────────────────────────────────────
    # The helper (media.replace) builds its OWN ObjectStorageClient, so the delete
    # spy patches 'media.replace.ObjectStorageClient' — NOT the view's client. Every
    # replace test patches BOTH: the view's (put) and the helper's (delete).
    def _seed_banner(self, campaign, object_key):
        return MediaAsset.objects.create(
            kind='BANNER', campaign=campaign, church=None,
            object_key=object_key, bucket='pamoja-media',
            content_type='image/jpeg', size_bytes=633, uploaded_by=self.treasurer_a,
        )

    # ── RED-CROSS-OWNER (headline): replace deletes only A's prior, never B's ─────
    @patch('media.replace.ObjectStorageClient')
    @patch('campaigns.views.ObjectStorageClient')
    def test_replace_cross_owner_never_touches_other_owner(self, mock_view_cls, mock_replace_cls):
        _stub_put(mock_view_cls)
        del_spy = mock_replace_cls.return_value.delete_object
        old_a_key = f'campaign/{self.campaign_a.id}/banner/OLD_A.jpg'
        old_b_key = f'campaign/{self.campaign_b.id}/banner/OLD_B.jpg'
        self._seed_banner(self.campaign_a, old_a_key)
        old_b = self._seed_banner(self.campaign_b, old_b_key)

        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(self._url(), {'file': _upload(_jpeg())}, format='multipart')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        called_keys = [c.args[0] for c in del_spy.call_args_list]
        self.assertIn(old_a_key, called_keys)          # A's old key deleted
        self.assertNotIn(old_b_key, called_keys)       # B's key NEVER touched
        # B's asset row survives, untouched.
        self.assertTrue(self.campaign_b.media_assets.filter(id=old_b.id).exists())
        # A dedups to exactly one banner (the new one); OLD_A row is gone.
        a_assets = MediaAsset.objects.filter(campaign=self.campaign_a, kind='BANNER')
        self.assertEqual(a_assets.count(), 1)
        self.assertFalse(a_assets.filter(object_key=old_a_key).exists())

    # ── RED-DELETE-FAILS-SOFT: a delete error must NOT fail the upload ────────────
    @patch('media.replace.ObjectStorageClient')
    @patch('campaigns.views.ObjectStorageClient')
    def test_replace_delete_failure_is_soft(self, mock_view_cls, mock_replace_cls):
        put_spy = _stub_put(mock_view_cls)
        mock_replace_cls.return_value.delete_object.side_effect = ObjectStorageError('boom')
        old_a_key = f'campaign/{self.campaign_a.id}/banner/OLD_A.jpg'
        self._seed_banner(self.campaign_a, old_a_key)

        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(self._url(), {'file': _upload(_jpeg())}, format='multipart')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        self.campaign_a.refresh_from_db()
        self.assertEqual(
            self.campaign_a.banner_image_url,
            f'http://test.local/pamoja-media/{put_spy.call_args.args[0]}',   # the NEW url
        )
        # Delete failed → OLD row left for the sweep → 2 assets (old + new).
        self.assertEqual(MediaAsset.objects.filter(campaign=self.campaign_a, kind='BANNER').count(), 2)
        self.assertTrue(
            MediaAsset.objects.filter(campaign=self.campaign_a, object_key=old_a_key).exists()
        )

    # ── GREEN-REUPLOAD-DEDUPS: re-upload leaves exactly one banner ───────────────
    @patch('media.replace.ObjectStorageClient')
    @patch('campaigns.views.ObjectStorageClient')
    def test_replace_reupload_dedups_to_one(self, mock_view_cls, mock_replace_cls):
        _stub_put(mock_view_cls)
        del_spy = mock_replace_cls.return_value.delete_object
        old_a_key = f'campaign/{self.campaign_a.id}/banner/OLD_A.jpg'
        self._seed_banner(self.campaign_a, old_a_key)

        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(self._url(), {'file': _upload(_jpeg())}, format='multipart')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        del_spy.assert_called_once_with(old_a_key)
        self.assertEqual(MediaAsset.objects.filter(campaign=self.campaign_a, kind='BANNER').count(), 1)
