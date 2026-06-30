"""Shared DRF permission classes — the multi-tenant security boundary.

These classes are the LAST line of defence between an authenticated user and
another church's data. The Build Guide's first-pass `ChurchScopedPermission` had
two fail-open holes (None == None comparison; AttributeError fall-through on the
object→church lookup). This module's implementations close both.

CRITICAL invariant (also stated on ChurchScopedPermission): DRF does NOT call
`has_object_permission` on LIST endpoints. Any view returning a list must
independently scope its `get_queryset()` to `request.user.church`. Relying on
ChurchScopedPermission alone for a list endpoint WILL leak other churches' data.
This is the half the permission class structurally cannot enforce — it is a
review item for every list view in Step 2.8+.
"""

import hashlib

from django.utils import timezone
from rest_framework.permissions import BasePermission


def _client_ip(request):
    """Best-effort client IP. In production behind a proxy, X-Forwarded-For would
    need careful parsing; for now REMOTE_ADDR is sufficient and is the same source
    django-ratelimit's `ip` key reads from.
    """
    return request.META.get('REMOTE_ADDR') or ''


class IsChurchTreasurer(BasePermission):
    def has_permission(self, request, view):
        return bool(
            request.user
            and request.user.is_authenticated
            and request.user.role == 'CHURCH_TREASURER'
        )


class IsSuperAdmin(BasePermission):
    def has_permission(self, request, view):
        return bool(
            request.user
            and request.user.is_authenticated
            and request.user.role == 'SUPER_ADMIN'
        )


class ChurchNotSuspended(BasePermission):
    """State-changing Church Treasurer actions require an actionable church.

    Allowed church statuses (allowlist): PENDING, ACTIVE.
    Denied: SUSPENDED, REJECTED, any future status not in the allowlist, and
    `church is None`.

    The allowlist semantics are FAIL-CLOSED for any new status added later:
    a new ChurchStatus value silently defaults to DENIED rather than allowed.
    The deny-by-comparison-to-'SUSPENDED' form would have fail-OPENED on
    REJECTED (added in Step 2.9c) — the allowlist closes that hole and any
    similar one in the future.

    Fail-closed on church=None: the `user.church is not None` guard short-circuits
    to deny when there is no church, mirroring the ChurchScopedPermission user_church-
    None fix. Do NOT simplify the form — the None guard is load-bearing.

    This is the VIEW-LEVEL gate (has_permission only) — it does not need object-level
    logic; the gate is a property of the acting user's church, not the target object.

    Pairing with other permissions:
      * For state-changing views WITHOUT object scope (create campaign, create
        group-label, PATCH /churches/me/): permission_classes = [ChurchNotSuspended]
      * For state-changing views WITH object scope (edit/pause/resume/close/post-update,
        edit/archive/unarchive group-label, approve/reject/retry withdrawal):
        permission_classes = [ChurchNotSuspended, ChurchScopedPermission].
      * READ endpoints MUST NOT use ChurchNotSuspended — a non-actionable church
        can still SEE its data. Use IsChurchTreasurer (+ ChurchScopedPermission
        for detail).

    String literals (rather than ChurchStatus.XXX) are intentional: common/ is
    imported very early and we avoid pulling churches.models at module-load
    time. The literals are the enum VALUES as defined on ChurchStatus — they
    cannot drift, and ChurchStatusEnumLiteralDriftGuard in
    tests/test_permissions.py turns any drift into CI failure.
    """

    message = 'Your church account is not active. Contact PamojaHub support.'

    ALLOWED_STATUSES = ('PENDING', 'ACTIVE')

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and user.role == 'CHURCH_TREASURER'
            and user.church is not None          # fail-closed on no church
            and user.church.status in self.ALLOWED_STATUSES
        )


def resolve_object_church(obj):
    """Walk from any church-scoped object to its owning Church, or None.

    Handles the known object→church paths in the schema:
      - Campaign, GroupLabel, Church-direct:  obj.church
      - Donation, Withdrawal, CampaignUpdate: obj.campaign.church
    Returns the Church instance or None. Explicit and total — no silent
    AttributeError, no accidental fall-through. A new model that needs church
    scoping must be added here explicitly; the resolver does not guess.
    """
    # Direct church (Campaign, GroupLabel, or a Church instance itself)
    church = getattr(obj, 'church', None)
    if church is not None:
        return church
    # Via campaign (Donation, Withdrawal, CampaignUpdate)
    campaign = getattr(obj, 'campaign', None)
    if campaign is not None:
        return getattr(campaign, 'church', None)
    return None


