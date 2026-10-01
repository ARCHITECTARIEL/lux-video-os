> Continuation routing updated 2026-09-29: historical prompt numbers below refer to the earlier pack. Use docs/MVP-EXECUTION-PROMPTS-2026-09-29.md, Prompt 1 (validate/preserve this existing repair), then Prompt 2 (DTO/accepted output). The implementation evidence below remains historical evidence, not a new rerun.

# Prompt 2 - authorization repair

## Implementation completed locally - 2026-09-29

This section supersedes the historical Phase A correction report retained below.
Diagnosis: CONFIRMED. Local implementation and offline verification completed; live DB/Blob coverage remains unverified.
Starting/ending HEAD and local origin/main: `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`, branch `main`.
No commit, push, migration, deployment or paid operation performed. Initial untracked notes/wiki preserved.

### Root cause and repair

- Domain sign-in persisted the same tester role later trusted by a read-only admin list. Listing then populated mutable process state consumed by future grants. Listing now has no authorization side effects; mutable tester registration cannot affect authorization or provisioning. Domain members receive the customer role and Standard entitlement; explicit configured testers remain distinct. The existing domain initial-credit policy stays separate and unchanged.
- Shared Premium containment authorization preceded tier selection. The route now authenticates, rate-limits, reads the bounded request, selects the tier, then checks persisted permission. Standard remains subject to its own quote/consent/activation gates.
- Exact-email route authorization disagreed with account-only cold-worker authorization. Both workers now consult persisted permission before submission. New reservations write a server-generated `renderAuthorization` containing version, account, job, tier, grant key and provenance. Premium reservation computes it inside its transaction; Standard uses its existing locked entitlement check. Client-provided authority is rejected by route schemas or overwritten at the repository boundary.
- Job binding validation rejects a mismatched account, tier, job ID, version or grant key. Current permission is rechecked so disabled/expired grants do not authorize new submission. Existing provider IDs still return without resubmission. Pre-repair jobs without the new field require current persisted authority; present-but-invalid fields fail closed. Standard replay compares canonical source inputs separately from the additive server permission field.
- Historical auth-derived Premium overgrants are filtered from account responses and render authorization unless the account has independently configured identity eligibility (or a workspace-password grant). Admin grants retain their source during sign-in. Admin revocation records admin provenance so subsequent sign-in cannot silently re-enable those grants.
- Admin tester creation previously generated a different ID from Google/magic-link sign-in. New grants use the same canonical ID; existing IDs are preserved. Verified sign-in and magic-link requests resolve existing accounts by normalized email, preserving older admin-granted accounts without migration.

### Final capability matrix

All allowed renders additionally require activation, owned inputs, valid consent/quote where applicable, and available credits.

| Actor/state | Standard | Premium | Authority |
|---|---|---|---|
| Anonymous | 401 | 401 | No session |
| Ordinary customer with no render grant | Denied | Denied | Credits/role alone grant neither tier |
| Domain member after verified sign-in | Allowed with active Standard grant | Denied | Domain membership provisions Standard only |
| Explicit Standard beta grant | Allowed | Denied | Active persisted standardRendering |
| Exact configured tester after verified sign-in | Allowed | Allowed | Persisted grants, not session email alone |
| Admin-designated tester | Allowed | Allowed | Persisted admin_tester_grant |
| Admin cookie only | No customer render session | No customer render session | Separate admin session |
| Workspace password account | Allowed | Allowed | Persisted workspace-password grants |
| Disabled/expired grant | Denied for that grant | Denied for that grant | Worker rechecks current state |
| Wrong-account job/media/download | 404 | 404 | Existing ownership queries retained |

### Files changed

Product: `api/video-os-lite/auth.js`, `api/video-os-lite/render-v2.js`, `db/repositories.js`, `db/standard-narration-repository.js`, `lib/video-os-security.js`, `lib/video-os-testers.js`, new `lib/video-os-render-authorization.js`, `workflows/video-render.js`, `workflows/standard-render.js`.

New tests: `tests/authorization-repair.test.mjs`, `tests/helpers/authorization-repair-scenario.mjs`, `tests/render-authorization-policy.test.mjs`.

Updated tests: `tests/account-authority-contract.test.mjs` was read but unchanged; edited tests are `admin-overview-repository`, `admin-route-http`, `entitlement-consistency-across-signin-methods`, `google-signin-route`, `mvp-tester-whitelist`, `render-auth`, `render-rate-limit`, `talent-inventory`, `video-os-operations`, `video-os-watchdog` (all `.test.mjs`). Integration fixture accounts now explicitly receive required test grants before reserving jobs. Google/magic-link live regressions now include admin listing between sign-ins.

Documentation: this handoff and `wiki/log.md`. No new dependencies, schema changes, migrations, billing changes or provider-worker changes.

