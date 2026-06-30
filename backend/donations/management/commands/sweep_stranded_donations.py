"""Step 3 trigger for the stranded-donation resolver (query-and-escalate, NEVER credits).

Runs `run_stranded_donation_sweep` SYNCHRONOUSLY, in-process — deliberately NOT via
Celery (no `.delay()`/`.apply_async()`), mirroring the A2 withdrawal command. Invoked
manually or by a system cron.

OPERATIONAL SAFETY: the resolver only fires when this command is actually run, and in
production it MUST run with `DJANGO_SETTINGS_MODULE=config.settings.production` —
`manage.py` defaults to `config.settings.development`. So the command prints its active
settings module AND database name at startup; a run against the wrong settings/DB is then
visible in cron output. Re-running / overlapping runs are safe: the resolver's
select_for_update + still-PENDING recheck makes an already-resolved row a non-candidate.

NOTE: this command hits the live Daraja STK Push Query (rate-limited ~5/min); the
resolver throttles between rows. It NEVER credits a donation — at most it marks a row
FAILED or flags a "looks paid" row for a Super Admin to credit by hand.
"""

from django.conf import settings
from django.core.management.base import BaseCommand

from donations.tasks import run_stranded_donation_sweep


class Command(BaseCommand):
    help = (
        'Resolve stranded donations: query Daraja STK Push Query for stale PENDING rows '
        'and escalate (FAILED, or flag-for-review on a "looks paid" row). Runs '
        'synchronously in-process (no Celery). NEVER credits a donation. Safe to re-run.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--staleness-minutes', type=int, default=None,
            help='Override DONATION_SWEEP_STALENESS_MINUTES (only sweep rows older than this).',
        )

    def handle(self, *args, **options):
        # Dev-default-settings defense: surface WHICH settings + DB this run touched.
        db_name = settings.DATABASES['default'].get('NAME')
        self.stdout.write(
            f'sweep_stranded_donations starting | '
            f'settings={settings.SETTINGS_MODULE} | DB={db_name}'
        )

        # Synchronous, in-process. Unhandled exceptions propagate → non-zero exit (so cron
        # surfaces failures); a clean run returns the counts dict → exit 0.
        counts = run_stranded_donation_sweep(
            staleness_minutes=options.get('staleness_minutes'),
        )

        self.stdout.write(self.style.SUCCESS(
            'Donation sweep done: examined={examined} failed={failed} '
            'flagged={flagged} pending={pending} inconclusive={inconclusive}.'.format(**counts)
        ))
