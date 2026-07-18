"""Auth endpoints — register, login, refresh, logout, password-reset request/confirm.

SECURITY invariants (all enforced by code below — referenced in tests):
  * Refresh tokens persisted ONLY as SHA-256 hashes (RefreshToken.token_hash).
  * Password-reset OTPs persisted ONLY as SHA-256 hashes (PasswordResetOTP.otp_hash).
  * Register is wrapped in transaction.atomic() — Church and User commit together or
    neither commits. The atomicity is verified in tests/test_auth_register.py::Test 2.
  * Login emits generic 401 ("Invalid email or password") regardless of whether the
    email exists — no email enumeration.
  * Password-reset/request returns an IDENTICAL 200 response regardless of whether
    the email exists — no email enumeration.
  * Password-reset/confirm caps brute force at 5 attempts per OTP; on the 5th wrong
    try the OTP is marked is_used=True even if no further request comes in.
  * Login is allowed for PENDING and SUSPENDED churches — frontend branches on
    `church_status` in the response. SUSPENDED-church enforcement on state-changing
    actions is the Step 2.9 layer's job, NOT login's.

Rate limits (django-ratelimit, locmem cache in dev — see config/settings/development.py):
  * login                       → 5 / 15min per IP
  * password-reset/request      → 3 / hour per IP AND 3 / hour per email
  * password-reset/confirm      → 5 attempts per OTP, model-side counter
"""

import logging
import uuid
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import authenticate
from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.decorators import method_decorator
from django_ratelimit.decorators import ratelimit
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken as JWTRefreshToken

from accounts.models import PasswordResetOTP, RefreshToken, User, UserRole
from accounts.serializers import (
    LoginSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    UserSerializer,
)
from accounts.utils import generate_otp, hash_token
from audit.models import AuditLog
from churches.models import Church, ChurchStatus
from churches.serializers import ChurchRegistrationSerializer
from common.masking import mask_email
from integrations.object_storage import ObjectStorageClient, ObjectStorageError
from integrations.resend_email import (
    EmailDeliveryError,
    send_password_changed,
    send_password_reset_otp,
    send_registration_received,
)
from media.models import MediaAsset, MediaKind
from media.validation import MAX_UPLOAD_BYTES, validate_and_reencode

logger = logging.getLogger(__name__)


def _client_ip(request):
    """Best-effort client IP. Note: in production behind a proxy, X-Forwarded-For
    would need to be parsed with care; for now REMOTE_ADDR is sufficient (and the
    proxy stripping concern is identical for django-ratelimit's `ip` key).
    """
    return request.META.get('REMOTE_ADDR') or ''


def _issue_jwt_pair(user, ip):
    """Generate access + refresh JWTs via SimpleJWT and persist the refresh hash.

    Returns (access_str, refresh_str). The refresh_str is returned to the client
    exactly once; only its hash lives in the DB.
    """
    refresh = JWTRefreshToken.for_user(user)
    refresh_str = str(refresh)
    access_str = str(refresh.access_token)
    RefreshToken.objects.create(
        user=user,
        token_hash=hash_token(refresh_str),
        expires_at=timezone.now() + timedelta(days=7),
        ip_address=ip or None,
    )
    return access_str, refresh_str


def _auth_user_payload(user):
    """Authenticated-user response body shared by login and /auth/me, so the two
    can never drift. Returns {user, church_status[, church_rejection_reason]}.

    church_rejection_reason is included ONLY when the church is REJECTED, and ONLY
    on this authenticated own-church surface (2.12b) — never on public/cross-church
    surfaces.
    """
    church_status = user.church.status if user.church else None
    body = {
        'user': UserSerializer(user).data,
        'church_status': church_status,
    }
    if church_status == ChurchStatus.REJECTED and user.church:
        body['church_rejection_reason'] = user.church.rejection_reason
    return body


# ───────────────────────── 3.1 Register ──────────────────────────────────────


