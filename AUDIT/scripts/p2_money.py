"""Phase 2.1 — money integrity (:8009 / pamoja_audit). Mutates audit DB only."""
import os, sys
from decimal import Decimal
import requests

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, BACKEND)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.development')
import django; django.setup()
from campaigns.models import Campaign
from donations.models import Donation, DonationStatus
from withdrawals.models import Withdrawal, WithdrawalStatus

BASE = 'http://127.0.0.1:8009/api/v1'

def wallet(slug):
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

print('=== 2.1.A STK callback replay -> credit NET exactly once ===')
Donation.objects.filter(checkout_request_id='AUDIT-REPLAY-1').delete()
d = Donation.objects.create(campaign=Campaign.objects.get(slug='alpha-build'),
    phone_number='254713000099', amount=Decimal('1000'),
    status=DonationStatus.PENDING, checkout_request_id='AUDIT-REPLAY-1')
r0, w0 = wallet('alpha-build')
c1 = requests.post(f'{BASE}/donations/callback/', json=stk_body('AUDIT-REPLAY-1', 0, 1000, 'RCPT-A1'), timeout=15)
r1, w1 = wallet('alpha-build')
c2 = requests.post(f'{BASE}/donations/callback/', json=stk_body('AUDIT-REPLAY-1', 0, 1000, 'RCPT-A1'), timeout=15)
r2, w2 = wallet('alpha-build')
print(f'  before raised={r0} wallet={w0}')
print(f'  after 1st  raised={r1} wallet={w1} (callback {c1.status_code}; expect +975 net of 1000@2.5%)')
print(f'  after 2nd  raised={r2} wallet={w2} (replay {c2.status_code}; expect UNCHANGED)')
print(f'  credited once: {r1-r0==Decimal("975") and r2==r1} (raised delta={r1-r0}, replay delta={r2-r1})')
d.refresh_from_db()
print(f'  donation stored: status={d.status} amount(gross)={d.amount} fee={d.platform_fee} net={d.net_amount}')

print('\n=== 2.1.B credit uses CALLBACK-confirmed amount, not client-supplied ===')
Donation.objects.filter(checkout_request_id='AUDIT-AMT-1').delete()
Donation.objects.create(campaign=Campaign.objects.get(slug='alpha-build'),
    phone_number='254713000098', amount=Decimal('5'),
    status=DonationStatus.PENDING, checkout_request_id='AUDIT-AMT-1')
rb, wb = wallet('alpha-build')
requests.post(f'{BASE}/donations/callback/', json=stk_body('AUDIT-AMT-1', 0, 10000, 'RCPT-AMT'), timeout=15)
ra, wa = wallet('alpha-build')
print(f'  donor initiated amount=5 but callback Amount=10000 -> raised delta={ra-rb} (expect 9750 net of 10000)')

print('\n=== 2.1.C B2C result callback replay -> wallet decrement exactly once ===')
Withdrawal.objects.filter(payout_reference='AUDIT-B2C-TXN').delete()
beta = Campaign.objects.get(slug='beta-outreach')
w = Withdrawal.objects.create(campaign=beta, requested_by_phone='254712000002',
    amount=Decimal('700'), destination_phone='254712000002', destination_name='Beta CampTreas',
    reason='b2c replay test', status=WithdrawalStatus.PROCESSING, b2c_conversation_id='AUDIT-CONV-1')
_, bw0 = wallet('beta-outreach')
b1 = requests.post(f'{BASE}/withdrawals/b2c-result/', json=b2c_body('AUDIT-CONV-1', 0, 'AUDIT-B2C-TXN'), timeout=15)
_, bw1 = wallet('beta-outreach')
b2 = requests.post(f'{BASE}/withdrawals/b2c-result/', json=b2c_body('AUDIT-CONV-1', 0, 'AUDIT-B2C-TXN'), timeout=15)
_, bw2 = wallet('beta-outreach')
w.refresh_from_db()
print(f'  wallet before={bw0} after1st={bw1} ({b1.status_code}) after2nd={bw2} ({b2.status_code})')
print(f'  decremented once by 700: {bw0-bw1==Decimal("700") and bw2==bw1} ; withdrawal status={w.status}')

print('\n=== 2.1.D donation initiate boundary amounts (must 400 before any STK push) ===')
for amt in ['0', '-100', '4', '4.99', '999999999999999']:
    r = requests.post(f'{BASE}/donations/initiate/',
        json={'campaign_slug':'alpha-build','phone_number':'254713000097','amount':amt}, timeout=15)
    print(f'  amount={amt:>16s} -> {r.status_code} (expect 400)')

print('\n=== 2.1.E callbacks are unauthenticated; unknown ids no-op (forge surface) ===')
u1 = requests.post(f'{BASE}/donations/callback/', json=stk_body('NONEXISTENT-CHECKOUT', 0, 500, 'X'), timeout=15)
u2 = requests.post(f'{BASE}/withdrawals/b2c-result/', json=b2c_body('NONEXISTENT-CONV', 0, 'X'), timeout=15)
print(f'  donation callback unknown id (no auth) -> {u1.status_code} {u1.text[:60]}')
print(f'  b2c result unknown id      (no auth) -> {u2.status_code} {u2.text[:60]}')
print('  NOTE: both accept unauthenticated POSTs; correctness rests on unguessable ids + idempotency (no IP allowlist/secret).')

print('\n=== 2.1.F Net-Everywhere: public campaign detail leaks no wallet/treasurer/fee ===')
pc = requests.get(f'{BASE}/campaigns/alpha-build/', timeout=15).json()
forbidden = [k for k in ('wallet_balance','treasurer_phone','treasurer_name','checkout_request_id','b2c_conversation_id','platform_fee') if k in pc]
print(f'  public campaign keys leaking forbidden fields: {forbidden or "NONE (OK)"}')
print(f'  raised_amount present (NET): {pc.get("raised_amount")}')

print('\n== P2.1 DONE ==')