Simplifications: removed repository registry writes and obsolete explanation of their role; one pure permission/binding helper handles the shared contract. Existing ownership checks and Standard source/consent validation remain in place.

### Verification evidence

| Command/check | Result |
|---|---|
| Initial `node --test tests/authorization-repair.test.mjs` before product edits | 0 pass, 3 fail, 0 skip; failures specifically demonstrated list escalation, Standard 503 and cold-worker denial |
| Final `npm run test:unit` | Exit 0; Node 350 total: 310 pass, 0 fail, 40 skipped; Vitest 4 pass, 0 fail |
| New authorization scenarios inside final suite | 7 pass: list, route, Premium worker, Standard worker, sign-in, persistence, admin identity |
| Policy tests inside final suite | 3 pass: expiry/disabled/wrong-account/tier; job binding; admin grant/revocation preservation |
| `npm run check:imports` | Exit 0, 8 API entry points imported |
| `npm run workflow:validate` | Exit 0; 4 files scanned, 2 workflow-pattern files; no serde issues reported by validator |
| `npm run workflow:build` | Exit 0; 89 steps, 2 workflows; pre-existing Sandbox SDK serde warning remains |
| Starting HEAD built in isolated temporary source snapshot | Exit 0; same Sandbox SDK warning, 89 steps/2 workflows |
| `node --check` for edited JS/MJS and new helper/policy modules | Exit 0 |
| `git diff --check` | Exit 0 |

The first candidate workflow build failed because Node-only imports reached the workflow bundle. Moving the config-only eligibility helper out of the HTTP/security modules resolved those errors. The remaining Sandbox SDK warning was reproduced against unchanged HEAD in `C:/Users/ariel/AppData/Local/Temp/lux-auth-baseline-b8afb3f5f7024069aa2d2838d91b1fba`; the temporary snapshot is retained for inspection.

There is no configured lint or typecheck script in package.json. Full production build, deployed runtime, browser E2E and live DB/Blob tests were not run for this API authorization change. The 40 skips are existing credential-gated database/Blob integration cases; none is counted as a pass. Local scenario tests run real route/repository/worker functions with explicit mocked persistence/provider seams; they prove those local boundaries, not real SQL isolation or provider success. No paid provider calls occurred.

### Remaining registry inventory and compatibility risks

- `lib/video-os-testers.js` retains the legacy Set and register/revoke/count exports for compatibility; `isTesterAccountId()` no longer reads the Set.
- `lib/video-os-security.js` re-exports those legacy symbols, but no production authorization or provisioning function writes/reads mutable registration as authority.
- Repository register/revoke/list/sign-in operations have no registry calls. Tests and the historical diagnostic script still exercise the compatibility exports.
- `docs/execution-notes/02-authorization-reproduction.mjs` is the historical pre-repair diagnostic; its assertions deliberately expect the old vulnerability and are superseded by the passing regression suite. It is not a current acceptance command.
- A fresh session for an exact tester with no persisted grant now correctly denies rendering until verified sign-in provisions its grant. Existing unsafe domain Premium sessions are denied even before sign-in reconciliation.
- Live database locking, legacy identity resolution and full Standard source/quote/replay integration require the skipped non-production tests before release. No production readiness claim is made.
- The pre-existing Sandbox SDK serialization warning requires separate release investigation.

Next prompt: Prompt 3 (real completed-output DTO/My Videos contract). Deployment and external operations remain gated under the prompt pack.

---

## Historical Phase A correction report (superseded by implementation above)

Date: 2026-09-29. Status: Phase A correction report; implementation NOT completed.
Starting/ending HEAD and local origin/main: `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`, branch `main`.
Remote previously verified in this session: `https://github.com/ARCHITECTARIEL/lux-video-os.git`.
Initial worktree: untracked `docs/execution-notes/` and `wiki/`; no tracked product edits.
Ending worktree: same directories, containing updated notes and a diagnostic script. No commits.

## Diagnosis: CORRECTED

Prompt 1 incorrectly dismissed the domain/admin-list escalation. The original prompt pack was correct. The existing admin regression uses `ensureAccount()`, which creates a customer, whereas both real sign-in paths explicitly store role `tester` for domain matches. Its synthetic setup therefore fails to model the trigger.

Before-state call path:

1. `api/video-os-lite/auth.js` magic-link and Google callbacks: `isTesterEmailDomain(email)` -> `role = 'tester'`; initial credits are 5000 for that branch. `containedRenderingEntitlementKeys()` initially returns Standard and tester entitlements only.
2. `db/repositories.js:updateAuthenticatedAccount()` persists that role. Its narrowed `registerAsTester` guard avoids direct registration on this first sign-in.
3. `routes/video-os-lite/admin.js` tester listing -> `db/repositories.js:listAdminTesters()` -> register every row whose role is tester, including the domain member.
4. `lib/video-os-testers.js:isTesterAccountId()` trusts that process-local Set.
5. Next `containedRenderingEntitlementKeys()` returns liveRendering; the shared Premium gate now accepts the ID.

