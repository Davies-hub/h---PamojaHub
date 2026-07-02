from django.conf import settings
from django.core.management.base import BaseCommand

from media.sweep import sweep_orphan_media


class Command(BaseCommand):
    help = ('Delete orphaned media objects (bucket objects with no MediaAsset row) older than '
            'the grace window. DRY-RUN by default — pass --commit to actually delete.')

    def add_arguments(self, parser):
        parser.add_argument('--grace-minutes', type=int, default=60,
            help='Only consider objects older than this (default 60). Guards in-flight uploads.')
        parser.add_argument('--commit', action='store_true', default=False,
            help='Actually delete. WITHOUT this flag, the command only reports (dry-run).')

    def handle(self, *args, **options):
        db_name = settings.DATABASES['default'].get('NAME')
        self.stdout.write(f'sweep_orphan_media starting | settings={settings.SETTINGS_MODULE} '
                          f'| DB={db_name} | mode={"COMMIT" if options["commit"] else "DRY-RUN"}')
        r = sweep_orphan_media(grace_minutes=options['grace_minutes'], commit=options['commit'])
        verb = 'Deleted' if r['committed'] else 'Would delete'
        self.stdout.write(self.style.SUCCESS(
            f"{verb} {r['orphans'] if not r['committed'] else r['deleted']} orphan(s), "
            f"{r['reclaimed_bytes']} bytes | scanned={r['scanned']} referenced={r['referenced']} "
            f"in_grace_skipped={r['in_grace_skipped']} delete_failed={r['delete_failed']}"))
        if not r['committed'] and r['orphan_keys']:
            self.stdout.write('Orphan keys (dry-run):')
            for k in r['orphan_keys']:
                self.stdout.write(f'  {k}')
