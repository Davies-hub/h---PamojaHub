# PamojaHub — Deploy-Ready Checklist

> Companion doc: the production ops runbook (sweep cron, AuditLog REVOKE) lives in `backend/docs/deploy_checklist.md`.

**Purpose:** the honest gap between the current build and a *deployable, money-safe product*. Not a feature wishlist — a launch gate list.

**Sources:** §0, §14.1, §18 of Compressed_v2; the BuildGuide; the open-items brief. Where a claim isn't in the files, it carries a certainty tag.

---

## ⬛ CURRENT STATUS — ALL BUILDABLE CODE COMPLETE

CURRENT VERIFIED BASELINE: 499 tests — `manage.py test tests`, all pass — re-verified green post-merge 2026-07-15 (master `fab9e17`); reconciled 2026-07-09.

Every [CODE] item that can be built **without a deployed environment is done and live-verified.** Tier 2 (resolve-paid, request-disbursement request-half), all of Tier 3, all of Tier 5 polish — closed. Three items the §0 list called "unbuilt" turned out already built (resolve-paid, billing tier-prices, church-tier-set).

**There is no more code to write ahead of the deploy environment.** Everything remaining (below) is **Tier 1 — [LIVE] / [OPS], not code.** It needs a domain + Safaricom approval + a real handset, none of which exist yet.

**The one bottleneck:** a deployed environment with a public HTTPS domain. Every remaining gate is downstream of it — you can't test a callback Safaricom can't reach, run prod SQL on a DB that isn't stood up, or prove STK on a handset against a localhost server.

---

## How to read this

Every item is tagged by **how it closes**, not how big it is — because that's what determines whether *I* can help or *you* must act:

- **[CODE]** — a build slice. I trace, write the prompt, you run it in Claude Code, I review. Normal flow.
- **[LIVE]** — closes only on a real round-trip in a deployed/staging environment (handset, PIN, public callback). I cannot run these. I can write the runbook.
- **[OPS]** — a manual action (SQL, cron, hosting, Safaricom portal). Not code, won't travel in migrations.
- **[DECISION]** — needs your money/product call before any build.

**The hard truth:** the code bucket is the *smaller* and *lower-risk* part. The launch risk lives in [LIVE] and [OPS].

---

## Recommended order (and why)

The principle: **do the highest-uncertainty, most-downstream-invalidating thing first.** A broken shared parser invalidates every payment screen you build on top of it.

| Step | What | Why here |
|---|---|---|
| 0 | Decide & stand up the **deployment target** (where prod runs, public HTTPS domain) | Every [LIVE]/[OPS] item depends on this existing. Can't test a callback Safaricom can't reach. |
| 1 | **STK success round-trip** in staging (Tier 1.1) | Highest risk, shared by donation + subscription. If wrong, everything downstream is wrong. Find out first. **Expect it to surface new work.** |
| 2 | **Production Daraja go-live** (Tier 1.2) | External Safaricom dependency, likely the long pole. Start the paperwork early; it gates real money in/out. |
| 3 | **Prod DB REVOKE + sweep cron** (Tier 1.3, 1.4) | Manual, fast, but must run with production settings. Do once infra exists. |
| 4 | **Unbuilt money writes** (Tier 2) | resolve-paid, request-disbursement. Money discipline, backend-guard-first. |
| 5 | **Non-money mock screens** (Tier 3) | Lower risk, build once the money spine is proven live. |
| 6 | **Deferred decisions** (Tier 4) | Your calls; some block Tier 2 builds (e.g. resolve-paid NULL ref). |
| 7 | **Polish / logged debt** (Tier 5) | Ship without these if needed. |

---

## TIER 1 — Blocks go-live. NOT closeable by building.

### 1.1 — Real STK SUCCESS callback parse [LIVE] — ✅ **CLOSED 2026-07-09**
- Closed on the sandbox itself: a **real-SIM** donation (KES 5, real PIN prompt) produced a genuine `ResultCode: 0` Safaricom callback (receipt `UG9KTAG8ZR`), processed by the real shared donation/subscription parser — credited exactly once, NET of fee. (§14.1 record 2026-07-09/10.)
- The gate had a hidden second half: **the `.env` callback URLs were missing the `MPESA_CALLBACK_SECRET` path segment**, so every real callback 404'd at the router since PH2-01. Fixed in `backend/.env`. **Carry-forward to go-live: the production URLs registered with Safaricom MUST include the production secret segment.**
- Facts learned: sandbox STK charges REAL money (M-Pesa auto-reverses); real payload confirms numeric `Amount`/`TransactionDate`/`PhoneNumber` and a `Balance` item with no `Value` — the parser handles all of it.