def _attach_registration_logo(request, church, user, uploaded):
    """Validate + store an OPTIONAL registration logo — POST-COMMIT and orphan-safe.

    Returns True if the logo was stored (church.logo_url set to the BARE object key),
    False on ANY failure. The church is ALREADY COMMITTED when this runs, so a logo
    failure must degrade softly (the caller flags logo_failed=True) and must NEVER
    raise or roll back the registration.

    This mirrors ChurchLogoUploadView.post EXACTLY — one validation path, one orphan
    story: DoS size gate → validate_and_reencode (magic-byte + Pillow decode + re-
    encode; the RE-ENCODED bytes are stored) → put_object BEFORE the metadata commit
    (a failed commit leaves at worst a harmless orphan object, never a dangling
    logo_url) → a short atomic() writing MediaAsset + church.logo_url (bare key, per
    the 2026-07-18 key-storage slice) + AuditLog. A brand-new church has no prior
    logo, so delete_prior_assets is intentionally not called here.
    """
    # DoS gate — declared size, then capped read (identical to the logo view).
    if uploaded.size > MAX_UPLOAD_BYTES:
        return False
    raw = uploaded.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        return False

    # Content gate — validate_and_reencode raises ValidationError on a non-image /
    # corrupt / out-of-bounds upload. We SWALLOW it (soft-degrade), never surface 400.
    try:
        clean_bytes, content_type = validate_and_reencode(raw)
    except ValidationError:
        return False

    ext = 'jpg' if content_type == 'image/jpeg' else 'png'
    key = f'church/{church.id}/logo/{uuid.uuid4().hex}.{ext}'   # server keygen

    client = ObjectStorageClient()
    try:
        result = client.put_object(key, clean_bytes, content_type)   # PUT before commit
    except ObjectStorageError:
        return False

    with transaction.atomic():                          # metadata AFTER confirmed PUT
        asset = MediaAsset.objects.create(
            kind=MediaKind.LOGO, church=church, campaign=None,
            object_key=result['key'], bucket=settings.S3_BUCKET_NAME,
            content_type=content_type, size_bytes=len(clean_bytes),
            uploaded_by=user,
        )
        # Bare OBJECT KEY — the absolute URL is minted at serialization time (media_url).
        church.logo_url = result['key']
        church.save(update_fields=['logo_url'])
        AuditLog.objects.create(
            actor=user, action='CHURCH_LOGO_UPLOADED',
            entity_type='Church', entity_id=church.id,
            details={'church_id': str(church.id), 'object_key': result['key'],
                     'asset_id': str(asset.id)},
            ip_address=_client_ip(request) or None,
        )
    return True


