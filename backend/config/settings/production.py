"""Production settings — full hardening (Redis cache, HTTPS, HSTS) is a later deployment concern."""

from .base import *  # noqa: F401,F403

DEBUG = False
ALLOWED_HOSTS = env.list('ALLOWED_HOSTS')

# Production cache (Redis) and security headers are configured during deployment,
# not in this file. Step 2.3 keeps production.py minimal.
