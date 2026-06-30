"""DEV-ONLY clock helper (Slice 2): set a church's subscription expiry/tier so the
subscription lifecycle (reminders + lapse) can be demoed without waiting real days.

This is the ONLY writer of subscription_expires_at until slice 3, so its DEBUG guard
is mandatory: it refuses to run when settings.DEBUG is False. It sets expires_at =
now + --days (negative allowed → past-dated for lapse demos), optionally sets --tier,
and resets the reminder marker (period=None, stage=NONE) so a re-run demos clean.
"""

from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from churches.models import Church, REMINDER_STAGE_NONE, SubscriptionTier


class Command(BaseCommand):
    help = (
        'DEV-ONLY: set a church subscription_expires_at to now + --days (negative '
        'allowed), optionally set --tier, and reset the reminder marker. Refuses to '
        'run unless DEBUG is True.'
    )

    def add_arguments(self, parser):
        parser.add_argument('--church', required=True,
                            help='Church id (UUID) or official_email.')
        parser.add_argument('--days', type=int, required=True,
                            help='Offset in days from now for expires_at (negative = past).')
        parser.add_argument('--tier', choices=[SubscriptionTier.GROWTH, SubscriptionTier.PARISH],
                            default=None, help='Optional: also set the subscription tier.')

    def handle(self, *args, **options):
        if not settings.DEBUG:
            raise CommandError('Refusing: dev-only command, DEBUG is False.')

        db_name = settings.DATABASES['default'].get('NAME')
        self.stdout.write(
            f'set_subscription_expiry | settings={settings.SETTINGS_MODULE} | DB={db_name}'
        )

        ref = options['church']
        church = Church.objects.filter(id=ref).first() if _looks_like_uuid(ref) else None
        if church is None:
            church = Church.objects.filter(official_email=ref).first()
        if church is None:
            raise CommandError(f'No church matching id-or-email {ref!r}.')

        if options['tier'] is not None:
            church.subscription_tier = options['tier']
        church.subscription_expires_at = timezone.now() + timedelta(days=options['days'])
        # Reset the reminder dedup marker so a re-run demos cleanly.
        church.subscription_reminder_period = None
        church.subscription_reminder_stage = REMINDER_STAGE_NONE
        church.save(update_fields=[
            'subscription_tier',
            'subscription_expires_at',
            'subscription_reminder_period',
            'subscription_reminder_stage',
        ])

        self.stdout.write(self.style.SUCCESS(
            f'{church.name} | tier={church.subscription_tier} | '
            f'expires_at={church.subscription_expires_at.isoformat()} | reminder marker reset.'
        ))


def _looks_like_uuid(value):
    import uuid
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, AttributeError, TypeError):
        return False
