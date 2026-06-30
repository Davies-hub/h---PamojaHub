"""Daily subscription processor (Slice 2): renewal reminders + grace-period lapse.

Runs `run_subscription_reminders` then `run_subscription_lapses` SYNCHRONOUSLY,
in-process — deliberately NOT via Celery (mirrors sweep_stranded_withdrawals). This
is the single daily cron entry point for the subscription lifecycle.

OPERATIONAL SAFETY: in production it MUST run with
`DJANGO_SETTINGS_MODULE=config.settings.production` — `manage.py` defaults to
`config.settings.development`. The command prints its active settings module AND
database name at startup so a run against the wrong settings/DB is visible in cron
output. Re-running / overlapping runs are safe: reminders are deduped per period via
the church's reminder marker, and a lapsed (now-FREE / null-expiry) church is no
longer a candidate on the next pass.
"""

from django.conf import settings
from django.core.management.base import BaseCommand

from churches.tasks import run_subscription_lapses, run_subscription_reminders


class Command(BaseCommand):
    help = (
        'Process church subscriptions: send 7-day/1-day renewal reminders (once each '
        'per period) and lapse paid churches past their grace window to FREE. Runs '
        'synchronously in-process (no Celery). Safe to re-run.'
    )

    def handle(self, *args, **options):
        db_name = settings.DATABASES['default'].get('NAME')
        self.stdout.write(
            f'process_subscriptions starting | '
            f'settings={settings.SETTINGS_MODULE} | DB={db_name}'
        )

        notified = run_subscription_reminders()
        lapsed = run_subscription_lapses()

        self.stdout.write(self.style.SUCCESS(
            f'Reminders sent to {notified} church(es); lapsed {lapsed} church(es) to FREE.'
        ))
