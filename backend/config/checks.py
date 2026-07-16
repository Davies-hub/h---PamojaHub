"""Django system checks for M-Pesa callback configuration (pamoja.E001/E002).

Settings-level companions to validate_env() (config/settings/base.py): that
function guards raw os.environ presence at import time; these checks run at the
resolved-settings layer on every `manage.py check` / server start, where
settings-module defaults (e.g. development.py's MPESA_CALLBACK_SECRET) are
visible. Registered from DonationsConfig.ready() (donations owns the primary
callback route).
"""

from django.conf import settings
from django.core.checks import Error, Tags, register

# The three Daraja-facing URLs whose targets are mounted behind the
# MPESA_CALLBACK_SECRET path segment (donations/urls.py, withdrawals/urls.py,
# churches/subscription_urls.py). A URL missing the segment 404s at the router
# on every real Safaricom callback. MPESA_B2C_QUEUE_URL is deliberately
# EXCLUDED: it is secret-less by design — no route consumes it (the
# QueueTimeOutURL is handed to Daraja but /b2c-queue/ is absent on purpose).
_SECRET_CARRYING_URL_SETTINGS = (
    'MPESA_CALLBACK_URL',
    'MPESA_SUBSCRIPTION_CALLBACK_URL',
    'MPESA_B2C_RESULT_URL',
)


@register(Tags.security)
def check_mpesa_callback_config(app_configs, **kwargs):
    errors = []

    # Rule 1 — containment: every configured callback URL must carry the
    # secret path segment. Messages name the offending VARIABLE only; the
    # secret and the URL themselves must never appear in check output.
    secret = settings.MPESA_CALLBACK_SECRET
    if secret:
        segment = f'/{secret}/'
        for name in _SECRET_CARRYING_URL_SETTINGS:
            url = getattr(settings, name, '')
            if url and segment not in url:
                errors.append(Error(
                    # ASCII-only: check output must survive a cp1252 console.
                    f'{name} does not contain the MPESA_CALLBACK_SECRET path '
                    'segment - Safaricom callbacks to this URL will 404 at '
                    'the router and no payment will ever confirm.',
                    hint=(
                        f'Rebuild {name} so its path ends with the exact '
                        '/<MPESA_CALLBACK_SECRET>/ segment the routes are '
                        'mounted under.'
                    ),
                    id='pamoja.E001',
                ))

    # Rule 2 — dev-module-in-prod: production.py hardcodes DEBUG=False, so
    # DEBUG=True alongside production M-Pesa can only mean the development
    # settings module (or equivalent) is pointed at real money.
    environment = (settings.MPESA_ENVIRONMENT or '').strip().lower()
    if environment == 'production' and settings.DEBUG:
        errors.append(Error(
            'development settings module cannot run against production '
            'M-Pesa (DEBUG=True with MPESA_ENVIRONMENT=production).',
            hint='Run under config.settings.production (DEBUG=False).',
            id='pamoja.E002',
        ))

    return errors
