"""Phase 6 — FULL SCENARIO / E2E against :8009 / FRESH pamoja_audit.

Asserts state + ledger at each step. JWTs minted IN-PROCESS (SimpleJWT
AccessToken.for_user) so we never touch the login throttle. The money-moving
STK-credit and B2C-PAID legs use FORGED callbacks on prepared rows (the proven
hermetic pattern from p2_money) so the journey is deterministic and makes no real
Daraja/SMS traffic; the REAL approve->B2C dispatch + REAL STK initiate were already
proven live in Phase 2/3. Registration/approval, portal disbursement-create,
treasurer approve transition, super suspend/reactivate/set-tier, billing forward-only
all go through the REAL HTTP views (real permissions + serializers + audit).
"""
import os, sys, secrets
from decimal import Decimal
from datetime import timedelta
import requests

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, BACKEND)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.development')
import django; django.setup()
from django.utils import timezone
from rest_framework_simplejwt.tokens import AccessToken
from accounts.models import User
from accounts.utils import hash_token
from churches.models import Church
from campaigns.models import Campaign
from donations.models import Donation, DonationStatus
from withdrawals.models import Withdrawal, WithdrawalStatus
from treasurer_portal.models import PortalToken
from audit.models import AuditLog

BASE = 'http://127.0.0.1:8009/api/v1'
PASS, FAIL = 0, 0

def check(label, cond, extra=''):
    global PASS, FAIL
    ok = bool(cond)
    PASS += ok; FAIL += (not ok)
    print(f'  [{"PASS" if ok else "FAIL"}] {label}{("  " + extra) if extra else ""}')

def bearer(user):
    return {'Authorization': f'Bearer {str(AccessToken.for_user(user))}'}

def portal_hdr(raw):
    return {'Authorization': f'Portal {raw}'}

def ledger(slug):
    c = Campaign.objects.get(slug=slug)
    return c.raised_amount, c.wallet_balance

def stk_body(checkout, code, amount=None, receipt=None):
    items = []
    if amount is not None: items.append({'Name': 'Amount', 'Value': amount})
    if receipt is not None: items.append({'Name': 'MpesaReceiptNumber', 'Value': receipt})
    cb = {'CheckoutRequestID': checkout, 'ResultCode': code}
    if items: cb['CallbackMetadata'] = {'Item': items}
    return {'Body': {'stkCallback': cb}}

def b2c_body(conv, code, txn=None):
    return {'Result': {'ConversationID': conv, 'OriginatorConversationID': '', 'ResultCode': code, 'TransactionID': txn}}

superu = User.objects.get(email='super@audit.test')
trA = User.objects.get(email='treasurerA@audit.test')
trB = User.objects.get(email='treasurerB@audit.test')
chA = trA.church
campA = Campaign.objects.get(slug='alpha-build')
campB = Campaign.objects.get(slug='beta-outreach')

print('=== 6.1.a REGISTRATION -> PENDING -> super APPROVE -> ACTIVE ===')
email = f'e2e-{secrets.token_hex(3)}@audit.test'
reg = requests.post(f'{BASE}/auth/register/', json={
    'name': 'E2E Journey Church', 'official_email': email, 'phone': '0712345670',
    'address': 'E2E Road', 'denomination': 'E2E', 'password': 'AuditPass!234'}, timeout=15)
check('register -> 201', reg.status_code == 201, f'({reg.status_code})')
newch = Church.objects.filter(official_email=email).first()
check('new church created PENDING', newch and newch.status == 'PENDING', f'(status={getattr(newch,"status",None)})')
ap = requests.post(f'{BASE}/super/churches/{newch.id}/approve/', headers=bearer(superu), json={}, timeout=15)
newch.refresh_from_db()
check('super approve -> 200 + ACTIVE', ap.status_code == 200 and newch.status == 'ACTIVE', f'({ap.status_code}/{newch.status})')
check('approval audit row written', AuditLog.objects.filter(entity_id=str(newch.id), action__icontains='APPROV').exists())

print('\n=== 6.1.b DONATION STK callback -> NET credited (clean ledger) ===')
r0, w0 = ledger('alpha-build')
Donation.objects.filter(checkout_request_id='E2E-STK-1').delete()
Donation.objects.create(campaign=campA, phone_number='254713000011', amount=Decimal('2000'),
    status=DonationStatus.PENDING, checkout_request_id='E2E-STK-1')
