"""Multi-tenant isolation tests for common.permissions.

These tests exercise ACTUAL cross-church denial against real objects, not just
class introspection. Build Guide Coding Rule 3 + Compressed Context Section 4:
no Church Treasurer may read or write data belonging to another church. The
permission class is the last line of defence; this test pins down its
fail-closed behaviour on every documented object→church path.

Mock request: a tiny `_Req` shim carrying `.user`. We do not need a real DRF
view — has_object_permission only reads `request.user` and the object.

Run: python manage.py test tests.test_permissions
"""

from decimal import Decimal

from django.test import TestCase

from accounts.models import User, UserRole
from campaigns.models import Campaign, CampaignCategory, CampaignUpdate, GroupLabel
from churches.models import Church, ChurchStatus
from common.permissions import (
    ChurchNotSuspended,
    ChurchScopedPermission,
    HasValidPortalToken,
    IsChurchTreasurer,
    IsSuperAdmin,
    resolve_object_church,
)
from donations.models import Donation
from withdrawals.models import Withdrawal


class _Req:
    """Minimal request shim — DRF permission classes only touch `.user`."""

    def __init__(self, user):
        self.user = user


class MultiTenantPermissionTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        # Two churches
        cls.church_a = Church.objects.create(
            name='Church A',
            official_email='a@example.org',
            phone='254700000001',
            address='A address',
            county='Nairobi',
            denomination='PCEA',
        )
        cls.church_b = Church.objects.create(
            name='Church B',
            official_email='b@example.org',
            phone='254700000002',
            address='B address',
            county='Mombasa',
            denomination='ACK',
        )

        # Treasurer for each church
        cls.treasurer_a = User.objects.create_user(
            email='treasurer-a@example.org',
            password='unused-for-this-test',
            first_name='Alice',
            last_name='Aye',
            role=UserRole.CHURCH_TREASURER,
            church=cls.church_a,
        )
        cls.treasurer_b = User.objects.create_user(
            email='treasurer-b@example.org',
            password='unused-for-this-test',
            first_name='Bob',
            last_name='Bee',
            role=UserRole.CHURCH_TREASURER,
            church=cls.church_b,
        )

        # Super Admin — explicitly has church=None
        cls.super_admin = User.objects.create_user(
            email='super@example.org',
            password='unused-for-this-test',
            first_name='Sue',
            last_name='Super',
            role=UserRole.SUPER_ADMIN,
            church=None,
        )

        # Church A's church-scoped objects
        cls.a_campaign = Campaign.objects.create(
            slug='a-campaign',
            church=cls.church_a,
            title='A Campaign',
            description='desc',
            goal_amount=Decimal('100000'),
            banner_image_url='https://example.org/a.png',
            category=CampaignCategory.BUILDING,
            treasurer_phone='254700000010',
            treasurer_name='Alice Aye',
            created_by=cls.treasurer_a,
        )
        cls.a_grouplabel = GroupLabel.objects.create(
            church=cls.church_a,
            name='A Building Fund',
        )
        cls.a_donation = Donation.objects.create(
            campaign=cls.a_campaign,
            phone_number='254700000099',
            amount=Decimal('500'),
            platform_fee=Decimal('12.50'),
            net_amount=Decimal('487.50'),
        )
        cls.a_withdrawal = Withdrawal.objects.create(
            campaign=cls.a_campaign,
            requested_by_phone='254700000010',
            amount=Decimal('1000'),
            destination_phone='254700000010',
            destination_name='Alice Aye',
            reason='Buy materials',
        )
        cls.a_campaignupdate = CampaignUpdate.objects.create(
            campaign=cls.a_campaign,
            posted_by=cls.treasurer_a,
            body='Progress update',
        )

    # ----- ChurchScopedPermission.has_object_permission -----

    def _check(self, user, obj):
        perm = ChurchScopedPermission()
        return perm.has_object_permission(_Req(user), view=None, obj=obj)

    def test_own_church_direct_campaign_allowed(self):
        self.assertTrue(self._check(self.treasurer_a, self.a_campaign))

    def test_cross_church_direct_campaign_denied(self):
        self.assertFalse(self._check(self.treasurer_b, self.a_campaign))

    def test_own_church_direct_grouplabel_allowed(self):
        self.assertTrue(self._check(self.treasurer_a, self.a_grouplabel))

    def test_cross_church_direct_grouplabel_denied(self):
        self.assertFalse(self._check(self.treasurer_b, self.a_grouplabel))

    def test_own_church_via_campaign_donation_allowed(self):
        self.assertTrue(self._check(self.treasurer_a, self.a_donation))

    def test_cross_church_via_campaign_donation_denied(self):
        self.assertFalse(self._check(self.treasurer_b, self.a_donation))

    def test_own_church_via_campaign_withdrawal_allowed(self):
        self.assertTrue(self._check(self.treasurer_a, self.a_withdrawal))

    def test_cross_church_via_campaign_withdrawal_denied(self):
        self.assertFalse(self._check(self.treasurer_b, self.a_withdrawal))

    def test_own_church_via_campaign_campaignupdate_allowed(self):
        self.assertTrue(self._check(self.treasurer_a, self.a_campaignupdate))

    def test_cross_church_via_campaign_campaignupdate_denied(self):
        self.assertFalse(self._check(self.treasurer_b, self.a_campaignupdate))

    def test_superadmin_with_none_church_denied(self):
        """user.church=None must not match an object.church=None — fail closed."""
        self.assertFalse(self._check(self.super_admin, self.a_campaign))

    # ----- resolve_object_church walks every path -----

    def test_resolver_direct_path_campaign(self):
        self.assertEqual(resolve_object_church(self.a_campaign), self.church_a)

    def test_resolver_direct_path_grouplabel(self):
        self.assertEqual(resolve_object_church(self.a_grouplabel), self.church_a)

    def test_resolver_two_hop_donation(self):
        self.assertEqual(resolve_object_church(self.a_donation), self.church_a)

    def test_resolver_two_hop_withdrawal(self):
        self.assertEqual(resolve_object_church(self.a_withdrawal), self.church_a)

    def test_resolver_two_hop_campaignupdate(self):
        self.assertEqual(resolve_object_church(self.a_campaignupdate), self.church_a)

    def test_resolver_unknown_object_returns_none(self):
        """Object with no church and no campaign → None (forces deny upstream)."""
        class _Unknown:
            pass
        self.assertIsNone(resolve_object_church(_Unknown()))

    # ----- IsChurchTreasurer / IsSuperAdmin -----

    def test_is_church_treasurer_allows_treasurer(self):
        self.assertTrue(IsChurchTreasurer().has_permission(_Req(self.treasurer_a), view=None))

    def test_is_church_treasurer_denies_super_admin(self):
        self.assertFalse(IsChurchTreasurer().has_permission(_Req(self.super_admin), view=None))

    def test_is_super_admin_allows_super_admin(self):
        self.assertTrue(IsSuperAdmin().has_permission(_Req(self.super_admin), view=None))

    def test_is_super_admin_denies_treasurer(self):
        self.assertFalse(IsSuperAdmin().has_permission(_Req(self.treasurer_a), view=None))

    # ----- HasValidPortalToken minimal contract -----
    # Full behavioural tests (valid token passes, expired/revoked/wrong-IP fails)
    # live in tests/test_portal.py — they need real PortalToken rows + a real
    # request shape with META headers. This test pins down the entry-point
    # invariant only: no portal token header → False.

    def test_portal_token_no_header_denies(self):
        """A request with neither X-Portal-Token nor 'Authorization: Portal ...'
        must be denied. _Req here carries no META, so the header extractor returns
        an empty string and has_permission short-circuits to False before any
        DB lookup happens.
        """
        class _ReqNoHeaders:
            def __init__(self):
                self.META = {}
        self.assertFalse(HasValidPortalToken().has_permission(_ReqNoHeaders(), view=None))


