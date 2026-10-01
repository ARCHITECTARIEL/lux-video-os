# VIDEO OS MVP completion plan

Date: 2026-09-29. Status: audited plan, **not a release approval**. Current local baseline: `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9` plus inherited, uncommitted authorization repair. Audit index: [current handoff](CURRENT-MVP-HANDOFF.md). Execution instructions: [prompt pack](MVP-EXECUTION-PROMPTS-2026-09-29.md).

## Temporary-upload bridge checkpoint - September30

The local foundation is now implemented: six-scope consent/re-consent, immutable provider ledger and guarded lifecycle, source-bound signed plans, and read-only reconciliation commands. See [the new execution note](execution-notes/20260930-bridge-foundation.md) for exact tests, isolated migrations and packaging status. Next is app-key/account qualification and server-side binding; the atomic deletion executor and real disposable canary remain separate later steps. The older checkpoint paragraph below describes the design milestone.

The owner selected Video OS as a bridge to HeyGen, with temporary public provider source assets, retained reusable avatar/voice references and private accepted final videos. [The reviewed design](HEYGEN-BRIDGE-TEMP-UPLOAD-DESIGN.md) and test specification define the next local implementation. Live source-dependency and CDN-denial canaries remain mandatory; no remote cleanup has been executed. The fresh local build clears the Sandbox import-graph gate and correctly treats a worker image as inapplicable to the selected managed API while retaining provider/runtime proof gates. [Execution evidence](execution-notes/20260930-heygen-bridge-release-gates.md).

## MVP provider decision - 2026-09-30

Owner selected **HeyGen for both Standard and Premium for the MVP**, while continuing free/open-source/self-hosted exploration to improve ROI. This resolves the backend choice; lower-cost research does not block MVP implementation. Use the [shared script plan](SCRIPTED-PHOTO-MVP-PLAN.md). The shared backend and one-time phone enrollment, consented voice extraction, project/quote and browser interfaces are now implemented locally: [execution note](execution-notes/20260930-phone-enrollment.md), [runbook](PHONE-ENROLLMENT-RUNBOOK.md). New rendering stays off by default; hosted/provider and release proof remain. [ROI research](LOW-COST-RENDERING-RESEARCH.md) continues independently. Production calls/deployment and a public free pricing plan are not authorized by this decision.

## Record-once scripts update - 2026-09-30

Owner confirmed one-time photo/phone-video setup, followed by scripts in both Standard and Premium; the photo defines final appearance. [The staged plan](SCRIPTED-PHOTO-MVP-PLAN.md) reuses current photo-avatar/voice/Premium work, introduces consent-bound derived audio internally, and versions Standard's new script contract. The Premium tier-marker parser defect is repaired locally. Implement the owner-selected HeyGen path for both tiers; retain low-cost alternatives as separate research. No recurring recordings or third user media upload are part of the desired flow.

## Historical Lane D preparation - superseded by the implementation above

Prompt 5A decision/provenance preparation is complete. [Owner decision brief](STANDARD-PROVIDER-DECISION.md) now records the owner's confirmed photo-based animated output, with a required supporting phone video. This supersedes provisional direct-video option B. At that earlier checkpoint, video purpose, narration source and photo-animation engine were open; the owner subsequently selected consented voice extraction and HeyGen for both tiers. [Provenance inventory](standard-provider-provenance/INVENTORY.md) supplies publisher-pinned checkpoint identities, a candidate VAE file set, exact archived license/config evidence, and the missing runtime/image proof. Code, runtime manifest and provider configuration are unchanged. Do not replay that obsolete decision step: the local photo/voice/script contract is now implemented, and model/worker research belongs to the separate ROI track. Independent Prompt 6 preparation remains possible; this does not clear Standard or production release.

## Lane C update - 2026-09-30