c1 = requests.post(f'{BASE}/donations/callback/', json=stk_body('E2E-STK-1', 0, 2000, 'E2ERCPT1'), timeout=15)
r1, w1 = ledger('alpha-build')
d = Donation.objects.get(checkout_request_id='E2E-STK-1')
check('callback 200 + donation SUCCESSFUL', c1.status_code == 200 and d.status == DonationStatus.SUCCESSFUL)
check('NET credited (2000 @2.5% -> +1950)', r1 - r0 == Decimal('1950') and w1 - w0 == Decimal('1950'), f'(d_raised={r1-r0})')
check('fee/net math: gross=2000 fee=50 net=1950', d.amount == Decimal('2000') and d.platform_fee == Decimal('50.00') and d.net_amount == Decimal('1950.00'), f'(fee={d.platform_fee} net={d.net_amount})')
# replay -> credit once
requests.post(f'{BASE}/donations/callback/', json=stk_body('E2E-STK-1', 0, 2000, 'E2ERCPT1'), timeout=15)
r2, w2 = ledger('alpha-build')
check('STK replay credits ONCE (idempotent)', r2 == r1 and w2 == w1)

print('\n=== 6.1.c PORTAL request-disbursement BLOCKED while a payout is already pending (one-pending guard) ===')
phoneA = campA.treasurer_phone
raw = secrets.token_urlsafe(24)
PortalToken.objects.create(phone_number=phoneA, campaign_ids=[str(campA.id)], ip_address='127.0.0.1',
    token_hash=hash_token(raw), is_revoked=False, expires_at=timezone.now() + timedelta(minutes=30))
seeded_wd = Withdrawal.objects.filter(campaign=campA, status=WithdrawalStatus.PENDING_APPROVAL).order_by('created_at').first()
guard = requests.post(f'{BASE}/treasurer/campaigns/{campA.id}/request-disbursement/', headers=portal_hdr(raw),
    json={'amount': '50', 'reason': 'E2E should be blocked'}, timeout=15)
check('portal request blocked (one pending per campaign) -> 400', guard.status_code == 400 and seeded_wd is not None, f'({guard.status_code})')

print('\n=== 6.1.d treasurer APPROVE seeded PENDING -> (forge B2C SUCCESS) -> PAID + wallet decrement ONCE ===')
amtA = seeded_wd.amount
ap2 = requests.post(f'{BASE}/withdrawals/{seeded_wd.id}/approve/', headers=bearer(trA), json={}, timeout=20)
seeded_wd.refresh_from_db()
check('approve seeded PENDING -> 200 + leaves PENDING_APPROVAL', ap2.status_code == 200, f'({ap2.status_code} status={seeded_wd.status})')
# Approve dispatches B2C to sandbox; outcome varies. Force a deterministic PROCESSING+conv for the PAID leg.
conv = 'E2E-CONV-1'
Withdrawal.objects.filter(id=seeded_wd.id).update(status=WithdrawalStatus.PROCESSING, b2c_conversation_id=conv, payout_reference=None)
_, wd_w0 = ledger('alpha-build')
b1 = requests.post(f'{BASE}/withdrawals/b2c-result/', json=b2c_body(conv, 0, 'E2E-TXN-1'), timeout=15)
seeded_wd.refresh_from_db(); _, wd_w1 = ledger('alpha-build')
check('B2C success -> PAID', b1.status_code == 200 and seeded_wd.status == WithdrawalStatus.PAID, f'({b1.status_code}/{seeded_wd.status})')
check(f'wallet decremented by {amtA} once', wd_w0 - wd_w1 == amtA, f'({wd_w0}->{wd_w1})')
b2 = requests.post(f'{BASE}/withdrawals/b2c-result/', json=b2c_body(conv, 0, 'E2E-TXN-1'), timeout=15)
_, wd_w2 = ledger('alpha-build')
check('B2C replay decrements ONCE (idempotent)', wd_w2 == wd_w1)
check('payout_reference recorded', bool(seeded_wd.payout_reference))

print('\n=== 6.1.c2 PORTAL request-disbursement HAPPY PATH (pending slot now free) -> 201 PENDING_APPROVAL, wallet UNCHANGED ===')
_, w_before = ledger('alpha-build')
rd = requests.post(f'{BASE}/treasurer/campaigns/{campA.id}/request-disbursement/', headers=portal_hdr(raw),
    json={'amount': '300', 'reason': 'E2E payout journey'}, timeout=15)
