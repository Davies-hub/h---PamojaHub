# Pamoja Hub — Compressed Context v2
*Generated May 2026 — Upload this file + PRD v5.0 FINAL to start any new chat or Claude Code session*

---

## 0. Current Build Status — as of 2026-06-26

> **This block is the live state and supersedes any "backend not yet started / Phase 2 next" wording elsewhere in this file.** Older sections (§13 close, §17, §18) are kept as historical build records.

- **Frontend (Phase 1):** ✅ complete — all public / auth / treasurer / super-admin screens built; `tsc --noEmit` 0 errors; mock-consistency suite green (§13 is the screen inventory).
- **Backend (Phase 2):** ✅ complete — all Django apps built (`audit, accounts, churches, campaigns, donations, withdrawals, notifications, treasurer_portal, superadmin, integrations, common`). Steps 2.1 → 2.12b done. **Backend test suite: 499 passing** (live `manage.py test tests` count — reconciled 2026-07-09, was 422 on 2026-06-26; this number is the baseline; update it whenever the count changes).
- **Phase 3 (DB hardening):** partial — indexes/constraints in place; AuditLog DB-level immutability (`REVOKE UPDATE/DELETE`) applied to the **dev** DB only. ⚠ The production REVOKE is **not** a migration — it must be run manually before go-live (runbook: `backend/docs/production_db_hardening.md`).
- **Phase 4 (connect frontend ↔ backend):** ✅ FUNCTIONALLY COMPLETE — READS 100% + WRITES 100%. A long run of slices 2026-06-16 → 2026-06-24 closed nearly everything the 06-16 "still mock" list named (plus the whole subscription lifecycle and the notifications read API), and on **2026-06-26 the final two functional gaps — campaign-create (PH4-04) and password-reset (PH4-05) — were wired and live-verified.** Only a cosmetic mock greeting + one dead service method remain (see "Still MOCK" below).
  - **Wired + verified live (reads):** login, session-restore (`GET /auth/me/`), registration, transparent access-token refresh-and-retry on 401, full server-side logout, public campaign + church **LIST** and **DETAIL**, treasurer dashboard **READS** (overview, my-campaigns, **campaign-detail**, payouts, **reports**, **settings/church profile**, **groups**), **ALL super-admin READS** (billing, withdrawals, campaigns, donations, queue, analytics, churches, audit-log — zero super mock). Standards: D5 `Paginated<T>{items,total,truncated}`; D1 admin serializers over-emit but FE mappers allowlist; D2 null money stays null; D3 audit `details` flattened shape-safe. `useFocusRefetch` applied to every read screen except billing.
  - **Wired + verified live (writes):**
    - Treasurer: campaign **pause/resume/close** (`/campaigns/mine/{slug}/…`); payout **approve/reject/retry** (`withdrawals.service.ts`, verdict-poll harness for approve/retry); **group-labels** create/rename/archive/unarchive; church-profile **PATCH** (`/churches/me/`, settings); **subscription** initiate → STK status-poll → cancel (`SubscriptionCard`); public **OTP portal** request-otp / verify-otp / report / **request-disbursement** (the treasurer money-write, via `portalClient` with `Authorization: Portal` scheme — chosen so CORS preflight passes on web).
    - Super Admin: church **approve/reject** (Queue, in-screen Modals replacing RN `Alert`), **suspend/reactivate**, **set-tier** (money-inert tier flip); withdrawal **force-retry** (FAILED_FINAL re-dispatch — real B2C, `settledRowsRef` race guard vs stale focus-refetch), **resolve-retry** (NEEDS_RECONCILIATION→FAILED, attestation-gated) + **resolve-paid** (→PAID, requires `payout_reference`); billing **PATCH** fee_percent + **growth/parish tier prices**.
    - Donations: STK **initiate + bounded poll** (donor flow — the FIRST money-IN write; 3s × 10 poll, success only on a SUCCESSFUL verdict).
    - Subscriptions (backend + FE): STK initiate/callback (period extend via `max()` + tier flip through shared `set_church_tier`), grace-lapse + 7d/1d/grace renewal reminders (`process_subscriptions` cron), Parish→Growth down-pay block, cancel-auto-renew flag. FREE tier capped at 3 ACTIVE campaigns (`TIER_ACTIVE_CAMPAIGN_CAP`, race-safe `select_for_update`).
    - Notifications: recipient-scoped read API (list / unread-count / mark-read / mark-all) wired backend + FE (bell + screen).
  - **Wired 2026-06-26 (both former launch-blockers closed):** **campaign creation** — `(treasurer)/campaigns/new.tsx:330` calls `campaignsService.create` → real `POST /campaigns/mine/create/` (`campaigns.service.ts:66-83`), loads the church's REAL group labels (`groupsService.list`, `new.tsx:226`), navigates to the server slug (`new.tsx:343`); backend made banner optional + `goal_amount` min_value=1. **auth password-reset** — `authService.requestPasswordReset`/`confirmPasswordReset` (`auth.service.ts:82-103`, field `otp_code`) hit the live `/auth/password-reset/{request,confirm}/`, consumed by `reset-password.tsx:66,92`.
  - **Still MOCK / dead (cosmetic + dead only — NO functional gap):** the OTP-portal greeting name (`(public)/treasurer/index.tsx:20` `mockTreasurerProfile.firstName`) — the ONLY remaining `mock/` import anywhere under `app/**`. (The dead `donationsService.listForCampaign` was **✅ DELETED 2026-07-08**, commit `4709e88`.)
- **Daraja B2C:** proven live end-to-end (PAID + exactly-once wallet decrement) on 2026-06-06 via a fresh sandbox app (B2C shortcode **600992**; the old 600977 initiator was server-side-locked → 8006). The Transaction-Status active-query / auto-redispatch design was **disproven on the live wire and DELETED**; stranded payouts now escalate to `NEEDS_RECONCILIATION` via an escalate-only management command (`sweep_stranded_withdrawals`) — see §14.1. Re-proven again 2026-06-16 on the super-admin force-retry path (two real dispatches, KES 100 + KES 50, both PAID with real receipts).
- **STK donations:** initiate + idempotent callback + status-poll built and tested on the backend; the donor-side frontend flow is now wired and live-verified (see above) — only the Super Admin Donations table READ existed before 2026-06-16.
- **Auth/token storage decision (Phase 4):** frontend maps snake_case→camelCase per-field at the service boundary (`services/mappers.ts`); DRF serializes `DecimalField` as a STRING, so all money fields go through `Number()` in the mappers; Option-1 platform-split token storage (expo-secure-store on native, `localStorage` on web — dev only).

---

## 1. What Pamoja Hub Is

A cross-platform church crowdfunding app for Kenya. Churches launch named project campaigns. The public donates via M-Pesa STK Push with no account. Not for tithes or offerings — project campaigns only.

**One-line pitch:** "A Paybill collects money. Pamoja Hub proves where it went."

**Platforms:** Website + Android app + iOS app — one React Native (Expo) codebase.

---

## 2. Tech Stack

| Layer | Choice |
|---|---|
| Frontend | React Native (Expo) — web, Android, iOS |
| Backend | Django + DRF |
| Database | PostgreSQL |
| Payments | Safaricom Daraja — STK Push + B2C |
| Auth | JWT (djangorestframework-simplejwt) |
| Email | Resend (transactional only) |
| OTP (Campaign Treasurer) | Africa's Talking SMS |
| Notifications | In-app only (bell + notifications page) |
| Donor SMS | Safaricom's automatic M-Pesa SMS — free, no integration |
| Background tasks | Celery + Redis |

---

## 3. The Single Most Important Architectural Decision

**Groups have NO accounts. They are labels only.**

