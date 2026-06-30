"""Phase 1.6 — password reset / account flow probes (:8009 / pamoja_audit)."""
import os, sys, time
from datetime import timedelta
import requests

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, BACKEND)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.development')
import django; django.setup()
from django.utils import timezone
from accounts.models import User, PasswordResetOTP, RefreshToken, UserRole
from accounts.utils import hash_token

BASE = 'http://127.0.0.1:8009/api/v1'

def timed_post(path, body):
    t = time.perf_counter()
    r = requests.post(f'{BASE}{path}', json=body, timeout=20)
    return r, (time.perf_counter() - t) * 1000

print('=== 1.6.1 reset-request enumeration parity + timing ===')
ru, tu = timed_post('/auth/password-reset/request/', {'email': 'nobody@audit.test'})
print(f'  UNKNOWN email -> {ru.status_code} in {tu:.0f}ms  body={ru.text[:80]}')
rk, tk = timed_post('/auth/password-reset/request/', {'email': 'treasurerA@audit.test'})
print(f'  KNOWN   email -> {rk.status_code} in {tk:.0f}ms  body={rk.text[:80]}')
print(f'  status differs: {ru.status_code != rk.status_code} ; timing delta: {tk - tu:.0f}ms (known path makes synchronous email send)')

# throwaway user for confirm flow (don't touch seeded treasurer passwords)
u, _ = User.objects.get_or_create(email='resettest@audit.test',
        defaults=dict(first_name='Reset', last_name='Test', role=UserRole.CHURCH_TREASURER))
u.set_password('OldPass!234'); u.save()

def inject_otp(user, code, minutes=15, used=False, attempts=0):
    PasswordResetOTP.objects.filter(user=user, is_used=False).update(is_used=True)
    return PasswordResetOTP.objects.create(user=user, otp_hash=hash_token(code),
        attempt_count=attempts, is_used=used,
        expires_at=timezone.now() + timedelta(minutes=minutes))

print('\n=== 1.6.2 confirm: wrong then correct, then reuse ===')
inject_otp(u, '123456')
rw = requests.post(f'{BASE}/auth/password-reset/confirm/',
    json={'email':'resettest@audit.test','otp_code':'000000','new_password':'NewPass!234'}, timeout=15)
print(f'  wrong code   -> {rw.status_code} (expect 400)')
rc = requests.post(f'{BASE}/auth/password-reset/confirm/',
    json={'email':'resettest@audit.test','otp_code':'123456','new_password':'NewPass!234'}, timeout=15)
print(f'  correct code -> {rc.status_code} (expect 200)')
u.refresh_from_db()
print(f'  password changed (ORM check): new={u.check_password("NewPass!234")} old={u.check_password("OldPass!234")}')
rr = requests.post(f'{BASE}/auth/password-reset/confirm/',
    json={'email':'resettest@audit.test','otp_code':'123456','new_password':'Another!234'}, timeout=15)
print(f'  reuse same OTP -> {rr.status_code} (expect 400 — is_used)')

print('\n=== 1.6.3 expired OTP ===')
u.set_password('OldPass!234'); u.save()
inject_otp(u, '222222', minutes=-1)
re = requests.post(f'{BASE}/auth/password-reset/confirm/',
    json={'email':'resettest@audit.test','otp_code':'222222','new_password':'X!2345678'}, timeout=15)
print(f'  expired OTP confirm -> {re.status_code} (expect 400)')
u.refresh_from_db(); print(f'  password unchanged: {u.check_password("OldPass!234")} (expect True)')

print('\n=== 1.6.4 cross-account hijack: victim email + attacker-controlled OTP ===')
# OTP belongs to resettest; attacker submits treasurerA email with resettest code
inject_otp(u, '333333')
rh = requests.post(f'{BASE}/auth/password-reset/confirm/',
    json={'email':'treasurerA@audit.test','otp_code':'333333','new_password':'Pwned!2345'}, timeout=15)
print(f'  A email + resettest code -> {rh.status_code} (expect 400 — OTP looked up per-user)')

print('\n=== 1.6.5 reset revokes all refresh tokens ===')
# issue a refresh row for resettest, then reset, confirm it gets revoked
RefreshToken.objects.create(user=u, token_hash=hash_token('dummy-'+str(time.time())),
    expires_at=timezone.now()+timedelta(days=7))
live_before = RefreshToken.objects.filter(user=u, is_revoked=False).count()
inject_otp(u, '444444')
requests.post(f'{BASE}/auth/password-reset/confirm/',
    json={'email':'resettest@audit.test','otp_code':'444444','new_password':'Fresh!2345'}, timeout=15)
live_after = RefreshToken.objects.filter(user=u, is_revoked=False).count()
print(f'  live refresh tokens before={live_before} after reset={live_after} (expect after=0)')

# cleanup throwaway user
User.objects.filter(email='resettest@audit.test').delete()
print('\n== P1.6 DONE ==')
