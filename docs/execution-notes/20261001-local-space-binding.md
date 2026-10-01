# Local HeyGen space binding — October 1, 2026

Status: implemented-local, verified-isolated-integration, review-only packaging complete. Not activated or deployed.

## Authorized scope and result

After the approved provider-space probe, the owner said to continue and approved local binding implementation and isolated-database verification. The implementation reuses the existing three-table binding/scope/promotion model and account lifecycle guard. No dependency or migration was added.

Added files:

- `config/heygen-space-anchor.json`: reviewed, redacted, pinned bootstrap evidence.
- `lib/heygen-space-anchor.js`: exact private bundle verification, safe projection and separate authority brands.
- `db/heygen-space-binding-repository.js`: verification-only bootstrap and fresh resolution.
- `tools/bind-heygen-space.mjs`: bounded operator bootstrap/status commands.
- Anchor, repository, CLI and guarded live test files.

The existing qualifier now brands freshly authenticated results and limits transport injection to the Node test runner. This closes the review finding where edited saved JSON could previously masquerade as a fresh result. No creation/render route or workflow was wired to the new binding helper; all activation remains off.

## Verification

| Check | Result | Evidence under `space-binding-local-20261001/` |
| --- | --- | --- |
| Full Node suite | 676 passed, 47 explicit credential/environment skips, zero failed | `unit-final.log` |
| Vitest | Four passed | `unit-final.log` |
| Actual isolated DB plus read-only HeyGen | Passed: exact three-row graph, idempotency, fresh resolve, stale/copy rejection, production/key-change rejection before HeyGen, revocation and no revival | `live-binding-final.json`, `live-binding-final.detail.json` |
| CLI outside the test runner | Bootstrap and fresh status passed on a separate existing fixture account | `cli-bootstrap.json`, `cli-status.json` |
| Cleanup after both proofs | All 27 tables empty; zero Blob objects | `cleanup-final.json` |
| Strict schema verification | Existing 11 migrations and structural lock passed; no new DDL | `schema-final.json` |
| Import, Workflow, privacy, syntax and whitespace checks | Passed | `imports-final.log`, `workflow-final.log`, `privacy-final.log` |
| Independent authority/security review | Passed after replay, transport, freshness, target and revocation repairs | Reviewed scoped implementation and focused tests |
| Review preview build | Passed: 42 routes, 29 steps, six workflows; no known Sandbox leakage | `build-final.log`, `build-summary.json` |

The final integration used ten read-only key/profile requests and no provider mutation. The standalone CLI proof used read-only qualification too. The only DB writes were disposable metadata fixtures on `mvp_verification_20260930`; they were cleaned. No new provider-space upload/delete probe was run during this implementation.

Browser tests were not rerun: this scope changes no product UI or public request path. Prior browser evidence remains explicitly scoped to the prior foundation.

## Exact candidate

- HEAD remains `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`; inherited dirty work is preserved.
- Source SHA-256: `0ae748b0f212b5da4d082808461106543db45e052c342fda79f736588a81bd5a` (416 files).
- Output SHA-256: `fb04cc6cab3491261ade031f657b49a7f2d7cea2fb7af6d042c91cb7e6e8b89c`.
- Review output: `.vercel/review-output-1790870414126-65168`; default `.vercel/output` is absent.
- Source and production-project link match the review manifest. This was local preview packaging, not publication.

## Limits and next step

Read [the operator runbook](../HEYGEN-SPACE-BINDING-RUNBOOK.md). The current space anchor expires October 2 at 15:11:53.953 UTC under a verification-only 24-hour policy; the fresh observation window is at most 60 seconds. Production re-probe policy is unset. API null expiry is not treated as a perpetual-validity guarantee, and a fresh profile check cannot prove historical space membership has not changed.

The local binding layer is ready for the next controlled integration phase. Production requires independently confirmed canonical DB targeting, reviewed production evidence/freshness policy, appropriate migration and configuration scope, then runtime wiring and the remaining canary/CI/storage/rollback/P0 gates. The current production DB timing correlation is not canonical connection proof. No production key/DB/environment change, runtime activation, provider generation, commit, push or deployment occurred.
