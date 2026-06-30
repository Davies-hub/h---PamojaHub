"""Custom DRF exception handler. Wraps DRF's default; also maps django-ratelimit's
Ratelimited exception to a 429 response (without this mapping django-ratelimit's
`block=True` would propagate the exception and DRF would return 500).
"""

from django_ratelimit.exceptions import Ratelimited
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler


def custom_exception_handler(exc, context):
    """Wraps DRF's default handler. Returns a consistent error envelope.

    Ratelimited handling: django-ratelimit raises `Ratelimited` (a Django exception,
    not a DRF exception), which DRF's default handler ignores. We catch it here and
    convert to HTTP 429 so blocked clients see the right status code.
    """
    if isinstance(exc, Ratelimited):
        return Response(
            {'detail': 'Too many requests. Please try again later.'},
            status=status.HTTP_429_TOO_MANY_REQUESTS,
        )
    return exception_handler(exc, context)
