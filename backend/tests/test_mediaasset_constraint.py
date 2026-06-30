"""SLICE 2b-i — MediaAsset owner-matches-kind CHECK, proven at the DB layer.

The single CHECK `mediaasset_owner_matches_kind` is the model's integrity guard
that an upload row's owner matches its kind:
  * BANNER -> exactly a campaign (no church)
  * LOGO   -> exactly a church  (no campaign)
It must reject "both owners set", "neither owner set", and "kind mismatched to
owner" — all at the database, independent of any serializer/view validation a
later slice adds. These tests insert directly via the ORM (NO endpoint), so the
only thing under test is the Postgres CHECK.

TransactionTestCase (NOT TestCase): a raised IntegrityError aborts the enclosing
transaction; under a plain atomic TestCase that poisons teardown. Each bad insert
is wrapped in its own transaction.atomic() so the error is catchable and isolated.

Fixture style mirrors tests/test_image_field_lock.py (Church/Campaign/User field set).
"""

from decimal import Decimal

from django.db import IntegrityError, transaction
from django.test import TransactionTestCase

from accounts.models import User, UserRole
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from media.models import MediaAsset


class MediaAssetOwnerConstraintTest(TransactionTestCase):
    """One ACTIVE church, one campaign under it, one treasurer — the two real
    owners the CHECK arms reference plus the uploader (PROTECT FK)."""

    def setUp(self):
        self.church = Church.objects.create(
            name='Church A',
            official_email='a@example.org',
            phone='254700000001',
            address='addr',
            county='Nairobi',
            denomination='PCEA',
            status=ChurchStatus.ACTIVE,
            logo_url=None,
        )
        self.user = User.objects.create_user(
            email='ta@example.org',
            password='UnusedForTest!',
            first_name='F',
            last_name='L',
            role=UserRole.CHURCH_TREASURER,
            church=self.church,
        )
        self.campaign = Campaign.objects.create(
            slug='a-active',
            church=self.church,
            title='Campaign a-active',
            description='desc',
            goal_amount=Decimal('100000'),
            raised_amount=Decimal('0'),
            wallet_balance=Decimal('0'),
            banner_image_url=None,
            category=CampaignCategory.BUILDING,
            treasurer_phone='254712345678',
            treasurer_name='Treas Urer',
            created_by=self.user,
            status=CampaignStatus.ACTIVE,
        )

    # ── RED: each malformed row MUST be rejected by the DB CHECK ──────────────
    def test_red_both_owners_set(self):
        """R1: BOTH campaign and church set violates the XOR."""
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                MediaAsset.objects.create(
                    kind='BANNER',
                    campaign=self.campaign,
                    church=self.church,
                    object_key='campaign/x/banner/x.jpg',
                    bucket='pamoja-media',
                    content_type='image/jpeg',
                    size_bytes=633,
                    uploaded_by=self.user,
                )

    def test_red_neither_owner_set(self):
        """R2: NEITHER owner set violates the XOR."""
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                MediaAsset.objects.create(
                    kind='BANNER',
                    campaign=None,
                    church=None,
                    object_key='campaign/x/banner/x.jpg',
                    bucket='pamoja-media',
                    content_type='image/jpeg',
                    size_bytes=633,
                    uploaded_by=self.user,
                )

    def test_red_banner_with_church(self):
        """R3: BANNER pinned to a church (not a campaign) is a kind/owner mismatch."""
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                MediaAsset.objects.create(
                    kind='BANNER',
                    campaign=None,
                    church=self.church,
                    object_key='church/x/banner/x.jpg',
                    bucket='pamoja-media',
                    content_type='image/jpeg',
                    size_bytes=633,
                    uploaded_by=self.user,
                )

    def test_red_logo_with_campaign(self):
        """R4: LOGO pinned to a campaign (not a church) is a kind/owner mismatch."""
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                MediaAsset.objects.create(
                    kind='LOGO',
                    campaign=self.campaign,
                    church=None,
                    object_key='campaign/x/logo/x.jpg',
                    bucket='pamoja-media',
                    content_type='image/jpeg',
                    size_bytes=633,
                    uploaded_by=self.user,
                )

    # ── GREEN: each well-formed row MUST insert ──────────────────────────────
    def test_green_valid_banner(self):
        """G1: BANNER + campaign-only inserts and round-trips."""
        asset = MediaAsset.objects.create(
            kind='BANNER',
            campaign=self.campaign,
            church=None,
            object_key=f'campaign/{self.campaign.id}/banner/x.jpg',
            bucket='pamoja-media',
            content_type='image/jpeg',
            size_bytes=633,
            uploaded_by=self.user,
        )
        self.assertTrue(MediaAsset.objects.filter(id=asset.id).exists())

    def test_green_valid_logo(self):
        """G2: LOGO + church-only inserts and round-trips."""
        asset = MediaAsset.objects.create(
            kind='LOGO',
            church=self.church,
            campaign=None,
            object_key=f'church/{self.church.id}/logo/x.jpg',
            bucket='pamoja-media',
            content_type='image/jpeg',
            size_bytes=633,
            uploaded_by=self.user,
        )
        self.assertTrue(MediaAsset.objects.filter(id=asset.id).exists())
