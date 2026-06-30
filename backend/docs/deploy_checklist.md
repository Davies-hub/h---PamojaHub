# Pamoja Hub — Production Deploy Checklist

> Companion doc: launch-gate + feature status lives in `docs/deploy_checklist_status.md`. This file is the narrow ops runbook (cron + DB REVOKE).

> Companion to `backend/docs/production_db_hardening.md` (DB REVOKE step). This file
> records the **ops steps that are not migrations** and would otherwise be tribal
> knowledge. Each one is a launch blocker if skipped.

---

## 1. Stranded-withdrawal sweep cron (B2C money-safety net) — REQUIRED

### What it is
`python manage.py sweep_stranded_withdrawals` escalates **stranded B2C payouts** to
`NEEDS_RECONCILIATION`. A payout is stranded when it is older than
`B2C_SWEEP_STALENESS_MINUTES` (default **15**) and is either:

- `status = PROCESSING` (dispatched, but no terminal M-Pesa result callback arrived), or
- `status = FAILED` **and** `dispatch_outcome = AMBIGUOUS_FAILURE` (the dispatch may have
  been queued at Safaricom but was never confirmed).

The command runs **synchronously, in-process** — it does **NOT** need Celery, a worker,
beat, or Redis. The transition is locked + atomic + idempotent (re-runs and overlapping
runs are safe: an already-escalated row fails the under-lock candidate recheck and is
skipped). It does **not** move money — escalation is a status flip only; the wallet is
untouched.

### Why a missing cron line silently strands money
This sweep is the **ONLY automated path** out of `AMBIGUOUS_FAILURE` / stuck-`PROCESSING`.
`NEEDS_RECONCILIATION` is the safe freeze: it has **no** force-retry (blind re-dispatch of a
possibly-queued payout is exactly the unsafe action for these rows) — the only exits are a
Super Admin's `resolve-paid` / `resolve-retry` **after** checking the M-Pesa statement — and
escalation is what **fires the Super-Admin alert** (in-app notification + `WITHDRAWAL_NEEDS_RECONCILIATION`
audit row).

If this cron line is **absent in production**, stranded rows are never escalated: **no alert
ever fires**, the campaign stays blocked on the outstanding payout, and the money sits in
limbo unnoticed. There is no other trigger — no beat schedule, no `PeriodicTask`. **Install
this cron line or money strands silently.**

### The crontab line (every 5 minutes, PRODUCTION settings pinned)

```cron
*/5 * * * * cd /opt/pamoja/backend && DJANGO_SETTINGS_MODULE=config.settings.production /opt/pamoja/venv/bin/python manage.py sweep_stranded_withdrawals >> /var/log/pamoja/sweep_stranded_withdrawals.log 2>&1
```

- Cadence `*/5` (every 5 min) means a row that crosses the 15-min staleness threshold is
  escalated within ~5 min of becoming eligible.
- `DJANGO_SETTINGS_MODULE=config.settings.production` is **mandatory** — `manage.py` defaults
  to `config.settings.development`. The command prints its active settings module + DB name on
  startup so a misconfigured entry is visible in the log (the stale-env guard). Equivalent
  alternative: append `--settings=config.settings.production` to the command.
- Run as the **app user** (not root), the same user that owns the venv.
- Clean run exits 0 (no cron mail); an unhandled error exits non-zero (cron surfaces it).

**PLACEHOLDERS the operator MUST fill with real prod paths:**

| Placeholder | Replace with |
|---|---|
| `/opt/pamoja/backend` | the directory containing `manage.py` on the prod host |
| `/opt/pamoja/venv/bin/python` | the prod virtualenv's Python interpreter |
| `/var/log/pamoja/sweep_stranded_withdrawals.log` | a log path whose **directory exists and is writable** by the cron user |

Optional tunable: set `B2C_SWEEP_STALENESS_MINUTES` in the prod environment to override the
15-min default.

### Post-deploy verification (one line)
After installing the cron, wait up to 5 minutes, then:

```bash
tail -n 5 /var/log/pamoja/sweep_stranded_withdrawals.log
```

Confirm an entry appears showing `settings=config.settings.production | DB=<prod db>` and
`Escalated N stranded payout(s) to NEEDS_RECONCILIATION.` (N is normally **0** on a healthy
platform — the line *appearing at all*, with the correct settings/DB, proves the cron fires
correctly). If the log never appears, the cron is not running or the path/user is wrong.

---

## 2. Database hardening (AuditLog REVOKE) — REQUIRED
See `backend/docs/production_db_hardening.md`. The prod `REVOKE UPDATE/DELETE` on the
AuditLog table is **not** a migration and must be applied manually before go-live.
