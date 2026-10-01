# Canonical database and runtime wiring — October 1, 2026

Status: local implementation, tests, isolated integration and review packaging complete. No deployment or production schema change.

## Database result

Canonical target provenance is confirmed as Neon `still-voice-83326863`, main branch `br-broad-sunset-awrsmiwa`, database `neondb`, role `neondb_owner`. Historical exact-copy commands tie the current Vercel canonical variables to the integration; audit timestamps remain unchanged. This is stronger than the earlier timing-only inference. The original Sensitive password bytes remain unrecoverable from Vercel.

The owner explicitly approved designating this integrated target and inspecting it read-only. A fresh credential for the independently checked target was kept outside Git. SQL identity matched, but strict readiness failed: **seven exact migrations applied, four missing (`0007`–`0010`), 16 tables versus 27 expected**. Only identity, migration journal and schema catalogue were queried. No customer records, migration, password reset, environment update or deployment occurred.

Evidence: [canonical investigation](runtime-wiring-20261001/canonical-db-investigation.md), [redacted inspection](runtime-wiring-20261001/production-database-inspection.json), [reviewed target](../../config/database-target.production.json). The earlier secret-reset proposal is superseded for target discovery.

## Runtime changes

- Enrollment upload/avatar/voice and render submission resolve fresh process-branded authority. Claims recheck the exact persisted binding, scope and promotion under the account lifecycle lock.
- Claim transactions use the exact connection captured by the verified binding. The ordinary database client also replaces a cached pool when the canonical URL changes.
- Outbound bytes and render inputs come from, or are compared to, the canonical claim. Unregistered stock selections cannot bypass owned-resource provenance.
- Receipts use a distinct transaction on the original target. A slow response can be recorded after qualification expires or process configuration changes, without granting authority for another request.
- Polling and preview load canonical resource references before provider reads. Finishing compares the serialized source URL with immutable ready evidence and retains the binding through final acceptance/debit. Transient polling, polling deadline and pre-download authority failures preserve the existing reservation for reconciliation rather than refunding an operation that may still complete.
- Same-operation unfinished submissions and missing-ID replays are held. All identity POST errors after sending, including transport/body/JSON/ID failures, are conservatively classified as uncertain; there is no automatic retry or claim of documented idempotency for upload/voice clone.
- Verification authority does not activate generation. Both identity creation and render retain the independent disabled activation gate; production policy and the deletion executor remain held.
- Node binding logic stays inside Workflow steps. Review packaging explicitly stages the allowlisted nonsecret target, anchor, migration and schema files inside each relevant function; private evidence, credentials and documentation are not copied.

No new dependency or migration was added. An existing transitive dependency was patched: `@workflow/core` now overrides `devalue` to `5.9.4` while Workflow remains `4.8.9`. Three newly reported high-severity advisories appeared during final verification; the audit gate was not weakened. Runtime audit is zero and a synthetic 5.9.2 wire fixture passes compatibility checks in both directions. See [the security repair evidence and live-run limits](runtime-wiring-20261001/devalue-security-repair.md).

Existing lifecycle guards and transaction patterns were reused; the unused inventory-to-provider submission path was removed from the owned-identity bridge. The provider-space identity remains explicitly a space, not a global account ID.

## Verification record

