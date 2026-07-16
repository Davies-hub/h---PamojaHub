# Pamoja Hub — Project Context for Claude

> This file is read by Claude Code at the start of every session. Keep it up to date.
> Full docs: HANDOFF.md · DESIGN_SYSTEM.md · PamojaHub_BuildGuide.md

---

## What this project is

Kenya's church crowdfunding platform. Churches register, create fundraising campaigns, and donors give via **M-Pesa STK push**. Every shilling is on record. Two roles: **Church Treasurer** (manages campaigns, requests disbursements) and **Super Admin** (approves churches, oversees platform).

Working directory: `j:\Pamoja_Hub\`  
Frontend: `j:\Pamoja_Hub\frontend\` — Expo SDK 56 / React Native / TypeScript (Phase 1 complete)  
Backend: `j:\Pamoja_Hub\backend\` — Django 5 + DRF + PostgreSQL (Phase 2 complete; venv at `backend\venv\`)

---

## Critical rules — never violate

1. **npm installs require `--legacy-peer-deps`** — React 19.2.3 is pinned; never let `npx expo install` change it
2. **All screen backgrounds = `#FFFFFF`** — never cream, never off-white
3. **Public screens never expose**: `treasurerPhone`, `treasurerName`, `walletBalance`, `platformFee`, `checkoutRequestId`
4. **JSX in `.ts` files is illegal** — use `React.createElement()` or rename to `.tsx`
5. **Progress bars always use `Colors.accent` (`#ED8F1C`)** — never primary teal
6. **Route conflicts**: never have both `campaigns.tsx` AND `campaigns/index.tsx` in the same directory
7. **Net-Everywhere**: all church-facing amounts are NET (post 2.5% fee). Exception: donor post-donation success screen shows gross to match M-Pesa SMS; Super Admin Donations table shows gross/fee/net.
8. **walletBalance is derived** — always `raisedAmount − Σ(PAID withdrawals)`; never hardcode it
9. **UI strings use "Payout" not "Disbursement"** — backend `Withdrawal` model name is unchanged
10. **Backend tests** run from repo root via the `tests` package: `backend\venv\Scripts\python.exe backend\manage.py test tests` — bare `manage.py test` discovers **0**. Keep the suite green. **Baseline = 499** (this number is the live `manage.py test tests` count — re-verified green post-merge 2026-07-15 on master `fab9e17`, 499/499 OK; update it whenever the count changes).
11. **Decimals are STRINGS on the wire** — DRF serializes `DecimalField` as a string (`"80000.00"`); the frontend converts via `Number()` in `services/mappers.ts`. Mappers are explicit per-field (snake→camel), never a generic deep-convert.
12. **Multi-tenant isolation** — treasurer read endpoints filter by `request.user.church`; every `/super/` endpoint is `[IsSuperAdmin]` (treasurer → 403). Never omit; never relax the money-safety invariants (lock-then-call: B2C/STK HTTP happens OUTSIDE the DB lock; idempotent callbacks keyed on the unique id).
13. **Phase 4 slice discipline** — per slice: READ-ONLY contract trace (quote file:line, NO edits) → BUILD (restart backend `--noreload` on current code, ONE live checkpoint) → STOP for review. READS are wired before WRITES; money-write actions are their own later slices.

---

## Tech stack (pinned — do not change versions)

| | |
|---|---|
| Framework | Expo SDK 56 / Expo Router 56.2 |
| Language | TypeScript 6.0.3 |
| React | **19.2.3** (exact pin) |
| React Native | 0.85.3 |
| Navigation | Expo Router file-based routing |
| Fonts | Poppins only (Bold/SemiBold/Medium/Regular) |
| Icons | `@expo/vector-icons` Ionicons |
| Gradients | `expo-linear-gradient` |

---

## Design tokens (from `constants/theme.ts`)

