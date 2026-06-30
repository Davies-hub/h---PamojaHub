"""Phase 3.5 — state-machine ILLEGAL-transition sweep (:8009 / pamoja_audit).

Sets up rows in every state via ORM (disposable DB) then fires every ILLEGAL
action endpoint at them and asserts the guard REJECTS (400/409) AND the row's
status is UNCHANGED. The single LEGAL transition for each state is NOT fired
(that would move money / dispatch B2C — already proven in Phase 2/6).

Run: DATABASE_URL=...pamoja_audit PYTHONIOENCODING=utf-8 python p3_state.py
Mutates pamoja_audit ONLY. ASCII stdout only (cp1252 console).
"""
import os, sys
from datetime import timedelta
from decimal import Decimal

import requests

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, BACKEND)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.development')
import django; django.setup()

from django.utils import timezone
from campaigns.models import Campaign, CampaignStatus
from churches.models import Church, ChurchStatus, SubscriptionTier
from churches.models import SubscriptionPayment, SubscriptionPaymentStatus
from withdrawals.models import Withdrawal, WithdrawalStatus, WithdrawalDispatchOutcome
from audit.models import AuditLog

sys.path.insert(0, os.path.dirname(__file__))
from _authlib import get_tokens, H

BASE = 'http://127.0.0.1:8009/api/v1'
TOK = get_tokens()
A = H(TOK['A']['access'])       # treasurer church A
SUP = H(TOK['super']['access'])  # super admin

PASS = 'PASS'; FAIL = 'FAIL'
results = []
def check(label, cond, extra=''):
    tag = PASS if cond else FAIL
    results.append(cond)
    print(f'  [{tag}] {label}{("  " + extra) if extra else ""}')

ALPHA = Campaign.objects.get(slug='alpha-build')      # church A, ACTIVE
CHURCH_A = ALPHA.church

# ============================================================================
print('=== 3.5.1 CAMPAIGN state machine (ACTIVE/PAUSED/CLOSED) ===')
# Build one campaign per state for church A (slug-prefixed sm-*; disposable DB).
Campaign.objects.filter(slug__startswith='sm-camp-').delete()
def mk_campaign(slug, st):
    return Campaign.objects.create(
        slug=slug, church=CHURCH_A, created_by=ALPHA.created_by,
        title=f'SM {slug}', description='state machine test',
        goal_amount=Decimal('100000'), category=ALPHA.category,
        treasurer_phone='254712000001', treasurer_name='SM Treas',
        status=st, raised_amount=Decimal('0'), wallet_balance=Decimal('0'),
    )
c_active = mk_campaign('sm-camp-active', CampaignStatus.ACTIVE)
c_paused = mk_campaign('sm-camp-paused', CampaignStatus.PAUSED)
c_closed = mk_campaign('sm-camp-closed', CampaignStatus.CLOSED)

def camp_status(slug):
    return Campaign.objects.get(slug=slug).status

def fire_camp(action, slug, method='POST', body=None):
    url = f'{BASE}/campaigns/mine/{slug}/' + (f'{action}/' if action else '')
    if method == 'POST':
        return requests.post(url, headers=A, json=body or {}, timeout=15)
    return requests.patch(url, headers=A, json=body or {}, timeout=15)

# pause: legal only from ACTIVE. Illegal from PAUSED, CLOSED.
r = fire_camp('pause', 'sm-camp-paused')
check('pause PAUSED -> 400, unchanged', r.status_code == 400 and camp_status('sm-camp-paused') == 'PAUSED', f'code={r.status_code}')
r = fire_camp('pause', 'sm-camp-closed')
check('pause CLOSED -> 400, unchanged', r.status_code == 400 and camp_status('sm-camp-closed') == 'CLOSED', f'code={r.status_code}')
# resume: legal only from PAUSED. Illegal from ACTIVE, CLOSED.
r = fire_camp('resume', 'sm-camp-active')
check('resume ACTIVE -> 400, unchanged', r.status_code == 400 and camp_status('sm-camp-active') == 'ACTIVE', f'code={r.status_code}')
r = fire_camp('resume', 'sm-camp-closed')
check('resume CLOSED -> 400, unchanged', r.status_code == 400 and camp_status('sm-camp-closed') == 'CLOSED', f'code={r.status_code}')
# close: legal from ACTIVE/PAUSED. Illegal from CLOSED.
r = fire_camp('close', 'sm-camp-closed')
check('close CLOSED -> 400, unchanged', r.status_code == 400 and camp_status('sm-camp-closed') == 'CLOSED', f'code={r.status_code}')
# PATCH on CLOSED -> 400 (terminal, no edits).
r = fire_camp(None, 'sm-camp-closed', method='PATCH', body={'title': 'hijack'})
check('PATCH CLOSED -> 400 (terminal)', r.status_code == 400 and Campaign.objects.get(slug='sm-camp-closed').title == 'SM sm-camp-closed', f'code={r.status_code}')