- Only ONE account per church: the Church Treasurer
- Groups (Women's Guild, PCMF, District 1–30) are dropdown labels on campaigns
- Campaign Treasurers are phone-gated via SMS OTP — no password, no account
- `treasurer_phone` on Campaign model serves dual purpose: (1) OTP auth gate for /treasurer portal, (2) B2C payout destination
- If group treasurer changes → Admin updates phone number on campaign. Zero system changes

---

## 4. User Roles (Final)

| Role | Count | Login | What They Do |
|---|---|---|---|
| Super Admin | Platform-wide | Email + password | Approve churches, monitor platform, handle FAILED_FINAL, manage billing |
| Church Treasurer | 1 per church | Email + password | Create group labels, create/manage campaigns, approve disbursements |
| Campaign Treasurer | 1 per campaign | SMS OTP only — no account | View campaign reports, submit disbursement requests |
| Public | Unlimited | None | Browse, donate as guest |

**Previous PRD called these "Church Admin" — that name is GONE. It is always "Church Treasurer" now.**

---

## 5. Money Flow

**Donations:**
- One central PamojaHub Paybill — all donations from all churches
- Transaction fee: **2.5%** (configurable by Super Admin)
- net_amount = amount - platform_fee → credited to campaign virtual wallet
- Minimum donation: KES 5

**Disbursements — Fully Automated via Daraja B2C:**
1. Campaign Treasurer submits via /treasurer portal (OTP-gated)
2. Church Treasurer approves (sees full destination phone prominently)
3. Django auto-calls Daraja B2C → money sent to treasurer_phone
4. Callback received → status = PAID

**Withdrawal Status Flow:**
`PENDING_APPROVAL → PROCESSING → PAID`
`PENDING_APPROVAL → PROCESSING → FAILED → retry → PAID or FAILED_FINAL`
`PENDING_APPROVAL → REJECTED`
`PROCESSING → NEEDS_RECONCILIATION` (stranded: no terminal callback arrived; money-in-limbo, that withdrawal's campaign frozen; exits ONLY via Super-Admin resolve-paid / resolve-retry — no force-retry)
`FAILED_FINAL → (Super-Admin force-retry) → PROCESSING` (FAILED_FINAL is terminal/non-blocking; force-retry resets retry_count to 0)

---

## 6. Monetization (Final)

| Tier | Price | Limit |
|---|---|---|
| Free | KES 0/month | 3 active campaigns |
| Growth | KES 999/month | Unlimited + full reports |
| Parish | KES 2,499/month | Everything + branding |

**Transaction fee: 2.5% on ALL tiers.**
**No registration fee — ever.**
**Launch strategy:** Months 1–6 free tier + 2.5% only. Month 7: introduce paid tiers with 3 months notice.

---

## 7. Campaign Treasurer Portal — /treasurer

Public-facing URL in top navigation. NOT part of the authenticated dashboard sidebar.

**Flow:**
1. Enter M-Pesa phone number
2. System finds ACTIVE/PAUSED campaigns where treasurer_phone matches
3. Africa's Talking sends 6-digit OTP via SMS (expires 10 min, hashed at rest)
4. OTP verified → if one campaign: enter directly. If multiple: campaign picker first
5. Scoped view: campaign stats, donation report (M-Pesa receipt, name, amount, date), Request Disbursement button

**Security:**
- Rate limit: 3 OTP requests per 10min per phone AND per IP
- 5 failed verifications → phone locked 1 hour
- Portal token bound to IP address, expires 30 min
- treasurer_phone change → old number access revoked immediately
- OTP auto-submits on last digit (matches M-Pesa UX)

---

## 8. Brand & Design System

**Logo files:**
- `PamojaHub_Logo_Cream.png` — canonical brand asset (cream background #F9F0E9). Use on splash, emails, marketing.
- `PamojaHub_Logo_White.png` — use where white background is mandatory only.
- App screens are ALWAYS white background — never cream.

**Colors (exact — do not substitute):**
```
primary: '#057C8A'       // Teal — nav, headings, primary buttons
primaryDark: '#035F6B'   // Hover/pressed states
primaryLight: '#D5EEF1'  // Card backgrounds, badges
accent: '#ED8F1C'        // Orange — CTAs, progress bars, "Hub" wordmark
accentDark: '#C97710'    // Hover on orange
accentLight: '#FEF3E2'   // Notification backgrounds
text: '#1A1A1A'
textSecondary: '#555555'
border: '#CCCCCC'
background: '#FFFFFF'    // ALL app screens — always white
success: '#1A7A4A'
successLight: '#D4EDDA'
danger: '#C00000'
dangerLight: '#FFEAEA'
warning: '#856404'
warningLight: '#FFF3CD'
```

**Typography:** Poppins Bold (headings), Poppins SemiBold (subheadings), Poppins Regular (body)
**Style:** Clean minimalism with warm accents — NOT glassmorphism, NOT dark mode
**Touch targets:** 48px minimum height on all interactive elements

**Design tooling:** UI/UX Pro Max skill installed in Claude Code at `.claude/skills/ui-ux-pro-max/`. Query it before building any screen. Run pre-delivery checklist after every screen.

---

## 9. Repository & Environment

**GitHub:** https://github.com/Davies-hub/PamojaHub.git
**Local path:** J:\Pamoja_Hub
**OS:** Windows 10

**Folder structure:**
```
J:\Pamoja_Hub\
├── frontend\     ← React Native Expo project (Phase 1 complete)
├── backend\      ← Django project (Phase 2 complete; venv at backend\venv, run via backend\manage.py)
└── .gitignore    ← committed first
```

**Tools confirmed installed:**
- Node.js v25.6.1
- Python 3.10.11
- PostgreSQL 18.3
- Expo 56.1.10
- Git 2.54.0
- ngrok 3.39.2

**Memory tool:** claude-mem installed in Claude Code. Use `/mem-search next steps` at start of every session.

---

## 10. Key Data Models

**Church:** id, name, official_email, phone, address, county (nullable), denomination, logo_url, description, status (PENDING/ACTIVE/SUSPENDED/**REJECTED**), rejection_reason (nullable — set on reject, surfaced in the treasurer's login response), subscription_tier, subscription_expires_at, created_at

**GroupLabel:** id, church(FK), parent_label(FK nullable), name, is_archived

**User:** id, email, password, role (SUPER_ADMIN/CHURCH_TREASURER), church(FK nullable), is_active
*(Only two roles — Campaign Treasurers are NOT users)*

**Campaign:** id, slug, church(FK), group_label(FK nullable), title, description, goal_amount, raised_amount, wallet_balance, status (ACTIVE/PAUSED/CLOSED), banner_image_url, document_url, category, **treasurer_phone**, **treasurer_name**, created_by(FK)

**Donation:** id, campaign(FK), phone_number, donor_name, donor_email, amount (GROSS), platform_fee (nullable — set at the STK callback from LIVE `PlatformSettings.fee_percent`), net_amount (nullable — credited to wallet, NET), status (PENDING/SUCCESSFUL/FAILED), checkout_request_id (unique), mpesa_receipt_number, created_at, confirmed_at

**Withdrawal:** id, campaign(FK), **requested_by_phone** (CharField — NOT FK, Campaign Treasurers have no accounts), approved_by(FK nullable), amount, destination_phone, destination_name, reason, rejection_reason, status (PENDING_APPROVAL/PROCESSING/PAID/FAILED/FAILED_FINAL/REJECTED/**NEEDS_RECONCILIATION**), payout_reference, b2c_conversation_id (Daraja's ConversationID — the correlation key the result callback matches on), originator_conversation_id (our `pmj-<uuid>`; NOT echoed by Daraja — per-dispatch id only, no longer a CAS key), dispatch_outcome (CLEAN_FAILURE/AMBIGUOUS_FAILURE marker, nullable), failure_reason, retry_count (max 5)

**CampaignTreasurerOTP:** id, phone_number, otp_code (hashed SHA-256), campaign_ids (JSONField), is_used, expires_at

**PortalToken:** id, phone_number, campaign_ids, ip_address, token_hash (SHA-256, unique — issued token hashed at rest), expires_at, is_revoked

**Notification:** id, recipient(FK), notification_type, title, message, related_campaign(FK), related_withdrawal(FK), is_read

**AuditLog:** id, actor(FK nullable), actor_phone (CharField nullable), action, entity_type, entity_id, details(JSON — phones masked via `common.masking.mask_phone`), ip_address, created_at — NEVER updated or deleted. INSERT-only at PostgreSQL role level (dev DB REVOKEd; prod REVOKE pending — see §0).

**PlatformSettings (singleton):** fee_percent (the LIVE transaction-fee rate; the ONLY surface that exposes it = `GET/PATCH /super/billing/`), growth_price, parish_price, updated_at. `load()` get_or_creates with defaults (2.50 / 999 / 2499). `PLATFORM_FEE_PERCENT` in .env is a DECOY constant — the donation callback reads this row LIVE, fees are forward-only (editing never rewrites confirmed donations).

**RefreshToken:** id, user(FK), token_hash (SHA-256), is_revoked, expires_at — server-side JWT refresh store. Refresh ROTATES (old row revoked immediately on use) → the frontend serializes refreshes (single-flight).

---

## 11. Security Implementation (Must Be Built In — Not Added Later)

1. Daraja callbacks IP-whitelisted at nginx level in production (not Django)
2. STK callback: CheckoutRequestID idempotency checked FIRST before any state change
3. Always credit Daraja callback amount — never frontend-supplied amount
4. OTP hashed with SHA-256 before storage — plaintext never stored or logged
5. Rate limiting: django-ratelimit on all public endpoints (see PRD Section 12.5 for full table)
6. ChurchScopedPermission class on ALL church-scoped endpoints — mandatory, never omitted
7. Withdrawal approval: verify withdrawal.campaign.church == request.user.church BEFORE calling B2C
8. treasurer_phone NEVER in any public API serializer or response
9. Withdrawal creation: SELECT FOR UPDATE on Campaign to prevent race condition double-spend
10. HTML sanitized with bleach in serializer validate_description() — whitelist only
11. AuditLog: INSERT-only PostgreSQL role, Python-level save() blocks updates
12. JWT refresh tokens stored server-side in RefreshToken table with is_revoked field
13. Startup guards: refuse to start if DEBUG=True + MPESA_ENVIRONMENT=production, or ngrok in callback URLs + production environment
14. .env in .gitignore from first commit — verified with git check-ignore -v .env

---

## 12. API Structure (Base: /api/v1/)

- `/auth/` — register, login, refresh, logout, password-reset, invite-treasurer
- `/treasurer/` — request-otp, verify-otp, campaigns, campaigns/{id}/report, campaigns/{id}/request-disbursement, campaigns/{id}/disbursements
- `/churches/` — public list, public profile, me (profile GET+PATCH), me/stats, me/donations
- `/group-labels/` — CRUD, archive, unarchive
- `/campaigns/` — public browse, `mine/` list, `mine/create/`, `mine/{slug}/` detail, `mine/{slug}/`pause/resume/close, `{slug}/updates`, public detail
- `/donations/` — initiate (guest), callback (Daraja webhook), status (poll)
- `/subscriptions/` — initiate (treasurer STK), cancel (auto-renew opt-out), callback (Daraja webhook), {id}/status (poll). Backed by `Church.subscription_*` fields + `services.set_church_tier` + `tasks.py` (grace-lapse / reminders) + `process_subscriptions` cron.
- `/withdrawals/` — list, approve, reject, retry, b2c-result (Daraja webhook)
- `/notifications/` — list, unread-count, {id}/read, read-all (all `[IsAuthenticated]`, `recipient=request.user`-scoped)
- `/super/` — churches (list + `pending` queue + approve/reject/suspend/reactivate/**set-tier**), campaigns, donations, withdrawals, withdrawals/{id}/force-retry, withdrawals/{id}/resolve-paid, withdrawals/{id}/resolve-retry, analytics, audit-log, billing (the ONLY fee_percent surface). EVERY endpoint is `[IsSuperAdmin]` (treasurer → 403). No paybill/balance endpoint exists.

---

## 13. Phase 1 Build Progress — FRONTEND

### ✅ COMPLETE — All Phase 1 screens built and verified

`npx tsc --noEmit` = 0 errors. `npm test` = 30/30 pass. Last verified 2026-05-29.

**Setup (Steps 1.1–1.7):**
- Expo project initialized, TypeScript configured
- Full folder structure: app/, components/, services/, stores/, utils/, mock/, constants/
- `constants/theme.ts` — all brand tokens including Colors.grey, Colors.white, Colors.successLight, Colors.dangerLight, Colors.warningLight, Colors.accentDark, Colors.primaryLightest
- All TypeScript interfaces in `types/index.ts`
- Mock data: campaigns, churches, donations, notifications, treasurer, groups, withdrawals, auditlog
- API service stubs — all return mock data; `// Phase 4: return (await api.get(...)).data` commented below each
- Auth store — React Context, mock login/logout, no Zustand

**Mock data architecture (single source of truth):**
- `campaigns.mock.ts` — canonical master (tc1–tc6); `walletBalance` computed as `raisedAmount − Σ(PAID withdrawals)`, never hardcoded. Exports: `mockAllCampaigns`, `mockPublicCampaigns`, `mockAdminCampaign`
- `withdrawals.mock.ts` — w1–w10 covering all 6 statuses
- `treasurer.mock.ts` — `mockTreasurerCampaigns` + `mockTreasurerSummary` fully derived from campaigns
- `tests/mockDataConsistency.test.ts` — 30 tests across groups A–H enforce all cross-file invariants

**Public screens:**
- `app/(public)/index.tsx` — Landing page: hero, stats, how-it-works, active campaigns preview
- `app/(public)/campaigns/index.tsx` — Browse campaigns: sticky teal header, search + category chips, FlatList
- `app/(public)/campaigns/[slug].tsx` — Campaign detail: DonationForm, WhatsAppShareButton, progress bar
- `app/(public)/churches/index.tsx` — Browse churches: ChurchCard with initials circle, search (name/county/denomination)
- `app/(public)/churches/[id].tsx` — Church profile: floating back button, FlatList with ListHeaderComponent
- `app/(public)/treasurer/index.tsx` — Treasurer OTP Portal: 3 states (phone → OTP boxes → campaign scoped view)

**Auth screens:**
- `app/(auth)/login.tsx` — email + password, show/hide toggle, inline error, mock login → routes by role
- `app/(auth)/register.tsx` — all fields, county slide-up modal (47 counties + search), success state
- `app/(auth)/reset-password.tsx` — 3 states: email entry → OTP boxes → success
- `components/ui/OTPInput.tsx` — shared component, forwardRef + useImperativeHandle, used in treasurer portal AND reset password

**Church Treasurer dashboard:**
- `app/(treasurer)/_layout.tsx` — teal top bar: church name + **Sign Out button** (white outlined; tapping opens confirm modal → logout + router.replace login). **5-tab bottom nav: Overview, Campaigns, Payouts, Reports, Settings.** Hidden tabs (href:null): notifications, groups. NOTE: notification bell is NOT in the top bar — it is in the Overview screen content.
- `app/(treasurer)/index.tsx` — Overview: greeting row with **notification bell** (teal icon, unread badge capped 99+, navigates to /notifications), 2×2 stat grid, pending payouts alert banner (orange, conditional), recent donations feed, active campaigns horizontal scroll
- `app/(treasurer)/campaigns/index.tsx` — campaigns list: compact card with 4-stat grid + ProgressBar + WhatsApp share + Pause/Resume/Close actions
- `app/(treasurer)/campaigns/new.tsx` — campaign creation form (3 section cards: Details/Media/Treasurer), 120-char title counter, group/category slide-up pickers, success screen with WhatsApp share CTA
- `app/(treasurer)/campaigns/[slug].tsx` — campaign detail with back bar, full stats, disbursement history
- `app/(treasurer)/payouts.tsx` — 10 withdrawals (all 6 statuses), pending banner, 7-chip filter, masked phone (0\*\*\* \*\*\*XXXX), Approve → DisbursementApprovalDialog, Reject → reason modal, Retry for FAILED, red border for FAILED_FINAL
- `app/(treasurer)/reports.tsx` — 4 report types, date range inputs, group filter modal, CSV/PDF toggle, download placeholder
- `app/(treasurer)/notifications.tsx` — hidden tab; back bar (← Overview); grouped Today/Yesterday/Earlier; teal border for unread; tap marks read; "Mark all read"
- `app/(treasurer)/groups.tsx` — hidden tab; back arrow integrated into page header (← Settings); inline rename; inline Add Group (flat/hierarchical toggle); archive with confirmation
- `app/(treasurer)/settings.tsx` — 4 Card sections: Church Profile (editable, county picker, Save toast), Account (read-only email/phone), Subscription (tier badge + renewal date), Danger Zone (mailto support link)

**Super Admin portal:**
- `app/(super)/_layout.tsx` — teal top bar: "Super Admin" + bell placeholder + sign-out icon (immediate, no modal). **6-tab bottom nav: Queue, Churches, Withdrawals, Analytics, Billing, More.** Hidden tabs (href:null): campaigns, donations, audit-log. Auth guard redirects non-SUPER_ADMIN to login.
- `app/(super)/index.tsx` (Queue) — PENDING church approval cards (name, email, county, denomination, date); Approve → sets ACTIVE + toast; Reject → reason modal + toast; badge count on tab
- `app/(super)/churches.tsx` — search + status chips (ALL/ACTIVE/SUSPENDED/PENDING) + tier chips (FREE/GROWTH/PARISH); per-row active campaign count + total raised; Suspend/Reinstate with confirmation; subscription tier edit modal
- `app/(super)/withdrawals.tsx` — platform-wide: all 10 records, 6 status chips, search; masked destination phone; Force Retry for FAILED_FINAL
- `app/(super)/analytics.tsx` — time-range chips; 2×2 stat grid (Total Churches, Active Campaigns, Total Donations, Platform Fees); 2 chart placeholder cards
- `app/(super)/billing.tsx` — platform fee rate (inline editable, KAV, change warning toast); Growth + Parish tier monthly prices (inline editable)
- `app/(super)/more.tsx` — menu tab with 3 items linking to hidden screens: Campaigns, Donations, Audit Log
- `app/(super)/campaigns.tsx` — hidden; back bar (← More); search + status + category chips; campaign FlatList with ProgressBar
- `app/(super)/donations.tsx` — hidden; back bar (← More); search + status + date chips; gross/fee/net grid per row
- `app/(super)/audit-log.tsx` — hidden; back bar (← More); entity + date chips; colour-coded action badges; red left border on danger rows

### Status note (updated 2026-06-13)

This section is the **frontend Phase 1 screen inventory** (an accurate record of what was built). The Django backend is now fully built (Phase 2 complete, **499 tests** — reconciled 2026-07-09, was 422 on 2026-06-26) and Phase 4 frontend↔backend wiring is functionally complete — see **§0** for the live state and **§18** for what is wired vs still mock. As screens are wired to the real API the underlying data source changes from mock to Axios, but the screens themselves are as inventoried above.

---

## 14. Deviations from Build Guide (All Approved)

| Deviation | Decision | Reason |
|---|---|---|
| OTP auto-submits on last digit; redundant Verify button removed | Keep permanently | Matches M-Pesa PIN UX — a Verify button is dead code when auto-submit fires on the 6th digit |
| Approval dialog uses `DisbursementApprovalDialog` bottom sheet (not native Alert). Phone displayed at FontSize.title bold; edit is secondary action behind "Edit number" link | Keep permanently | Phone is the gate between approval click and money leaving Paybill — must be the visual focal point. Bottom sheet allows editable fields and better validation UX than native Alert |
| 2 ACK campaigns added to mock data | Keep | Church profile needed non-empty state |
| Sign-out is icon in dashboard header | Keep | Accessible without cluttering scroll |
| router.replace cast to `any` for /(treasurer)/ | Temporary | Keeps TypeScript happy until overview screen exists — already exists now, can be cleaned up |
| Reset password 3-state in-screen (no query params) | Keep permanently | Better UX than query-param handoff to login |
| Archive blocked by Alert (not silent disable) | Keep permanently | Explains why to the user |
| Filter chips (status + group) removed from campaigns list | Keep permanently | Cleaner UI; search bar alone is sufficient for Phase 1 mock data volume |
| OTPInput extracted to components/ui/OTPInput.tsx | Keep permanently | DRY — used in treasurer portal + reset password |
| County picker is slide-up modal with live search | Keep permanently | Better UX than a flat dropdown for 47 items |
| No Zustand — React Context only | Keep permanently | No dependency conflict with Expo 56 |
| --legacy-peer-deps for some packages | Keep | Resolves peer dependency conflicts in Node 25 |
| Screen backgrounds: StyleSheet.absoluteFillObject | Keep | Required pattern for Expo Router on web |
| Net-Everywhere rule: all amounts on church-facing surfaces are NET (after 2.5% fee). Exceptions: (1) donor post-donation success screen shows GROSS to match M-Pesa SMS, (2) Super Admin Donations table shows gross/fee/net per PRD §8.6 | Keep permanently | Prevents church officials from psychologically experiencing the platform fee as money lost. The gap between raised and wallet now reflects only their own approved payouts, not Pamoja Hub's cut. PRD §9.4 already defines raised_amount as sum of net_amount — this aligns frontend display with the existing data model. |
| "Payout" used in all UI strings instead of "Disbursement" | Keep permanently | Shorter, sharper, matches what a Kenyan church treasurer says out loud. Backend Withdrawal model name unchanged. |
| Theme tokens `primaryLightest`, `gradientStart`, `gradientEnd` added to constants/theme.ts | Keep | Surfaces previously hardcoded hex values into the token system. |
| disbursements.tsx renamed to payouts.tsx | Keep | UI consistency with Payout terminology; backend Withdrawal model name unchanged. |
| Treasurer top bar: bell replaced with Sign Out button (white outlined, confirm modal) | Keep permanently | Sign-out reachable from every treasurer tab. Modal prevents accidental taps. Mirrors super admin sign-out pattern. |
| Notifications bell moved to Overview content row (beside greeting) | Keep permanently | Bell is a glanceable Overview concern. Retains full badge + navigation to /(treasurer)/notifications. |
| All hidden tab screens have BackHandler AND visible back bar/button | Keep permanently | Hardware back alone is invisible. Pattern: useFocusEffect + BackHandler + matching onPress UI. Super admin hidden → /(super)/more; treasurer notifications → /(treasurer)/; treasurer groups → /(treasurer)/settings. |
| dayjs in package.json but unused in source | Acceptable | formatters.ts uses built-in JS Date. dayjs was added as a dependency stub but is not called anywhere — do not start using it without a clear reason. |
| `accounts.User` and `churches.Church` models built in Step 2.3, not 2.4 | Keep | `AUTH_USER_MODEL = 'accounts.User'` resolves at import time via Django's admin/auth `check_user_model` chain. The check instantiates User and forces resolution of every field default, including the FK to `churches.Church` — so Church must exist as a real model class, not just a lazy string. User and Church are the only two models built early; all other foundational models (audit.AuditLog, accounts.RefreshToken, GroupLabel, Campaign, etc.) stay in Step 2.4. |
| Narrowed `validate_env()` in `config/settings/base.py` | Keep permanently | Always-required: `SECRET_KEY`, `DATABASE_URL`. Required when DEBUG=False (any real deployment): all M-Pesa / AT / Resend / FRONTEND_URL vars. Production-only safety guards (refuse DEBUG=True + MPESA_ENVIRONMENT=production; refuse ngrok URLs in production) fire when MPESA_ENVIRONMENT=production. Strict-trigger is DEBUG=False, not MPESA_ENVIRONMENT=production — DEBUG=False is unavoidably present in any real deployment, whereas MPESA_ENVIRONMENT could be misconfigured. Lets `manage.py check` and `runserver` work in development on dummy external-service values while production safety remains fully enforced. |
| Initial migrations (`accounts.0001`, `churches.0001`) generated and applied in Step 2.3 | Keep | The "no migrations until Step 2.4" rule was satisfied once the User model existed; deferring further only broke `runserver`. `django.contrib.admin`'s migration graph declares a swappable dep on `AUTH_USER_MODEL`, so the graph builder requires `accounts/migrations/` to be non-empty. Migrations are additive — Step 2.4 adds 0002+ on top. DB correctly bound to `accounts.User` (verified: `accounts_user` table exists, no `auth_user` table). |
| `AuditLog.save()` uses an existence check (`if self.pk and AuditLog.objects.filter(pk=self.pk).exists()`), not the Build Guide's bare `if self.pk` | Keep | UUID PKs are populated by `default=uuid.uuid4` at instantiation, so `self.pk` is truthy even on unsaved records. The Build Guide's bare check would block ALL inserts, making the audit log unwritable. The existence check blocks only genuine updates. Python guard catches instance `save`/`delete` only; `QuerySet.update`/`QuerySet.delete` bypass it — full immutability enforced by PostgreSQL `REVOKE UPDATE, DELETE` in Phase 3 Step 3.3. |
| `PortalToken` has a `token_hash` field (SHA-256, unique) beyond the Compressed Context Section 10 field list | Keep | Portal token validation must compare hashes, never plaintext — same pattern as `RefreshToken.token_hash` and `CampaignTreasurerOTP.otp_code`. The issued portal token is hashed at rest. |
| `ChurchStatus.REJECTED` added in Step 2.9c | Keep | The frontend Queue screen has an explicit reject action; the original `ChurchStatus` (PENDING / ACTIVE / SUSPENDED) had no terminal status for it. Rejection reason kept in `AuditLog.details` and the rejection email — NOT on a new `Church.rejection_reason` field (keeps the model lean; AuditLog is authoritative). Public list filter (status=ACTIVE) auto-excludes REJECTED. |
| `ChurchNotSuspended` uses ALLOWLIST semantics (`status in ('PENDING','ACTIVE')`), not denylist (`status != 'SUSPENDED'`) | Keep permanently | The denylist form fail-OPENED on REJECTED when that status was added (REJECTED != SUSPENDED → permission passed). The allowlist is fail-closed: any future status added without thought defaults to DENIED. Drift-guard test (`tests/test_permissions.py::ChurchStatusEnumLiteralDriftGuard`) breaks CI on enum-value drift. |
| Rejected-church treasurer accounts stay loginable (is_active=True). NOT deactivated. | Keep permanently | Most rejections are correctable (incomplete info, typo, wrong county). Deactivating would permanently lock out a legitimate church from re-registering — both the REJECTED Church row and the unique-email User row persist, and a deactivated User cannot log in to see the decline reason or resubmit. The account is inert by other means: ChurchNotSuspended allowlist excludes REJECTED → every state-changing action returns 403; public surfaces filter to status=ACTIVE → the church doesn't appear publicly; login returns `church_status='REJECTED'` so the frontend shows the decline reason. The actual money-safety boundary for non-ACTIVE churches is the donation-initiate church-status check (a Step 2.10 requirement) — NOT the login state. |
| Suspension/rejection enforcement depends on `request.user.church.status` being read FRESH per request | Keep permanently | SimpleJWT's `JWTAuthentication` fetches the user from the DB on every request and `user.church` is a lazy FK that loads on access — so `ChurchNotSuspended.has_permission` sees the LIVE status row, not a cached one. Do NOT add `select_related('church')` to the JWT auth user fetch and do NOT introduce an auth-layer user cache: either change would make suspension stale until token expiry, so admin SUSPEND wouldn't take effect until the treasurer's next access-token refresh. Verified by `tests/test_superadmin.py::SuspendCrossLayerWithJWTBearerTest` — drives a real bearer token, suspends the church without refreshing the token, and asserts the next state-changing request is denied. |
| AuditLog.details masks phones via `common/masking.mask_phone` (PRD §12.10) | Keep permanently | AuditLog entries are exported/reviewed by Super Admin — storing raw phones there leaks PII beyond what the entity row already holds. The full number lives on the entity (Withdrawal.destination_phone, Campaign.treasurer_phone), reachable via entity_id; the audit carries the masked form (`254712***678`) for spot-check forensic linking. Applied to: WITHDRAWAL_APPROVED / WITHDRAWAL_REJECTED / WITHDRAWAL_RETRIED / WITHDRAWAL_RETRY_DISPATCH_FAILED / WITHDRAWAL_DISPATCH_FAILED / WITHDRAWAL_FORCE_RETRIED / WITHDRAWAL_FORCE_RETRY_DISPATCH_FAILED / CAMPAIGN_TREASURER_DESTINATION_CHANGED. The frontend `DisbursementApprovalDialog`'s unmasked-phone display is a separate concern (treasurer needs to verify the destination before approving). |
| Every Withdrawal state change is audited — including the Phase-2 dispatch-failure transition (PROCESSING → FAILED) | Keep permanently | Without an explicit audit on the dispatch-failure path, the trail jumps from `WITHDRAWAL_APPROVED` (PROCESSING) directly to whatever the retry/sweep does next, with no trace of the failure itself. New actions: `WITHDRAWAL_DISPATCH_FAILED` (2.9b approve), `WITHDRAWAL_RETRY_DISPATCH_FAILED` (2.9b retry), `WITHDRAWAL_FORCE_RETRY_DISPATCH_FAILED` (2.9c force-retry). Each records the masked destination phone and the exception reason (capped). |
| All money-mover endpoints (treasurer approve, treasurer retry, super admin force-retry) acquire Campaign lock BEFORE Withdrawal lock | Keep permanently | Lock-ordering convention prevents deadlocks. Code path is identical in all three views: `Campaign.objects.select_for_update().get(id=withdrawal.campaign_id)` precedes `Withdrawal.objects.select_for_update().get(id=...)`. Every `save(update_fields=[...])` in Phase 1 includes `updated_at` explicitly — Django's `auto_now` is NOT automatically included when `update_fields` is passed. |
| Force-retry dispatch-failure transitions FAILED_FINAL → FAILED with retry_count=0 | Keep permanently (by design) | Super Admin force-retry resets `retry_count = 0` in Phase 1 (fresh budget, overriding the exhausted FAILED_FINAL state). If the Phase-2 B2C dispatch then fails, the withdrawal lands at FAILED with retry_count=0 — i.e. back in the TREASURER-retriable state, not FAILED_FINAL again. This is intentional: a force-retry that can't even dispatch should hand the item back to the treasurer's normal retry flow (FAILED is the treasurer's domain; FAILED_FINAL is the Super Admin's). The dispatch-failure `failure_reason` therefore says "Retry from the Withdrawals panel" (MANUAL) — there is no automatic retry job in Phase 2; the same manual-retry wording is used by the treasurer approve/retry dispatch-failure paths. Step 2.10's callback worker, not this view, owns the FAILED → FAILED_FINAL re-escalation if retries exhaust again. |
| B2C stuck-PROCESSING sweep + FAILED_FINAL escalation + NEEDS_RECONCILIATION (Step 2.10c) | Keep permanently | ⚠ **PARTLY SUPERSEDED (2026-06-07, A2):** the `check_transaction_status` active-query / conditional-re-dispatch machinery described in this row was DISPROVEN on the live wire and DELETED — the sweep is now escalate-only (`run_stranded_withdrawal_sweep` → `NEEDS_RECONCILIATION`, no network, no re-dispatch), triggered by `manage.py sweep_stranded_withdrawals`. See §14.1 "RESOLVED 2026-06-07 (A2)". The NEEDS_RECONCILIATION freeze + FAILED_FINAL escalation + money-safety properties below remain accurate; the auto-resolve-via-status-query parts do not. **PRD Table 4 NARROWING — status-query gates ALL auto-retry.** Table 4's "retry 3× on downtime" / "00:05 on daily-limit" are honored as check-then-MAYBE-retry, NEVER blind re-dispatch. The Build Guide's `auto_retry_b2c` (blind 3× re-dispatch) is deliberately NOT implemented — it is the double-pay generator. A withdrawal is re-dispatched ONLY on a `CONFIRMED_NOT_SENT` from `DarajaClient.check_transaction_status` (3-outcome contract: CONFIRMED_PAID / CONFIRMED_NOT_SENT / INCONCLUSIVE; INCONCLUSIVE is NEVER collapsed into a certain state). The Transaction Status query is a network call made OUTSIDE any DB lock (Phase-1/Phase-2 discipline). **Clean-strand-treated-as-AMBIGUOUS:** a PROCESSING row with no conversation_id and no dispatch marker COULD be inferred never-dispatched (direct re-dispatch), but is instead status-queried first — that row state has more than one possible cause and Daraja's ground truth is cheap insurance. The sweep status-queries EVERY candidate uniformly (PROCESSING-stale OR FAILED+AMBIGUOUS_FAILURE marker); it never branches on conversation_id presence. **NEEDS_RECONCILIATION** = the terminal floor for persistently-INCONCLUSIVE rows (N=`B2C_SWEEP_STATUS_QUERY_ATTEMPTS` re-queries with exponential backoff, injectable for tests, then terminal). It is in `BLOCKING_WITHDRAWAL_STATUSES` (single source of truth in withdrawals.models — money-in-limbo, campaign frozen for that withdrawal), is visually/semantically distinct from PROCESSING (so the freeze is legible), has NO force-retry path (force-retry is FAILED_FINAL-only), and fires a Super Admin alert (Notification + AuditLog `WITHDRAWAL_NEEDS_RECONCILIATION`) carrying the OriginatorConversationID + amount + withdrawal id. The ONLY exits are Super-Admin `resolve-paid` (idempotent finalize PAID via the shared helper, exactly-once wallet decrement, safe against a late callback) and `resolve-retry` (→ FAILED + CLEAN_FAILURE marker + retry_count=0, treasurer-retriable; NON-money-moving so re-dispatch uses the standard locked path), each verifying the row is NEEDS_RECONCILIATION (else 400) and audited with the human actor. **FAILED → FAILED_FINAL escalation** is driven by the B2C result callback worker (`/withdrawals/b2c-result/`, public, 200 on every path): a failure result at `retry_count >= MAX_RETRIES` → FAILED_FINAL, else FAILED; the clean-dispatch-failure path (`record_dispatch_failure`) ALSO escalates at the ceiling (no callback comes for a clean failure, so block-on-FAILED safety requires it). **FAILED_FINAL is TERMINAL/non-blocking** (Super Admin force-retry exists); NEEDS_RECONCILIATION is BLOCKING — different states, different freeze semantics. **OriginatorConversationID lookup-handle:** generated by us (`pmj-<uuid>`), stored on the withdrawal in the Phase-1 (locked) block BEFORE the B2C HTTP call (so even a clean strand carries it) and sent in the payload; it is the M-Pesa back-office / Transaction Status correlation handle for rows with no Daraja ConversationID. It is ALSO the re-entrancy version-key: every dispatch (manual retry, force-retry, sweep re-dispatch) rotates it, and `redispatch_withdrawal` proceeds under its lock ONLY if the row still carries the originator id the sweep observed before the (unlocked) status query — optimistic concurrency that makes two overlapping sweep ticks / a manual retry racing the sweep a no-op for the second actor (a status guard alone can't: a freshly-redispatched row is PROCESSING, indistinguishable from the un-dispatched strand). **Frontend follow-on (Phase 3):** the treasurer/admin payout UI must render NEEDS_RECONCILIATION distinctly from PROCESSING (a frozen "needs a human" state, not a healthy in-flight payout) and must NOT offer a retry/force-retry control on it. **UNVERIFIED-MAPPING GATE (2.10c correction):** `check_transaction_status`'s mapping of Daraja's wire format → the three outcomes is NOT yet validated against live Daraja and is the safety-critical heart of the contract. CONFIRMED_PAID requires an EXPLICIT completed `TransactionStatus` (`_PAID_STATUSES`) — a bare `ResultCode/ResponseCode == '0'` is NOT treated as paid (zero = query-accepted, not payout-completed; the earlier `or result_code=='0'` PAID trigger was the 2.10a ResponseCode-vs-outcome confusion reappearing and has been removed, since a false CONFIRMED_PAID finalizes an unpaid row). CONFIRMED_NOT_SENT (the ONLY re-dispatch authorization) requires an EXPLICIT not-found `TransactionStatus` from an INTENTIONALLY NARROW allowlist (`_NOT_SENT_STATUSES`); anything else → INCONCLUSIVE, the safe default (over-escalates to NEEDS_RECONCILIATION, never re-dispatches a possibly-live payout). The allowlists are widened ONLY with wording confirmed by the **sandbox round-trip — which is therefore no longer a deferred nicety: it gates this safety-critical mapping before production**. |
| STK push donation contract (Step 2.10b): ack, live-fee, idempotency, church-ACTIVE boundary | Keep permanently | **STK ack contract** (`DarajaClient.stk_push`): ACCEPTED ⟺ HTTP 200 + `ResponseCode '0'` + a non-empty `CheckoutRequestID` → returns `{checkout_request_id, merchant_request_id}`. ANY other outcome (transport error, non-200, unparseable, non-zero ResponseCode, missing CheckoutRequestID, OAuth/token failure) raises a single `STKPushError` → initiate returns HTTP 502 "couldn't start payment, try again". NO clean/ambiguous split needed (unlike B2C): at initiate NO money has moved, so a donation that never gets a CheckoutRequestID stays PENDING, is never credited, and ages out harmlessly. We NEVER invent a CheckoutRequestID — an ambiguous STK ack IS an initiate failure (without the id the donor can't poll and the callback can't correlate). **Live-fee-read-and-store:** the callback reads `PlatformSettings.load().fee_percent` LIVE at confirmation time and stores BOTH `platform_fee` and `net_amount` on the Donation row (forward-only — editing the fee later never rewrites a confirmed donation). `PLATFORM_FEE_PERCENT` in settings/.env is a DECOY constant — computing from it would make the billing-UI rate edit silently cosmetic. `platform_fee`/`net_amount` are now NULL until the callback confirms (`donations.0002_*`); raised_amount & wallet_balance move by NET (Net-Everywhere), the donor success poll shows GROSS only (no fee/net/checkout_request_id). **Callback idempotency:** public, unauthenticated, Safaricom-retried on any non-200 → handler returns 200 on EVERY path (success/failure/duplicate/unknown); idempotency is the FIRST in-transaction op — `SELECT FOR UPDATE` the donation by the DB-unique `checkout_request_id`, short-circuit if already SUCCESSFUL/FAILED, before any balance mutation; credits the CALLBACK-CONFIRMED amount, never client-supplied. **Church-must-be-ACTIVE donation boundary** (the money-safety check 2.9c explicitly deferred to here): initiate refuses a PENDING/SUSPENDED/REJECTED church's campaign (and any non-ACTIVE campaign) with 400 — a non-ACTIVE church must not collect. Rate limit: 10/h per normalized donor phone (`normalized_phone_key` uses the SAME `validate_safaricom_phone` as the serializer, so all format variants of one number share one bucket). **502-initiate ↔ later-callback (deliberate):** a 502 initiate (incl. ambiguous STK ack where Safaricom may have queued it) stores NO `checkout_request_id`, so the row is un-correlatable — a later success callback matches no row, hits the unknown-id 200 no-op, and the campaign is NEVER credited for that row. Donor UX (failed/try-again) and row state (PENDING, uncredited) AGREE — no silent credit-without-success. A possibly-queued-but-uncorrelatable STK ages out; reconciling a donor who was actually charged is an ops / Transaction-Status-query concern (deferred), never a double-credit — we never invent a CheckoutRequestID. The initiate→stk_push→`checkout_request_id` save is synchronous before the response; a callback can only reference an id Safaricom returns AFTER stk_push, and a success callback only fires after PIN entry, so the create→save window admits no correlatable callback (and any that did would be a harmless unknown-id no-op). |
| Step 2.12b: password-reset enumeration fix (conditional surface-failure rule) + rejection-reason persisted (now resolved) + timing oracle recorded OPEN | Keep permanently | **A. Password-reset status-code oracle CLOSED.** `PasswordResetRequestView` Path C (send raises `EmailDeliveryError`) no longer returns 502 — it logs server-side (`logger.exception`, recipient masked via `mask_email`) and returns the SAME generic 200 as Path A (no such user) and Path B (send ok). All three paths are now byte-identical (status + body), so the 502-as-"account-exists" oracle is gone. Rationale: an unauthenticated reset caller can't act on a delivery failure and doesn't own the mailbox, so surfacing it bought nothing and broke existence-opacity. **CONDITIONAL surface-failure RULE (corrects the 2.11/2.12 "OTP surfaces failure" rule — it is NOT universal):** an OTP/operation send surfaces failure to its requester ONLY where the endpoint does NOT already promise existence-opacity. Portal OTP (`treasurer_portal` request-otp — 404s on an unknown phone, so NOT opacity-protected) → surface (502), correct. Password-changed (2.12, authenticated user, courtesy) → best-effort, correct. **Password-reset (opacity-protected by an identical generic response) → do NOT surface; log server-side, return generic** — this 2.12b reversal is the correct posture. Test: `tests/test_email.py::ResetEnumerationOpacityTests` asserts the three paths are byte-identical and Path C no longer 502s. **B. Rejection-reason — now RESOLVED (durable channel exists), not mitigated-by-flare.** Added `Church.rejection_reason` (nullable TextField; migration `churches.0003_church_rejection_reason`, alters only Church). `SuperChurchRejectView` sets it from the request reason in the same atomic as the status flip (AuditLog still records it too). Surfaced to the rejected treasurer in the **login response** (`church_rejection_reason`, included ONLY when `church_status == REJECTED`) — the loginable-rejected-treasurer intent from 2.9c, completed. **Public-leak audit (verified):** `PublicChurchSerializer` is an explicit allowlist that excludes it (and excludes `status`; REJECTED churches are already filtered from public lists); `rejection_reason` rides only on `AdminChurchSerializer` (`__all__`), whose every use is either `/churches/me/` (own church, scoped by `request.user.church`, no id in URL → no cross-church probe) or IsSuperAdmin `/super/` endpoints — no anonymous or cross-church path. With a durable treasurer-readable home, `send_registration_rejected`'s failure log is downgraded from the elevated `logger.error [SOLE-REASON-CHANNEL]` to ordinary courtesy `logger.exception` (masked) — a delivery failure is now genuinely cosmetic. Tests: reject persists the reason; rejected treasurer's login carries it; the reason/`rejection_reason` appear on no public surface. **C. Timing oracle — OPEN, and WIDENED by 2.12 (recorded, NOT fixed).** With the status/body oracle closed by A, an enumeration channel REMAINS: the existing-email path does `SELECT + UPDATE (invalidate OTPs) + generate_otp + hash_token + INSERT + a live Resend round-trip`, vs a single failed `SELECT` for a non-existent email — so existing emails respond measurably slower regardless of the now-uniform body. Pre-existing (the DB-write/OTP-gen asymmetry), but 2.12's real network send WIDENED it (live HTTP vs the old no-op). Candidate fix (NOT built, tracked follow-on): constant-time response, or offload OTP-gen+send to a background task so the response returns before the slow path. **Enumeration is NOT fully closed until this timing channel is addressed.** Scope: SMS, Daraja, and the open Finding #1 redesign untouched. |
| Resend email real client (Step 2.12): TWO failure postures + the rejection-reason SOLE-CHANNEL finding | Keep permanently | Replaced the `integrations/resend_email.py` stub no-op bodies with a real Resend send through a single seam `_send_email(to, subject, html)` (mirrors 2.11's `_send_sms` / Daraja's `_http_request` — tests patch exactly that one boundary, using the installed `resend` SDK: `resend.Emails.send({...})`, success ⟺ a returned `id`). **Non-DEBUG no-op guard REMOVED** — the real send fires in staging/prod (proven by a test under the runner's DEBUG=False asserting the SDK is reached). **Two postures, encoded IN THE SEAM functions (not call sites — drift-proof):** (1) **OTP/operation** — `send_password_reset_otp` RAISES typed `EmailDeliveryError`; the view (`accounts/views.py` password-reset/request) catches it and returns **HTTP 502 "Could not send the reset code. Please try again."** — never the generic "sent" on a failed send. **Enumeration trade-off — ⚠️ SUPERSEDED by 2.12b (the 502 was an oracle and is REMOVED):** the 502 only fired for an EXISTING account (non-existent emails short-circuit to the generic 200 before the send), making it an account-existence oracle. 2.12b reverts this posture for password-reset — see the 2.12b row. (2) **COURTESY** — `send_password_changed`, `send_registration_approved`, `send_registration_rejected` — run after a committed op; **typed `except EmailDeliveryError`** (NOT bare/`except Exception` — programming errors still propagate), log with the **recipient MASKED via `common.masking.mask_email`** (new helper, PRD §12.10 discipline: first local char + domain, e.g. `j*******@example.org`; rest masked), and return — never raise/roll back/500. **REJECTION-REASON SOLE-CHANNEL FINDING:** there is NO `Church.rejection_reason` field; login returns `church_status='REJECTED'` but NOT the reason; the reason otherwise lives only in Super-Admin-only `AuditLog.details`. So `send_registration_rejected`'s email is the ONLY human-readable channel telling the rejected treasurer WHY. It stays non-raising (reject op is committed, must not roll back) but its failure is logged at **`logger.error`** with a `[SOLE-REASON-CHANNEL]` marker (elevated above ordinary courtesy `logger.exception`); the free-text reason itself is NOT written to the log (PII), only the masked recipient + church for follow-up/replay. **Robust fix — ✅ BUILT in 2.12b:** the reason is now persisted on `Church.rejection_reason` and surfaced in the rejected treasurer's login response, so email is no longer the sole channel and the SOLE-REASON-CHANNEL flare is downgraded to ordinary courtesy logging — see the 2.12b row. **Best-effort-NOW / Celery-follow-on:** synchronous in-request best-effort; the masked durable logs are the replay hooks for moving email to Celery. Tests: `tests/test_email.py` (8) — approve/reject still 200 + status transitions when `_send_email` raises; reset request returns 502 (not "sent") when it raises; courtesy functions never raise; send fires under DEBUG=False; failure log masks the recipient and omits the raw reason; `mask_email` unit cases. **No email-path test crutches needed fixing** — unlike 2.11's 5 portal tests, NO password-reset tests existed, and courtesy sends never raise so the existing register/approve/reject tests stay green. SMS (2.11), Daraja, and the open Finding #1 redesign untouched. |
| Africa's Talking SMS real client (Step 2.11): TWO failure postures — courtesy best-effort-logged vs OTP-surfaces-failure | Keep permanently | Replaced the `integrations/africastalking.py` stub no-op bodies with a real AT send through a single seam `_send_sms()` (mirrors Daraja's `_http_request` — tests patch exactly that one boundary; normalizes the recipient to `254XXXXXXXXX` via `validate_safaricom_phone` AT the boundary). **The non-DEBUG no-op guard is REMOVED** — the real send fires in staging/prod, not silently returns (proven by a test that runs under the test runner's DEBUG=False and asserts the SDK is reached). **Two postures, encoded IN THE SEAM (not at call sites — drift-proof: a caller cannot accidentally let an SMS failure break a money path):** (1) **COURTESY** sends — `send_payout_approved`, `send_payout_rejected` — run AFTER a committed money op (`withdrawals/views.py` approve/reject, both already positioned post-commit); they wrap `_send_sms` in try/except, log via `logger.exception` with structured `recipient + event` context (a DURABLE, queryable failure trace for the future Celery replay), and RETURN — never raise, never roll back, never 500 the approve/reject. (2) **OTP** send — `send_portal_otp` — IS the operation: on failure it RAISES the typed `SMSDeliveryError`; the calling view (`treasurer_portal/views.py`) catches it and returns **HTTP 502 "Could not send the verification code. Please try again."** — the user is NEVER told "OTP sent" on a failed send (the OTP row already exists but is harmless: it expires unused and the next request invalidates older unused OTPs). **Best-effort-NOW / Celery-follow-on:** courtesy sends are synchronous in-request best-effort; the durable log line is the replay hook for when SMS is moved to a Celery task (a network hiccup to AT must never surface in the money-op request path). Tests: `tests/test_sms.py` (6) — approve/reject still 200 + row transitions when `_send_sms` raises; OTP request returns 502 (not "OTP sent") when it raises; send fires under DEBUG=False + normalizes recipient; non-Success AT status raises. Pre-existing `tests/test_portal.py` request-otp tests now stub `_send_sms` to success in setUp (they cover OTP issuance/normalization, not delivery). **Resend/email (`send_password_reset_otp` / `send_password_changed` / `send_registration_approved` / `send_registration_rejected`) is UNTOUCHED — that's Step 2.12.** Daraja path and the open Finding #1 redesign untouched. |
| `DarajaClient.b2c_payout()` contract: synchronous ACK vs asynchronous result, with CLEAN vs AMBIGUOUS dispatch-failure split (Step 2.10a, corrected) | Keep permanently (load-bearing for 2.10c) | B2C is two-phase. **Phase 1 — synchronous ACK (this method):** the POST returns immediately with "queued, here is a ConversationID" (`ResponseCode == '0'`). It does NOT mean money moved — only that Daraja accepted the request. **Phase 2 — asynchronous result (2.10c):** the actual PAID/FAILED arrives later on the B2C result callback to `MPESA_B2C_RESULT_URL`. `b2c_payout()` reports ONLY on phase 1: **RETURNS `{'conversation_id': str}`** ⟺ HTTP 200 AND `ResponseCode == '0'` AND a non-empty `ConversationID`; otherwise raises one of TWO subclasses of `B2CDispatchError` (both leave the row `status=FAILED`, `b2c_conversation_id=None` — no strand). **`B2CDispatchCleanError` (CLEAN_FAILURE):** request PROVABLY never queued — transport error/timeout/DNS, non-200 sync status, OR OAuth/token acquisition failure. Safe to re-dispatch. **`B2CDispatchAmbiguousError` (AMBIGUOUS_FAILURE):** Daraja RECEIVED the request and MAY have queued it but we hold no usable ConversationID — 200 + unparseable body, 200 + non-zero `ResponseCode`, OR 200 + `ResponseCode '0'` with missing/empty `ConversationID`. NOT safe to blind-re-dispatch. **CORRECTED INVARIANT** (the earlier "no `conversation_id` ⟺ safe to re-dispatch" was WRONG and would have armed a double-pay): a missing `conversation_id` means NO CONFIRMED QUEUE, not "never queued" — re-dispatch safety is determined by the `Withdrawal.dispatch_outcome` MARKER, never by `conversation_id` absence alone. **2.10c branches on the marker:** CLEAN → may re-dispatch; AMBIGUOUS → MUST first query Daraja Transaction Status or correlate via the `Occasion=withdrawal.id` echo (carried out on dispatch, echoed back on the result callback — a correlation handle even with no stored conversation_id), NEVER blind-re-dispatch. The marker is a dedicated machine-readable field (NOT a `failure_reason` string sentinel — a copy edit must never silently flip the sweep's branch); treasurer-facing copy stays "Retry from the Withdrawals panel" for both classes. The three money-movers (treasurer approve/retry, super force-retry) catch the two subclasses in SEPARATE `except` arms and call the single shared `withdrawals/services.record_dispatch_failure(...)` so the handling can't drift; retry/force-retry clear a stale marker in Phase 1. We NEVER invent/guess a `conversation_id`, NEVER raise on how the payout RESOLVES. Single outbound HTTP boundary `DarajaClient._http_request` (tests patch exactly that, exercise the real client). OAuth token cached in-process (module dict, keyed by environment, 60s margin); the in-process concurrent-miss race is a DELIBERATE non-fix (both threads fetch, second overwrites, both tokens valid — harmless; no Redis). `b2c_payout_stub` is DELETED; all three money-movers call `DarajaClient().b2c_payout(withdrawal)` in the Phase-2 (unlocked) position only. Schema: `withdrawals.0002_withdrawal_dispatch_outcome` adds the nullable `dispatch_outcome` CharField. |

### 14.1 Live-sandbox findings — RECORDS ONLY (no change authorized)

> These are findings-records from the live Daraja B2C sandbox gate. **Nothing in 2.10c is to be edited off the back of them yet** — the redesign and the correlation trace are separate future steps. Recorded to prevent re-discovery and to scope the future work.

**§14 — 2026-06-04 — 2.10c `check_transaction_status`: synchronous-status assumption is wrong against live Daraja (SAFETY-RELEVANT, redesign required)**

Discovered during the live B2C sandbox gate (one real transaction, errorCode-confirmed path). `check_transaction_status` is built on the premise that Daraja's Transaction Status Query returns a definitive status synchronously (it parses `TransactionStatus`/`ResultCode` from the sync HTTP body and maps via `_PAID_STATUSES`/`_NOT_SENT_STATUSES`). Live Daraja does NOT do this.

Observed live (one query, TransactionID `UF4030DAHQ`): the synchronous HTTP 200 body contained only an accept-acknowledgement — `ResponseCode "0"`, `ResponseDescription "Accept the service request successfully."` — and NO `TransactionStatus`, `ResultCode`, or `ResultDesc` field. The real result arrives asynchronously on the ResultURL callback, consistent with Daraja's documented async design for this API.

Consequence (inferred from this sample + Daraja's async design; not yet proven across all response cases): because the synchronous body never contains a status string, the `CONFIRMED_PAID` and `CONFIRMED_NOT_SENT` branches are effectively unreachable on a live sync response, and the function falls through to `INCONCLUSIVE`. If this holds generally, the 2.10c sweep can never auto-resolve a stranded withdrawal via a live status query: every candidate would map INCONCLUSIVE → backoff → INCONCLUSIVE → NEEDS_RECONCILIATION.

Severity: this is SAFE, not dangerous — it strands toward human reconciliation, never toward an unverified re-dispatch or finalize, so it cannot cause a double-pay. But it means the sweep's automatic-resolution capability — the central purpose of 2.10c — does not function against real Daraja as currently built. "Broken-conservative," in the sense flagged at design time: maximally safe, but non-functional as an auto-sweep.

Why no test caught it: the hermetic suite injects a synthetic synchronous body `{"TransactionStatus":"Completed", ...}` that the live API does not send synchronously. The tests therefore validate the handler against a payload shape Safaricom does not produce. This is the same class of blind spot as the migration-drift / ALLOWED_HOSTS / STK-auth findings (suite tests logic against assumed I/O, blind to real protocol shape) but is the most severe instance, because it is a design assumption inside safety-critical money-movement logic rather than an environment/config gap.

Real async vocabulary (partial, captured from the B2C result callback, NOT the status query): a failed result arrived as `ResultCode 8006` (integer), `ResultDesc "The security credential is locked."` (human string), with no `TransactionStatus` field. So the real status vocabulary is `{integer ResultCode, string ResultDesc}` on an async callback — not the `TransactionStatus` strings the current allowlists target. A SUCCESS-result vocabulary has NOT yet been captured (no successful payout has occurred — see the 8006 locked-credential note).

Required redesign (not done; for a future 2.10c-revision step before Phase 2 is called done): status-query resolution must be driven by the async ResultURL callback, not by a synchronous return value. `_PAID_STATUSES`/`_NOT_SENT_STATUSES` as currently defined target the wrong protocol leg and remain UNVALIDATED. The corrected design must parse the async result-callback fields (`ResultCode`/`ResultDesc`) and map those. Capturing a real SUCCESS result-callback is a prerequisite for validating the success-side mapping.

Status of 2.10c after this finding: money-SAFETY properties confirmed live (no wallet debit on failed/clean-failed dispatch; failure result-callback handling works end-to-end and returns 200; no double-pay path). Money-RESOLUTION automation does NOT work against live Daraja and needs the async redesign above.

**§14 — 2026-06-04 — 2.10c re-entrancy guard: OriginatorConversationID is not echoed by Daraja (correlation basis UNCONFIRMED — must trace before relying on the version-key guard)** — ⚠️ **SUPERSEDED / DOWNGRADED TO RESOLVED by the post-trace correction immediately below (2026-06-04). The original entry (kept verbatim for the record) is a MISDIAGNOSIS — read the correction.**

Observed live: we generate and store our own OriginatorConversationID (`pmj-<uuid>`) in the Phase-1 locked block and send it in the B2C payload. Daraja's ACK did NOT echo it — the ACK returned Daraja's own OriginatorConversationID (`80c4-…`), and the row's stored value remained `pmj-…`. The B2C result callback also carried Daraja's OriginatorConversationID/ConversationID, not ours.

The 2.10c re-entrancy / optimistic-concurrency guard (`redispatch_withdrawal`'s `skipped_changed` branch) was designed on the assumption that our OriginatorConversationID round-trips and can serve as a version key for correlation. That assumption is FALSE — Daraja does not return our value.

IMPORTANT — do not overstate this: the result callback DID correlate to the correct withdrawal and set it FAILED, and `payout_reference`/`conversation_id` were reportedly not stored either. So correlation is currently WORKING by some means we have NOT yet traced — this is NOT evidence the guard is broken, only that its actual matching basis is unconfirmed and is not the round-tripped OriginatorConversationID we assumed. Possible actual bases to check: the `Occasion=withdrawal.id` echo, Daraja's ConversationID stored at dispatch, or something else.

Action (dig-in, not yet done): trace exactly how the 8006 result callback matched the withdrawal row, given our OriginatorConversationID was not echoed and `conversation_id`/`payout_reference` were reportedly unstored. The answer determines whether the re-entrancy guard needs rebuilding (if it relies on the non-round-tripping value) or only re-documenting (if correlation rests on a different, sound field). Until traced, treat the version-key guard's basis as unverified.

**§14.1 — CORRECTION to finding #2 (2026-06-04, post-trace) — RESOLVED, no defect, no rebuild needed**

Finding #2 as originally recorded (above) is a MISDIAGNOSIS and is hereby downgraded to RESOLVED. The original entry claimed the 2.10c re-entrancy guard "was designed assuming our OriginatorConversationID round-trips, and that assumption is FALSE." That conflated two unrelated uses of the `originator_conversation_id` field:

1. **The re-entrancy guard** (`services.py:226-250`) compares `fresh.originator_conversation_id` against `expected_originator_conversation_id` — **both our own internally-generated `pmj-…` value**, read off the row before vs. under the lock, rotated each dispatch via `new_originator_conversation_id()`. This is a purely internal compare-and-swap version token. **Daraja never enters this comparison; it does NOT depend on Daraja echoing anything. The guard basis is SOUND.**
2. **The callback's fallback correlation leg** would want a round-trip but doesn't get one — see the separate nuance below.

The original finding incorrectly attached the (true) observation "Daraja does not echo our OriginatorConversationID" to the (unaffected) guard. Correlation and re-entrancy are both sound; the round-trip concern applies to neither in a way that breaks anything.

**Correlation basis (traced, verified against the live row):** the B2C result callback correlates on `b2c_conversation_id == callback ConversationID` — Daraja's own ConversationID, stored at dispatch (approve Phase-2, `views.py:310-312`), echoed in the result callback. Live proof: stored `AG_20260604_01001003027yv75fs3dl` == callback ConversationID, primary match True. Sound, unique field. The earlier gate report's claim that "conversation_id was not stored" was an attribute-name error (checked `conversation_id`; the real field is `b2c_conversation_id`, which WAS populated).

**Nuance to record (SAFE, not a defect):** the callback's secondary `originator_conversation_id` fallback leg is effectively dead against live Daraja — since Daraja returns its own OriginatorConversationID, that filter can never match a live callback. It would only matter when `b2c_conversation_id` is null (an ambiguous/clean dispatch failure with no stored ACK ConversationID) that nonetheless receives a later result callback — which would then fail to correlate → unknown-id 200 no-op → row ages to NEEDS_RECONCILIATION. This is SAFE (no double-pay, no false finalize; it matches the intended AMBIGUOUS-don't-auto-resolve posture) but the fallback should be understood as non-functional against live Daraja, not as a working second correlation path. Whether to remove the dead fallback or leave it as defensive is a future-cleanup decision, not a defect.

**Finding #1 (synchronous-status assumption) is UNAFFECTED by this correction and remains open** — it is a genuine defect requiring the async redesign, unrelated to correlation.

**§14 — 2026-06-04 — Two tripwires recorded post-2.12b review (records only, no code change)**

**Tripwire 1 — `Church.rejection_reason` is safe-by-current-call-sites, NOT safe-by-construction.** `rejection_reason` is exposed via `AdminChurchSerializer`, which uses `fields = '__all__'`. The 2.12b audit verified its current mountings are safe: `/churches/me/` (own church, scoped by `request.user.church`, no id in URL → no cross-church probe) and IsSuperAdmin `/super/` endpoints only — no anonymous or cross-church path. BUT `__all__` means this safety is a property of the current call-site SET, not of the serializer itself: any future endpoint that mounts `AdminChurchSerializer` against a church id, or any new sensitive field added to `Church`, inherits exposure silently. (Same fragility flagged on the admin serializer in 2.9c.) TRIPWIRE: anyone changing `AdminChurchSerializer`'s mountings or adding a sensitive `Church` field MUST re-audit — a sensitive "why we rejected this church" string now rides on `__all__`.

**Tripwire 2 — the 2.12b enumeration fix closed the body/status oracle ONLY.** Verified at body+status level (all three password-reset paths return byte-identical 200 + generic body). It does NOT close: (a) the **timing channel** — existing-email path does `SELECT + UPDATE + OTP-gen + hash + INSERT + live Resend round-trip` vs one failed `SELECT` for non-existent, so existing emails respond measurably slower regardless of uniform body; recorded OPEN and widened-by-2.12, candidate fix = constant-time response or background-task the OTP-gen+send. (b) **Header-level indistinguishability** — the byte-identical test compares `data`/`content`, NOT response headers (Content-Length, Set-Cookie, Vary); believed identical (same Response shape on all paths) but NOT separately verified. TRIPWIRE: "enumeration closed" means body/status only; the timing and header channels are not separately verified.

**§14.1 — 2026-06-04 — B2C 8006 RETEST with regenerated SecurityCredential — STILL LOCKED (one live payout, then stopped)**

Fired ONE live B2C payout (KES 100 → 254708374149) through the real approve endpoint after the credential was regenerated (running process confirmed: SecurityCredential len 344, base64-shaped, prefix `Xdc2`; B2C shortcode 600977; initiator `testapi`; v1 `/mpesa/b2c/v1/paymentrequest`, no trailing slash; ResultURL on live ngrok → 405 on GET). Outcome:

- **Synchronous ACK CLEAN** — approve returned 200, `status=PROCESSING`, no `dispatch_status`, `b2c_conversation_id=AG_20260604_010010031bh3zg78br9r` stored. Daraja accepted and queued the request → the regenerated credential is NOT rejected at the front door.
- **Async result callback = ResultCode 8006 "The security credential is locked." AGAIN** (~1s later). Raw: `{"Result":{"ResultType":0,"ResultCode":8006,"ResultDesc":"The security credential is locked.","OriginatorConversationID":"6ff3-4bbb-8f06-6752fb3fafe115610","ConversationID":"AG_20260604_010010031bh3zg78br9r","TransactionID":"UF4030D942",...}}`. The regeneration did NOT clear the lock.
- **Finding #1 CONFIRMED on the live wire:** the credential lock is invisible at dispatch — the sync ack only means "queued"; the real fate (8006) arrives async on ResultURL. Any status logic that trusts the sync response would read this as success. (Reinforces the open async-redesign requirement.)
- **Finding #2 correction RE-CONFIRMED (2nd live datapoint):** callback `OriginatorConversationID=6ff3-4bbb-8f06-6752fb3fafe115610` ≠ our stored `pmj-13863f6cdfec42d2bef6bce6a5eb9299`. Daraja does NOT echo our originator id; correlation succeeded via `ConversationID`. The originator-id fallback leg remains dead against live Daraja.
- **Failure path SAFE end-to-end on a real locked-credential failure:** callback RC≠0 → row `FAILED` (retry_count 0 < 5, treasurer-retriable), `dispatch_outcome` cleared, `payout_reference` None, `wallet_balance` unchanged at 1000.00 (NO decrement), `raised_amount` unchanged. No double-pay, no false PAID. Money safety held.
- **Courtesy SMS posture confirmed live:** `send_payout_approved` to 254708374149 raised inside AT (sandbox rejects that MSISDN as "Invalid phone number") → swallowed as `[sms-failed][payout-approved]`, money op already committed, approve still 200. Exactly the courtesy posture.

**STOPPED per instruction — no re-fire.** NEXT (diagnosis, not yet done): the regeneration itself — `SecurityCredential` must be the **sandbox** public-cert RSA-encrypt (PKCS#1 v1.5) of initiator `testapi`'s plaintext API-operator password for shortcode 600977; an 8006-that-survives-regeneration points at (a) wrong/expired initiator password, (b) prod cert used to encrypt a sandbox cred (or vice-versa), or (c) the test-credential portal not having unlocked/activated the initiator. SUCCESS B2C result-callback vocabulary (the §6 blocked-boundary artifact) still UNCAPTURED — blocked on a non-8006 result.

**RETEST #2 (2026-06-04, same day) — real `testapi` password credential → STILL 8006. Conclusion: server-side initiator lock, not a local credential error.** Restarted to PID 20544 (≠9600); confirmed-new credential loaded (len 344, prefix `mQbJ` — **differs from the prior guessed-password `Xdc2`**, so a genuinely different plaintext encrypted; shortcode 600977 / initiator testapi / v1-no-slash / ResultURL 405 all unchanged). Fired ONE payout by **retrying** the existing FAILED row `bb40b8b9…`: sync ACK clean again (200, PROCESSING, retry_count 1, ConversationID `AG_20260604_010010031car84icawj2`, TransactionID `UF4030D946`), async callback **ResultCode 8006 "The security credential is locked." again** (~1s later). Row landed FAILED (retry_count 1 < 5), `dispatch_outcome=None`, `payout_reference=None`, `wallet_balance=1000.00` unchanged — money safety held identically. Since two **different, correctly-shaped** credentials (one guessed, one the real testapi password) both produce 8006 while Daraja accepts the dispatch (clean sync ack) every time, the lock is on the **Safaricom sandbox initiator** (600977 / testapi), not on our `.env` value or encryption. **NEXT STEP = Safaricom Daraja sandbox support / re-activate-or-unlock the test initiator — NOT another `.env` change.** §6 SUCCESS-callback vocabulary remains UNCAPTURED until the initiator is unlocked.

**RETEST #3 (2026-06-06, +2 days, credential UNCHANGED `mQbJ`) — STILL 8006. Time alone did not clear the lock.** Re-fired one payout via retry of `bb40b8b9…` (PID 3612; same confirmed-correct credential, same shortcode/initiator/ResultURL/v1). Sync ACK clean (200, PROCESSING, retry_count 2, ConversationID `AG_20260606_0100100304t5iyfgdj83`, TransactionID `UF6030D9BJ`); async callback **ResultCode 8006 "The security credential is locked." again**. Row → FAILED (retry_count 2 < 5), `wallet_balance=1000.00` unchanged, money safety held. Confirms the lock does NOT auto-clear with elapsed time — it requires an explicit Safaricom sandbox initiator unlock/re-activation. §6 SUCCESS artifact still blocked.

**RESOLVED (2026-06-06) — NEW Daraja sandbox app cleared 8006. Full B2C lifecycle proven live end-to-end; §6 SUCCESS artifact CAPTURED.** Root cause confirmed: the lock was bound to the OLD app's B2C initiator (shortcode `600977`), not to our `.env` value — a freshly-created Daraja app fixed it with NO code change. New working config (in `.env`, sandbox): new consumer key (`ikby…`, len 48) + secret (`kYF8…`, len 64) → **OAUTH=OK**; **B2C shortcode `600992`** (was 600977); initiator `testapi`; new SecurityCredential (`LV90…`, len 344, ≠ prior `mQbJ`/`Xdc2`); STK shortcode 174379. Fired one retry of `bb40b8b9…` → sync ACK clean → async **ResultCode 0** result callback.

**§6 BLOCKED-BOUNDARY ARTIFACT — B2C SUCCESS result-callback vocabulary (verbatim, exact casing):**
```json
{"Result":{"ResultType":0,"ResultCode":0,"ResultDesc":"The service request is processed successfully.",
"OriginatorConversationID":"3dbc-450c-a895-2387f154a65a62471","ConversationID":"AG_20260606_0100100305icrjnviknq",
"TransactionID":"UF6030DATO","ResultParameters":{"ResultParameter":[
{"Key":"TransactionAmount","Value":100},{"Key":"TransactionReceipt","Value":"UF6030DATO"},
{"Key":"ReceiverPartyPublicName","Value":"254708374149 - John Doe"},
{"Key":"TransactionCompletedDateTime","Value":"06.06.2026 02:34:14"},
{"Key":"B2CUtilityAccountAvailableFunds","Value":4276682.55},{"Key":"B2CWorkingAccountAvailableFunds","Value":108.90},
{"Key":"B2CRecipientIsRegisteredCustomer","Value":"Y"},{"Key":"B2CChargesPaidAccountAvailableFunds","Value":-1980.00}]},
"ReferenceData":{"ReferenceItem":{"Key":"QueueTimeoutURL","Value":"…/b2cresults/v1/submit"}}}}
```
Shape notes for the Finding #1 redesign: success ⟺ top-level `Result.ResultCode == 0` (int 0, not string); `ResultDesc` = "The service request is processed successfully."; the receipt lives BOTH at top-level `Result.TransactionID` AND inside `ResultParameters.ResultParameter[]` as `TransactionReceipt` (same value `UF6030DATO`). Our callback handler reads ONLY top-level `TransactionID` and does NOT parse `ResultParameters` — that sufficed (payout_reference set correctly), so no callback-path change needed. `TransactionCompletedDateTime` format is `dd.mm.yyyy HH:MM:SS`. `ResultParameters` is present on SUCCESS and ABSENT on the 8006 failure — so a parser must treat it as optional.

**End-to-end row outcome (verified):** withdrawal → `PAID`; `payout_reference=UF6030DATO`; campaign `wallet_balance` 1000 → **900** (exactly-once decrement by the 100 amount via `finalize_withdrawal_paid`); `raised_amount` unchanged (correct — payouts don't touch raised); correlation matched on `b2c_conversation_id == callback ConversationID` (`AG_20260606_0100100305icrjnviknq`). **Finding #2 re-confirmed once more:** callback `OriginatorConversationID=3dbc-…` ≠ our stored `pmj-b0feed10…` — Daraja still does not echo our id; correlation rode ConversationID. **Finding #1 (sync-status assumption) now has its real success artifact:** like the 8006 failure, the SUCCESS verdict arrived ONLY on the async ResultURL (~1s after a clean sync "queued" ack) — the sync ack is never the outcome. This is the live proof the async redesign must encode.

**§14.1 — Lock-order inversion on the resolve-to-PAID path (KNOWN, REAL-BUT-SAFE, DEFERRED).** Dispatch movers lock Campaign→Withdrawal (`services.py:218-219`, `views.py:247-253`); resolve movers lock Withdrawal→Campaign (`views.py:611`→`services.py:110`, and the same via resolve-paid/sweep-finalize). Inverted orders = textbook ABBA. NOT a money-correctness defect: Phase-1/Phase-2 discipline releases the dispatch locks BEFORE the B2C HTTP call, so the held-across overlap is sub-millisecond; any actual deadlock is a Postgres-aborted, self-healing, no-money-moved event (callback returns non-200 → Safaricom retries; sweep tick retries). The collision becomes more reachable once Finding #1's secondary resolver starts returning CONFIRMED_NOT_SENT (sweep re-dispatch races a late callback). DEFERRED: align resolve paths to Campaign→Withdrawal as its own small checkpoint AFTER the secondary resolver is built. Recorded so the inversion is a deliberate deferral, not a forgotten one.

**§14.1 — resolve-paid finalizes with a NULL payout_reference when no success callback ever arrives (PRE-EXISTING DEFECT, DEFERRED).** `payout_reference` is written only inside `finalize_withdrawal_paid` on the PAID transition (`services.py:114-117`); a row reaching NEEDS_RECONCILIATION has never been through finalize, so its reference is NULL (`mark_needs_reconciliation` leaves it untouched, `services.py:146-150`). The (2)+(3)+(b-persist) fix (callback short-circuit now persists the receipt when a SUCCESS callback arrives AFTER the row is in reconciliation — `WITHDRAWAL_RECONCILIATION_PAYMENT_CONFIRMED`, tests in `tests/test_reconciliation_finalize.py`) lands the receipt for THAT case only. It does NOT cover the case where no further callback ever arrives — those rows still resolve PAID with a NULL receipt. DEFERRED: a separate item — either require the Super Admin to enter the M-Pesa reference at resolve-paid (they're reconciling against the M-Pesa statement and have it) or explicitly record "resolved without reference." Touches the resolve-paid endpoint + frontend; a genuine product decision, surfaced not bundled.

**§14.1 — DISBURSEMENT_FAILED was overloaded for non-failure reconciliation alerts (PARTIALLY corrected).** The enum had no reconciliation types, so `mark_needs_reconciliation` borrowed `DISBURSEMENT_FAILED` for the freeze alert (its own comment admits the borrow), and the Finding #1 payment-confirmed alert initially inherited the same borrow — typing a confirmed success as a failure. CORRECTED: minted `NotificationType.RECONCILIATION_PAYMENT_CONFIRMED` for the payment-confirmed alert. Migration was NOT free as first assumed: the value is 32 chars vs the field's `max_length=30`, so `notification_type` was widened to 40 (`notifications/0003_alter_notification_notification_type`, a real `AlterField`) — and this repo migrates on every choices change anyway (precedent: `0002`). DEFERRED (recorded, not fixed): `mark_needs_reconciliation`'s freeze alert STILL uses `DISBURSEMENT_FAILED` (`services.py:186`, untouched) — a non-success state, so a more defensible borrow than the confirmed-payment one was, but still imprecise; retype to a reconciliation-freeze type when that path is next opened. Note: no literal payout-failure currently emits ANY Notification (callback-failure and `record_dispatch_failure` write only AuditLog) — so `DISBURSEMENT_FAILED` as an enum value has no honest emitter today.

**§14.1 — Frontend NotificationType union is out of sync with the backend enum (Phase-4 wiring item).** `frontend/types/index.ts` lists 8 members; the backend now has **10** (was 9 — missing `CAMPAIGN_DESTINATION_CHANGED` — plus the new `RECONCILIATION_PAYMENT_CONFIRMED`). Unknown types fall back to a default icon (`notifications.tsx:41` — `?? notifications-outline`), so this is non-breaking today, but the union AND the `TYPE_ICON` map must be reconciled with the backend enum when the frontend is wired to the real API — and especially before any Super-Admin notifications screen renders the reconciliation alerts, which currently surface in NO UI (the super-admin bell is a placeholder).

**§14.1 — CAPTURED 2026-06-07 — Transaction Status Query ASYNC result vocabulary** (the §6 secondary-resolver artifact; records only, no resolver built).

Captured on the working 600992 sandbox app. Fired one KES 100 payout (row `3769eec8…`, → PAID, ReceiptNo `UF7030D9EY`, wallet 5000→4900), then called `check_transaction_status`. Sync response = bare accept-ACK (`ResponseCode "0"`, no status) → INCONCLUSIVE, as Finding #1 predicted. The real verdict arrived ASYNC on the SHARED `/withdrawals/b2c-result/` URL ~1s later.

RAW async status-query result (verbatim):
```json
{"Result":{"ResultType":0,"ResultCode":0,"ResultDesc":"The service request is processed successfully.","OriginatorConversationID":"3bbc-4bca-9342-a9e5d35e42916374","ConversationID":"AG_20260607_0100100300tp67kvox7g","TransactionID":"UF71000000","ResultParameters":{"ResultParameter":[{"Key":"DebitPartyName","Value":"600992 - Safaricom Daraja 992"},{"Key":"CreditPartyName","Value":"254708374149 - John Doe"},{"Key":"OriginatorConversationID","Value":"a71a-483d-be2d-b5dd69df628b8463"},{"Key":"InitiatedTime","Value":20260607002146},{"Key":"DebitAccountType","Value":"Utility Account"},{"Key":"DebitPartyCharges","Value":"Fee For B2C Payment|KES|33.60"},{"Key":"TransactionReason"},{"Key":"ReasonType","Value":"Business Payment to Customer via API"},{"Key":"TransactionStatus","Value":"Completed"},{"Key":"FinalisedTime","Value":20260607002146},{"Key":"Amount","Value":100.00},{"Key":"ConversationID","Value":"AG_20260607_0100100300rzz1iz3zwf"},{"Key":"ReceiptNo","Value":"UF7030D9EY"}]},"ReferenceData":{"ReferenceItem":{"Key":"Occasion","Value":"3769eec8-8d7b-478c-aa81-47189b56a31c"}}}}
```

DESIGN-CRITICAL SHAPE FACTS (the secondary resolver MUST encode these):
1. **SUCCESS ⟺** top-level `Result.ResultCode == 0` (int) AND inner `TransactionStatus == "Completed"` (case-insensitive; `_PAID_STATUSES=('completed',)` matches). `TransactionStatus` lives INSIDE `ResultParameters`, NOT top-level.
2. **CORRELATION DOES NOT MATCH THE PAYOUT PATH.** Top-level `ConversationID`/`OriginatorConversationID` are the QUERY's own ids, not the payout's — the live capture confirmed today's top-level-`ConversationID` handler matched NOTHING and left the row untouched. The payout's identity is INSIDE: inner `ConversationID` = our `b2c_conversation_id` (`AG_…rzz1iz3zwf`); `ReceiptNo` = our `payout_reference` (`UF7030D9EY`); `ReferenceData.Occasion` = our `withdrawal.id` (`3769eec8…`). → The secondary resolver needs a DIFFERENT correlation leg (Occasion / inner ConversationID / ReceiptNo), decided at design time. It CANNOT reuse the primary callback's top-level correlation.
3. **DISCRIMINATION** (status-query result vs payout result on the shared URL): distinguishable by `ResultParameters` key set (status-query: `TransactionStatus`, `ReceiptNo`, `DebitPartyName`, `ReasonType`; payout: `TransactionReceipt`, `ReceiverPartyPublicName`, `B2CWorkingAccountAvailableFunds`). Shape-based, not a clean type flag — treat as fragile.
4. Top-level `TransactionID` on the status-query result is a placeholder (`UF71000000`), NOT the payout receipt. The real receipt is inner `ReceiptNo`.

**§14.1 — DISPROVEN 2026-06-07 — Daraja Transaction Status Query CANNOT resolve an unconfirmed B2C row (the secondary-resolver architecture has no live mechanism).** Four-variant live capture (working 600992 app, payout `ff14be9b…`, receipt `UF7030D9F0`): the ONLY lookup key that makes Daraja locate a transaction is `TransactionID` = the M-Pesa receipt (Variant A → full status, `TransactionStatus` Completed). The three handles an UNCONFIRMED row carries all FAIL to locate: our `pmj-` `OriginatorConversationID` → sync HTTP 500 `500.001.1001`, no async result (Variant B, deterministic, re-fired); `Occasion=withdrawal.id` alone → same 500 (Variant D); Daraja's own `AG_` ConversationID in the `TransactionID` slot → async `ResultCode 25` "format … invalid" (Variant C; the API has no `ConversationID` parameter). Since PROCESSING and FAILED+AMBIGUOUS rows have `payout_reference=NULL` (receipt only written on PAID), the one working key exists ONLY AFTER the success the sweep is trying to confirm in its absence — a circular dependency in Daraja's contract. CONSEQUENCE: the dual-path design's SECONDARY leg (active re-query) is non-functional on the wire; the rejected single-path alternative (callback resolves; stale rows with no callback escalate to NEEDS_RECONCILIATION for a human) is the only viable architecture. The §14 note naming `OriginatorConversationID` as "the Transaction Status correlation handle" is DISPROVEN. The §14.1 result-parsing capture remains valid but answers a query the sweep cannot successfully fire. CAVEAT: sandbox-only; production Daraja MAY differ, and other Daraja APIs (reversal, statement) are untested — record as "no working key on the wire as tested," revisit if production differs.

**§14.1 — DISCOVERED 2026-06-07 — the B2C stranded-row sweep has NEVER been scheduled; stranded-row escalation has been non-operational since written.** `sweep_stuck_withdrawals` (`tasks.py:83`) is a bare `@shared_task` with NO trigger: no `beat_schedule` (`config/celery.py` has no `app.conf.beat_schedule`; no `CELERY_BEAT_SCHEDULE` in settings), `django-celery-beat` is in requirements but NOT in `INSTALLED_APPS` and creates no `PeriodicTask`, no `.delay()`/`.apply_async()` caller, no management command, no Procfile/compose/cron, and only a worker (never beat) is documented (`BuildGuide:1625`). CONSEQUENCE: a PROCESSING row with a lost callback is never escalated to NEEDS_RECONCILIATION — the §14 "money-in-limbo frozen for a human" guarantee is not in effect in the deployment. This compounds the active-query disproof: stranded rows can be neither auto-resolved (no working query key) NOR auto-escalated (no scheduler). RESOLUTION DECISION: [A1 wire beat / A2 management command / B defer] — see checkpoint. Wiring a schedule in code is necessary-but-not-sufficient: the net only fires if a celery beat (A1) or the command (A2) actually runs in the deployment — an operational dependency, not provable by a unit test.

**§14.1 — RESOLVED 2026-06-07 (A2) — sweep rebuilt escalate-only as a management command; wire-disproven active-query machinery DELETED.** A2 chosen. The Transaction Status active-query path was removed wholesale (wire-disproven, see the two records above): deleted `check_transaction_status`, `TransactionStatusOutcome`, `_PAID_STATUSES`, `_NOT_SENT_STATUSES` (`daraja.py`); `_query_status_with_backoff` and the CONFIRMED_PAID / CONFIRMED_NOT_SENT branches (`tasks.py`); `redispatch_withdrawal` (`services.py` — now dead: the sweep was its only non-test caller; treasurer-retry and super-force-retry call `b2c_payout` directly); and the two query tunables `B2C_SWEEP_STATUS_QUERY_ATTEMPTS` / `B2C_SWEEP_BACKOFF_BASE_SECONDS` (`base.py`). The sweep is now `run_stranded_withdrawal_sweep()` — a plain function (no `DarajaClient`, no network, no re-dispatch) that selects stale PROCESSING / FAILED+AMBIGUOUS rows → `select_for_update` + `_is_still_candidate` recheck → `mark_needs_reconciliation` (existing Super-Admin alert + audit, UNCHANGED). BEHAVIOUR-PRESERVING against the live wire: the deleted query always returned INCONCLUSIVE on real Daraja, so stale rows already escalated — only the impossible branch was removed, not the outcome. TRIGGER (A2): `python manage.py sweep_stranded_withdrawals` (`withdrawals/management/commands/`), run manually or by system cron, synchronously in-process (never `.delay()`). The safety net is operational ONLY when the command is actually run, and in prod it MUST run with `DJANGO_SETTINGS_MODULE=config.settings.production` (`manage.py` defaults to development) — the command prints its active settings module + DB name at startup so a misconfigured run is visible in cron output. `sweep_stuck_withdrawals` is KEPT as a thin `@shared_task` wrapper so wiring beat later (A1) needs no rework. `originator_conversation_id` rotation at the three dispatch sites (approve/retry/force-retry) is RETAINED but documented in-code as no-longer-a-CAS-key (its only reader, `redispatch_withdrawal`, is gone — it is now just a per-dispatch unique id sent to Daraja, not a concurrency guard). Tests: 11 deleted (4 query-outcome + 6 Transaction-Status mapping + 1 re-entrancy), 3 reframed to escalate-only, 4 added (escalate-only RED→GREEN with a no-`DarajaClient` assertion proven RED against the old sweep first, fresh-row staleness gate, already-resolved recheck, and a `call_command` idempotent-re-run test). Full suite 252/252 green. STILL OPEN (operational, not code): A2 only protects money-in-limbo if the cron entry actually exists and runs with production settings — deployment must add it.

**§14.1 — RESOLVED 2026-06-16 — Super Admin Force-Retry FE wiring: live B2C re-dispatch proven; new race guard added; lock-then-call double-dispatch guard proven on the wire.**

Force-retry (FAILED_FINAL → PROCESSING → PAID/FAILED) was the first super-admin write that re-dispatches REAL money, and the Withdrawals screen had no verdict-poller before this slice (it was `useFocusRefetch`-only). Ported the treasurer payouts screen's proven `startApprovalPoll` harness (3s × 10 attempts) verbatim, plus a structural addition the treasurer screen didn't need: `settledRowsRef` (a `Map<id, Withdrawal>`) pins a row once the poller — or an early-arriving focus-refetch — reaches a terminal verdict, so a stale/out-of-order `useFocusRefetch` snapshot can never resurrect a stale PROCESSING after the row settled. `activePollIdRef` lets an incoming focus-refetch settle the poll early if its own snapshot is already terminal.

**Live proof, happy path:** seeded a real FAILED_FINAL row (`fc18ba29…`, KES 100 → sandbox MSISDN `254708374149`) via Django shell, drove it through the real UI (Playwright): confirm modal showed no attestation checkbox (the decided design — FAILED_FINAL is provably never-sent, so there's no out-of-band M-Pesa fact to attest), full destination phone, danger styling. POST 200 body: `status=PROCESSING`. The FIRST silent poll tick (3s later) already showed `status=PAID, payout_reference=UFG030DCA9, b2c_conversation_id=AG_20260616_0100100318iervymzio7` — the real Daraja sandbox callback landed inside the first window. DB confirmed: wallet `4690.00→4590.00` (exactly once), `retry_count` reset to 0 then stayed 0.

**Race-guard proof (driven deterministically, disclosed):** after the row settled to PAID, manually reverted the DB row to `status=PROCESSING, payout_reference=null` to simulate the exact snapshot a stale/delayed `useFocusRefetch` response would carry, then triggered a real focus-refetch (tab switch away and back). The GET response genuinely carried the stale `PROCESSING`/`null` — but the UI still rendered **Paid**, proving `settledRowsRef` held. DB was restored to the true `PAID`/`UFG030DCA9` state immediately after.

**Double-fire / lock-then-call proof (driven for real):** seeded a second FAILED_FINAL row (`5d55ff00…`, KES 50) and fired two concurrent `force-retry` POSTs via curl with a real super-admin bearer token. Result: one request got `400 {"detail":"Only FAILED_FINAL withdrawals can be force-retried."}`, the other got `200 PROCESSING` — `select_for_update` lock-then-call prevented a double dispatch at the DB level (the frontend's `forceRetrySubmitting` guard + `confirmDisabled` would prevent a UI double-click from even issuing the second request). That row went on to settle PAID for real (`UFG030DCAA`, wallet `4590→4540`).

**Sync dispatch failure / timeout terminal:** code-verified, not driven — both branches are identical to the already-proven treasurer approve/retry handling (`dispatch_status === 'failed_queued_for_retry'` branch; same poll constants and exhaustion logic ported line-for-line).

**Re-audit finding (recorded so it isn't re-discovered):** the prior "still all mock" Phase 4 write-tier status (§0/§18, dated through 2026-06-15) was stale — campaign pause/resume/close, treasurer payout approve/reject/retry, super church approve/reject/suspend/reinstate, and super billing fee_percent PATCH were ALL already wired in the codebase before this slice, just never recorded in a status update. §0/§18 corrected 2026-06-16 to reflect actual code state, verified by grepping each service file for real `api.*()` calls vs `// Phase 4:` stubs.

**§14.1 — RESOLVED 2026-06-09 (Phase 3 Piece 3) — AuditLog DB-level immutability applied to the DEV database; production repeat-step documented.** Ran `REVOKE UPDATE ON audit_auditlog FROM pamoja_app;` + `REVOKE DELETE ON audit_auditlog FROM pamoja_app;` on the dev DB (`pamoja_dev`), closing the gap noted earlier (the Python `AuditLog.save()/delete()` guard does not catch `QuerySet.update()/delete()` or raw SQL). VERIFIED acting as `pamoja_app`: UPDATE → `permission denied for table audit_auditlog`; DELETE → `permission denied`; INSERT still succeeds (probe rolled back); SELECT still works (`has_table_privilege` after: SELECT t, INSERT t, UPDATE f, DELETE f). Full suite 280/280 green (INSERT unbroken; note the test DB is separate and does NOT receive the REVOKE — it isn't a migration). OWNERSHIP NUANCE: `pamoja_app` is the table OWNER (migrations ran as it) and is NOT a superuser; a non-superuser owner CAN make a table read-only to itself (PG docs confirmed on the wire), so the REVOKE is effective — BUT the owner keeps the implicit GRANT OPTION and could `GRANT` the privileges back to itself. For hard tamper-proofing, production should own audit tables with a SEPARATE migrations/admin role, leaving `pamoja_app` a non-owner with only INSERT/SELECT. CRITICAL — NOT A MIGRATION: a REVOKE does not travel in migrations, so it must be run MANUALLY against the PRODUCTION database (as a superuser or the table owner) before go-live, and verified with the same UPDATE-must-fail test. Until run on production, the production audit log is NOT tamper-proof at the DB level. Runbook: `backend/docs/production_db_hardening.md` (exact SQL + verification + ownership caveat). Also deleted the leftover throwaway `backend/_live8006_state.py` (confirmed not imported anywhere). Models/migrations untouched by this piece.

---

## 15. Mock Data Summary

**campaigns.mock.ts — canonical master list (single source of truth):**

| ID | Title | Church | Status | raisedAmount (net) | walletBalance (derived) |
|---|---|---|---|---|---|
| tc1 | District 5 Classroom Desks Fund | PCEA Bahati Martyrs | ACTIVE | 50 700 | 38 700 |
| tc2 | Women's Guild Meeting Hall Roof | PCEA Bahati Martyrs | ACTIVE | 95 550 | 70 550 |
| tc3 | Cathedral Roof Restoration | ACK St. Paul's Cathedral | ACTIVE | 2 437 500 | 2 437 500 |
| tc4 | Sunday School Books & Supplies | ACK St. Paul's Cathedral | ACTIVE | 40 462.5 | 32 462.5 |
| tc5 | Elders Meeting Room Renovation | PCEA Bahati Martyrs | PAUSED | 34 125 | 19 125 |
| tc6 | Christmas Outreach Fund 2024 | PCEA Bahati Martyrs | CLOSED | 29 250 | 29 250 |

`walletBalance` is a **derived field** — computed in `campaigns.mock.ts` as `raisedAmount − sum(PAID withdrawals)`. Never hardcoded. `mockTreasurerCampaigns` and `mockTreasurerSummary` in `treasurer.mock.ts` are fully derived from the master list — no duplicate data.

PCEA treasurer view shows: tc1, tc2, tc5, tc6 (filter `churchId === 'church-1'`). ACK campaigns (tc3, tc4) are invisible to the PCEA treasurer — PRD multi-tenant boundary enforced at mock layer.

`mockTreasurerSummary` (all computed): `totalRaised: 209625`, `walletBalance: 157625`, `totalDisbursed: 52000`, `activeCampaigns: 2`, `pendingDisbursements: 2`.

**churches.mock.ts:** 7 churches — church-1 PCEA Bahati Martyrs (ACTIVE), church-2 ACK St. Paul's Cathedral (ACTIVE), church-3 RGC Mombasa (ACTIVE), church-4 AG Eldoret (SUSPENDED), church-5/6/7 (PENDING)

**withdrawals.mock.ts:** 10 withdrawals (w1–w10) covering all 6 statuses. ID scheme matches campaign IDs (`tc1`–`tc5`). `walletBalance` in campaigns is derived from these records — editing a withdrawal amount auto-corrects the campaign balance.

**donations.mock.ts:** Multiple with realistic M-Pesa receipts (format: QHE7FG123Z)

**notifications.mock.ts:** Multiple covering all notification types

**groups.mock.ts:** 5 GroupLabels — 3 with active campaigns (cannot archive), 2 without (can archive), mix of flat and hierarchical

**treasurer.mock.ts:** `mockTreasurerCampaigns` and `mockTreasurerSummary` fully derived from `mockAllCampaigns` in campaigns.mock.ts. `mockRecentDonations` (d1–d4) are static with correct net/fee math.

**Consistency test suite:** `tests/mockDataConsistency.test.ts` — 30 tests across groups A–H. Run with `npm test`. All tests enforce the cross-file invariants described above.

---

## 16. Components Built

**components/ui/:**
- Button.tsx — variants: primary, secondary, danger, ghost. States: default, loading, disabled
- Input.tsx — label, value, error message, helper text, numeric keyboard type prop
- Badge.tsx — status badges with colors for each status enum
- ProgressBar.tsx — raised/goal with percentage
- Card.tsx
- Modal.tsx — reusable with title, content, confirm/cancel
- Spinner.tsx
- Toast.tsx
- OTPInput.tsx — forwardRef + useImperativeHandle, exports OTPInputRef type

**components/campaign/:**
- CampaignCard.tsx
- DonationForm.tsx — 4 fields, Safaricom validation, 2s mock flow, success/failure states
- CampaignCreationForm.tsx
- WhatsAppShareButton.tsx — builds wa.me URL, opens natively

**components/layout/:**
- TopNav.tsx
- NotificationBell.tsx — with badge and dropdown
- TreasurerSidebar.tsx
- SuperAdminSidebar.tsx

**components/disbursement/:**
- DisbursementRequestForm.tsx
- DisbursementApprovalDialog.tsx — full unmasked phone + red warning box

---

## 17. Environment Variables (backend — configured in `backend/.env`)

```
SECRET_KEY=
DEBUG=
DATABASE_URL=
MPESA_CONSUMER_KEY=
MPESA_CONSUMER_SECRET=
MPESA_SHORTCODE=
MPESA_PASSKEY=
MPESA_CALLBACK_URL=
MPESA_ENVIRONMENT=sandbox
MPESA_B2C_INITIATOR_NAME=
MPESA_B2C_SECURITY_CREDENTIAL=
MPESA_B2C_QUEUE_URL=
MPESA_B2C_RESULT_URL=
MPESA_FLOAT_ALERT_THRESHOLD=50000
AT_API_KEY=
AT_USERNAME=sandbox
RESEND_API_KEY=
RESEND_FROM_EMAIL=
FRONTEND_URL=
ALLOWED_HOSTS=
CORS_ALLOWED_ORIGINS=
PLATFORM_FEE_PERCENT=2.5
```

All three service accounts are live and credentials are entered (Africa's Talking, Resend, Safaricom Daraja). Daraja sandbox is the **600992** app (OAuth + STK 174379 + B2C 600992 all working; the old 600977 B2C initiator was server-side-locked — see §14.1). For web dev, `CORS_ALLOWED_ORIGINS` must include the Metro origin `http://localhost:8081` (default in base.py is `[]`).

---

## 18. Phase Roadmap & Remaining Work (updated 2026-06-26)

**Phase 2 — Backend (Django): ✅ DONE.** All apps built in order (audit → accounts → churches → campaigns → donations → withdrawals → notifications → treasurer_portal → superadmin, plus integrations/common), Steps 2.1 → 2.12b. 499 tests (live count — reconciled 2026-07-09, was 422 on 2026-06-26). Run from repo root: `backend\venv\Scripts\python.exe backend\manage.py test tests` (the suite lives in the `tests` package — bare `manage.py test` discovers 0).

**Phase 3 — DB indexes/constraints + AuditLog immutability: ✅ DONE on dev.** ⚠ Production REVOKE UPDATE/DELETE on `audit_auditlog` is NOT a migration — run manually before go-live (`backend/docs/production_db_hardening.md`).

**Phase 4 — Connect frontend to backend (replace mock with real Axios): ✅ FUNCTIONALLY COMPLETE — reads done, writes done (incl. campaign-create + password-reset, closed 2026-06-26).**
- ✅ Done (reads): login, session-restore (`/auth/me`), register, token refresh-and-retry, full logout, public LIST + DETAIL screens, treasurer dashboard READS (overview/my-campaigns/campaign-detail/payouts/reports/settings/groups), **ALL super-admin READS** (billing, withdrawals, campaigns, donations, queue, analytics, churches, audit-log — zero super mock). `useFocusRefetch` applied to every read screen except billing. S7a backend gap closed (`/super/churches/` aggregates).
- ✅ Done (treasurer writes): campaign pause/resume/close; payout approve/reject/retry (verdict-poll harness); group-labels create/rename/archive/unarchive; church-profile PATCH (`/churches/me/`); subscription initiate → STK poll → cancel (`SubscriptionCard`); OTP-portal request-otp/verify-otp/report/**request-disbursement** (`portalClient`, `Authorization: Portal`).
- ✅ Done (super writes): church approve/reject (Queue) + suspend/reactivate + **set-tier**; billing PATCH (fee_percent + **growth/parish prices**); withdrawal resolve-retry + **resolve-paid** + **force-retry** (first super B2C re-dispatch, see §14.1).
- ✅ Done (money-in + lifecycle): donations STK initiate + bounded poll (first money-IN write); full subscription lifecycle (initiate/callback/poll/cancel, grace-lapse, 7d/1d/grace reminders, down-pay block) backend + FE; FREE-tier 3-active-campaign cap; notifications read API (list/unread-count/mark-read/mark-all) backend + FE.
- ✅ Done (final gaps, 2026-06-26): **campaign creation** (`new.tsx:330` → `campaignsService.create` → `POST /campaigns/mine/create/`; live group labels via `groupsService.list`; navigates to server slug) and auth **password-reset** request/confirm (`auth.service.ts:82-103` → live `/auth/password-reset/{request,confirm}/`). Landing active-campaigns preview is also live (`campaignsService.browse`).
- ⬜ Remaining (cosmetic + dead only): the OTP-portal greeting name (`mockTreasurerProfile.firstName`). (The dead `donationsService.listForCampaign` was **✅ DELETED 2026-07-08**, commit `4709e88`.) No functional gap.
- Working method: per slice — READ-ONLY contract trace (quote file:line, no edits) → BUILD (restart backend `--noreload`, one live checkpoint) → STOP for review. Money-write actions come AFTER their read slice.

**Open backend items (recorded in §14.1):** Finding #1 redesign is RESOLVED (active-query deleted, escalate-only sweep) but the sweep only protects money-in-limbo if the cron/command actually runs with production settings; resolve-paid NULL-reference handling and lock-order alignment on the resolve path are deferred. **STK SUCCESS-callback parse path remains unexercised against a real success** — the sandbox never delivers a success array (no handset/PIN), so donation/subscription success is proven via local POST + idempotency, not a live success callback.

---

## 19. Files Reference

| File | Purpose |
|---|---|
| PamojaHub_PRD_v5_FINAL.docx | Source of truth — all product decisions |
| PamojaHub_BuildGuide.md | Step-by-step build instructions |
| PamojaHub_Compressed_v2.md | This file — quick context for new sessions |
| PamojaHub_Logo_Cream.png | Canonical brand logo (cream background) |
| PamojaHub_Logo_White.png | Logo on white background |
| backend.env.example | All required environment variables with placeholders |

---

## 20. How to Start a New Session

**In this chat (claude.ai):**
Upload PamojaHub_PRD_v5_FINAL.docx + PamojaHub_Compressed_v2.md and say:
*"Read both files fully. We are building Pamoja Hub. [state the next thing you need]"*

**In Claude Code (VS Code):**
1. Type `/mem-search next steps` — memory will surface the current state
2. If memory is unclear, upload PRD v5 + this file and say:
*"Read both files. We are on [step]. Continue from where we left off."*

---

*Pamoja Hub Compressed Context v2 — Last updated 2026-06-26*
*Frontend Phase 1 complete (0 TypeScript errors; vitest 60/60). Backend Phase 2 complete (499 tests, live count — reconciled 2026-07-09, was 422). Phase 3 DB hardening applied to dev DB (prod REVOKE pending). Phase 4 frontend↔backend wiring FUNCTIONALLY COMPLETE — all reads + all writes wired (treasurer + super + donations STK + full subscription lifecycle + notifications + campaign-create + password-reset); only a cosmetic mock greeting remains (the dead `listForCampaign` was deleted 2026-07-08). Security: PH2-01 forged-callback vector closed (secret callback path + amount/identity cross-check). See §0 for the live state.*
