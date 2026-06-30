"""
Base settings for the Pamoja Hub backend.

Shared across development and production. Reads from backend/.env via django-environ.

NOTE: Settings are split into a package (base/development/production) per Build Guide
Step 2.3. With this file one level deeper than the original generated settings.py,
BASE_DIR uses three .parent calls to resolve to backend/.
"""

import os
from datetime import timedelta
from pathlib import Path

import environ

# ── Paths ─────────────────────────────────────────────────────────────────────
# backend/config/settings/base.py → .parent.parent.parent → backend/
BASE_DIR = Path(__file__).resolve().parent.parent.parent

# ── Env loading ───────────────────────────────────────────────────────────────
env = environ.Env()
# Reads backend/.env. By default does NOT overwrite existing os.environ values,
# so shell-exported env vars take precedence (important for CI/production).
environ.Env.read_env(BASE_DIR / '.env')

# ── Core Django ───────────────────────────────────────────────────────────────
SECRET_KEY = env('SECRET_KEY')
DEBUG = env.bool('DEBUG', default=False)
# ALLOWED_HOSTS is overridden per environment (dev: hardcoded; prod: env list).
ALLOWED_HOSTS = []

# ── Application definition ────────────────────────────────────────────────────
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    # Third party
    'rest_framework',
    'rest_framework_simplejwt',
    'corsheaders',
    # Internal apps
    'audit',
    'accounts',
    'churches',
    'campaigns',
    'media',
    'donations',
    'withdrawals',
    'notifications',
    'treasurer_portal',
    'superadmin',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'

# ── Custom user model ─────────────────────────────────────────────────────────
# accounts.User model is created in Step 2.4 — do not run migrations until it exists.
AUTH_USER_MODEL = 'accounts.User'

# ── Database ──────────────────────────────────────────────────────────────────
DATABASES = {
    'default': env.db('DATABASE_URL'),
}

# ── Password validation ───────────────────────────────────────────────────────
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# ── REST framework ────────────────────────────────────────────────────────────
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    'DEFAULT_PAGINATION_CLASS': 'common.pagination.StandardPagination',
    'PAGE_SIZE': 20,
    'EXCEPTION_HANDLER': 'common.exceptions.custom_exception_handler',
}

# ── JWT (SimpleJWT) ───────────────────────────────────────────────────────────
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=60),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=7),
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
}

# ── Internationalization ──────────────────────────────────────────────────────
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

# ── Static files ──────────────────────────────────────────────────────────────
STATIC_URL = 'static/'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# ── CORS ──────────────────────────────────────────────────────────────────────
CORS_ALLOWED_ORIGINS = env.list('CORS_ALLOWED_ORIGINS', default=[])
CORS_ALLOW_CREDENTIALS = True

# ── M-Pesa / Daraja ───────────────────────────────────────────────────────────
MPESA_CONSUMER_KEY = env('MPESA_CONSUMER_KEY', default='')
MPESA_CONSUMER_SECRET = env('MPESA_CONSUMER_SECRET', default='')
MPESA_SHORTCODE = env('MPESA_SHORTCODE', default='')
MPESA_PASSKEY = env('MPESA_PASSKEY', default='')
MPESA_CALLBACK_URL = env('MPESA_CALLBACK_URL', default='')
# Subscription STK callbacks land on their OWN handler (/subscriptions/callback/),
# never the donation handler (Slice 3b). Defaults to MPESA_CALLBACK_URL with the
# donations path swapped to subscriptions (our URL convention); overridable by env.
MPESA_SUBSCRIPTION_CALLBACK_URL = env(
    'MPESA_SUBSCRIPTION_CALLBACK_URL',
    default=MPESA_CALLBACK_URL.replace('/donations/callback/', '/subscriptions/callback/'),
)
# Secret path segment appended to ALL THREE payment-callback routes (donation,
# subscription, B2C result). The Daraja-facing callback URLs (MPESA_CALLBACK_URL /
# MPESA_SUBSCRIPTION_CALLBACK_URL / MPESA_B2C_RESULT_URL above) and the registered
# Daraja portal URLs MUST carry this SAME segment, or Safaricom's real callback
# 404s. Empty → routes fall back to the bare path (dev convenience only); a
# non-empty value is REQUIRED in production (validate_env, below). It is a bearer
# secret in a URL — defense-in-depth over the per-callback amount/identity check,
# not a substitute for it.
MPESA_CALLBACK_SECRET = env('MPESA_CALLBACK_SECRET', default='')
MPESA_ENVIRONMENT = env('MPESA_ENVIRONMENT', default='sandbox')
# B2C uses its own shortcode, distinct from the STK MPESA_SHORTCODE (sandbox B2C
# is a different test org, e.g. 600xxx — never reuse the Lipa-na-M-Pesa shortcode).
MPESA_B2C_SHORTCODE = env('MPESA_B2C_SHORTCODE', default='')
MPESA_B2C_INITIATOR_NAME = env('MPESA_B2C_INITIATOR_NAME', default='')
MPESA_B2C_SECURITY_CREDENTIAL = env('MPESA_B2C_SECURITY_CREDENTIAL', default='')
MPESA_B2C_QUEUE_URL = env('MPESA_B2C_QUEUE_URL', default='')
MPESA_B2C_RESULT_URL = env('MPESA_B2C_RESULT_URL', default='')
MPESA_FLOAT_ALERT_THRESHOLD = env.int('MPESA_FLOAT_ALERT_THRESHOLD', default=50000)