# ============================================================================
print('\n=== 3.5.2 WITHDRAWAL state machine ===')
Withdrawal.objects.filter(reason__startswith='SM-STATE').delete()
def mk_wd(st, amount='10', dispatch=None, retry=0):
    return Withdrawal.objects.create(
        campaign=ALPHA, requested_by_phone='254712000001',
        amount=Decimal(amount), destination_phone='254712000001',
        destination_name='SM Treas', reason='SM-STATE', status=st,
        dispatch_outcome=dispatch, retry_count=retry,
    )
W = {
    'PENDING_APPROVAL': mk_wd(WithdrawalStatus.PENDING_APPROVAL),
    'PROCESSING':       mk_wd(WithdrawalStatus.PROCESSING),
    'PAID':             mk_wd(WithdrawalStatus.PAID),
    'FAILED':           mk_wd(WithdrawalStatus.FAILED),          # CLEAN, retry 0 -> retry IS legal (skip)
    'FAILED_FINAL':     mk_wd(WithdrawalStatus.FAILED_FINAL),
    'REJECTED':         mk_wd(WithdrawalStatus.REJECTED),
    'NEEDS_RECONCILIATION': mk_wd(WithdrawalStatus.NEEDS_RECONCILIATION),
}
W_ambig = mk_wd(WithdrawalStatus.FAILED, dispatch=WithdrawalDispatchOutcome.AMBIGUOUS_FAILURE)
W_maxed = mk_wd(WithdrawalStatus.FAILED, retry=5)

def wd_status(wid):
    return Withdrawal.objects.get(id=wid).status

def fire_wd(action, wid, hdr, body=None, super_=False):
    seg = f'super/withdrawals/{wid}/{action}/' if super_ else f'withdrawals/{wid}/{action}/'
    return requests.post(f'{BASE}/{seg}', headers=hdr, json=body or {}, timeout=15)

# Map: action -> (the ONE legal-from status, is_super, header, body)
print('  -- treasurer approve: legal only from PENDING_APPROVAL --')
for st in ('PROCESSING', 'PAID', 'FAILED', 'FAILED_FINAL', 'REJECTED', 'NEEDS_RECONCILIATION'):
    r = fire_wd('approve', W[st].id, A)
    check(f'approve {st} -> 400, unchanged', r.status_code == 400 and wd_status(W[st].id) == st, f'code={r.status_code}')

print('  -- treasurer reject: legal only from PENDING_APPROVAL --')
for st in ('PROCESSING', 'PAID', 'FAILED', 'FAILED_FINAL', 'REJECTED', 'NEEDS_RECONCILIATION'):
    r = fire_wd('reject', W[st].id, A, body={'rejection_reason': 'audit illegal-transition probe'})
    check(f'reject {st} -> 400, unchanged', r.status_code == 400 and wd_status(W[st].id) == st, f'code={r.status_code}')

print('  -- treasurer retry: legal only from FAILED(clean, retry<5) --')
for st in ('PENDING_APPROVAL', 'PROCESSING', 'PAID', 'FAILED_FINAL', 'REJECTED', 'NEEDS_RECONCILIATION'):
    r = fire_wd('retry', W[st].id, A)
    check(f'retry {st} -> 400, unchanged', r.status_code == 400 and wd_status(W[st].id) == st, f'code={r.status_code}')
