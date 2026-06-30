# PamojaHub — COMPREHENSIVE AUDIT REPORT

> Audit-only engagement. NO application source was modified. All mutation testing ran against
> a disposable `pamoja_audit` DB (dropped at the end); `pamoja_dev` was never written to.
> Full per-finding detail lives in `AUDIT/FINDINGS.md`; coverage checklist in `AUDIT/PROGRESS.md`;
> inventory in `AUDIT/INVENTORY.md`. Reproduction scripts in `AUDIT/scripts/`.

**Scope covered:** Phases 0–8 COMPLETE. Backend (Django 5 / DRF / PostgreSQL / M-Pesa Daraja),
frontend (Expo/React-Native web), FE↔BE contracts, full E2E money journeys, dead-code sweep.

**Headline:** **0 CRITICAL, 0 HIGH.** The security core is genuinely strong — no money loss, no
auth bypass, no cross-tenant leak, no injection sink. The defects cluster in four buckets:
(1) **frontend features that fake success while doing nothing** (campaign-create, password-reset,
super approve-payout), (2) **production-settings hardening** not yet wired (rate-limit cache/IP,
callback IP-allowlist, transport headers, audit-REVOKE-as-migration), (3) **enumeration via timing**
from synchronous external sends, (4) **HTML escaping** in transactional emails.

---

## 1. COUNTS

### By severity
| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 10 |
| LOW | 6 |
| INFO | 2 |
| **TOTAL** | **18** |

### By phase
| Phase | Findings | IDs |
|---|---|---|
| 1 — Auth/AuthZ | 8 | PH1-01…PH1-08 |
| 2 — Money/Injection/Config | 3 | PH2-01, PH2-02, PH2-03 |
| 4 — Frontend | 5 | PH4-01…PH4-05 |
| 5 — FE↔BE contracts | 1 | PH5-01 |
| 7 — Dead code | 1 | PH7-01 |
| 3 / 6 | 0 | (all verified clean; backend correctness + E2E) |

### By category
| Category | IDs |
|---|---|
| FE-error (fake-success / non-functional) | PH4-01, PH4-04, PH4-05 |
| Config / prod-hardening | PH1-03, PH1-05, PH1-08, PH2-03 |
| Auth (enumeration / session / throttle) | PH1-01, PH1-02, PH1-04, PH1-07 |
| Money-integrity (defense-in-depth) | PH2-01, PH1-06 |
| Injection | PH2-02 |
| API-contract / State-machine | PH4-03 |
| FE-design (mock-vs-live) | PH4-02 |
| Dead-code | PH5-01, PH7-01 |

---

## 2. TOP FIXES BEFORE LAUNCH (ranked)

No CRITICAL/HIGH exist, so nothing *blocks* on a security-catastrophe basis. The ranked must-fix
list below is ordered by **launch impact** (a faked core feature is a launch-stopper even at MEDIUM):

