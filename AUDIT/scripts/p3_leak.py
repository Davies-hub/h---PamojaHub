"""Phase 3.3 — serializer leak sweep: every read surface exposes ONLY its allowlist."""
import os, sys
import requests
sys.path.insert(0, os.path.dirname(__file__))
from _authlib import BASE, get_tokens, H

T = get_tokens()
A = T['A']['access']; S = T['super']['access']

def items_of(j):
    if isinstance(j, dict):
        return j.get('items', j.get('results', [j]))
    return j if isinstance(j, list) else [j]

def check(label, url, tok, forbidden, must_have=()):
    h = H(tok) if tok else {}
    r = requests.get(url, headers=h, timeout=15)
    if r.status_code != 200:
        print(f'  [{r.status_code}] {label} (skipped)'); return
    rows = items_of(r.json())
    sample = rows[0] if rows else {}
    keys = set(sample.keys()) if isinstance(sample, dict) else set()
    leaked = sorted(k for k in forbidden if k in keys)
    missing = sorted(k for k in must_have if k not in keys)
    flag = '*** LEAK ***' if leaked else 'OK'
    print(f'  {flag} {label}: leaked={leaked or "none"}' + (f' MISSING={missing}' if missing else ''))

CAMP_FORBIDDEN = ['treasurer_phone','treasurer_name','wallet_balance','checkout_request_id','b2c_conversation_id','church','created_by']
CHURCH_PUB_FORBIDDEN = ['official_email','phone','address','status','subscription_tier','subscription_expires_at','rejection_reason']

print('=== PUBLIC surfaces (anon) ===')
check('public campaigns list', f'{BASE}/campaigns/', None, CAMP_FORBIDDEN, must_have=['raised_amount','title'])
check('public campaign detail', f'{BASE}/campaigns/alpha-build/', None, CAMP_FORBIDDEN)
check('public churches list', f'{BASE}/churches/', None, CHURCH_PUB_FORBIDDEN, must_have=['name','denomination'])

print('\n=== SUPER surfaces ===')
check('super campaigns', f'{BASE}/super/campaigns/', S, ['treasurer_phone','treasurer_name','created_by','church','group_label','closed_at'])
check('super donations', f'{BASE}/super/donations/', S, ['phone_number','donor_email','checkout_request_id','campaign'])
check('super withdrawals', f'{BASE}/super/withdrawals/', S, ['b2c_conversation_id','originator_conversation_id'])
check('super churches', f'{BASE}/super/churches/', S, ['rejection_reason'])
check('super audit-log', f'{BASE}/super/audit-log/', S, [])

print('\n=== TREASURER surfaces (own data) ===')
check('treasurer campaigns/mine', f'{BASE}/campaigns/mine/', A, ['checkout_request_id','b2c_conversation_id'])
check('churches/me', f'{BASE}/churches/me/', A, ['rejection_reason'])
check('churches/me/donations', f'{BASE}/churches/me/donations/', A, ['phone_number','donor_email','checkout_request_id'])

print('\n=== PUBLIC donation status (gross only) ===')
# need a donation id — use the seeded one via super donations
dons = requests.get(f'{BASE}/super/donations/', headers=H(S), timeout=15).json()
did = items_of(dons)[0].get('id') if items_of(dons) else None
if did:
    r = requests.get(f'{BASE}/donations/{did}/status/', timeout=15)
    keys = set(r.json().keys())
    forb = [k for k in ('platform_fee','net_amount','checkout_request_id','b2c_conversation_id','phone_number') if k in keys]
    print(f'  donation status keys={sorted(keys)} forbidden_leaked={forb or "none"}')

print('\n== P3.3 DONE ==')
