"""Super Admin platform-wide config — PlatformSettings singleton.

Co-located with the superadmin app because this is its only consumer surface:
the IsSuperAdmin billing GET/PATCH endpoints. The model has only ONE row;
several enforcement layers keep it that way:

  1. Fixed `SINGLETON_ID = 1` as the primary key default.
  2. `save()` overrides pk to `SINGLETON_ID` on every save — a second
     `PlatformSettings.objects.create()` overwrites row 1 rather than adding
     a row 2.
  3. `delete()` is a no-op — there is no path to zero rows from the model.
  4. `load()` get_or_creates with defaults — the first read on a fresh DB
     returns defaults, never raises DoesNotExist.

Defaults (Compressed Context §13): fee 2.50%, Growth KES 999/mo, Parish KES
2,499/mo.

CRITICAL — fee_percent is INTERNAL:
  * Server-side donation processing (Step 2.10) reads
    `PlatformSettings.load().fee_percent` LIVE — fee changes apply
    forward-only to new donations. Existing donations keep their
    per-row `platform_fee` / `net_amount` stored at write time.
  * `fee_percent` MUST NEVER appear in any public or treasurer-facing
    response. The only API surface that exposes it is GET /api/v1/super/billing/
    (IsSuperAdmin). Tests in tests/test_superadmin.py confine this.
"""

from decimal import Decimal

from django.db import models


class PlatformSettings(models.Model):
    SINGLETON_ID = 1

    id = models.PositiveSmallIntegerField(
        primary_key=True, default=SINGLETON_ID, editable=False,
    )
    fee_percent = models.DecimalField(
        max_digits=5, decimal_places=2, default=Decimal('2.50'),
    )
    growth_price = models.DecimalField(
        max_digits=10, decimal_places=2, default=Decimal('999.00'),
    )
    parish_price = models.DecimalField(
        max_digits=10, decimal_places=2, default=Decimal('2499.00'),
    )
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        # Pin the pk — there can be only one PlatformSettings row.
        self.pk = self.SINGLETON_ID
        # Force UPDATE rather than INSERT when a row already exists. Without
        # this, a brand-new `PlatformSettings(...)` instance has
        # `_state.adding = True` and Django attempts an INSERT, which fails
        # on the pk uniqueness constraint. Flipping the flag to False makes
        # save() UPDATE the existing row (singleton overwrite). The
        # filter().exists() check is racey under concurrent first-creates,
        # but the singleton is initialized eagerly via load() in normal
        # operation; first-create concurrency on a fresh DB is unrealistic.
        if type(self).objects.filter(pk=self.SINGLETON_ID).exists():
            self._state.adding = False
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        # The singleton is not deletable. Silently no-op rather than raise
        # so a careless ORM call doesn't 500; the test suite still asserts
        # count == 1 after attempted creates.
        return None

    @classmethod
    def load(cls):
        """Return the singleton, creating it with defaults if it doesn't exist."""
        obj, _ = cls.objects.get_or_create(pk=cls.SINGLETON_ID)
        return obj
