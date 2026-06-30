"""Phase 1.1 — JWT security probes against the audit server (:8009 / pamoja_audit).

Read-only against the API (login + protected GETs). Crafts tokens locally.
Run from backend/:
  DATABASE_URL=...pamoja_audit DJANGO_SETTINGS_MODULE=config.settings.development \
  ./venv/Scripts/python.exe ../AUDIT/scripts/p1_jwt.py
"""
import os, sys, time, json
import requests, jwt

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, BACKEND)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.development')
import django; django.setup()
from django.conf import settings

BASE = 'http://127.0.0.1:8009/api/v1'
PW = 'AuditPass!234'
SECRET = settings.SECRET_KEY
ALGO = settings.SIMPLE_JWT.get('ALGORITHM', 'HS256')

def line(t): print('\n=== ' + t + ' ===')

def login(email):
    r = requests.post(f'{BASE}/auth/login/', json={'email': email, 'password': PW}, timeout=15)
    return r

# ── baseline login ──────────────────────────────────────────────────────────
line('1.1.0 baseline login (treasurerA)')
r = login('treasurerA@audit.test')
print('login status', r.status_code)
tok = r.json()
access = tok['access']; refresh = tok['refresh']
hdr = jwt.get_unverified_header(access)
payload = jwt.decode(access, options={'verify_signature': False})
print('access header:', hdr)
print('access claims:', {k: payload.get(k) for k in payload})
me = requests.get(f'{BASE}/auth/me/', headers={'Authorization': f'Bearer {access}'}, timeout=15)
print('me with good token:', me.status_code, me.json().get('user', {}).get('email'))

# ── 1.1.a tampered payload (flip user_id, no re-sign) ───────────────────────
line('1.1.a tampered payload, original signature (must 401)')
parts = access.split('.')
import base64
def b64d(s): return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))
def b64e(b): return base64.urlsafe_b64encode(b).decode().rstrip('=')
p = json.loads(b64d(parts[1]))
p['user_id'] = '00000000-0000-0000-0000-000000000000'
tampered = parts[0] + '.' + b64e(json.dumps(p).encode()) + '.' + parts[2]
rr = requests.get(f'{BASE}/auth/me/', headers={'Authorization': f'Bearer {tampered}'}, timeout=15)
print('tampered token me:', rr.status_code, '(expect 401)')

# ── 1.1.b alg=none ──────────────────────────────────────────────────────────
line('1.1.b alg=none forged token (must 401)')
none_tok = jwt.encode(p, key='', algorithm='none')
rr = requests.get(f'{BASE}/auth/me/', headers={'Authorization': f'Bearer {none_tok}'}, timeout=15)
print('alg=none me:', rr.status_code, '(expect 401)')

# ── 1.1.c claim injection: validly signed token with role/church claims ─────
line('1.1.c valid-signed token w/ injected role=SUPER_ADMIN + is_superuser')
forged = dict(p)
forged['user_id'] = payload['user_id']  # real treasurer A
forged['role'] = 'SUPER_ADMIN'
forged['is_superuser'] = True
forged['church'] = None
forged['exp'] = int(time.time()) + 3600
forged['iat'] = int(time.time())
forged['token_type'] = 'access'
forged['jti'] = payload.get('jti', 'x')
signed = jwt.encode(forged, SECRET, algorithm=ALGO)
rr = requests.get(f'{BASE}/super/churches/', headers={'Authorization': f'Bearer {signed}'}, timeout=15)
print('injected-role super/churches:', rr.status_code, '(expect 403 — server must use DB role, not claim)')

# ── 1.1.d expired access token (signed, exp in past) ────────────────────────
line('1.1.d expired access token (must 401)')
expd = dict(forged); expd['role'] = 'CHURCH_TREASURER'; expd['exp'] = int(time.time()) - 10
expd_tok = jwt.encode(expd, SECRET, algorithm=ALGO)
rr = requests.get(f'{BASE}/auth/me/', headers={'Authorization': f'Bearer {expd_tok}'}, timeout=15)
print('expired token me:', rr.status_code, '(expect 401)')

# ── 1.1.e refresh rotation + replay ─────────────────────────────────────────
line('1.1.e refresh rotation + replay of old refresh (must 401 on replay)')
r1 = requests.post(f'{BASE}/auth/token/refresh/', json={'refresh': refresh}, timeout=15)
print('first refresh:', r1.status_code)
new_refresh = r1.json().get('refresh') if r1.status_code == 200 else None
r2 = requests.post(f'{BASE}/auth/token/refresh/', json={'refresh': refresh}, timeout=15)
print('replay OLD refresh:', r2.status_code, '(expect 401 — rotation revokes old)')
if new_refresh:
    r3 = requests.post(f'{BASE}/auth/token/refresh/', json={'refresh': new_refresh}, timeout=15)
    print('new refresh works once:', r3.status_code, '(expect 200)')

# ── 1.1.f logout invalidates refresh; access still valid in window ──────────
line('1.1.f logout: refresh revoked, access token lifetime')
r = login('treasurerA@audit.test')
acc2 = r.json()['access']; ref2 = r.json()['refresh']
lo = requests.post(f'{BASE}/auth/logout/', json={'refresh': ref2}, headers={'Authorization': f'Bearer {acc2}'}, timeout=15)
print('logout status:', lo.status_code)
ru = requests.post(f'{BASE}/auth/token/refresh/', json={'refresh': ref2}, timeout=15)
print('refresh after logout:', ru.status_code, '(expect 401)')
mu = requests.get(f'{BASE}/auth/me/', headers={'Authorization': f'Bearer {acc2}'}, timeout=15)
print('ACCESS token after logout:', mu.status_code, '(200 = access NOT invalidated by logout — stateless window up to 60min)')

# ── 1.1.g logout requires auth? can attacker revoke someone else's refresh? ──
line('1.1.g logout cross-user: treasurerB tries to revoke treasurerA refresh')
ra = login('treasurerA@audit.test'); refA = ra.json()['refresh']
rb = login('treasurerB@audit.test'); accB = rb.json()['access']
xo = requests.post(f'{BASE}/auth/logout/', json={'refresh': refA}, headers={'Authorization': f'Bearer {accB}'}, timeout=15)
print('B logs out with A refresh:', xo.status_code)
chk = requests.post(f'{BASE}/auth/token/refresh/', json={'refresh': refA}, timeout=15)
print('A refresh still valid after B logout attempt:', chk.status_code, '(expect 200 — B cannot revoke A; logout filters by user)')
print('\n== P1.1 DONE ==')
