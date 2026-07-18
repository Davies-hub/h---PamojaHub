# Pamoja Hub — Developer Handoff

_Last updated: 2026-07-18. This file is the orientation doc for a new contributor or a new chat. For the most granular live status read `CLAUDE.md` (loaded every session) → `PamojaHub_Compressed_v2.md` §0/§18 → the persistent memory index._

> **Where the repo is right now (2026-07-18):** `master` at **`d3f4270`**, tree **clean**, **`origin/master` synced**. Backend suite **528 green** (`manage.py test tests`). Recent arc: optional **church logo at registration** (`d3f4270` — anonymous multipart, post-commit orphan-safe, 3/h per-IP), **media key-storage** (`45f7c2d` — bare object keys stored, URLs minted at serialization), **fresh dashboards** (`6566765` — focus-refetch everywhere, pull-to-refresh, 45s focused polling on treasurer Overview), and campaign **pause/resume/close wired on the detail screen** (`23f1bf7`, was local-mock). Banner + logo upload now work on **laptop AND Android**.

> **UI redesign MERGED to master 2026-07-15 (`fab9e17`, pushed).** The production-level responsive/aesthetic UI overhaul is no longer a branch experiment: 12 slices, aesthetic-only, palette locked, 48 files, zero logic edits (rollback point `97692a9`; the `ui-redesign` branch is now merged history / delete-candidate). Back-button clip regression fixed with a web-only `position:fixed` edge overlay (`183c3cb`) — **standing convention: all back buttons top-left window edge on wide web** (except the `treasurer/new` + `groups` inline links). A Playwright e2e suite (`frontend/e2e/back-buttons.spec.ts`) now guards it. A DEBUG-only test route `POST /api/v1/dev/reset-ratelimit/` was added (absent when `DEBUG=False`). Backend baseline was re-verified **499 green** post-merge on 2026-07-15 (historical — the live number is **528**, above). See `docs/deploy_checklist_status.md` for the full open-items list.

---

## What is Pamoja Hub?

Kenya's church crowdfunding platform. Churches register, create campaigns, and donors give via M-Pesa **STK push**. Every shilling is on record — the platform proves where money went. Two roles: **Church Treasurer** (manages campaigns, requests payouts) and **Super Admin** (approves churches, oversees the platform).

---

## Monorepo layout

```
j:\Pamoja_Hub\
  frontend/        ← Expo SDK 56 / React Native / TypeScript (Phase 1 complete, wired to API)
  backend/         ← Django 5 + DRF + PostgreSQL (Phase 2 complete; venv at backend\venv\)
  CLAUDE.md        ← session context + critical rules (READ FIRST)
  PamojaHub_Compressed_v2.md  ← deep live status (§0), deviations (§14), Daraja findings (§14.1)
  PamojaHub_BuildGuide.md     ← the original step-by-step build spec (historical)
  DESIGN_SYSTEM.md            ← component specs + UX rules
  HANDOFF.md       ← this file
```

---

## Build phases & where we are (2026-07-18)

Build order (per the BuildGuide): **Frontend (UI shells w/ mock) → Backend (API + logic) → Database (indexes/constraints) → Connect (wire FE↔BE).**

| Phase | State |
|---|---|
| **Phase 1 — Frontend** | ✅ Complete + responsive/aesthetic overhaul MERGED to master 2026-07-15 (`fab9e17`). All public/auth/treasurer/super screens built. `tsc --noEmit` = 0; `npm test` (vitest) = 60/60. Playwright e2e back-button spec exists but **`npm test` excludes `e2e/**`** — it never runs under vitest; run it separately. |
| **Phase 2 — Backend** | ✅ Complete. 11 Django apps, Steps 2.1 → 2.12b. **528 tests** green (live `manage.py test tests` count, verified 2026-07-18 — registration-logo slice; was 522 after media key-storage 2026-07-18, 513 on 2026-07-16, 499 post-merge 2026-07-15, 422 on 2026-06-26). |
| **Phase 3 — DB hardening** | 🟡 Partial. Indexes/constraints + AuditLog `REVOKE UPDATE/DELETE` applied to **dev** DB. The prod REVOKE is **not a migration** — run manually before go-live (`backend/docs/production_db_hardening.md`). |
| **Phase 4 — Connect FE↔BE** | ✅ Functionally complete. All reads + all writes wired & live-verified, incl. the two former launch-blockers (campaign-create + password-reset, closed 2026-06-26). Zero mock imports / dead service methods remain (verified 2026-07-16). |

**No functional gap remains.** Both former launch-blockers are closed: campaign-create (`frontend/app/(treasurer)/campaigns/new.tsx`) now calls `campaignsService.create` → real `POST /api/v1/campaigns/mine/create/` with live group labels (`groupsService.list`), and auth password-reset (`auth.service.ts:82-103`) hits the live `/auth/password-reset/{request,confirm}/` endpoints. Zero `mock/` imports remain anywhere under `app/**` (the OTP-portal greeting was neutralized 2026-07-07; `mockTreasurerProfile` has zero frontend hits, re-verified 2026-07-16), and the dead `donationsService.listForCampaign` was deleted 2026-07-08 in commit `4709e88`. See `CLAUDE.md` → "KNOWN OPEN GATES" for the live/ops items still deferred to go-live.

