"""Phase 3.6 — management commands / crons (pamoja_audit, in-process).

Runs the REAL management commands (call_command) for:
  * sweep_stranded_withdrawals  (escalate stale PROCESSING / AMBIGUOUS-FAILED -> NEEDS_RECONCILIATION)
  * process_subscriptions       (7d/1d/grace reminders + grace-lapse to FREE)
Asserts the right rows/notifications/audit are emitted AND that a second run is
idempotent (no new escalations / re-sent reminders / re-lapses).

Run: DATABASE_URL=...pamoja_audit PYTHONIOENCODING=utf-8 python p3_36.py
Mutates pamoja_audit ONLY (creates+deletes throwaway sub36-* churches/users).
"""
import io, os, sys
from datetime import timedelta
from decimal import Decimal

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, BACKEND)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.development')
import django; django.setup()

from django.conf import settings
from django.core.management import call_command
from django.db import connection
from django.utils import timezone

if connection.settings_dict['NAME'] != 'pamoja_audit':
    raise SystemExit(f"REFUSING: DB is {connection.settings_dict['NAME']}, not pamoja_audit")

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import Campaign
from churches.models import (Church, ChurchStatus, SubscriptionTier,
                             REMINDER_STAGE_NONE, REMINDER_STAGE_7D,
                             REMINDER_STAGE_1D, REMINDER_STAGE_GRACE)
from notifications.models import Notification, NotificationType
from withdrawals.models import Withdrawal, WithdrawalStatus, WithdrawalDispatchOutcome

results = []
def check(label, cond, extra=''):
    results.append(cond)
    print(f'  [{"PASS" if cond else "FAIL"}] {label}{("  " + extra) if extra else ""}')

def run_cmd(name, *a):
    buf = io.StringIO()
    call_command(name, *a, stdout=buf)
    out = buf.getvalue().strip()
    print(f'  $ {name} {" ".join(a)}\n    {out.splitlines()[-1] if out else ""}')
    return out

ALPHA = Campaign.objects.get(slug='alpha-build')
GRACE = settings.SUBSCRIPTION_GRACE_DAYS  # 7

# ============================================================================
print('=== 3.6.1 sweep_stranded_withdrawals ===')
Withdrawal.objects.filter(reason__startswith='SWEEP36').delete()
def mk_wd(reason, st, dispatch=None, stale_min=60):
    w = Withdrawal.objects.create(
        campaign=ALPHA, requested_by_phone='254712000001', amount=Decimal('10'),
        destination_phone='254712000001', destination_name='Sweep36',
        reason=reason, status=st, dispatch_outcome=dispatch)
    # Force updated_at into the past (auto_now bypass via QuerySet.update).
    Withdrawal.objects.filter(id=w.id).update(
        updated_at=timezone.now() - timedelta(minutes=stale_min))
    return w
w_proc  = mk_wd('SWEEP36-proc',  WithdrawalStatus.PROCESSING)                                  # candidate
w_ambig = mk_wd('SWEEP36-ambig', WithdrawalStatus.FAILED, WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE)  # candidate
w_fresh = mk_wd('SWEEP36-fresh', WithdrawalStatus.PROCESSING, stale_min=0)                     # NOT (fresh)
w_clean = mk_wd('SWEEP36-clean', WithdrawalStatus.FAILED, WithdrawalDispatchOutcome.CLEAN_FAILURE)  # NOT (clean fail)

n_super = User.objects.filter(role=UserRole.SUPER_ADMIN).count()
def recon_audits():
    return AuditLog.objects.filter(action='WITHDRAWAL_NEEDS_RECONCILIATION').count()
def recon_notifs():
    return Notification.objects.filter(notification_type=NotificationType.DISBURSEMENT_FAILED,
                                       title='Payout needs reconciliation').count()
a0, nfy0 = recon_audits(), recon_notifs()

out1 = run_cmd('sweep_stranded_withdrawals')
for w in (w_proc, w_ambig, w_fresh, w_clean):
    w.refresh_from_db()
check('escalated=2 in output', 'Escalated 2 ' in out1, f'out="{out1.splitlines()[-1]}"')
check('stale PROCESSING -> NEEDS_RECONCILIATION', w_proc.status == 'NEEDS_RECONCILIATION', w_proc.status)
check('stale AMBIGUOUS-FAILED -> NEEDS_RECONCILIATION', w_ambig.status == 'NEEDS_RECONCILIATION', w_ambig.status)
check('fresh PROCESSING untouched', w_fresh.status == 'PROCESSING', w_fresh.status)
check('CLEAN-FAILED untouched', w_clean.status == 'FAILED', w_clean.status)
check('2 new recon audit rows', recon_audits() - a0 == 2, f'delta={recon_audits()-a0}')
check(f'{2*n_super} new super recon notifications', recon_notifs() - nfy0 == 2 * n_super,
      f'delta={recon_notifs()-nfy0}')

a1, nfy1 = recon_audits(), recon_notifs()
out2 = run_cmd('sweep_stranded_withdrawals')  # re-run
for w in (w_proc, w_ambig):
    w.refresh_from_db()
check('RE-RUN escalated=0 (idempotent)', 'Escalated 0 ' in out2, f'out="{out2.splitlines()[-1]}"')
check('RE-RUN no new audit rows', recon_audits() == a1, f'delta={recon_audits()-a1}')
check('RE-RUN no new notifications', recon_notifs() == nfy1, f'delta={recon_notifs()-nfy1}')
check('RE-RUN statuses still NEEDS_RECONCILIATION',
      w_proc.status == 'NEEDS_RECONCILIATION' and w_ambig.status == 'NEEDS_RECONCILIATION')

Withdrawal.objects.filter(reason__startswith='SWEEP36').delete()
print('  (cleaned SWEEP36 withdrawals)')

