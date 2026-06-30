"""Seed a minimal multi-tenant fixture into the DISPOSABLE pamoja_audit DB.

Harness rule 2: never mutate pamoja_dev. This script ASSERTS the active DB is
pamoja_audit before writing a single row, and refuses otherwise.

Run from backend/ with the audit DB pointed via env:
  DATABASE_URL=postgresql://pamoja_app:admin@localhost:5432/pamoja_audit \
  DJANGO_SETTINGS_MODULE=config.settings.development \
  ./venv/Scripts/python.exe ../AUDIT/scripts/seed_audit.py

Idempotent: re-running updates the same rows (get_or_create keyed on natural keys).

Known actors after seeding (password for ALL accounts: AuditPass!234):
  SUPER ADMIN     super@audit.test
  TREASURER A     treasurerA@audit.test   church "Audit Alpha Church" (ACTIVE)
  TREASURER B     treasurerB@audit.test   church "Audit Beta Church"  (ACTIVE)
  CAMPAIGN-TREAS A phone 254712000001  (campaign "alpha-build")
  CAMPAIGN-TREAS B phone 254712000002  (campaign "beta-outreach")
"""

import os
import sys
from datetime import timedelta
from decimal import Decimal

import django
from django.utils import timezone

# backend/ is the cwd's parent's child; ensure backend on path
BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, BACKEND)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.development')
django.setup()

from django.conf import settings
from django.db import connection

# ── SAFETY GUARD: refuse to write to anything but pamoja_audit ──────────────────
db_name = connection.settings_dict['NAME']
if db_name != 'pamoja_audit':
    raise SystemExit(
        f"REFUSING TO SEED: active DB is '{db_name}', not 'pamoja_audit'. "
        f"Set DATABASE_URL to the pamoja_audit DB before running."
    )

from accounts.models import User, UserRole
from churches.models import Church, ChurchStatus, SubscriptionTier
from campaigns.models import Campaign, CampaignStatus, CampaignCategory, GroupLabel
from donations.models import Donation, DonationStatus
from withdrawals.models import Withdrawal, WithdrawalStatus
from superadmin.models import PlatformSettings

PASSWORD = 'AuditPass!234'
now = timezone.now()


def upsert_user(email, first, last, role, church=None, phone=''):
    u, _ = User.objects.get_or_create(
        email=email,
        defaults=dict(first_name=first, last_name=last, role=role, church=church, phone=phone),
    )
    u.first_name, u.last_name, u.role, u.church, u.phone = first, last, role, church, phone
    if role == UserRole.SUPER_ADMIN:
        u.is_staff = True
        u.is_superuser = True
    u.set_password(PASSWORD)
    u.save()
    return u


def upsert_church(name, email, phone, tier=SubscriptionTier.FREE, status=ChurchStatus.ACTIVE):
    c, _ = Church.objects.get_or_create(
        official_email=email,
        defaults=dict(
            name=name, phone=phone, address='123 Audit Rd', county='Nairobi',
            denomination='Test Denomination', status=status, subscription_tier=tier,
        ),
    )
    c.name, c.phone, c.status, c.subscription_tier = name, phone, status, tier
    c.save()
    return c


def upsert_campaign(slug, church, creator, title, treas_phone, treas_name, goal, raised, wallet):
    camp, _ = Campaign.objects.get_or_create(
        slug=slug,
        defaults=dict(
            church=church, title=title, description='Audit fixture campaign.',
            goal_amount=Decimal(goal), raised_amount=Decimal(raised),
            wallet_balance=Decimal(wallet), status=CampaignStatus.ACTIVE,
            banner_image_url='https://example.com/banner.png',
            category=CampaignCategory.BUILDING, treasurer_phone=treas_phone,
            treasurer_name=treas_name, created_by=creator,
        ),
    )
    camp.church, camp.created_by = church, creator
    camp.title, camp.treasurer_phone, camp.treasurer_name = title, treas_phone, treas_name
    camp.goal_amount = Decimal(goal)
    camp.raised_amount = Decimal(raised)
    camp.wallet_balance = Decimal(wallet)
    camp.status = CampaignStatus.ACTIVE
    camp.save()
    return camp