### 1.2 — Production Daraja go-live [OPS] — *likely the long pole*
- Everything today is **sandbox** (app 600992: OAuth + STK 174379 + B2C 600992).
- **Sandbox ceiling reached (2026-07-10):** money-IN is fully provable/demoable on sandbox with a real SIM; money-OUT to a real phone is a hard sandbox wall (ResultCode 2040, CommandID-independent — §14.1). Real-destination payouts can only be tested via production B2C or an aggregator disbursement API (interim option: IntaSend).
- Production needs: production consumer key/secret, production STK shortcode + passkey, production B2C shortcode + initiator + SecurityCredential (encrypted with the **production** cert), Safaricom go-live approval, and `ALLOWED_HOSTS` / public HTTPS callback URLs Safaricom can actually reach.
- *[Guessing on exact current steps — Safaricom's go-live process changes; verify before starting.]*

### 1.3 — Production AuditLog REVOKE [OPS]
- `REVOKE UPDATE/DELETE ON audit_auditlog` was applied to **dev only**. A REVOKE does **not** travel in migrations.
- Must be run manually on the **production** DB as superuser/owner, then verified (UPDATE must fail).
- Ownership nuance: for hard tamper-proofing, prod should own audit tables with a **separate** migrations/admin role, leaving the app role INSERT/SELECT only.
- Runbook already exists: `backend/docs/production_db_hardening.md`.
- **Until run on prod, the production audit log is NOT tamper-proof at the DB level.**

### 1.4 — Stranded-withdrawal sweep scheduler [OPS]
- The escalate-only command (`manage.py sweep_stranded_withdrawals`) **exists**, but nothing runs it in the deployment — no cron, no beat.
- Must be a cron entry running with `DJANGO_SETTINGS_MODULE=config.settings.production`.
- **Until armed: money-in-limbo is never frozen for a human.** The "needs reconciliation" guarantee is not in effect.

### 1.5 — Confirm the prior 502 subscription-initiate row landed FAILED, not stuck PENDING [LIVE / data-check]
- Small but real: one prior 502 needs confirming it ended `FAILED`, not orphaned `PENDING`.

---

## TIER 2 — Money-write features — ✅ CLOSED (built + live-verified, split at the prod boundary)

Both built backend-guard-first, seen-failing-first, live-gated. Each splits cleanly: the request/ledger half is live now; the B2C-dispatch half waits on production Daraja (Tier 1.2).

### 2.1 — Super-admin **resolve-paid** write — ✅ DONE
- Trace found it was already built end-to-end *including* reference capture (4.1 already implemented in code). Live-verified: wallet decrements exactly once across happy-path + sequential + concurrent double-fire; reference persisted; 400 on wrong-status and blank reference.

### 2.2 — Campaign-Treasurer **request-disbursement** (portal) — ✅ DONE (request half)
- The dead `DisbursementRequestForm.tsx` was a red herring (empty stub, wrong actor). Real path is the OTP portal. Built across 4 slices: campaign-state guard (block CLOSED), request-otp enumeration-oracle fix, portal auth live (Option A bare-axios client + 401/403 chokepoint), and the money-write itself.
- Live-verified: real PENDING_APPROVAL row, both 400 shapes mapped, auth-lost re-auth, exactly one write across six rejection paths.
- **Dispatch half (approve→B2C) waits on Tier 1.2** — same prod-Daraja boundary.

### NEW carry-forward gates discovered during the portal arc (all [LIVE]/[OPS], added to Tier 1 scope):
- **OTP-over-real-SMS unproven.** Every portal gate used dev-shell hash injection (real Africa's Talking SMS couldn't be received in dev). Same shape as the STK boundary — the code is right, the live SMS round-trip is an open gate. Closes on first real OTP SMS in staging.
- **Portal auth rides the `Authorization: Portal` header** (browser CORS preflight blocks the custom `X-Portal-Token`). Prod CORS/proxy MUST pass `Authorization` through untouched or the portal dies silently. Confirm at go-live.
- **Option C — portal endpoints inherit JWT auth** (latent backend bug). Token-level failures surface as 401 with a `Bearer` challenge instead of an honest 403; on the shared `api` client that 401 would be hijacked into JWT force-logout. Worked around on the FE (bare portalClient). Root-cause fix = `authentication_classes = []` on portal views. Non-blocking; logged so the next portal-call author doesn't trip the hijack.

---

## TIER 3 — Non-money mock features [CODE]

Lower risk; build once the money spine is proven live.

### 3.1 — Treasurer screens still mock: campaign **detail / reports / settings / groups** — **✅ SUPERSEDED: all four DONE; reports CSV+PDF export BUILT (see "Treasurer screens — ✅ ALL DONE" below)**
### 3.2 — Super-admin **subscription tier-edit** write (not wired)
### 3.3 — Super-admin **billing growth/parish tier-price** writes (currently local-only edits)
### 3.4 — **groups** + **treasurer-portal** services (still Phase-4 stubs)
### 3.5 — Landing-page **active-campaigns preview** (roadmap item, never built)
### 3.6 — Reconcile the rest of the **NotificationType union** with the 12-member backend enum
- We added `SUBSCRIPTION_ACTIVATED`. Still missing from the FE union/icon map: `DONATION_NEEDS_REVIEW`, `RECONCILIATION_PAYMENT_CONFIRMED`, `CAMPAIGN_DESTINATION_CHANGED`.
- Non-breaking today (fallback icon), but unreconciled. [Certain]

---

## TIER 4 — Deferred product decisions [DECISION]

These need your call. Some gate Tier 2 builds.

### 4.1 — resolve-paid **NULL payout_reference** — ✅ RESOLVED (already in code)
- Trace found this already implemented and matching the lean: reference is **required + non-blank**, with an audited `WITHDRAWAL_RESOLVED_WITHOUT_REFERENCE` fallback marker. A resolved-paid row ends indistinguishable from a callback-paid row. No build needed.

### 4.2 — Lock-order inversion on the resolve path (ABBA)
- Dispatch locks Campaign→Withdrawal; resolve locks Withdrawal→Campaign. Known, real, but **safe** (sub-ms overlap, self-healing). Aligning resolve to Campaign→Withdrawal is its own small checkpoint.

### 4.3 — `mark_needs_reconciliation` freeze alert still typed `DISBURSEMENT_FAILED`
- Imprecise (a non-success borrow). Retype to a reconciliation-freeze type when that path is next opened.

---

## TIER 5 — Logged debt / polish [CODE, non-blocking]

Ship without these. Listed so they're not forgotten.

### 5.1 — `markRead` / `markAllRead` have catch-less awaits
- Awaited POST rejects into `finally` with no `catch` → dev-only red-box. Silent in prod; the sync-notice already signals the user. 3-line fix if you reopen the file.

### 5.2 — `markAllRead` → `clearUnread()` is un-reverted on failure
- Bell goes to 0 optimistically; self-heals on Overview focus. Low stakes.

### 5.3 — Activation **render** never round-tripped
- `SUBSCRIPTION_ACTIVATED` icon verified on pre-existing rows only. Rides on the same STK-success boundary as 1.1 — closes when 1.1 closes.

### 5.4 — Pre-existing console error on the super-admin landing screen
- Flagged long ago, never chased. Confirm it's harmless before launch.

### 5.5 — Context-file hygiene
- Test baseline drift: docs said 299, then 385/422. **✅ RECONCILED 2026-07-09 — see CURRENT VERIFIED BASELINE above.** Older 299/385/422 figures were historical floors.

---

## What I can and can't do

**I can:** trace, write build prompts, sequence, and review returns for every **[CODE]** item; write runbooks/verification scripts for **[OPS]** items; structure the **[LIVE]** round-trips so you know exactly what to do and what counts as a pass.

**I can't:** run the staging handset round-trip, run production SQL, set up Safaricom production, or stand up hosting. Those are yours.

---

## One honest caveat

"Fully functional" has a moving floor. Item 1.1 (the staging round-trip) has historically surfaced new work *every time* it's run — §14.1 is the evidence. **Treat this list as the known floor, not the ceiling.** It will grow once staging runs. That's not pessimism; it's the pattern your own findings show.

---

## Tier 3 progress (updated)

**Treasurer screens — ✅ ALL DONE** (groups, settings, campaign-detail, reports), each live-verified on the `churches.tsx` template (real service + mapper + useFocusRefetch + web-safe confirm + 400-surfacing). New JWT backend added where needed: `validate_phone` on profile PATCH, `GET /churches/me/donations/` (NET-only). audit_log report type dropped (no JWT source by design); CSV/PDF export **✅ BUILT** — real CSV (`StreamingHttpResponse`) + PDF (`reportlab`) for all THREE report types: donations (`churches/views.py:466-494`), payouts (`withdrawals/views.py:285-313`), campaign-summary (`campaigns/views.py:412-434`); shared builder `common/pdf.py:43-107`. No 501/stub anywhere — `_Passthrough*Renderer` exists only for DRF content-negotiation.

**Remaining Tier 3:** super-admin tier-edit (3.2) + growth/parish tier-price writes (3.3, local-only "lying toast" today), landing active-campaigns preview (3.5), NotificationType union remainder (3.6 — DONATION_NEEDS_REVIEW, RECONCILIATION_PAYMENT_CONFIRMED, CAMPAIGN_DESTINATION_CHANGED still FE-missing, fallback icon, non-breaking).

**New logged debt (cosmetic, non-blocking):** treasurer Overview recent-donations feed (`(treasurer)/index.tsx`) keys by bare `mpesaReceipt` → React duplicate-key warning when a church has two SUCCESSFUL rows sharing a receipt (sandbox data artifact; reports screen already fixed to composite key). Fix Overview to composite key when that file is next open.

**3.2 + 3.3 — ✅ ALREADY DONE (trace-confirmed, premise was stale).** Super-admin church-tier-set (`/super/churches/{id}/set-tier/`) and tier-price writes (`growth_price`/`parish_price` on `/super/billing/`) are both fully wired FE↔BE with field-error handling, in-flight guards, server-truth re-seed, and a `PLATFORM_SETTINGS_CHANGED` audit. Tier-prices are forward-only (read live at initiate, never rewrite existing subscriptions) — same semantics as `fee_percent`. No money-correctness gap.

**⚠️ Context-file drift:** the §0 "still mock / not wired" list has now overstated remaining work 3× (resolve-paid, request-disbursement form, billing tier-prices all turned out built). Recommend a reconciliation pass of §0 against reality before it sends future slices chasing phantom work. **✅ DONE 2026-07-09:** reconciliation pass complete — baseline set to 499 (see CURRENT VERIFIED BASELINE above); reports-export (BUILT), document_url (LOCKED) and PH2-02 (CLOSED) phantom-open items corrected; dead-code cluster marked partially closed (FE deletions done; `dayjs` + `/updates/` deferred).

**Tier 3 remaining (only 2):** landing active-campaigns preview (3.5, public/no-auth/no-money), NotificationType union remainder (3.6, cosmetic).

---

## AUDIT RESULTS (comprehensive multi-session audit harness — Phases 0–8 complete)

**Headline:** 0 found-CRITICAL / 0 found-HIGH from the audit's own pass, BUT a trace of the under-rated PH2-01 reclassified it CRITICAL and it is now fixed (below). Treat "0 critical" as "0 found by this method," not "0 exist" — the same agent family built and audited the code.

### ✅ CLOSED — PH2-01 forged-callback money-injection (was mis-rated MEDIUM → actually CRITICAL)
- **The hole:** all 3 payment callbacks (donation `/donations/callback/`, subscription `/subscriptions/callback/`, B2C `/withdrawals/b2c-result/`) were AllowAny + body-only correlation with NO source check and NO amount cross-check. Public `initiate` mints a real `checkout_request_id` (returned to the donor's own client) before any PIN; the donor could then POST the callback themselves with `ResultCode:0` + any `Amount` and inject arbitrary NET into a campaign wallet — which backs real B2C payouts. RED-confirmed: forged donation credited 974,999 off a 1,000 initiate; forged subscription granted GROWTH free; forged B2C drained a wallet.
- **The fix (RED→GREEN, all 3, 417/417 suite):** (1) settings-driven secret path segment on all 3 routes (`MPESA_CALLBACK_SECRET`, empty-safe, prod-startup fails if empty); (2) amount cross-check on donation+subscription (credit the server-stored initiate amount, reject on mismatch → row stays PENDING for reconciliation); (3) B2C identity guard confirmed sufficient (correlation by server-generated ids; deliberately NOT narrowed to PROCESSING-only, preserving late-callback-on-FAILED recovery).
- **Still deferred to go-live (logged):** Safaricom source-IP allowlist (needs prod IPs + the PH1-05 proxy-IP fix; the secret path is a bearer-secret-in-URL, defense-in-depth not authentication); STK Push Query backstop (live-Daraja work).

### New carry-forward (separate bug, logged not fixed)
- **Missing `b2c-queue/` route:** `QueueTimeOutURL` is sent to Daraja but no route is mounted — a B2C timeout has nowhere to land. Not a security hole; a missing handler. Fix before relying on B2C timeout recovery in prod.

### Audit remaining work (post-PH2-01), by triage bucket
- **Faked FE features (MEDIUM, launch-blockers — real slices):** PH4-04 campaign-create is entirely mock (fakes success, persists nothing — biggest, an unwired feature); PH4-05 password-reset is a no-op stub; PH4-01 super "Approve Payout" is a dead button faking success on a money surface (likely just remove it — approval is treasurer-only).
- **Prod-hardening cluster (MEDIUM/LOW — fold into go-live ops, overlaps existing Tier-1):** PH1-05 per-process rate-limit + REMOTE_ADDR-only IP (throttles + portal IP-binding collapse behind a proxy — also gates the source-IP allowlist above); PH1-03 audit-REVOKE-as-migration (already a Tier-1 item); PH2-03 transport headers (HSTS/SSL-redirect/secure cookies); PH1-06 donation-initiate per-IP throttle; PH2-02 HTML-escape user data in transactional emails **(✅ CLOSED 2026-07-02 (commit 755cb9f) — `integrations/resend_email.py` `html.escape()`s church_name/reason/donor_name/campaign_title/receipt; server-gen otp/amount safe)**; PH1-01/04/07/08 token-lifetime/login-lockout/register+refresh throttle/reset-timing.
- **FE↔BE (LOW):** PH4-03 admin-granted paid tier (null expiry) renders as "FREE/Upgrade" to the treasurer; PH4-02 hardcoded landing hero stats on a "transparency" homepage.
- **Dead code (mostly CLOSED 2026-07-08, commit `4709e88`):** ✅ DELETED — `DisbursementRequestForm.tsx`, `CampaignCreationForm.tsx`, `donationsService.listForCampaign`, orphaned `auditlog.mock`/`notifications.mock` (+ `groups.mock`/`donations.mock`). ⬜ STILL PRESENT (deferred, not re-confirmed unused this pass): `dayjs` dep (`frontend/package.json:18`), routed-but-unused `/campaigns/{slug}/updates/` (`campaigns/urls.py:42`).

**Verified-clean under active attack (coverage, not just problems):** JWT forgery/claim-injection/refresh-replay, cross-tenant IDOR sweep, mass-assignment on every serializer, portal OTP/token guards, audit actor integrity, money exactly-once (STK/B2C/resolve-paid replay), Net-Everywhere leak-free, no SQLi/XSS sink, state machines 51/51, E2E money journeys 27/27.

---

## ✅ All three audit FE-fakes CLOSED (the "lying toast" class is gone)

- **PH4-01 super "Approve Payout" — DELETED.** No backend super-approve endpoint, not an intended role (approval is treasurer-only). The fake also leaked the full destination phone on the super surface — both gone. The 4 legit super actions (read, force-retry, resolve-retry, resolve-paid) untouched; PENDING rows now read-only with masked phone.
- **PH4-05 password-reset — WIRED + login-verified.** Was a no-op stub faking success; now real `/auth/password-reset/{request,confirm}/`. Gate proof: reset → log in with the NEW password works; old password dead; all refresh tokens revoked; enumeration opacity preserved (unknown email still advances, no leak); server password-policy 400 surfaces. (OTP via email — same real-comms-in-staging limitation as STK/SMS.)
- **PH4-04 campaign-create — WIRED + persists.** Was entirely mock (fake success, mock labels, guessed slug). Now real `POST /campaigns/mine/create/`: real church-scoped group-label picker, real persistence (church/created_by/status server-set, raised/wallet 0, AuditLog), nav to the real campaign by **server slug**. Two backend hardening changes folded in (RED-green): `banner_image_url` made optional (at the time, no upload feature existed — **SUPERSEDED**: image upload is now built; `banner_image_url` is server-set via the upload endpoint — see the IMAGE UPLOAD section below), and `goal_amount` given a clean `min_value=1` (was 503-disguised-as-slug-error on ≤0, now honest 400). Suite 422/422.

## ✅ IMAGE UPLOAD — built as a SECURITY feature (the audit's "no upload surface" is now a *guarded* surface)

Built backend-guard-first, RED→GREEN on every guard, proven at the DB layer, the patched seam, AND the live MinIO wire. Baseline 422 → 480.

- **Slice 1 — URL-field write-lock (CLOSED, live-gated).** `banner_image_url` (Campaign) + `logo_url` (Church) were client-writable free-text URLField on the admin serializers (a treasurer could PATCH any off-domain URL). Flipped server-set-only (banner: `read_only=True` on the declared field; logo: into `read_only_fields`). Live PATCH gate: evil URL silently dropped, DB unchanged. Broke no FE write. 422→425.
- **Slice 2a — object-storage client (CLOSED, live-gated).** `integrations/object_storage.py` (boto3, mirrors the daraja client; NOT django-storages). Single `ObjectStorageError` (no clean/ambiguous split — no money in flight). 6 `S3_*` settings via `env()`. Seam-tested + live round-trip (head_object ruled out an FS-fallback false-green). 425→431.
- **Slice 2b-i — MediaAsset model (CLOSED).** New `media` app. Kind-discriminated (BANNER/LOGO), nullable campaign+church FKs, owner-XOR-matches-kind CheckConstraint `mediaasset_owner_matches_kind` verified at the Postgres layer + 4 IntegrityError REDs. 431→437.
- **Slice 2b-ii — image validator (CLOSED).** `media/validation.py` pure `validate_and_reencode`. Order: size cap → magic-byte → Pillow decode under MAX_IMAGE_PIXELS bomb guard → JPEG/PNG allowlist → re-encode (strips polyglot tail+metadata) → downscale to 2000. Seen-failing-first on re-encode, proven for BOTH JPEG and PNG containers. 437→449.
- **Slice 2b-iii — banner endpoint (CLOSED, seam-proven).** `POST /api/v1/campaigns/mine/<slug>/banner/` — `CampaignBannerUploadView(_CampaignActionBase)`, MultiPartParser. Order: IDOR (object-scope BEFORE bytes read) → DoS (size gate before read) → validate → server keygen `campaign/<id>/banner/<uuid4>.<ext>` → put_object(CLEAN bytes) → metadata commit after confirmed PUT. REDs (patched storage): cross-tenant IDOR (403, put_object+validator never called), stores-clean-not-raw (C-teeth proven). 449→454.
- **Slice 2b-iv — live banner upload (CLOSED, unpatched, live-gated).** E2E over HTTP vs real MinIO: URL resolves (GET 200), polyglot tail gone from the *served* object, >2.5MB spill-to-temp re-encodes+downscales on the wire. Drift caught: endpoint is under `mine/`; wire `category` is title-case.
- **Slice 3 — church logo upload (CLOSED, live-gated).** Self-scoped (church from request.user; injected church_id ignored — proven structural via C-teeth). Reuses validator + storage client + MediaAsset(kind=LOGO). Live: church/* prefix serves, polyglot stripped on the wire. 460 tests.
- **Slice 4a — FE render (CLOSED, live-gated).** Fixed banner-nullability type lie (bannerImageUrl optional + mapper ?? undefined); RemoteImage null-guard at 4 sites. Live: real banner + placeholder on one screen, image GETs 200, no broken icons. tsc clean.
- **Slice 4b — user-driven logo upload (CLOSED, live-gated).** Picker → multipart POST /churches/me/logo/ → server re-validate → MinIO → render. Web-blob branch + Content-Type override for the boundary. Live: pick a file, logo changes AND survives hard refresh. Added expo-image-picker. Backend guard is the trust boundary; FE checks are UX only.
- **Cleanup slice (CLOSED, live-gated).** SS0 delete_object (idempotent, live-proven). SS1 object_key UNIQUE index (Postgres-verified + RED). SS2 replace/dedup (owner-scoped, best-effort post-commit; cross-owner-delete C-teeth; live: re-upload deletes old object, OLD_URL 404). SS3a list_objects (paginated, multi-page proven). SS3b sweep_orphan_media (dry-run default, grace window, referenced-set diff; over-delete C-teeth; live: takes only the orphan, live survives --commit). 480 tests.

## 🔜 Image-upload carry-forwards (deploy/ops + remaining slices)

Deploy/ops (go-live, NOT buildable pre-deploy):
- **Prod object storage is a SEPARATE go-live decision.** MinIO is **DEV-ONLY** (CE is now source-only / frozen-binary / AGPL — never ships to prod). Prod = a real cloud S3-compatible store (R2 / Backblaze B2 / Spaces / S3). Swap is config-only (6 `S3_*` env vars; client uses a configurable `endpoint_url`).
- **Public-read bucket policy MUST be prefix-scoped to `campaign/*` and `church/*` only — never the whole bucket.** Single riskiest line in the feature. Dev proved it (root-prefix object → 403). Re-decide + re-prove on the prod bucket.
- **Browser-GET CORS** on the prod bucket (served URLs fetched cross-origin by the web FE).
- **Reverse-proxy body cap** (`client_max_body_size` ~5–6 MB) as first-line DoS gate ahead of Django's read.
- **Gate `S3_*` in `validate_env()`** prod-required list once upload is prod-reachable (currently NOT gated — fine while dev-only).
- deps added: `boto3==1.40.0`, `botocore==1.40.76`, `jmespath==1.1.0`, `s3transfer==0.13.1`.
- **Dev env-state lives OUTSIDE git:** MinIO data dir is J:\minio-data; bring-up script Downloads\minIO\minio_bringup.ps1 points at J:. A fresh checkout has neither — uploads 404 against an empty MinIO until bring-up runs. Add to the dev-setup runbook.
- **Storage-full monitoring (prod ops):** a full bucket → XMinioStorageFull → endpoint 502s, persists nothing (proven live). Prod needs free-space alerting before the store fills.
- **sweep_orphan_media cron:** schedule (dry-run first, then --commit) with the unscheduled sweep_stranded_withdrawals + process_subscriptions crons. It DELETES — dry-run in prod first to confirm the referenced-set is complete.

Remaining buildable slices (pre-deploy):
- **Slice 3 — church logo upload** (self-scoped to `request.user.church`; near-copy of the banner endpoint; reuses validator + storage client + MediaAsset `kind=LOGO`).
- **Slice 4 — FE render** (watch the real banner/logo load; FE already receives the URLs, just doesn't render them yet).
- **Cleanup slice** — replace/dedup (each upload currently orphans the prior object), orphan sweep, and the deferred `object_key` DB unique index.
- **`document_url` (Campaign) — ✅ LOCKED read-only at the serializer layer.** Listed in `AdminCampaignSerializer.Meta.read_only_fields` (`campaigns/serializers.py:131`, rationale :128-131), so DRF silently drops any client value; regression-guarded by `test_image_field_lock.py:114`. The model field stays a plain `URLField` (`campaigns/models.py:70`) — the lock is serializer-layer by design (same pattern Slice 1 used for banner/logo).

## Status after the audit-remediation pass

**Buildable-now scope (as of the audit pass) was nearly exhausted — then the IMAGE UPLOAD feature was built as a security surface (see below); its logo + FE-render + cleanup slices remain buildable pre-deploy.** Slice-by-slice build (Tiers 2/3/5) + audit remediation (PH2-01 critical fix + 3 FE-fakes) are done and verified. What remains needs the deploy environment:
- **Prod-hardening cluster** (go-live ops): PH1-05 proxy-IP/rate-limit-cache, PH2-01's source-IP allowlist, PH2-03 transport headers, PH2-02 email HTML-escape **(✅ CLOSED — `resend_email.py` `html.escape`)**, PH1-06 donation throttle, PH1-01/04/07/08 token/lockout/throttle items, PH1-03 audit-REVOKE-as-migration.
- **The original Tier-1 live gates**: STK success round-trip, OTP-over-real-SMS, production Daraja, prod DB REVOKE, sweep cron, the missing `b2c-queue/` route.
- **Dead-code triage** (audit Appendix A): ✅ DELETED 2026-07-08 (commit `4709e88`) — `DisbursementRequestForm.tsx`, `CampaignCreationForm.tsx`, `donationsService.listForCampaign`, orphaned mock files. ⬜ STILL PRESENT (deferred, unused-status not re-confirmed this pass): `dayjs`, routed-but-unused `/campaigns/{slug}/updates/`.

## ✅ UI REDESIGN — MERGED TO MASTER 2026-07-15 (`fab9e17`, pushed)

The production-level responsive/aesthetic overhaul is merged to master — no longer a branch experiment.

- **Merge `fab9e17`** (`--no-ff`): 12 slices, **aesthetic-only, palette locked, 48 files (+4108/-1793)**, zero logic edits. Rollback point `97692a9`. The `ui-redesign` branch is now merged history (delete-candidate). Baseline re-verified **499 green** post-merge.
- **Back-button arc (`183c3cb`):** A6 live audit found the register/reset **clip regression** (`y=-142`, flex-centering overflow carried the buttons off-screen). Fixed via a **web-only `position:fixed` edge overlay** (`absolute` on native). **Standing convention: all back buttons top-left window edge on wide web.** Accepted exceptions (owner): `treasurer/campaigns/new` + `groups` inline text back-links. **Guarded-back** (`canGoBack() ? back : replace(parent)`) applied to the six former bare `router.back()` sites — deep-link no-ops fixed.
- **Playwright e2e suite:** `frontend/e2e/back-buttons.spec.ts` + `global-setup.ts` + `playwright.config.ts` (retries 0, 90s timeout, unique OTP email/run). Proven RED→GREEN on the clip bug; 3× clean at retries 0 after the harness fix (`09ffcc4`).
- **Dead-button sweep (`c77ec4b`):** whole-frontend sweep found exactly ONE dead control (treasurer Recent Donations "See all", pre-existing on both branches). Fixed by gating `SectionHeader`'s link on `onPress` — the component can no longer render a handler-less link.

### ⚠ SECURITY NOTE — DEBUG-only test endpoint (`09ffcc4`)
`POST /api/v1/dev/reset-ratelimit/` (in `config/urls.py`) clears the rate-limit cache for e2e runs. **Mounted ONLY under `if settings.DEBUG:` — the route does not exist when `DEBUG=False`.** A prod deploy accidentally running `DEBUG=True` WOULD expose it. **Strengthens the case for a `validate_env` startup assert that `DEBUG` is False in prod** (see OPEN ITEMS below).

## ⬜ OPEN ITEMS — pre-deploy buildable + deferred (verified present 2026-07-16)

- **DEBUG demo callback simulator** — the ONE buildable pre-deploy item (lets a demo drive a fake Safaricom success callback without a real handset). Not yet built.
- **`validate_env` slice** — assert callback URLs contain `MPESA_CALLBACK_SECRET` **and** assert `DEBUG=False` in prod (would also fence the dev reset-ratelimit route above). Owner has deferred; reviewer flags it.
- **Fee rounding** — `5 × 0.975 = 4.875` stored as `4.87`; rounding **direction never confirmed deliberate**. Decide before go-live.
- **IntaSend payout capability for an unregistered account: UNPROVEN** — marketing claims only; needs one real third-party payout test before relying on it as the money-OUT path around the sandbox B2C 2040 wall.
- **Production Daraja go-live paperwork** + all Tier-1 `[LIVE]`/`[OPS]` gates (see Tier 1 above): STK success round-trip, OTP-over-real-SMS, prod DB REVOKE, sweep cron, `b2c-queue/` route.
- **Deferred debt:** `dayjs` dep (`frontend/package.json`), routed-but-FE-unused `/campaigns/{slug}/updates/` route, OTP-portal dashboard header deliberately uncapped, the 4 dead `components/layout/` sidebar/nav files.

## ✅ RESPONSIVE WEB UI BASELINE — DONE 2026-07-12 (slices 1–11, committed + pushed)

The whole frontend is now responsive on web ≥768px; phone rendering is identical by construction (every wide style is gated on `useIsWideWeb()`). Backend suite re-confirmed green after the arc (UI-only work).

**New shared components — all future screens MUST use them:**
- `components/layout/Screen.tsx` — `useIsWideWeb()` (web AND width ≥ 768) + `<Screen>` wrapper with content-cap variants 480 / 760 / 1100.
- `components/ui/ResponsiveSheet.tsx` — the only dialog wrapper: bottom sheet on phone/narrow, centered max-480 card on wide web (`visible / onRequestClose / dismissable / keyboardOffset`). No more hand-rolled Modal+overlay+sheet constructions (payouts reject, OTP-portal payout, DisbursementApprovalDialog all converted).

**Conventions (owner-decided):** back buttons anchor at the window edge (`left: Spacing.md`), not the content column; list screens 760; grids 1100 with 3-across (analytics stat tiles 4-across); forms/OTP 480; top bars full-bleed teal with the inner title/actions row capped at 1100 so bar content aligns with page content; tab bars untouched.

**Known accepted costs:**
- FlatList `numColumns` remount resets scroll when the window crosses 768.
- `DisbursementApprovalDialog` narrow-mode deltas from ResponsiveSheet adoption (overlay 0.45→0.40, paddingTop sm→md, gap 4→sm) — accepted by owner.
- OTP-portal dashboard header inner row deliberately uncapped.
- Dead delete-candidates: the 4 unused `components/layout/` files (TopNav, NotificationBell, TreasurerSidebar, SuperAdminSidebar — the landing page uses its own local TopNav).

---

## ✅ HIGH-VALUE non-code task — DONE 2026-07-09: context files reconciled
The §0 "still mock / not wired" list overstated remaining work **4× this session** (resolve-paid, request-disbursement form, billing tier-prices were all already built; PH2-01 was rated MEDIUM when it was CRITICAL). A future session trusting a stale §0/severity will chase phantom slices or under-rate a real hole. Also: at the time this to-do was written the test baseline had drifted to **422** (docs variously said 299 / 406) — reconcile §0, the wired/mock status of every screen, and that baseline against reality so the next session starts from truth, not drift. **✅ DONE 2026-07-09:** §0/status reconciled — set to the **499** baseline (see CURRENT VERIFIED BASELINE above); C2 reports-export (BUILT), C3 document_url (LOCKED) and C4 PH2-02 (CLOSED) phantom-open items corrected; dead-code cluster partially closed (FE deletions done; `dayjs` + `/campaigns/{slug}/updates/` deferred).
