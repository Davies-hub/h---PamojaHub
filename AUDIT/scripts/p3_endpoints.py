"""Phase 3.2 — endpoint status-code + response-shape matrix (:8009 / pamoja_audit).

For each contract row: happy path (status + top-level shape), key error paths
(404 unknown / 400 missing-required / 405 wrong-method). 401/403/IDOR + money
boundaries already covered in Ph1-2; this fills the systematic status+shape grid.
Read-only except the documented Ph1-2 mutations already present. ASCII stdout.
"""
import os, sys, json
import requests

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, BACKEND)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.development')
import django; django.setup()
from campaigns.models import Campaign, GroupLabel
from churches.models import Church
from donations.models import Donation
from withdrawals.models import Withdrawal

sys.path.insert(0, os.path.dirname(__file__))
from _authlib import get_tokens, H

BASE = 'http://127.0.0.1:8009/api/v1'
TOK = get_tokens()
A = H(TOK['A']['access']); SUP = H(TOK['super']['access'])

# known ids
alpha = Campaign.objects.get(slug='alpha-build')
chA = alpha.church
chB = Church.objects.get(official_email='beta@audit.test')
donA = Donation.objects.filter(campaign=alpha).first()
wdA = Withdrawal.objects.filter(campaign=alpha).first()
glA = GroupLabel.objects.filter(church=chA).first()

results = []
def shape(r):
    try:
        j = r.json()
    except Exception:
        return '(non-json)'
    if isinstance(j, list):
        return f'[list n={len(j)}]'
    if isinstance(j, dict):
        return '{' + ','.join(sorted(j.keys())) + '}'
    return str(type(j))

def hit(method, path, hdr=None, body=None, expect=None, note=''):
    url = f'{BASE}{path}'
    r = requests.request(method, url, headers=hdr, json=body, timeout=20)
    ok = (r.status_code == expect) if expect is not None else True
    if expect is not None:
        results.append(ok)
    tag = '    ' if expect is None else (' OK ' if ok else 'FAIL')
    exp = f' (exp {expect})' if expect is not None else ''
    print(f'  [{tag}] {method:5s} {path:42s} -> {r.status_code}{exp}  {shape(r)}  {note}')
    return r

print('=== PUBLIC (no auth) ===')
hit('GET', '/campaigns/', expect=200, note='list shape')
hit('GET', '/campaigns/alpha-build/', expect=200, note='detail+updates')
hit('GET', '/campaigns/no-such-slug/', expect=404)
hit('GET', '/churches/', expect=200, note='list shape')
hit('GET', f'/churches/{chA.id}/', expect=200)
hit('GET', '/churches/00000000-0000-0000-0000-000000000000/', expect=404)

print('\n=== AUTH error/happy paths ===')
hit('POST', '/auth/login/', body={'email': 'super@audit.test', 'password': 'wrong'}, expect=401, note='bad creds')
hit('POST', '/auth/login/', body={'email': 'super@audit.test'}, expect=400, note='missing password')
hit('GET', '/auth/me/', expect=401, note='no token')
hit('GET', '/auth/me/', hdr=A, expect=200)
hit('POST', '/auth/register/', body={'email': 'x'}, expect=400, note='missing required')
hit('POST', '/auth/token/refresh/', body={'refresh': 'garbage'}, expect=401, note='bad refresh')

print('\n=== TREASURER (JWT A) — happy + 404 ===')
hit('GET', '/campaigns/mine/', hdr=A, expect=200, note='list shape')
hit('GET', '/campaigns/mine/alpha-build/', hdr=A, expect=200)
hit('GET', '/campaigns/mine/no-such-slug/', hdr=A, expect=404)
hit('GET', '/withdrawals/', hdr=A, expect=200, note='list shape')
hit('GET', '/churches/me/', hdr=A, expect=200)
hit('GET', '/churches/me/stats/', hdr=A, expect=200, note='stats obj')
hit('GET', '/churches/me/donations/', hdr=A, expect=200, note='list shape')
hit('GET', '/group-labels/', hdr=A, expect=200, note='list shape')
hit('GET', f'/group-labels/{glA.id}/', hdr=A, expect=200)
hit('GET', '/group-labels/00000000-0000-0000-0000-000000000000/', hdr=A, expect=404)
hit('GET', '/notifications/', hdr=A, expect=200, note='list shape')
hit('GET', '/notifications/unread-count/', hdr=A, expect=200, note='count obj')

