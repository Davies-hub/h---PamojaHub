"""Phase 1.3 — mass assignment probes (:8009 / pamoja_audit). Mutates audit DB only."""
import os, sys
import requests
sys.path.insert(0, os.path.dirname(__file__))
from _authlib import BASE, get_tokens, H

T = get_tokens()
A = T['A']['access']; B = T['B']['access']; S = T['super']['access']

def jpp(label, r):
    print(f'  [{r.status_code}] {label}')
    try: return r.json()
    except Exception: return {}

# resolve church B id + group B id for cross-tenant attempts
chB = requests.get(f'{BASE}/super/churches/', headers=H(S), timeout=15).json()
chB_items = chB.get('items', chB.get('results', []))
chB_id = next((c['id'] for c in chB_items if 'Beta' in c.get('name','')), None)
gB = requests.get(f'{BASE}/group-labels/', headers=H(B), timeout=15).json()
gB_items = gB.get('results', gB) if isinstance(gB, dict) else gB
gB_id = gB_items[0]['id'] if gB_items else None
print('church B id', chB_id, '| group B id', gB_id)

print('\n=== 1.3.1 PATCH /churches/me/ (A) with privileged fields (must be ignored) ===')
before = requests.get(f'{BASE}/churches/me/', headers=H(A), timeout=15).json()
print('  before: status=%s tier=%s email=%s cancel=%s' % (
    before.get('status'), before.get('subscription_tier'),
    before.get('official_email'), before.get('subscription_cancel_requested')))
r = requests.patch(f'{BASE}/churches/me/', headers=H(A), json={
    'status': 'ACTIVE', 'subscription_tier': 'PARISH',
    'official_email': 'attacker@evil.test',
    'subscription_cancel_requested': True,
    'subscription_expires_at': '2099-01-01T00:00:00Z',
    'description': 'massassign-marker',
}, timeout=15)
after = jpp('PATCH /churches/me/', r)
af = requests.get(f'{BASE}/churches/me/', headers=H(A), timeout=15).json()
print('  after:  status=%s tier=%s email=%s cancel=%s exp=%s' % (
    af.get('status'), af.get('subscription_tier'), af.get('official_email'),
    af.get('subscription_cancel_requested'), af.get('subscription_expires_at')))
chg = [k for k in ('status','subscription_tier','official_email','subscription_cancel_requested','subscription_expires_at')
       if before.get(k) != af.get(k)]
print('  PRIVILEGED FIELDS CHANGED:', chg or 'NONE (OK)')

print('\n=== 1.3.2 campaign create (A) with privileged extras (must be ignored) ===')
payload = {
    'title': 'MassAssign Test', 'description': 'x', 'goal_amount': '50000',
    'banner_image_url': 'https://example.com/b.png', 'category': 'Building',
    'treasurer_phone': '254712000009', 'treasurer_name': 'MA Treas',
    # privileged / server-managed:
    'raised_amount': '999999', 'wallet_balance': '888888', 'status': 'CLOSED',
    'church': chB_id, 'created_by': T['super']['user']['id'] if 'user' in T['super'] else None,
}
r = requests.post(f'{BASE}/campaigns/mine/create/', headers=H(A), json=payload, timeout=15)
camp = jpp('POST campaign create', r)
print('  created: slug=%s raised=%s wallet=%s status=%s church_name=%s' % (
    camp.get('slug'), camp.get('raised_amount'), camp.get('wallet_balance'),
    camp.get('status'), camp.get('church_name')))
# verify it belongs to church A, not B, and money fields are 0
if camp.get('slug'):
    chk = requests.get(f'{BASE}/super/campaigns/', headers=H(S), timeout=15).json()
    items = chk.get('items', chk.get('results', []))
    mine = next((c for c in items if c.get('slug')==camp.get('slug')), {})
    print('  super view: church_name=%s raised=%s status=%s' % (
        mine.get('church_name'), mine.get('raised_amount'), mine.get('status')))

print('\n=== 1.3.3 group-label create (A) parented under church B group (cross-tenant) ===')
r = requests.post(f'{BASE}/group-labels/', headers=H(A), json={
    'name': 'A child of B', 'parent_label': gB_id,
}, timeout=15)
gl = jpp('POST group-label parent=B', r)
print('  result:', {k: gl.get(k) for k in ('id','name','parent_label')} if gl else gl)
print('  EXPECT: 400 (parent not in caller church) — if 201 with parent_label=B, that is a cross-tenant mass-assign FINDING')

print('\n=== 1.3.4 group-label create (A) with church=B id (must be ignored, label stays A) ===')
r = requests.post(f'{BASE}/group-labels/', headers=H(A), json={
    'name': 'church-field-test', 'church': chB_id,
}, timeout=15)
gl2 = jpp('POST group-label church=B', r)
# confirm it shows in A's list, not B's
if gl2.get('id'):
    aList = requests.get(f'{BASE}/group-labels/', headers=H(A), timeout=15).json()
    aItems = aList.get('results', aList) if isinstance(aList, dict) else aList
    inA = any(x['id']==gl2['id'] for x in aItems)
    bList = requests.get(f'{BASE}/group-labels/', headers=H(B), timeout=15).json()
    bItems = bList.get('results', bList) if isinstance(bList, dict) else bList
    inB = any(x['id']==gl2['id'] for x in bItems)
    print(f'  new label in A list={inA} in B list={inB}  (expect inA=True inB=False)')

print('\n== P1.3 DONE ==')