# ── Object storage (S3-compatible: MinIO in dev) ─────────────────────────
S3_ENDPOINT_URL = env('S3_ENDPOINT_URL', default='')          # e.g. http://localhost:9000
S3_ACCESS_KEY_ID = env('S3_ACCESS_KEY_ID', default='')
S3_SECRET_ACCESS_KEY = env('S3_SECRET_ACCESS_KEY', default='')
S3_BUCKET_NAME = env('S3_BUCKET_NAME', default='')
S3_REGION = env('S3_REGION', default='us-east-1')             # MinIO ignores; boto3 requires
S3_PUBLIC_URL_BASE = env('S3_PUBLIC_URL_BASE', default='')    # e.g. http://localhost:9000/<bucket>

# ── Africa's Talking ──────────────────────────────────────────────────────────
AT_API_KEY = env('AT_API_KEY', default='')
AT_USERNAME = env('AT_USERNAME', default='sandbox')

# ── Resend ────────────────────────────────────────────────────────────────────
RESEND_API_KEY = env('RESEND_API_KEY', default='')
RESEND_FROM_EMAIL = env('RESEND_FROM_EMAIL', default='')

# Tests stub the Resend SDK boundary suite-wide (no production no-op guard exists,
# and courtesy emails now live in register / payout / donation flows). See the runner.
TEST_RUNNER = 'config.test_runner.StubbedExternalsTestRunner'

# ── Frontend / Platform ───────────────────────────────────────────────────────
FRONTEND_URL = env('FRONTEND_URL', default='')
PLATFORM_FEE_PERCENT = env.float('PLATFORM_FEE_PERCENT', default=2.5)

# ── Celery (Step 2.10c — B2C reconciliation sweep) ──────────────────────────────
# Broker is only contacted by a running worker/beat; web + check + tests never
# connect (the sweep is invoked directly as a function in tests).
CELERY_BROKER_URL = env('CELERY_BROKER_URL', default='redis://localhost:6379/0')
CELERY_RESULT_BACKEND = env('CELERY_RESULT_BACKEND', default='')
CELERY_TASK_TRACK_STARTED = True

# B2C stranded-withdrawal sweep tunable (escalate-only since A2, 2026-06-07).
#   STALENESS_MINUTES — only escalate PROCESSING / AMBIGUOUS-FAILED rows older than this.
# STATUS_QUERY_ATTEMPTS and BACKOFF_BASE_SECONDS were removed with the wire-disproven
# active Transaction Status query (see §14.1 "DISPROVEN 2026-06-07").
B2C_SWEEP_STALENESS_MINUTES = env.int('B2C_SWEEP_STALENESS_MINUTES', default=15)

# Stranded-donation resolver tunable (Step 3, query-and-escalate; NEVER credits).
#   Donations age by created_at — Donation has NO updated_at field, and a stranded
#   PENDING row never advances any timestamp. 30 min default is well beyond the ~1s
#   real STK callback latency, so a still-PENDING row older than this is genuinely stuck.
DONATION_SWEEP_STALENESS_MINUTES = env.int('DONATION_SWEEP_STALENESS_MINUTES', default=30)

