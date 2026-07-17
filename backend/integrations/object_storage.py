"""S3-compatible object-storage client — Slice 2a (MinIO in dev, S3 in prod).

Mirrors integrations/daraja.py's SHAPE: config is read from settings.X in
__init__ (nothing network-y there), ALL outbound I/O flows through a single
patchable seam (`_put`), and the public method returns a dict on success and
raises on any failure.

──────────────────────────────────────────────────────────────────────────────
THE FAILURE CONTRACT — ONE exception, NO clean/ambiguous split (read first)
──────────────────────────────────────────────────────────────────────────────
Unlike B2C (integrations/daraja.py), object storage has NO money-in-flight
problem, so it needs NO CLEAN vs AMBIGUOUS distinction. With B2C a dispatch that
"may or may not have landed" can mean a real payout is in flight, so the caller
must know which. Here, a PUT that may-or-may-not have landed leaves at worst an
ORPHAN object — wasted bytes, swept later — and NEVER a dangling reference,
because the caller (Slice 2b) writes metadata and sets the URL only AFTER a
confirmed PUT. So every failure mode (endpoint down, auth rejected, timeout
after send, bucket missing, malformed response) collapses to ONE exception:
ObjectStorageError. The caller turns that into a 502 and stores nothing.

Defines:
  * ObjectStorageError  — any failure to store an object.
  * ObjectStorageClient — put_object() + public_url(). The ONLY outbound I/O
                          flows through _put(), so a test can patch exactly that
                          boundary (`integrations.object_storage
                          .ObjectStorageClient._put`) and exercise the real
                          client logic with no MinIO/S3.
"""

import logging

import boto3
from botocore.client import Config
from django.conf import settings


logger = logging.getLogger(__name__)


class ObjectStorageError(Exception):
    """Any failure to store an object. Per the image-upload contract there is NO
    clean/ambiguous split (unlike B2C): no money is in flight, so a PUT that
    may-or-may-not have landed leaves at worst an ORPHAN object (wasted bytes,
    swept later) — never a dangling reference, because the caller writes metadata
    + sets the URL only AFTER a confirmed PUT. All failure modes (endpoint down,
    auth, timeout-after-send, bucket missing) collapse to this one exception →
    caller returns 502 and stores nothing.
    """


