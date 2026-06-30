"""DEV-ONLY one-shot cleanup of synthetic test withdrawals (2026-06-18 trace).

Deletes EXACTLY the 17 synthetic rows enumerated below and restores the
wallet_balance invariant on the single campaign that loses PAID rows ("Trace
Classroom Desks Fund"). It does NOT touch AuditLog (entity_id is a bare UUID, not
an FK — no cascade — and the dev DB role also blocks DELETE on audit_auditlog),
users/auth, donations, the 12 real-sandbox UF… provenance rows, the 3 live rows,
or any campaign that holds no targeted withdrawal.

Two NON-NEGOTIABLE safety properties make this impossible to run destructively by
reflex or against prod:

  1. HARD GUARD (assert_dev_target) — aborts (CommandError, deletes nothing)
     unless BOTH settings.SETTINGS_MODULE ends with 'development' AND the
     connected DB name == 'pamoja_dev'. Factored out so it is unit-testable with
     stubbed values WITHOUT ever connecting to a non-dev DB.
  2. --yes-i-am-sure is REQUIRED to commit. Without it the command runs in
     DRY-RUN: it prints the would-delete set + the wallet reset table and changes
     nothing.

The delete set is an EXPLICIT id-prefix list (NOT a status/date filter) so a row
created after the trace can never be swept in. Each prefix is paired with its
expected status from the trace; the command REFUSES (aborts, deletes nothing) if
any found row's live status drifted since the trace.
"""

from decimal import Decimal

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from campaigns.models import Campaign
from notifications.models import Notification
from withdrawals.models import Withdrawal, WithdrawalStatus


EXPECTED_DEV_DB = 'pamoja_dev'

# (id-prefix, expected_status) from the 2026-06-18 trace. Each 8-char prefix
# resolves to exactly one Withdrawal; the command refuses to delete a row whose
# live status != expected_status (drift since the trace). Explicit list — never a
# broad filter — so a later-created row can never be caught.
SYNTHETIC_TARGETS = [
    # Wallet-neutral synthetic (11) — never PAID, so deleting them moves no wallet.
    ('ef26d85f', WithdrawalStatus.FAILED),
    ('dc338cb8', WithdrawalStatus.FAILED),
    ('afb31486', WithdrawalStatus.FAILED),
    ('8e419c54', WithdrawalStatus.REJECTED),
    ('6342206e', WithdrawalStatus.REJECTED),
    ('8996f266', WithdrawalStatus.REJECTED),
    ('55f31859', WithdrawalStatus.PROCESSING),
    ('02f07956', WithdrawalStatus.PENDING_APPROVAL),
    ('fe7f202c', WithdrawalStatus.PROCESSING),
    ('6cf8df10', WithdrawalStatus.PROCESSING),
    ('ce713d76', WithdrawalStatus.PROCESSING),
    # Synthetic PAID (6) — all on "Trace Classroom Desks Fund" (Σ=2500). Deleting
    # these is the ONLY reason a wallet reset happens.
    ('794b0436', WithdrawalStatus.PAID),
    ('48bd41fe', WithdrawalStatus.PAID),
    ('be4eba32', WithdrawalStatus.PAID),
    ('313ba49a', WithdrawalStatus.PAID),
    ('8ec99332', WithdrawalStatus.PAID),
    ('d552e5db', WithdrawalStatus.PAID),
]

# Rows that MUST survive — asserted disjoint from the resolved delete set. Two are
# live (NEEDS_RECONCILIATION / FAILED); 44bfd44c additionally owns Super-Admin
# notifications that must NOT cascade away.
PROTECTED_PREFIXES = {'44bfd44c', '552feae2', '013020fc'}


def assert_dev_target(settings_module, db_name):
    """HARD guard. Raises CommandError (caller aborts, deletes nothing) unless
    BOTH the settings module ends with 'development' AND db_name is the dev DB.

    Pure function of its two arguments so it can be unit-tested with stubbed
    values — proving the refusal WITHOUT connecting to or creating a prod DB.
    """
    if not (settings_module and str(settings_module).endswith('development')):
        raise CommandError(
            f'REFUSING: settings module {settings_module!r} is not a *development* '
            f'settings module. This command runs against dev only.'
        )
    if db_name != EXPECTED_DEV_DB:
        raise CommandError(
            f'REFUSING: connected database {db_name!r} is not {EXPECTED_DEV_DB!r}. '
            f'This command runs against the dev database only.'
        )


