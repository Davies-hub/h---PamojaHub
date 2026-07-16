from django.apps import AppConfig


class DonationsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'donations'

    def ready(self):
        # Registers the pamoja.E001/E002 M-Pesa callback system checks
        # (@register runs at import). Donations owns the primary callback
        # route, so it hosts the registration.
        from config import checks  # noqa: F401