class ChurchScopedPermission(BasePermission):
    """Object-level multi-tenant isolation: the object must belong to the
    requesting user's church.

    CRITICAL: this is ONLY the object-level half of multi-tenant isolation.
    DRF does NOT call has_object_permission on LIST endpoints — list views must
    independently scope their get_queryset() to request.user.church. A view that
    relies on this permission alone for a list endpoint WILL leak other churches'
    data. See Step 2.8+ view requirements.

    Fail-closed: access is granted ONLY when both the user's church and the
    object's church resolve to the same non-None Church.
    """

    def has_permission(self, request, view):
        # View-level: must be an authenticated church treasurer at minimum.
        return bool(
            request.user
            and request.user.is_authenticated
            and request.user.role == 'CHURCH_TREASURER'
        )

    def has_object_permission(self, request, view, obj):
        user_church = getattr(request.user, 'church', None)
        if user_church is None:
            # No church → no church-scoped access. Fail closed.
            # This closes the None == None fail-open hole — a Super Admin or
            # a malformed user with church=None cannot match a record whose
            # church also happens to be None.
            return False
        obj_church = resolve_object_church(obj)
        if obj_church is None:
            # Couldn't resolve object's church → deny. Fail closed.
            # Prevents fall-through when a new model is added without updating
            # resolve_object_church.
            return False
        return obj_church == user_church


class HasValidPortalToken(BasePermission):
    """IP-bound, time-limited, campaign-scoped portal token auth for Campaign
    Treasurers (phone-gated; no user account).

    Validation — ALL must hold, fail closed on any miss:
      1. Token present in a portal header (X-Portal-Token, or `Authorization: Portal <raw>`)
         and resolves to a non-revoked PortalToken row by token_hash.
      2. Not expired (expires_at > now).
      3. is_revoked is False.
      4. Request IP equals the token's bound ip_address (and the bound IP is non-empty).

    Campaign-scope (is the requested campaign in this token's campaign_ids) is
    enforced in the VIEW, not here, because has_permission does not have clean
    access to URL kwargs across all DRF versions. has_permission attaches the
    validated token to `request.portal_token` so the view can do the scope check
    and read phone_number / campaign_ids.

    Empty bound IP mirrors the ChurchScopedPermission fail-closed pattern: a
    token with no bound IP can never match. Every PortalToken issued by
    /verify-otp MUST set a real ip_address — this branch is the safety net.
    """

    def has_permission(self, request, view):
        # Local import — common.permissions is imported very early and we want to
        # avoid pulling treasurer_portal at module-load time.
        from treasurer_portal.models import PortalToken

        raw = self._extract_token(request)
        if not raw:
            return False

        token_hash = hashlib.sha256(raw.encode('utf-8')).hexdigest()
        try:
            token = PortalToken.objects.get(token_hash=token_hash)
        except PortalToken.DoesNotExist:
            return False

        if token.is_revoked:
            return False
        if token.expires_at <= timezone.now():
            return False

        bound_ip = token.ip_address or ''
        client_ip = _client_ip(request)
        if bound_ip == '' or bound_ip != client_ip:
            # Fail closed: no bound IP (data integrity miss) or mismatch.
            return False

        # Validated — attach for the view to read campaign scope + phone.
        request.portal_token = token
        return True

    def has_object_permission(self, request, view, obj):
        # Object-level scoping is the view's job (compare URL kwarg against
        # request.portal_token.campaign_ids). Don't allow accidental open access here.
        return False

    def _extract_token(self, request):
        """Dedicated portal header — never collides with JWT 'Bearer <jwt>' auth.

        Order: X-Portal-Token wins; falls back to `Authorization: Portal <raw>`.
        """
        header = request.META.get('HTTP_X_PORTAL_TOKEN', '')
        if header:
            return header.strip()
        auth = request.META.get('HTTP_AUTHORIZATION', '')
        if auth.startswith('Portal '):
            return auth[len('Portal '):].strip()
        return ''
