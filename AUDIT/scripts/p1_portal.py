"""Phase 1.4 — Portal OTP auth probes (:8009 / pamoja_audit).

Combines ORM injection (known-plaintext OTP + crafted PortalToken rows) with HTTP
so we exercise verify/IP-binding/TTL/revocation/scope WITHOUT burning SMS throttle
buckets. request-otp is probed only twice (enumeration parity + timing).
"""
import os, sys, time, secrets
from datetime import timedelta
import requests

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, BACKEND)
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.development')
import django; django.setup()
from django.utils import timezone
from accounts.utils import hash_token
from treasurer_portal.models import CampaignTreasurerOTP, PortalToken
from campaigns.models import Campaign

BASE = 'http://127.0.0.1:8009/api/v1'
PHONE_A = '254712000001'   # campaign-treasurer A (known)
PHONE_UNKNOWN = '254700999999'
camp_a = Campaign.objects.get(slug='alpha-build')
camp_b = Campaign.objects.get(slug='beta-outreach')

def timed_post(path, body):
    t = time.perf_counter()
    r = requests.post(f'{BASE}{path}', json=body, timeout=20)
    return r, (time.perf_counter() - t) * 1000

print('=== 1.4.1 request-otp enumeration parity (known vs unknown) ===')
ru, tu = timed_post('/treasurer/request-otp/', {'phone_number': PHONE_UNKNOWN})
print(f'  UNKNOWN phone -> {ru.status_code} in {tu:.0f}ms  body={ru.text[:90]}')
rk, tk = timed_post('/treasurer/request-otp/', {'phone_number': PHONE_A})
print(f'  KNOWN   phone -> {rk.status_code} in {tk:.0f}ms  body={rk.text[:90]}')
print(f'  --> status differs: {ru.status_code != rk.status_code} ; timing delta: {tk - tu:.0f}ms')
print('  (known path makes a synchronous SMS network call; unknown short-circuits)')

def inject_otp(phone, code, campaign_ids, minutes=10, attempt_count=0, is_used=False):
    CampaignTreasurerOTP.objects.filter(phone_number=phone, is_used=False).update(is_used=True)
    return CampaignTreasurerOTP.objects.create(
        phone_number=phone, otp_code=hash_token(code),
        campaign_ids=[str(c) for c in campaign_ids],
        attempt_count=attempt_count, is_used=is_used,
        expires_at=timezone.now() + timedelta(minutes=minutes),
    )

print('\n=== 1.4.2 verify-otp wrong then correct (injected OTP) ===')
otp = inject_otp(PHONE_A, '123456', [camp_a.id])
rw = requests.post(f'{BASE}/treasurer/verify-otp/', json={'phone_number': PHONE_A, 'otp_code': '000000'}, timeout=15)
print(f'  wrong code   -> {rw.status_code} (expect 400)')
rc = requests.post(f'{BASE}/treasurer/verify-otp/', json={'phone_number': PHONE_A, 'otp_code': '123456'}, timeout=15)
print(f'  correct code -> {rc.status_code} (expect 200)')
tok = rc.json().get('portal_token') if rc.status_code == 200 else None
print(f'  portal_token issued: {bool(tok)} ; campaigns scoped: {[c.get("slug") for c in rc.json().get("campaigns", [])] if rc.status_code==200 else None}')

# confirm DB stores hashes, not plaintext
otp_row = CampaignTreasurerOTP.objects.filter(phone_number=PHONE_A).order_by('-id').first()
print(f'  OTP stored hashed: len={len(otp_row.otp_code)} hex={all(c in "0123456789abcdef" for c in otp_row.otp_code)} (expect 64-hex)')

print('\n=== 1.4.3 portal token use + scope enforcement ===')
def H(t): return {'X-Portal-Token': t}
if tok:
    r = requests.get(f'{BASE}/treasurer/campaigns/', headers=H(tok), timeout=15)
    print(f'  GET /treasurer/campaigns/ with token -> {r.status_code} (expect 200)')
    ptok_row = PortalToken.objects.filter(token_hash=hash_token(tok)).first()
    print(f'  PortalToken stored hashed: len={len(ptok_row.token_hash)} ip_bound={ptok_row.ip_address!r}')
    # scope: beta campaign not in token scope
    rs = requests.get(f'{BASE}/treasurer/campaigns/{camp_b.id}/disbursements/', headers=H(tok), timeout=15)
    print(f'  GET beta disbursements (out of scope) -> {rs.status_code} (expect 403)')
    ra = requests.get(f'{BASE}/treasurer/campaigns/{camp_a.id}/disbursements/', headers=H(tok), timeout=15)
    print(f'  GET alpha disbursements (in scope)    -> {ra.status_code} (expect 200)')

print('\n=== 1.4.4 crafted PortalToken rows: IP-binding / empty-IP / expiry / revoked ===')
def craft(raw, ip, minutes, revoked):
    PortalToken.objects.create(
        phone_number=PHONE_A, campaign_ids=[str(camp_a.id)], ip_address=ip,
        token_hash=hash_token(raw), is_revoked=revoked,
        expires_at=timezone.now() + timedelta(minutes=minutes),
    )
cases = [
    ('ip-mismatch', '9.9.9.9', 30, False, '401'),
    ('empty-ip',    '',        30, False, '401'),
    ('expired',     '127.0.0.1', -5, False, '401'),
    ('revoked',     '127.0.0.1', 30, True, '401'),
    ('valid',       '127.0.0.1', 30, False, '200'),
]
for name, ip, mins, rev, exp in cases:
    raw = secrets.token_urlsafe(24)
    craft(raw, ip, mins, rev)
    r = requests.get(f'{BASE}/treasurer/campaigns/', headers=H(raw), timeout=15)
    ok = 'OK' if str(r.status_code) == exp else '*** UNEXPECTED ***'
    print(f'  {name:12s} ip={ip!r:11s} -> {r.status_code} (expect {exp}) {ok}')

print('\n=== 1.4.5 per-OTP attempt cap (attempt_count pre-set to 4) ===')
inject_otp(PHONE_A, '654321', [camp_a.id], attempt_count=4)
r1 = requests.post(f'{BASE}/treasurer/verify-otp/', json={'phone_number': PHONE_A, 'otp_code': '111111'}, timeout=15)
print(f'  wrong attempt #5 -> {r1.status_code} (expect 400, OTP now dead)')
r2 = requests.post(f'{BASE}/treasurer/verify-otp/', json={'phone_number': PHONE_A, 'otp_code': '654321'}, timeout=15)
print(f'  correct after cap-> {r2.status_code} (expect 400 — OTP is_used)')
dead = CampaignTreasurerOTP.objects.filter(phone_number=PHONE_A, otp_code=hash_token('654321')).first()
print(f'  OTP is_used after cap: {dead.is_used if dead else "?"} (expect True)')

print('\n=== 1.4.6 portal token rejected on JWT (api) path? header isolation ===')
if tok:
    r = requests.get(f'{BASE}/treasurer/campaigns/', headers={'Authorization': f'Bearer {tok}'}, timeout=15)
    print(f'  portal raw as Bearer JWT -> {r.status_code} (expect 401 — not a JWT)')

print('\n== P1.4 DONE ==')