r = fire_wd('retry', W_ambig.id, A)
check('retry FAILED+AMBIGUOUS -> 400 (reconcile-first)', r.status_code == 400 and wd_status(W_ambig.id) == 'FAILED', f'code={r.status_code}')
r = fire_wd('retry', W_maxed.id, A)
check('retry FAILED+retry_count=5 -> 400 (maxed)', r.status_code == 400 and wd_status(W_maxed.id) == 'FAILED', f'code={r.status_code}')

print('  -- super force-retry: legal only from FAILED_FINAL --')
for st in ('PENDING_APPROVAL', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED', 'NEEDS_RECONCILIATION'):
    r = fire_wd('force-retry', W[st].id, SUP, super_=True)
    check(f'force-retry {st} -> 400, unchanged', r.status_code == 400 and wd_status(W[st].id) == st, f'code={r.status_code}')

print('  -- super resolve-paid: legal only from NEEDS_RECONCILIATION (valid ref so guard, not validation, fires) --')
for st in ('PENDING_APPROVAL', 'PROCESSING', 'PAID', 'FAILED', 'FAILED_FINAL', 'REJECTED'):
    r = fire_wd('resolve-paid', W[st].id, SUP, body={'payout_reference': 'AUDITREF1'}, super_=True)
    detail = (r.json().get('detail', '') if r.headers.get('content-type','').startswith('application/json') else '')
    is_guard = 'not awaiting reconciliation' in detail
    check(f'resolve-paid {st} -> 400 (status-guard), unchanged', r.status_code == 400 and is_guard and wd_status(W[st].id) == st, f'code={r.status_code} detail="{detail[:40]}"')

print('  -- super resolve-retry: legal only from NEEDS_RECONCILIATION --')
for st in ('PENDING_APPROVAL', 'PROCESSING', 'PAID', 'FAILED', 'FAILED_FINAL', 'REJECTED'):
    r = fire_wd('resolve-retry', W[st].id, SUP, super_=True)
    detail = (r.json().get('detail', '') if r.headers.get('content-type','').startswith('application/json') else '')
    is_guard = 'not awaiting reconciliation' in detail
    check(f'resolve-retry {st} -> 400 (status-guard), unchanged', r.status_code == 400 and is_guard and wd_status(W[st].id) == st, f'code={r.status_code} detail="{detail[:40]}"')

# ============================================================================
print('\n=== 3.5.3 SUBSCRIPTION state machine ===')
# Snapshot church A subscription fields to RESTORE at the end.
CHURCH_A.refresh_from_db()
snap = dict(
    tier=CHURCH_A.subscription_tier,
    expires=CHURCH_A.subscription_expires_at,
    cancel=CHURCH_A.subscription_cancel_requested,
)
print(f'  (church A snapshot: tier={snap["tier"]} expires={snap["expires"]} cancel={snap["cancel"]})')

# (a) initiate FREE tier -> 400 (FREE is never a payment target).
r = requests.post(f'{BASE}/subscriptions/initiate/', headers=A,
                  json={'tier': 'FREE', 'phone_number': '254712000001'}, timeout=15)
check('initiate tier=FREE -> 400', r.status_code == 400, f'code={r.status_code}')

# (b) down-pay block: LIVE Parish (expiry > now+7d) paying Growth -> 400 BEFORE any STK.
Church.objects.filter(id=CHURCH_A.id).update(
    subscription_tier=SubscriptionTier.PARISH,
    subscription_expires_at=timezone.now() + timedelta(days=30),
    subscription_cancel_requested=False,
)
r = requests.post(f'{BASE}/subscriptions/initiate/', headers=A,
                  json={'tier': 'GROWTH', 'phone_number': '254712000001'}, timeout=15)
CHURCH_A.refresh_from_db()
check('down-pay LIVE-Parish->Growth -> 400, tier unchanged (no STK)',
      r.status_code == 400 and CHURCH_A.subscription_tier == 'PARISH', f'code={r.status_code}')

# (c) one-in-flight 409: a recent PENDING payment blocks a second initiate (before STK).
SubscriptionPayment.objects.filter(church=CHURCH_A, phone_number='254700SMTEST').delete()
SubscriptionPayment.objects.create(
    church=CHURCH_A, tier=SubscriptionTier.GROWTH, amount=Decimal('500'),
    phone_number='254700SMTEST', status=SubscriptionPaymentStatus.PENDING,
)
# Set church FREE so the down-pay guard doesn't fire first; in-flight guard should.
Church.objects.filter(id=CHURCH_A.id).update(
    subscription_tier=SubscriptionTier.FREE, subscription_expires_at=None)
r = requests.post(f'{BASE}/subscriptions/initiate/', headers=A,
                  json={'tier': 'GROWTH', 'phone_number': '254712000001'}, timeout=15)
check('second initiate while PENDING in-flight -> 409', r.status_code == 409, f'code={r.status_code}')

# (d) callback idempotency: a terminal SUCCESSFUL payment must not re-grant.
SubscriptionPayment.objects.filter(checkout_request_id='SM-SUB-DONE').delete()
done = SubscriptionPayment.objects.create(
    church=CHURCH_A, tier=SubscriptionTier.GROWTH, amount=Decimal('500'),
    phone_number='254712000001', status=SubscriptionPaymentStatus.SUCCESSFUL,
    checkout_request_id='SM-SUB-DONE',
)
Church.objects.filter(id=CHURCH_A.id).update(
    subscription_tier=SubscriptionTier.FREE, subscription_expires_at=None)
before_audit = AuditLog.objects.filter(action='CHURCH_TIER_CHANGED').count()
cb = {'Body': {'stkCallback': {'CheckoutRequestID': 'SM-SUB-DONE', 'ResultCode': 0,
      'CallbackMetadata': {'Item': [{'Name': 'MpesaReceiptNumber', 'Value': 'SHOULD-IGNORE'}]}}}}
r = requests.post(f'{BASE}/subscriptions/callback/', json=cb, timeout=15)
CHURCH_A.refresh_from_db(); done.refresh_from_db()
after_audit = AuditLog.objects.filter(action='CHURCH_TIER_CHANGED').count()
check('duplicate SUCCESS callback -> 200, no re-grant (tier still FREE, no tier audit)',
      r.status_code == 200 and CHURCH_A.subscription_tier == 'FREE'
      and CHURCH_A.subscription_expires_at is None and after_audit == before_audit,
      f'code={r.status_code} tier={CHURCH_A.subscription_tier}')
check('duplicate callback did not overwrite receipt', done.mpesa_receipt_number != 'SHOULD-IGNORE')

# (e) cancel idempotency: second cancel -> 200, NO second audit row.
Church.objects.filter(id=CHURCH_A.id).update(
    subscription_tier=SubscriptionTier.GROWTH,
    subscription_expires_at=timezone.now() + timedelta(days=20),
    subscription_cancel_requested=False)
AuditLog.objects.filter(action='SUBSCRIPTION_CANCEL_REQUESTED',
                        entity_id=CHURCH_A.id).delete()
r1 = requests.post(f'{BASE}/subscriptions/cancel/', headers=A, json={}, timeout=15)
n1 = AuditLog.objects.filter(action='SUBSCRIPTION_CANCEL_REQUESTED', entity_id=CHURCH_A.id).count()
r2 = requests.post(f'{BASE}/subscriptions/cancel/', headers=A, json={}, timeout=15)
n2 = AuditLog.objects.filter(action='SUBSCRIPTION_CANCEL_REQUESTED', entity_id=CHURCH_A.id).count()
check('first cancel -> 200 + 1 audit', r1.status_code == 200 and n1 == 1, f'code={r1.status_code} audits={n1}')
check('second cancel -> 200 + NO new audit (idempotent)', r2.status_code == 200 and n2 == 1, f'code={r2.status_code} audits={n2}')

# ---- RESTORE church A to its seeded subscription state ----
Church.objects.filter(id=CHURCH_A.id).update(
    subscription_tier=snap['tier'],
    subscription_expires_at=snap['expires'],
    subscription_cancel_requested=snap['cancel'])
SubscriptionPayment.objects.filter(church=CHURCH_A, phone_number='254700SMTEST').delete()
print(f'  (restored church A: tier={snap["tier"]})')

# ============================================================================
print('\n=== SUMMARY ===')
print(f'  {sum(results)}/{len(results)} checks PASS')
print('== P3.5 DONE ==' if all(results) else '== P3.5 FAIL — see above ==')