Prompt 4 local release checks are implemented and isolated live migration faults verified. Fabricated P0 signoff is disabled; CodeQL account logging removed; reconciliation mismatches fail automation. Preview packaging is diagnostic and quarantined. Production still requires canonical DB mapping/reference inventory, preview credential reconciliation, Sandbox workflow repair, exact-candidate hosted CI/CodeQL and authorized real P0 proof. See [execution note](execution-notes/20260930-prompt4.md) and [preflight/rollback instructions](RELEASE-PREFLIGHT.md). Next independent lane: Prompt 5A decision/provenance preparation. Older lane updates below are dated history; the current handoff records subsequent live verification.

## Lane A update - 2026-09-29

Prompt 1 is implemented-local / verified-local: persisted talent permission, transactional submission check, exact Premium replay, normalized legacy lookup and explicit revoke precedence are covered locally. Unit result: 311 Node pass / 40 skipped, four Vitest pass. Live integration remains pending because the local URL maps to default/main, not a verified isolated target, and Blob credentials are absent. See [execution note](execution-notes/20260929T202952Z-A-prompt1.md). Next independent local work: Prompt 2; do not infer release readiness.

## Lane B update - 2026-09-29

Prompt 2 read-side acceptance/history/status/download/email contract is implemented-local and verified-local: 315 Node passes/40 skips, four Vitest passes, 31 browser tests. Prompt 3 must produce the acceptance evidence, protect immutable stored bytes, and gate debit/ready atomically; until then real outputs remain unavailable. Read [acceptance contract](OUTPUT-ACCEPTANCE-CONTRACT.md) and [execution note](execution-notes/20260929T204451Z-B-prompt2.md). Also reproduce the adjacent Premium tier-field/schema mismatch before release; output tests do not cover real submission.

## Lane B Prompt 3 update - 2026-09-30

Real stored-media decoding, immutable storage, hash-verified downloads, atomic ready/debit and retry handling are implemented locally. 42 focused checks pass; local HyperFrames source/output duration proof passes. The last full suite is not green: 334 passes, 40 skips, one npm-audit failure covering five advisories (one critical). See [execution note](execution-notes/20260929T211246Z-B-prompt3.md). Next is Prompt 4, including dependency-gate remediation without silently adding exceptions. Live DB/Blob concurrency and hosted capacity remain release gates.

## Dependency and isolated-live update - 2026-09-30

The five named dependency advisories and the discovered tar critical are removed; runtime audit is zero. Separate live DB/Blob suite passes 102 checks without skips, including real row-lock revocation and concurrent settlement. Final cleanup confirms zero application rows and zero objects. Local unit suite passes (336 Node, four Vitest; 41 credential skips covered separately where listed). Full dev-inclusive audit retains 43 unrelated noncritical findings. Read [latest execution note](execution-notes/20260930-security-live-verification.md); remaining Prompt 4 and production P0 gates are not waived.

## MVP outcome and boundaries

An eligible customer signs in, supplies authorized inputs, sees an accurate credit quote, submits once, receives an accepted private video, finds it in a fresh session, and downloads the same bytes. Invalid output never becomes billable success. Unauthorized users never gain provider access or another account's media. Operations can identify and recover a failed job without duplicate submissions or charges.

Plan assumption: Vercel is the launch target. VPS deployment, new providers, expanded cinematic effects, new dashboards and cosmetic redesign are outside the MVP critical path. Preserve implemented features that meet the contracts; do not expand them for this plan.

The owner requires the finished video to animate the uploaded photo's appearance. Users upload a phone photo and record a phone video once, then create future videos from scripts in both tiers. The local implementation derives a reusable voice sample under explicit consent; HeyGen is selected for both MVP tiers. LatentSync alone cannot animate the photo. Qualify the selected HeyGen account and preserve the implemented consent/hash/acceptance contracts. The prior direct-video option B and thumbnail-only recommendation are superseded.

## Evidence-backed sequence

