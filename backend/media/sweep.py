import logging
from datetime import timedelta

from django.utils import timezone

from integrations.object_storage import ObjectStorageClient, ObjectStorageError
from media.models import MediaAsset

logger = logging.getLogger(__name__)


def sweep_orphan_media(grace_minutes=60, commit=False):
    """Find bucket objects with NO referencing MediaAsset row, older than the grace window,
    and (if commit) delete them. Returns a summary dict:
      {'scanned': n, 'referenced': r, 'orphans': o, 'in_grace_skipped': g,
       'deleted': d, 'delete_failed': f, 'reclaimed_bytes': b, 'committed': commit,
       'orphan_keys': [...]}   # orphan_keys for dry-run reporting

    SAFETY (fail toward UNDER-delete):
      - referenced set is computed FRESH here (set(MediaAsset.object_key)) — authoritative.
      - an object is a candidate ONLY IF its key is NOT referenced AND it is OLDER than grace.
      - grace uses timezone.now() vs the object's last_modified (both tz-aware UTC).
      - dry-run (commit=False) deletes NOTHING — only reports.
      - delete is best-effort per object; an ObjectStorageError is counted (delete_failed),
        logged, and does NOT abort the sweep (next run retries).
    """
    client = ObjectStorageClient()
    cutoff = timezone.now() - timedelta(minutes=grace_minutes)
    referenced = set(MediaAsset.objects.values_list('object_key', flat=True))   # FRESH, authoritative

    objects = client.list_objects('')     # whole bucket
    scanned = len(objects)
    orphans = []
    in_grace_skipped = 0
    for obj in objects:
        if obj['key'] in referenced:
            continue                       # LIVE — never a candidate
        if obj['last_modified'] > cutoff:
            in_grace_skipped += 1          # too young — could be mid-upload; skip
            continue
        orphans.append(obj)

    deleted = delete_failed = reclaimed = 0
    if commit:
        for obj in orphans:
            try:
                client.delete_object(obj['key'])
            except ObjectStorageError as exc:
                logger.warning('sweep: delete failed for %s (%s)', obj['key'], exc)
                delete_failed += 1
                continue
            deleted += 1
            reclaimed += obj['size']
    else:
        reclaimed = sum(o['size'] for o in orphans)   # would-be reclaim (dry-run)

    return {
        'scanned': scanned, 'referenced': len(referenced), 'orphans': len(orphans),
        'in_grace_skipped': in_grace_skipped, 'deleted': deleted,
        'delete_failed': delete_failed, 'reclaimed_bytes': reclaimed,
        'committed': commit, 'orphan_keys': [o['key'] for o in orphans],
    }
