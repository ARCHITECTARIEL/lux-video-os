# Temporary provider bridge foundation — September 30, 2026

Status: verified-local and verified-isolated-integration; review packaging complete; not deployed.

## Authorized scope

The owner asked to take the next step after selecting the temporary-public HeyGen bridge design. This step implements local consent-v2 and re-consent, normalized provider-resource provenance, account lifecycle locking and tombstone checks, signed approval validation, and read-only reconciliation plan/status tooling. Production deletion execution remains disabled.

Baseline HEAD: `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`. Baseline source ledger: `b2e7e583a660823f76d32fda8c3f6d4befa2238846d4fc7cba69c7af1743a7f5`. Inherited changes were preserved before editing; see `bridge-foundation-20260930/baseline.json` for the backup and patch digest.

## Implementation and verification sequence

1. Freeze exact consent, snapshot, signing and locking interfaces. Preserve immutable creation origin and distinguish credential scope from a verified provider account.
2. Implement consent/re-consent UI and repositories, provider ledger and account-first locking. Add an append-only database audit trail with restrictive relationships.
3. Implement bounded resource read adapters and mock-only deletion contract tests. Production deletion remains hard-disabled regardless of approval contents.
4. Add read-only plan/status CLI with strict database target/schema preflight, source identity checks and redacted output. Private raw plans are optional, exclusive files outside the repository.
5. Review generated migration plus database guards before applying only to the pinned, isolated verification database. Capture a new schema baseline only after confirming the previous baseline and exact migration prefix.
6. Run focused tests, isolated database tests, full local checks and review-only packaging. Clean the isolated database/storage and record exact results.
7. Update the current handoff, next prompt and dated project log with verified results and remaining external gates.

## Deliberate limits

Cross-credential resource migration and deletion claims are outside this foundation. Read-only snapshots must retain old-origin resources and report a hold/conflict when the current credential scope cannot act on them. They must never silently omit old resources or present a false verified cleanup plan. A future activation step must review the cross-rotation claim model.

The 40-case bridge test specification includes future executor, external provider and production acceptance requirements. Passing local contract tests does not satisfy those external requirements. No temporary-source deletion, source-dependency survival, CDN denial, provider pricing/account qualification, training opt-out or backup purge is claimed here.

No live provider upload, cloning, rendering, deletion, paid call, production mutation, commit, push or deployment is part of this step.

## Results

Isolated database verification:

- `0009_absurd_meteorite.sql` adds nine ledger tables, v2 consent fields and reviewed database guards. A real rollback-only SQL check caught generated foreign-key/index ordering; moving the five referenced unique indexes before their foreign keys corrected it without changing schema semantics.
- `0010_provider_source_binding.sql` adds the exact null-safe resource/origin media hash and byte-count invariant. It is additive because `0009` had already been applied; applied migration history was preserved.
- Both migrations were applied only to `mvp_verification_20260930` on the pinned Neon verification branch. Eleven migration hashes and the 27-table structural schema were verified. The updated direct SQL guard test passed, including malformed source pairs and immutable provenance.
- `tools/verify-isolated-live.mjs validate-migration` executes pending SQL inside a rolled-back transaction on that same pinned target and verifies the schema fingerprint is unchanged. It exposes safe statement indices for errors the Drizzle CLI suppresses.
- Schema-lock source binding now includes the manual guard SQL as well as both schema modules. Capturing a schema baseline remains distinct from the subsequent strict verification result.

## Final verification

| Check | Result | Evidence in `bridge-foundation-20260930/` |
| --- | --- | --- |
| Full Node + Vitest suite | Exit 0; 555 Node passed, 46 explicit credential/environment skips; four Vitest passed | `unit-final.log` |
| Full browser suite, including consent visuals | Exit 0; 118 passed, one gated production-proof skip | `e2e-final.log` |
| Clean isolated integration run | Exit 0; four passed: enrollment/re-consent, SQL guards, actual ledger repository, scripted reservation/revocation | `live-final.json`, `live-final.log` |
| Final isolated cleanup | Exit 0; all 27 tables empty, zero Blob objects | `cleanup-final.json` |
| Strict isolated schema verification | Exit 0; 11 exact migrations and full structural schema matched | `schema-0010-verified.json` |
| Imports, Workflow validation, client privacy | Passed | `imports-final.log`, `workflow-validation.log`, `privacy-final.log` |
| Review-only preview packaging | Exit 0; 42 routes, 29 steps, six workflows; `NO_KNOWN_SANDBOX_CLASS_LEAK` | `build-final.log`, `build-summary.json` |
| Independent security review | Approved for the local execution-disabled foundation | Review findings and corrections summarized below |