class Command(BaseCommand):
    help = (
        'DEV-ONLY: delete the 17 synthetic test withdrawals from the 2026-06-18 '
        'trace and restore the wallet invariant on the affected campaign. '
        'DRY-RUN unless --yes-i-am-sure is passed. Refuses outside dev/pamoja_dev.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--yes-i-am-sure', action='store_true', dest='confirmed',
            help='Actually delete. Without it the command DRY-RUNs (changes nothing).',
        )

    def handle(self, *args, **options):
        db_name = settings.DATABASES['default'].get('NAME')
        settings_module = settings.SETTINGS_MODULE
        confirmed = options['confirmed']

        # Visible-env banner (mirrors sweep_stranded_withdrawals) — a misconfigured
        # run is then obvious in the output before anything else happens.
        self.stdout.write(
            f'cleanup_synthetic_withdrawals starting | '
            f'settings={settings_module} | DB={db_name} | '
            f'mode={"COMMIT" if confirmed else "DRY-RUN"}'
        )

        # ── HARD GUARD — before a single row is read for deletion ───────────────
        assert_dev_target(settings_module, db_name)

        # ── Resolve prefixes → rows (DB-agnostic; no __startswith on a UUID PK) ──
        all_w = list(Withdrawal.objects.all())
        by_prefix = {}
        for w in all_w:
            by_prefix.setdefault(str(w.id)[:8], []).append(w)

        to_delete = []   # [(prefix, withdrawal)]
        missing = []     # [prefix]  (already gone — graceful, not an error)
        drift = []       # [(prefix, expected, actual)]
        for prefix, expected in SYNTHETIC_TARGETS:
            rows = by_prefix.get(prefix, [])
            if not rows:
                missing.append(prefix)
                continue
            if len(rows) > 1:
                raise CommandError(
                    f'REFUSING: prefix {prefix} matches {len(rows)} rows (ambiguous) — '
                    f'deleted nothing.'
                )
            w = rows[0]
            if w.status != expected:
                drift.append((prefix, expected, w.status))
                continue
            to_delete.append((prefix, w))

        # Status drift on a FOUND row = stale trace → abort, delete NOTHING.
        if drift:
            for prefix, expected, actual in drift:
                self.stderr.write(
                    f'  STATUS DRIFT {prefix}: expected {expected}, found {actual}'
                )
            raise CommandError(
                'REFUSING: one or more target rows changed status since the trace. '
                'Re-trace before running; deleted nothing.'
            )

        # ── Safety assertions: never touch a protected/live row ─────────────────
        delete_ids = [w.id for _, w in to_delete]
        delete_id_set = set(delete_ids)
        delete_prefixes = {p for p, _ in to_delete}
        overlap = delete_prefixes & PROTECTED_PREFIXES
        if overlap:
            raise CommandError(
                f'REFUSING: delete set overlaps protected rows {sorted(overlap)} — '
                f'deleted nothing.'
            )
        # 44bfd44c owns notifications that must survive — assert it is excluded.
        assert '44bfd44c' not in delete_prefixes, '44bfd44c must never be in the delete set'

        # Missing ids → SKIP (re-run / partial). Reported, never fatal.
        for prefix in missing:
            self.stdout.write(f'  SKIP {prefix}: not found (already deleted?)')

        # ── Print the delete set ────────────────────────────────────────────────
        self.stdout.write('')
        self.stdout.write(f'DELETE SET - {len(to_delete)} row(s):')
        for prefix, w in to_delete:
            self.stdout.write(
                f'  {prefix} | {w.status:20s} | KES {w.amount:>9} | {w.campaign.title}'
            )

        notif_count = (
            Notification.objects.filter(related_withdrawal_id__in=delete_ids).count()
            if delete_ids else 0
        )
        self.stdout.write(f'Notifications that will cascade-delete: {notif_count}')

        # ── Wallet plan: campaigns losing >=1 PAID row need a reset ─────────────
        paid = WithdrawalStatus.PAID
        affected_paid_campaign_ids = {
            w.campaign_id for _, w in to_delete if w.status == paid
        }
        self.stdout.write('')
        self.stdout.write('WALLET RESET PLAN (only campaigns losing a PAID row):')
        if not affected_paid_campaign_ids:
            self.stdout.write('  (none - no PAID rows in the delete set; balances unchanged)')
        for cid in affected_paid_campaign_ids:
            c = Campaign.objects.get(id=cid)
            sum_rem = sum(
                (w.amount for w in all_w
                 if w.campaign_id == cid and w.status == paid and w.id not in delete_id_set),
                Decimal('0'),
            )
            after = c.raised_amount - sum_rem
            self.stdout.write(
                f'  {c.title}: raised={c.raised_amount} | wallet {c.wallet_balance} -> {after} '
                f'(= raised - sum(remaining PAID) {sum_rem})'
            )

        # ── DRY-RUN: stop here, commit nothing ──────────────────────────────────
        if not confirmed:
            self.stdout.write('')
            self.stdout.write(self.style.WARNING(
                'DRY-RUN: nothing changed. Re-run with --yes-i-am-sure to commit.'
            ))
            return

        if not to_delete:
            self.stdout.write(self.style.SUCCESS(
                'Nothing to delete (all target ids already absent) - no-op.'
            ))
            return

        # ── COMMIT: delete + every wallet reset in ONE atomic transaction ───────
        with transaction.atomic():
            deleted_total, deleted_by_model = (
                Withdrawal.objects.filter(id__in=delete_ids).delete()
            )
            resets = []
            for cid in affected_paid_campaign_ids:
                c = Campaign.objects.select_for_update().get(id=cid)
                sum_rem = sum(
                    (w.amount for w in
                     Withdrawal.objects.filter(campaign=c, status=paid)),
                    Decimal('0'),
                )
                before = c.wallet_balance
                c.wallet_balance = c.raised_amount - sum_rem
                c.save(update_fields=['wallet_balance'])
                resets.append((c, before, c.wallet_balance, sum_rem))

        # ── Post-commit report ──────────────────────────────────────────────────
        self.stdout.write('')
        self.stdout.write(self.style.SUCCESS(
            f'Deleted {deleted_total} object(s): {deleted_by_model}'
        ))
        self.stdout.write('Wallet reset (after commit):')
        for c, before, after, sum_rem in resets:
            inv_ok = (c.wallet_balance == c.raised_amount - sum_rem)
            self.stdout.write(
                f'  {c.title}: wallet {before} -> {after} | '
                f'invariant raised - sum(PAID) == wallet : {inv_ok}'
            )
        self.stdout.write(self.style.SUCCESS('Done.'))
