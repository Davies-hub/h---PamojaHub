"""Phase 1.2 — privilege escalation + cross-tenant IDOR sweep (:8009 / pamoja_audit)."""
import os, sys
import requests
sys.path.insert(0, os.path.dirname(__file__))
from _authlib import BASE, get_tokens, H

T = get_tokens()
A = T['A']['access']; B = T['B']['access']; S = T['super']['access']

def show(label, r, expect):
    ok = 'OK' if str(r.status_code) in expect.split('/') else '*** UNEXPECTED ***'
    print(f'  [{r.status_code} exp {expect}] {ok}  {label}')

def my_groups(tok):
    r = requests.get(f'{BASE}/group-labels/', headers=H(tok), timeout=15)
    data = r.json()
    return data.get('results', data) if isinstance(data, dict) else data
gA = my_groups(A); gB = my_groups(B)
gA_id = gA[0]['id'] if gA else None
gB_id = gB[0]['id'] if gB else None
print('group A id', gA_id, '| group B id', gB_id)

print('\n=== 1.2.1 list endpoints scope to own church (no cross-tenant rows) ===')
for tok, who, foreign_slug in [(A,'A','beta-outreach'), (B,'B','alpha-build')]:
    r = requests.get(f'{BASE}/campaigns/mine/', headers=H(tok), timeout=15)
    items = r.json().get('results', [])
    slugs = [c.get('slug') for c in items]
    leak = foreign_slug in slugs
    print(f'  treasurer {who} /campaigns/mine/ slugs={slugs}  cross-leak={leak} {"*** LEAK ***" if leak else "OK"}')
    rw = requests.get(f'{BASE}/withdrawals/', headers=H(tok), timeout=15)
    wits = rw.json().get('results', [])
    print(f'  treasurer {who} /withdrawals/ count={len(wits)}')
    rd = requests.get(f'{BASE}/churches/me/donations/', headers=H(tok), timeout=15)
    dons = rd.json().get('results', [])
    print(f'  treasurer {who} /churches/me/donations/ count={len(dons)}')

print('\n=== 1.2.2 cross-tenant: treasurer A targets church B objects (all must reject) ===')
show('A GET /campaigns/mine/beta-outreach/', requests.get(f'{BASE}/campaigns/mine/beta-outreach/', headers=H(A), timeout=15), '403/404')
show('A POST pause beta-outreach', requests.post(f'{BASE}/campaigns/mine/beta-outreach/pause/', headers=H(A), timeout=15), '403/404')
show('A POST resume beta-outreach', requests.post(f'{BASE}/campaigns/mine/beta-outreach/resume/', headers=H(A), timeout=15), '403/404')
show('A POST close beta-outreach', requests.post(f'{BASE}/campaigns/mine/beta-outreach/close/', headers=H(A), timeout=15), '403/404')
if gB_id:
    show('A PATCH group-label B', requests.patch(f'{BASE}/group-labels/{gB_id}/', headers=H(A), json={'name':'hacked'}, timeout=15), '403/404')
    show('A POST archive group-label B', requests.post(f'{BASE}/group-labels/{gB_id}/archive/', headers=H(A), timeout=15), '403/404')
    show('A GET group-label B (detail)', requests.get(f'{BASE}/group-labels/{gB_id}/', headers=H(A), timeout=15), '403/404')

print('\n=== 1.2.3 cross-tenant withdrawal money actions (B withdrawal id via A) ===')
rs = requests.get(f'{BASE}/super/withdrawals/', headers=H(S), timeout=15)
sd = rs.json(); witems = sd.get('items', sd.get('results', []))
def is_beta(w): return 'Beta' in str(w)
wB = next((w['id'] for w in witems if is_beta(w)), None)
print('  resolved wB=', wB, ' (super withdrawal count=', len(witems), ')')
if wB:
    show('A approve B withdrawal', requests.post(f'{BASE}/withdrawals/{wB}/approve/', headers=H(A), timeout=15), '403/404')
    show('A reject B withdrawal', requests.post(f'{BASE}/withdrawals/{wB}/reject/', headers=H(A), json={'reason':'x'}, timeout=15), '403/404')
    show('A retry B withdrawal', requests.post(f'{BASE}/withdrawals/{wB}/retry/', headers=H(A), timeout=15), '403/404')

print('\n=== 1.2.4 privilege escalation: treasurer token on EVERY /super/ endpoint (must 403) ===')
for m,p in [('GET','churches/'),('GET','churches/pending/'),('GET','campaigns/'),('GET','donations/'),
            ('GET','withdrawals/'),('GET','analytics/'),('GET','audit-log/'),('GET','billing/')]:
    show(f'A {m} /super/{p}', requests.request(m, f'{BASE}/super/{p}', headers=H(A), timeout=15), '403')
fake = '00000000-0000-0000-0000-000000000000'
for m,p in [('POST', f'churches/{fake}/approve/'),('POST', f'churches/{fake}/reject/'),
            ('POST', f'churches/{fake}/suspend/'),('POST', f'churches/{fake}/reactivate/'),
            ('POST', f'churches/{fake}/set-tier/'),('POST', f'withdrawals/{fake}/force-retry/'),
            ('POST', f'withdrawals/{fake}/resolve-paid/'),('POST', f'withdrawals/{fake}/resolve-retry/'),
            ('PATCH','billing/')]:
    show(f'A {m} /super/{p}', requests.request(m, f'{BASE}/super/{p}', headers=H(A), json={}, timeout=15), '403')

print('\n=== 1.2.5 unauthenticated access to protected endpoints (must 401) ===')
for m,p in [('GET','auth/me/'),('GET','campaigns/mine/'),('GET','withdrawals/'),('GET','super/churches/'),
            ('GET','churches/me/'),('GET','notifications/'),('GET','churches/me/stats/')]:
    show(f'anon {m} /{p}', requests.request(m, f'{BASE}/{p}', timeout=15), '401')

print('\n== P1.2 DONE ==')