---

## How to run

**Backend (Django, port 8000):**
```powershell
backend\venv\Scripts\python.exe backend\manage.py runserver --noreload
```
Tests (from repo root — the suite lives in the `tests` package; bare `manage.py test` discovers 0):
```powershell
backend\venv\Scripts\python.exe backend\manage.py test tests
```

**Frontend (Expo, web on port 8081):**
```powershell
cd j:\Pamoja_Hub\frontend
npx expo start --clear          # web + Expo Go QR
npx tsc --noEmit                # typecheck (must be 0)
npm test                        # vitest (60) — EXCLUDES e2e/**
npx playwright test             # back-button e2e — separate run, never part of npm test
```

**Physical-device (Android) dev:** `EXPO_PUBLIC_API_URL` is **bake-time** — export `http://<laptop LAN IP>:8000/api/v1` in the shell *before* starting Metro (the `localhost` fallback resolves to the phone itself). Backend runs `runserver 0.0.0.0:8000 --noreload` with the LAN IP in `ALLOWED_HOSTS`; MinIO binds `0.0.0.0:9000` with a LAN-IP `S3_PUBLIC_URL_BASE`. See `CLAUDE.md` → "Physical-device dev setup".

**Critical npm rule:** always install with `--legacy-peer-deps` — React **19.2.3** is exact-pinned and most Expo packages declare peer deps for older React. Never let `npx expo install` change the React version.

**Dev logins (pamoja_dev DB):** every account's password is `D1ReviewPass!234`. Super admin = `admin@pamojahub.co.ke`; a good treasurer demo = `active.treasurer@pamojatest.local` or `stktreas@example.org`.

---

## Tech stack (pinned — do not change versions)

| Layer | Choice |
|---|---|
| Frontend | Expo SDK 56 / Expo Router 56.2, TypeScript 6, **React 19.2.3 (exact)**, React Native 0.85.3 |
| Fonts / icons | Poppins (Bold/SemiBold/Medium/Regular); `@expo/vector-icons` Ionicons; `expo-linear-gradient` |
| Backend | Django 5 + DRF + SimpleJWT, PostgreSQL, Celery (wired), Daraja (M-Pesa) STK + B2C |
| State | React Context (auth, notifications, pending-queue) — no Zustand |

---

## Architecture you must respect

- **Money-safety invariants** (never relax): lock-then-call — B2C/STK HTTP happens **outside** the DB `SELECT FOR UPDATE`; idempotent callbacks keyed on the unique id; `finalize_withdrawal_paid` decrements the wallet **exactly once** (shared by callback + sweep + resolve). `walletBalance` is always derived (`raisedAmount − Σ PAID withdrawals`), never stored.
- **Multi-tenant isolation:** treasurer reads filter by `request.user.church`; every `/super/` endpoint is `[IsSuperAdmin]` (treasurer → 403).
- **Serializer split is a security boundary:** public serializers are strict allowlists (never expose `treasurerPhone/treasurerName/walletBalance/platformFee/checkoutRequestId`); admin/super serializers over-emit (D1) and the **frontend mappers allowlist** drops the surplus at the boundary.
- **The wire boundary:** DRF serializes `DecimalField` as a **string**; `services/mappers.ts` converts money via `Number()`, per-field snake→camel (never a generic deep-convert).
- **Media is key-storage (since 2026-07-18):** uploads persist the **bare object key**, never an absolute URL; the browser-facing URL is minted at **serialization** time by `media_url()` (`integrations/object_storage.py:164`) through `MediaURLRepresentationMixin`. `S3_PUBLIC_URL_BASE` is read at call time, so re-pointing the base re-points every key-holding row with no DB rewrite. Rows written before the refactor hold absolute URLs and **pass through unchanged** (no backfill by design) — they only gain a key on re-upload. Banner + logo upload are live-gated on **laptop and Android**; for phone-visible images dev needs a **LAN-IP** `S3_PUBLIC_URL_BASE` and MinIO bound to `0.0.0.0:9000`.
- **`Alert.alert` is a no-op on web** — use `ResponsiveSheet` for every confirm/destructive dialog. (Two known stragglers remain: super churches suspend/reactivate.)
- **Net-Everywhere:** all church-facing amounts are NET (post 2.5% fee). Exceptions: donor success screen shows gross (matches M-Pesa SMS); Super Admin Donations table shows gross/fee/net.
- **UI says "Payout", backend model is `Withdrawal`** — do not rename backend identifiers.

---

## API surface (Base: `/api/v1/`)

