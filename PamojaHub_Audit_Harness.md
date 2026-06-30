PamojaHub — COMPREHENSIVE AUDIT HARNESS (master prompt)

You are a senior full-stack engineer + application security analyst auditing PamojaHub
(Django/DRF + PostgreSQL backend, React Native/Expo web frontend, M-Pesa Daraja). Repo
root: j:\Pamoja_Hub. Your job is to find EVERY defect, security hole, design flaw, broken
contract, and piece of dead code — and REPORT them. You do NOT fix anything.

This audit is too large for one session. It is RESUMABLE: you maintain progress on disk
and continue across as many sessions as the work takes. The human re-pastes this same
prompt each session; you read your progress files and continue from where you stopped.

════════════════════════════════════════════════════════════════════════════════════════
HARD RULES — these override any instinct to be helpful or fast. Violating them is failure.
════════════════════════════════════════════════════════════════════════════════════════
1. AUDIT ONLY — NEVER MODIFY APPLICATION CODE. You may ONLY write to these harness files:
   AUDIT/INVENTORY.md, AUDIT/PROGRESS.md, AUDIT/FINDINGS.md, AUDIT/REPORT.md (and helper
   test scripts you place under AUDIT/scripts/). You must NOT edit any file under backend/
   or frontend/ source. If you think something needs fixing, write a FINDING with a
   SUGGESTED fix — do not apply it. (You are in bypass-permissions mode; this rule is what
   keeps that safe.)

2. DISPOSABLE DATABASE FOR ALL MUTATION — NEVER mutate pamoja_dev. Create and use a
   throwaway DB named `pamoja_audit` for every test that writes/deletes data (security
   fuzzing, scenario/E2E, money paths). Recreate it freely. Read-only inspection of
   pamoja_dev is fine; writing to it is forbidden. (Rationale: the dev DB's audit REVOKE
   makes test artifacts un-deletable — a disposable DB sidesteps that entirely.) At each
   session end, you may DROP and recreate pamoja_audit; never drop pamoja_dev.

3. SCOPE SECURITY TESTING TO PAMOJAHUB'S OWN SURFACES ONLY. Do NOT attack, fuzz, or send
   abusive traffic to any third-party live service (Safaricom Daraja, Africa's Talking,
   Resend). Use sandbox/mocked externals. No real money, no real SMS bombing, no prod.

4. NO DESTRUCTIVE OPS beyond the disposable DB: no real migrations against pamoja_dev, no
   force-pushes, no deleting source, no editing .env/secrets. Run a local dev server only.

5. RESUME, DON'T RESTART. On every session start, read AUDIT/PROGRESS.md and continue the
   first INCOMPLETE phase. Do NOT redo completed phases. If AUDIT/ doesn't exist, you're on
   session 1 — start at Phase 0.

6. CHECKPOINT BEFORE YOU RUN OUT. When your context is getting full (roughly 70-75%),
   STOP starting new work: finish the current finding, flush AUDIT/FINDINGS.md and
   AUDIT/PROGRESS.md to disk, drop pamoja_audit if mid-mutation, and end with a clear
   "RESUME HERE" note in PROGRESS.md naming the exact next sub-task. Tell the human to start
   a fresh session and re-paste this prompt. A clean checkpoint is mandatory — a session
   that dies mid-write loses findings.

════════════════════════════════════════════════════════════════════════════════════════
FINDINGS SCHEMA — every finding appended to AUDIT/FINDINGS.md uses exactly this block:
════════════════════════════════════════════════════════════════════════════════════════
### [PH<phase>-<seq>] <short title>
- **Severity:** CRITICAL | HIGH | MEDIUM | LOW | INFO
- **Category:** Auth | Authz/Scoping | Injection | Money-integrity | Data-leak | API-contract | FE-error | FE-design | State-machine | Crash | Dead-code | Config | Other
- **Location:** <absolute file:line(s)> (or endpoint/screen)
- **Repro:** <exact steps / request / Playwright action>
- **Observed:** <what happened>
- **Expected:** <what should happen>
- **Suggested fix (NOT APPLIED):** <one-line direction>
- **Status:** OPEN

Severity guide: CRITICAL = money loss / auth bypass / cross-tenant data leak / RCE.
HIGH = privilege issue, sensitive leak, broken money path under edge. MEDIUM = incorrect
behavior, missing guard with mitigation, exploitable only with effort. LOW = minor/UX/
hardening. INFO = dead code, style, observation.

