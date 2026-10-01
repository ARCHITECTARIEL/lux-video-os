# HeyGen reconciliation foundation: operator runbook

This local tool provides read-only inspection. It does not upload media, call HeyGen, issue approvals, delete resources, or resume deletion. The deletion executor is disabled. Read the [design](HEYGEN-BRIDGE-TEMP-UPLOAD-DESIGN.md), [wire contract](HEYGEN-RECONCILIATION-CONTRACT.md), and [current execution note](execution-notes/20260930-bridge-foundation.md) first.

## Preconditions

- Use an explicitly supplied credential for the exact reviewed database target. The CLI never loads `.env.local` automatically. Do not substitute an integration-prefixed connection for canonical production `DATABASE_URL`.
- Strict target, migration journal and structural schema-lock verification must pass. Production target loading retains the existing canonical-manifest rules in `tools/check-migrations.mjs`.
- The current source ledger and `.vercel/project.json` identify the application candidate/project. The CLI rechecks source and adapter hashes before returning results.
- Account and enrollment must be owned and present. A missing provider binding stays provisional; an environment variable is not provider-account verification.

## Read-only status

Pass an external environment file through Node if needed; the file must already be available in a protected directory. Do not paste credentials into command arguments or this repository.

```powershell
node --env-file=C:/private/video-os-verification.env tools/reconcile-heygen-enrollment.mjs status --environment verification --target-manifest config/database-target.verification.json --account-id ACCOUNT_ID --enrollment-id ENROLLMENT_UUID
```

Output contains safe counts, binding state and `execution.enabled: false`. A successful command means inspection completed; it does not mean provider cleanup is ready or finished.

## Prepare a held or reviewable plan

Select exact normalized `provider_resources.id` UUIDs from the owned ledger in the verified read-only database. Resource selection never accepts a raw provider ID or a name. Keep the enrollment/account scope exact. To request multiple resources, repeat `--resource-action`.

```powershell
node --env-file=C:/private/video-os-verification.env tools/reconcile-heygen-enrollment.mjs plan --environment verification --target-manifest config/database-target.verification.json --account-id ACCOUNT_ID --enrollment-id ENROLLMENT_UUID --cohort-id disposable-review --expires-at FUTURE_UTC_TIMESTAMP --resource-action RESOURCE_UUID:read,delete,readback --private-plan-output C:/private/heygen-plan.json
```

Replace `FUTURE_UTC_TIMESTAMP` with an explicit timestamp such as `2026-10-01T18:00:00.000Z` only when it is actually in the future and within the contract's permitted window. The example is not approval or a live execution instruction.

Stdout is redacted. The optional private plan includes exact remote identifiers and must remain private. Its parent directory must already exist outside the repository; the tool resolves directory links and creates a new file exclusively, never overwriting an existing file. POSIX mode is `0600`; on Windows, choose a directory whose inherited ACL is restricted to the intended operator. Do not place the plan in a shared/synced folder without checking access.

The stable database binding hashes environment, provider project/branch/database and application project identity. Schema and migration proof are separate, so an ordinary migration does not change account origin. Credential origin and verified provider-account scope are also separate.

## Holds and recovery boundaries

- Provisional, conflicting, revoked or rotated credential origin: preserve old records and investigate account binding. Cross-credential action is unsupported in this foundation, even if two credentials appear to access the same provider account.
- Pending or ambiguous operation: preserve all known remote IDs and receipts. Do not rerun creation just because no final resource row exists.
- Active consumer or incomplete group membership: keep the resource. Local absence of a reference does not prove complete provider membership or lack of external/template consumers.
- Source or target drift: discard the old review artifact and inspect the new exact candidate. Do not edit an old digest into a new plan.
- Provider API absence, public URL denial and backup retention are distinct outcomes. None is established by this CLI, a mock response, or a local tombstone.

`execute` and `resume` return `EXECUTION_DISABLED` before dependency loading. Signature validation alone cannot enable them. Future execution needs reviewed atomic nonce/budget claims, fresh under-lock scope validation, real account qualification and the separately scoped canary/release authorization. See the [release preflight](RELEASE-PREFLIGHT.md).
