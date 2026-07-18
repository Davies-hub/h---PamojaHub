"""Register-endpoint integration tests.

The atomicity test is the load-bearing assertion here — it pins down that a User
failure inside POST /api/v1/auth/register/ rolls back the Church that was just
inserted, so no orphan church rows survive a half-failed registration.
"""

from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from churches.models import Church, ChurchStatus


VALID_PAYLOAD = {
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

# Only the fields that STAY required after the optional-fields change — no county,
# no first/last name (B3: only the church name is collected at registration).
MINIMAL_PAYLOAD = {
    'name': 'Minimal Church',
    'official_email': 'minimal@example.org',
    'phone': '254700000002',
    'address': '1 Test Road',
    'denomination': 'ACK',
    'password': 'Sup3rL0ngPass!word',
}


class RegisterEndpointTest(TestCase):
    def setUp(self):
        # Register is now 3/h per IP (block=True → 429). LocMemCache is process-global
        # and Django does NOT reset it between tests, so consecutive register POSTs from
        # 127.0.0.1 accumulate into a 429. Clear it per test — the same isolation
        # test_auth_login / test_auth_me / test_email already use for this reason.
        cache.clear()
        self.client = APIClient()
        self.url = reverse('auth-register')

    def test_successful_registration_creates_one_church_and_one_user(self):
        response = self.client.post(self.url, VALID_PAYLOAD, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Church.objects.count(), 1)
        self.assertEqual(User.objects.count(), 1)

        church = Church.objects.get()
        user = User.objects.get()

        # Church is PENDING and the User is the Church Treasurer for that church.
        self.assertEqual(church.status, ChurchStatus.PENDING)
        self.assertEqual(user.role, UserRole.CHURCH_TREASURER)
        self.assertEqual(user.church_id, church.id)
        self.assertEqual(user.email, VALID_PAYLOAD['official_email'])

        # Response body shape: user + church_status
        self.assertIn('user', response.data)
        self.assertEqual(response.data['church_status'], ChurchStatus.PENDING)

    def test_register_without_county_or_names_succeeds(self):
        """B3 + county-optional: registering with ONLY church name, email, phone,
        address, denomination, password → 201; church PENDING with NULL county; user
        created with blank names. Response shape unchanged ({user, church_status})."""
        response = self.client.post(self.url, MINIMAL_PAYLOAD, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.content)
        church = Church.objects.get(official_email=MINIMAL_PAYLOAD['official_email'])
        user = User.objects.get(email=MINIMAL_PAYLOAD['official_email'])

        self.assertIsNone(church.county)            # absent county → NULL
        self.assertEqual(user.first_name, '')        # absent name → blank
        self.assertEqual(user.last_name, '')
        self.assertEqual(church.status, ChurchStatus.PENDING)
        self.assertEqual(user.role, UserRole.CHURCH_TREASURER)

        # Response shape is unchanged.
        self.assertIn('user', response.data)
        self.assertEqual(response.data['church_status'], ChurchStatus.PENDING)

    def test_register_normalizes_phone_to_254(self):
        """Phone-normalization fix (contract-trace item): register must store the
        bare 254… form, like the rest of the system — NOT the raw 0712… input."""
        payload = {**MINIMAL_PAYLOAD, 'official_email': 'phone-norm@example.org', 'phone': '0712345678'}
        response = self.client.post(self.url, payload, format='json')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.content)
        church = Church.objects.get(official_email='phone-norm@example.org')
        self.assertEqual(church.phone, '254712345678')

    def test_browse_churches_tolerates_null_county(self):
        """A church registered without a county (NULL) must not break the public
        browse list or its serializer — county is exposed there."""
        Church.objects.create(
            name='NoCounty Church', official_email='nc@example.org',
            phone='254700000003', address='x', county=None, denomination='SDA',
            status=ChurchStatus.ACTIVE,
        )
        resp = self.client.get('/api/v1/churches/')
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        rows = {c['name']: c for c in resp.data['results']}
        self.assertIn('NoCounty Church', rows)
        self.assertIsNone(rows['NoCounty Church']['county'])  # serialized as null, no crash

    def test_atomicity_user_creation_failure_rolls_back_church(self):
        """If User.objects.create_user raises mid-transaction, the Church row inserted
        moments earlier must roll back. Asserts the atomic boundary, not the error
        message — the failure mode is irrelevant; the rollback is what matters.
        """
        churches_before = Church.objects.count()
        users_before = User.objects.count()

        # Force the User insert to blow up AFTER the Church was created in the same
        # transaction. The atomic block must roll back both.
        with patch(
            'accounts.views.User.objects.create_user',
            side_effect=RuntimeError('simulated user-creation failure'),
        ):
            with self.assertRaises(RuntimeError):
                self.client.post(self.url, VALID_PAYLOAD, format='json')

        self.assertEqual(
            Church.objects.count(), churches_before,
            "Orphan Church row survived a failed registration — transaction.atomic() rollback broken.",
        )
        self.assertEqual(User.objects.count(), users_before)

    def test_duplicate_church_email_returns_400(self):
        """A second register with the same official_email after a successful first
        register: the User branch of validate_official_email fires (because the first
        registration also created a User with that email). Either branch returns 400.
        """
        # First registration succeeds.
        first = self.client.post(self.url, VALID_PAYLOAD, format='json')
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)

        churches_after_first = Church.objects.count()
        users_after_first = User.objects.count()

        # Second registration with the same official_email — serializer rejects.
        second = self.client.post(self.url, VALID_PAYLOAD, format='json')
        self.assertEqual(second.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('official_email', second.data)

        # No extra rows.
        self.assertEqual(Church.objects.count(), churches_after_first)
        self.assertEqual(User.objects.count(), users_after_first)

    def test_duplicate_user_email_rolls_back_and_returns_400(self):
        """The realistic failure mode: a User exists with this email but NO matching
        Church (e.g. a Super Admin account with that email). Pre-Fix 1 this passed
        serializer validation, created the Church, then crashed at User.create_user
        with IntegrityError → 500 to the client. Now: serializer's User check fires,
        no Church is created, response is a clean 400.
        """
        # Pre-create a User with the same email but no matching Church.
        existing_email = VALID_PAYLOAD['official_email']
        User.objects.create_user(
            email=existing_email,
            password='SomeOtherL0ngPass!word',
            first_name='Pre',
            last_name='Existing',
            role=UserRole.SUPER_ADMIN,
            church=None,
        )
        churches_before = Church.objects.count()
        users_before = User.objects.count()

        response = self.client.post(self.url, VALID_PAYLOAD, format='json')

        # Clean 400, NOT 500 — this is the bug Fix 1 + Fix 2 close.
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        # No orphan church — the existence check fires before the atomic block.
        self.assertEqual(Church.objects.count(), churches_before)
        # No new user either — the pre-existing one is untouched.
        self.assertEqual(User.objects.count(), users_before)

        # Response surfaces an email-collision message (either as a field error from
        # the serializer OR as a top-level detail from the IntegrityError catch).
        body_blob = str(response.data).lower()
        self.assertIn('email', body_blob)
        self.assertIn('already exists', body_blob)