def upsert_donation(campaign, phone, name, amount, fee, net, checkout_id, receipt):
    d, _ = Donation.objects.get_or_create(
        checkout_request_id=checkout_id,
        defaults=dict(
            campaign=campaign, phone_number=phone, donor_name=name,
            amount=Decimal(amount), platform_fee=Decimal(fee), net_amount=Decimal(net),
            status=DonationStatus.SUCCESSFUL, mpesa_receipt_number=receipt,
            confirmed_at=now,
        ),
    )
    return d


def upsert_withdrawal(campaign, req_phone, amount, dest_phone, dest_name, reason, status):
    # natural-ish key: one per (campaign, reason)
    w, _ = Withdrawal.objects.get_or_create(
        campaign=campaign, reason=reason,
        defaults=dict(
            requested_by_phone=req_phone, amount=Decimal(amount),
            destination_phone=dest_phone, destination_name=dest_name, status=status,
        ),
    )
    w.amount = Decimal(amount)
    w.status = status
    w.save()
    return w


# ── PlatformSettings singleton (fee 2.5%) ───────────────────────────────────────
PlatformSettings.objects.get_or_create(id=1) if False else None
ps = PlatformSettings.objects.first()
if ps is None:
    ps = PlatformSettings.objects.create()
print(f"PlatformSettings: {ps}")

# ── Super admin ─────────────────────────────────────────────────────────────────
sa = upsert_user('super@audit.test', 'Super', 'Admin', UserRole.SUPER_ADMIN)

# ── Church A ──────────────────────────────────────────────────────────────────
church_a = upsert_church('Audit Alpha Church', 'alpha@audit.test', '254700000001',
                         tier=SubscriptionTier.GROWTH)
treas_a = upsert_user('treasurerA@audit.test', 'Alice', 'Alpha', UserRole.CHURCH_TREASURER,
                      church=church_a, phone='254711000001')
camp_a = upsert_campaign('alpha-build', church_a, treas_a, 'Alpha Building Fund',
                         '254712000001', 'Alpha CampTreas', goal='100000', raised='975', wallet='975')
don_a = upsert_donation(camp_a, '254713000001', 'Donor A', '1000', '25', '975',
                        'AUDIT-CHK-A1', 'AUDITRCPTA1')
wd_a = upsert_withdrawal(camp_a, '254712000001', '500', '254712000001', 'Alpha CampTreas',
                         'Alpha payout fixture', WithdrawalStatus.PENDING_APPROVAL)

# ── Church B ──────────────────────────────────────────────────────────────────
church_b = upsert_church('Audit Beta Church', 'beta@audit.test', '254700000002',
                         tier=SubscriptionTier.FREE)
treas_b = upsert_user('treasurerB@audit.test', 'Bob', 'Beta', UserRole.CHURCH_TREASURER,
                      church=church_b, phone='254711000002')
camp_b = upsert_campaign('beta-outreach', church_b, treas_b, 'Beta Outreach Drive',
                         '254712000002', 'Beta CampTreas', goal='200000', raised='1950', wallet='1950')
don_b = upsert_donation(camp_b, '254713000002', 'Donor B', '2000', '50', '1950',
                        'AUDIT-CHK-B1', 'AUDITRCPTB1')
wd_b = upsert_withdrawal(camp_b, '254712000002', '700', '254712000002', 'Beta CampTreas',
                         'Beta payout fixture', WithdrawalStatus.PENDING_APPROVAL)

# ── A group label per church (for group-label IDOR tests) ───────────────────────
GroupLabel.objects.get_or_create(church=church_a, name='Alpha Group')
GroupLabel.objects.get_or_create(church=church_b, name='Beta Group')

print("== SEED COMPLETE ==")
print(f"super={sa.email} id={sa.id}")
print(f"churchA={church_a.id} treasurerA={treas_a.email} id={treas_a.id} campA={camp_a.slug}/{camp_a.id} donA={don_a.id} wdA={wd_a.id}")
print(f"churchB={church_b.id} treasurerB={treas_b.email} id={treas_b.id} campB={camp_b.slug}/{camp_b.id} donB={don_b.id} wdB={wd_b.id}")
print(f"Counts: users={User.objects.count()} churches={Church.objects.count()} "
      f"campaigns={Campaign.objects.count()} donations={Donation.objects.count()} "
      f"withdrawals={Withdrawal.objects.count()}")
