"""Test runner that stubs the Resend network boundary for the WHOLE suite.

WHY: the project deliberately has NO production no-op guard — emails fire for real
with DEBUG=False (see integrations/resend_email.py). Courtesy email sends now live in
high-traffic flows (registration, payout approve/reject, donation receipt), so without
a stub the suite would make dozens of real Resend HTTP calls per run. Africa's Talking
fails on LOCAL phone validation (no packet), but Resend's SDK actually POSTs — so we
neutralize exactly that one SDK boundary here, once, instead of patching every flow's
tests.

We stub `resend.Emails.send` (the SDK call), NOT `_send_email` (our seam): this keeps
`_send_email`'s real logic exercised, so tests that assert seam behaviour still mean
something. Tests that need a specific send outcome patch `_send_email` (or `resend.Emails`)
locally — a context-manager patch overrides this global stub for that test's duration.
"""

from unittest import mock

from django.test.runner import DiscoverRunner


class StubbedExternalsTestRunner(DiscoverRunner):
    def run_tests(self, *args, **kwargs):
        # A successful-looking response so unpatched courtesy sends return normally
        # (no network, no raise) exactly as a real success would.
        with mock.patch('resend.Emails.send', return_value={'id': 'test-stub'}):
            return super().run_tests(*args, **kwargs)