| # | ID | Sev | What | One-line fix direction |
|---|---|---|---|---|
| 1 | **PH4-04** | MED | **Campaign creation is entirely mock** — fakes "Campaign Created!", persists nothing, mock group labels | Add `campaignsService.create` → `POST /campaigns/mine/create/` (endpoint exists); load real `/group-labels/`; surface 201 slug + both 400 shapes |
| 2 | **PH4-05** | MED | **Password-reset is a no-op stub** — fakes success end-to-end; locked-out users stay locked, silently | Uncomment/wire `auth.service` `requestPasswordReset`/`confirmPasswordReset` to the live `/auth/password-reset/{request,confirm}/` |
| 3 | **PH4-01** | MED | Super "Approve Payout" is a dead button that fakes success on a money surface (no backend call; web no-op) | Remove the Approve affordance from super Withdrawals (approval is a treasurer-only wired action); never local-optimistic on money |
| 4 | **PH2-01** | MED | Payment callbacks (donation/B2C/subscription) are unauthenticated — a leaked correlation id alone can drive PAID/credit | Add a Safaricom source-IP allowlist and/or a secret path segment on the 3 callback views |
| 5 | **PH1-05** | MED | Prod rate-limiting is per-process (no shared cache) + IP=REMOTE_ADDR — every throttle + portal IP-binding collapses behind a proxy | Add Redis cache + `RATELIMIT_USE_CACHE` in production; derive client IP from a trusted XFF |
| 6 | **PH2-02** | MED | HTML/content injection in transactional emails (unescaped f-strings: campaign_title, donor_name, church_name, reason) | `html.escape(...)` all interpolated user data in `integrations/resend_email.py` |
| 7 | **PH1-03** | MED | Audit-log immutability in prod depends on a MANUAL REVOKE not carried by any migration (fresh DBs start mutable) | Ship the REVOKE as a migration (RunSQL) or a startup gate that fails if privileges aren't revoked |
| 8 | **PH4-03** | MED | Admin-granted paid tier (null expiry) shows to the treasurer as "FREE / Upgrade plan" (FE↔BE mismatch) | Treat `paid tier + null expiry` as a permanent paid state in `deriveSubscriptionState` (suppress Upgrade CTA), or set a sentinel expiry on grants |
| 9 | **PH1-06** | MED | Donation `initiate` has no per-IP throttle → STK-push spam/cost to arbitrary phones | Add `@ratelimit(key='ip', …)` (mirror request-otp's dual key) |
| 10 | **PH1-02** | MED | request-otp enumeration via timing (synchronous SMS on the known path; ~2.5 s delta) | Move SMS send off the request path (async) so both paths return identically |

**Production-hardening cluster (LOW — do as a batch on the launch checklist):**
PH2-03 (HSTS / SSL-redirect / secure cookies / SECURE_PROXY_SSL_HEADER), PH1-07 (per-account login
throttle/lockout), PH1-08 (throttle register + refresh), PH1-01 (shorten access-token lifetime so
logout/rotation closes the stateless window), PH1-04 (password-reset request timing — same async fix
as PH1-02). PH4-02 (LOW): replace the hardcoded landing hero stats ("KES 4.2M / 138 / 47") with a
real public aggregate or non-numeric copy — a trust mismatch on a "transparency" homepage.

---

## 3. ALL FINDINGS (by severity)

### MEDIUM (10)
- **PH1-02** — request-otp enumeration via timing side-channel (synchronous SMS on known path).
- **PH1-03** — audit-log prod immutability depends on a manual, non-migration REVOKE.
- **PH1-05** — prod rate-limiting per-process + REMOTE_ADDR-only IP (throttles + portal IP-binding collapse behind a proxy).
- **PH1-06** — donation initiate has no per-IP throttle → STK-push spam to arbitrary phones.
- **PH2-01** — payment callbacks (donation/B2C/subscription) are unauthenticated (no Safaricom-IP allowlist / shared secret).
- **PH2-02** — HTML/content injection in transactional emails (unescaped f-string interpolation of user data).
- **PH4-01** — super-admin Withdrawals "Approve Payout" is a dead button that FAKES success on a money surface.
- **PH4-03** — admin-granted paid tier (null expiry) shown as "FREE / Upgrade plan" to the treasurer (FE↔BE mismatch).
- **PH4-04** — campaign creation is entirely mock: fakes "Campaign Created!", persists nothing, mock group labels.
- **PH4-05** — password-reset flow is a no-op stub that fakes success end-to-end.

### LOW (6)
- **PH1-01** — logout does not invalidate the access token (60-min stateless window).
- **PH1-04** — password-reset/request enumeration via timing (synchronous email send on known path).
- **PH1-07** — no per-account login throttle (distributed brute-force / credential stuffing).
- **PH1-08** — no rate limit on register and token/refresh (and no per-IP companion on verify-otp).
- **PH2-03** — production transport hardening not configured (HSTS / SSL redirect / secure cookies).
- **PH4-02** — public landing hero stats are hardcoded, not live (mock-vs-live on a "transparency" homepage).

### INFO (2)
- **PH5-01** — dead `donationsService.listForCampaign` returns mock; its commented endpoint doesn't exist.
- **PH7-01** — Unused Inventory (see Appendix A).

---

## 4. WHAT WAS VERIFIED CLEAN (coverage, not just problems)

The following were actively attacked/exercised and **held** — recorded as `[PHx-VERIFIED]` blocks in
FINDINGS.md, with live repro scripts:

**Auth / AuthZ (Phase 1):**
- JWT: alg=none forgery, tampered payload, expired token all → 401; signed `role=SUPER_ADMIN`
  claim-injection still 403 (perms read the DB, not JWT claims); refresh ROTATION + old-refresh replay
  blocked; logout authZ scoped to the caller.
- Cross-tenant IDOR sweep (treasurer A → church B objects) and full `/super/` matrix via a treasurer
  token → every door 403; anon → 401; all list views church-scoped server-side (no leak).
- Mass assignment: every privileged/server-managed field (status, subscription_tier, official_email,
  raised/wallet, church ownership, withdrawal status) is read-only or forced server-side.
- Portal OTP/token: OTP SHA-256-hashed, 5-attempt cap, per-phone+per-IP throttle; portal token
  IP-binding / 30-min TTL / revocation / campaign-scope / header-isolation all fail-closed.
- Audit actor integrity (all 35 create-sites set actor server-side; no forged-actor vector);
  coverage of money/permission actions confirmed + a live audit write.
- Password-reset CONFIRM flow: single-use, expiry, per-user OTP lookup (no cross-account hijack),
  refresh-revocation on reset.

**Money / Injection / Config (Phase 2):**
- Money exactly-once: STK replay credits NET once; B2C replay decrements once; resolve-paid double-fire
  guarded; callback-confirmed amount authoritative (client amount ignored); boundary amounts → 400
  pre-dispatch; Net-Everywhere leak-free on public surfaces.
- No SQL injection surface (ORM-only; zero `.raw`/`.extra`/string-built SQL); no FE HTML sink
  (no `dangerouslySetInnerHTML`/WebView/innerHTML — stored markup renders as literal text); campaign
  description bleach-sanitized.
- URL fields reject `javascript:`/`data:`; arbitrary http(s) accepted but NEVER server-fetched (no SSRF);
  no upload surface. DEBUG off in prod; SECRET_KEY from env; .env untracked; CORS explicit (no wildcard).

**Backend correctness (Phase 3):** suite **406/406**; endpoint status/shape matrix; serializer leak
sweep (every read surface allowlist-only); state machines **51/51** (every illegal transition rejected);
management commands **24/24** (sweep + subscription reminders/lapse, correct emission + idempotent
re-run); migrations clean (`makemigrations --check` = no changes; fresh-DB apply).

**FE↔BE contracts (Phase 5):** every service endpoint maps 1:1 to a real backend URL+verb; mappers
explicit per-field, NET-everywhere, money-string→Number, structural allowlist (sensitive fields absent
from Backend* interfaces); pagination shape matches; Bearer-vs-Portal credential split is clean (only
treasurer-portal uses the bare `portalClient`); 401 refresh-retry/forced-logout discrimination robust.

**Frontend (Phase 4):** every screen across anon / treasurer / super / OTP-portal — 0 uncaught JS
errors (only benign RN-web deprecation warnings + self-healing hard-reload 401); NET everywhere; phone
masking; injection inert in UI; graceful loading/empty/error states (forced via route-abort + bad slug);
both backend 400 shapes handled in the donation form; responsive at 375 & 1280 (no overflow); ZERO
duplicate-key warnings.

**E2E (Phase 6, clean ledger, 27/27):** registration→approval→donation NET-credit(once)→portal
disbursement(lock-then-call)→approve→B2C→PAID(wallet −once)→idempotent replays; one-pending-per-campaign
guard; resolve-paid double-fire (PAID once / 2nd→400); suspend/reactivate+audit; billing fee
forward-only (existing net unchanged); set-tier+audit. Satisfies the deferred 3.4 money-recompute.

---

## 5. APPENDIX A — UNUSED INVENTORY (PH7-01, triage list)

**Frontend dead components**
- `components/disbursement/DisbursementRequestForm.tsx` — 13-line empty `<View/>` stub; 0 importers.
- `components/campaign/CampaignCreationForm.tsx` — 0 importers (new.tsx uses an inline form).

**Frontend dead service method**
- `donationsService.listForCampaign` — no caller; returns `mockDonations`; commented endpoint doesn't exist.

**Orphaned mock files (0 consumers anywhere)**
- `mock/auditlog.mock.ts`, `mock/notifications.mock.ts`.

**Mocks alive only via mock/stub code (orphan once linked finding is fixed)**
- `mock/groups.mock.ts` (campaign-create PH4-04), `mock/donations.mock.ts` (dead listForCampaign PH5-01),
  `mockTreasurerProfile` (OTP-portal greeting, cosmetic).

**Test-only fixtures (INTENTIONAL — keep; back the 60-test vitest suite)**
- `mock/campaigns.mock.ts`, `mock/churches.mock.ts`, `mock/withdrawals.mock.ts`, parts of `mock/treasurer.mock.ts`.

**Unused dependency**
- `dayjs` (declared, imported by 0 source files).

**Backend**
- `GET /campaigns/<slug>/updates/` (CampaignUpdatesView) — routed, no FE caller.
- `set_subscription_expiry` management command — no test/cron/doc reference (confirm still needed).
- `cleanup_synthetic_withdrawals` — guarded DEV-only cleanup tool (keep out of prod).

**Recommended CI additions (not run offline here):** `depcheck` (FE unused deps), `pip-audit` / `npm audit`
(CVE pass — current deps were not obviously stale as committed).

---

## 6. METHOD & SAFETY NOTES
- All mutation against disposable `pamoja_audit` (dropped at audit end). `pamoja_dev` read-only / untouched.
- No real money, no real SMS, no prod traffic; Daraja STK/B2C money legs exercised via forged callbacks on
  prepared rows (the real STK-initiate + B2C-dispatch were separately proven live on sandbox in Phase 2/3).
- Repro scripts: `AUDIT/scripts/{p1_*,p2_*,p3_*,p6_e2e}.py` + `seed_audit.py` + `_authlib.py`.
- 18 findings, 0 CRITICAL / 0 HIGH. The money-safety invariants (exactly-once, NET, forward-only,
  lock-then-call, idempotent callbacks) and the tenant-isolation/permission model are solid; remediation
  is concentrated in wiring three faked FE features and a production-settings hardening pass.