```
Colors.primary      = '#057C8A'  // teal — nav bars, primary buttons, links
Colors.primaryDark  = '#035F6B'
Colors.primaryLight = '#D5EEF1'  // chip/pill backgrounds
Colors.accent       = '#ED8F1C'  // orange — CTA buttons, progress fill, "Hub" wordmark
Colors.accentLight  = '#FEF3E2'
Colors.accentDark   = '#C97710'
Colors.text         = '#1A1A1A'
Colors.textSecondary= '#555555'
Colors.textMuted    = '#888888'
Colors.border       = '#CCCCCC'
Colors.background   = '#FFFFFF'  // all screens — always white
Colors.grey         = '#F5F5F5'  // scroll view / page backgrounds
Colors.white        = '#FFFFFF'
Colors.success      = '#1A7A4A'  Colors.successLight = '#D4EDDA'
Colors.danger       = '#C00000'  Colors.dangerLight  = '#FDECEA'
Colors.warning      = '#C97710'  Colors.warningLight = '#FEF3E2'

Spacing.touch = 48  // minimum touch target everywhere
FontSize: xs=12 sm=13 md=14 base=15 lg=16 xl=18 xxl=20 xxxl=22 title=28
BorderRadius: sm=4 md=8 lg=12 xl=16 pill=999
```

Wordmark rule: on white → "Pamoja" in `#057C8A` + "Hub" in `#ED8F1C`, Poppins-Bold 22px. PNG logo only on teal/dark backgrounds.

---

## Route groups (Expo Router)

```
app/
  (public)/     Public screens — no auth required
  (auth)/       Login, register, reset-password
  (treasurer)/  Treasurer dashboard — tabs layout, auth-gated
  (super)/      Super admin portal — tabs layout, auth-gated
```

Route groups are transparent — `(public)` is not in the URL. `/campaigns` maps to `app/(public)/campaigns/index.tsx`.

---

## Responsive web UI baseline (2026-07-12; aesthetic overhaul MERGED 2026-07-15 — MANDATORY for all future screens)

The whole app is responsive on web ≥768px; phone rendering is identical by construction (all wide styles are gated). The 2026-07-15 UI-redesign merge (`fab9e17`) layered a production-level aesthetic pass on top of this baseline (heroes, floating money cards, icon circles, status-coded rows) — see the "UI REDESIGN — MERGED" block above. The two shared components below still carry the responsive system. Two shared components carry the system — **all future screens must use them**:

- **`components/layout/Screen.tsx`** — exports `useIsWideWeb()` (web AND width ≥ **768**) and a `<Screen>` wrapper with content-cap variants **480 / 760 / 1100**.
- **`components/ui/ResponsiveSheet.tsx`** — the ONLY dialog wrapper: bottom sheet on phone/narrow, centered max-480 card on wide web. Props: `visible / onRequestClose / dismissable / keyboardOffset`. Never hand-roll a Modal+overlay+sheet again.

**Conventions (owner-decided):**
- Back buttons anchor at the **window edge** (`left: Spacing.md`), NOT the content column (owner decision, slice 11 reverted the column-anchored math).
- List screens cap at **760**; grids (landing, public lists, analytics tiles) cap at **1100** with 3-across (4-across stat tiles on analytics); forms/OTP screens cap at **480**.
- Top bars stay **full-bleed teal**; their inner row (title + actions) gets the 1100 cap + center so bar content aligns with page content. Tab bars untouched.

**Known accepted costs:**
- FlatList `numColumns` remount resets scroll position when the window crosses the 768 breakpoint (accepted).
- `DisbursementApprovalDialog` narrow-mode deltas from ResponsiveSheet adoption (overlay 0.45→0.40, paddingTop sm→md, gap 4→sm) — accepted by owner.
- OTP-portal dashboard header inner row deliberately uncapped.
- The 4 old `components/layout/` sidebar/nav files (TopNav, NotificationBell, TreasurerSidebar, SuperAdminSidebar) are dead/unused — delete-candidates.

---

## UI REDESIGN — MERGED TO MASTER 2026-07-15 (READ THIS FIRST)

The production-level responsive/aesthetic UI overhaul is **merged to master and pushed** — it is no longer a branch experiment.

