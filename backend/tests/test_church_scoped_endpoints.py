"""Step 2.9a multi-tenant integration tests for church-scoped endpoints.

This test file is the linchpin of 2.9a. It proves the get_queryset() half of
multi-tenant isolation that the permission-class unit tests (tests/test_permissions.py)
structurally cannot:

  * Permission class only fires on detail/edit (has_object_permission) — it does
    NOT fire on LIST endpoints. So a list endpoint with a missing church filter
    would silently leak every other church's data, and unit tests of the
    permission class would not catch it.

  * This suite drives the LIVE API routes (APIClient + force_authenticate), as
    a treasurer for Church B, against Church A's data — and asserts that every
    list endpoint returns ZERO of A's records, and every detail/action endpoint
    against A's objects returns 403 or 404.

Coverage matrix:
  1. List-leakage probes (the queryset filter test):
       - GET /campaigns/mine/                  → zero of A's campaigns
       - GET /group-labels/                    → zero of A's labels
       - GET /churches/me/stats/                → numbers reflect B only
  2. Detail/action cross-church denial (the permission-class test):
       - GET /campaigns/mine/{A-slug}/, PATCH same
       - POST pause/resume/close on A's campaign
       - POST /campaigns/{A-slug}/updates/
       - GET/PATCH/POST archive/unarchive /group-labels/{A-id}/
  3. Own-church positive control
  4. SUSPENDED-church enforcement on state-changing actions
  5. Slug collision (deferred from Step 2.5)
  6. goal-below-raised rejection
  7. treasurer_phone change → AuditLog + Notification
  8. Group-label archive guard (active campaigns block archive)
  9. CLOSED rejects all edits
 10. Public list filter (PAUSED/CLOSED + PENDING/SUSPENDED-church campaigns excluded)
"""

import csv
import io
from datetime import datetime, timezone as dt_timezone
from decimal import Decimal

from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User, UserRole
from audit.models import AuditLog
from campaigns.models import (
    Campaign,
    CampaignCategory,
    CampaignStatus,
    CampaignUpdate,
    GroupLabel,
)
from churches.models import Church, ChurchStatus
from donations.models import Donation, DonationStatus
from notifications.models import Notification, NotificationType


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────


def _make_church(name='Church X', email='x@example.org', status_=ChurchStatus.ACTIVE):
    return Church.objects.create(
        name=name,
        official_email=email,
        phone='254700000001',
        address='addr',
        county='Nairobi',
        denomination='PCEA',
        status=status_,
    )


def _make_treasurer(church, email):
    return User.objects.create_user(
        email=email,
        password='UnusedForTest!',
        first_name='F',
        last_name='L',
        role=UserRole.CHURCH_TREASURER,
        church=church,
    )


def _make_campaign(church, treasurer, *, slug, title=None, status_=CampaignStatus.ACTIVE,
                   raised=Decimal('0'), wallet=Decimal('0'),
                   treasurer_phone='254712345678', treasurer_name='Treas Urer',
                   group_label=None):
    return Campaign.objects.create(
        slug=slug,
        church=church,
        title=title or f'Campaign {slug}',
        description='desc',
        goal_amount=Decimal('100000'),
        raised_amount=raised,
        wallet_balance=wallet,
        banner_image_url='https://example.org/x.png',
        category=CampaignCategory.BUILDING,
        treasurer_phone=treasurer_phone,
        treasurer_name=treasurer_name,
        created_by=treasurer,
        status=status_,
        group_label=group_label,
    )


class BaseTwoChurchSetUp(TestCase):
    """Shared two-church fixture used by every test class."""

    @classmethod
    def setUpTestData(cls):
        cls.church_a = _make_church(name='Church A', email='a@example.org')
        cls.church_b = _make_church(name='Church B', email='b@example.org')
        cls.treasurer_a = _make_treasurer(cls.church_a, 'ta@example.org')
        cls.treasurer_b = _make_treasurer(cls.church_b, 'tb@example.org')

        # Group labels for each church
        cls.label_a = GroupLabel.objects.create(church=cls.church_a, name='Mission A')
        cls.label_b = GroupLabel.objects.create(church=cls.church_b, name='Mission B')

        # Campaigns for Church A in various statuses
        cls.camp_a_active = _make_campaign(cls.church_a, cls.treasurer_a, slug='a-active',
                                           status_=CampaignStatus.ACTIVE,
                                           raised=Decimal('10000'), wallet=Decimal('5000'),
                                           group_label=cls.label_a)
        cls.camp_a_paused = _make_campaign(cls.church_a, cls.treasurer_a, slug='a-paused',
                                           status_=CampaignStatus.PAUSED)
        cls.camp_a_closed = _make_campaign(cls.church_a, cls.treasurer_a, slug='a-closed',
                                           status_=CampaignStatus.CLOSED)

        # One campaign for Church B (positive control + cross-church target)
        cls.camp_b_active = _make_campaign(cls.church_b, cls.treasurer_b, slug='b-active',
                                           status_=CampaignStatus.ACTIVE,
                                           raised=Decimal('500'), wallet=Decimal('500'))

    def setUp(self):
        self.client = APIClient()


# ═════════════════════════════════════════════════════════════════════════════
# 1. List-leakage probes — every list endpoint as treasurer B
# ═════════════════════════════════════════════════════════════════════════════


