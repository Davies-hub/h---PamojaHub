"""Shared token cache for Phase 1+ scripts — logs in each actor at most ONCE
per cache lifetime, to stay under the login rate limit (5/15m per IP).

Tokens cached to scratchpad tokens.json. Delete that file (or call refresh) to
force a re-login. Access tokens live 60 min — plenty for a working session.
"""
import json, os, time
import requests

BASE = 'http://127.0.0.1:8009/api/v1'
PW = 'AuditPass!234'
CACHE = os.path.join(
    os.environ.get('TEMP', '/tmp'),
    'claude', 'j--Pamoja-Hub', 'audit_tokens.json',
)
ACTORS = {
    'super': 'super@audit.test',
    'A': 'treasurerA@audit.test',
    'B': 'treasurerB@audit.test',
}

def _login(email):
    r = requests.post(f'{BASE}/auth/login/', json={'email': email, 'password': PW}, timeout=15)
    if r.status_code != 200:
        raise SystemExit(f'login {email} failed {r.status_code}: {r.text[:200]}')
    return r.json()

def get_tokens(force=False):
    if not force and os.path.exists(CACHE):
        with open(CACHE) as f:
            data = json.load(f)
        # access tokens last 60m; refresh cache if older than 50m
        if time.time() - data.get('_ts', 0) < 50 * 60:
            return data
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    data = {'_ts': time.time()}
    for k, email in ACTORS.items():
        data[k] = _login(email)
    with open(CACHE, 'w') as f:
        json.dump(data, f)
    return data

def H(tok):
    return {'Authorization': f'Bearer {tok}'}

if __name__ == '__main__':
    t = get_tokens(force=True)
    print('cached tokens for:', [k for k in t if not k.startswith('_')])