- **Merge `fab9e17`** (`--no-ff`) brought the `ui-redesign` branch into master: **12 slices, aesthetic-only, palette locked, 48 files (+4108/-1793)**. Zero logic edits; every wide style stays gated on `useIsWideWeb()` so phone rendering is identical by construction. The `ui-redesign` branch is now merged history — **delete-candidate**. Rollback point: `97692a9`.
- **Back-button arc (`183c3cb`):** the A6 live audit found a register/reset **clip regression** — back buttons rendered inside the flex-centered, overflowing ScrollView were carried off-screen (measured `y=-142`, unreachable). Fixed by moving them OUT of the scroll into a **web-only `position:fixed` edge overlay** (viewport-anchored; `absolute` on native). **STANDING CONVENTION: all back buttons anchor top-left at the window edge on wide web.** Accepted exceptions (owner decision): `treasurer/campaigns/new` + `groups` keep inline text back-links at the content-column top-left (integrated with their capped headers). The **guarded-back pattern** (`canGoBack() ? router.back() : router.replace(parent)`) was applied to the six former bare `router.back()` sites — deep-link no-ops fixed.
- **Playwright e2e suite now exists:** `frontend/e2e/back-buttons.spec.ts` + `frontend/e2e/global-setup.ts` + `frontend/playwright.config.ts` (retries 0, 90s timeout, unique OTP email per run). Proven RED→GREEN on the clip bug; 3× clean at retries 0 after the harness fix (`09ffcc4` — unique OTP email + DEBUG-only throttle reset + globalSetup).
- **DEBUG-only test endpoint (security-relevant):** `09ffcc4` added `POST /api/v1/dev/reset-ratelimit/` in `config/urls.py` — clears the rate-limit cache so e2e runs aren't throttled. **It is mounted ONLY when `settings.DEBUG` is True; the route does not exist when `DEBUG=False`.** ⚠ A prod deploy accidentally running `DEBUG=True` would expose it. Note `validate_env()` EXISTS (`config/settings/base.py:253`, called at import time :296): it already requires `MPESA_CALLBACK_SECRET` (+15 other vars) whenever `DEBUG=False`, and rejects `DEBUG=True` when `MPESA_ENVIRONMENT=production`. The remaining open slice is narrower: (i) assert each `MPESA_*` callback URL actually CONTAINS the `MPESA_CALLBACK_SECRET` segment, and (ii) an unconditional `DEBUG=False` guard in prod (today's guard only fires when `MPESA_ENVIRONMENT=production`) — see open items in deploy_checklist_status.md.
- **Dead-button sweep (`c77ec4b`):** a whole-frontend sweep found exactly ONE dead control — the treasurer Recent Donations "See all" label (pre-existing on both branches, no handler). Fixed by gating `SectionHeader`'s link render on `onPress`, so the component can no longer render a handler-less link.
- **Test baseline: still 499**, re-verified green post-merge on master (`manage.py test tests`). tsc clean; 14/14 back-button specs.

## Current status — 2026-07-10 (READ THIS FIRST)

**Frontend Phase 1:** ✅ complete (screen inventory in the next section). `npx tsc --noEmit` = 0 errors; `npm test` (vitest) = **60/60** (mock-consistency + reducer suites).

