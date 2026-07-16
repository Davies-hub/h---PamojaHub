"""Settings-level M-Pesa system checks (config/checks.py — pamoja.E001/E002).

Calls the check function directly under override_settings; route wiring of the
secret segment itself is covered by test_callback_forgery_hardening.py.
"""

from django.test import SimpleTestCase, override_settings

from config.checks import check_mpesa_callback_config


class MpesaCallbackConfigCheckTests(SimpleTestCase):

    @override_settings(
        MPESA_CALLBACK_URL='https://example.invalid/api/v1/donations/callback/',
        MPESA_CALLBACK_SECRET='dev-callback-secret',
    )
    def test_secretless_callback_url_returns_e001(self):
        errors = check_mpesa_callback_config(None)
        e001 = [e for e in errors if e.id == 'pamoja.E001']
        self.assertEqual(len(e001), 1)
        # Names the offending variable — and never leaks the secret value.
        self.assertIn('MPESA_CALLBACK_URL', e001[0].msg)
        self.assertNotIn('dev-callback-secret', e001[0].msg)

    @override_settings(DEBUG=True, MPESA_ENVIRONMENT='production')
    def test_debug_true_with_production_mpesa_returns_e002(self):
        errors = check_mpesa_callback_config(None)
        self.assertIn('pamoja.E002', [e.id for e in errors])

    def test_current_dev_settings_are_clean(self):
        # Real development settings + backend/.env as-is must produce zero
        # errors — the dev callback URLs carry the secret segment already.
        self.assertEqual(check_mpesa_callback_config(None), [])