`/auth/` (register — optionally **multipart** with a `logo` file; login, me, token/refresh, logout, password-reset) · `/treasurer/` (OTP portal: request-otp, verify-otp, campaigns, report, request-disbursement, disbursements) · `/churches/` (public list/detail, me GET+PATCH, me/stats, me/donations) · `/campaigns/` (public browse/detail, mine list, mine/create, mine/{slug} + pause/resume/close, updates) · `/group-labels/` (CRUD + archive/unarchive) · `/donations/` (initiate, callback, {id}/status) · `/subscriptions/` (initiate, cancel, callback, {id}/status) · `/withdrawals/` (list, approve, reject, retry, b2c-result) · `/notifications/` (list, unread-count, {id}/read, read-all) · `/super/` (all 8 reads + church approve/reject/suspend/reactivate/set-tier + withdrawal force-retry/resolve-paid/resolve-retry + billing).

---

## Frontend layout

```
frontend/
├── app/
│   ├── (public)/    landing, campaigns (list+detail), churches (list+detail), treasurer OTP portal
│   ├── (auth)/      login, register, reset-password
│   ├── (treasurer)/ overview, campaigns (list/new/[slug]), payouts, reports, settings, +hidden: notifications, groups
│   └── (super)/     queue, churches, withdrawals, analytics, billing, more, +hidden: campaigns, donations, audit-log
├── components/      ui/, campaign/, layout/, disbursement/, treasurer/ (SubscriptionCard)
├── services/        api.ts, portalClient.ts, mappers.ts + per-domain services (ALL wired to the real API — create + password-reset included)
├── hooks/           useFocusRefetch.ts (background refetch-on-focus, keep last-good)
├── stores/          auth.store, notifications.store, pendingQueue.store (React Context)
├── constants/       theme.ts (all brand tokens)
├── types/           index.ts (every interface)
└── mock/            fixtures for the vitest consistency suite ONLY — zero `mock/` imports remain under app/**
```

Route groups are transparent — `(public)` is not in the URL. `/campaigns` → `app/(public)/campaigns/index.tsx`.

---

## Design tokens — `constants/theme.ts`

```
Colors.primary=#057C8A (teal)  primaryDark=#035F6B  primaryLight=#D5EEF1
Colors.accent=#ED8F1C (orange — CTA, progress fill, "Hub" wordmark)  accentDark=#C97710  accentLight=#FEF3E2
Colors.text=#1A1A1A  textSecondary=#555555  textMuted=#888888  border=#CCCCCC
Colors.background=#FFFFFF (ALL screens — always white)  grey=#F5F5F5
Colors.success=#1A7A4A  danger=#C00000  warning=#C97710  (each with a *Light pair)
Spacing.touch=48  FontSize xs12…title28  BorderRadius sm4/md8/lg12/xl16/pill999
```
Wordmark: on white → "Pamoja" teal + "Hub" orange, Poppins-Bold 22. PNG logo only on teal/dark. **Progress bars always use `Colors.accent`, never primary teal.**

---

## Security rules — NEVER violate

1. Public screens never expose `treasurerPhone`, `treasurerName`, `walletBalance`, `platformFee`, `checkoutRequestId`, `b2cConversationId`.
2. OTP codes are hashed before storage — never store/log/display a plaintext OTP.
3. `.env` is gitignored — never commit it. (`Set-Content -Encoding utf8` adds a BOM that corrupts `.env`; edit via Bash/sed.)
4. All screen backgrounds are `#FFFFFF`.
5. `--legacy-peer-deps` on every npm install (React 19.2.3 pinned).

---

## Daraja (M-Pesa) status

- **B2C** proven live end-to-end (PAID + exactly-once wallet decrement) via sandbox app **600992** (old 600977 was initiator-locked → 8006). Re-proven on the super-admin force-retry path.
- The Transaction-Status active-query / auto-redispatch design was **disproven on the live wire and DELETED**. Stranded payouts escalate to `NEEDS_RECONCILIATION` via the escalate-only command `manage.py sweep_stranded_withdrawals`; only Super Admin resolve-paid / resolve-retry can clear them.
- **STK SUCCESS-callback parse: ✅ CLOSED LIVE 2026-07-09** — a real-SIM sandbox donation (KES 5, real PIN prompt) delivered a genuine `ResultCode: 0` callback from Safaricom (receipt `UG9KTAG8ZR`), processed end-to-end by the real handler (credited exactly once, NET of fee). The old "sandbox never delivers a success array" belief was FALSE — it only fails for the virtual test MSISDN; a real SIM works. **Root cause of every prior "no callback": the `.env` callback URLs were missing the `MPESA_CALLBACK_SECRET` path segment**, so the router 404'd real callbacks since PH2-01 — fixed in `backend/.env` (any URL handed to Daraja must carry the secret segment, production included). Note: sandbox STK charges REAL money and M-Pesa auto-reverses it.
- **Sandbox B2C cannot pay a REAL phone** (proven 2026-07-09/10): ResultCode 2040 "Credit Party customer type can't be supported", identical for `BusinessPayment` and `SalaryPayment` — by design (test MSISDNs only). Payouts to real numbers require production Daraja B2C or an aggregator disbursement API. The result callback DID arrive on the fixed secret path and drove FAILED correctly — B2C callback delivery is proven post-fix; only the real-destination credit is walled.