| Check | Result | Evidence under `runtime-wiring-20261001/` |
| --- | --- | --- |
| Full Node suite | 722 passed, 47 explicit environment/credential skips, zero failures | `unit-final.log` |
| Vitest | Four passed | `unit-final.log` |
| Real isolated binding/claim/receipt SQL | Passed, including cached-target drift, copy/account/revocation denial and expired-claim/original-target receipt separation | `live-runtime-receipts.json`, `.detail.json` |
| Real isolated provider ledger SQL | Passed: source binding, replay, conflict and tombstones | `live-ledger.json` |
| Real isolated enrollment and scripted render suites | Both passed: private multipart upload, actual audio extraction, consent revocation and credit/claim locking | `live-enrollment-scripted.json` |
| Final cleanup | All 27 test tables empty, zero Blob objects | `cleanup-final.json` |
| Strict isolated schema | Eleven migrations and reviewed catalogue matched | `schema-verification.json` |
| Imports, strict Workflow validation, privacy and whitespace | Passed | `imports-final.log`, `workflow-final.log`, `privacy-final.log` |
| Independent authority/runtime review | No remaining blocker in the hard-disabled local wiring | Recorded scope and limits below |
| Runtime dependency audit | Zero vulnerabilities; existing full-audit exception policy still enforced | `audit-runtime-after.json`, `audit-compatibility.log` |
| Packaged verification data and real file trace | Four tests passed; real bundled anchor loads, required metadata present, no recursive/private assets | `runtime-packaging-final.log` |
| Final review packaging and readback | 42 routes, 29 steps, six workflows; no known Sandbox leakage; staged files match source; default output absent | `build-final.log`, `build-summary.json`, `artifact-readback.json` |

Four actual isolated DB/Blob proofs passed. HeyGen access in the binding proof was read-only qualification. Other live suites use explicit synthetic provider fixtures to exercise real SQL; those fixtures are not HeyGen generation evidence. No suite uploaded, cloned or rendered with HeyGen or changed production. Earlier failed runs exposed stale test fixtures/static assertions and were repaired; final logs above supersede intermediate logs.

No product UI changed, so browser suites were not rerun. Existing browser results belong to their earlier checkpoints. There is no lint/typecheck script in this plain-JavaScript project; import/syntax checks, strict Workflow validation and the full tests cover this scoped change.

The first full build exposed recursive file tracing through an imported path helper. The identified preview subprocess was stopped and its output quarantined. Literal source/bundled file references replaced the helper; actual NFT tracing now excludes build output and private files. Explicit Vercel exclusions include both Windows-compatible and POSIX directory patterns because NFT normalizes paths before glob matching. The 19 staged verification files are required assets, not an exclusive dependency inventory; existing CLI verifier imports also trace public Drizzle snapshots/tool code. Splitting those CLI-only assets is an optional size cleanup, not an activation or containment bypass.

## Final candidate and changed files

- HEAD remains `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`; inherited dirty work is preserved. No commit or push occurred.
- Source SHA-256: `77a5fd7de66f5ecbe8e2b6852bac882ad43da218a7dc285e53a31a05153e5ee4` (425 files).
- Output SHA-256: `eff1e634df81ff03c270500dfa38bdd1699f2f63a27b5cf3e262dcf531089e03`.
- Review output: `.vercel/review-output-1790875380651-64660`; `.vercel/output` is absent.
- Source and production project-link hash match the review manifest. The artifact is review-only, not deployment-authorized.

The 37 changed source files relative to this turn's captured baseline are listed in [build-summary.json](runtime-wiring-20261001/build-summary.json). Main changes are `config/database-target.production.json`; the database client, binding, enrollment, ledger and render repositories; `routes/video-os-lite/identities.js`; `workflows/video-render.js`; `services/heygen.js`; runtime packaging/migration-check tooling and `vercel.json`; the dependency override/lock; and their regression fixtures. No schema migration or frontend file changed in this phase.

## Next action and limits

Use [the four-migration rehearsal plan](runtime-wiring-20261001/production-migration-next-step.md). Production application needs its own reviewed rehearsal, explicit migration scope, restore point, strict readback and release checks. Local packaging does not authorize deployment.

The current anchor still expires **2026-10-02T15:11:53.953Z** under the verification-only policy. No timestamp or evidence pin was extended. Production freshness/re-probe policy is unset, and the original one-asset probe approval remains exhausted. Provider privacy/pricing/capabilities, real device/provider canaries, private storage, CI/CodeQL, rollback and P0 gates remain distinct prerequisites.

The inherited Workflow flow passes the raw provider result URL through durable step state. Its custody must be verified against the [design's private evidence retention requirement](../HEYGEN-BRIDGE-TEMP-UPLOAD-DESIGN.md) before activation. This run proves URL integrity at finishing, not encryption/retention compliance of Workflow storage. No architecture change or new storage service was introduced to resolve that separate privacy decision.
