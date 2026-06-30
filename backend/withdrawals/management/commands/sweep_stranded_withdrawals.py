"""A2 trigger (2026-06-07) for the escalate-only B2C stranded-withdrawal sweep.

Runs `run_stranded_withdrawal_sweep` SYNCHRONOUSLY, in-process — deliberately NOT
via Celery (no `.delay()`/`.apply_async()`). A2 exists precisely to avoid needing a
Celery worker/beat runtime: this command is invoked manually or by a system cron.

OPERATIONAL SAFETY: the stranded-row safety net only fires when this command is
actually run, and in production it MUST run with
`DJANGO_SETTINGS_MODULE=config.settings.production` — `manage.py` defaults to
`config.settings.development`. So the command prints its active settings module AND
database name at startup; a run against the wrong settings/DB is then visible in cron
output. Re-running / overlapping runs are safe: the sweep's select_for_update +
candidate recheck makes an already-escalated row a non-candidate on the next pass.
"""

from django.conf import settings
from django.core.management.base import BaseCommand

from withdrawals.tasks import run_stranded_withdrawal_sweep


class Command(BaseCommand):
    help = (
        'Escalate stranded B2C payouts (stale PROCESSING / AMBIGUOUS-FAILED rows) to '
        'NEEDS_RECONCILIATION for manual reconciliation. Runs synchronously in-process '
        '(no Celery). Safe to re-run.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--staleness-minutes', type=int, default=None,
            help='Override B2C_SWEEP_STALENESS_MINUTES (only escalate rows older than this).',
        )

    def handle(self, *args, **options):
        # Dev-default-settings defense: surface WHICH settings + DB this run touched,
        # so a misconfigured cron entry is visible in its output.
        db_name = settings.DATABASES['default'].get('NAME')
        self.stdout.write(
            f'sweep_stranded_withdrawals starting | '
            f'settings={settings.SETTINGS_MODULE} | DB={db_name}'
        )

        # Synchronous, in-process. Unhandled exceptions propagate → non-zero exit
        # (so cron surfaces failures); a clean run returns None → exit 0.
        escalated = run_stranded_withdrawal_sweep(
            staleness_minutes=options.get('staleness_minutes'),
        )

        self.stdout.write(self.style.SUCCESS(
            f'Escalated {escalated} stranded payout(s) to NEEDS_RECONCILIATION.'
        ))
