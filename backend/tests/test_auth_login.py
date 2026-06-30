"""Login + token round-trip tests.

These exercise the full lifecycle: register → login → refresh → logout. Key invariants:
  * Refresh tokens are persisted only as hashes (plaintext never leaves the response).
  * Token refresh rotates: old row revoked, new row created.
  * Logout revokes; subsequent refresh on that token → 401.
  * Failed login emits a generic 401 message (no email enumeration).
"""

from django.core.cache import cache
from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import RefreshToken
from accounts.utils import hash_token
from churches.models import ChurchStatus


REGISTER_PAYLOAD = {
    'name': 'PCEA Test Church',
    'official_email': 'pcea-test@example.org',
    'phone': '254700000001',
    'address': '123 Test Road, Nairobi',
    'county': 'Nairobi',
    'denomination': 'PCEA',
    'first_name': 'Test',
    'last_name': 'Treasurer',
    'password': 'Sup3rL0ngPass!word',
}


class LoginTokenLifecycleTest(TestCase):
    def setUp(self):
        # Clear the django-ratelimit cache between tests so login's 5/15m-per-IP
        # limit doesn't trip when several tests in this class run consecutively
        # from the same test client IP (127.0.0.1). Rate-limit behaviour gets its
        # own dedicated test in a later step — these tests exercise the auth
        # lifecycle, not the limiter.
        cache.clear()

        self.client = APIClient()
        self.register_url = reverse('auth-register')
        self.login_url = reverse('auth-login')
        self.refresh_url = reverse('auth-token-refresh')
        self.logout_url = reverse('auth-logout')

        # Register once so login has a real user to authenticate.
        resp = self.client.post(self.register_url, REGISTER_PAYLOAD, format='json')
        assert resp.status_code == status.HTTP_201_CREATED, resp.content

    # ────────────────────────────────────────────────────────────────────────

    def test_login_with_correct_credentials_returns_tokens_and_church_status(self):
        resp = self.client.post(
            self.login_url,
            {'email': REGISTER_PAYLOAD['official_email'], 'password': REGISTER_PAYLOAD['password']},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn('access', resp.data)
        self.assertIn('refresh', resp.data)
        self.assertIn('user', resp.data)
        # Church created via register is PENDING — login allowed; frontend branches.
        self.assertEqual(resp.data['church_status'], ChurchStatus.PENDING)

    def test_login_with_wrong_password_returns_generic_401(self):
        resp = self.client.post(
            self.login_url,
            {'email': REGISTER_PAYLOAD['official_email'], 'password': 'WrongPassword!'},
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)
        # Generic message — does not reveal whether the email exists.
        self.assertEqual(resp.data, {'detail': 'Invalid email or password.'})
        self.assertNotIn('access', resp.data)
        self.assertNotIn('refresh', resp.data)

    def test_login_persists_only_hashed_refresh_token(self):
        resp = self.client.post(
            self.login_url,
            {'email': REGISTER_PAYLOAD['official_email'], 'password': REGISTER_PAYLOAD['password']},
            format='json',
        )
        raw_refresh = resp.data['refresh']
        self.assertTrue(raw_refresh)

        # The stored row's token_hash MUST be the hash, not the plaintext.
        rows = list(RefreshToken.objects.all())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].token_hash, hash_token(raw_refresh))

        # Defensive: no stored token_hash equals the plaintext (would mean we
        # accidentally stored the raw refresh token).
        for row in rows:
            self.assertNotEqual(row.token_hash, raw_refresh)

    def test_token_refresh_rotates_old_row_revoked_new_row_created(self):
        login = self.client.post(
            self.login_url,
            {'email': REGISTER_PAYLOAD['official_email'], 'password': REGISTER_PAYLOAD['password']},
            format='json',
        )
        old_refresh = login.data['refresh']
        old_hash = hash_token(old_refresh)
        self.assertTrue(RefreshToken.objects.filter(token_hash=old_hash, is_revoked=False).exists())

        refresh_resp = self.client.post(self.refresh_url, {'refresh': old_refresh}, format='json')
        self.assertEqual(refresh_resp.status_code, status.HTTP_200_OK)
        self.assertIn('access', refresh_resp.data)
        self.assertIn('refresh', refresh_resp.data)

        new_refresh = refresh_resp.data['refresh']
        self.assertNotEqual(new_refresh, old_refresh)

        # Old row is now revoked.
        old_row = RefreshToken.objects.get(token_hash=old_hash)
        self.assertTrue(old_row.is_revoked)
        # A new row exists for the rotated token.
        self.assertTrue(
            RefreshToken.objects.filter(token_hash=hash_token(new_refresh), is_revoked=False).exists()
        )

    def test_logout_revokes_refresh_token_and_subsequent_refresh_returns_401(self):
        login = self.client.post(
            self.login_url,
            {'email': REGISTER_PAYLOAD['official_email'], 'password': REGISTER_PAYLOAD['password']},
            format='json',
        )
        access = login.data['access']
        refresh = login.data['refresh']

        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')
        logout_resp = self.client.post(self.logout_url, {'refresh': refresh}, format='json')
        self.assertEqual(logout_resp.status_code, status.HTTP_200_OK)

        # Row is now revoked.
        row = RefreshToken.objects.get(token_hash=hash_token(refresh))
        self.assertTrue(row.is_revoked)

        # Subsequent refresh with that token → 401.
        self.client.credentials()  # clear auth
        refresh_resp = self.client.post(self.refresh_url, {'refresh': refresh}, format='json')
        self.assertEqual(refresh_resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_protected_endpoint_requires_auth(self):
        """Smoke test using logout as the protected endpoint (IsAuthenticated)."""
        # Without auth → 401.
        resp = self.client.post(self.logout_url, {}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

        # With a valid access token → 200 (no refresh in body; that's fine — logout
        # always returns 200 to avoid leaking whether a token existed).
        login = self.client.post(
            self.login_url,
            {'email': REGISTER_PAYLOAD['official_email'], 'password': REGISTER_PAYLOAD['password']},
            format='json',
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {login.data['access']}")
        ok = self.client.post(self.logout_url, {}, format='json')
        self.assertEqual(ok.status_code, status.HTTP_200_OK)
