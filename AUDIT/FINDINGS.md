# PamojaHub Audit — FINDINGS

> Every finding uses the schema block from the harness. Appended live as discovered.
> Severity: CRITICAL = money loss / auth bypass / cross-tenant leak / RCE.
> HIGH = privilege issue, sensitive leak, broken money path under edge.
> MEDIUM = incorrect behavior, missing guard w/ mitigation, exploitable w/ effort.
> LOW = minor/UX/hardening. INFO = dead code, style, observation.

---

## PHASE 1 — AUTH & AUTHZ

### [PH1-01] Logout does not invalidate the access token (60-min stateless window)
- **Severity:** LOW
- **Category:** Auth
- **Location:** backend/accounts/views.py:293 LogoutView; SIMPLE_JWT ACCESS_TOKEN_LIFETIME=60min (config/settings/base.py:119)
- **Repro:** Login → POST /auth/logout/ {refresh}. The refresh token is revoked (verified: refresh after logout → 401). But the access token issued at login still authenticates: `GET /auth/me/` with the pre-logout access token → 200 after logout.
- **Observed:** Access token remains valid for up to 60 min after logout (no access-token blacklist; `rest_framework_simplejwt.token_blacklist` is not installed and not used).
- **Expected:** For a financial app, a logged-out / stolen access token ideally stops working promptly. Standard stateless-JWT tradeoff, but the 60-min lifetime widens the window.
- **Suggested fix (NOT APPLIED):** Shorten ACCESS_TOKEN_LIFETIME (e.g. 5–15 min) so logout/rotation closes the window quickly; or add a lightweight access-token denylist (jti) checked in authentication for high-value sessions.
- **Status:** OPEN

### [PH1-VERIFIED] JWT guards confirmed holding (no finding)
- alg=none forged token → 401. Tampered payload (flipped user_id) with original signature → 401 (HS256 signature verified). Expired access token (signed) → 401.
- **Claim-injection resistant:** a validly-signed token carrying `role=SUPER_ADMIN`/`is_superuser=True` for treasurer A still gets 403 on `/super/churches/` — DRF permissions read `request.user.role` from the DB, not from JWT claims. Access token carries only `user_id` (+ token_type/exp/iat/jti); no role/church claim to trust.
- **Refresh rotation:** first refresh → 200; replaying the OLD refresh → 401 (custom accounts.RefreshToken row revoked on rotation); the rotated refresh works exactly once. SimpleJWT signature/expiry + own-table hash lookup + user_id match all enforced (accounts/views.py:230 TokenRefreshView). [Resolves INVENTORY lead #2 — blacklist app absence is compensated by the custom RefreshToken table.]
- **Logout authZ:** logout filters revocation by `user=request.user`, so treasurer B cannot revoke treasurer A's refresh (A's refresh still valid after B's logout attempt). Logout is `IsAuthenticated`.

### [PH1-VERIFIED] Privilege escalation + cross-tenant IDOR — all guards hold (no finding)
Tested live as treasurer A vs church B objects, treasurer token vs all /super/, and anon:
- **List scoping:** `/campaigns/mine/`, `/withdrawals/`, `/churches/me/donations/` each return ONLY the caller's church rows (A sees alpha-build only; B sees beta-outreach only — no cross-leak). Confirms get_queryset() church-scoping on every list view (the half ChurchScopedPermission structurally can't enforce).
- **Cross-tenant object access (A→B):** GET/pause/resume/close `campaigns/mine/beta-outreach/` → 403; PATCH/archive/GET `group-labels/{B}` → 403; approve/reject/retry `withdrawals/{B}` → 403. All money/state actions on another tenant's objects rejected.
- **Privilege escalation:** treasurer token on all 8 `/super/` GETs → 403; all 9 `/super/` writes (approve/reject/suspend/reactivate/set-tier/force-retry/resolve-paid/resolve-retry/billing PATCH) → 403. PermissionInversion holds on every door.
- **Unauthenticated:** `/auth/me/`, `/campaigns/mine/`, `/withdrawals/`, `/super/churches/`, `/churches/me/`, `/notifications/`, `/churches/me/stats/` → 401.
- Script: AUDIT/scripts/p1_idor.py. Note: notification-by-id cross-recipient IDOR not exercised (no notifications seeded) — code path recipient=request.user / foreign→404 to confirm in Phase 3.

