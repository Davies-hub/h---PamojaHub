"""Slice 2a — ObjectStorageClient seam tests.

Mirror tests/test_daraja_client.py: these exercise the REAL put_object /
public_url code paths and mock ONLY the I/O boundary
(ObjectStorageClient._put). No MinIO, no network — SimpleTestCase keeps them fast.

The failure contract here is SIMPLER than B2C's: there is NO clean/ambiguous
split. Every failure mode collapses to ObjectStorageError, so T2 proves a
generic Exception, a botocore EndpointConnectionError, and a botocore ClientError
ALL surface as the one exception.
"""

from datetime import datetime, timezone
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError, EndpointConnectionError
from django.test import SimpleTestCase, override_settings

from integrations.object_storage import ObjectStorageClient, ObjectStorageError


_S3_TEST_SETTINGS = dict(
    S3_ENDPOINT_URL='http://localhost:9000',
    S3_ACCESS_KEY_ID='test-key',
    S3_SECRET_ACCESS_KEY='test-secret',
    S3_BUCKET_NAME='pamoja-test',
    S3_REGION='us-east-1',
    S3_PUBLIC_URL_BASE='http://localhost:9000/pamoja-test',
)


@override_settings(**_S3_TEST_SETTINGS)
class ObjectStoragePutSeamTests(SimpleTestCase):
    # ── T1: success ──────────────────────────────────────────────────────────────
    def test_success_returns_key_and_url(self):
        with patch.object(ObjectStorageClient, '_put', return_value=None):
            result = ObjectStorageClient().put_object(
                'campaign/x/banner/u.jpg', b'bytes', 'image/jpeg',
            )
        self.assertEqual(result, {
            'key': 'campaign/x/banner/u.jpg',
            'url': 'http://localhost:9000/pamoja-test/campaign/x/banner/u.jpg',
        })

    # ── T2: every failure mode → ObjectStorageError ──────────────────────────────
    def test_generic_exception_is_object_storage_error(self):
        with patch.object(ObjectStorageClient, '_put', side_effect=Exception('boom')):
            with self.assertRaises(ObjectStorageError):
                ObjectStorageClient().put_object('k', b'b', 'image/jpeg')

    def test_endpoint_connection_error_is_object_storage_error(self):
        exc = EndpointConnectionError(endpoint_url='http://localhost:9000')
        with patch.object(ObjectStorageClient, '_put', side_effect=exc):
            with self.assertRaises(ObjectStorageError):
                ObjectStorageClient().put_object('k', b'b', 'image/jpeg')

    def test_client_error_is_object_storage_error(self):
        exc = ClientError(
            {'Error': {'Code': 'NoSuchBucket', 'Message': 'bucket missing'}},
            'PutObject',
        )
        with patch.object(ObjectStorageClient, '_put', side_effect=exc):
            with self.assertRaises(ObjectStorageError):
                ObjectStorageClient().put_object('k', b'b', 'image/jpeg')

    # ── T-del-1: success returns {'key', 'deleted': True} ────────────────────────
    def test_delete_success_returns_deleted_true(self):
        with patch.object(ObjectStorageClient, '_delete', return_value=None):
            result = ObjectStorageClient().delete_object('campaign/x/banner/u.jpg')
        self.assertEqual(result, {'key': 'campaign/x/banner/u.jpg', 'deleted': True})

    # ── T-del-2: generic failure → ObjectStorageError ────────────────────────────
    def test_delete_generic_exception_is_object_storage_error(self):
        with patch.object(ObjectStorageClient, '_delete', side_effect=Exception('boom')):
            with self.assertRaises(ObjectStorageError):
                ObjectStorageClient().delete_object('k')

    # ── T-del-3: botocore ClientError → ObjectStorageError ───────────────────────
    def test_delete_client_error_is_object_storage_error(self):
        exc = ClientError(
            {'Error': {'Code': 'AccessDenied', 'Message': 'nope'}},
            'DeleteObject',
        )
        with patch.object(ObjectStorageClient, '_delete', side_effect=exc):
            with self.assertRaises(ObjectStorageError):
                ObjectStorageClient().delete_object('k')

    # ── T-del-4: idempotent shape — missing key on real S3 returns normally, so a
    # normally-returning _delete still yields {'deleted': True} (no special-casing).
    def test_delete_missing_key_is_success_no_op(self):
        with patch.object(ObjectStorageClient, '_delete', return_value=None):
            result = ObjectStorageClient().delete_object('campaign/x/banner/gone.jpg')
        self.assertEqual(result, {'key': 'campaign/x/banner/gone.jpg', 'deleted': True})

    # ── T-list-1: MULTI-PAGE — the paginator must walk EVERY page, not just the first.
    # A single-page-only impl would drop page 2's key → this test catches it.
    def test_list_walks_all_pages_and_maps_fields(self):
        dt1 = datetime(2026, 7, 1, 10, 0, 0, tzinfo=timezone.utc)
        dt2 = datetime(2026, 7, 1, 11, 0, 0, tzinfo=timezone.utc)
        dt3 = datetime(2026, 7, 2, 9, 0, 0, tzinfo=timezone.utc)
        pages = [
            {'Contents': [
                {'Key': 'campaign/1/banner/a.jpg', 'LastModified': dt1, 'Size': 10},
                {'Key': 'campaign/1/banner/b.jpg', 'LastModified': dt2, 'Size': 20},
            ]},
            {'Contents': [
                {'Key': 'church/2/logo/c.png', 'LastModified': dt3, 'Size': 30},
            ]},
        ]
        with patch.object(ObjectStorageClient, '_list', return_value=pages):
            result = ObjectStorageClient().list_objects('')
        self.assertEqual(result, [
            {'key': 'campaign/1/banner/a.jpg', 'last_modified': dt1, 'size': 10},
            {'key': 'campaign/1/banner/b.jpg', 'last_modified': dt2, 'size': 20},
            {'key': 'church/2/logo/c.png', 'last_modified': dt3, 'size': 30},
        ])

    # ── T-list-2: EMPTY bucket — a page with NO 'Contents' key (real S3 empty shape).
    def test_list_empty_bucket_returns_empty_list(self):
        with patch.object(ObjectStorageClient, '_list', return_value=[{}]):
            result = ObjectStorageClient().list_objects('')
        self.assertEqual(result, [])

    # ── T-list-3: generic failure → ObjectStorageError ───────────────────────────
    def test_list_generic_exception_is_object_storage_error(self):
        with patch.object(ObjectStorageClient, '_list', side_effect=Exception('boom')):
            with self.assertRaises(ObjectStorageError):
                ObjectStorageClient().list_objects('')

    # ── T-list-4: botocore ClientError → ObjectStorageError ──────────────────────
    def test_list_client_error_is_object_storage_error(self):
        exc = ClientError(
            {'Error': {'Code': 'AccessDenied', 'Message': 'nope'}},
            'ListObjectsV2',
        )
        with patch.object(ObjectStorageClient, '_list', side_effect=exc):
            with self.assertRaises(ObjectStorageError):
                ObjectStorageClient().list_objects('')

    # ── T-list-5: prefix passthrough — the caller's prefix reaches _list verbatim.
    def test_list_passes_prefix_through_to_seam(self):
        mock_list = Mock(return_value=[{}])
        with patch.object(ObjectStorageClient, '_list', mock_list):
            ObjectStorageClient().list_objects('campaign/x/')
        mock_list.assert_called_once_with('campaign/x/')


@override_settings(**_S3_TEST_SETTINGS)
class PublicUrlShapeTests(SimpleTestCase):
    # ── T3: public_url shape (no double slash) ───────────────────────────────────
    def test_public_url_no_double_slash(self):
        url = ObjectStorageClient().public_url('a/b.jpg')
        self.assertEqual(url, 'http://localhost:9000/pamoja-test/a/b.jpg')

    @override_settings(S3_PUBLIC_URL_BASE='http://localhost:9000/pamoja-test/')
    def test_public_url_strips_trailing_slash_on_base(self):
        # A base WITH a trailing slash must NOT produce a double slash at the join.
        url = ObjectStorageClient().public_url('a/b.jpg')
        self.assertEqual(url, 'http://localhost:9000/pamoja-test/a/b.jpg')