| Lane / priority | Ownership and scope | Prerequisites | Acceptance / exit evidence |
|---|---|---|---|
| A — P0: preserve and validate authorization | Integration owner; `lib/video-os-render-authorization.js`, auth/security/testers, repositories, render route, both workflows | Preserve dirty baseline; read execution note 02 | Review current repair rather than redo it; safe local suite passes; non-production DB/Blob regressions cover real sign-in → admin list → sign-in, revocation, legacy account identity, cold worker and replay. Zero new Premium grants from domain membership/listing. Commit/PR records exact tested source when authorized. |
| B — P0: accepted-output and history contract | DTO and media specialists, serialized repository/workflow edits; `db/dto.js:125`, `public/studio.js:177`, finishers, finalization | A for integrated runtime; media/DTO test design can start in parallel | One explicit server acceptance contract; DTO returns tier and acceptance from persisted validation, never just status. ffprobe + full decode, audio/video streams, duration/dimension/size limits and hash checks precede final-ready/debit. Truncated, silent/missing-stream, mismatched-duration and corrupt media fail with no debit. Fresh-session real API history renders accepted output; anonymous 401/wrong-account 404 remain. |
| C — P0: deployment/CI integrity | Release engineer; `tools/check-migrations.mjs`, `tools/build-production.mjs`, `.github/workflows/*`, Stripe admin reconciliation | Can start independently; integrate after A/B | Production verification fails on absent/wrong DB identity, drift, missing journal, connection error and mismatch. Verify actual migration hashes/schema rather than row-count heuristics. `db:check` is snapshot checking only. Current-SHA CI and CodeQL pass. Stripe reconciliation mismatch causes job failure. Resolve/contain Sandbox workflow serialization warning with target-runtime evidence. Release manifest binds commit, dirty state, build, image and migration evidence. |
| D - P0 for shared HeyGen enrollment and scripts | Enrollment/provider engineer; browser, API, quote, storage and identity/render workflows | Implemented photo/video/consent/script contracts; shared media acceptance | Exact owned photo/derived voice and consent bind reusable provider resources and each quote. Real account capability, price, privacy and one-job-per-tier provider proof remain required. Model/image provenance belongs to the separate self-hosted ROI track. No simulated output admitted as real generation proof. |
| E — P1: advertised composition and product truth | Product engineer; provider capabilities, composition catalog/finisher, public copy | B; D decision; coordinate `public/studio.js` with B/D | Every advertised composition is consumed by actual renderer, or unavailable choices are honestly disabled. Aspect ratio/duration/audio verified. Privacy accurately describes analytics and subprocessors; remove unsupported “both tiers live” claims. Copywriter persistence is required only if promised in accepted scope. Use reference-first UI workflow for visual changes. |
| F — P0 for public paid launch: billing | Billing engineer; checkout/webhook/admin reconciliation and tests | B/C, owner-approved Stripe configuration, P0 gates | Test-mode purchase grants exactly once, duplicate/out-of-order webhooks safe, refund policy explicit, ledger reconciles, failure fails automation. Stripe live keys/prices/webhook configured only with authorization. Billing remains disabled until existing P0 gate is cleared and owner approves activation. |
| G — release proof | Integration owner + independent verifier | A–E for chosen pilot tiers; F for paid launch; authorization for deploy/spend | Exact candidate deployed to approved target; bounded production proof meets all nine observations in `P0-RELEASE-GATE.md` for each launched tier. Signed-in browser inputs, provider identity, private validated MP4, fresh-session gallery, download hash, denial checks, one submission/debit/artifact. Private canonical receipt + safe hash/reference. |
| H — developer continuity | Integration owner | Every lane | Update current handoff, execution note and append-only work log after each lane; record SHAs, file ownership, commands/exits/skips, unresolved risks and exact next prompt. Another developer can resume without reading chat. |

Additional audited requirements: Lane A must align `api/video-os/talent.js:118` with persisted Premium authority, including admin grants and revocation. Lane C must replace/disable the unconditional VERIFIED/APPROVED behavior in `tools/verify-p0-release-gate.mjs:46-108`; a fabricated, missing, stale or mismatched observation must fail. This existing script is not proof that P0 has ever cleared.

## Staffing and integration rules

Use native agents in Codex App: integration lead, authorization/security reviewer, DTO/media executor, release/test engineer, provider/provenance investigator, independent verifier. Maximum six children; use only as many as independently useful. OMX team requires an attached tmux OMX shell and is optional, not a prerequisite.