# Subscription grace window (days). A paid church whose subscription_expires_at is
# older than now - SUBSCRIPTION_GRACE_DAYS is lapsed to FREE by the lapse job. The
# grace window itself is silent (no reminders). Injectable for tests.
SUBSCRIPTION_GRACE_DAYS = env.int('SUBSCRIPTION_GRACE_DAYS', default=7)

# Subscription billing period (days) — the span a confirmed subscription payment
# buys. Granted at the callback (3b), NOT at initiate. Injectable for tests.
SUBSCRIPTION_PERIOD_DAYS = env.int('SUBSCRIPTION_PERIOD_DAYS', default=30)

# In-flight renewal window (minutes). Subscription initiate refuses a new STK push
# while a PENDING SubscriptionPayment for the church is younger than this — one
# in-flight renewal per church. A still-PENDING row OLDER than this is stale (the
# STK prompt has expired) and no longer blocks a fresh initiate. Injectable for tests.
SUBSCRIPTION_STK_TIMEOUT_MINUTES = env.int('SUBSCRIPTION_STK_TIMEOUT_MINUTES', default=5)


# ── Environment validation ────────────────────────────────────────────────────
# Narrowed deviation from Build Guide Step 2.3 (see Section 14 of Compressed Context).
#
# Build Guide's validate_env() requires all ~16 vars unconditionally at import time.
# That breaks `manage.py check` in development because dev .env carries dummy
# external-service values that are *deliberately* not real.
#
# This version:
#   * Always requires SECRET_KEY and DATABASE_URL (Django can't start without them).
#   * Requires all external-service vars only when DEBUG=False (any real deployment).
#   * Fires the production-only safety guards when MPESA_ENVIRONMENT=production:
#       - DEBUG=True is rejected in production
#       - ngrok URLs are rejected in production callback URLs
#
# Trigger for strict validation is DEBUG=False, not MPESA_ENVIRONMENT=production —
# because DEBUG=False is unavoidably present in any real deployment.
#
# Implementation note: reads from os.environ directly. django-environ's read_env()
# (called above) populates os.environ for any var defined in the .env file, without
# overwriting existing values. So shell-exported vars take precedence over .env,
# which is the correct behaviour for CI and production.
def validate_env():
    from django.core.exceptions import ImproperlyConfigured

    # Always required — Django cannot start without these
    always_required = ['SECRET_KEY', 'DATABASE_URL']
    missing_always = [v for v in always_required if not os.environ.get(v)]
    if missing_always:
        raise ImproperlyConfigured(
            f"Missing always-required environment variables: {', '.join(missing_always)}"
        )

    debug = os.environ.get('DEBUG', 'False') == 'True'

    # Strict validation only when NOT in debug (i.e. any real deployment)
    if not debug:
        prod_required = [
            'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE',
            'MPESA_PASSKEY', 'MPESA_CALLBACK_URL', 'MPESA_B2C_INITIATOR_NAME',
            'MPESA_B2C_SECURITY_CREDENTIAL', 'MPESA_B2C_QUEUE_URL', 'MPESA_B2C_RESULT_URL',
            # Without a secret path segment in prod the callback routes are the bare,
            # publicly-guessable paths — refuse to start.
            'MPESA_CALLBACK_SECRET',
            'AT_API_KEY', 'AT_USERNAME', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'FRONTEND_URL',
        ]
        missing_prod = [v for v in prod_required if not os.environ.get(v)]
        if missing_prod:
            raise ImproperlyConfigured(
                f"Missing required environment variables for non-debug mode: {', '.join(missing_prod)}"
            )

    # Production-specific safety guards
    if os.environ.get('MPESA_ENVIRONMENT') == 'production':
        if os.environ.get('DEBUG', 'False') == 'True':
            raise ImproperlyConfigured("DEBUG must be False when MPESA_ENVIRONMENT=production.")
        callback = os.environ.get('MPESA_CALLBACK_URL', '')
        result = os.environ.get('MPESA_B2C_RESULT_URL', '')
        queue = os.environ.get('MPESA_B2C_QUEUE_URL', '')
        if any('ngrok' in url for url in (callback, result, queue)):
            raise ImproperlyConfigured(
                "ngrok URLs cannot be used when MPESA_ENVIRONMENT=production."
            )


validate_env()
