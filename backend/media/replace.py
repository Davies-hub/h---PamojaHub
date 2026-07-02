import logging

from integrations.object_storage import ObjectStorageClient, ObjectStorageError

logger = logging.getLogger(__name__)


def delete_prior_assets(owner, kind, keep_asset_id):
    """Best-effort replace: delete the bucket objects + rows for `owner`'s prior assets of `kind`,
    EXCLUDING the just-created asset (keep_asset_id). Owner-scoped via the reverse relation
    (owner.media_assets) — structurally cannot reach another owner's assets.

    MUST be called AFTER the new asset is committed and the owner's *_url is set (mirror of the
    upload's put-before-commit): the new image is already live, so any failure here is harmless
    (a leftover object the orphan-sweep collects) — NEVER a missing current image.

    Per prior asset: delete the OBJECT first (best-effort); only if that succeeds, delete the ROW.
    On ObjectStorageError, log and SKIP that asset (leave the row so the sweep retries) — do NOT
    delete a row whose object may still exist. This function never raises; it returns a summary
    dict for logging/tests: {'deleted': n, 'skipped': m}.
    """
    client = ObjectStorageClient()
    deleted = skipped = 0
    # owner.media_assets is the ONLY source — never MediaAsset.objects (that could cross owners).
    prior = owner.media_assets.filter(kind=kind).exclude(id=keep_asset_id)
    for asset in list(prior):
        try:
            client.delete_object(asset.object_key)
        except ObjectStorageError as exc:
            logger.warning('replace: object delete failed for %s (%s) — leaving row for sweep',
                           asset.object_key, exc)
            skipped += 1
            continue
        asset.delete()
        deleted += 1
    return {'deleted': deleted, 'skipped': skipped}
