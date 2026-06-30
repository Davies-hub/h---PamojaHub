"""GET /auth/me/ — session-restore endpoint.

Invariants:
  * Returns the authenticated user (from the JWT), shape identical to login's user
    payload (so the frontend's mapUser works for both).
  * No token → 401.
  * SECURITY: the user is derived from the token ONLY. The view has no id/user input,
    so a client-supplied id cannot make it return someone else's record, and two
    different tokens never cross-leak.
"""

from django.core.cache import cache
from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from churches.models import ChurchStatus


def _register_payload(slug):
    return {
        'name': f'{slug} Church',
        'official_email': f'{slug}@example.org',
        'phone': '254700000001',
        'address': '123 Test Road, Nairobi',
        'county': 'Nairobi',
        'denomination': 'PCEA',
        'first_name': slug.capitalize(),
        'last_name': 'Treasurer',
        'password': 'Sup3rL0ngPass!word',
    }


class AuthMeTest(TestCase):
    def setUp(self):
        cache.clear()  # login is 5/15m-per-IP; clear so consecutive logins don't 429
        self.client = APIClient()
        self.register_url = reverse('auth-register')
        self.login_url = reverse('auth-login')
        self.me_url = reverse('auth-me')

        # Two distinct users (distinct churches), each PENDING from register.
        self.payload_a = _register_payload('alice')
        self.payload_b = _register_payload('bob')
        assert self.client.post(self.register_url, self.payload_a, format='json').status_code == 201
        assert self.client.post(self.register_url, self.payload_b, format='json').status_code == 201

    def _login(self, payload):
        resp = self.client.post(
            self.login_url,
            {'email': payload['official_email'], 'password': payload['password']},
            format='json',
        )
        assert resp.status_code == status.HTTP_200_OK, resp.content
        return resp.data

    def _auth(self, access):
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')
        return c

    # ── 200 / shape ────────────────────────────────────────────────────────────

    def test_me_with_valid_token_returns_that_users_data(self):
        login = self._login(self.payload_a)
        c = self._auth(login['access'])

        resp = c.get(self.me_url)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['user']['email'], self.payload_a['official_email'])
        self.assertEqual(resp.data['user']['first_name'], self.payload_a['first_name'])
        self.assertEqual(resp.data['user']['role'], 'CHURCH_TREASURER')
        # church_status delivered the SAME way as login (PENDING from register).
        self.assertEqual(resp.data['church_status'], ChurchStatus.PENDING)

    def test_me_shape_matches_login_user_payload(self):
        login = self._login(self.payload_a)
        c = self._auth(login['access'])
        me = c.get(self.me_url).data
        # Same user object + same church_status key as the login response.
        self.assertEqual(me['user'], login['user'])
        self.assertEqual(me['church_status'], login['church_status'])
        # Never leaks credentials/flags.
        for forbidden in ('password', 'is_superuser', 'is_staff'):
            self.assertNotIn(forbidden, me['user'])

    # ── 401 ──────────────────────────────────────────────────────────────────────

    def test_me_without_token_returns_401_not_200_with_null(self):
        resp = self.client.get(self.me_url)  # no credentials
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_me_with_garbage_token_returns_401(self):
        c = self._auth('not-a-real-jwt')
        resp = c.get(self.me_url)
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    # ── SECURITY: token is the only identity source ──────────────────────────────

    def test_me_ignores_client_supplied_id(self):
        """A malicious client passing ?id=<other user> must STILL get the token's
        user. (The view has no id param; this proves the param is inert.)"""
        login_a = self._login(self.payload_a)
        login_b_user_id = self._login(self.payload_b)['user']['id']
        c = self._auth(login_a['access'])

        # Try several shapes a client might attempt to smuggle another id through.
        for qs in (f'?id={login_b_user_id}', f'?user={login_b_user_id}', f'?user_id={login_b_user_id}'):
            resp = c.get(self.me_url + qs)
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
            self.assertEqual(resp.data['user']['id'], login_a['user']['id'])
            self.assertNotEqual(resp.data['user']['id'], login_b_user_id)

    def test_me_no_cross_leak_between_two_tokens(self):
        login_a = self._login(self.payload_a)
        login_b = self._login(self.payload_b)

        me_a = self._auth(login_a['access']).get(self.me_url).data
        me_b = self._auth(login_b['access']).get(self.me_url).data

        self.assertEqual(me_a['user']['email'], self.payload_a['official_email'])
        self.assertEqual(me_b['user']['email'], self.payload_b['official_email'])
        self.assertNotEqual(me_a['user']['id'], me_b['user']['id'])
