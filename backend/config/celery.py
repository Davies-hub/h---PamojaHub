"""Celery app for Pamoja Hub (Step 2.10c).

Hosts the B2C stuck-PROCESSING reconciliation sweep. The app is created here and
imported from config/__init__.py so `@shared_task`s register on it and
`autodiscover_tasks` picks up each app's tasks.py. The broker is only contacted
when a worker/beat runs — `manage.py check`, the test suite (which calls the
sweep function directly), and the web process never connect to it.
"""

import os

from celery import Celery

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.development')

app = Celery('pamoja')
app.config_from_object('django.conf:settings', namespace='CELERY')
app.autodiscover_tasks()
