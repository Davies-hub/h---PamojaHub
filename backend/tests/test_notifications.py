"""Slice 1 — notifications read API: list / unread-count / mark-read / mark-all-read.

The headline guards mirror the live round-trip that GATES this slice:
  * RECIPIENT SCOPE — list and unread-count return ONLY the caller's own rows; a
    second user's notifications are never reachable.
  * NO EXISTENCE LEAK — mark-read on a foreign (or nonexistent) id is 404, not 403.
  * MARK-READ — flips is_read True (idempotent), returns the serialized row.
  * MARK-ALL — bulk-flips the caller's unread only, returns {"updated": N}, and does
    NOT touch another user's unread rows.
"""

from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from churches.models import Church, ChurchStatus
from notifications.models import Notification, NotificationType


def _make_church(name='Church', email='c@example.org'):
    return Church.objects.create(
        name=name, official_email=email, phone='254700000001',
        address='addr', county='Nairobi', denomination='PCEA',
        status=ChurchStatus.ACTIVE,
    )


def _make_treasurer(church, email='t@example.org'):
    return User.objects.create_user(
        email=email, password='unused', first_name='F', last_name='L',
        role=UserRole.CHURCH_TREASURER, church=church,
    )


def _notif(recipient, *, is_read=False,
           ntype=NotificationType.SUBSCRIPTION_REMINDER, title='t'):
    return Notification.objects.create(
        recipient=recipient, notification_type=ntype,
        title=title, message='m', is_read=is_read,
    )


class NotificationReadApiTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.church = _make_church()
        cls.me = _make_treasurer(cls.church, email='me@example.org')
        cls.other = _make_treasurer(cls.church, email='other@example.org')
        # caller: 2 unread + 1 read
        cls.mine_unread_1 = _notif(cls.me, is_read=False)
        cls.mine_unread_2 = _notif(cls.me, is_read=False,
                                   ntype=NotificationType.SUBSCRIPTION_LAPSED)
        cls.mine_read = _notif(cls.me, is_read=True)
        # other user: 1 unread (must never appear / never be mutated)
        cls.foreign = _notif(cls.other, is_read=False)

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.me)

    # ── list ──────────────────────────────────────────────────────────────────

    def test_list_returns_only_callers_rows(self):
        resp = self.client.get(reverse('notification-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['count'], 3)  # mine only, not the foreign row
        ids = {row['id'] for row in resp.data['results']}
        self.assertEqual(
            ids,
            {str(self.mine_unread_1.id), str(self.mine_unread_2.id), str(self.mine_read.id)},
        )
        self.assertNotIn(str(self.foreign.id), ids)

    def test_list_requires_auth(self):
        self.client.force_authenticate(user=None)
        resp = self.client.get(reverse('notification-list'))
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    # ── unread-count ────────────────────────────────────────────────────────────

    def test_unread_count_is_caller_scoped(self):
        resp = self.client.get(reverse('notification-unread-count'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, {'count': 2})  # the 2 unread mine; foreign excluded

    # ── mark single read ────────────────────────────────────────────────────────

    def test_mark_read_flips_is_read_and_returns_row(self):
        resp = self.client.post(
            reverse('notification-read', args=[self.mine_unread_1.id])
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertTrue(resp.data['is_read'])
        self.assertEqual(resp.data['id'], str(self.mine_unread_1.id))
        self.mine_unread_1.refresh_from_db()
        self.assertTrue(self.mine_unread_1.is_read)
        # unread count drops by exactly one
        uc = self.client.get(reverse('notification-unread-count'))
        self.assertEqual(uc.data, {'count': 1})

    def test_mark_read_is_idempotent(self):
        # already-read row still returns 200, stays read
        resp = self.client.post(
            reverse('notification-read', args=[self.mine_read.id])
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertTrue(resp.data['is_read'])

    def test_mark_read_foreign_id_is_404_not_403(self):
        resp = self.client.post(
            reverse('notification-read', args=[self.foreign.id])
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        # the foreign row was NOT mutated
        self.foreign.refresh_from_db()
        self.assertFalse(self.foreign.is_read)

    def test_mark_read_nonexistent_id_is_404(self):
        import uuid
        resp = self.client.post(
            reverse('notification-read', args=[uuid.uuid4()])
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    # ── mark all read ───────────────────────────────────────────────────────────

    def test_mark_all_read_bulk_flips_and_reports_count(self):
        resp = self.client.post(reverse('notification-read-all'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data, {'updated': 2})  # only the 2 unread mine
        # caller now has zero unread
        uc = self.client.get(reverse('notification-unread-count'))
        self.assertEqual(uc.data, {'count': 0})
        # the OTHER user's unread row is untouched
        self.foreign.refresh_from_db()
        self.assertFalse(self.foreign.is_read)

    def test_mark_all_read_again_reports_zero(self):
        self.client.post(reverse('notification-read-all'))
        resp = self.client.post(reverse('notification-read-all'))
        self.assertEqual(resp.data, {'updated': 0})
