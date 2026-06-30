"""Standard DRF pagination class for list endpoints.

Minimal implementation for Step 2.3 — referenced by REST_FRAMEWORK.DEFAULT_PAGINATION_CLASS.
Page size override per view can be added later via PaginationMixin or per-view subclasses.
"""

from rest_framework.pagination import PageNumberPagination


class StandardPagination(PageNumberPagination):
    page_size = 20
    page_size_query_param = 'page_size'
    max_page_size = 100