class ChurchStatusEnumLiteralDriftGuard(TestCase):
    """ChurchNotSuspended (common/permissions.py) compares user.church.status against
    the literal string 'SUSPENDED' — NOT ChurchStatus.SUSPENDED. The literal is used
    on purpose to avoid an early import of churches.models from common/, which is
    loaded very early in the Django bootstrap.

    The safety of using a literal depends on a static invariant: ChurchStatus's
    enum VALUES must equal the strings ChurchNotSuspended compares against. If a
    future refactor changes (say) `SUSPENDED = 'SUSPENDED'` to `SUSPENDED = 'BANNED'`,
    every suspended church would silently bypass ChurchNotSuspended — the permission
    would fail OPEN.

    This test makes that drift loud: CI breaks if the enum values diverge from
    the literals encoded in the permission. Treat a failure here as a security
    incident, not a test-name change.
    """

    def test_church_status_enum_values_match_literals(self):
        self.assertEqual(ChurchStatus.SUSPENDED, 'SUSPENDED')
        self.assertEqual(ChurchStatus.ACTIVE, 'ACTIVE')
        self.assertEqual(ChurchStatus.PENDING, 'PENDING')
        # Added Step 2.9c. REJECTED must also be denied by ChurchNotSuspended's
        # allowlist (PENDING, ACTIVE) — see test_church_not_suspended_denies_rejected_church.
        self.assertEqual(ChurchStatus.REJECTED, 'REJECTED')

    def test_church_not_suspended_denies_suspended_church_by_enum_value(self):
        """End-to-end: a real treasurer whose church is at ChurchStatus.SUSPENDED
        is denied by ChurchNotSuspended. If someone reassigns the enum value, this
        test fails alongside the literal-comparison test above.
        """
        church = Church.objects.create(
            name='Suspended Church',
            official_email='suspended@example.org',
            phone='254700000099',
            address='addr',
            county='Nairobi',
            denomination='PCEA',
            status=ChurchStatus.SUSPENDED,
        )
        user = User.objects.create_user(
            email='suspended-treasurer@example.org',
            password='unused',
            first_name='S', last_name='T',
            role=UserRole.CHURCH_TREASURER,
            church=church,
        )
        self.assertFalse(ChurchNotSuspended().has_permission(_Req(user), view=None))

    def test_church_not_suspended_denies_rejected_church(self):
        """REJECTED church (Step 2.9c) is NOT in the allowlist. A treasurer
        whose registration was denied must not be able to act on platform
        state. Allowlist semantics (PENDING, ACTIVE) deny REJECTED by
        default — the prior `!= 'SUSPENDED'` form would have fail-OPENED here.
        """
        church = Church.objects.create(
            name='Rejected Church',
            official_email='rejected@example.org',
            phone='254700000098', address='addr',
            county='Nairobi', denomination='PCEA',
            status=ChurchStatus.REJECTED,
        )
        user = User.objects.create_user(
            email='rejected-treasurer@example.org',
            password='unused',
            first_name='R', last_name='T',
            role=UserRole.CHURCH_TREASURER,
            church=church,
        )
        self.assertFalse(ChurchNotSuspended().has_permission(_Req(user), view=None))

    def test_church_not_suspended_denies_user_with_no_church(self):
        """The user.church is not None guard is load-bearing — a treasurer with
        no church (degenerate but possible state) must be denied, NOT allowed."""
        user = User.objects.create_user(
            email='no-church@example.org',
            password='unused',
            first_name='N', last_name='C',
            role=UserRole.CHURCH_TREASURER,
            church=None,
        )
        self.assertFalse(ChurchNotSuspended().has_permission(_Req(user), view=None))