Independent defects also verified:

- `api/video-os-lite/render-v2.js` invokes shared authorization before reading/selecting tier. A Standard-only domain member is denied by this gate.
- `workflows/video-render.js:submitProvider()` invokes account-only authorization for non-identity jobs. A fresh exact tester ID passes the route check with its email but fails the worker check without email or persisted authority.

## Reproducible local evidence

Run `node --experimental-test-module-mocks docs/execution-notes/02-authorization-reproduction.mjs`.

Observed exit: 0. Three diagnostic scenarios confirmed, zero diagnostic failures/skips:

| Scenario | Observation |
|---|---|
| Domain member, before/after admin list | `[standardRendering,tester]` becomes `[liveRendering,standardRendering,tester]`; Premium gate allows |
| Standard-only account | Has Standard entitlement, shared gate denies, source confirms tier selection occurs afterward |
| Exact tester with cold worker | Route gate with exact email allows; account-only worker gate denies |

The script runs the real repository list function against a mocked database returning a synthetic tester-role row, plus real entitlement/security helpers. Source assertions bind this row shape to both auth branches. It does NOT run authenticated Google/magic-link HTTP flows, real SQL, provider submission, or the full worker. These are local diagnostic proofs, not complete route/integration regression coverage. Node prints its expected experimental module-mocking warning.

## Current capability matrix (not a repaired policy)

| Actor | Sign-in entitlement intent | Actual limitation |
|---|---|---|
| Anonymous | No render rights | Existing handler authenticates before render processing |
| Normal customer | Auth-method access; trial credits | No contained render grant by default |
| Domain member | Standard + tester, broad initial credit grant | Shared render gate denies before tier; admin list may escalate to Premium |
| Explicit Standard beta grant | Standard only | Shared Premium gate ignores this persisted grant |
| Exact tester/configured account | Standard + Premium | Exact email route fix does not solve cold worker authority |
| Admin session | Administrative actions | Separate admin cookie; no automatic customer rendering grant inferred |
| Workspace password | Standard + Premium + passwordAccess | Persisted grants and shared containment checks can disagree |

## Revised minimal implementation proposal

Continue Prompt 2 in this order:

1. Add actual Google and magic-link sequence regressions, with persistence represented faithfully, including role tester -> admin list -> second sign-in.
2. Make tester listing read-only and separate domain membership from explicit tester authority. Preserve credits as a separate policy; do not use balances or role alone as Premium authority.
3. Remove mutable process memory as authorization authority. Preserve explicit admin grants across sign-in without silently overwriting their provenance.
4. Select the tier before evaluating persisted tier-specific entitlement. Bind the server-accepted decision to the reserved job; reject client-supplied authorization data.
5. Verify cold worker, revocation/legacy-job behavior, anonymous 401 and wrong-account 404. Choose explicit legacy handling before accepting jobs with no bound decision.

Planned edits: auth.js; video-os-security.js; video-os-testers.js; repositories.js; render-v2.js; video-render.js; focused auth/admin/worker tests. Read-only dependencies: schema, Standard narration repository, account/session helpers, talent authorization, P0 gate. Integration-owner files involved: repositories.js, render-v2.js and workflows/video-render.js; keep changes serialized. No provider, billing, composition, migration, dependency, or UI implementation is proposed here.

## Remaining mutable registry call sites

- `db/repositories.js`: updateAuthenticatedAccount (line 66), registerAdminTester (1001), listAdminTesters (1098), revokeAdminTester (1105).
- `lib/video-os-security.js`: containedRenderingEntitlementKeys registers (71); accountAllowedForContainedRendering and requireRenderAccountAuthorization consume registry-backed isTesterAccountId (19, 26); gate checks Set size (29).
- `api/video-os-lite/auth.js`: Google/magic-link eligibility and registerAsTester decisions consume isTesterAccountId (206, 213, 252, 258).
- `lib/video-os-testers.js`: owns Set, count, register, revoke and registry-backed identity check.

## Stop condition and verification limits

Prompt 0 Phase A says: "If the diagnosis is false, stale or materially different, stop implementation. Write a correction report with evidence and a revised minimal proposal." This report corrects the inherited audit before repairs. Product code is unchanged. Required regression/build/integration gates for a completed Prompt 2 have NOT been run and no fixed capability matrix is claimed.

Other corrections: the migration checker run in the prior turn printed only snapshot success and exited 0; it did not print an explicit live-check skip. The model manifest has a complete byte count/hash for MediaPipe, so the prior statement that ALL model entries have null bytes is false. U-Net/Whisper byte sizes and VAE immutable identity remain incomplete.

Next: implement corrected Prompt 2; do not advance to Prompt 3 or claim release readiness.
