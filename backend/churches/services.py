"""Church domain services — shared write helpers.

`set_church_tier` is the single spine for every subscription-tier write: the
Super-Admin set-tier endpoint and the subscription-lapse job both call it, so the
lock-then-compare-then-save-then-audit shape lives in exactly one place.
"""

from audit.models import AuditLog


def set_church_tier(locked_church, new_tier, *, actor, action, ip_address=None, details_extra=None):
    """Write a church's subscription_tier + audit. PRECONDITION: call inside
    transaction.atomic() on a row already locked via select_for_update().
    No-op safe: if already on new_tier, returns False (no save, no audit).
    Returns True if the tier changed. Does NOT touch subscription_expires_at,
    wallet, or any other field — callers own period/expiry side effects.
    actor=None and ip_address=None are valid (system/job actor)."""
    if locked_church.subscription_tier == new_tier:
        return False

    old_tier = locked_church.subscription_tier
    locked_church.subscription_tier = new_tier
    locked_church.save(update_fields=['subscription_tier'])

    details = {
        'church_name': locked_church.name,
        'old_tier': old_tier,
        'new_tier': new_tier,
    }
    details.update(details_extra or {})
    AuditLog.objects.create(
        actor=actor,
        action=action,
        entity_type='Church',
        entity_id=locked_church.id,
        details=details,
        ip_address=ip_address,
    )
    return True