The four isolated tests used the pinned verification database and private test Blob store only. Enrollment used real multipart upload, hashing and FFmpeg extraction. Re-consent preserved historical consent and reused existing media; synthetic provider bindings/IDs were database fixtures, not actual HeyGen evidence. SQL/repository tests exercised immutable provenance, late conflicting IDs, blocked plans, active consumers, source pairs and tombstones. The scripted test exercised quote/reservation replay and revocation winning the provider claim. No live HeyGen call occurred.

Source ledger: `f64e77d220008d1c310eb16d8d2f45c2630feb20692251ca4da9f79cc1b0bd5e` (404 files). Output ledger: `93fec4087d7ea541e043191796dd00d89699b28e67dbc9bcb5892edbc41c73af`. The current source and project-link readback match the build. Review output is quarantined at `.vercel/review-output-1790802043329-77252`; default `.vercel/output` is absent. The checkout still links to production project `prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW`, but this was local preview packaging, not deployment.

## Corrections established by review and testing

- Canonical candidate SHA means application code-tree identity; customer photo/voice media hashes and byte counts are separate resource provenance signed into the private plan digest. Redacted output exposes only whether that provenance is bound.
- Credential origin remains immutable. All prior bindings stay visible; rotation and missing/mismatched verified annotations hold the plan rather than hiding resources.
- Late conflicting remote IDs survive in immutable events even when no normalized resource can be created. These events, pending receipts and global reconciliation holds cannot disappear from read-only planning.
- Response timeout includes the body stream; errors and MIME metadata are bounded/sanitized; path traversal IDs and noncanonical approvals fail before provider access.
- Re-consent checks current owned media and preserves history; account lifecycle locks precede row locks. Existing financial/quote invariants are preserved.
- Test fixtures were updated to obey the same SQL guards and clock/source contracts. Guards were not weakened to make fixtures pass.

## Developer handoff

Core additions: `db/provider-reconciliation-repository.js`, `db/provider-lifecycle-lock.js`, `db/provider-lifecycle-guards.sql`, schema/migrations `0009` and `0010`, `lib/heygen-reconciliation-contract.js`, `lib/provider-reconciliation-target.js`, `services/heygen-reconciliation.js`, and `tools/reconcile-heygen-enrollment.mjs`. Existing enrollment/identity/render repositories, routes, consent UI and tests were integrated. No dependency was added. Existing account locking and repository patterns were reused; provider IDs and operational status are separated from browser-safe DTOs.

Read [the operator runbook](../HEYGEN-RECONCILIATION-RUNBOOK.md), [wire contract](../HEYGEN-RECONCILIATION-CONTRACT.md), and [next prompt](../MVP-EXECUTION-PROMPTS-2026-09-29.md). Ten SHA-bound desktop/mobile consent screenshots and the accepted visual verdict are indexed in `.design/bridge-consent-screenshot-manifest.json`; these use controlled browser fixtures.

Next: qualify and bind the exact application provider account/scopes, cost/privacy evidence and canonical production/Preview storage identities. Runtime call sites intentionally lack a qualified `providerBinding`. The deletion worker, atomic application nonce/budget claim-and-resume path and real disposable source-dependency/CDN canary remain unimplemented or unverified. Current-candidate CI/CodeQL, production DB/storage proof, rollback attestation and P0 release proof remain open. Do not turn the fixture promotion into production authority.

No production schema/data/environment change, customer media upload, live provider upload/clone/render/deletion, spend, support message, commit, push or deployment occurred. Applied isolated migration history and the inherited dirty checkout were preserved.