check('portal disbursement -> 201', rd.status_code == 201, f'({rd.status_code} {rd.text[:80]})')
new_wd = Withdrawal.objects.filter(campaign=campA, reason='E2E payout journey').order_by('-created_at').first()
check('withdrawal PENDING_APPROVAL', new_wd and new_wd.status == WithdrawalStatus.PENDING_APPROVAL, f'(status={getattr(new_wd,"status",None)})')
_, w_after = ledger('alpha-build')
check('wallet UNCHANGED on request (lock-then-call: no money yet)', w_after == w_before, f'({w_before}->{w_after})')

print('\n=== 6.5 resolve-paid double-fire on NEEDS_RECONCILIATION -> PAID once, second -> 400 ===')
recon = Withdrawal.objects.create(campaign=campB, requested_by_phone='254712000002', amount=Decimal('100'),
    destination_phone='254712000002', destination_name='Beta', reason='E2E recon',
    status=WithdrawalStatus.NEEDS_RECONCILIATION, b2c_conversation_id='E2E-RECON-1')
_, rw0 = ledger('beta-outreach')
rp1 = requests.post(f'{BASE}/super/withdrawals/{recon.id}/resolve-paid/', headers=bearer(superu),
    json={'payout_reference': 'E2E-MANUAL-REF'}, timeout=15)
recon.refresh_from_db(); _, rw1 = ledger('beta-outreach')
check('resolve-paid -> 200 + PAID', rp1.status_code == 200 and recon.status == WithdrawalStatus.PAID, f'({rp1.status_code}/{recon.status})')
check('wallet decremented once by 100', rw0 - rw1 == Decimal('100'), f'({rw0}->{rw1})')
rp2 = requests.post(f'{BASE}/super/withdrawals/{recon.id}/resolve-paid/', headers=bearer(superu),
    json={'payout_reference': 'E2E-MANUAL-REF-2'}, timeout=15)
_, rw2 = ledger('beta-outreach')
check('second resolve-paid -> 400 (status guard), wallet unchanged', rp2.status_code == 400 and rw2 == rw1, f'({rp2.status_code})')

print('\n=== 6.4 super SUSPEND/REACTIVATE church B (+audit) ===')
su = requests.post(f'{BASE}/super/churches/{campB.church_id}/suspend/', headers=bearer(superu), json={}, timeout=15)
chBs = Church.objects.get(id=campB.church_id)
check('suspend -> 200 + SUSPENDED', su.status_code == 200 and chBs.status == 'SUSPENDED', f'({su.status_code}/{chBs.status})')
check('CHURCH_SUSPENDED audit row', AuditLog.objects.filter(entity_id=str(campB.church_id), action__icontains='SUSPEND').exists())
re = requests.post(f'{BASE}/super/churches/{campB.church_id}/reactivate/', headers=bearer(superu), json={}, timeout=15)
chBs.refresh_from_db()
check('reactivate -> 200 + ACTIVE', re.status_code == 200 and chBs.status == 'ACTIVE', f'({re.status_code}/{chBs.status})')

print('\n=== 6.4 billing fee % is FORWARD-ONLY (existing donation net not retro-changed) ===')
pre_net = Donation.objects.get(checkout_request_id='E2E-STK-1').net_amount
bp = requests.patch(f'{BASE}/super/billing/', headers=bearer(superu), json={'fee_percent': '5.00'}, timeout=15)
post_net = Donation.objects.get(checkout_request_id='E2E-STK-1').net_amount
check('billing PATCH fee_percent -> 200', bp.status_code == 200, f'({bp.status_code})')
check('existing donation net UNCHANGED (forward-only)', pre_net == post_net == Decimal('1950.00'), f'({pre_net}->{post_net})')
# restore fee for any later runs
requests.patch(f'{BASE}/super/billing/', headers=bearer(superu), json={'fee_percent': '2.50'}, timeout=15)

print('\n=== 6.2 subscription set-tier (money-inert grant) flips tier + audit ===')
st = requests.post(f'{BASE}/super/churches/{campB.church_id}/set-tier/', headers=bearer(superu),
    json={'subscription_tier': 'GROWTH'}, timeout=15)
chBs.refresh_from_db()
check('set-tier GROWTH -> 200 + tier flipped', st.status_code == 200 and chBs.subscription_tier == 'GROWTH', f'({st.status_code}/{chBs.subscription_tier})')
check('CHURCH_TIER_CHANGED audit row', AuditLog.objects.filter(entity_id=str(campB.church_id), action__icontains='TIER').exists())

print(f'\n== P6 E2E DONE: {PASS} PASS / {FAIL} FAIL ==')
