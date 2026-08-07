# Identity Studio baseline reconciliation

## Credential decision

> Rotation of the HeyGen password and API key was recommended but declined by the operator. No credential value may be displayed, copied into source code, committed, published, or included in receipts.

The retained credentials are not described as unexposed or risk-free. Local credential-bearing tool logs were contained before product work. No credential value is recorded here.

## Source lines

- Approved remote main: 72641b8d6565b742f6634996eaa363bd10efebf8
- CEO UX draft PR #6 head reviewed: 76e17d67bff3c59aafd9b46f3a2a7b0ce8363287
- Identity Studio checkpoint: 55b6da4000fba78b6bedbbb6f443e9a8a846da03
- Reconciliation branch: agent/identity-studio-reconciliation
- HyperFrames proof branch and commit were not modified.

PR #6 and the Identity checkpoint share d2309c28e052f39e2490a145c4245ae32813caee. The later CEO repair commits touch only provider talent inventory code and tests. The shared UI files were reconciled semantically, without whole-file replacement:

- public/index.html: CEO wizard, Featured Cast, and Final Cut markup plus the separate Identity Studio navigation and My Cast region.
- public/lite.css: CEO Cast, Final Cut, and responsive behavior plus isolated My Cast styling.
- public/lite.js: CEO top-20 Cast, Ariel -> OSO -> KD exact-ID behavior, matched-voice priority, and newest-job Final Cut recovery plus ready-only private identity state and fail-closed handoff/recovery.
- tests/e2e/ceo-demo-ux.spec.js: all CEO regressions retained and extended with private-identity isolation cases.

## Authority and privacy decisions

- Postgres users, entitlements, credit_accounts, and credit_transactions are the runtime account and economic authority.
- Each validated authentication method replaces its prior auth-sourced entitlement set; separately sourced grants remain independent.
- Private Blob remains byte/object storage and hashed magic-link challenge storage; legacy Blob objects are preserved but no active account, credit, or job path reads them as authority.
- Browser requests never supply an account or owner identifier.
- One shared HeyGen service client owns authenticated provider HTTP.
- Identity provider creation requires both existing global safety gates and an exact server-configured account match.
- Every identity render revalidates current, active consent and the frozen source-asset SHA-256 fingerprints.
- Identity media and result downloads remain session- and account-scoped.
- No provider creation or render request was sent to HeyGen during reconciliation.

## Identity Studio inventory

Implemented and locally verified:

- Separate authenticated Identity Studio route.
- Account-owned photo-avatar and cloned-voice records.
- Private photo/audio upload validation and private preview.
- Versioned face, voice, provider-processing, and archive/delete consent.
- Durable avatar/voice processing, failure, retry, archive, and ready state.
- Ready-only owner composer selection and refresh recovery.
- Anonymous and cross-account media denial.

Not implemented in this baseline:

- A provider-backed video Digital Twin lifecycle. The interface continues to mark this capability unavailable; no biometric Digital Twin request is permitted.

## Verification record

Passed locally:

- 90 Node tests.
- 4 Vitest tests.
- 17 Python tests.
- 22 Playwright tests covering desktop/mobile product behavior; one Production-only proof was intentionally skipped.
- API import sweep.
- Drizzle consistency check.
- Strict workflow serialization.
- Preview-shaped build.
- Production-shaped local build.
- Production runtime dependency audit: zero vulnerabilities.

Constrained or outstanding:

- Database-backed migration dry run requires a database URL. No database or credential was retrieved for this task; additive migration structure, preservation, and rollback are covered by static and unit tests.
- The development-only dependency graph reports known audit findings through Vercel/Drizzle tooling. No breaking forced upgrade was applied.
- Live two-account Preview verification and a provider-backed Digital Twin lifecycle remain review gates.