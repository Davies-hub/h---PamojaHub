"""Slice 3 — church logo upload endpoint tests (storage PATCHED, no MinIO).

The headline RED:
  * RED-INJECT — self-scope is STRUCTURAL: a treasurer POSTing an injected church_id
    (churchB) alongside a valid file has the logo attach to their OWN church (churchA),
    never churchB. The church comes from request.user, never the body.

Other REDs mirror the banner suite: RE-ENCODE (not raw), missing-file 400, oversized-early
reject (before validate), and SUSPENDED-church denial. GREEN is the happy path.

Storage is patched at 'churches.views.ObjectStorageClient' in every test — this slice never
talks to MinIO/S3 (that is the next step). Auth uses force_authenticate, matching
tests/test_banner_upload.py / tests/test_church_scoped_endpoints.py.
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
from churches.models import Church, ChurchStatus
from media.models import MediaAsset


def _jpeg():
    b = io.BytesIO()
    Image.new('RGB', (8, 8), (237, 143, 28)).save(b, 'JPEG')
    return b.getvalue()


def _upload(b, name='logo.jpg', ct='image/jpeg'):
    return SimpleUploadedFile(name, b, content_type=ct)


def _stub_put(mock_cls):
    """Make the patched ObjectStorageClient echo a deterministic url; return the spy."""
    mock_cls.return_value.put_object.side_effect = lambda key, data, content_type: {
        'key': key, 'url': f'http://test.local/pamoja-media/{key}'}
    return mock_cls.return_value.put_object


@override_settings(S3_BUCKET_NAME='pamoja-media')
class LogoUploadTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.church_a = Church.objects.create(
            name='Church A', official_email='a@example.org', phone='254700000001',
            address='addr', county='Nairobi', denomination='PCEA', status=ChurchStatus.ACTIVE,
            logo_url=None,
        )
        # churchB exists ONLY to be the injection target in RED-INJECT.
        cls.church_b = Church.objects.create(
            name='Church B', official_email='b@example.org', phone='254700000002',
            address='addr', county='Nairobi', denomination='PCEA', status=ChurchStatus.ACTIVE,
            logo_url=None,
        )
        cls.treasurer_a = User.objects.create_user(
            email='ta@example.org', password='UnusedForTest!', first_name='F', last_name='L',
            role=UserRole.CHURCH_TREASURER, church=cls.church_a,
        )
        cls.treasurer_b = User.objects.create_user(
            email='tb@example.org', password='UnusedForTest!', first_name='F', last_name='L',
            role=UserRole.CHURCH_TREASURER, church=cls.church_b,
        )

    def _url(self):
        return reverse('church-logo-upload')

    # ── RED-INJECT — self-scope is STRUCTURAL (headline) ─────────────────────────
    @patch('churches.views.ObjectStorageClient')
    def test_red_inject_church_id_ignored_self_scope(self, mock_cls):
        put_spy = _stub_put(mock_cls)
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(
            self._url(),
            {
                'file': _upload(_jpeg()),
                # Both injection vectors — a hostile client trying to redirect the logo.
                'church_id': str(self.church_b.id),
                'church': str(self.church_b.id),
            },
            format='multipart',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        put_spy.assert_called_once()

        # The asset attaches to churchA (the token's church), NOT the injected churchB.
        assets = MediaAsset.objects.filter(kind='LOGO')
        self.assertEqual(assets.count(), 1)
        asset = assets.get()
        self.assertEqual(asset.church_id, self.church_a.id)
        self.assertNotEqual(asset.church_id, self.church_b.id)
        self.assertTrue(asset.object_key.startswith(f'church/{self.church_a.id}/logo/'))

        # churchA gets the logo; churchB is untouched; no asset points at churchB.
        self.church_a.refresh_from_db()
        self.church_b.refresh_from_db()
        self.assertIsNotNone(self.church_a.logo_url)
        self.assertIsNone(self.church_b.logo_url)
        self.assertEqual(MediaAsset.objects.filter(church=self.church_b).count(), 0)

    # ── RED-B — stores RE-ENCODED bytes, not raw (real validator) ────────────────
    @patch('churches.views.ObjectStorageClient')
    def test_red_b_stores_reencoded_not_raw(self, mock_cls):
        put_spy = _stub_put(mock_cls)
        payload = _jpeg() + b'<script>alert(document.cookie)</script>'
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(
            self._url(), {'file': _upload(payload, 'logo.jpg', 'image/jpeg')},
            format='multipart',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        put_spy.assert_called_once()
        stored = put_spy.call_args.args[1]      # (key, data, content_type)
        self.assertNotIn(b'<script>', stored)
        self.assertNotIn(b'alert', stored)

    # ── RED-C — missing file → 400, storage untouched ───────────────────────────
    @patch('churches.views.ObjectStorageClient')
    def test_red_c_missing_file(self, mock_cls):
        put_spy = _stub_put(mock_cls)
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(self._url(), {}, format='multipart')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        put_spy.assert_not_called()

    # ── RED-D — oversized rejected BEFORE read/validate ──────────────────────────
    @patch('churches.views.validate_and_reencode')
    @patch('churches.views.ObjectStorageClient')
    def test_red_d_oversized_rejected_early(self, mock_cls, mock_validate):
        put_spy = _stub_put(mock_cls)
        big = b'\xFF\xD8\xFF' + b'\x00' * (6 * 1024 * 1024)
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(
            self._url(), {'file': _upload(big, 'big.jpg', 'image/jpeg')},
            format='multipart',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        put_spy.assert_not_called()
        mock_validate.assert_not_called()      # size gate fired before validate

    # ── RED-SUSPENDED — suspended church blocked (403) ───────────────────────────
    @patch('churches.views.ObjectStorageClient')
    def test_red_suspended_blocked(self, mock_cls):
        put_spy = _stub_put(mock_cls)
        self.church_a.status = ChurchStatus.SUSPENDED
        self.church_a.save(update_fields=['status'])
        try:
            self.client.force_authenticate(user=self.treasurer_a)
            resp = self.client.post(
                self._url(), {'file': _upload(_jpeg())}, format='multipart',
            )
            self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
            put_spy.assert_not_called()
            self.church_a.refresh_from_db()
            self.assertIsNone(self.church_a.logo_url)
        finally:
            self.church_a.status = ChurchStatus.ACTIVE
            self.church_a.save(update_fields=['status'])

    # ── GREEN — happy path (real validator, patched storage) ─────────────────────
    @patch('churches.views.ObjectStorageClient')
    def test_green_happy_path(self, mock_cls):
        put_spy = _stub_put(mock_cls)
        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(
            self._url(), {'file': _upload(_jpeg(), 'logo.jpg', 'image/jpeg')},
            format='multipart',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        put_spy.assert_called_once()
        key_arg, data_arg, ct_arg = put_spy.call_args.args
        self.assertEqual(ct_arg, 'image/jpeg')

        assets = MediaAsset.objects.filter(church=self.church_a)
        self.assertEqual(assets.count(), 1)
        asset = assets.get()
        self.assertEqual(asset.kind, 'LOGO')
        self.assertEqual(asset.church_id, self.church_a.id)
        self.assertIsNone(asset.campaign_id)
        self.assertRegex(
            asset.object_key,
            rf'^church/{self.church_a.id}/logo/[0-9a-f]{{32}}\.jpg$',
        )
        self.assertEqual(asset.bucket, 'pamoja-media')
        self.assertEqual(asset.size_bytes, len(data_arg))
        self.assertEqual(asset.uploaded_by_id, self.treasurer_a.id)

        self.church_a.refresh_from_db()
        self.assertEqual(
            self.church_a.logo_url,
            f'http://test.local/pamoja-media/{key_arg}',
        )

        self.assertTrue(
            AuditLog.objects.filter(
                action='CHURCH_LOGO_UPLOADED', entity_id=self.church_a.id,
            ).exists()
        )

    # ── Sub-slice 2: replace/dedup (mirror of the banner suite) ──────────────────
    # Delete spy patches 'media.replace.ObjectStorageClient' (the helper's own
    # client); the view's put patches 'churches.views.ObjectStorageClient'.
    def _seed_logo(self, church, object_key):
        return MediaAsset.objects.create(
            kind='LOGO', church=church, campaign=None,
            object_key=object_key, bucket='pamoja-media',
            content_type='image/jpeg', size_bytes=633, uploaded_by=self.treasurer_a,
        )

    # ── RED-CROSS-OWNER (headline): replace never touches church_b's logo ────────
    @patch('media.replace.ObjectStorageClient')
    @patch('churches.views.ObjectStorageClient')
    def test_replace_cross_owner_never_touches_other_church(self, mock_view_cls, mock_replace_cls):
        _stub_put(mock_view_cls)
        del_spy = mock_replace_cls.return_value.delete_object
        old_a_key = f'church/{self.church_a.id}/logo/OLD_A.jpg'
        old_b_key = f'church/{self.church_b.id}/logo/OLD_B.jpg'
        self._seed_logo(self.church_a, old_a_key)
        old_b = self._seed_logo(self.church_b, old_b_key)

        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(self._url(), {'file': _upload(_jpeg())}, format='multipart')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        called_keys = [c.args[0] for c in del_spy.call_args_list]
        self.assertIn(old_a_key, called_keys)          # A's old logo deleted
        self.assertNotIn(old_b_key, called_keys)       # B's logo NEVER touched
        self.assertTrue(self.church_b.media_assets.filter(id=old_b.id).exists())
        a_assets = MediaAsset.objects.filter(church=self.church_a, kind='LOGO')
        self.assertEqual(a_assets.count(), 1)
        self.assertFalse(a_assets.filter(object_key=old_a_key).exists())

    # ── GREEN-REUPLOAD-DEDUPS: re-upload leaves exactly one logo ─────────────────
    @patch('media.replace.ObjectStorageClient')
    @patch('churches.views.ObjectStorageClient')
    def test_replace_reupload_dedups_to_one(self, mock_view_cls, mock_replace_cls):
        _stub_put(mock_view_cls)
        del_spy = mock_replace_cls.return_value.delete_object
        old_a_key = f'church/{self.church_a.id}/logo/OLD_A.jpg'
        self._seed_logo(self.church_a, old_a_key)

        self.client.force_authenticate(user=self.treasurer_a)
        resp = self.client.post(self._url(), {'file': _upload(_jpeg())}, format='multipart')
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        del_spy.assert_called_once_with(old_a_key)
        self.assertEqual(MediaAsset.objects.filter(church=self.church_a, kind='LOGO').count(), 1)