class ObjectStorageClient:
    """Talks to an S3-compatible store (MinIO in dev, S3 in prod). Config comes
    from settings.S3_*; the boto3 client is built lazily and cached so seam tests
    that patch _put never construct one.
    """

    def __init__(self):
        # Read config only — build NOTHING network-y here (mirrors DarajaClient).
        self.endpoint_url = settings.S3_ENDPOINT_URL
        self.access_key = settings.S3_ACCESS_KEY_ID
        self.secret_key = settings.S3_SECRET_ACCESS_KEY
        self.bucket = settings.S3_BUCKET_NAME
        self.region = settings.S3_REGION
        self.public_url_base = settings.S3_PUBLIC_URL_BASE
        self._cached_client = None

    # ── boto3 client (lazy) ──────────────────────────────────────────────────────
    def _client(self):
        """Lazily build and cache the boto3 S3 client. MinIO needs path-style
        addressing (bucket in the path, not the host). Lazy so seam tests that
        patch _put never construct a client.
        """
        if self._cached_client is None:
            self._cached_client = boto3.client(
                's3',
                endpoint_url=self.endpoint_url,
                aws_access_key_id=self.access_key,
                aws_secret_access_key=self.secret_key,
                region_name=self.region,
                config=Config(s3={'addressing_style': 'path'}),
            )
        return self._cached_client

    # ── THE I/O BOUNDARY ─────────────────────────────────────────────────────────
    def _put(self, key, data, content_type):
        """The ONLY place this module touches the network. put_object routes its
        single outbound call through here, so a test can patch exactly this method
        (`integrations.object_storage.ObjectStorageClient._put`) and exercise the
        full client logic with zero real MinIO/S3.
        """
        return self._client().put_object(
            Bucket=self.bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
        )

    # ── Public API ───────────────────────────────────────────────────────────────
    def put_object(self, key, data, content_type):
        """Store `data` at `key` with `content_type`. Returns
        {'key': key, 'url': public_url(key)} on a confirmed PUT; raises
        ObjectStorageError on ANY failure (see module docstring — no clean/
        ambiguous split). Does NOT write any metadata or set any reference; that
        is the caller's job, AFTER this returns.
        """
        try:
            self._put(key, data, content_type)
        except Exception as exc:
            raise ObjectStorageError(f'Object PUT failed for key {key!r}: {exc}') from exc

        logger.info('Stored object %s in bucket %s', key, self.bucket)
        return {'key': key, 'url': self.public_url(key)}

    def _delete(self, key):
        """The ONLY network boundary for deletes (mirrors _put). Tests patch exactly
        integrations.object_storage.ObjectStorageClient._delete. S3/MinIO DELETE is
        idempotent — deleting a missing key returns success, not an error."""
        return self._client().delete_object(Bucket=self.bucket, Key=key)

    def delete_object(self, key):
        """Delete the object at `key`. Idempotent: a missing key is a successful no-op
        (S3 DELETE semantics). Raises ObjectStorageError on any real failure (endpoint
        down, auth, network). Returns {'key': key, 'deleted': True} on success — the
        caller treats delete as best-effort AFTER the replacement object is already
        committed, so a raised error never leaves a dangling reference."""
        try:
            self._delete(key)
        except Exception as exc:
            raise ObjectStorageError(f'Object DELETE failed for key {key!r}: {exc}') from exc
        logger.info('Deleted object %s from bucket %s', key, self.bucket)
        return {'key': key, 'deleted': True}

    def _list(self, prefix=''):
        """The ONLY network boundary for listing (mirrors _put/_delete). Tests patch exactly
        integrations.object_storage.ObjectStorageClient._list. Returns an ITERABLE of raw boto3
        page dicts (each may have a 'Contents' list, or none if that page is empty). Uses the
        list_objects_v2 paginator so ALL pages are walked, not just the first 1000 keys."""
        paginator = self._client().get_paginator('list_objects_v2')
        return paginator.paginate(Bucket=self.bucket, Prefix=prefix)

    def list_objects(self, prefix=''):
        """List every object under `prefix` (default: whole bucket) as
        [{'key': str, 'last_modified': datetime, 'size': int}, ...]. Walks ALL pages.
        Raises ObjectStorageError on any failure. An empty bucket/prefix returns []
        (a page with no objects omits 'Contents' — handled via .get('Contents', []))."""
        out = []
        try:
            for page in self._list(prefix):
                for obj in page.get('Contents', []):        # empty page → no 'Contents' key → []
                    out.append({
                        'key': obj['Key'],
                        'last_modified': obj['LastModified'],
                        'size': obj['Size'],
                    })
        except Exception as exc:
            raise ObjectStorageError(f'Object LIST failed for prefix {prefix!r}: {exc}') from exc
        return out

    def public_url(self, key):
        """Path-style public URL for an object key. No double slash at the join."""
        return f"{self.public_url_base.rstrip('/')}/{key}"


def media_url(value):
    """Mint the browser-facing URL for a stored media reference at READ time.

    Three cases:
      * None / ''            -> returned unchanged (no media).
      * absolute http(s) URL -> returned unchanged, byte-identical. Old rows stored
        the full URL at upload time and are absolute forever — no backfill by
        design (2026-07-18); re-upload is the only way an old row gets a key.
      * bare object key      -> prefixed with settings.S3_PUBLIC_URL_BASE (read at
        call time, so changing the base re-points every key-holding row without
        any DB rewrite — the point of storing keys).
    """
    if not value:
        return value
    if value.startswith('http://') or value.startswith('https://'):
        return value
    return f"{settings.S3_PUBLIC_URL_BASE.rstrip('/')}/{value}"