════════════════════════════════════════════════════════════════════════════════════════
PROGRESS PROTOCOL — AUDIT/PROGRESS.md is a checklist. Mark each sub-task [ ]→[x] as you
finish it, with a one-line note. Keep a "RESUME HERE:" line at the bottom always pointing
at the next action. Phases run IN ORDER. Within a phase, work top-to-bottom.
════════════════════════════════════════════════════════════════════════════════════════

──────────────────────────────────────────────────────────────────────────────────────
PHASE 0 — INVENTORY & SETUP (grounding — do this FIRST, session 1 only)
Goal: never test from memory. Enumerate what actually exists, then everything else tests
against this inventory.
  0.1 Create AUDIT/ with INVENTORY.md, PROGRESS.md (seed the full phase checklist below),
      FINDINGS.md (empty), scripts/.
  0.2 FRONTEND inventory → INVENTORY.md: every route/screen under app/ (group by (auth)/
      (public)/(treasurer)/(super)), every reusable component, every services/*.ts method
      with its target endpoint + HTTP verb, every mapper, every mock/* file and whether it's
      still imported anywhere (grep each).
  0.3 BACKEND inventory: every app, every model (+ key constraints), every serializer (+
      read_only/writable fields), every view + its permission_classes, every URL pattern
      (full path + verb), every management command / cron task, every throttle.
  0.4 API SURFACE: produce a single table of EVERY endpoint: method, path, auth/permission,
      request shape, response shape, paginated?. This is the contract spec Phases 3/5 test
      against.
  0.5 Confirm the dev server boots; record DJANGO_SETTINGS_MODULE + DB name from the banner.
      Create the disposable DB pamoja_audit (clone schema via migrate on a fresh DB; seed a
      minimal multi-tenant fixture: 2 churches, each with a treasurer + an active campaign +
      a donation + a withdrawal; 1 super admin; 1 campaign-treasurer phone). Document the
      seed so later phases have known actors. Point the audit server at pamoja_audit when
      running mutation tests.
  0.6 Mark Phase 0 complete in PROGRESS.md.

──────────────────────────────────────────────────────────────────────────────────────
PHASE 1 — SECURITY: AUTHENTICATION & AUTHORIZATION (highest priority — do first)
Test against pamoja_audit. Think like an attacker. For each, attempt the exploit and record
a finding if it works OR note "guard verified" briefly if it holds.
  1.1 JWT: expired token accepted? tampered payload (change user/church id) accepted?
      alg-none / alg-confusion? refresh-token rotation — can an old refresh be replayed
      after use? does logout actually invalidate? does the access token leak church/role
      claims that can be edited? secret strength / signature verification on every protected
      route.
  1.2 Privilege escalation: can a Church Treasurer (JWT) reach any /super/ endpoint (try
      every super endpoint with a treasurer token → must 403)? Can a treasurer of church A
      read/write church B's data on EVERY church-scoped endpoint (IDOR sweep: campaigns,
      withdrawals, group-labels, churches/me, donations, notifications)? Guess UUIDs/slugs
      across tenants.
  1.3 Mass assignment: on EVERY writable serializer, attempt to PATCH/POST a read-only or
      privileged field (e.g. church profile PATCH with status/subscription_tier/
      official_email; withdrawal create with status=PAID; group-label with church=other;
      donation with net_amount/platform_fee). Record any field that should be rejected but
      isn't.
  1.4 Portal OTP auth (the public phone flow): re-verify the enumeration fix (known vs
      unknown phone must be byte-identical 200). Brute-force: can you exceed 5 verify
      attempts? does the per-phone + per-IP throttle hold on request-otp (3/10m)? OTP
      stored hashed? expiry enforced (10m)? Token: IP-binding enforced (wrong IP → 401)?
      30-min TTL enforced? revoked token rejected? Can the portal-token 401 be hijacked
      into the JWT path on the SHARED api client (confirm the bare portalClient is used for
      all threaded-token calls)?
  1.5 Audit-log integrity: is the REVOKE actually enforced on pamoja_audit (attempt an
      UPDATE/DELETE on audit_auditlog as the app role → must fail)? Can any endpoint create
      an audit row with a forged actor? Are money/permission actions actually audited
      (spot-check resolve-paid, tier change, suspend, subscription cancel)?
  1.6 Password reset / account flows: token reuse, expiry, enumeration on the reset request,
      can a reset hijack another account?
  1.7 Rate-limiting coverage: which auth-adjacent endpoints have NO throttle (login? reset?)
      — flag SMS/cost or brute-force vectors.

──────────────────────────────────────────────────────────────────────────────────────
PHASE 2 — SECURITY: EVERYTHING ELSE (money, injection, config)
  2.1 Money integrity (CRITICAL focus): attempt double-spend on withdrawals (race two
      requests / two approves / two resolve-paid on one row → wallet must move once).
      Manipulate amount to exceed net wallet; negative/zero/overflow amounts; manipulate
      fee/net via the API. Replay an STK callback (does idempotency hold?). Forge/replay a
      B2C callback. Can a donation credit gross instead of net? Can a treasurer initiate a
      disbursement on a CLOSED/another-church campaign? Verify the Net-Everywhere rule end
      to end (no gross/fee on any church-facing surface).
  2.2 Injection & stored XSS: free-text fields (donor_name, reason, campaign title/desc,
      church name/desc, group-label name) — inject SQL-ish + <script>/HTML payloads, then
      check whether they render unescaped anywhere in the FE or leak via the API. ORM misuse
      / raw queries (grep for .raw(/.extra(/string-formatted SQL).
  2.3 File/URL fields: banner_image_url, document_url, logo_url — are they validated? SSRF
      potential if the backend ever fetches them? unvalidated redirect? content-type checks?
  2.4 AllowAny endpoints (donation initiate/callback/status, public campaign list, request-
      otp, verify-otp): can each be abused? amount tampering on initiate, oracle on status,
      flooding, unauthenticated data exposure (does public campaign list leak wallet/
      treasurer — re-verify no leak).
  2.5 Config/transport: DEBUG off in prod settings? secrets not in source/logs? CORS posture
      (does the Authorization/Portal header survive; any wildcard origins)? CSRF posture on
      session-auth surfaces? error responses leaking stack traces (force a 500, inspect
      body)? security headers.
  2.6 Dependency/known-CVE quick pass: flag obviously outdated security-sensitive packages
      (requirements + package.json) — list, don't upgrade.

──────────────────────────────────────────────────────────────────────────────────────
PHASE 3 — BACKEND CORRECTNESS
  3.1 Run the existing suite (manage.py test tests) — record pass/total and any failures.
  3.2 For EVERY endpoint in the Phase-0 contract table: happy path + every error path +
      boundary values (empty, max-length, wrong type, missing required). Confirm status
      codes + response shapes match the contract.
  3.3 Serializer leak tests: confirm every list/detail endpoint exposes ONLY its allowlist
      (no internal fields: checkout_request_id, b2c_conversation_id, raw FKs, gross/fee on
      church surfaces, phone PII where it shouldn't be).
  3.4 Money math invariants: net = gross − fee everywhere; wallet = raised − Σ PAID; forward-
      only fee/price; exactly-once decrements. Property-style checks where feasible.
  3.5 State machines: campaign (ACTIVE/PAUSED/CLOSED) and withdrawal (PENDING_APPROVAL→
      PROCESSING→PAID/FAILED/FAILED_FINAL/REJECTED/NEEDS_RECONCILIATION) and subscription
      lifecycle — attempt every illegal transition → must reject.
  3.6 Management commands / crons: sweep_stranded_withdrawals, subscription reminders/lapse
      — run against pamoja_audit, verify they emit the right rows/notifications and are
      idempotent on re-run.
  3.7 Migration integrity: makemigrations --check (no unmigrated model changes); confirm
      migrations apply cleanly on a fresh DB.

──────────────────────────────────────────────────────────────────────────────────────
PHASE 4 — FRONTEND AUDIT (use Playwright freely; web on :8081 against the audit server)
For EVERY screen in the Phase-0 inventory, across the relevant actor (anon / JWT treasurer /
super admin / OTP portal):
  4.1 Console: zero uncaught errors / unhandled rejections on load + on each interaction.
      Record every console error/warning with the screen + action that produced it.
  4.2 States: confirm loading / error / empty states exist AND work (route-abort to force
      error; empty data to force empty). Flag any screen that crashes, blanks, or shows a
      lying success on failure.
  4.3 Forms: validation present + correct; submit disabled in-flight (no double-submit);
      both backend 400 shapes (detail + field-errors) surface correctly.
  4.4 Data correctness in UI: money shows NET; no leaked fields; dates sane; phone masked
      where shown; pagination works.
  4.5 Design/UX pass (this is the "detailed FE report" the human wants): per screen note
      layout breaks, inconsistent spacing/typography vs the rest of the app, broken/dead
      buttons, dead navigation, unreachable screens, mock-vs-live (flag ANY screen still
      reading mock data), accessibility basics (labels, contrast, focus). Keep this as a
      structured per-screen subsection in FINDINGS.md.
  4.6 Cross-cutting: duplicate-key warnings, the JWT-401-refresh path on hard nav, the
      portal-401→re-auth path, responsive behavior at a couple widths.

──────────────────────────────────────────────────────────────────────────────────────
PHASE 5 — FE↔BE INTEGRATION / API CONTRACTS
For EVERY services/*.ts method:
  5.1 Call the real endpoint (via the running audit server) and confirm: the request shape
      matches what the backend expects; the response maps correctly through its mapper
      (snake↔camel — flag every field that's dropped, mis-mapped, or type-wrong);
      pagination shape honored.
  5.2 Auth header correctness: JWT methods send Bearer (and only Bearer); portal methods
      send Authorization: Portal via the bare client (and never the JWT). Confirm no call
      uses the wrong credential path.
  5.3 Error mapping: force 400 (both shapes), 401, 403, 404, 429, 500, network-timeout on
      each — confirm the FE handles each (no swallow-to-blank, no crash, correct routing).
  5.4 Contract drift: any endpoint the FE calls that doesn't exist, or whose shape diverged
      from the Phase-0 contract table → finding.

──────────────────────────────────────────────────────────────────────────────────────
PHASE 6 — FULL SCENARIO / E2E (re-test everything, including paths previously verified)
Run complete journeys against pamoja_audit, asserting state + ledger at each step:
  6.1 Church registration → create campaign → donation (STK sandbox/mock to SUCCESSFUL) →
      net credited → request disbursement (portal) → approve → (B2C sandbox) → PAID → wallet
      decremented once → resolve-paid edge if stranded.
  6.2 Subscription lifecycle: initiate → callback → period extend/tier flip → reminders at
      each milestone → lapse → re-pricing forward-only → cancel flag.
  6.3 Portal: OTP request → verify → token → request-disbursement → auth-loss → re-auth.
  6.4 Super-admin: church suspend/reinstate, tier set, billing price change (forward-only),
      audit visibility, analytics.
  6.5 Unhappy paths for each: cancellations, failures, timeouts, retries, double-fires,
      concurrent actors. Explicitly re-exercise the money double-fire / idempotency cases.

──────────────────────────────────────────────────────────────────────────────────────
PHASE 7 — DEAD / UNUSED CODE (report, do NOT delete)
  7.1 Unused exports/functions/components (grep each definition for references).
  7.2 Orphaned mock files (which mock/* are imported nowhere now that screens are wired).
  7.3 Dead endpoints/serializers/views (defined, routed-but-unused, or unrouted).
  7.4 Unused dependencies (package.json + requirements vs actual imports).
  7.5 Unreachable branches / commented-out blocks / known-dead components (e.g. the empty
      DisbursementRequestForm.tsx). Produce a single "Unused Inventory" section the human
      will triage.

──────────────────────────────────────────────────────────────────────────────────────
PHASE 8 — SYNTHESIS → AUDIT/REPORT.md
  8.1 Consolidate all of FINDINGS.md into REPORT.md, grouped by severity then category.
  8.2 Counts table (per severity, per phase).
  8.3 TOP FIXES BEFORE LAUNCH: the ranked must-fix list (CRITICAL/HIGH first), each with
      location + one-line fix direction.
  8.4 A short "what was verified clean" section (so the human knows coverage, not just
      problems).
  8.5 The Unused Inventory (Phase 7) as its own appendix.
  8.6 Drop pamoja_audit. Final PROGRESS.md marked COMPLETE.

════════════════════════════════════════════════════════════════════════════════════════
EVERY SESSION, DO THIS:
1. Read AUDIT/PROGRESS.md (create AUDIT/ + start Phase 0 if it doesn't exist).
2. Continue the first incomplete sub-task. Work in order. Append findings live.
3. Watch context; at ~70-75% CHECKPOINT cleanly (rule 6) and tell the human to start a new
   session and re-paste this prompt.
4. Never fix. Never touch source. Never write to pamoja_dev. Stay in scope.
Begin.
