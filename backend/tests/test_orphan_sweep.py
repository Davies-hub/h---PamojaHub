"""CLEANUP SLICE 3b — orphan-media sweep, storage PATCHED (no MinIO; live gate is separate).

These prove the sweep REFUSES to delete objects that are either (a) still referenced by a
MediaAsset row or (b) inside the grace window — the two ways an over-delete could destroy a
live asset. Storage is mocked at media.sweep.ObjectStorageClient: list_objects returns a
crafted four-object mix and delete_object is a spy, so the ONLY thing under test is the
sweep's candidate logic + the command's dry-run default.

Fixture style mirrors tests/test_mediaasset_constraint.py (Church/Campaign/User field set).
"""

import io
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone

from accounts.models import User, UserRole
from campaigns.models import Campaign, CampaignCategory, CampaignStatus
from churches.models import Church, ChurchStatus
from media.models import MediaAsset
from media.sweep import sweep_orphan_media


class OrphanSweepTests(TestCase):
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

        # Two tz-aware ages straddling the default 60-min grace window.
        self.old = timezone.now() - timedelta(hours=2)      # older than grace → sweepable
        self.young = timezone.now() - timedelta(minutes=5)  # inside grace → protected

        # The four crafted object keys.
        self.REF_OLD = f'campaign/{self.campaign.id}/banner/ref_old.jpg'
        self.ORPH_OLD = f'campaign/{self.campaign.id}/banner/orph_old.jpg'
        self.ORPH_YOUNG = f'campaign/{self.campaign.id}/banner/orph_young.jpg'
        self.REF_YOUNG = f'church/{self.church.id}/logo/ref_young.png'
        self.ORPH_OLD_SIZE = 4242

        # Seed MediaAsset rows so REF_OLD and REF_YOUNG's keys are REFERENCED (must survive).
        MediaAsset.objects.create(
            kind='BANNER', campaign=self.campaign, church=None,
            object_key=self.REF_OLD, bucket='pamoja-media',
            content_type='image/jpeg', size_bytes=100, uploaded_by=self.user,
        )
        MediaAsset.objects.create(
            kind='LOGO', church=self.church, campaign=None,
            object_key=self.REF_YOUNG, bucket='pamoja-media',
            content_type='image/png', size_bytes=200, uploaded_by=self.user,
        )

    def _listing(self, include_orph_old=True):
        objs = [
            {'key': self.REF_OLD, 'last_modified': self.old, 'size': 100},        # referenced
            {'key': self.ORPH_YOUNG, 'last_modified': self.young, 'size': 300},   # orphan but in-grace
            {'key': self.REF_YOUNG, 'last_modified': self.young, 'size': 200},    # referenced
        ]
        if include_orph_old:
            objs.append(
                {'key': self.ORPH_OLD, 'last_modified': self.old, 'size': self.ORPH_OLD_SIZE},  # the ONLY candidate
            )
        return objs

    def _wire(self, mock_cls, include_orph_old=True):
        """Point the patched ObjectStorageClient at the crafted listing; return the instance
        mock so callers can inspect delete_object (the spy)."""
        instance = mock_cls.return_value
        instance.list_objects.return_value = self._listing(include_orph_old)
        return instance

    # ── RED-DRYRUN-DELETES-NOTHING ───────────────────────────────────────────────
    @patch('media.sweep.ObjectStorageClient')
    def test_red_dryrun_deletes_nothing(self, mock_cls):
        instance = self._wire(mock_cls)
        out = io.StringIO()
        call_command('sweep_orphan_media', stdout=out)   # NO --commit

        text = out.getvalue()
        instance.delete_object.assert_not_called()        # dry-run touches NOTHING
        self.assertIn('Would delete 1', text)             # only ORPH_OLD is a candidate
        self.assertIn('DRY-RUN', text)

        # And the summary from a direct dry-run call agrees.
        r = sweep_orphan_media(commit=False)
        self.assertEqual(r['orphans'], 1)
        self.assertEqual(r['deleted'], 0)

    # ── RED-LIVE-OBJECT-SURVIVES ─────────────────────────────────────────────────
    @patch('media.sweep.ObjectStorageClient')
    def test_red_live_object_survives_under_commit(self, mock_cls):
        instance = self._wire(mock_cls)
        call_command('sweep_orphan_media', '--commit')

        # Deleted EXACTLY the one true orphan…
        instance.delete_object.assert_called_once_with(self.ORPH_OLD)
        # …and NEVER a referenced or in-grace key, even under --commit.
        deleted_keys = [c.args[0] for c in instance.delete_object.call_args_list]
        self.assertNotIn(self.REF_OLD, deleted_keys)      # referenced — must survive
        self.assertNotIn(self.REF_YOUNG, deleted_keys)    # referenced — must survive
        self.assertNotIn(self.ORPH_YOUNG, deleted_keys)   # in-grace — must survive

    # ── RED-GRACE-PROTECTS ───────────────────────────────────────────────────────
    @patch('media.sweep.ObjectStorageClient')
    def test_red_grace_protects_young_orphan(self, mock_cls):
        self._wire(mock_cls)
        r = sweep_orphan_media(commit=False)
        self.assertEqual(r['in_grace_skipped'], 1)        # ORPH_YOUNG skipped, not deleted

    # ── GREEN-COMMIT-DELETES-ORPHAN ──────────────────────────────────────────────
    @patch('media.sweep.ObjectStorageClient')
    def test_green_commit_deletes_orphan(self, mock_cls):
        instance = self._wire(mock_cls)
        r = sweep_orphan_media(commit=True)

        self.assertEqual(r['deleted'], 1)
        self.assertEqual(r['reclaimed_bytes'], self.ORPH_OLD_SIZE)
        instance.delete_object.assert_called_once_with(self.ORPH_OLD)

    # ── IDEMPOTENT ───────────────────────────────────────────────────────────────
    @patch('media.sweep.ObjectStorageClient')
    def test_idempotent_second_run_deletes_nothing(self, mock_cls):
        # Second run: ORPH_OLD already gone from the bucket listing → no candidate.
        instance = self._wire(mock_cls, include_orph_old=False)
        r = sweep_orphan_media(commit=True)
        self.assertEqual(r['deleted'], 0)
        instance.delete_object.assert_not_called()