**Backend Phase 2:** ✅ complete. Django apps: `audit, accounts, churches, campaigns, donations, withdrawals, notifications, treasurer_portal, superadmin, integrations, common`. Steps 2.1 → 2.12b. **Suite: 499 tests** (live `manage.py test tests` count, 2026-07-09 — run command in critical rule #10).

**Phase 3 (DB hardening):** partial — indexes/constraints + AuditLog `REVOKE UPDATE/DELETE` applied to the **dev** DB only. The prod REVOKE is NOT a migration — run manually before go-live (`backend/docs/production_db_hardening.md`).

**Phase 4 (connect frontend ↔ backend): ✅ FUNCTIONALLY COMPLETE — reads 100%, writes 100% (the two launch-blockers, campaign-create + password-reset, were closed 2026-06-26). Zero mock imports and zero dead service methods remain (verified 2026-07-16).**
- ✅ **Reads (all wired + live-verified):** login, session-restore (`GET /auth/me/`), register, transparent token refresh-and-retry, full server-side logout, public campaign + church LIST/DETAIL, treasurer dashboard (overview / my-campaigns / campaign-detail / payouts / reports / settings / groups), **ALL 8 super-admin reads** (billing, withdrawals, campaigns, donations, queue, analytics, churches, audit-log — zero super mock). Standards: D5 `Paginated<T>{items,total,truncated}` (truncated → notice banner, not paging); D1 admin serializers over-emit, FE allowlist mappers drop the surplus; D2 null money stays null ("—"); D3 audit `details` flattened shape-safe. Shared `hooks/useFocusRefetch.ts` applied to every read screen EXCEPT billing (editable inputs).
- ✅ **Treasurer writes (wired + live-verified):** campaign **pause/resume/close** (`/campaigns/mine/{slug}/…`); payout **approve/reject/retry** (`/withdrawals/{id}/…`, with a verdict-poll harness for approve/retry); **group-labels** create/rename/archive/unarchive; church-profile **PATCH** (`/churches/me/`); **subscription** initiate → STK poll → cancel (settings `SubscriptionCard`); public **OTP portal** request-otp / verify-otp / report / **request-disbursement** (money-write via `portalClient`, `Authorization: Portal` scheme).
- ✅ **Super-admin writes (wired + live-verified):** church **approve/reject** (Queue, in-screen Modals), **suspend/reactivate**, **set-tier** (money-inert); withdrawal **force-retry** (FAILED_FINAL re-dispatch — real B2C), **resolve-retry** + **resolve-paid** (NEEDS_RECONCILIATION exits); billing **PATCH** fee_percent + **growth/parish tier prices**.
- ✅ **Donations (money-IN):** donor STK **initiate + bounded poll** (success only on a SUCCESSFUL verdict).
- ✅ **Subscriptions (backend + FE):** STK initiate/callback, period extend + tier flip via `set_church_tier`, grace-lapse + 7d/1d/grace renewal reminders (cron `process_subscriptions`), down-pay block, cancel-auto-renew. FREE tier capped at 3 ACTIVE campaigns.
- ✅ **Notifications:** recipient-scoped read API (list / unread-count / mark-read / mark-all) wired backend + FE (bell + screen).
- ✅ **Campaign creation (wired 2026-06-26 — PH4-04 closed):** `(treasurer)/campaigns/new.tsx` calls `campaignsService.create` → real `POST /campaigns/mine/create/` (`campaigns.service.ts:66-83`), loads the church's REAL group labels via `groupsService.list` (`new.tsx:226`), and navigates to the server-allocated slug (`new.tsx:343`). No mock import remains in the form. (Backend: banner now optional, `goal_amount` min_value=1.)
- ✅ **Auth password-reset (wired 2026-06-26 — PH4-05 closed):** `authService.requestPasswordReset` / `confirmPasswordReset` hit `POST /auth/password-reset/{request,confirm}/` (`auth.service.ts:82-103`, wire field `otp_code`); `reset-password.tsx:66,92` calls both. Live round-trip verified.
- ✅ **Still mock / unwired: NOTHING.** Zero `mock/` imports remain anywhere under `app/**` (the OTP-portal greeting was neutralized 2026-07-07 — `mockTreasurerProfile` has zero hits in the frontend, re-verified 2026-07-16). The dead, never-called `donationsService.listForCampaign` was **✅ DELETED 2026-07-08**, commit `4709e88`. No functional gap remains.

**Daraja B2C:** proven live end-to-end (PAID + exactly-once wallet decrement) via sandbox app **600992** (re-proven on super force-retry) — **to the sandbox test MSISDN only**. Live-proven 2026-07-09/10: sandbox B2C **cannot pay a REAL phone** (ResultCode 2040 "Credit Party customer type … can't be supported" — identical for `BusinessPayment` AND `SalaryPayment`, so the wall is CommandID-independent and by design); payouts to real numbers need production Daraja B2C or an aggregator payout API — do NOT retry a 2040. Re-confirmed on this wire: Daraja REWRITES `OriginatorConversationID`, so the originator fallback correlation in `B2CResultCallbackView` never matches live — the stored sync-ack `ConversationID` is the only real correlation basis (§14.1). The Transaction-Status active-query/re-dispatch design was disproven on the wire and DELETED; stranded payouts escalate to `NEEDS_RECONCILIATION` via the escalate-only command `manage.py sweep_stranded_withdrawals`. **STK SUCCESS-callback parse: ✅ CLOSED live 2026-07-09** — a real-SIM sandbox donation (KES 5, real PIN prompt) delivered a genuine ResultCode-0 callback (receipt `UG9KTAG8ZR`; sandbox charges REAL money which M-Pesa then auto-reversed). Root cause of every prior "callback never arrived": the `.env` callback URLs lacked the `MPESA_CALLBACK_SECRET` path segment, so the router 404'd every real callback since PH2-01 — **FIXED in `backend/.env`** (donation + B2C result URLs now end in `dev-callback-secret/`; any URL handed to Daraja MUST carry the secret segment, prod included). B2C result-callback delivery re-proven on the fixed path (a real failure callback drove FAILED correctly, wallet untouched).

**Security posture (PH2-01 closed 2026-06):** the forged-callback money-injection vector (originally rated MEDIUM, actually CRITICAL) is **CLOSED**. All three payment callbacks now sit behind a settings-driven secret path segment (`MPESA_CALLBACK_SECRET` → `callback/<secret>/` & `b2c-result/<secret>/`; a bare-path POST 404s at the router — `donations/urls.py:24`, `withdrawals/urls.py:16`, `churches/subscription_urls.py:27`) **plus** a per-shape amount/identity cross-check (donation/subscription credit the SERVER-STORED expected amount and refuse on mismatch — `donations/views.py:244-259`; B2C correlates only to a server-generated dispatch id). Regression-guarded by `backend/tests/test_callback_forgery_hardening.py` (the old forgeable-behavior test was replaced). **Deferred to go-live:** Safaricom source-IP allowlist (defense-in-depth) + PH1-05 trusted proxy-IP derivation — still OPEN.

**KNOWN OPEN GATES (live/ops — cannot be built/closed pre-deploy):**
- **Live STK SUCCESS-callback parse** — ✅ CLOSED 2026-07-09 (see Daraja block above: real-SIM sandbox donation → genuine success callback end-to-end after the `.env` secret-segment fix). Money-IN is fully demoable on sandbox with any real Safaricom SIM (min KES 5; charges real money, M-Pesa auto-reverses).
- **B2C payout to a REAL phone** — OPEN (hard sandbox wall, 2026-07-09: ResultCode 2040). Needs production Daraja B2C or an aggregator payout API; sandbox B2C works against test MSISDNs only.
- **OTP over real SMS / production Daraja** — OPEN. Sandbox app 600992 only; prod Daraja + AT not provisioned.
- **Prod DB REVOKE (audit immutability)** — OPEN. `backend/docs/production_db_hardening.md` is a runbook, NOT a migration; must run manually before go-live (PH1-03).
- **Crons not scheduled** — OPEN. `sweep_stranded_withdrawals` (`withdrawals/tasks.py:104` "NOT scheduled today") and `process_subscriptions` run manually; wire a scheduler at deploy.
- **`/b2c-queue/` route** — ABSENT by design. `MPESA_B2C_QUEUE_URL` is sent to Daraja as QueueTimeOutURL but no route consumes it (`backend.env.example:35-38`).
- **Prod-hardening cluster (deferred to launch checklist):** PH1-05 (per-process ratelimit + REMOTE_ADDR-only IP), PH1-06 (donation has per-phone but no per-IP throttle — `donations/views.py:68`), **PH2-02 (✅ CLOSED 2026-07-02 — `integrations/resend_email.py` now imports `html` (:30) and `html.escape()`s every user-supplied email value: church_name/reason/donor_name/campaign_title/receipt; server-generated otp/amount left raw, safe)**, PH2-03 (no HSTS/SSL-redirect/secure-cookie SECURE_* in `production.py`), PH1-01/07/08 (JWT logout window, per-account login throttle, register/refresh throttle). All OPEN except PH2-02 (closed above), all documented in `AUDIT/FINDINGS.md`.

**DEAD CODE (FE cluster ✅ DELETED 2026-07-08, commit `4709e88`; two items remain):** removed — `frontend/components/disbursement/DisbursementRequestForm.tsx`, `frontend/components/campaign/CampaignCreationForm.tsx`, `donationsService.listForCampaign`, and the orphaned mocks `mock/auditlog.mock.ts` + `mock/notifications.mock.ts` + `mock/groups.mock.ts` + `mock/donations.mock.ts` (only `campaigns/churches/treasurer/withdrawals` mocks remain). **⬜ STILL PRESENT (removal deferred, not re-confirmed unused this pass):** the `dayjs` dependency (`frontend/package.json:18`) and the routed-but-FE-unused `GET /campaigns/<slug>/updates/` (`campaigns/urls.py:42`).

**Deep detail lives in:** `PamojaHub_Compressed_v2.md` (§0 live status, §14 every approved deviation, §14.1 live-Daraja findings), `AUDIT/FINDINGS.md` (18 findings), and persistent memory at `C:\Users\Administrator\.claude\projects\j--Pamoja-Hub\memory\` (start with `MEMORY.md`).

---

## Frontend Phase 1 inventory (screens & infrastructure built)

> The screens/components below are built. Phase 4 has now wired all of them to the real API (data source mock → Axios); the screen layouts are as inventoried. No screen reads mock data any more (zero `mock/` imports under `app/**`, verified 2026-07-16). Treat this section as the **screen/layout inventory**, and the Current-status block above as the source of truth for what is wired.

### Infrastructure

- Expo project initialised, TypeScript strict, full folder structure
- `constants/theme.ts` — all brand tokens
- `types/index.ts` — every TypeScript interface (Campaign, PublicCampaign, Withdrawal, Donation, AuthUser, Church, GroupLabel, Notification, AuditLog, PortalCampaign …)
- `stores/auth.store.ts` — React Context, mock login/logout, no Zustand
- `stores/notifications.store.ts` — unread count
- `utils/formatters.ts` — fmtKes, timeAgo, formatDate, formatDateTime (built-in JS Date only — dayjs is installed in package.json but unused)
- `services/` — api.ts (Axios base + JWT/refresh interceptors), `portalClient.ts` (no-JWT client for OTP-portal calls, `Authorization: Portal` scheme), `mappers.ts` (the snake→camel + decimal-string→`Number()` boundary), and per-domain services: auth, campaigns, churches, dashboard, donations, groups, notifications, subscriptions, superadmin, treasurer-portal, withdrawals. `hooks/useFocusRefetch.ts` — shared background-refetch-on-focus hook (used by every read screen except billing). **REAL (hit the API) — nearly everything:** auth (login/register/logout/refresh/getCurrentUser), campaigns (browse/getBySlug/listMine/getMine + pause/resume/close), churches (browse/getById/getMyChurch/updateMyChurch/getMyDonations), dashboard (getStats), groups (list/create/rename/archive/unarchive), withdrawals (list/approve/reject/retry), donations (initiate + status-poll), subscriptions (initiate/getStatus/cancel), notifications (list/unread-count/markRead/markAllRead), treasurer-portal (requestOtp/verifyOtp/getCampaignReport/requestDisbursement), **superadmin (all 8 reads + writes: approve/reject/suspend/reactivate/setTier, force-retry/resolve-paid/resolve-retry, billing PATCH ×3).** **Wired since 2026-06-24:** auth password-reset (`requestPasswordReset`/`confirmPasswordReset` → live endpoints) and `campaignsService.create` (`POST /campaigns/mine/create/`, consumed by the campaign-create form). **Still mock / dead:** none — `donationsService.listForCampaign` was deleted in `4709e88` (2026-07-08); no service imports from `mock/` any more.

### Mock data (`mock/`)

Single source of truth pattern. `campaigns.mock.ts` is the canonical master — `walletBalance` is derived, never hardcoded.

| File | Key exports |
|---|---|
| `campaigns.mock.ts` | `mockAllCampaigns` (tc1–tc6), `mockPublicCampaigns`, `mockAdminCampaign` |
| `withdrawals.mock.ts` | `mockWithdrawals` (w1–w10, all 6 statuses) |
| `treasurer.mock.ts` | `mockTreasurerCampaigns` + `mockTreasurerSummary` (both derived from campaigns) |
| `churches.mock.ts` | 7 churches (church-1 PCEA, church-2 ACK, church-3 RGC, church-4 AG SUSPENDED, church-5/6/7 PENDING) |
| `donations.mock.ts` | Realistic M-Pesa receipts |
| `notifications.mock.ts` | All notification types |
| `groups.mock.ts` | 5 GroupLabels |
| `auditlog.mock.ts` | AuditLog entries |

**Consistency test suite:** `tests/mockDataConsistency.test.ts` — 30 tests (groups A–H), plus reducer/util suites (subscription poll, etc.). `npm test` (vitest) now totals **60**.

### UI components (`components/`)

**`components/ui/`:** Button, Input, Badge, Card, Modal, Spinner, Toast, ProgressBar, BrandLogo, OTPInput (forwardRef, shared by treasurer portal + reset password), CountyPicker

**`components/campaign/`:** CampaignCard, CampaignCreationForm, DonationForm (full M-Pesa mock flow, inline success/failure), WhatsAppShareButton

**`components/layout/`:** TopNav, NotificationBell, TreasurerSidebar, SuperAdminSidebar

**`components/disbursement/`:** DisbursementRequestForm, DisbursementApprovalDialog (full unmasked phone + red warning)

### Layouts

- `app/_layout.tsx` — root: Poppins fonts, SafeAreaProvider, all 4 route groups
- `app/(public)/_layout.tsx` — Stack, headerShown: false
- `app/(auth)/_layout.tsx` — Stack, headerShown: false
- `app/(treasurer)/_layout.tsx` — Tabs: **Overview, Campaigns, Payouts, Reports, Settings** + hidden (href:null): notifications, groups. Top bar: church name + **Sign Out button** (white outlined, triggers confirm modal → logout + router.replace login). **Notifications bell is NOT in the top bar** — it lives on the Overview screen content beside the greeting.
- `app/(super)/_layout.tsx` — Tabs: **Queue, Churches, Withdrawals, Analytics, Billing, More** + hidden (href:null): campaigns, donations, audit-log. Top bar: "Super Admin" + bell icon (non-functional placeholder) + sign-out icon (immediate, no modal). Auth guard: redirects to login if user is not SUPER_ADMIN.

### Public screens

- `(public)/index.tsx` — Landing page: TopNav (4-item menu), hero, How It Works, active campaigns preview
- `(public)/campaigns/index.tsx` — Browse Campaigns: sticky teal header, search + category chips, FlatList
- `(public)/campaigns/[slug].tsx` — Campaign detail: banner, progress bar, DonationForm, description, WhatsApp share
- `(public)/churches/index.tsx` — Browse Churches: ChurchCard with initials circle, search filters (name/county/denomination)
- `(public)/churches/[id].tsx` — Church profile: floating back button, FlatList with ListHeaderComponent
- `(public)/treasurer/index.tsx` — Treasurer OTP Portal: 3 states (phone entry → OTP boxes → campaign scoped view)

### Auth screens

- `(auth)/login.tsx` — email + password, show/hide toggle, inline error, mock login → routes by role
- `(auth)/register.tsx` — all fields, county slide-up modal (47 counties + search), success state
- `(auth)/reset-password.tsx` — 3 states: email → OTP boxes → success

### Treasurer screens

- `(treasurer)/index.tsx` — Overview: greeting row with **notifications bell** (teal, badge, navigates to /(treasurer)/notifications), 2×2 stat grid, pending payouts alert banner (orange, conditional), recent donations feed, active campaigns horizontal scroll
- `(treasurer)/campaigns/index.tsx` — campaigns list: compact card with 4-stat grid + ProgressBar + WhatsApp share + Pause/Resume/Close actions
- `(treasurer)/campaigns/new.tsx` — campaign creation form: 3 section cards (Details/Media/Treasurer), 120-char title counter, group/category slide-up pickers, success screen with WhatsApp share CTA
- `(treasurer)/campaigns/[slug].tsx` — campaign detail with back bar, full stats, disbursement history
- `(treasurer)/payouts.tsx` — 10 withdrawals (all 6 statuses), pending count banner, 7-chip filter, masked phone, Approve → DisbursementApprovalDialog, Reject → bottom sheet with required reason, Retry for FAILED, red border for FAILED_FINAL
- `(treasurer)/reports.tsx` — 4 report types, date range inputs, group filter modal, CSV/PDF toggle, download placeholder
- `(treasurer)/notifications.tsx` — hidden tab; back bar (← Overview); **flat list** (wired to the live read API; the old grouped Today/Yesterday layout was dropped); type icons; teal border unread; tap to mark read (optimistic + soft sync-notice on bg-refetch fail); Mark all read
- `(treasurer)/groups.tsx` — hidden tab; back arrow in page header (← Settings); inline rename; inline Add Group (flat/hierarchical toggle); archive with confirmation
- `(treasurer)/settings.tsx` — 4 Card sections: Church Profile (editable fields + county picker + save), Account (read-only), Subscription (tier badge), Danger Zone (mailto support link)

### Super Admin screens

- `(super)/index.tsx` (Queue) — PENDING church approval cards: name, email, county, denomination, date; Approve (→ sets ACTIVE, fires toast) / Reject (→ rejection reason modal, fires toast); badge count on tab
- `(super)/churches.tsx` — Churches table: search, status chips (ALL/ACTIVE/SUSPENDED/PENDING), tier chips (FREE/GROWTH/PARISH); per-church row with active campaign count + total raised; Suspend/Reinstate actions with confirmation; subscription tier edit modal
- `(super)/withdrawals.tsx` — Platform-wide withdrawals: all 10 mock records, all 6 status chips, search by church/campaign/phone; masked destination phone; Force Retry for FAILED_FINAL; read-only for PAID
- `(super)/analytics.tsx` — Time-range chips; 2×2 stat grid (Total Churches, Active Campaigns, Total Donations, Platform Fees); 2 chart placeholder cards
- `(super)/billing.tsx` — Platform fee rate (inline editable, warning on change); Growth + Parish tier monthly prices (inline editable); KeyboardAvoidingView; toast on save
- `(super)/more.tsx` — Menu tab linking to 3 hidden screens: Campaigns, Donations, Audit Log
- `(super)/campaigns.tsx` — hidden; back bar (← More); search + status chips + category chips; FlatList of CampaignRow cards with ProgressBar
- `(super)/donations.tsx` — hidden; back bar (← More); search + status chips + date chips; gross/fee/net amount grid per row
- `(super)/audit-log.tsx` — hidden; back bar (← More); entity chips + date chips; action badge with colour-coded severity; danger rows with red left border

### Hidden tab back-navigation pattern

All hidden tab screens (`href: null`) must have:
1. `useFocusEffect` + `BackHandler` navigating to the parent tab
2. A matching visible back control (back bar or back icon) with the same `onPress` target

Current targets: super admin hidden → `/(super)/more`; treasurer notifications → `/(treasurer)/`; treasurer groups → `/(treasurer)/settings`.

---

## Key architectural decisions

- **No Zustand** — React Context for auth and notifications (no external state library in Phase 1)
- **dayjs installed but unused** — `utils/formatters.ts` uses built-in JS `Date` methods only; dayjs remains in package.json as a dependency stub for Phase 4 if needed
- **No real images** — banner placeholders use teal background + category letter circle; switch to expo-image in a later frontend pass
- **Mock service pattern (being replaced in Phase 4)** — services originally returned mock data behind a `// Phase 4:` stub; Phase 4 is swapping each to a real Axios call via `services/mappers.ts` (see Current status for which are done). The mock files under `mock/` stay until every consumer is wired.
- **`--legacy-peer-deps`** required for ALL npm installs — React 19.2.3 is pinned
- **"Payout" everywhere in UI** — backend model is still `Withdrawal` / `WithdrawalStatus`; do not rename backend identifiers
- **walletBalance is always derived** — `raisedAmount − Σ(PAID withdrawals)`; the mock layer enforces this and the test suite (test B3) guards it permanently

---

## Files to always check before editing screens (frontend)

- `constants/theme.ts` — design tokens
- `types/index.ts` — all TypeScript interfaces
- `services/mappers.ts` — the snake→camel + decimal-string→Number boundary (the pattern for every wiring slice)
- `DESIGN_SYSTEM.md` — full component specs and UX rules
- `design-system/pamoja-hub/MASTER.md` — UI/UX Pro Max design system (queried before building screens)

## Files to know before editing the backend

- `config/urls.py` — every API mount (`/auth/ /treasurer/ /churches/ /campaigns/ /group-labels/ /withdrawals/ /super/ /donations/`)
- `common/permissions.py` — `IsSuperAdmin`, `IsChurchTreasurer`, `ChurchNotSuspended` (allowlist), `ChurchScopedPermission`, `HasValidPortalToken`
- `<app>/serializers.py` — public vs admin serializer split is a SECURITY boundary (public = strict allowlist; admin/super = `__all__`)
- `withdrawals/services.py` — shared money-mover helpers (`finalize_withdrawal_paid`, `record_dispatch_failure`); lock-then-call discipline
- `tests/` — the suite is a package; mirror the existing per-endpoint test classes when adding coverage
