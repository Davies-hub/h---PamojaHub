"""Public-surface field leak tests for Pamoja Hub serializers.

Build Guide Coding Rule 3 + Compressed Context Section 11 item 8: certain field names
must NEVER appear on any public-facing API response. This test instantiates each
public serializer and inspects `.fields.keys()` — failures name both the serializer
and the leaked field so a regression is impossible to misread.

These tests use SimpleTestCase (no DB access) — we are inspecting declared field
metadata only, not exercising any queries.

Run: python manage.py test tests.test_serializer_leaks
"""

from django.test import SimpleTestCase

from accounts.serializers import UserSerializer
from campaigns.serializers import PublicCampaignSerializer
from churches.serializers import PublicChurchSerializer
from donations.serializers import DonationStatusSerializer, PortalDonationReportSerializer
from treasurer_portal.serializers import PortalCampaignSerializer
from withdrawals.serializers import WithdrawalSerializer


# Master forbidden set: never serialize out on any public-facing surface.
FORBIDDEN_GLOBAL = {
    'treasurer_phone',
    'treasurer_name',
    'wallet_balance',
    'checkout_request_id',
    'b2c_conversation_id',
    'platform_fee',
    'password',
    'is_superuser',
    'is_staff',
}

# Sensitive data under non-forbidden names — guarded by view-layer authorization,
# not serializer field allowlists. Field NAMES like destination_phone and
# requested_by_phone aren't on the forbidden list (a campaign legitimately needs
# them on authorized surfaces — Church Treasurer approval dialog, portal pending
# list), but the data underneath IS sensitive. A future regression that wires
# WithdrawalSerializer to a public/cross-church endpoint cannot be caught by a
# field-name allowlist test. The guardrail lives in the view/permission layer
# (Step 2.8). WithdrawalSerializerSurfaceTest below is a tripwire: it asserts the
# fields are intentionally present so anyone reading the test suite sees the
# constraint stated explicitly.
SENSITIVE_UNDER_BENIGN_NAMES = {
    'destination_phone',
    'requested_by_phone',
}


def _field_names(serializer_cls):
    """Return the set of declared output field names for a serializer."""
    return set(serializer_cls().fields.keys())


def _assert_no_leaks(testcase, serializer_cls, forbidden):
    """Assert none of `forbidden` appear in `serializer_cls`'s output fields.
    Each failure names the serializer and the leaked field.
    """
    declared = _field_names(serializer_cls)
    leaks = declared & set(forbidden)
    testcase.assertFalse(
        leaks,
        msg=f"{serializer_cls.__name__} LEAKS forbidden fields: {sorted(leaks)}",
    )


class PublicChurchSerializerLeakTest(SimpleTestCase):
    forbidden = FORBIDDEN_GLOBAL | {
        'official_email',
        'phone',
        'address',
        'status',
        'subscription_tier',
        'subscription_expires_at',
    }

    def test_no_forbidden_fields_leak(self):
        _assert_no_leaks(self, PublicChurchSerializer, self.forbidden)


class PublicCampaignSerializerLeakTest(SimpleTestCase):
    forbidden = FORBIDDEN_GLOBAL | {
        # Already in FORBIDDEN_GLOBAL but listed here for spec traceability:
        'treasurer_phone',
        'treasurer_name',
        'wallet_balance',
        'checkout_request_id',
        'b2c_conversation_id',
    }

    def test_no_forbidden_fields_leak(self):
        _assert_no_leaks(self, PublicCampaignSerializer, self.forbidden)


class DonationStatusSerializerLeakTest(SimpleTestCase):
    forbidden = FORBIDDEN_GLOBAL | {
        'platform_fee',
        'net_amount',
        'checkout_request_id',
        'b2c_conversation_id',
    }

    def test_no_forbidden_fields_leak(self):
        _assert_no_leaks(self, DonationStatusSerializer, self.forbidden)


class PortalDonationReportSerializerLeakTest(SimpleTestCase):
    forbidden = FORBIDDEN_GLOBAL | {
        'phone_number',
        'platform_fee',
        'b2c_conversation_id',
    }

    def test_no_forbidden_fields_leak(self):
        _assert_no_leaks(self, PortalDonationReportSerializer, self.forbidden)

    def test_amount_field_sourced_from_net_amount(self):
        """Net-Everywhere: portal report shows net, not gross."""
        s = PortalDonationReportSerializer()
        amount_field = s.fields.get('amount')
        self.assertIsNotNone(
            amount_field,
            msg="PortalDonationReportSerializer is missing the 'amount' output field.",
        )
        self.assertEqual(
            amount_field.source,
            'net_amount',
            msg=(
                "PortalDonationReportSerializer.amount must serialize net_amount per "
                f"Net-Everywhere; got source={amount_field.source!r}."
            ),
        )


class UserSerializerLeakTest(SimpleTestCase):
    forbidden = FORBIDDEN_GLOBAL | {
        'password',
        'is_superuser',
        'is_staff',
        'user_permissions',
        'groups',
    }

    def test_no_forbidden_fields_leak(self):
        _assert_no_leaks(self, UserSerializer, self.forbidden)


class PortalCampaignSerializerLeakTest(SimpleTestCase):
    # Note: wallet_balance IS allowed on PortalCampaignSerializer (authenticated
    # church-facing surface), so it is intentionally removed from forbidden here.
    forbidden = (FORBIDDEN_GLOBAL - {'wallet_balance'}) | {
        'treasurer_phone',
        'treasurer_name',
    }

    def test_no_forbidden_fields_leak(self):
        _assert_no_leaks(self, PortalCampaignSerializer, self.forbidden)


class WithdrawalSerializerSurfaceTest(SimpleTestCase):
    """Documented tripwire — NOT a leak assertion.

    WithdrawalSerializer is authorized-surface-only. It intentionally exposes
    destination_phone and requested_by_phone in full because the authorized surfaces
    (approval dialog, portal pending list) need them. The field NAMES are not on the
    forbidden list, so this test cannot use _assert_no_leaks. Instead it asserts the
    fields ARE present (proving intent) and serves as documentation that anyone
    routing WithdrawalSerializer to a new endpoint must verify the endpoint is
    authorized + scoped to the requesting user's church.

    Authorization is enforced at the view/permission layer in Step 2.8 — NOT here.
    """

    def test_sensitive_fields_intentionally_present(self):
        declared = _field_names(WithdrawalSerializer)
        for field_name in SENSITIVE_UNDER_BENIGN_NAMES:
            self.assertIn(
                field_name,
                declared,
                msg=(
                    f"WithdrawalSerializer is expected to expose {field_name!r} "
                    "on authorized surfaces. If you removed it, update PRD 8.5.5 "
                    "and the approval dialog UI before deleting this assertion."
                ),
            )

    def test_b2c_conversation_id_excluded(self):
        """Internal Daraja correlation id stays out of the response."""
        declared = _field_names(WithdrawalSerializer)
        self.assertNotIn(
            'b2c_conversation_id',
            declared,
            msg=(
                "WithdrawalSerializer must not expose b2c_conversation_id "
                "(Coding Rule 3 — internal Daraja correlation id)."
            ),
        )
