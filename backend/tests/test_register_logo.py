"""Register-time OPTIONAL church logo — abuse-rejection is the acceptance gate.

Design (option a): the church/user commit first (transaction.atomic in RegisterView);
the logo is attached POST-COMMIT by _attach_registration_logo, OUTSIDE that transaction,
so a logo failure degrades softly to logo_failed=True in the 201 body and can NEVER roll
back a successful registration. Storage is PATCHED at 'accounts.views.ObjectStorageClient'
in every test — this suite never talks to MinIO/S3. The real magic-byte + Pillow validator
(media.validation.validate_and_reencode) runs unpatched, so the non-image RED exercises it.

The headline REDs (the gate):
  * non-image (text-as-.jpg)  → 201, logo_failed, NO MediaAsset, church.logo_url NULL, church EXISTS
  * oversized (>5 MB)         → same soft-degrade, church created, no logo, PUT never called
  * PUT failure (storage down)→ same soft-degrade, NO dangling logo_url
  * rate limit (4th POST/IP)  → 429 (3/h per IP), copying test_portal's loop+assert
  * regression: JSON no-logo  → 201 unchanged, no logo_failed key
"""

import io
from unittest.mock import patch

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.urls import reverse
from PIL import Image
from rest_framework import status
from rest_framework.test import APITestCase

from audit.models import AuditLog
from churches.models import Church, ChurchStatus
from integrations.object_storage import ObjectStorageError
from media.models import MediaAsset


def _jpeg():
    b = io.BytesIO()
    Image.new('RGB', (8, 8), (237, 143, 28)).save(b, 'JPEG')
    return b.getvalue()


def _logo(b, name='logo.jpg', ct='image/jpeg'):
    return SimpleUploadedFile(name, b, content_type=ct)


def _reg_fields(email='new@example.org', phone='254700000001'):
    """The text fields RegisterView requires — no logo. Used for both the multipart
    (logo added by the caller) and JSON (regression) paths."""
    return {
        'name': 'New Church',
        'official_email': email,
        'phone': phone,
        'address': '1 Test Road, Nairobi',
        'denomination': 'PCEA',
        'password': 'Sup3rL0ngPass!word',
    }


def _stub_put(mock_cls):
    """Patched ObjectStorageClient echoes a deterministic {key,url}; return the spy."""
    mock_cls.return_value.put_object.side_effect = lambda key, data, content_type: {
        'key': key, 'url': f'http://test.local/pamoja-media/{key}'}
    return mock_cls.return_value.put_object


@override_settings(S3_BUCKET_NAME='pamoja-media',
                   S3_PUBLIC_URL_BASE='http://test.local/pamoja-media')
