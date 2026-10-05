# Video OS P0 release gate

> September 30, 2026: `tools/verify-p0-release-gate.mjs` is disabled and exits 2 for verification requests. Its historical generated approvals did not verify observations and cannot satisfy this gate. An authenticated evidence collector and independently reviewed real observations are still required. See [release preparation](RELEASE-PREFLIGHT.md) and [Prompt 4 evidence](execution-notes/20260930-prompt4.md).

Billing, paid-credit activation, hosted finishing, pilot enrollment, and launch remain blocked until one new production job produces the complete receipt below. Existing or manually repaired artifacts are invalid proof.

## Owner-approved pre-P0 private enrollment exception (inactive)

A fresh identity may be needed before the new-job P0 proof can be run. The
general pilot-enrollment prohibition above remains in force. On October 4,
2026, the owner approved a separate policy exception for one owner-operated
**private source capture and extraction canary**, with no HeyGen contact,
provider creation, render or billing. This approval does not authorize a
deployment, production flag change, media upload or database/storage write.
Before any live write, present the exact account, deployment, private store,
one photo/video attempt and its bounded retry/cleanup plan for the separate
production-action approval required by the owner.
The current code pins the account but does not enforce a durable one-attempt
budget for that account; its existing per-account rate limit remains in force.
An owner-approved operator window must monitor and close the canary after the
single planned attempt, or a separate durable one-shot guard must be reviewed
before activation. Do not describe the account pin as a one-shot budget.
Immediately before activation, read back zero existing enrollment rows and no
pending enrollment workflows on the canonical production target; otherwise
stop and reconcile the historical cohort before opening the window. The
October 4 aggregate zero-row observation is a dated baseline, not permanent
authority.

The candidate must prove that production enrollment and identity-source upload
requests are limited to the pinned account, with persisted account entitlement,
an exact UTC cohort start, denial of older photo/enrollment sources and denial
of provider reconsent during the private canary,
correct private-store identity, authorized preview and anonymous/cross-account
denial. Provider creation, HeyGen upload, rendering, billing and hosted finishing
remain disabled. The canary may produce an `IDENTITY_READY` local draft only;
that state is neither provider readiness nor the P0 receipt. New source bytes,
consent and hashes belong to a new cohort. All legacy, unreferenced and
quarantined objects and references remain intact. Historical original-source
equality and the private-storage migration requirement below remain blocked.

The current enrollment UI requires six affirmative permissions, including
authorization for future temporary public provider exposure. Provider work is
still blocked in this canary. If the owner declines that permission, stop;
do not precheck it or treat private capture as consent to provider exposure.
An extraction-only consent path would require a separate reviewed change.

The separate approval must include the private-store probe's disposable test
object and conditional deletion, the real photo/video/derived-audio writes,
workflow recovery, and exact evidence/readback. No deployment, environment
change, upload or cleanup is implied by this proposed exception.

## Required configuration gates

- `VIDEO_OS_BILLING_ENABLED` remains unset or `false`.
- `VIDEO_OS_HOSTED_FINISHING_ENABLED` remains unset during containment. It may be `true` only for the bounded proof after private storage migration and source-policy tests pass.
- `VIDEO_OS_PUBLIC_ORIGIN` is the exact production HTTPS origin.
- `CRON_SECRET`, `VIDEO_OS_SESSION_SECRET`, and `BLOB_READ_WRITE_TOKEN` are configured.
- `VIDEO_OS_PROVIDER_MEDIA_HOSTS` contains only verified provider media hostnames.
- All legacy public account, auth, rate, job, upload, and final objects have been copied to private storage, verified, references migrated, and public originals removed.

## New-job production receipt

Record a server-generated proof ID and correlation ID. Capture the signed-in account hash and a preflight digest of existing provider job IDs. Submit exactly one provider render with a unique `P0-PROOF-<UTC>-<nonce>` title. The provider job ID must be absent from preflight and created after proof start.

The receipt must bind that same account hash, correlation ID, job ID, provider job ID, private final pathname digest, final byte count and SHA-256 through these observations:

1. signed-in customer session;
2. provider submission and completed provider job;
3. private final MP4 with valid audio/video streams;
4. account history in the original session;
5. a completely fresh browser context and newly issued session;
6. normal gallery recovery without storage repair or route replay;
7. authorized download whose SHA-256 equals the stored artifact;
8. anonymous download `401`, wrong-account download `404`, and direct private Blob access denied;
9. exactly one provider submission, credit debit, and final artifact event in correlated logs.

Store the canonical receipt privately and hash it. Only that hash-bearing receipt clears P0.

## Operating contract

Structured job events carry request/correlation/job/provider identifiers, hashed account ID, stages, latency, bytes, credit cost, recovery attempts, and a bounded failure category. Never log email, cookies, tokens, scripts, raw provider bodies, source URLs, or URL query strings.

Alert immediately on an authorization escape, public customer asset, source-policy bypass, duplicate grant, or ledger mismatch. Warn on more than two provider/finish failures in 15 minutes, provider submission stuck beyond 30 minutes, provider-ready beyond 15 minutes, missing ready artifact, or exhausted recovery.

Reconcile daily: every debit has one provider job; every ready job has one private final; every final has one account/job; terminal states never regress; every Stripe event has at most one applied grant; every recovery attempt has an immutable receipt. Report mismatches and repair only with a separate receipt.

Initial SLOs: session/results/download availability 99.9% monthly; eligible submission acceptance 99.5%; 99% of provider-ready jobs final-ready within 15 minutes and 99.9% within 30; 95% provider-submitted to authorized download within 30 minutes; 100% terminal jobs correlated and costed; reconciliation complete daily by 10:00 UTC; zero cross-account downloads. Any security invariant breach is an automatic launch stop.
