"""Phase 1.5 — live audit-write confirmation (mutates pamoja_audit only)."""
import os, sys
import requests
sys.path.insert(0, os.path.dirname(__file__))
from _authlib import BASE, get_tokens, H

T = get_tokens()
S = T['super']['access']

ch = requests.get(f'{BASE}/super/churches/', headers=H(S), timeout=15).json()
items = ch.get('items', ch.get('results', []))
chB = next((c for c in items if 'Beta' in c.get('name','')), None)
print('church B status before:', chB.get('status'))

# suspend B
r = requests.post(f"{BASE}/super/churches/{chB['id']}/suspend/", headers=H(S), timeout=15)
print('suspend ->', r.status_code)

# read audit-log, find newest CHURCH_SUSPENDED
al = requests.get(f'{BASE}/super/audit-log/', headers=H(S), timeout=15).json()
rows = al.get('items', al.get('results', []))
susp = next((x for x in rows if x.get('action')=='CHURCH_SUSPENDED'), None)
print('audit row:', {k: susp.get(k) for k in ('action','actor','actorEmail','actor_email','entity_type','entityType','ipAddress','ip_address')} if susp else 'NOT FOUND')

# reactivate to restore fixture
rr = requests.post(f"{BASE}/super/churches/{chB['id']}/reactivate/", headers=H(S), timeout=15)
print('reactivate ->', rr.status_code)
chk = requests.get(f'{BASE}/super/churches/', headers=H(S), timeout=15).json()
items2 = chk.get('items', chk.get('results', []))
print('church B status restored:', next((c.get('status') for c in items2 if 'Beta' in c.get('name','')), '?'))
print('== P1.5 DONE ==')
