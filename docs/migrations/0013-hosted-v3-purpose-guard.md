# Migration 0013: hosted v3 purpose guard

File: `drizzle/0013_hosted_v3_purpose_guard.sql`. Adds the validated CHECK `identity_consents_hosted_v3_purpose_ck`
(`policy_version <> 'identity-provider-subject-consent-v3' OR consent_purpose IS NOT DISTINCT FROM 'hosted-avatar-consent'`),
exactly as declared in `db/schema.js`. Additive only: no column, data, or other constraint changes. Supersedes
`docs/hosted-v3-purpose-guard.proposed.sql`.

**Status: NOT applied to production.** Applying it needs a separate owner go-ahead.

## Pre-apply read-only check (run immediately before applying; expect 0)

```sql
SELECT count(*) AS incompatible_v3_rows
FROM public.identity_consents
WHERE policy_version = 'identity-provider-subject-consent-v3'
  AND consent_purpose IS DISTINCT FROM 'hosted-avatar-consent';
```

If the count is not 0, do not apply. The migration would fail closed anyway (`check constraint ... is violated by some row`,
no constraint left behind), but investigate those rows first.

## Lock and duration

`ADD CONSTRAINT ... CHECK` validates in one step: it takes an ACCESS EXCLUSIVE lock on `identity_consents` for a full
scan. Acceptable for this small table; apply at a quiet time.

## Rollback (no data loss)

```sql
ALTER TABLE identity_consents DROP CONSTRAINT identity_consents_hosted_v3_purpose_ck;
```

Dropping the constraint loses no data. If the migration should also be considered unapplied, remove the 0013 row from
`drizzle.__drizzle_migrations`. The only v3 writer (`db/provider-subject-consent-repository.js`) always sets the
purpose, so application code is compatible with or without the constraint.