# ============================================================================
print('\n=== 3.6.2 process_subscriptions (reminders + lapse) ===')
# Tear down any prior throwaway fixtures.
User.objects.filter(email__startswith='sub36-').delete()
Church.objects.filter(official_email__startswith='sub36-').delete()

now = timezone.now()
def mk_church(key, expires_delta_days, tier=SubscriptionTier.GROWTH):
    c = Church.objects.create(
        name=f'Sub36 {key}', official_email=f'sub36-{key}@audit.test',
        phone='254700000000', address='x', county='Nairobi', denomination='T',
        status=ChurchStatus.ACTIVE, subscription_tier=tier,
        subscription_expires_at=(now + timedelta(days=expires_delta_days)
                                 if expires_delta_days is not None else None),
        subscription_reminder_stage=REMINDER_STAGE_NONE,
    )
    User.objects.create(email=f'sub36-{key}-t@audit.test', first_name=key, last_name='T',
                        role=UserRole.CHURCH_TREASURER, church=c)
    return c

ch_7d    = mk_church('7d',    5)         # 1d<delta<=7d -> 7D
ch_1d    = mk_church('1d',    0.5)       # 0<delta<=1d  -> 1D
ch_grace = mk_church('grace', -6.5)     # in (-7d,-6d] last full grace day -> GRACE
ch_lapse = mk_church('lapse', -8)       # past grace -> lapse to FREE
ch_early = mk_church('early', 10)       # >7d -> no reminder
ch_free  = mk_church('free',  None, tier=SubscriptionTier.FREE)  # skipped

def remind_notifs(church):
    return Notification.objects.filter(
        recipient__church=church,
        notification_type=NotificationType.SUBSCRIPTION_REMINDER).count()
def lapse_notifs(church):
    return Notification.objects.filter(
        recipient__church=church,
        notification_type=NotificationType.SUBSCRIPTION_LAPSED).count()

out1 = run_cmd('process_subscriptions')
for c in (ch_7d, ch_1d, ch_grace, ch_lapse, ch_early, ch_free):
    c.refresh_from_db()
check('7d church -> reminder_stage=7D', ch_7d.subscription_reminder_stage == REMINDER_STAGE_7D, str(ch_7d.subscription_reminder_stage))
check('1d church -> reminder_stage=1D', ch_1d.subscription_reminder_stage == REMINDER_STAGE_1D, str(ch_1d.subscription_reminder_stage))
check('grace church -> reminder_stage=GRACE', ch_grace.subscription_reminder_stage == REMINDER_STAGE_GRACE, str(ch_grace.subscription_reminder_stage))
check('early church -> reminder_stage=NONE', ch_early.subscription_reminder_stage == REMINDER_STAGE_NONE, str(ch_early.subscription_reminder_stage))
check('7d/1d/grace each got exactly 1 reminder notif',
      remind_notifs(ch_7d) == 1 and remind_notifs(ch_1d) == 1 and remind_notifs(ch_grace) == 1,
      f'{remind_notifs(ch_7d)}/{remind_notifs(ch_1d)}/{remind_notifs(ch_grace)}')
check('early/free got 0 reminder notifs', remind_notifs(ch_early) == 0 and remind_notifs(ch_free) == 0)
check('lapse church -> tier=FREE, expiry NULL', ch_lapse.subscription_tier == 'FREE' and ch_lapse.subscription_expires_at is None,
      f'tier={ch_lapse.subscription_tier} exp={ch_lapse.subscription_expires_at}')
check('lapse church got 1 SUBSCRIPTION_LAPSED notif', lapse_notifs(ch_lapse) == 1, str(lapse_notifs(ch_lapse)))
check('lapse audit CHURCH_TIER_LAPSED_TO_FREE present',
      AuditLog.objects.filter(action='CHURCH_TIER_LAPSED_TO_FREE', entity_id=ch_lapse.id).count() == 1)
check('free/early did NOT lapse', ch_free.subscription_tier == 'FREE' and ch_early.subscription_tier == 'GROWTH')
check('summary: reminders=3 lapsed=1', 'Reminders sent to 3 church(es); lapsed 1 church(es)' in out1,
      f'out="{out1.splitlines()[-1]}"')

# snapshot reminder/lapse notif counts before re-run
snap = {c.id: (remind_notifs(c), lapse_notifs(c)) for c in (ch_7d, ch_1d, ch_grace, ch_lapse, ch_early)}
out2 = run_cmd('process_subscriptions')  # re-run
for c in (ch_7d, ch_1d, ch_grace, ch_lapse, ch_early):
    c.refresh_from_db()
re_ok = all(
    (remind_notifs(c), lapse_notifs(c)) == snap[c.id]
    for c in (ch_7d, ch_1d, ch_grace, ch_lapse, ch_early)
)
check('RE-RUN no new reminder/lapse notifications (idempotent)', re_ok)
check('RE-RUN summary reminders=0 lapsed=0', 'Reminders sent to 0 church(es); lapsed 0 church(es)' in out2,
      f'out="{out2.splitlines()[-1]}"')

# cleanup throwaway fixtures + their lapse audit rows
ids = [c.id for c in (ch_7d, ch_1d, ch_grace, ch_lapse, ch_early, ch_free)]
User.objects.filter(email__startswith='sub36-').delete()
Church.objects.filter(official_email__startswith='sub36-').delete()
AuditLog.objects.filter(action='CHURCH_TIER_LAPSED_TO_FREE', entity_id__in=ids).delete()
print('  (cleaned sub36-* churches/users/audit)')

# ============================================================================
print('\n=== SUMMARY ===')
print(f'  {sum(results)}/{len(results)} checks PASS')
print('== P3.6 DONE ==' if all(results) else '== P3.6 FAIL — see above ==')
