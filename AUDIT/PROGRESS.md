# PamojaHub Audit — PROGRESS

> Resumable checklist. Mark `[ ]`→`[x]` as each sub-task finishes, with a one-line note.
> Phases run IN ORDER. Within a phase, top-to-bottom. "RESUME HERE" at the bottom always
> points at the next action.

Session log:
- Session 1 (2026-06-24): Phase 0-2 complete; Phase 3 partial.
- Session 2 (2026-06-25): Phase 3 COMPLETE (3.2/3.5/3.6 done, all verified clean); Phase 4 substantially done (anon + ALL treasurer visible screens + ALL super screens; 3 findings). **14 findings total: 0 CRIT, 0 HIGH, 8 MED, 6 LOW.**
- Session 3 (2026-06-25): Phases 4,5,6,7,8 ALL COMPLETE → **AUDIT COMPLETE**. +4 findings (PH4-04, PH4-05, PH5-01, PH7-01). pamoja_audit reset+reseeded for Phase 6 (p6_e2e.py 27/27), then DROPPED. **18 findings total: 0 CRIT, 0 HIGH, 10 MED, 6 LOW, 2 INFO.** Deliverable: AUDIT/REPORT.md.

---

## PHASE 0 — INVENTORY & SETUP  ✅ COMPLETE
- [x] 0.1 AUDIT/ files created (INVENTORY.md, PROGRESS.md, FINDINGS.md, scripts/)
- [x] 0.2 Frontend inventory → INVENTORY.md §A (routes, components, services table, mappers, mock usage)
- [x] 0.3 Backend inventory → INVENTORY.md §B (apps, models+enums, serializers, views+perms, commands, throttle posture, config)
- [x] 0.4 API surface contract table → INVENTORY.md §C
- [x] 0.5 Server boots. DJANGO_SETTINGS_MODULE=config.settings.development. pamoja_audit created+migrated+seeded; audit server on :8009.
- [x] 0.6 Phase 0 complete.

### SETUP FACTS (for all later phases)
- **Audit server:** `DATABASE_URL=postgresql://pamoja_app:admin@localhost:5432/pamoja_audit DJANGO_SETTINGS_MODULE=config.settings.development ./venv/Scripts/python.exe manage.py runserver 127.0.0.1:8009 --noreload` (run from backend/). Log: AUDIT/scripts/audit_server.log.
- **Dev server (pamoja_dev) already runs on :8000 — DO NOT TOUCH.** Audit work uses :8009 only.
- **Re-seed:** `DATABASE_URL=...pamoja_audit PYTHONIOENCODING=utf-8 ./venv/Scripts/python.exe ../AUDIT/scripts/seed_audit.py` (idempotent; refuses any DB != pamoja_audit).
- **Reset audit DB:** drop+recreate `pamoja_audit` (owner pamoja_app, CREATEDB), migrate, re-seed.
- **psql:** `/c/Program Files/PostgreSQL/18/bin/psql` ; `export PGPASSWORD=admin; psql -U pamoja_app -h localhost -d pamoja_audit`
- **Password for ALL seeded accounts:** `AuditPass!234`

### SEEDED ACTORS (pamoja_audit)
- SUPER ADMIN: super@audit.test (id 4e460129-03d7-4980-b587-08cc2c5f3e2f)
- TREASURER A: treasurerA@audit.test (id 9c2427d3-…ccf9f) — church A
- TREASURER B: treasurerB@audit.test (id ea12df64-…3996) — church B
- Church A "Audit Alpha Church" id 5dcbc55b-3213-4173-9f80-c2ff77b88fb9 (GROWTH, ACTIVE)
  - campaign alpha-build id 0ed12d18-8abe-4b59-bcdf-318409d4328d (raised 975, wallet 975)
  - donation b937a313-… (1000 gross / 25 fee / 975 net, SUCCESSFUL)
  - withdrawal d5575a41-… (500, PENDING_APPROVAL)
  - campaign-treasurer phone 254712000001
