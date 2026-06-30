"""Guard tests for the DEV-ONLY synthetic-withdrawal cleanup command.

The command must be IMPOSSIBLE to run destructively against prod or by reflex.
These exercise the factored guard (assert_dev_target) with STUBBED settings/DB
values, proving it REFUSES (CommandError) for a non-development settings module
and for a non-dev database WITHOUT ever connecting to or creating a prod DB.
"""

from django.core.management.base import CommandError
from django.test import SimpleTestCase

from withdrawals.management.commands.cleanup_synthetic_withdrawals import (
    EXPECTED_DEV_DB,
    assert_dev_target,
)


class CleanupGuardTests(SimpleTestCase):
    def test_passes_on_dev_settings_and_dev_db(self):
        # The only accepted combination — must NOT raise.
        assert_dev_target('config.settings.development', EXPECTED_DEV_DB)

    def test_refuses_non_development_settings_module(self):
        with self.assertRaises(CommandError):
            assert_dev_target('config.settings.production', EXPECTED_DEV_DB)

    def test_refuses_non_dev_database(self):
        with self.assertRaises(CommandError):
            assert_dev_target('config.settings.development', 'pamoja_prod')

    def test_refuses_when_both_wrong(self):
        with self.assertRaises(CommandError):
            assert_dev_target('config.settings.production', 'pamoja_prod')

    def test_refuses_on_missing_inputs(self):
        with self.assertRaises(CommandError):
            assert_dev_target(None, EXPECTED_DEV_DB)
        with self.assertRaises(CommandError):
            assert_dev_target('config.settings.development', None)