class RegisterLogoTests(APITestCase):
    def setUp(self):
        # Register is rate-limited 3/h per IP; clear the django-ratelimit locmem cache
        # between tests so single-POST tests from the shared 127.0.0.1 don't accumulate
        # into a 429 (the dedicated rate-limit test drives the limit within one method).
        cache.clear()
        self.url = reverse('auth-register')

    # ── HAPPY — valid JPEG → 201, bare-key logo_url, MediaAsset + AuditLog ────────
    @patch('accounts.views.ObjectStorageClient')
    def test_happy_valid_logo_stored_as_bare_key(self, mock_cls):
        put_spy = _stub_put(mock_cls)
        resp = self.client.post(
            self.url,
            {**_reg_fields(), 'logo': _logo(_jpeg())},
            format='multipart',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertIs(resp.data.get('logo_failed'), False)
        put_spy.assert_called_once()

        church = Church.objects.get(official_email='new@example.org')
        # Stored value is the BARE object key (2026-07-18 key-storage slice), NOT a URL.
        self.assertIsNotNone(church.logo_url)
        self.assertFalse(church.logo_url.startswith('http'))
        self.assertTrue(church.logo_url.startswith(f'church/{church.id}/logo/'))

        assets = MediaAsset.objects.filter(church=church, kind='LOGO')
        self.assertEqual(assets.count(), 1)
        self.assertEqual(assets.get().object_key, church.logo_url)
        self.assertTrue(
            AuditLog.objects.filter(
                action='CHURCH_LOGO_UPLOADED', entity_id=church.id,
            ).exists()
        )

    # ── RED — non-image (text renamed .jpg) → soft-degrade, church survives ───────
    @patch('accounts.views.ObjectStorageClient')
    def test_red_non_image_degrades_church_survives(self, mock_cls):
        put_spy = _stub_put(mock_cls)
        junk = b'this is definitely not a real jpeg, just text bytes'
        resp = self.client.post(
            self.url,
            {**_reg_fields(), 'logo': _logo(junk, 'logo.jpg', 'image/jpeg')},
            format='multipart',
        )
        # Registration SUCCEEDS; only the logo failed.
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertIs(resp.data.get('logo_failed'), True)
        put_spy.assert_not_called()             # rejected at the content gate, before any PUT

        church = Church.objects.get(official_email='new@example.org')   # church EXISTS
        self.assertEqual(church.status, ChurchStatus.PENDING)
        self.assertIsNone(church.logo_url)                              # no dangling url
        self.assertEqual(MediaAsset.objects.filter(church=church).count(), 0)

    # ── RED — oversized (>5 MB) → rejected before read/validate, church survives ──
    @patch('accounts.views.validate_and_reencode')
    @patch('accounts.views.ObjectStorageClient')
    def test_red_oversized_degrades_church_survives(self, mock_cls, mock_validate):
        put_spy = _stub_put(mock_cls)
        big = b'\xFF\xD8\xFF' + b'\x00' * (6 * 1024 * 1024)     # 6 MB, JPEG magic
        resp = self.client.post(
            self.url,
            {**_reg_fields(), 'logo': _logo(big, 'big.jpg', 'image/jpeg')},
            format='multipart',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertIs(resp.data.get('logo_failed'), True)
        put_spy.assert_not_called()
        mock_validate.assert_not_called()       # size gate fired BEFORE validate

        church = Church.objects.get(official_email='new@example.org')
        self.assertIsNone(church.logo_url)
        self.assertEqual(MediaAsset.objects.filter(church=church).count(), 0)

    # ── RED — storage PUT failure → soft-degrade, NO dangling logo_url ───────────
    @patch('accounts.views.ObjectStorageClient')
    def test_red_put_failure_degrades_no_dangling_url(self, mock_cls):
        mock_cls.return_value.put_object.side_effect = ObjectStorageError('minio down')
        resp = self.client.post(
            self.url,
            {**_reg_fields(), 'logo': _logo(_jpeg())},
            format='multipart',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertIs(resp.data.get('logo_failed'), True)

        church = Church.objects.get(official_email='new@example.org')   # church EXISTS
        self.assertIsNone(church.logo_url)                             # PUT before commit → no dangling ref
        self.assertEqual(MediaAsset.objects.filter(church=church).count(), 0)

    # ── RED — rate limit: 4th POST from one IP → 429 (3/h per IP) ────────────────
    def test_red_rate_limit_fourth_post_is_429(self):
        codes = []
        for i in range(4):
            r = self.client.post(
                self.url,
                _reg_fields(email=f'rl{i}@example.org', phone=f'25470000010{i}'),
                format='json',
                REMOTE_ADDR='9.9.9.9',
            )
            codes.append(r.status_code)
        # First 3 within budget → 201; 4th exhausts the per-IP bucket → 429.
        self.assertEqual(codes[:3], [201, 201, 201], msg=f'codes={codes}')
        self.assertEqual(codes[3], 429, msg=f'4th register was not rate-limited: codes={codes}')
        # The blocked request never ran post() → only 3 churches exist.
        self.assertEqual(Church.objects.count(), 3)

    # ── REGRESSION — JSON no-logo register is unchanged (no logo_failed key) ──────
    def test_regression_json_no_logo_unchanged(self):
        resp = self.client.post(self.url, _reg_fields(), format='json')
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertIn('user', resp.data)
        self.assertEqual(resp.data['church_status'], ChurchStatus.PENDING)
        # The new field is ABSENT when no logo was submitted — JSON path byte-identical.
        self.assertNotIn('logo_failed', resp.data)

        church = Church.objects.get(official_email='new@example.org')
        self.assertIsNone(church.logo_url)
        self.assertEqual(MediaAsset.objects.filter(church=church).count(), 0)