- Church B "Audit Beta Church" id 1a057a80-a95f-49f7-a182-04aac78f2b80 (FREE, ACTIVE)
  - campaign beta-outreach id 576a1e39-0997-48e5-b3fd-41cef8d318e2 (raised 1950, wallet 1950)
  - donation dc71d807-… (2000 / 50 / 1950, SUCCESSFUL)
  - withdrawal 55aa93d1-… (700, PENDING_APPROVAL)
  - campaign-treasurer phone 254712000002

### EARLY OBSERVATION (verify in later phase, not yet a finding)
- Public /campaigns/ pagination shape = DRF default `{count,next,previous,results}` (NOT the D5 `{items,total,truncated}` — that's super lists only). FE PaginatedResponse type must match `{count,results}`. [Phase 5.1]

## PHASE 1 — SECURITY: AUTH & AUTHZ  ✅ COMPLETE
- [x] 1.1 JWT — VERIFIED CLEAN + PH1-01 (LOW: logout doesn't invalidate 60-min access token). alg=none/tamper/expired→401; claim-injection→DB role wins (403); refresh rotation+replay block holds.
- [x] 1.2 Privilege escalation + IDOR — VERIFIED CLEAN. All cross-tenant→403, all /super/ via treasurer→403, anon→401, list views church-scoped (no leak).
- [x] 1.3 Mass assignment — VERIFIED CLEAN. Privileged fields read-only; cross-tenant parent_label→400; church override ignored.
- [x] 1.4 Portal OTP — PH1-02 (MEDIUM: request-otp timing-enumeration oracle, 2.5s delta from synchronous SMS on known path). Hashing/IP-binding/TTL/revocation/scope/attempt-cap/header-isolation all clean.
- [x] 1.5 Audit-log — PH1-03 (MEDIUM: prod immutability is manual non-migration REVOKE; dev enforced, fresh DBs not). No forged-actor vector; coverage confirmed; live write verified.
- [x] 1.6 Password reset — PH1-04 (LOW: reset-request timing enumeration, same root as PH1-02). Single-use/expiry/per-user-lookup(no hijack)/refresh-revocation all clean.
- [x] 1.7 Rate limits — PH1-05 (MED: prod per-process cache + REMOTE_ADDR-only undermines all throttles + portal IP-binding), PH1-06 (MED: donation initiate no per-IP → STK spam), PH1-07 (LOW: no per-account login throttle), PH1-08 (LOW: register/refresh unthrottled). Present throttles enumerated + verified.

## PHASE 2 — SECURITY: MONEY, INJECTION, CONFIG  ✅ COMPLETE
- [x] 2.1 Money integrity — VERIFIED CLEAN (PH2-VERIFIED) + PH2-01 (MED callback auth). Replay→credit/decrement once; NET not gross; callback-amount authoritative; boundaries→400; Net-Everywhere no leak. Script p2_money.py.
- [x] 2.2 Injection/XSS — PH2-02 (MED: HTML-injection in transactional emails via unescaped f-strings, campaign_title→donor emails). No SQLi (ORM-only); no FE HTML sink; description bleach-sanitized. Script p2_injection.py.
- [x] 2.3 File/URL — VERIFIED CLEAN. javascript:/data: rejected; arbitrary http(s) accepted but never server-fetched (no SSRF); no upload surface. (LOW/INFO: image-host allowlist for D-in-D.)
- [x] 2.4 AllowAny abuse — covered by PH1-02/PH1-06/PH2-01; donation status UUID-keyed low-sens; public lists leak-free.
- [x] 2.5 Config/transport — PH2-03 (LOW prod transport headers). DEBUG off in prod; .env gitignored/untracked; CORS explicit; CSRF N/A (JWT API); 500 generic in prod.
- [x] 2.6 Deps — current as committed (Django 5.2.14, DRF 3.17.1, urllib3 2.7, pillow 12.2.0); no stale security pkg. Recommend pip-audit/npm audit in CI.

## PHASE 3 — BACKEND CORRECTNESS  ✅ COMPLETE (3.4 full-recompute deferred to post-Phase-6 reseed)
- [x] 3.1 Suite = **406/406 PASS** (test_pamoja_audit, 400.8s). Matches baseline. Log: AUDIT/scripts/p3_suite.log.
- [x] 3.2 Every endpoint: happy + error + boundary — **VERIFIED CLEAN** (PH3-VERIFIED). Script p3_endpoints.py: happy 200/201 + correct shapes, 404 unknown, 400 missing-required, 405 wrong-method across every contract row. **Pagination wire shape RESOLVED: ALL lists (incl /super/) emit DRF `{count,next,previous,results}`; the "D5 {items,total,truncated}" is an FE-internal adapter in superadmin.service.ts — no drift** (closes the Phase-0 EARLY OBSERVATION).
- [x] 3.3 Serializer leak tests — ALL CLEAN (public/super/treasurer surfaces; donation status gross-only). Script p3_leak.py.
- [~] 3.4 Money invariants — exactly-once+NET proven in 2.1; CheckConstraints present. Full recompute deferred until after Phase-6 re-seed (live DB has ORM-injected test rows).
- [x] 3.5 State machines (campaign/withdrawal/subscription) illegal transitions — **51/51 PASS, VERIFIED CLEAN** (PH3-VERIFIED). Script p3_state.py. Every illegal action → 400/409 + status unchanged; resolve-paid/retry 400 confirmed as status-guard (not validation).
- [x] 3.6 Management commands / crons — **24/24 PASS, VERIFIED CLEAN** (PH3-VERIFIED). Script p3_36.py runs real call_command. sweep escalates 2 (fresh/clean untouched) + idempotent re-run=0; process_subscriptions 7D/1D/GRACE reminders + grace-lapse→FREE + idempotent re-run=0.
- [x] 3.7 Migration integrity — makemigrations --check = "No changes detected"; fresh-DB apply verified (0.5).

## PHASE 4 — FRONTEND AUDIT (Playwright)  ✅ COMPLETE (session 3: all remaining screens/forms/states; 2 new findings PH4-04, PH4-05)
Harness LIVE: web :8081 started with `CI=1 EXPO_PUBLIC_API_URL=http://localhost:8009/api/v1 npx expo start --web --port 8081` (from frontend/; MUST set EXPO_PUBLIC_API_URL or the FE defaults to :8000/pamoja_dev — verified it hits :8009). Playwright profile is PERSISTENT → clear localStorage/sessionStorage between actors (stale tokens cause a dead-token `/`→`/login` redirect that is NOT a bug). UI login throttle is 5/15m per IP — space out logins. Expo-web HARD deep-link to a nested tab resets to the group index → reach tabs by CLICKING (tabs stay mounted = DOM accumulates; use browser_evaluate slices to read the active panel).
- [x] 4.1 Console errors — ALL screens now: anon (landing/campaigns/OTP-portal/churches-browse/churches-detail/register/reset), treasurer (overview/payouts/reports/settings/campaigns-list/[slug]/groups/notifications), super (ALL 7 visible + hidden Campaigns). Clean except benign RN-web `shadow*`/`pointerEvents` deprecations + self-healing hard-reload 401 (INFO).
- [x] 4.2 States — Queue EMPTY verified; route-abort `**/campaigns/**` → public browse "Couldn't load… / Try again" (graceful); unknown slug → "Campaign not found"; loading spinners present.
- [x] 4.3 Forms — donation form BOTH-400-shapes handled in code (field-keyed→inline, detail→failed; +502/+429; success only on poll verdict); register required-validation; payout reject min-5-char; settings PATCH REAL (`PATCH /churches/me/ 200`); campaign-create=PH4-04 mock; password-reset=PH4-05 stub.
- [x] 4.4 Data correctness — NET everywhere; phone masking; injection inert (campaign title/donor name/group name all render literal); no public/treasurer leaks; super platform-wide scoping correct.
- [x] 4.5 Design/UX + mock-vs-live — PH4-02 (hardcoded landing hero, re-confirmed at 1280px), PH4-03 (admin-granted tier FREE), PH4-04 (campaign-create mock+mockGroupLabels), PH4-05 (password-reset stub). Honest "coming soon" CSV/PDF + chart placeholders (not findings).
- [x] 4.6 Cross-cutting — 401-refresh self-heal re-confirmed; portal-401 re-auth code-verified (bare portalClient + handlePortalAuthLost chokepoint→phone re-entry); responsive 375+1280 no overflow; ZERO duplicate-key warnings.
**Phase-4 findings: PH4-01 (MED — super Approve-Payout fake-success dead button), PH4-02 (LOW — hardcoded hero), PH4-03 (MED — admin-granted tier shown FREE), PH4-04 (MED — campaign-create entirely mock/fakes success), PH4-05 (MED — password-reset no-op stub fakes success end-to-end).**

## PHASE 5 — FE↔BE INTEGRATION / CONTRACTS  ✅ COMPLETE (session 3; clean except PH5-01 INFO + the already-logged PH4-04/PH4-05 FE gaps)
- [x] 5.1 Each services/*.ts method: request+response+mapper+pagination — every endpoint maps 1:1 to a real backend URL+verb; mappers explicit per-field, money string→Number (billing kept string), NET-everywhere, allowlist structural; `PaginatedResponse{count,results}` matches DRF wire (D5 is FE-internal adapter — no drift).
- [x] 5.2 Auth header correctness — only treasurer-portal uses bare `portalClient` + `Authorization: Portal`; all 10 others use JWT `api` (Bearer). No cross-path leak (Phase-1.4 live-confirmed isolation).
- [x] 5.3 Error mapping — api.ts 401 single-flight rotation-aware refresh-retry-once + loop-guard + forceLogout-only-on-definitive-auth-failure (network blip keeps session); screens map both-400-shapes/404/429/500/timeout to non-blank failure copy (live forced ERR_FAILED + 404 confirmed).
- [x] 5.4 Contract drift — only the logged FE gaps (PH4-04 no campaignsService.create; PH4-05 password-reset stubs) + PH5-01 dead listForCampaign (commented endpoint doesn't exist). No wrong-shape/wrong-verb call.

## PHASE 6 — FULL SCENARIO / E2E  ✅ COMPLETE (DB reset+reseed first; p6_e2e.py 27/27 PASS; clears deferred 3.4)
- [x] 6.1 Reg→approve→donation NET credit (once)→portal disbursement (lock-then-call, wallet unchanged)→approve→B2C→PAID→wallet −once (+replay idempotent). One-pending-per-campaign guard verified.
- [x] 6.2 Subscription set-tier flip + audit (full lifecycle proven Ph3.5/3.6 + slices).
- [x] 6.3 Portal request-disbursement via real Authorization: Portal token (create+guard+happy); OTP→token→auth-loss proven Ph1.4.
- [x] 6.4 Suspend/reactivate (+audit); billing fee PATCH FORWARD-ONLY (existing net unchanged); set-tier (+audit).
- [x] 6.5 Money double-fire: resolve-paid PAID-once + 2nd→400; STK replay credit-once; B2C replay decrement-once.

## PHASE 7 — DEAD / UNUSED CODE  ✅ COMPLETE (PH7-01 Unused Inventory — INFO)
- [x] 7.1 Dead components: DisbursementRequestForm.tsx (empty <View/> stub, 0 imports), CampaignCreationForm.tsx (0 imports — new.tsx inline); dead method donationsService.listForCampaign.
- [x] 7.2 Orphaned mocks: auditlog.mock.ts + notifications.mock.ts (0 consumers); groups/donations/mockTreasurerProfile alive only via mock/stub code; campaigns/churches/withdrawals/treasurer = test fixtures (keep).
- [x] 7.3 Dead/unused endpoints: GET /campaigns/<slug>/updates/ (no FE caller); set_subscription_expiry command (no test/cron/doc ref).
- [x] 7.4 Unused dep: dayjs (0 source imports). Full depcheck/pip-audit recommended in CI.
- [x] 7.5 Known-dead component (empty DisbursementRequestForm) confirmed; consolidated into PH7-01.

## PHASE 8 — SYNTHESIS → REPORT.md  ✅ COMPLETE
- [x] 8.1 AUDIT/REPORT.md written (findings by severity + category).
- [x] 8.2 Counts table (per severity: 0C/0H/10M/6L/2I=18; per phase).
- [x] 8.3 TOP FIXES BEFORE LAUNCH (ranked 1–10 + LOW prod-hardening cluster).
- [x] 8.4 "What was verified clean" coverage section.
- [x] 8.5 Unused Inventory appendix (Appendix A).
- [x] 8.6 **pamoja_audit DROPPED** (pamoja_dev verified intact); audit server stopped. PROGRESS marked COMPLETE.

# ✅ AUDIT COMPLETE (all phases 0–8). 18 findings: 0 CRITICAL, 0 HIGH, 10 MEDIUM, 6 LOW, 2 INFO. Deliverable: AUDIT/REPORT.md.

---

RESUME HERE: **NOTHING — AUDIT COMPLETE.** All phases 0–8 done. Deliverable = AUDIT/REPORT.md (18 findings: 0 CRIT, 0 HIGH, 10 MED, 6 LOW, 2 INFO). pamoja_audit DROPPED (pamoja_dev intact); the audit :8009 server is stopped. If re-opening: the only remaining optional item is a CI dep/CVE scan (depcheck/pip-audit/npm audit), which the report recommends but was not run offline. To re-run any repro: recreate pamoja_audit (drop+create+migrate+`seed_audit.py`), start the :8009 server, run AUDIT/scripts/{p1_*,p2_*,p3_*,p6_e2e}.py.
SERVER GOTCHA (suite): a killed `manage.py test` strands test_pamoja_audit + lock blocks re-runs — terminate+drop (psql pg_terminate_backend + DROP DATABASE) then re-run --noinput. Use DATABASE_URL=...pamoja_audit (test DB = test_pamoja_audit, avoids :8000's test_pamoja_dev).

### SESSION CHECKPOINT (end of session 2 — 2026-06-25)
- DONE this session: Phase 3 COMPLETE — 3.5 state machines (p3_state.py 51/51), 3.6 mgmt commands (p3_36.py 24/24), 3.2 endpoint matrix (p3_endpoints.py; pagination-shape question RESOLVED, no drift). All three verified CLEAN. Then Phase 4 SUBSTANTIALLY DONE via Playwright — anon (landing/campaigns/OTP-portal), treasurer A (overview/payouts/reports/settings), super (ALL 7: queue/churches/withdrawals/analytics/billing/donations/audit-log), login routing both actors, 401-refresh hard-load path, OTP-portal form validation. **3 new findings: PH4-01 (MEDIUM) super Withdrawals Approve-Payout dead/fake-success button; PH4-02 (LOW) hardcoded landing hero stats; PH4-03 (MEDIUM) admin-granted paid tier (null expiry) shown to treasurer as FREE+Upgrade.**
- **FINDINGS NOW 14: 0 CRITICAL, 0 HIGH, 8 MEDIUM, 6 LOW.** MEDIUMs: PH1-02, PH1-03, PH1-05, PH1-06, PH2-01, PH2-02, PH4-01, PH4-03. LOWs: PH1-01, PH1-04, PH1-07, PH1-08, PH2-03, PH4-02.
- NEW scripts this session (AUDIT/scripts/): p3_state.py, p3_36.py, p3_endpoints.py.
- SERVERS (both backgrounded this session; may not survive into next session — restart if down):
  - Audit API :8009 — `DATABASE_URL=postgresql://pamoja_app:admin@localhost:5432/pamoja_audit DJANGO_SETTINGS_MODULE=config.settings.development PYTHONIOENCODING=utf-8 ./venv/Scripts/python.exe manage.py runserver 127.0.0.1:8009 --noreload` (from backend/).
  - Expo web :8081 — `CI=1 EXPO_PUBLIC_API_URL=http://localhost:8009/api/v1 npx expo start --web --port 8081` (from frontend/). **MUST set EXPO_PUBLIC_API_URL** else FE → :8000/pamoja_dev (forbidden).
- pamoja_audit state: Phase-3 scripts cleaned up their own injected rows (sm-camp-*, SM-STATE, SWEEP36, sub36-*). Residual Ph1-2 artifacts remain (massassign-test/xss-test campaigns, AUDIT-* donations, beta withdrawal PAID, alpha raised inflated ~11700) — harmless for Phase 4/5; **MUST drop+recreate+migrate+re-seed before Phase 6 count-sensitive E2E.** NOT mid-mutation → pamoja_audit left intact for Phase 5.
- Playwright profile is PERSISTENT — clear localStorage/sessionStorage when switching actors (stale tokens trigger a dead-token `/`→`/login` that is NOT a bug). UI login throttle 5/15m per IP.

### SESSION CHECKPOINT (end of session 1 — 2026-06-24)
- DONE: Phase 0 (inventory + pamoja_audit seeded + server), Phase 1 (7/7), Phase 2 (6/6), Phase 3 PARTIAL (3.1 suite 406/406 green, 3.3 leak sweep clean, 3.7 migrations clean; 3.2/3.4-full/3.5/3.6 remain). **11 findings: 0 CRITICAL, 0 HIGH, 6 MEDIUM, 5 LOW** (Phase 3 so far all verified-clean, no new findings). MEDIUMs: PH1-02 timing-enum, PH1-03 audit REVOKE manual, PH1-05 prod ratelimit cache/IP, PH1-06 STK spam, PH2-01 callback auth, PH2-02 email HTML-injection. The security core (JWT, IDOR, mass-assign, portal token, audit actor, money exactly-once/NET, no-SQLi) is genuinely strong; findings cluster around (a) timing-enum from synchronous external sends, (b) production-settings hardening, (c) unauthenticated Daraja callbacks, (d) HTML email escaping.
- ENVIRONMENT for next session:
  - Restart audit server if not running: from backend/ run `DATABASE_URL=postgresql://pamoja_app:admin@localhost:5432/pamoja_audit DJANGO_SETTINGS_MODULE=config.settings.development PYTHONIOENCODING=utf-8 ./venv/Scripts/python.exe manage.py runserver 127.0.0.1:8009 --noreload` (background). Dev server on :8000 = pamoja_dev, do not touch.
  - Token cache helper: AUDIT/scripts/_authlib.py (get_tokens() — logins cached to TEMP/claude/j--Pamoja-Hub/audit_tokens.json; refresh with force=True; respects login 5/15m budget).
  - pamoja_audit carries Phase-1 test artifacts (extra campaign "massassign-test" + group labels on church A). **Before Phase 6 count-sensitive E2E, reset: drop+recreate pamoja_audit, migrate, re-run seed_audit.py.** For Phase 2 the artifacts are harmless.
  - Phase-2 reading targets already located: withdrawals/services.py (finalize_withdrawal_paid, record_dispatch_failure, lock-then-call), withdrawals/views.py (approve/reject/retry + B2CResultCallbackView L633), donations/views.py (initiate/callback/status, idempotency on checkout_request_id), donations/services.py (credit-on-callback).
- Scripts written this session (all under AUDIT/scripts/): seed_audit.py, _authlib.py, p1_jwt.py, p1_idor.py, p1_massassign.py, p1_portal.py, p1_audit.py, p1_reset.py, p2_money.py, p2_injection.py.
- pamoja_audit MUTATED by Phase 1-2 (extra campaigns massassign-test/xss-test, group labels, donations AUDIT-*, beta withdrawal PAID, alpha raised inflated ~11700). Harmless for Phase 3 (which uses its own throwaway test DB). **MUST drop+recreate+migrate+re-seed pamoja_audit before Phase 6 count-sensitive E2E.**