@method_decorator(
    ratelimit(key='ip', rate='3/h', method='POST', block=True),
    name='post',
)
class RegisterView(APIView):
    """POST /api/v1/auth/register/ — create Church (PENDING) + Church Treasurer user.

    Wrapped in transaction.atomic() so either both rows commit or neither does.
    No orphan church if user creation fails (e.g. duplicate email at the user layer).

    Rate limit: 3/h per IP (block=True → 429). Registration is a once-ever action, so
    this is a hard cap on register spam AND on the now-more-expensive optional-logo
    path (an anonymous Pillow re-encode + storage PUT per POST) — the guard fires
    BEFORE post() runs, so a blocked request never reaches the transaction or the image.

    Optional logo (multipart field `logo`): accepted via the DRF DEFAULT parsers
    (JSON + form + multipart — no parser_classes needed). It is handled POST-COMMIT
    by _attach_registration_logo, OUTSIDE the church/user transaction: the church is
    committed first, then a logo failure degrades softly to logo_failed=True in the
    201 body — it can NEVER roll back a successful registration.
    """

    permission_classes = [AllowAny]

    def post(self, request):
        serializer = ChurchRegistrationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # Defence in depth: the serializer's validate_official_email() now checks
        # BOTH User.email and Church.official_email up front (Fix 1). This try/except
        # catches the residual race condition — two simultaneous registrations with
        # the same email passing serializer validation before either commits — and
        # converts the resulting DB unique-constraint failure into a clean 400
        # instead of a 500.
        try:
            with transaction.atomic():
                church = Church.objects.create(
                    name=data['name'],
                    official_email=data['official_email'],
                    phone=data['phone'],
                    address=data['address'],
                    # county is optional now — absent or blank → NULL.
                    county=data.get('county') or None,
                    denomination=data['denomination'],
                    status=ChurchStatus.PENDING,
                )
                user = User.objects.create_user(
                    email=data['official_email'],
                    password=data['password'],
                    # first/last name optional now — absent → '' (serializer default).
                    first_name=data.get('first_name', ''),
                    last_name=data.get('last_name', ''),
                    role=UserRole.CHURCH_TREASURER,
                    church=church,
                )

                # GAP: notifications.NotificationType has no enum value matching
                # "new church registration". The closest existing types are
                # DONATION_RECEIVED / DISBURSEMENT_* / SUBSCRIPTION_* — none fit.
                # Per Step 2.7 instructions, do NOT invent an enum value here; the
                # AuditLog entry below preserves the trail. A `CHURCH_REGISTERED`
                # NotificationType (or a separate SuperAdminNotification surface) is
                # the right fix and is flagged for the next notifications-touching
                # step.
                AuditLog.objects.create(
                    actor=user,
                    action='CHURCH_REGISTERED',
                    entity_type='Church',
                    entity_id=church.id,
                    details={'church_name': church.name, 'county': church.county},
                    ip_address=_client_ip(request) or None,
                )
        except IntegrityError:
            return Response(
                {'detail': 'An account with this email already exists.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Optional logo — POST-COMMIT, orphan-safe. The church is already committed;
        # a logo failure must NEVER roll back a successful registration. So we attach
        # OUTSIDE the transaction and degrade softly: on any logo problem (missing/
        # oversized/bad-format/re-encode reject/storage down) church.logo_url stays
        # NULL and the 201 body carries logo_failed=True. The field is present ONLY
        # when a logo was actually submitted, so the pure-JSON (no-logo) response
        # shape is unchanged.
        logo_failed = None
        uploaded = request.FILES.get('logo')
        if uploaded is not None:
            logo_failed = not _attach_registration_logo(request, church, user, uploaded)

        # Onboarding acknowledgement — courtesy, OUTSIDE the transaction (it has
        # already committed). send_registration_received swallows delivery failures,
        # so a bad email send can never undo a successful registration.
        send_registration_received(email=church.official_email, church_name=church.name)

        body = {
            'user': UserSerializer(user).data,
            'church_status': church.status,
        }
        if logo_failed is not None:
            body['logo_failed'] = logo_failed
        return Response(body, status=status.HTTP_201_CREATED)


# ───────────────────────── 3.2 Login ─────────────────────────────────────────


@method_decorator(
    ratelimit(key='ip', rate='5/15m', method='POST', block=True),
    name='post',
)
class LoginView(APIView):
    """POST /api/v1/auth/login/ — 5/15min per IP.

    Login allowed for PENDING and SUSPENDED churches (response carries church_status
    so the frontend can branch). SUSPENDED-church enforcement on state-changing
    actions is the Step 2.9 layer's job.
    """

    permission_classes = [AllowAny]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data['email']
        password = serializer.validated_data['password']

        user = authenticate(request, username=email, password=password)
        if user is None or not user.is_active:
            # Generic failure — does NOT reveal whether the email exists.
            return Response(
                {'detail': 'Invalid email or password.'},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        access, refresh = _issue_jwt_pair(user, _client_ip(request))

        # church_status (and, when REJECTED, church_rejection_reason) come from the
        # SHARED _auth_user_payload helper — the SAME computation /auth/me uses, so a
        # restored session can never see a different church state than login showed.
        body = {'access': access, 'refresh': refresh}
        body.update(_auth_user_payload(user))

        return Response(body, status=status.HTTP_200_OK)


# ───────────────────────── 3.3 Refresh ───────────────────────────────────────


class TokenRefreshView(APIView):
    """POST /api/v1/auth/token/refresh/ — rotates refresh token on every use.

    Step: verify JWT signature/expiry via SimpleJWT, then look up token_hash in our
    own RefreshToken table. Reject if revoked or unknown. On success: revoke old row,
    issue new pair, persist new hash.
    """

    permission_classes = [AllowAny]

    def post(self, request):
        raw = request.data.get('refresh')
        if not raw:
            return Response(
                {'detail': 'Refresh token is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            jwt_obj = JWTRefreshToken(raw)
        except Exception:
            return Response(
                {'detail': 'Invalid or expired refresh token.'},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        token_hash = hash_token(raw)
        try:
            row = RefreshToken.objects.get(token_hash=token_hash)
        except RefreshToken.DoesNotExist:
            return Response(
                {'detail': 'Invalid or expired refresh token.'},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        if row.is_revoked or row.expires_at <= timezone.now():
            return Response(
                {'detail': 'Invalid or expired refresh token.'},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        user_id_from_jwt = jwt_obj['user_id']
        if str(row.user_id) != str(user_id_from_jwt):
            return Response(
                {'detail': 'Invalid or expired refresh token.'},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        # Rotate: revoke this row, issue + persist a new pair.
        with transaction.atomic():
            row.is_revoked = True
            row.save(update_fields=['is_revoked'])
            access, refresh = _issue_jwt_pair(row.user, _client_ip(request))

        return Response(
            {'access': access, 'refresh': refresh},
            status=status.HTTP_200_OK,
        )


# ───────────────────────── 3.4 Logout ────────────────────────────────────────


class LogoutView(APIView):
    """POST /api/v1/auth/logout/ — revokes the supplied refresh token.

    Always returns 200; does not reveal whether the token existed.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        raw = request.data.get('refresh')
        if raw:
            RefreshToken.objects.filter(
                token_hash=hash_token(raw),
                user=request.user,
            ).update(is_revoked=True)
        return Response(status=status.HTTP_200_OK)


# ───────────────────────── 3.5 Password reset request ────────────────────────


@method_decorator(ratelimit(key='post:email', rate='3/h', method='POST', block=True), name='post')
@method_decorator(ratelimit(key='ip', rate='3/h', method='POST', block=True), name='post')
class PasswordResetRequestView(APIView):
    """POST /api/v1/auth/password-reset/request/.

    EMAIL ENUMERATION PROTECTION: the response is identical regardless of whether
    the supplied email maps to a user. Only the side effect (sending an OTP) differs.
    """

    permission_classes = [AllowAny]

    GENERIC_RESPONSE = {
        'detail': 'If an account exists for this email, a reset code has been sent.',
    }

    def post(self, request):
        serializer = PasswordResetRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data['email']

        try:
            user = User.objects.get(email=email)
        except User.DoesNotExist:
            return Response(self.GENERIC_RESPONSE, status=status.HTTP_200_OK)

        # Invalidate any prior unused OTPs so only the newest is live.
        PasswordResetOTP.objects.filter(user=user, is_used=False).update(is_used=True)

        otp_plain = generate_otp()
        PasswordResetOTP.objects.create(
            user=user,
            otp_hash=hash_token(otp_plain),
            expires_at=timezone.now() + timedelta(minutes=15),
        )
        # This endpoint is EXISTENCE-OPACITY-protected (identical response whether
        # or not the email maps to a user). So a delivery failure must NOT surface:
        # a 502 here would only ever fire for an EXISTING account (a non-existent
        # email returned the generic 200 above, before any send), making the 502 an
        # "account exists" oracle (see §14). Instead, log server-side (masked) and
        # return the SAME generic 200 as Paths A and B. An unauthenticated caller
        # can't act on a delivery failure anyway (doesn't own the mailbox), so
        # surfacing it buys nothing and breaks opacity.
        try:
            send_password_reset_otp(email, otp_plain)
        except EmailDeliveryError:
            logger.exception(
                'Password-reset OTP email delivery failed for %s', mask_email(email)
            )

        return Response(self.GENERIC_RESPONSE, status=status.HTTP_200_OK)


# ───────────────────────── 3.6 Password reset confirm ────────────────────────


class PasswordResetConfirmView(APIView):
    """POST /api/v1/auth/password-reset/confirm/.

    Model-side brute-force cap: attempt_count increments on each wrong-OTP submission,
    and once it reaches MAX_ATTEMPTS the OTP is marked is_used=True (dead) regardless
    of any further requests.
    """

    permission_classes = [AllowAny]
    MAX_ATTEMPTS = 5
    GENERIC_INVALID = {'detail': 'Invalid or expired code.'}

    def post(self, request):
        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data['email']
        otp_code = serializer.validated_data['otp_code']
        new_password = serializer.validated_data['new_password']

        try:
            user = User.objects.get(email=email)
        except User.DoesNotExist:
            return Response(self.GENERIC_INVALID, status=status.HTTP_400_BAD_REQUEST)

        otp = (
            PasswordResetOTP.objects
            .filter(user=user, is_used=False, expires_at__gt=timezone.now())
            .order_by('-created_at')
            .first()
        )
        if otp is None:
            return Response(self.GENERIC_INVALID, status=status.HTTP_400_BAD_REQUEST)

        # Increment first — caps brute force even if the code is correct on the 6th try.
        otp.attempt_count += 1
        if otp.attempt_count >= self.MAX_ATTEMPTS:
            otp.is_used = True
            otp.save(update_fields=['attempt_count', 'is_used'])
            return Response(self.GENERIC_INVALID, status=status.HTTP_400_BAD_REQUEST)

        if hash_token(otp_code) != otp.otp_hash:
            otp.save(update_fields=['attempt_count'])
            return Response(self.GENERIC_INVALID, status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            user.set_password(new_password)
            user.save(update_fields=['password'])
            otp.is_used = True
            otp.save(update_fields=['attempt_count', 'is_used'])
            # A password reset invalidates EVERY refresh token for the user.
            RefreshToken.objects.filter(user=user, is_revoked=False).update(is_revoked=True)
            AuditLog.objects.create(
                actor=user,
                action='PASSWORD_RESET',
                entity_type='User',
                entity_id=user.id,
                details={},
                ip_address=_client_ip(request) or None,
            )

        send_password_changed(email)
        return Response(status=status.HTTP_200_OK)


# ───────────────────────── 3.7 Current user (/me) ────────────────────────────


class MeView(APIView):
    """GET /api/v1/auth/me/ — the authenticated user, for session restore on launch.

    SECURITY: the returned user is derived from the JWT ONLY — `request.user`, which
    SimpleJWT's JWTAuthentication populates from the Bearer token. This view reads NO
    query param and NO request body; there is deliberately no `id`/`user` input, so a
    client CANNOT request anyone else's record (the absence of the param is the
    guarantee). The response shape is IDENTICAL to login's user payload (same
    _auth_user_payload helper) so the frontend's mapUser handles both.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(_auth_user_payload(request.user), status=status.HTTP_200_OK)
