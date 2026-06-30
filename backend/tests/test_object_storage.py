"""Slice 2a — ObjectStorageClient seam tests.

Mirror tests/test_daraja_client.py: these exercise the REAL put_object /
public_url code paths and mock ONLY the I/O boundary
(ObjectStorageClient._put). No MinIO, no network — SimpleTestCase keeps them fast.

The failure contract here is SIMPLER than B2C's: there is NO clean/ambiguous
split. Every failure mode collapses to ObjectStorageError, so T2 proves a
generic Exception, a botocore EndpointConnectionError, and a botocore ClientError
ALL surface as the one exception.
"""

from unittest.mock import patch

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