class ListLeakageProbes(BaseTwoChurchSetUp):
    """Authenticate as Treasurer B; every list endpoint must contain ZERO of A's records."""

    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_b)

    def test_campaigns_mine_list_excludes_other_church(self):
        resp = self.client.get(reverse('campaign-mine-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        slugs = {item['slug'] for item in resp.data['results']}
        # B sees its own
        self.assertIn('b-active', slugs)
        # B sees ZERO of A's, regardless of status
        self.assertNotIn('a-active', slugs)
        self.assertNotIn('a-paused', slugs)
        self.assertNotIn('a-closed', slugs)

    def test_group_labels_list_excludes_other_church(self):
        resp = self.client.get(reverse('group-label-list-create'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = {item['id'] for item in resp.data['results']}
        self.assertIn(str(self.label_b.id), ids)
        self.assertNotIn(str(self.label_a.id), ids)

    def test_church_me_stats_numbers_reflect_only_own_church(self):
        # Church A has campaigns raising 10000 in total; Church B has 500. B must see 500.
        resp = self.client.get(reverse('church-me-stats'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # B's wallet/raised must NOT include A's data.
        self.assertEqual(Decimal(resp.data['total_raised']), Decimal('500'))
        # B has 1 ACTIVE campaign (b-active); not 1+3 = 4.
        self.assertEqual(resp.data['active_campaigns'], 1)


# ═════════════════════════════════════════════════════════════════════════════
# 2. Detail / action cross-church denial — every endpoint targeting A's object as B
# ═════════════════════════════════════════════════════════════════════════════


class CrossChurchDetailDenials(BaseTwoChurchSetUp):
    """Authenticated as B. Targeting A's objects must return 403/404 on every endpoint."""

    DENIED_CODES = (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND)

    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_b)

    def test_campaign_detail_get_on_a_denied(self):
        resp = self.client.get(reverse('campaign-mine-detail', args=['a-active']))
        self.assertIn(resp.status_code, self.DENIED_CODES)

    def test_campaign_patch_on_a_denied(self):
        resp = self.client.patch(
            reverse('campaign-mine-detail', args=['a-active']),
            {'title': 'Hijacked'}, format='json',
        )
        self.assertIn(resp.status_code, self.DENIED_CODES)
        self.camp_a_active.refresh_from_db()
        self.assertNotEqual(self.camp_a_active.title, 'Hijacked')

    def test_campaign_pause_on_a_denied(self):
        resp = self.client.post(reverse('campaign-pause', args=['a-active']))
        self.assertIn(resp.status_code, self.DENIED_CODES)
        self.camp_a_active.refresh_from_db()
        self.assertEqual(self.camp_a_active.status, CampaignStatus.ACTIVE)

    def test_campaign_resume_on_a_denied(self):
        resp = self.client.post(reverse('campaign-resume', args=['a-paused']))
        self.assertIn(resp.status_code, self.DENIED_CODES)
        self.camp_a_paused.refresh_from_db()
        self.assertEqual(self.camp_a_paused.status, CampaignStatus.PAUSED)

    def test_campaign_close_on_a_denied(self):
        resp = self.client.post(reverse('campaign-close', args=['a-active']))
        self.assertIn(resp.status_code, self.DENIED_CODES)
        self.camp_a_active.refresh_from_db()
        self.assertEqual(self.camp_a_active.status, CampaignStatus.ACTIVE)

    def test_campaign_post_update_on_a_denied(self):
        resp = self.client.post(
            reverse('campaign-updates', args=['a-active']),
            {'body': 'Hijacked update'}, format='json',
        )
        self.assertIn(resp.status_code, self.DENIED_CODES)
        self.assertEqual(CampaignUpdate.objects.filter(campaign=self.camp_a_active).count(), 0)

    def test_group_label_detail_get_on_a_denied(self):
        resp = self.client.get(reverse('group-label-detail', args=[self.label_a.id]))
        self.assertIn(resp.status_code, self.DENIED_CODES)

    def test_group_label_patch_on_a_denied(self):
        resp = self.client.patch(
            reverse('group-label-detail', args=[self.label_a.id]),
            {'name': 'Hijacked'}, format='json',
        )
        self.assertIn(resp.status_code, self.DENIED_CODES)
        self.label_a.refresh_from_db()
        self.assertEqual(self.label_a.name, 'Mission A')

    def test_group_label_archive_on_a_denied(self):
        resp = self.client.post(reverse('group-label-archive', args=[self.label_a.id]))
        self.assertIn(resp.status_code, self.DENIED_CODES)
        self.label_a.refresh_from_db()
        self.assertFalse(self.label_a.is_archived)

    def test_group_label_unarchive_on_a_denied(self):
        self.label_a.is_archived = True
        self.label_a.save(update_fields=['is_archived'])
        resp = self.client.post(reverse('group-label-unarchive', args=[self.label_a.id]))
        self.assertIn(resp.status_code, self.DENIED_CODES)
        self.label_a.refresh_from_db()
        self.assertTrue(self.label_a.is_archived)


# ═════════════════════════════════════════════════════════════════════════════
# 3. Own-church positive control — treasurer A reads/edits its own data fine
# ═════════════════════════════════════════════════════════════════════════════


class OwnChurchPositiveControl(BaseTwoChurchSetUp):
    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)

    def test_a_can_list_own_campaigns(self):
        resp = self.client.get(reverse('campaign-mine-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        slugs = {item['slug'] for item in resp.data['results']}
        self.assertEqual(slugs, {'a-active', 'a-paused', 'a-closed'})

    def test_a_can_view_own_campaign_detail(self):
        resp = self.client.get(reverse('campaign-mine-detail', args=['a-active']))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['slug'], 'a-active')

    def test_a_can_pause_own_campaign(self):
        resp = self.client.post(reverse('campaign-pause', args=['a-active']))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.camp_a_active.refresh_from_db()
        self.assertEqual(self.camp_a_active.status, CampaignStatus.PAUSED)

    def test_a_can_resume_own_paused_campaign(self):
        resp = self.client.post(reverse('campaign-resume', args=['a-paused']))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.camp_a_paused.refresh_from_db()
        self.assertEqual(self.camp_a_paused.status, CampaignStatus.ACTIVE)


# ═════════════════════════════════════════════════════════════════════════════
# 3b. Profile PATCH — phone normalization parity with registration
# ═════════════════════════════════════════════════════════════════════════════


class ChurchMeProfilePatchPhone(BaseTwoChurchSetUp):
    """PATCH /churches/me/ normalizes phone to 254XXXXXXXXX (parity with registration).

    Before this slice the profile PATCH stored the raw 0712… form while registration,
    campaigns, donations and B2C all used 254…. AdminChurchSerializer.validate_phone now
    runs the SAME shared validate_safaricom_phone helper.
    """

    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)

    def test_patch_normalizes_phone_07_to_254(self):
        resp = self.client.patch(reverse('church-me'), {'phone': '0712345678'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['phone'], '254712345678')
        self.church_a.refresh_from_db()
        self.assertEqual(self.church_a.phone, '254712345678')

    def test_patch_already_normalized_phone_unchanged(self):
        resp = self.client.patch(reverse('church-me'), {'phone': '254720111222'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['phone'], '254720111222')

    def test_patch_invalid_phone_returns_400_field_error(self):
        resp = self.client.patch(reverse('church-me'), {'phone': '12345'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('phone', resp.data)
        # The bad value is NOT persisted — DB keeps the fixture default.
        self.church_a.refresh_from_db()
        self.assertEqual(self.church_a.phone, '254700000001')

    def test_patch_omitting_phone_still_succeeds(self):
        # A partial PATCH that does NOT include phone must never trip validate_phone
        # (DRF only calls validate_<field> when the field is present).
        resp = self.client.patch(reverse('church-me'), {'name': 'Renamed Church'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['name'], 'Renamed Church')
        self.church_a.refresh_from_db()
        self.assertEqual(self.church_a.name, 'Renamed Church')
        self.assertEqual(self.church_a.phone, '254700000001')   # phone untouched


# ═════════════════════════════════════════════════════════════════════════════
# 4. SUSPENDED enforcement — reads OK, writes 403 on every state-changing action
# ═════════════════════════════════════════════════════════════════════════════


class SuspendedChurchEnforcement(BaseTwoChurchSetUp):
    def setUp(self):
        super().setUp()
        # Suspend Church A
        self.church_a.status = ChurchStatus.SUSPENDED
        self.church_a.save(update_fields=['status'])
        self.client.force_authenticate(user=self.treasurer_a)

    def test_reads_still_work_when_suspended(self):
        """Suspended church can still see its own data — just can't act on it."""
        resp = self.client.get(reverse('church-me'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        resp = self.client.get(reverse('campaign-mine-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        resp = self.client.get(reverse('group-label-list-create'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_create_campaign_rejected_when_suspended(self):
        resp = self.client.post(
            reverse('campaign-create'),
            {
                'title': 'New Drive',
                'description': 'desc',
                'goal_amount': '50000',
                'banner_image_url': 'https://example.org/x.png',
                'category': CampaignCategory.BUILDING,
                'treasurer_phone': '0712345678',
                'treasurer_name': 'T U',
            },
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIn('not active', resp.data['detail'].lower())

    def test_patch_campaign_rejected_when_suspended(self):
        resp = self.client.patch(
            reverse('campaign-mine-detail', args=['a-active']),
            {'title': 'Renamed'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_pause_rejected_when_suspended(self):
        resp = self.client.post(reverse('campaign-pause', args=['a-active']))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_post_update_rejected_when_suspended(self):
        resp = self.client.post(
            reverse('campaign-updates', args=['a-active']),
            {'body': 'update'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_create_group_label_rejected_when_suspended(self):
        resp = self.client.post(
            reverse('group-label-list-create'),
            {'name': 'New label'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_patch_church_me_rejected_when_suspended(self):
        resp = self.client.patch(reverse('church-me'), {'name': 'Renamed'}, format='json')
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


# ═════════════════════════════════════════════════════════════════════════════
# 5. Slug collision — two campaigns with the same title get unique slugs
# ═════════════════════════════════════════════════════════════════════════════


class SlugCollisionTest(BaseTwoChurchSetUp):
    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)

    def _create(self, title):
        return self.client.post(
            reverse('campaign-create'),
            {
                'title': title,
                'description': 'desc',
                'goal_amount': '50000',
                'banner_image_url': 'https://example.org/x.png',
                'category': CampaignCategory.BUILDING,
                'treasurer_phone': '0712345678',
                'treasurer_name': 'T U',
            },
            format='json',
        )

    def test_two_campaigns_with_same_title_get_distinct_slugs(self):
        r1 = self._create('Roof Fund')
        self.assertEqual(r1.status_code, status.HTTP_201_CREATED, r1.content)
        self.assertEqual(r1.data['slug'], 'roof-fund')

        r2 = self._create('Roof Fund')
        self.assertEqual(r2.status_code, status.HTTP_201_CREATED, r2.content)
        self.assertEqual(r2.data['slug'], 'roof-fund-2')

        # Both rows exist — no IntegrityError, no overwrite.
        self.assertEqual(Campaign.objects.filter(slug__startswith='roof-fund').count(), 2)


# ═════════════════════════════════════════════════════════════════════════════
# 5b. Create: banner_image_url optional + goal_amount clean min (PH4-04)
# ═════════════════════════════════════════════════════════════════════════════


class CampaignCreateBannerOptionalAndGoalMinTest(BaseTwoChurchSetUp):
    """PH4-04 wiring guards:

      * banner_image_url is now OPTIONAL on create (image upload is a later
        feature; the create form collects no URL). A create with no banner — or
        a blank banner — must 201 and persist a null/empty banner.
      * goal_amount <= 0 must be a CLEAN 400 {"goal_amount": [...]} from the
        serializer, NOT a DB-constraint IntegrityError that the slug-retry loop
        swallows into a 503.

    Server-forcing (church/status/raised/wallet) and the slug auto-gen are
    re-asserted here so a regression in the create path surfaces in this class.
    """

    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)

    def _payload(self, **overrides):
        base = {
            'title': 'Roofing Drive',
            'description': 'desc',
            'goal_amount': '50000',
            'category': CampaignCategory.BUILDING,
            'treasurer_phone': '0712345678',
            'treasurer_name': 'T U',
        }
        base.update(overrides)
        return base

    def test_create_without_banner_succeeds_and_persists(self):
        # NO banner_image_url key at all.
        resp = self.client.post(reverse('campaign-create'), self._payload(), format='json')
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        camp = Campaign.objects.get(slug=resp.data['slug'])
        # Server-forced fields (re-assert no regression).
        self.assertEqual(camp.church_id, self.church_a.id)
        self.assertEqual(camp.created_by_id, self.treasurer_a.id)
        self.assertEqual(camp.status, CampaignStatus.ACTIVE)
        self.assertEqual(camp.raised_amount, Decimal('0'))
        self.assertEqual(camp.wallet_balance, Decimal('0'))
        # Banner is null/empty, not a 400.
        self.assertIn(camp.banner_image_url, (None, ''))

    def test_create_with_blank_banner_succeeds(self):
        resp = self.client.post(
            reverse('campaign-create'), self._payload(banner_image_url=''), format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)

    def test_goal_amount_zero_returns_clean_400_not_503(self):
        # Valid banner so the ONLY rejectable field is goal_amount — this isolates
        # the goal-min path (pre-fix this hit the DB constraint → slug-retry → 503).
        resp = self.client.post(
            reverse('campaign-create'),
            self._payload(goal_amount='0', banner_image_url='https://example.org/b.png'),
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertIn('goal_amount', resp.data)
        self.assertFalse(Campaign.objects.filter(title='Roofing Drive').exists())

    def test_goal_amount_negative_returns_clean_400(self):
        resp = self.client.post(
            reverse('campaign-create'),
            self._payload(goal_amount='-5', banner_image_url='https://example.org/b.png'),
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertIn('goal_amount', resp.data)

    def test_full_valid_create_still_201(self):
        resp = self.client.post(
            reverse('campaign-create'),
            self._payload(
                banner_image_url='https://example.org/b.png',
                group_label=str(self.label_a.id),
            ),
            format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertEqual(resp.data['slug'], 'roofing-drive')
        camp = Campaign.objects.get(slug='roofing-drive')
        self.assertIsNone(camp.banner_image_url)  # client banner is now dropped (server-set-only); see tests/test_image_field_lock.py
        self.assertEqual(camp.group_label_id, self.label_a.id)


# ═════════════════════════════════════════════════════════════════════════════
# 6. goal-below-raised rejection
# ═════════════════════════════════════════════════════════════════════════════


class GoalBelowRaisedRejection(BaseTwoChurchSetUp):
    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)

    def test_lowering_goal_below_raised_returns_400(self):
        # camp_a_active has raised_amount=10000. Try to lower goal to 5000.
        resp = self.client.patch(
            reverse('campaign-mine-detail', args=['a-active']),
            {'goal_amount': '5000'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('cannot be set below', resp.data['detail'].lower())
        self.camp_a_active.refresh_from_db()
        self.assertEqual(self.camp_a_active.goal_amount, Decimal('100000'))

    def test_raising_goal_works(self):
        resp = self.client.patch(
            reverse('campaign-mine-detail', args=['a-active']),
            {'goal_amount': '200000'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        self.camp_a_active.refresh_from_db()
        self.assertEqual(self.camp_a_active.goal_amount, Decimal('200000'))


# ═════════════════════════════════════════════════════════════════════════════
# 7. treasurer_phone change → AuditLog + Notification side effects
# ═════════════════════════════════════════════════════════════════════════════


class TreasurerDestinationChangeSideEffects(BaseTwoChurchSetUp):
    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)

    def test_phone_change_writes_audit_log_and_notification(self):
        before_audit = AuditLog.objects.filter(
            action='CAMPAIGN_TREASURER_DESTINATION_CHANGED',
            entity_id=self.camp_a_active.id,
        ).count()
        before_notif = Notification.objects.filter(
            recipient=self.treasurer_a,
            notification_type=NotificationType.CAMPAIGN_DESTINATION_CHANGED,
            related_campaign=self.camp_a_active,
        ).count()

        resp = self.client.patch(
            reverse('campaign-mine-detail', args=['a-active']),
            {'treasurer_phone': '0700111222'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)

        after_audit = AuditLog.objects.filter(
            action='CAMPAIGN_TREASURER_DESTINATION_CHANGED',
            entity_id=self.camp_a_active.id,
        ).count()
        after_notif = Notification.objects.filter(
            recipient=self.treasurer_a,
            notification_type=NotificationType.CAMPAIGN_DESTINATION_CHANGED,
            related_campaign=self.camp_a_active,
        ).count()

        self.assertEqual(after_audit, before_audit + 1)
        self.assertEqual(after_notif, before_notif + 1)

        audit = AuditLog.objects.filter(
            action='CAMPAIGN_TREASURER_DESTINATION_CHANGED',
            entity_id=self.camp_a_active.id,
        ).latest('created_at')
        # PRD §12.10 — phones masked in AuditLog.details (all but last 3 digits).
        # Raw form is on the Campaign row; the audit carries the masked form for
        # forensic linking without unnecessary PII storage.
        self.assertEqual(audit.details['old_phone'], '*********678')
        self.assertEqual(audit.details['new_phone'], '*********222')
        # And the raw phones MUST NOT appear in the audit details.
        for v in audit.details.values():
            self.assertNotEqual(v, '254712345678')
            self.assertNotEqual(v, '254700111222')

    def test_unrelated_edit_does_not_emit_destination_change_audit(self):
        before = AuditLog.objects.filter(
            action='CAMPAIGN_TREASURER_DESTINATION_CHANGED',
            entity_id=self.camp_a_active.id,
        ).count()
        resp = self.client.patch(
            reverse('campaign-mine-detail', args=['a-active']),
            {'description': 'changed desc'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        after = AuditLog.objects.filter(
            action='CAMPAIGN_TREASURER_DESTINATION_CHANGED',
            entity_id=self.camp_a_active.id,
        ).count()
        self.assertEqual(after, before)


# ═════════════════════════════════════════════════════════════════════════════
# 8. Group-label archive guard — active campaigns block archive
# ═════════════════════════════════════════════════════════════════════════════


class GroupLabelArchiveGuard(BaseTwoChurchSetUp):
    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)

    def test_archive_blocked_when_active_campaign_uses_label(self):
        # camp_a_active references label_a via group_label.
        resp = self.client.post(reverse('group-label-archive', args=[self.label_a.id]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('active campaigns', resp.data['detail'].lower())
        self.label_a.refresh_from_db()
        self.assertFalse(self.label_a.is_archived)

    def test_archive_allowed_when_no_active_campaign_uses_label(self):
        empty_label = GroupLabel.objects.create(church=self.church_a, name='Unused')
        resp = self.client.post(reverse('group-label-archive', args=[empty_label.id]))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        empty_label.refresh_from_db()
        self.assertTrue(empty_label.is_archived)


# ═════════════════════════════════════════════════════════════════════════════
# 9. CLOSED rejects all edits
# ═════════════════════════════════════════════════════════════════════════════


class ClosedCampaignsRejectEdits(BaseTwoChurchSetUp):
    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)

    def test_patch_on_closed_returns_400(self):
        resp = self.client.patch(
            reverse('campaign-mine-detail', args=['a-closed']),
            {'title': 'Renamed'}, format='json',
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('closed campaigns', resp.data['detail'].lower())

    def test_pause_on_closed_returns_400(self):
        resp = self.client.post(reverse('campaign-pause', args=['a-closed']))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_resume_on_closed_returns_400(self):
        resp = self.client.post(reverse('campaign-resume', args=['a-closed']))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)


# ═════════════════════════════════════════════════════════════════════════════
# Stats Coalesce — zero-campaign church returns 0s, never null
# ═════════════════════════════════════════════════════════════════════════════


class StatsZeroCampaignsTest(TestCase):
    """A newly-approved (ACTIVE) church with no campaigns yet is the most common
    "fresh" state. Sum aggregations return None for empty querysets without
    Coalesce, which serializes to JSON null — frontends expect numbers.
    """

    @classmethod
    def setUpTestData(cls):
        cls.church = _make_church(name='Fresh Church', email='fresh@example.org',
                                  status_=ChurchStatus.ACTIVE)
        cls.treasurer = _make_treasurer(cls.church, 'tf@example.org')

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.treasurer)

    def test_stats_for_church_with_no_campaigns_returns_zeros(self):
        # Sanity: this church has no campaigns / withdrawals / donations.
        self.assertEqual(Campaign.objects.filter(church=self.church).count(), 0)

        resp = self.client.get(reverse('church-me-stats'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        # All fields must be present.
        for field in ('total_raised', 'wallet_balance', 'active_campaigns',
                      'pending_disbursements', 'recent_donations'):
            self.assertIn(field, resp.data)
            self.assertIsNotNone(resp.data[field], f'{field} is null (should be 0/[])')

        # Sum aggregations: numbers, not null. Compare via Decimal to be safe.
        self.assertEqual(Decimal(resp.data['total_raised']), Decimal('0'))
        self.assertEqual(Decimal(resp.data['wallet_balance']), Decimal('0'))
        # Counts: zero, not null.
        self.assertEqual(resp.data['active_campaigns'], 0)
        self.assertEqual(resp.data['pending_disbursements'], 0)
        # Empty donation list, not null.
        self.assertEqual(resp.data['recent_donations'], [])


# ═════════════════════════════════════════════════════════════════════════════
# 10. Public list filter — only ACTIVE campaigns of ACTIVE churches
# ═════════════════════════════════════════════════════════════════════════════


class PublicListFilterTest(BaseTwoChurchSetUp):
    def test_public_excludes_paused_closed_and_non_active_church_campaigns(self):
        # Mark Church B as PENDING and create an ACTIVE campaign for it — must not appear.
        pending_church = _make_church(name='Pending Church', email='p@example.org',
                                      status_=ChurchStatus.PENDING)
        pending_treas = _make_treasurer(pending_church, 'tp@example.org')
        _make_campaign(pending_church, pending_treas, slug='pending-campaign',
                       status_=CampaignStatus.ACTIVE)

        # Unauth public client
        resp = self.client.get(reverse('campaign-public-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        slugs = {item['slug'] for item in resp.data['results']}

        # ACTIVE campaigns of ACTIVE churches: a-active, b-active
        self.assertIn('a-active', slugs)
        self.assertIn('b-active', slugs)
        # PAUSED and CLOSED of ACTIVE churches excluded
        self.assertNotIn('a-paused', slugs)
        self.assertNotIn('a-closed', slugs)
        # ACTIVE campaign of PENDING church excluded
        self.assertNotIn('pending-campaign', slugs)

    def test_public_church_list_excludes_non_active_churches(self):
        _make_church(name='Pending Church', email='p2@example.org',
                     status_=ChurchStatus.PENDING)
        _make_church(name='Suspended Church', email='s@example.org',
                     status_=ChurchStatus.SUSPENDED)
        resp = self.client.get(reverse('church-public-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        names = {item['name'] for item in resp.data['results']}
        self.assertIn('Church A', names)
        self.assertIn('Church B', names)
        self.assertNotIn('Pending Church', names)
        self.assertNotIn('Suspended Church', names)


# ═════════════════════════════════════════════════════════════════════════════
# 11. Treasurer-dashboard read additions — group_label_name + campaign_title
# ═════════════════════════════════════════════════════════════════════════════


class TreasurerDashboardFieldAdditions(BaseTwoChurchSetUp):
    """Two read-only field additions for the treasurer dashboard:
      * AdminCampaignSerializer.group_label_name  (GET /campaigns/mine/)
      * PortalDonationReportSerializer.campaign_title (GET /churches/me/stats/ feed)
    Verifies each field appears, nothing existing was dropped, donor-privacy /
    Net-Everywhere stay intact, and the additions remain church-scoped.
    """

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        # A SUCCESSFUL donation to Church A's active campaign — appears in A's feed.
        cls.donation = Donation.objects.create(
            campaign=cls.camp_a_active,
            phone_number='254712345678',
            donor_name='Jane Tester',
            amount=Decimal('1000.00'),     # GROSS (what the donor sent)
            platform_fee=Decimal('25.00'),
            net_amount=Decimal('975.00'),  # NET (what the church keeps)
            status=DonationStatus.SUCCESSFUL,
            mpesa_receipt_number='QHX0TEST01',
        )

    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)

    def test_my_campaigns_include_group_label_name_without_dropping_fields(self):
        resp = self.client.get(reverse('campaign-mine-list'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        by_slug = {item['slug']: item for item in resp.data['results']}

        # WITH a label → the NAME is exposed; the FK id (group_label) is STILL there.
        active = by_slug['a-active']
        self.assertIn('group_label_name', active)
        self.assertEqual(active['group_label_name'], 'Mission A')
        self.assertEqual(str(active['group_label']), str(self.label_a.id))

        # WITHOUT a label → null name (and null id).
        paused = by_slug['a-paused']
        self.assertIn('group_label_name', paused)
        self.assertIsNone(paused['group_label_name'])
        self.assertIsNone(paused['group_label'])

        # Every existing __all__ field is STILL present (the addition dropped nothing).
        for f in ('id', 'slug', 'church', 'title', 'description', 'goal_amount',
                  'raised_amount', 'wallet_balance', 'status', 'banner_image_url',
                  'document_url', 'category', 'treasurer_phone', 'treasurer_name',
                  'created_by', 'created_at', 'closed_at'):
            self.assertIn(f, active, f'__all__ field {f} was dropped')

    def test_stats_recent_donations_include_campaign_title_privacy_intact(self):
        resp = self.client.get(reverse('church-me-stats'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        feed = resp.data['recent_donations']
        self.assertEqual(len(feed), 1)
        row = feed[0]

        # campaign_title present + correct.
        self.assertEqual(row['campaign_title'], self.camp_a_active.title)
        # amount is NET (975.00), never the gross 1000.00.
        self.assertEqual(Decimal(row['amount']), Decimal('975.00'))
        self.assertNotEqual(str(row['amount']), '1000.00')
        # Exactly the allowed keys — no gross/fee/phone/email leaked.
        self.assertEqual(
            set(row.keys()),
            {'mpesa_receipt_number', 'donor_name', 'amount', 'campaign_title', 'created_at'},
        )

    def test_stats_feed_with_campaign_title_stays_church_scoped(self):
        # Treasurer B (no donations) must NOT see Church A's donation via the feed.
        self.client.force_authenticate(user=self.treasurer_b)
        resp = self.client.get(reverse('church-me-stats'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['recent_donations'], [])


# ═════════════════════════════════════════════════════════════════════════════
# 12. Treasurer donation list — GET /churches/me/donations/ (reports source)
# ═════════════════════════════════════════════════════════════════════════════


class ChurchMeDonationsListTest(BaseTwoChurchSetUp):
    """GET /api/v1/churches/me/donations/ — the JWT church-scoped donation history
    that the treasurer Reports screen (Donation History) composes from.

    Same two-church fixture as the leak probes. Proves:
      * church-scoped (B never sees A's donations),
      * SUCCESSFUL-only (PENDING/FAILED excluded),
      * NET-only wire shape (no gross / platform_fee / phone / email),
      * date-INCLUSIVE `to` (a 23:30 donation on the to-date is returned),
      * malformed from/to → 400 (shared _parse_date_param), never 500,
      * role gate (anon + non-treasurer denied),
      * optional ?campaign= filter stays church-scoped.
    """

    # A fixed calendar day used by the date-inclusive probe. Distinct from the
    # auto_now_add "today" of the other donations, so a from=to filter on this day
    # isolates exactly the late-evening row.
    DATED_DAY = datetime(2026, 6, 1, 23, 30, 0, tzinfo=dt_timezone.utc)

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()

        # ── Church A: two SUCCESSFUL (one stamped 23:30 on DATED_DAY), one PENDING,
        #    one FAILED. Only the two SUCCESSFUL rows may surface. ──
        cls.don_a_success = Donation.objects.create(
            campaign=cls.camp_a_active,
            phone_number='254712345678',
            donor_email='jane@example.org',
            donor_name='Jane A',
            amount=Decimal('1000.00'),      # GROSS — must NEVER reach the wire
            platform_fee=Decimal('25.00'),  # fee — must NEVER reach the wire
            net_amount=Decimal('975.00'),   # NET — the church-facing `amount`
            status=DonationStatus.SUCCESSFUL,
            mpesa_receipt_number='QHX0DON001',
        )
        cls.don_a_dated = Donation.objects.create(
            campaign=cls.camp_a_active,
            phone_number='254712345678',
            donor_name='Dated A',
            amount=Decimal('600.00'),
            platform_fee=Decimal('15.00'),
            net_amount=Decimal('585.00'),
            status=DonationStatus.SUCCESSFUL,
            mpesa_receipt_number='QHX0DON002',
        )
        # created_at is auto_now_add → bypass it via .update() to plant the 23:30 stamp.
        Donation.objects.filter(id=cls.don_a_dated.id).update(created_at=cls.DATED_DAY)

        cls.don_a_pending = Donation.objects.create(
            campaign=cls.camp_a_active,
            phone_number='254712345678',
            amount=Decimal('300.00'),
            status=DonationStatus.PENDING,   # excluded — no money kept
            mpesa_receipt_number='QHX0PEND01',
        )
        cls.don_a_failed = Donation.objects.create(
            campaign=cls.camp_a_active,
            phone_number='254712345678',
            amount=Decimal('400.00'),
            status=DonationStatus.FAILED,    # excluded
            mpesa_receipt_number='QHX0FAIL01',
        )

        # ── Church B: one SUCCESSFUL donation (cross-church control). ──
        cls.don_b_success = Donation.objects.create(
            campaign=cls.camp_b_active,
            phone_number='254700000009',
            donor_name='Bob B',
            amount=Decimal('100.00'),
            platform_fee=Decimal('2.50'),
            net_amount=Decimal('97.50'),
            status=DonationStatus.SUCCESSFUL,
            mpesa_receipt_number='QHX0DONB01',
        )

    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)

    def _receipts(self, resp):
        return {row['mpesa_receipt_number'] for row in resp.data['results']}

    def test_lists_only_own_church_successful_donations(self):
        resp = self.client.get(reverse('church-me-donations'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        receipts = self._receipts(resp)
        # A's two SUCCESSFUL rows present.
        self.assertIn('QHX0DON001', receipts)
        self.assertIn('QHX0DON002', receipts)
        # B's donation is NEVER visible to A (leak probe).
        self.assertNotIn('QHX0DONB01', receipts)

    def test_excludes_pending_and_failed(self):
        resp = self.client.get(reverse('church-me-donations'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        receipts = self._receipts(resp)
        self.assertNotIn('QHX0PEND01', receipts)
        self.assertNotIn('QHX0FAIL01', receipts)
        # Exactly the two SUCCESSFUL rows of Church A.
        self.assertEqual(len(resp.data['results']), 2)

    def test_cross_church_treasurer_sees_only_own(self):
        # Treasurer B must see ONLY B's donation, zero of A's.
        self.client.force_authenticate(user=self.treasurer_b)
        resp = self.client.get(reverse('church-me-donations'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        receipts = self._receipts(resp)
        self.assertEqual(receipts, {'QHX0DONB01'})

    def test_row_shape_is_net_only(self):
        resp = self.client.get(reverse('church-me-donations'))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        row = next(r for r in resp.data['results'] if r['mpesa_receipt_number'] == 'QHX0DON001')
        # Exactly the allowlist keys — nothing more.
        self.assertEqual(
            set(row.keys()),
            {'mpesa_receipt_number', 'donor_name', 'amount', 'campaign_title', 'created_at'},
        )
        # amount is NET (975.00), never the gross 1000.00.
        self.assertEqual(Decimal(row['amount']), Decimal('975.00'))
        self.assertNotEqual(str(row['amount']), '1000.00')
        # Donor-private + gross/fee fields must be wholly absent from the row.
        for forbidden in ('platform_fee', 'net_amount', 'phone_number',
                          'donor_email', 'checkout_request_id'):
            self.assertNotIn(forbidden, row)
        # campaign_title labels the gift.
        self.assertEqual(row['campaign_title'], self.camp_a_active.title)

    def test_date_to_is_inclusive_of_2330_on_to_date(self):
        # from=to=DATED_DAY → only the 23:30 row, proving __date__lte (inclusive),
        # not a midnight-start __lte that would silently drop it.
        resp = self.client.get(
            reverse('church-me-donations'), {'from': '2026-06-01', 'to': '2026-06-01'}
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.content)
        receipts = self._receipts(resp)
        self.assertEqual(receipts, {'QHX0DON002'})

    def test_bad_to_param_returns_400_not_500(self):
        resp = self.client.get(reverse('church-me-donations'), {'to': 'notadate'})
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertIn('to', resp.data)

    def test_bad_from_param_returns_400_not_500(self):
        resp = self.client.get(reverse('church-me-donations'), {'from': '2026-13-99'})
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertIn('from', resp.data)

    def test_campaign_filter_stays_church_scoped(self):
        # Filtering by A's own campaign returns its rows…
        resp = self.client.get(
            reverse('church-me-donations'), {'campaign': str(self.camp_a_active.id)}
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(self._receipts(resp), {'QHX0DON001', 'QHX0DON002'})
        # …while filtering by B's campaign id (cross-church) yields nothing — the
        # church scope still applies on top of the campaign filter.
        resp = self.client.get(
            reverse('church-me-donations'), {'campaign': str(self.camp_b_active.id)}
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data['results'], [])

    def test_anonymous_denied(self):
        self.client.force_authenticate(user=None)
        resp = self.client.get(reverse('church-me-donations'))
        self.assertIn(resp.status_code,
                      (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))

    def test_non_treasurer_super_admin_denied(self):
        super_admin = User.objects.create_user(
            email='super-donlist@example.org',
            password='UnusedForTest!',
            first_name='S', last_name='A',
            role=UserRole.SUPER_ADMIN,
        )
        self.client.force_authenticate(user=super_admin)
        resp = self.client.get(reverse('church-me-donations'))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


# ═════════════════════════════════════════════════════════════════════════════
# 13. Treasurer donation CSV export — GET /churches/me/donations/export/?format=csv
# ═════════════════════════════════════════════════════════════════════════════


class ChurchMeDonationsCsvExportTest(BaseTwoChurchSetUp):
    """GET /api/v1/churches/me/donations/export/?format=csv — full, un-paginated,
    NET-only CSV of this church's SUCCESSFUL donations.

    The paginated sibling (/me/donations/) caps at StandardPagination.page_size=20,
    so a church with >20 gifts cannot download its complete history there. This
    export reuses the exact same church-scope + SUCCESSFUL guard but streams EVERY
    row. This test plants 25 SUCCESSFUL donations to prove the >20 case: the export
    must return all 25 data rows, not a 20-row page.
    """

    N_DONATIONS = 25

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        for i in range(cls.N_DONATIONS):
            Donation.objects.create(
                campaign=cls.camp_a_active,
                phone_number='254712345678',
                donor_name=f'Donor {i:02d}',
                amount=Decimal('1000.00'),
                platform_fee=Decimal('25.00'),
                net_amount=Decimal('975.00'),
                status=DonationStatus.SUCCESSFUL,
                mpesa_receipt_number=f'QHXCSV{i:03d}',
            )

    def setUp(self):
        super().setUp()
        self.client.force_authenticate(user=self.treasurer_a)
        # Concat (not reverse('...-export')) so this URL resolves to a clean 404
        # while the route is absent — proving RED without a NoReverseMatch error.
        self.export_url = reverse('church-me-donations') + 'export/'

    def test_export_streams_all_25_rows_not_a_20_row_page(self):
        resp = self.client.get(self.export_url, {'format': 'csv'})
        self.assertEqual(resp.status_code, status.HTTP_200_OK, getattr(resp, 'content', resp))
        # Content-Type is CSV.
        self.assertTrue(resp['Content-Type'].startswith('text/csv'), resp['Content-Type'])
        # Streamed body → parse with the csv module.
        body = b''.join(resp.streaming_content).decode('utf-8')
        rows = list(csv.reader(io.StringIO(body)))
        rows = [r for r in rows if r]  # drop any trailing blank line
        # Header row present.
        self.assertEqual(rows[0], ['Date', 'Receipt', 'Donor', 'Net Amount (KES)'])
        # 25 DATA rows — the whole history, NOT a 20-row page.
        self.assertEqual(len(rows) - 1, self.N_DONATIONS)