### [PH1-VERIFIED] Mass assignment — all privileged/cross-tenant fields rejected (no finding)
Live as treasurer A (AUDIT/scripts/p1_massassign.py):
- **PATCH /churches/me/** with status/subscription_tier/official_email/subscription_cancel_requested/subscription_expires_at → 200 but ALL privileged fields unchanged (read_only_fields in AdminChurchSerializer). Only profile fields (name/phone/etc/description) are writable.
- **POST /campaigns/mine/create/** with raised_amount=999999, wallet_balance=888888, status=CLOSED, church=<church B id>, created_by=<other> → 201 but raised/wallet forced to 0.00, status forced ACTIVE, ownership forced to caller's church (Audit Alpha Church). Server-managed fields honored read_only; create view ignores client status.
- **POST /group-labels/** parent_label=<church B's group id> → 400 (parent ownership validated in view; not a cross-tenant mass-assign).
- **POST /group-labels/** church=<church B id> → 201 but label belongs to A (in A's list, not B's); `church` is set from request.user.church, not the body.
- Withdrawal create (WithdrawalRequestSerializer) structurally accepts only `amount`+`reason` (status/destination server-side) — confirmed by code; live-exercised in Phase 1.4/6 with a portal token.
- NOTE: audit DB now carries test artifacts (campaign "massassign-test" + 2 extra group labels on church A). Re-seed/reset pamoja_audit before Phase 6 E2E count-sensitive checks.

### [PH1-02] request-otp enumeration via timing side channel (synchronous SMS on known path)
- **Severity:** MEDIUM
- **Category:** Data-leak (enumeration) / Auth
- **Location:** backend/treasurer_portal/views.py:117-164 RequestOTPView.post (the `send_portal_otp(...)` synchronous call at L154 happens only on the KNOWN path; unknown path short-circuits at L137)
- **Repro:** POST /api/v1/treasurer/request-otp/ with an unknown phone vs a known campaign-treasurer phone (254712000001). Measure latency. Live result: UNKNOWN → 200 in **117ms**; KNOWN → (200 in prod / 502 on dev creds) in **2689ms**. Timing delta ≈ **2572ms**.
- **Observed:** Response *body* is byte-identical (good — "If this number is registered…"), but the known path performs a synchronous Africa's Talking SMS network call inside the request, so its latency is seconds vs the unknown path's ~100ms. This is a trivially-distinguishable enumeration oracle for which phone numbers are registered campaign treasurers — far above network jitter. Secondary: each known probe sends a REAL SMS to a REAL treasurer (cost + nuisance amplification). On dev/failing-SMS creds the status also splits (502 vs 200), an additional oracle whenever AT delivery fails.
- **Expected:** Known and unknown phones should be indistinguishable by timing AND status. The code comment (L106-114) acknowledges timing "differs" but characterizes it as low-value microsecond hashing — in reality it's a multi-hundred-ms-to-seconds synchronous third-party network call.
- **Mitigation present:** request-otp is rate-limited 3/10m per IP AND 3/10m per normalized phone (django-ratelimit), which slows single-source enumeration; distributed IPs still enable phone-space enumeration.
- **Suggested fix (NOT APPLIED):** Move the SMS send off the request path (enqueue async/Celery) so both paths return immediately with identical timing and status; or perform equivalent dummy work on the unknown path. (Tradeoff: loses the synchronous 502 "code didn't send" signal — acceptable; the treasurer retries if no SMS arrives.)
- **Status:** OPEN

### [PH1-VERIFIED] Portal OTP/token security — all other guards hold (no finding)
Live (AUDIT/scripts/p1_portal.py):
- **OTP hashing:** CampaignTreasurerOTP.otp_code stored as 64-hex SHA-256; plaintext only in SMS. PortalToken.token_hash 64-hex.
- **verify-otp:** wrong code → 400; correct → 200 with portal_token + scoped campaigns.
- **Per-OTP brute-force cap:** attempt_count→5 marks OTP is_used; correct code after cap → 400 (OTP dead). (Per-phone 5/h decorator present; threshold confirmed in 1.7.)
- **Portal token IP-binding (HasValidPortalToken) — all fail-closed:** ip-mismatch (9.9.9.9) → 401; empty bound IP → 401; expired (TTL 30m) → 401; revoked → 401; valid (127.0.0.1) → 200.
- **Campaign scope:** in-scope campaign disbursements → 200; out-of-scope campaign → 403 (view-level _campaign_in_scope, not serializer masking).
- **Header isolation:** a raw portal token presented as `Authorization: Bearer <portal>` on the JWT path → 401 (portal token is not a JWT; the two credential paths don't cross).

### [PH1-03] Audit-log immutability in prod depends on a manual, non-migration REVOKE
- **Severity:** MEDIUM
- **Category:** Config
- **Location:** backend/audit/models.py:30-48 (Python guard only catches instance .save()/.delete(), NOT QuerySet.update()/.delete()); DB-level REVOKE documented in backend/docs/production_db_hardening.md, applied manually (not a migration).
- **Repro:** `has_table_privilege('pamoja_app','audit_auditlog','UPDATE'/'DELETE')` — pamoja_dev = false/false (REVOKE applied); a freshly-migrated DB (pamoja_audit) = true/true (REVOKE absent).
- **Observed:** Full audit immutability relies on a manual REVOKE that is NOT carried by any migration, so any newly provisioned/restored prod DB starts WITHOUT it. Until run, the app role can `UPDATE`/`DELETE` audit_auditlog via QuerySet ops (the Python model guard is bypassed by .update()/.delete()).
- **Expected:** The money/permission audit trail should be immutable by construction on every environment.
- **Suggested fix (NOT APPLIED):** Add the REVOKE as a Django migration (RunSQL) or a post-deploy gate that fails startup if the privileges are not revoked; ensure it's on the launch checklist (PamojaHub_Deploy_Checklist.md).
- **Status:** OPEN

### [PH1-VERIFIED] Audit actor integrity + coverage (no finding)
- **No forged-actor vector:** every `AuditLog.objects.create(...)` across the codebase sets `actor` server-side (`request.user`, or `actor=None`+`actor_phone` for portal/system/callback flows) — none read actor/actor_phone from client input. (35 create sites enumerated.)
- **Coverage of money/permission actions confirmed:** superadmin views write audit rows for approve/reject/suspend/reactivate/set-tier/force-retry/resolve-paid/resolve-retry/billing; withdrawals approve/reject/retry + services finalize/dispatch; churches set_church_tier + subscription; campaigns create/pause/resume/close/update; accounts register + password-reset; portal otp-verified + disbursement-requested.
- **Live:** super suspend church B → CHURCH_SUSPENDED audit row with actor_email=super@audit.test, ip_address=127.0.0.1, entity_type=Church (fixture restored via reactivate). Script: AUDIT/scripts/p1_audit.py.

### [PH1-04] password-reset/request enumeration via timing (synchronous email send on known path)
- **Severity:** LOW
- **Category:** Data-leak (enumeration)
- **Location:** backend/accounts/views.py:329-363 PasswordResetRequestView.post (send_password_reset_otp at L357 runs only when the email maps to a user; unknown email returns the generic 200 at L337 before any send)
- **Repro:** POST /auth/password-reset/request/ unknown vs known email; measure latency. Live: UNKNOWN → 200 in **112ms**; KNOWN → 200 in **1192ms** (delta ≈ **1081ms**). Bodies byte-identical (good).
- **Observed:** Account existence is disclosed via response timing (synchronous Resend email call on the known path), and each known probe sends a real email. Same root cause as [PH1-02] on a different surface.
- **Mitigation present:** throttled 3/h per IP AND 3/h per email.
- **Suggested fix (NOT APPLIED):** Same as PH1-02 — send the reset email asynchronously so both paths return with identical timing. One fix (move external sends off the request path) closes both PH1-02 and PH1-04.
- **Status:** OPEN

### [PH1-VERIFIED] Password-reset confirm flow (no finding)
Live (AUDIT/scripts/p1_reset.py, throwaway user):
- Wrong code → 400; correct → 200 (password changed, verified via ORM check_password). OTP single-use: reuse → 400 (is_used).
- Expired OTP → 400, password unchanged. OTP stored as SHA-256 hash; brute-force capped by attempt_count (≥5 → is_used).
- **No cross-account hijack:** victim email + attacker's own OTP code → 400 (OTP looked up filtered by the email's user; an OTP issued to one user cannot reset another).
- **Reset revokes all refresh tokens:** live refresh count 1 → 0 after reset (accounts/views.py:419).

## PHASE 1.7 — RATE-LIMIT COVERAGE

### [PH1-05] Production rate-limiting is per-process + IP detection is REMOTE_ADDR-only
- **Severity:** MEDIUM
- **Category:** Config
- **Location:** backend/config/settings/production.py (no CACHES, no RATELIMIT_USE_CACHE — only base + DEBUG/ALLOWED_HOSTS); RATELIMIT_USE_CACHE set ONLY in development.py:16; common/permissions.py:22 + accounts/views.py:60 `_client_ip` = `REMOTE_ADDR` only (no X-Forwarded-For parsing).
- **Observed:** As committed, production has no shared (Redis) cache, so django-ratelimit falls back to per-process LocMemCache → with N gunicorn workers every throttle (login 5/15m, OTP 3/10m, donation 10/h, etc.) becomes effectively N× looser and non-deterministic. Separately, behind the usual reverse proxy, REMOTE_ADDR is the proxy's IP, so every `key='ip'` limit collapses into ONE global bucket (legitimate users collectively trip it = availability hit; attackers are indistinguishable) AND the portal token IP-binding (HasValidPortalToken) binds to the proxy IP, neutralizing it.
- **Expected:** A shared cache backing rate limits across workers, and trustworthy client-IP derivation (parse XFF from the known proxy) so per-IP limits + portal IP-binding are meaningful in production.
- **Suggested fix (NOT APPLIED):** Configure a shared cache (Redis) + RATELIMIT_USE_CACHE in production settings; derive client IP from a trusted proxy header (django's `SECURE_PROXY` / a vetted XFF parse). Add to launch checklist.
- **Status:** OPEN

### [PH1-06] Donation initiate has no per-IP throttle → STK-push spam to arbitrary phones
- **Severity:** MEDIUM
- **Category:** Config / Other (abuse/cost)
- **Location:** backend/donations/views.py:64-65 DonationInitiateView — single `@ratelimit(key=normalized_phone_key, rate='10/h')`; no `key='ip'` companion. AllowAny.
- **Repro:** POST /donations/initiate/ with a valid campaign_slug, amount≥5, rotating phone_number values from one IP. Each call triggers a real STK push prompt to the supplied number.
- **Observed:** An unauthenticated attacker can send STK-push prompts to many different Kenyan numbers (harassment + Daraja transaction cost), bounded only by 10/h PER NUMBER — there is no per-IP ceiling on the number of distinct targets.
- **Expected:** A per-IP limit on initiate (in addition to per-phone) to cap how many distinct STK prompts one source can trigger.
- **Suggested fix (NOT APPLIED):** Add `@ratelimit(key='ip', rate=...)` to DonationInitiateView (mirrors request-otp's dual key).
- **Status:** OPEN

### [PH1-07] No per-account throttle on login (distributed brute-force / credential stuffing)
- **Severity:** LOW
- **Category:** Auth
- **Location:** backend/accounts/views.py:188 LoginView — `@ratelimit(key='ip', rate='5/15m')` only; no per-email/account counter or lockout.
- **Observed:** Login throttles per IP but not per target account, so a distributed attacker (many IPs) can brute-force/credential-stuff a single known account beyond 5/15m. Mitigated by Django password validators (min length, common-password, numeric) but not by any account-level rate limit or lockout.
- **Suggested fix (NOT APPLIED):** Add a per-email login throttle and/or temporary account lockout with backoff (compounding with the per-IP limit).
- **Status:** OPEN

### [PH1-08] No rate limit on register and token/refresh (and no per-IP on verify-otp)
- **Severity:** LOW
- **Category:** Config
- **Location:** backend/accounts/views.py:107 RegisterView (no decorator), :230 TokenRefreshView (no decorator); treasurer_portal/views.py:172 VerifyOTPView (per-phone 5/h but no `key='ip'`).
- **Observed:** Register has no throttle — an attacker can mass-create PENDING churches + users and trigger a registration email per call (DB bloat + Resend cost + super-admin queue spam). token/refresh has no throttle (low risk — needs a valid 256-bit refresh token). verify-otp lacks a per-IP companion (low risk — each attempt needs a live OTP for the targeted phone).
- **Suggested fix (NOT APPLIED):** Add `@ratelimit(key='ip', ...)` to RegisterView (and optionally a per-IP companion to verify-otp); consider a modest throttle on refresh.
- **Status:** OPEN

## PHASE 2 — MONEY, INJECTION, CONFIG

### [PH2-01] Payment callbacks are unauthenticated (no Safaricom-IP allowlist / shared secret)
- **Severity:** MEDIUM
- **Category:** Money-integrity / Auth
- **Location:** donations/views.py:182 DonationCallbackView, withdrawals/views.py:615 B2CResultCallbackView, churches/views.py:532 SubscriptionCallbackView — all `permission_classes=[AllowAny]`, no IP allowlist, no HMAC/shared-secret check.
- **Repro:** POST `/donations/callback/` or `/withdrawals/b2c-result/` from any host with a crafted body → 200 and processed (live: unknown ids no-op 200; a body carrying a REAL pending `checkout_request_id`/`b2c_conversation_id` would be processed — that is exactly how the audit's own forged-but-valid B2C success in 2.1.C finalized a withdrawal to PAID with no auth).
- **Observed:** Anyone who learns/guesses a correlation id can drive a donation to SUCCESSFUL (credits NET → inflates raised/wallet without real money) or a withdrawal to PAID (decrements wallet for a payout that may have actually failed). Daraja provides no callback signature, so the only defenses present are the unguessable ids + idempotency.
- **Expected:** Defense-in-depth: restrict callbacks to Safaricom's published IP ranges (and/or an unguessable per-deploy URL path token) so a leaked/guessed correlation id is not sufficient on its own.
- **Mitigation present:** correlation ids are random/unguessable; idempotency prevents double-processing; donation credit uses the callback-confirmed amount.
- **Suggested fix (NOT APPLIED):** Add a Safaricom source-IP allowlist (middleware/permission) on the three callback views, and/or a secret path segment in the callback URLs. Pairs with PH1-05 (trustworthy client-IP derivation behind the proxy).
- **Status:** OPEN

### [PH2-VERIFIED] Money integrity core — exactly-once, NET, callback-authoritative (no finding)
Live (AUDIT/scripts/p2_money.py):
- **STK callback replay → credit-once:** PENDING donation 1000 → first callback credits NET 975 to raised+wallet; replay → unchanged (raised delta 975 then 0). Donation stored gross=1000/fee=25/net=975, status SUCCESSFUL.
- **Callback-confirmed amount authoritative:** donor "initiated" amount=5 but callback Amount=10000 → campaign credited NET 9750 (server ignores client-supplied amount, uses callback metadata).
- **B2C result replay → wallet decrement once:** PROCESSING withdrawal 700 → success callback finalizes PAID, wallet −700; replay → unchanged. (finalize_withdrawal_paid `==PAID` guard; same helper backs resolve-paid, so resolve-paid double-fire is covered by the same exactly-once guarantee.)
- **Boundary amounts rejected pre-dispatch:** donation initiate amount 0 / −100 / 4 / 4.99 / 999999999999999 → all 400 (min_value=5 + DecimalField max_digits=12) before any STK push.
- **Net-Everywhere:** public campaign detail exposes NET raised_amount and leaks NONE of wallet_balance/treasurer_phone/treasurer_name/checkout_request_id/b2c_conversation_id/platform_fee.
- Double-approve: status guard (only PENDING_APPROVAL→PROCESSING) makes a second approve 400 (code-confirmed, lock-then-call). Cross-church/closed-campaign disbursement: cross-church blocked in PH1.2; CLOSED guard present in PortalRequestDisbursementView (code-confirmed; live in Phase 6).

### [PH2-02] HTML/content injection in transactional emails (unescaped f-string interpolation)
- **Severity:** MEDIUM
- **Category:** Injection
- **Location:** backend/integrations/resend_email.py — emails sent as HTML (`_send_email(..., html)` L50/61); user-controlled values interpolated directly into HTML bodies via f-strings: `campaign_title` (L197 donation receipt, L217/236 payout emails), `donor_name` (L190 greeting), `church_name` (L120/145/169), `reason` (L146/237). Only campaign *description* is bleach-sanitized (campaigns/serializers.py); `title`/`donor_name`/`church_name`/`reason` are NOT.
- **Repro:** A church treasurer sets a campaign `title` containing HTML (e.g. `<a href="https://evil">Claim your refund</a>` or `<img src=...>`). Every donor to that campaign receives a donation-receipt email whose HTML body embeds the attacker-controlled markup. Similarly a donor's `donor_name` lands in their own receipt email; `church_name` in registration/approval/rejection emails.
- **Observed:** Attacker-controlled strings are emitted into HTML email bodies without escaping → phishing/link/content injection into emails delivered to third parties (donors). Modern mail clients block most JS, but `<a>`/`<img>`/layout injection is sufficient for phishing and tracking.
- **Expected:** HTML-escape all interpolated user data in email templates (or send text emails).
- **Suggested fix (NOT APPLIED):** Wrap interpolated values in `html.escape(...)` (or `markupsafe`/`bleach.clean(..., tags=[])`) in resend_email.py builders; consider escaping campaign `title`/`donor_name` at the serializer too.
- **Status:** OPEN

### [PH2-VERIFIED] Injection & stored XSS in the app surfaces (no finding beyond PH2-02)
- **No SQL injection surface:** zero `.raw(`/`.extra(`/`cursor.execute`/string-built SQL in backend app code (grep) — Django ORM parameterizes. Live: SQL-ish campaign title stored verbatim, `campaigns` table intact.
- **No FE HTML sink:** zero `dangerouslySetInnerHTML`/`WebView`/`react-native-render-html`/`innerHTML` in frontend — names/descriptions render in `<Text>` (escaped). Stored markup in group-label name / donor_name / withdrawal reason / church fields is therefore inert in the app UI.
- **Campaign description sanitized:** bleach allowlist strips `<script>`/`onerror=` and keeps safe tags (`<b>`); CampaignUpdate.body uses tags=[] (plain text).
- Residual (covered by PH2-02): the raw-stored free-text fields would activate if ever rendered as HTML (the email templates are exactly that surface).

### [PH2-03] Production transport hardening not configured (HSTS / SSL redirect / secure cookies)
- **Severity:** LOW
- **Category:** Config
- **Location:** backend/config/settings/production.py (only DEBUG=False + ALLOWED_HOSTS; comment defers hardening to "deployment"). No SECURE_SSL_REDIRECT, SECURE_HSTS_SECONDS, SECURE_PROXY_SSL_HEADER, SESSION_COOKIE_SECURE, CSRF_COOKIE_SECURE.
- **Observed:** As committed, a prod deploy has no HSTS, no HTTP→HTTPS redirect, and the admin session/CSRF cookies are not Secure-flagged (the JSON API is JWT-only so cookie flags don't affect it, but the Django admin uses session cookies). XFrameOptionsMiddleware is present (X-Frame-Options defaults to DENY), so clickjacking is covered.
- **Suggested fix (NOT APPLIED):** Add the SECURE_* settings (HSTS with preload, SSL redirect, SECURE_PROXY_SSL_HEADER for the proxy, secure cookies) to production.py or the deploy config; add to launch checklist. Pairs with PH1-05 (cache + IP) and PH2-01 (callback IP allowlist) as the "production settings" cluster.
- **Status:** OPEN

### [PH2-VERIFIED] File/URL fields, AllowAny abuse, config/transport, deps (no further finding)
- **URL fields (2.3):** banner_image_url/document_url/logo_url are Django URLField — `javascript:`/`data:`/`not-a-url` rejected (400 live). Arbitrary http(s) hosts (incl. http://169.254.169.254/) are accepted (200) BUT the backend NEVER fetches them (no `requests.get`/urlopen on user URLs; no image processing — URLs are display-only) → no SSRF. No file-upload surface (URLs only, no multipart). Residual (LOW/INFO): could restrict to an image-host allowlist for defense-in-depth.
- **AllowAny abuse (2.4):** donation status (GET /donations/{id}/status/) is UUID-keyed (unguessable), returns only status/gross/receipt (low sensitivity, donor's own). Public campaign/church lists leak no internal fields (re-verified 2.1.F + PublicChurchSerializer allowlist). The abuse vectors that DO exist are already logged: PH1-02 (otp enumeration), PH1-06 (STK spam), PH2-01 (callback forgery).
- **Config/transport (2.5):** DEBUG=False in prod (validate_env even rejects DEBUG=True when MPESA_ENVIRONMENT=production); SECRET_KEY from env; backend/.env is gitignored and untracked (repo has no commits yet — no secret committed); CORS uses an explicit origin list (no wildcard) with ALLOW_CREDENTIALS; CSRF N/A to the API (JWT-only, no SessionAuthentication in DRF defaults — only the admin uses sessions, CSRF middleware present); custom_exception_handler adds only a 429 map and does not leak internals (prod 500s are generic under DEBUG=False).
- **Dependencies (2.6):** versions are current as committed — Django 5.2.14, DRF 3.17.1, djangorestframework_simplejwt 5.5.1, PyJWT 2.13.0, urllib3 2.7.0, requests 2.34.2, pillow 12.2.0, psycopg2-binary 2.9.12, bleach 6.3.0. No obviously stale security-sensitive package. (No offline CVE scanner run — recommend `pip-audit` / `npm audit` in CI.)

## PHASE 3 — BACKEND CORRECTNESS (partial — 3.1/3.3/3.7 done; 3.2/3.4/3.5/3.6 next session)

### [PH3-VERIFIED] Test suite, serializer leak sweep, migration integrity (no finding)
- **3.1 Suite:** `manage.py test tests` → **406/406 PASS** (400.8s) against test_pamoja_audit. Matches CLAUDE baseline. (Negative-path tests deliberately log SMSDeliveryError/B2C-dispatch-failure warnings — final result OK.)
- **3.3 Serializer leak sweep (AUDIT/scripts/p3_leak.py) — ALL CLEAN:** every read surface exposes only its allowlist:
  - public campaigns list+detail: no treasurer_phone/treasurer_name/wallet_balance/checkout_request_id/b2c_conversation_id/church/created_by.
  - public churches list: no official_email/phone/address/status/subscription_tier/expiry/rejection_reason.
  - super campaigns: no treasurer_phone/treasurer_name/created_by/raw FK/closed_at. super donations: no phone_number/donor_email/checkout_request_id/raw campaign FK. super withdrawals: no b2c_conversation_id/originator_conversation_id. super churches: no rejection_reason. super audit-log: clean.
  - treasurer campaigns/mine + churches/me + churches/me/donations: no checkout_request_id/b2c_conversation_id/donor PII beyond allowlist.
  - public donation status: only {id, status, amount(gross), mpesa_receipt_number} — no platform_fee/net_amount/checkout_request_id.
- **3.7 Migration integrity:** `makemigrations --check --dry-run` → "No changes detected" (no model/migration drift); fresh-DB migrate already verified clean in Phase 0.5.
- **3.4 (partial):** money-math invariants already proven exactly-once + NET in PH2-VERIFIED (2.1); model CheckConstraints present (amount>0, raised>=0, donation amount>=5, retry_count<=5). Full property recompute deferred (live DB carries ORM-injected test donations that bypass the credit path — would false-positive; recompute after Phase-6 re-seed).

### [PH3-VERIFIED] Endpoint status-code + response-shape matrix (3.2, no finding)
Live (AUDIT/scripts/p3_endpoints.py against :8009/pamoja_audit) — happy + 404 + 400-missing-required + 405-wrong-method across every contract row:
- **Happy 200/201 + correct shapes:** public campaigns/churches list+detail; auth me; treasurer mine/withdrawals/churches-me/stats/donations/group-labels/notifications/unread-count; ALL 8 super reads; analytics object `{active_campaigns,churches_by_status,donations,platform_fees_collected}`; billing `{fee_percent,growth_price,parish_price,updated_at}`; donor status `{amount,id,mpesa_receipt_number,status}` (gross only).
- **404 on unknown id/slug:** campaign slug, church uuid, group-label, donation status, subscription status, treasurer mine slug — all `{detail}` 404. **400 missing-required:** login (missing password→`{password}`), register (→field-errors), donation initiate (→`{amount,phone_number}`). **404 unknown campaign** on donation initiate. **405** on wrong method: GET /auth/login/, DELETE /campaigns/mine/{slug}/, PUT /churches/me/, GET /withdrawals/{id}/approve/.
- **Pagination wire shape — RESOLVED (closes Phase-0 EARLY OBSERVATION + the "D5" question):** EVERY backend list (public, treasurer, notifications, AND all /super/) emits the DRF default `{count,next,previous,results}`. The "D5 `{items,total,truncated}`" in CLAUDE/memory is an **FE-INTERNAL** adapter type built in `frontend/services/superadmin.service.ts` (`items=data.results`, `total=data.count`, `truncated=data.next!=null`) — NOT a wire shape. Public/notifications services read `data.count`/`data.results` straight into `PaginatedResponse`. **No contract drift.**
- NOTE: two bad-login probes returned 429 (not 401/400) when the per-IP login throttle (5/15m) was exhausted by repeated audit runs — expected throttle behavior (the throttle itself is the subject of PH1-07/PH1-05), not a defect; they return 401/400 on a fresh window.

### [PH3-VERIFIED] State machines — every illegal transition rejected (3.5, no finding)
Live sweep (AUDIT/scripts/p3_state.py, 51/51 PASS against :8009/pamoja_audit; rows seeded per-state via ORM, illegal action fired, 400/409 + status-unchanged asserted; the one LEGAL transition per state NOT fired — proven in Ph2/6):
- **Campaign (ACTIVE/PAUSED/CLOSED):** pause PAUSED→400, pause CLOSED→400, resume ACTIVE→400, resume CLOSED→400, close CLOSED→400, PATCH CLOSED→400 (terminal, title unchanged). Each guard returns the status-named 400 and leaves the row's status unchanged.
- **Withdrawal:** approve & reject illegal from {PROCESSING,PAID,FAILED,FAILED_FINAL,REJECTED,NEEDS_RECONCILIATION}→400 (12 checks). retry illegal from {PENDING_APPROVAL,PROCESSING,PAID,FAILED_FINAL,REJECTED,NEEDS_RECONCILIATION}→400, plus FAILED+AMBIGUOUS_FAILURE→400 (reconcile-first) and FAILED+retry_count=5→400 (maxed). force-retry illegal from all non-FAILED_FINAL→400 (6). resolve-paid/resolve-retry illegal from all non-NEEDS_RECONCILIATION→400 with the **status-guard** detail "This payout is not awaiting reconciliation." (resolve-paid sent WITH a valid payout_reference so the 400 is the status guard, not serializer validation). All under-lock re-checks present; no status drift on any rejected call.
- **Subscription:** initiate tier=FREE→400; LIVE-Parish(exp>now+7d)→Growth down-pay→400 with tier unchanged BEFORE any STK; second initiate while a recent PENDING payment exists→409; duplicate SUCCESS callback on a terminal SUCCESSFUL row→200 with NO re-grant (tier stays FREE, expiry stays null, no CHURCH_TIER_CHANGED audit, stored receipt not overwritten); cancel idempotent (first→200+1 audit, second→200+NO second audit). Church A subscription state snapshotted + restored after.

### [PH3-VERIFIED] Management commands / crons — correct emission + idempotent re-run (3.6, no finding)
Live (AUDIT/scripts/p3_36.py, 24/24 PASS; runs the REAL `call_command(...)` against pamoja_audit):
- **sweep_stranded_withdrawals:** stale (updated_at < now−15m) PROCESSING and FAILED+AMBIGUOUS_FAILURE rows → NEEDS_RECONCILIATION (escalated=2); a FRESH PROCESSING row and a CLEAN_FAILURE FAILED row are left untouched (correct candidate set). Emits exactly 2 WITHDRAWAL_NEEDS_RECONCILIATION audit rows + 2 Super-Admin "Payout needs reconciliation" notifications. **Re-run: escalated=0, no new audit/notifications, statuses still NEEDS_RECONCILIATION** (select_for_update + candidate re-check makes an escalated row a non-candidate).
- **process_subscriptions:** reminders fire once each at the right milestone — 7d-out→stage 7D, 12h-out→stage 1D, in-last-grace-day(−6.5d)→stage GRACE; >7d-out and FREE churches get no reminder; one SUBSCRIPTION_REMINDER notification per reminded church. Lapse: a past-grace (−8d) paid church → tier FREE + expiry NULL + 1 SUBSCRIPTION_LAPSED notification + CHURCH_TIER_LAPSED_TO_FREE audit; FREE/early churches do not lapse. Summary "reminders=3 lapsed=1". **Re-run: reminders=0 lapsed=0, no new notifications** (per-period reminder high-water dedup; lapsed church no longer a candidate). Throwaway sub36-* fixtures created + deleted.

### [PH1-VERIFIED] Rate limits that ARE present
- login 5/15m per IP (live-confirmed it trips); password-reset/request 3/h per IP AND 3/h per email; request-otp 3/10m per IP AND per normalized phone; verify-otp 5/h per normalized phone; donation initiate 10/h per normalized phone. `normalized_phone_key` collapses format variants of one number into one bucket (closes the budget-multiplication bypass). NOTE: all are subject to PH1-05 in production.

## PHASE 4 — FRONTEND (Playwright, web :8081 → audit server :8009)

> Driven live as anon / treasurer A (treasurerA@audit.test) / super (super@audit.test) against pamoja_audit. FE confirmed pointing at :8009 (NEVER :8000/pamoja_dev) — every observed XHR hit http://localhost:8009. Persistent benign warning on every screen: RN-web `"shadow*" style props are deprecated. Use "boxShadow."` (library-level; matches the "don't re-chase RN-web warnings" note) — NOT a finding.

### [PH4-01] Super-admin Withdrawals "Approve Payout" is a dead button that FAKES success on a money surface
- **Severity:** MEDIUM
- **Category:** FE-error / FE-design (money surface)
- **Location:** frontend/app/(super)/withdrawals.tsx:398-419 (`handleApprove`) + the PENDING-row affordance at :136-153 (`onApprove`).
- **Repro:** Log in as Super Admin → Withdrawals tab. Every PENDING row renders an "Approve Payout" button (next to the full unmasked M-Pesa destination). Click it.
- **Observed:** `handleApprove` calls NO backend endpoint. On native it shows an Alert reading "This will trigger an M-Pesa STK transfer to the treasurer's phone," and on "Approve" it only does an OPTIMISTIC local state flip (`setWithdrawals` → status PROCESSING) + a success toast "Payout approved — processing KES …". Nothing is sent to the server; the next focus-refetch (useFocusRefetch) reverts the row to PENDING. On WEB the Alert is a no-op (RN `Alert.alert` doesn't render on web), so the button does literally nothing. Either way it's a lying-success / dead control on a MONEY action.
- **Expected:** Approving a PENDING payout is a Church-Treasurer, church-scoped action (`POST /withdrawals/{id}/approve/`, perms `[ChurchNotSuspended, ChurchScopedPermission]`); a SUPER_ADMIN has no backend approve path (would 403). The super Withdrawals screen per design should expose only Force-Retry (FAILED_FINAL) + Resolve-Paid/Resolve-Retry (NEEDS_RECONCILIATION) — there should be NO Approve affordance here at all, and certainly not one that fabricates success.
- **Suggested fix (NOT APPLIED):** Remove the Approve-Payout affordance (and the inline full-phone block) from the super Withdrawals row for PENDING; approval belongs only to the treasurer payouts screen (which IS wired to the real endpoint). If a super "approve" is ever a product requirement, add a real `/super/` endpoint + wire it — never a local-only optimistic flip on money.
- **Status:** OPEN

### [PH4-02] Public landing hero stats are hardcoded, not live (mock-vs-live on a "transparency" homepage)
- **Severity:** LOW
- **Category:** FE-design (mock-vs-live)
- **Location:** frontend/app/(public)/index.tsx (hero stat block).
- **Repro:** Open `/` as anon. Hero shows "KES 4.2M Raised · 138 Campaigns · 47 Churches".
- **Observed:** These three headline trust numbers are static literals, unrelated to the API (the audit DB has 2 churches / a handful of campaigns; the numbers do not change). The "Active campaigns" preview below them IS live. For a platform whose pitch is "every shilling on record," fabricated aggregate stats on the public homepage are an integrity/trust mismatch.
- **Expected:** Either drive the hero counters from a public aggregate endpoint (e.g. /super/analytics is admin-only; a small public stats endpoint would be needed) or remove the specific figures.
- **Suggested fix (NOT APPLIED):** Add a public aggregate-stats endpoint and bind the hero to it, or replace the hardcoded figures with non-numeric copy.
- **Status:** OPEN

### [PH4-VERIFIED] Frontend screens exercised so far — clean (no finding beyond PH4-01/02)
- **Anon public:** `/` landing (0 console errors; live "active campaigns" preview), `/campaigns` browse (0 errors). **Data correctness:** raised shown NET ("KES 1,950 of KES 200,000"); NO wallet/treasurer/fee leaked into any public card. **Stored-injection inert (live PH2-VERIFIED confirm):** campaign title `XSS Test Robert'); DROP TABLE` and a donor name `<script>alert(1)</script><img src=x onerror=alert(2)><b>bold</b>` both render as LITERAL escaped text with 0 console errors / no alert fired (React Native `<Text>`, no FE HTML sink).
- **Auth/login:** treasurer A + super both log in (200) and route correctly via the shared resolveAuthDestination (treasurer→treasurer dash, super→super dash, both at web path `/`). Cold anon at `/` (empty storage) shows the public landing — NO forced redirect (the earlier `/`→`/login` was a STALE-TOKEN/dead-token reload artifact from the persistent Playwright profile, cleared by forceLogout; resolveAuthDestination(null)=null → no redirect).
- **Treasurer Overview:** 0 errors. Total Raised + Wallet both NET (KES 11,700/11,700, wallet=raised−ΣPAID with no PAID rows); recent donations show NET (+KES 975 / +KES 9,750); unread bell live (2).
- **Treasurer Payouts:** destination phone MASKED in the list (`0*** ***0001`); amount NET (KES 500); 1 pending matches seed. (A `GET /withdrawals/` 401 fired on the hard deep-link load then self-healed via the interceptor refresh-retry — see INFO below.)
- **Super Queue:** correct EMPTY state ("No pending applications") since the audit DB has no PENDING churches. **Super Withdrawals:** platform-wide rows render with NET amounts + correct status chips; requested-by phone masked in row meta. (Destination phone shown full in the PENDING approval box — authorized for the super role by WithdrawalSerializer, but that whole box is the subject of PH4-01.)
- **Super Analytics:** 0 errors; figures correct vs audit DB — Total Churches 2, Active Campaigns 4, Total Donations KES 14,100 (GROSS — the sanctioned Net-Everywhere exception on the admin analytics surface), Platform Fees KES 352.5 (=2.5% of gross). Two chart cards show the intentional "Chart available after backend connection" placeholder (known-unimplemented per design, not a finding). NOTE (tab behavior, not a bug): Expo Router keeps visited super tabs mounted, so Queue+Withdrawals+Analytics DOM (incl. the PH4-01 Approve buttons) coexist while on Analytics.
- **Super Churches:** 0 errors; Beta=ACTIVE/FREE/1 campaign/KES 1,950 NET, Alpha=ACTIVE/GROWTH/3 campaigns/KES 11,700 NET; status+tier filter chips present; NO official_email/phone/address/rejection_reason rendered in the cards (consistent with 3.3 leak sweep). **Super Billing:** 0 errors; live PlatformSettings shown (fee 2.50%, Growth 999/mo, Parish 2499/mo) with correct "changes apply to future donations only" forward-only copy.
- **Super Donations (authorized gross/fee/net surface):** 0 errors; every row shows Gross/Fee/Net with net=gross−fee verified (100/2.5/97.5; 10,000/250/9,750; 2,000/50/1,950); NO phone_number/donor_email/checkout_request_id rendered (only campaign/church/status/date/donor-name/amounts/receipt); donor-name injection inert. **Super Audit Log:** 0 errors; rows show action/timestamp/entity/actor with destination_phone MASKED (`*********001`), NO ip_address (dropped by mapAuditLog), `System` actor for null-actor system rows, details flattened (D3, no "[object Object]"). ALL 7 super FE screens now verified (only hidden super Campaigns skipped — reuses already-verified mapPublicCampaign).
- **INFO (not a standalone finding):** On a HARD reload of an authed deep-link, the first authed XHR races ahead of in-memory token hydration → one `401` (browser-logged) → transparent refresh-and-retry recovers and the screen renders correct data (confirms the 4.6 401-refresh path). Cosmetic console noise + one extra round-trip on hard reload only; self-heals. Also the 2 anon `/auth/me/`+`/auth/token/refresh/` 401s on a stale-token cold load are browser-logged resource errors, not uncaught JS.

### [PH4-03] Admin-granted paid tier (null expiry) is shown as "FREE / Upgrade plan" to the treasurer
- **Severity:** MEDIUM
- **Category:** State-machine / API-contract (FE↔BE mismatch) / FE-design (money CTA)
- **Location:** frontend/utils/subscription.ts:38-39 `deriveSubscriptionState` ("paid-but-no-expiry → FREE", line 39) → consumed by frontend/components/treasurer/SubscriptionCard.tsx:340-349 (badge/message/CTA). Backend counterpart: superadmin/views.py SuperChurchSetTierView (sets subscription_tier WITHOUT subscription_expires_at) + churches/tasks.py (lapse job treats null-expiry paid churches as PERMANENT, never lapses) + churches/models.py TIER_ACTIVE_CAMPAIGN_CAP (cap applies to FREE only).
- **Repro:** As Super Admin, set a church's tier to GROWTH/PARISH via `/super/churches/{id}/set-tier/` (the documented money-inert grant — it deliberately does NOT set an expiry). This is exactly the seeded state of Audit Alpha Church (tier=GROWTH, subscription_expires_at=null). Log in as that church's treasurer → Settings → Subscription.
- **Observed:** Card shows badge "FREE", message "Up to 3 active campaigns. Upgrade to Growth or Parish for unlimited campaigns and more.", and an "Upgrade plan" CTA — even though the backend has the church on GROWTH. Confirmed: DB and `GET /churches/me/` both return `subscription_tier=GROWTH`, and `/super/churches/` shows GROWTH; only the treasurer's own SubscriptionCard says FREE. The church actually has unlimited active campaigns (the FREE cap doesn't apply to GROWTH), so the "capped at 3" message is factually wrong and the CTA invites payment for a tier already held.
- **Expected:** A church the backend treats as a paid tier should not be presented to its own treasurer as FREE. Either (a) the FE should show the granted tier (GROWTH/PARISH) with "active (admin-granted / no renewal date)" copy when expiry is null, or (b) the backend should set a sentinel/permanent-expiry on admin grants so FE and BE agree. The current split (BE = permanent paid tier; FE = FREE+upgrade) is a contract mismatch reachable by a normal admin action.
- **Suggested fix (NOT APPLIED):** Treat `paid tier + null expiry` as an ACTIVE/permanent paid state in `deriveSubscriptionState` (distinct copy, no day-count, suppress the Upgrade CTA), OR have set-tier record a permanent-grant marker the FE can read. Align FE and BE on what a null-expiry paid tier means.
- **Status:** OPEN

### [PH4-04] Campaign creation is entirely mock — fakes "Campaign Created!" success, persists nothing, uses mock group labels
- **Severity:** MEDIUM
- **Category:** FE-error / FE-design (mock-vs-live, lying success on a core write)
- **Location:** frontend/app/(treasurer)/campaigns/new.tsx:19 (`import { mockGroupLabels }`), :33-36 (GROUP_OPTIONS built from mock, NOT the church's real `/group-labels/`), :251-280 `handleSubmit` (no network call — `await new Promise(r => setTimeout(r, 1500))` then `setCreateState('success')`). There is NO `create` method in frontend/services/campaigns.service.ts (grep: only browse/getBySlug/listMine/getMine/pause/resume/close). Backend endpoint `POST /campaigns/mine/create/` EXISTS and is unused by the FE.
- **Repro:** Log in as a treasurer → Campaigns → "New Campaign". Fill all required fields → "Save Campaign". After a 1.5s spinner the screen shows "Campaign Created! / Your campaign is now live" with a WhatsApp share CTA to `https://pamojahub.co.ke/campaigns/<slug-from-title>`.
- **Observed:** Nothing is sent to the server. No campaign row is created; `GET /campaigns/mine/` is unchanged after "creation"; the share link points to a campaign that does not exist (404). The Group Label picker lists `mockGroupLabels` (5 hardcoded labels) instead of the logged-in church's actual group labels from `/group-labels/`, so a treasurer can "tag" a campaign with a group that isn't theirs / doesn't exist. This is a fabricated-success on the platform's single most important create path, and it is the LAST mock-data screen in the authed app.
- **Expected:** Save should call `POST /campaigns/mine/create/` (which exists, enforces FREE-tier 3-ACTIVE cap, forces church/raised/wallet/status server-side), surface its 201 → real slug for the share link, and surface 400 (field-errors + tier-cap detail) inline. The group picker should load the church's real `/group-labels/`.
- **Suggested fix (NOT APPLIED):** Add `campaignsService.create(payload)` → `POST /campaigns/mine/create/`; wire `handleSubmit` to it (real success/slug + both 400 shapes); replace `mockGroupLabels` with a live `groupsService.list()` fetch (as the Groups screen already does).
- **Status:** OPEN

### [PH4-05] Password-reset flow is a no-op stub that fakes success end-to-end (locked-out users stay locked out, silently)
- **Severity:** MEDIUM
- **Category:** FE-error (lying success on the only account-recovery path) / Auth
- **Location:** frontend/services/auth.service.ts:82-88 — `requestPasswordReset` and `confirmPasswordReset` bodies are ENTIRELY commented out (`// Phase 4: await api.post(...)`); both resolve `Promise<void>` immediately with no network call. Consumed by frontend/app/(auth)/reset-password.tsx (advances state on resolve). Backend endpoints `/auth/password-reset/request/` and `/auth/password-reset/confirm/` EXIST and work (Phase 1.6 verified them live).
- **Repro:** `/reset-password` (anon) → enter `treasurerA@audit.test` → "Send OTP". Screen advances to "Verify & Reset / Enter the code sent to treasurerA@audit.test". **Network panel: ZERO `/password-reset/` requests fired** (confirmed live). Enter any 6 digits + a new password → "Reset Password" → success state. The password is never changed (confirm is also a no-op); logging in with the "new" password fails.
- **Observed:** A user who has genuinely forgotten their password uses the only in-app recovery path, is told a code was emailed (none was) and that their password was reset (it wasn't), and remains locked out — with no error to signal the flow is fake. The backend reset endpoints are fully functional and unused.
- **Expected:** "Send OTP" should call `POST /auth/password-reset/request/`; "Reset Password" should call `POST /auth/password-reset/confirm/` and surface its 400s (bad/expired OTP). Both backend endpoints already exist.
- **Suggested fix (NOT APPLIED):** Uncomment/wire the two `auth.service.ts` methods to their existing endpoints (the request body shapes are already written in the comments) and surface confirm's 400 errors in the form.
- **Status:** OPEN

### [PH4-VERIFIED] More frontend screens — clean (treasurer Reports/Settings, OTP portal, forms)
- **Treasurer Reports:** 0 errors. Report-type selector (Campaign Summary / Donation History / Payout History) each labeled NET; the Campaign Summary in-screen table renders Goal/Raised/Wallet all NET (Alpha 100,000/11,700/11,700; wallet=raised, no PAID). CSV/PDF export is an HONEST "coming soon" placeholder (button says "Download — coming soon" — not a lying control).
- **Treasurer Settings:** 0 errors. Church Profile editable fields (name/phone/address/county/denomination/description + Save); Account read-only (Alice Alpha / treasurerA@audit.test / Change Password); Danger Zone = mailto support copy. Subscription card is the subject of PH4-03.
- **Public OTP Treasurer Portal (`/treasurer`, anon):** 0 errors; phone-entry → Send OTP step renders. **Form validation (4.3):** invalid phone ("123") → inline "Enter a valid Kenyan number (07xx or 01xx)", NO network call, stays on step (no submit-to-blank, no lying success). As a LOGGED-IN treasurer, `/treasurer` correctly redirects to the treasurer dashboard (resolveAuthDestination), so the public portal is anon-only as designed.
- **Coverage tally:** Phase-4 screens exercised live = anon (landing, campaigns browse, OTP portal), treasurer (overview, payouts, reports, settings), super (queue, churches, withdrawals, analytics, billing, donations, audit-log). Still UNVISITED (next session): treasurer campaigns-list/[slug]/groups/notifications, super hidden Campaigns, auth register/reset-password, donation form 400-shapes, forced error/loading states (route-abort), responsive widths.

### [PH4-VERIFIED] Remaining screens, forms, states, cross-cutting (session 3 — Phase 4 now COMPLETE; findings PH4-04, PH4-05)
Driven live :8081 → :8009. Every screen 0 UNCAUGHT JS errors (only the benign RN-web `shadow*`/`pointerEvents` deprecation warnings + expected resource-level 401/404/ERR_FAILED that resolve to correct UI).
- **Public churches browse (`/churches`):** 2 churches, NET active-campaign counts (Alpha 3 / Beta 1); NO official_email/phone/status/tier/address leaked. Hits GET :8009/churches/.
- **Public church detail (`/churches/{id}`):** NET raised (KES 11,700 / 0), injection inert (`XSS Test Robert'); DROP TABLE` literal), no wallet/treasurer/fee leaked.
- **Treasurer campaigns-list (`/campaigns`):** wired (listMine), NET raised, status badges, Pause/Close/Share live; injection inert.
- **Treasurer campaign-detail (`/campaigns/alpha-build`):** wired (getMine + withdrawals/{campaign}); payout history phone MASKED (`0*** ***0001`); NET; "Request Payout" is an HONEST nav button → routes to /payouts (NOT a fake control like PH4-01).
- **Treasurer groups (`/groups`):** wired live `/group-labels/`; Flat/Hier badges; rename/archive; injection inert. (Hard-reload fired the documented self-heal 401 then rendered correct data.)
- **Treasurer notifications (`/notifications`):** wired live; NET amounts labeled "(net)"; flat list; 2 unread + Mark-all-read.
- **Super hidden Campaigns (`/campaigns` as super):** platform-wide (BOTH churches), status+category filter chips, NET raised + donor counts; injection inert; no treasurer/wallet leak.
- **Auth register (`/register`):** county correctly removed (session-4 polish); submit-empty → all 6 fields show inline required-errors, NO network call, no crash.
- **4.3 FORMS:**
  - Donation form: client validation live (phone "123" → "Enter a valid Kenyan number"; amount "2" → "Minimum amount is KES 5"; no call). **Both backend 400 shapes handled in code** (DonationForm.tsx:162-194): field-keyed 400 {phone_number/amount} → inline form errors; `detail` 400/404 → extractDetail → 'failed' copy; +502 (not-charged) +429 paths; success ONLY on a SUCCESSFUL poll verdict (no lying success).
  - Payout reject-reason: empty submit → "Reason must be at least 5 characters", no call (min-length client guard).
  - Settings Church-Profile: "Save changes" fires a REAL `PATCH :8009/churches/me/ => 200` (not fake).
  - (Register validation above.) Campaign-create = PH4-04 (mock); password-reset = PH4-05 (stub).
- **4.2 forced states:** route-aborting `**/api/v1/campaigns/**` → public browse shows "Couldn't load campaigns / Try again" (graceful, no blank/crash). Unknown slug `/campaigns/this-slug-does-not-exist-xyz` → "Campaign not found" state. Loading spinners present in source; empty state verified (Queue).
- **4.6 cross-cutting:** responsive 375px (no horizontal overflow, scrollWidth==viewport) AND 1280px (no overflow) on landing; **ZERO duplicate-key warnings** in the whole session console; portal-401 re-auth = bare `portalClient` (no interceptors) + single `handlePortalAuthLost` chokepoint (treasurer/index.tsx:246-276) routing 401/403 → phone re-entry + notice (code-verified; Phase-1.4 confirmed the token 401 fail-closed live); JWT 401-refresh self-heal re-confirmed on every hard deep-link.

## PHASE 5 — FE↔BE INTEGRATION / CONTRACTS

### [PH5-01] Dead `donationsService.listForCampaign` returns mock + its intended endpoint does not exist (latent contract drift)
- **Severity:** INFO
- **Category:** Dead-code / API-contract
- **Location:** frontend/services/donations.service.ts:51-54 (`listForCampaign` returns `{ count: mockDonations.length, results: mockDonations }` — line 52; the real call is only a COMMENT on line 53: `// Phase 4: return (await api.get(\`/campaigns/${campaignId}/donations/\`)).data;`). Imports `mockDonations` (line 1) — the last service importing a `mock/` file.
- **Observed:** The method is never called anywhere in the app (grep: no `listForCampaign` caller). It still returns mock donation rows and keeps `mock/donations.mock.ts` alive at the service layer. Its commented intended endpoint `GET /campaigns/{id}/donations/` does NOT exist in the backend (campaigns/urls.py has only `''`, `mine/`, `mine/create/`, `mine/<slug>/[pause|resume|close]`, `<slug>/updates/`, `<slug>/`) — so if anyone wires it per the comment it would 404. (The treasurer per-campaign/Reports donation feed is served instead by `GET /churches/me/donations/`.)
- **Expected:** Remove the dead method (and the `mockDonations` import) or, if a per-campaign donation feed is wanted, add a real backend endpoint and wire to it.
- **Suggested fix (NOT APPLIED):** Delete `listForCampaign` + the `mockDonations` import; track `mock/donations.mock.ts` for removal in the Phase-7 dead-code inventory.
- **Status:** OPEN

### [PH5-VERIFIED] Per-service contracts, header split, error mapping, drift — clean (only PH4-04/PH4-05/PH5-01)
- **5.1 request/response/mapper/pagination:** Every endpoint a service calls maps 1:1 to a real backend URL+verb (cross-checked vs config/urls.py + each app urls.py). Mappers (services/mappers.ts) are EXPLICIT per-field (no generic deep-convert): every money DecimalField arrives as a STRING and is `Number()`-converted via `toMoneyNumber` (NaN-guard → warn + 0), EXCEPT `mapPlatformSettings` which deliberately keeps fee/growth/parish as strings (they feed editable inputs — a read must not reformat money). NET-Everywhere honored (recent-donation/portal/my-donation `amount` IS net; analytics gross/net is the sanctioned admin exception; donor status `amount` is gross to match the M-Pesa SMS). Allowlist boundary is structural: sensitive wire fields (checkout_request_id, b2c_conversation_id, phone_number, donor_email, rejection_reason, ip_address, subscription_expires_at on the super surface) are ABSENT from the Backend* interfaces, so they can never surface (`mapDonation`/`mapWithdrawal`/`mapAdminChurch`/`mapAuditLog`/`mapPortalCampaign`). Pagination: FE `PaginatedResponse<T>={count,next?,previous?,results}` matches the DRF default wire shape exactly; the super "D5 {items,total,truncated}" is an FE-internal adapter, NOT a wire type (no drift — closes the Phase-0 EARLY OBSERVATION).
- **5.2 Bearer-vs-Portal header correctness:** Only treasurer-portal.service.ts imports `portalClient` (grep: 2 files = the service + portalClient.ts itself); ALL 10 other services use the shared JWT `api`. `portalClient` is a BARE axios instance (no request/response interceptors) and the portal calls thread `Authorization: Portal <raw>` explicitly per call — so a portal 401 can NEVER be hijacked into the JWT refresh/login path, and a JWT call never sends a portal token. (Phase-1.4 confirmed header isolation live: portal token as Bearer → 401; JWT on portal path rejected.) Donation initiate/status use `api` (AllowAny → no token → no Bearer header, which is correct).
- **5.3 error mapping:** api.ts response interceptor: 401 → single-flight rotation-aware refresh-and-retry ONCE; `_retried` loop-guard → forceLogout; forceLogout ONLY on a DEFINITIVE auth failure (401/403 from refresh) or no-refresh-token — a network blip KEEPS the session (verified logic). Refresh uses BARE axios (no interceptor re-entry). Services let axios throw; screens map: campaigns-list `extractDetail` (detail vs generic), DonationForm `handleInitiateError` (BOTH 400 shapes + 502 + 429 + 404), portal `callPortal` (401/403→re-auth, 400 both-shapes re-thrown). 429/500/timeout surface as non-blank failure copy (live-confirmed: forced ERR_FAILED → "Couldn't load… / Try again"; 404 → "not found").
- **5.4 contract drift:** The ONLY drifts are already-logged FE gaps where the backend endpoint EXISTS but the FE doesn't call it: PH4-04 (no `campaignsService.create` for `POST /campaigns/mine/create/`) and PH4-05 (`auth.service` password-reset request/confirm are commented-out stubs vs the live `/auth/password-reset/{request,confirm}/`). Plus PH5-01 (dead `listForCampaign` whose commented endpoint doesn't exist). No service calls a wrong-shaped or wrong-verb endpoint; no mapper drops a field the screen needs.

## PHASE 6 — FULL SCENARIO / E2E (fresh pamoja_audit; AUDIT/scripts/p6_e2e.py)

### [PH6-VERIFIED] End-to-end journeys + money ledger — 27/27 PASS, no finding (also clears deferred 3.4)
DB RESET first (drop+recreate+migrate+reseed → clean 2-church baseline). JWTs minted in-process (SimpleJWT `AccessToken.for_user`, no login-throttle hit). Real HTTP views for register/approve/portal-create/approve/suspend/billing/set-tier (real permissions + serializers + audit); the money-moving STK-credit and B2C-PAID legs use FORGED callbacks on prepared rows (proven hermetic pattern; the REAL STK-initiate + B2C-dispatch were proven live in Phase 2/3). Ledger asserted by relative deltas at each step.
- **6.1 Reg→campaign→donation→net→disbursement→approve→PAID→wallet-once:** register → 201 PENDING; super approve → ACTIVE + approval audit row. Donation STK callback (gross 2000) → **NET +1950 credited** to raised AND wallet, donation stored gross=2000/fee=50.00/net=1950.00; **STK replay credits exactly once** (idempotent). Treasurer approve seeded PENDING (200) → forge B2C success → **PAID, wallet −500 exactly once**, `payout_reference` recorded; **B2C replay decrements once** (idempotent). Portal happy-path `request-disbursement` (slot free) → 201 PENDING_APPROVAL with **wallet UNCHANGED** (lock-then-call: no money moves on request).
- **One-pending-per-campaign guard (correctness, holds):** a portal `request-disbursement` while a PENDING_APPROVAL payout already exists on that campaign → **400 "A payout request is already pending for this campaign."** (prevents stacking concurrent payout requests on one wallet).
- **6.5 money double-fire / idempotency:** super resolve-paid on a NEEDS_RECONCILIATION row → 200 PAID, **wallet −100 once**; a SECOND resolve-paid → **400 (status guard), wallet unchanged**. (Same exactly-once spine as the B2C+STK replays above.)
- **6.4 super-admin:** suspend church B → 200 SUSPENDED + CHURCH_SUSPENDED audit; reactivate → 200 ACTIVE. Billing PATCH fee_percent 2.5→5.0 → 200, **existing donation net STAYS 1950.00 (forward-only — no retro-recompute)**; fee restored to 2.5.
- **6.2 subscription:** set-tier GROWTH (money-inert admin grant) → 200, tier flipped + CHURCH_TIER_CHANGED audit. (Full initiate→callback→extend→reminders→lapse→cancel lifecycle proven in Phase 3.5/3.6 + the subscription slices; not re-driven here.)
- **6.3 portal:** request-disbursement via a real `Authorization: Portal` token exercised (create + guard + happy path); full OTP-request→verify→token→auth-loss→re-auth proven live in Phase 1.4.
- **Deferred 3.4 now satisfied:** net=gross−fee, wallet moves exactly once per PAID, and forward-only fee are all proven on the fresh clean ledger here.

## PHASE 7 — DEAD / UNUSED CODE (report only — do NOT delete)

### [PH7-01] Unused Inventory (dead code / orphaned mocks / unused dep) — triage list
- **Severity:** INFO
- **Category:** Dead-code
- **Frontend dead components:**
  - `frontend/components/disbursement/DisbursementRequestForm.tsx` — a 13-line STUB that returns `<View />` (empty); ZERO importers. Fully dead (the portal disbursement is implemented inline elsewhere).
  - `frontend/components/campaign/CampaignCreationForm.tsx` — ZERO importers. The campaign-create screen `(treasurer)/campaigns/new.tsx` has its OWN inline form (see PH4-04), so this component is dead/superseded.
- **Frontend dead service method:** `donationsService.listForCampaign` (donations.service.ts:51) — no caller; returns `mockDonations`; its commented endpoint doesn't exist (see PH5-01).
- **Orphaned mock files (0 consumers anywhere — app, services, AND tests):**
  - `frontend/mock/auditlog.mock.ts` — imported nowhere.
  - `frontend/mock/notifications.mock.ts` — imported nowhere.
- **Mock files kept alive ONLY by mock/stub code (will orphan once the linked finding is fixed):**
  - `groups.mock.ts` → only `(treasurer)/campaigns/new.tsx` (PH4-04 mock form).
  - `donations.mock.ts` → only the dead `listForCampaign` (PH5-01).
  - `treasurer.mock.ts`'s `mockTreasurerProfile` → only the OTP-portal greeting name (cosmetic; the rest of treasurer.mock is test-fixture).
- **Test-only mock fixtures (INTENTIONAL — keep; they back the 60-test vitest consistency suite):** `campaigns.mock.ts`, `churches.mock.ts`, `withdrawals.mock.ts`, and `treasurer.mock.ts` (campaigns/summary/recentDonations). Not dead — they are the suite's source of truth.
- **Unused dependency (frontend):** `dayjs` — declared in package.json, imported by ZERO source files (utils/formatters.ts uses built-in `Date`). Matches the CLAUDE.md "dayjs installed but unused" note. (A full unused-dep scan — `depcheck` / `pip-audit` — recommended in CI; not run offline here.)
- **Backend — routed but FE-unused endpoint:** `GET /campaigns/<slug>/updates/` (CampaignUpdatesView, campaigns/urls.py:36) has NO frontend caller (no service references `updates`). Either a future feature or removable.
- **Backend — management command with no test/cron/doc reference:** `set_subscription_expiry` (churches/management/commands) is referenced nowhere outside its own file (cf. `process_subscriptions`/`sweep_stranded_withdrawals`/`sweep_stranded_donations`, which all have tasks.py/tests/docs). Likely a one-off manual admin tool — confirm it's still needed. (`cleanup_synthetic_withdrawals` is a guarded DEV-only cleanup tool — keep out of prod.)
- **Suggested fix (NOT APPLIED):** Delete `DisbursementRequestForm.tsx`, `CampaignCreationForm.tsx`, `donationsService.listForCampaign`, `mock/auditlog.mock.ts`, `mock/notifications.mock.ts`, and the `dayjs` dep; the `groups`/`donations`/`mockTreasurerProfile` mocks fall out naturally when PH4-04/PH5-01/the greeting are wired. Decide on `/campaigns/<slug>/updates/` + `set_subscription_expiry`.
- **Status:** OPEN
