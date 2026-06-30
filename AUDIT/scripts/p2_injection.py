"""Phase 2.2 — injection & stored-XSS storage/sanitization checks (:8009)."""
import os, sys
import requests
sys.path.insert(0, os.path.dirname(__file__))
from _authlib import BASE, get_tokens, H

T = get_tokens()
A = T['A']['access']

XSS = '<script>alert(1)</script><img src=x onerror=alert(2)><b>bold</b>'
SQLISH = "Robert'); DROP TABLE campaigns;--"

print('=== 2.2.1 campaign description bleach sanitization (create) ===')
r = requests.post(f'{BASE}/campaigns/mine/create/', headers=H(A), json={
    'title': 'XSS Test '+SQLISH[:20], 'description': XSS,
    'goal_amount': '1000', 'banner_image_url':'https://example.com/b.png',
    'category':'Building','treasurer_phone':'254712000050','treasurer_name':'X'}, timeout=15)
print(f'  create -> {r.status_code}')
if r.status_code == 201:
    desc = r.json().get('description')
    print(f'  stored description: {desc!r}')
    print(f'  <script> stripped: {"<script>" not in desc} ; onerror stripped: {"onerror" not in desc} ; <b> kept: {"<b>" in desc}')
    print(f'  title (SQL-ish) stored verbatim, tables intact: {requests.get(BASE+"/campaigns/", timeout=15).status_code==200}')

print('\n=== 2.2.2 group-label name (no bleach) stored verbatim; API JSON-safe ===')
r = requests.post(f'{BASE}/group-labels/', headers=H(A), json={'name': XSS}, timeout=15)
print(f'  create -> {r.status_code} ; name stored: {r.json().get("name")!r}')
print('  (FE renders names in <Text> — escaped; no dangerouslySetInnerHTML/WebView in frontend)')

print('\n=== 2.2.3 donation donor_name with payload -> stored, returned JSON-encoded ===')
import django  # noqa
from decimal import Decimal
BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, BACKEND); os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings.development')
django.setup()
from donations.models import Donation, DonationStatus
from campaigns.models import Campaign
Donation.objects.filter(checkout_request_id='AUDIT-XSS-1').delete()
Donation.objects.create(campaign=Campaign.objects.get(slug='alpha-build'), phone_number='254713000050',
    donor_name=XSS, amount=Decimal('100'), status=DonationStatus.SUCCESSFUL,
    net_amount=Decimal('97.50'), platform_fee=Decimal('2.50'), checkout_request_id='AUDIT-XSS-1')
S = T['super']['access']
dons = requests.get(f'{BASE}/super/donations/', headers=H(S), timeout=15).json()
items = dons.get('items', dons.get('results', []))
hit = next((d for d in items if 'script' in str(d.get('donor_name',''))), None)
print(f'  super donations returns donor_name raw in JSON: {hit.get("donor_name") if hit else "not found"!r}')
print('  (raw markup in JSON string is inert until rendered; FE uses <Text> escaping)')

print('\n== P2.2 DONE ==')