Safe parallel starts: audit/review of A, isolated release work C, read-only provenance D. Serialize edits to `db/repositories.js`, `db/standard-narration-repository.js`, `db/dto.js`, `api/video-os-lite/render-v2.js`, workflows, `public/studio.js`, `package.json`, lockfile and migrations through the integration owner. No agent overwrites inherited changes. Never run concurrent DB-mutating suites against the same test account/database.

Lane C also owns the private-storage migration prerequisite from P0: first inventory legacy public objects and references read-only; prepare counts, hashes, private-copy verification, reference migration, rollback and direct-access denial tests. Any production copy/reference write/public-object removal requires exact approval; never silently delete originals. No release until the approved migration has verifiable completion evidence.

Before Lane A changes inherited source, preserve an immutable baseline: binary Git patch plus SHA-256 manifest and copies of relevant untracked source/tests in a safe local directory, or an explicitly authorized reviewed local commit. Record baseline hashes. Integration lead exclusively edits shared handoff/work-log/plan files; lane agents write unique timestamp-and-lane notes, avoiding numbered-note collisions.

For DB verification, the release owner supplies an expected nonsecret target identity manifest/fingerprint; compare the queried database identity against that expected value before evaluating migrations. Do not infer production from an environment-variable name alone.

Media tooling must use available verified binaries. `ffmpeg-static` is installed; ffprobe availability is not established. Check availability first, use an equivalent justified probe/decode contract with existing tooling where possible, or request explicit approval before introducing a dependency. The acceptance requirements are mandatory regardless of implementation.

## Verification matrix

1. Baseline: Git status/diff and current HEAD, ZIP hash, remote SHA, target link and alias deployment. Preserve inherited changes separately from new edits.
2. Local: `npm run test:unit`, `npm run check:imports`, `npm run workflow:validate`, workflow build and syntax checks. Record exact exit and pass/fail/skip counts. Package currently has no lint/typecheck script; do not invent a passing result.
3. Isolated integration: explicitly identified non-production Neon/Blob resources; real repository/handler/worker behavior, cleanup receipt, account/credit counts before/after. A skipped test is unverified, not passed.
4. Browser: real route DTOs and persisted state, both supported input flows, reload/fresh-context recovery, denied cross-account access. Fixture-only e2e does not prove deployed provider/SQL behavior.
5. Adversarial media/provider: invalid artifacts, timeout, restart, repeated request, callback/recovery races, revoked grant and duplicate provider notification; no duplicate debit/submission.
6. Release: current-source CI/CodeQL plus deployment/migration identity; existing nine-observation P0 receipt. Watchdog success on an older SHA is not current-candidate verification.

## Risks and mitigations

- Older production can hide new regressions: certify the exact candidate, then re-read stable alias after authorized promotion.
- Dirty repair can be lost or omitted: inventory/hash it first, isolate follow-up edits, integrate and review explicitly.
- Fixture DTOs can hide a broken gallery: test the real `jobDto` through history/finalize to browser.
- Weak media checks can charge for unusable output: central acceptance before the terminal state/debit transaction.
- Missing DB identity can make a green build meaningless: fail closed and independently read migration/schema evidence.
- Provider contract or licensing can block Standard: keep tier disabled until compatible, provenance-approved inference exists; use Premium-only only as a deliberate reduced-scope pilot.
- Consent timeout can recur: capture per-stage latency and correlation through real consent and quote calls; do not assume the old cold-start theory.

## Decisions still needed at execution boundaries

HeyGen account economics, limits and supported photo/voice capabilities; commercial model and legal-copy approval; repository visibility if current repository is public; exact test resources; maximum spend and target for each canary; live billing enablement. These do not block local audit, planning or reversible code preparation. No production action is authorized by this plan alone.

## Completion rule

Do not use percentage-complete estimates. Mark each lane `planned`, `implemented-local`, `verified-local`, `verified-integration`, `deployed`, or `accepted-production`, with evidence. MVP is complete only when the selected scope satisfies all applicable gates and H is current. Pending owner decisions are explicit, never silently waived.
