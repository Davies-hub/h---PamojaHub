# Production DB Hardening — AuditLog immutability (Phase 3, Step 3.3)

> **This is NOT a migration.** A `REVOKE` changes PostgreSQL role permissions, which
> do **not** travel inside Django migrations. It must be run **manually, once, against
> each real database** (production, staging) by a role allowed to revoke (a superuser,
> or the table owner). **Until it is run on production, the production audit log is NOT
> tamper-proof at the database level** — the only protection there is the Python
> `AuditLog.save()/delete()` guard, which does *not* catch `QuerySet.update()` /
> `QuerySet.delete()` / raw SQL.

## What it does

Revokes `UPDATE` and `DELETE` on `audit_auditlog` from the application DB role
(`pamoja_app`), so that even bypassing the Django model layer (a `QuerySet.update()`,
a `.delete()`, or a SQL-injection that reaches a write) **cannot mutate or remove an
audit record**. `INSERT` and `SELECT` are deliberately kept — the app must still append
new audit rows and read them.

## Pre-requisites

- Connect to the **production** database (not dev). Confirm the database name first.
- Run as a role with authority to revoke on the table: a **superuser**, or the
  **table owner**. (A non-superuser owner can revoke its *own* DML — this is how it was
  applied in dev; see the ownership caveat below.)
- Confirm the app role name is `pamoja_app` (or substitute the real production app role).

## The SQL — run EXACTLY these two statements, nothing broader

```sql
REVOKE UPDATE ON audit_auditlog FROM pamoja_app;
REVOKE DELETE ON audit_auditlog FROM pamoja_app;
```

Do **NOT** also run the Build Guide's `CREATE ROLE` / broad `GRANT` block — the role
already exists with the correct `INSERT`/`SELECT` grants. Do **NOT** revoke `INSERT` or
`SELECT` (the app needs both). Do **NOT** touch sequences (INSERT relies on the id
default). Do **NOT** touch any other table.

## Verification — REQUIRED (this is the proof, not optional)

Acting **as `pamoja_app`** (e.g. `SET ROLE pamoja_app;` as superuser, or connect as the
app role):

```sql
-- (a) UPDATE must be REJECTED:
UPDATE audit_auditlog SET action='TAMPERED' WHERE id = (SELECT id FROM audit_auditlog LIMIT 1);
--    expect: ERROR:  permission denied for table audit_auditlog

-- (b) DELETE must be REJECTED:
DELETE FROM audit_auditlog WHERE id = (SELECT id FROM audit_auditlog LIMIT 1);
--    expect: ERROR:  permission denied for table audit_auditlog

-- (c) INSERT must still SUCCEED (app must keep appending audits) — roll back the probe:
BEGIN;
INSERT INTO audit_auditlog (id, action, entity_type, entity_id, details, created_at)
VALUES (gen_random_uuid(), 'REVOKE_PROBE', 'Test', gen_random_uuid(), '{}', now());
ROLLBACK;          -- (the app role cannot DELETE it, so do not COMMIT the probe)
--    expect: INSERT succeeds

-- (d) SELECT must still SUCCEED:
SELECT count(*) FROM audit_auditlog;
--    expect: a count, no error
```

Quick privilege check (no row needed):
```sql
SELECT has_table_privilege('pamoja_app','audit_auditlog','SELECT')  AS sel,   -- expect t
       has_table_privilege('pamoja_app','audit_auditlog','INSERT')  AS ins,   -- expect t
       has_table_privilege('pamoja_app','audit_auditlog','UPDATE')  AS upd,   -- expect f
       has_table_privilege('pamoja_app','audit_auditlog','DELETE')  AS del;   -- expect f
```

If (a) or (b) **succeeds** (tamper not blocked), or (c)/(d) **fails** (app can't
write/read), the revoke went wrong — investigate before relying on it.

## ⚠️ Ownership caveat (important for true tamper-proofing)

In dev, `pamoja_app` **owns** `audit_auditlog` (migrations ran as that role). A
non-superuser owner *can* revoke its own DML and the table becomes read-only to it
(verified in dev: UPDATE/DELETE → permission denied) — **but the owner retains the
implicit GRANT OPTION and can re-grant `UPDATE`/`DELETE` to itself at any time**
(`GRANT UPDATE ON audit_auditlog TO pamoja_app;`). So if `pamoja_app` owns the table in
production, the REVOKE blocks accidental/compromised `QuerySet.update`/`delete` and
injection writes, but a determined actor able to run arbitrary SQL as `pamoja_app` could
re-grant.

**Recommended for production:** the audit table (ideally all tables) should be **owned by
a separate migrations/admin role**, with `pamoja_app` a non-owner holding only
`INSERT`/`SELECT` on `audit_auditlog`. Then `pamoja_app` cannot re-grant itself
write access, and immutability is hard. If you adopt that, re-run the verification as
`pamoja_app` to confirm.

## Re-run scope

The `REVOKE` lives only in the database it was run against. It is **not** in migrations,
so it does **not** reach a freshly-created database — including the **test database**
(`test_*`), which is why the test suite still has `UPDATE`/`DELETE` on its own throwaway
`audit_auditlog` and stays green. Apply this runbook to **every** real database
(production, staging) separately, and re-apply after any DB rebuild/restore that
recreates the table.