print('\n=== SUPER (JWT super) — list shapes + objects ===')
for p in ('/super/churches/', '/super/churches/pending/', '/super/campaigns/',
          '/super/donations/', '/super/withdrawals/', '/super/audit-log/'):
    hit('GET', p, hdr=SUP, expect=200, note='super list shape')
hit('GET', '/super/analytics/', hdr=SUP, expect=200, note='analytics obj')
hit('GET', '/super/billing/', hdr=SUP, expect=200, note='billing obj')

print('\n=== DONATIONS / SUBSCRIPTIONS error paths ===')
hit('GET', f'/donations/{donA.id}/status/', expect=200, note='donor status (gross)')
hit('GET', '/donations/00000000-0000-0000-0000-000000000000/status/', expect=404)
hit('POST', '/donations/initiate/', body={'campaign_slug': 'alpha-build'}, expect=400, note='missing phone/amount')
hit('POST', '/donations/initiate/', body={'campaign_slug': 'no-such', 'phone_number': '254700000000', 'amount': '100'}, expect=404, note='unknown campaign')
hit('GET', '/subscriptions/00000000-0000-0000-0000-000000000000/status/', hdr=A, expect=404)

print('\n=== METHOD-not-allowed spot checks (405) ===')
hit('GET', '/auth/login/', expect=405, note='login is POST-only')
hit('DELETE', '/campaigns/mine/alpha-build/', hdr=A, expect=405, note='no DELETE')
hit('PUT', '/churches/me/', hdr=A, expect=405, note='PATCH-only (no PUT)')
hit('GET', '/withdrawals/{}/approve/'.format(wdA.id), hdr=A, expect=405, note='approve is POST-only')

print('\n=== SHAPE assertions (contract) ===')
def keys(r):
    return set(r.json().keys()) if r.headers.get('content-type','').startswith('application/json') else set()
pub = requests.get(f'{BASE}/campaigns/', timeout=20)
trz = requests.get(f'{BASE}/campaigns/mine/', headers=A, timeout=20)
sup = requests.get(f'{BASE}/super/campaigns/', headers=SUP, timeout=20)
notif = requests.get(f'{BASE}/notifications/', headers=A, timeout=20)
DRF = {'count', 'next', 'previous', 'results'}
D5 = {'items', 'total', 'truncated'}
def assert_shape(label, r, expected):
    k = keys(r); ok = (k == expected)
    results.append(ok)
    print(f'  [{" OK " if ok else "FAIL"}] {label}: {sorted(k)} == {sorted(expected)}')
# ALL backend lists emit the DRF wire shape {count,next,previous,results}. The FE
# "D5" Paginated{items,total,truncated} is an FE-INTERNAL adapter type built in
# superadmin.service.ts (items=data.results, total=data.count, truncated=data.next!=null).
# So the wire contract is uniformly DRF — confirmed against superadmin.service.ts.
assert_shape('public /campaigns/ = DRF {count,results}', pub, DRF)
assert_shape('treasurer /campaigns/mine/ = DRF {count,results}', trz, DRF)
assert_shape('super /super/campaigns/ = DRF wire shape (FE adapts to items/total/truncated)', sup, DRF)
assert_shape('notifications /notifications/ = DRF {count,results}', notif, DRF)
_ = D5  # retained for documentation of the FE-internal shape

print('\n=== SUMMARY ===')
print(f'  {sum(results)}/{len(results)} asserted checks PASS')
print('== P3.2 DONE ==' if all(results) else '== P3.2 has MISMATCHES — inspect above ==')
