"""Development settings — local Windows machine, dummy external-service credentials."""

from .base import *  # noqa: F401,F403

DEBUG = True
# '.ngrok-free.dev' is a leading-dot wildcard for the ephemeral ngrok tunnel used
# in live Daraja sandbox callback testing (subdomain recycles each session). Dev-only.
ALLOWED_HOSTS = ['localhost', '127.0.0.1', '.ngrok-free.dev']

# Non-empty in dev so the secret-path callback routes are active locally and the
# test suite exercises them (reverse() yields the secret path). Override via env
# for live sandbox testing — the ngrok callback URLs registered with Daraja must
# then include this exact /<secret>/ segment.
MPESA_CALLBACK_SECRET = env('MPESA_CALLBACK_SECRET', default='dev-callback-secret')

# Dev cache for django-ratelimit — in-process locmem.
CACHES = {
    'default': {
        'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
    }
}
RATELIMIT_USE_CACHE = 'default'
