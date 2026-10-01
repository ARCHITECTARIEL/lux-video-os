# VIDEO OS — MVP execution prompts



Use with [completion plan](MVP-COMPLETION-PLAN-2026-09-29.md). These replace blind replay of earlier prompts: the authorization implementation already exists locally; the ZIP itself contains no execution-prompt pack. Paste the common contract plus one numbered prompt. Run sequentially unless the ownership map explicitly permits parallel work.



## Latest checkpoint — runtime wiring complete locally

Read [the October 1 runtime receipt](execution-notes/20261001-runtime-wiring.md). Canonical production DB provenance is confirmed and the local binding/claim/receipt/continuation path is verified. Source is `77a5fd7de66f5ecbe8e2b6852bac882ad43da218a7dc285e53a31a05153e5ee4`. No production migration or activation occurred. This prompt supersedes the historical qualification prompts below:

```text
Continue from docs/execution-notes/20261001-runtime-wiring.md and docs/CURRENT-MVP-HANDOFF.md. Preserve the verified local wiring and inherited dirty work. Canonical production target is config/database-target.production.json: still-voice-83326863 / br-broad-sunset-awrsmiwa / neondb. Read-only production inspection proved an exact seven-migration prefix; 0007 through 0010 are missing. Do not repeat account discovery, reimplement runtime wiring or reset a secret merely to identify the target.

Prepare the bounded migration rehearsal described in docs/execution-notes/runtime-wiring-20261001/production-migration-next-step.md. Review the exact pending SQL and existing-data constraints, identify the disposable rehearsal target and restore/abort plan, then obtain any necessary exact provider-resource scope before creating a branch. Production application requires its own reviewed command and owner authorization; the October 1 approval covered read-only inspection only. Never rewrite applied migrations or weaken the canonical schema lock.

Keep provider creation, production binding and deletion execution disabled. Resolve production freshness policy and Workflow raw-provider-URL custody before activation. The verification anchor expires 2026-10-02T15:11:53.953Z; do not extend it or replay the exhausted probe. Retain the devalue 5.9.4 security backport and inventory/reconcile existing provider operations before any Workflow deployment cutover; never blindly recreate an uncertain upload/clone/render. Finish with exact candidate evidence, current handoff and a dated tagged wiki/log.md entry. No deployment, provider mutation or spending is implied.
```

## Historical checkpoint - temporary provider bridge

**Foundation implemented:** follow [the latest execution note](execution-notes/20260930-bridge-foundation.md) for the exact candidate and verification receipts. Consent-v2, normalized provenance, account guards, signed plan validation and read-only plan/status now exist. Deletion execution and provider activation remain disabled. Do not reimplement this foundation or restart from `b2e7e583`.

Owner selected [the reviewed temporary-upload bridge design](HEYGEN-BRIDGE-TEMP-UPLOAD-DESIGN.md). Official deletion APIs are documented; actual raw-source independence and old-URL denial remain unverified. Read the [reconciliation runbook](HEYGEN-RECONCILIATION-RUNBOOK.md) and [frozen contract](HEYGEN-RECONCILIATION-CONTRACT.md).

Next bounded prompt — provider qualification and binding:

**Latest completed scope:** the [verification-only space binding layer](execution-notes/20261001-local-space-binding.md) now exists and passed actual isolated DB and standalone CLI proofs. Do not replay its implementation. Use the following updated prompt before the older qualification-history text:

```text
Continue from docs/execution-notes/20261001-local-space-binding.md and docs/HEYGEN-SPACE-BINDING-RUNBOOK.md. Preserve source 0ae748b0 and inherited work. The key and namespaced provider space are proved, and the isolated binding/resolver is implemented; no production binding is active. Establish the canonical production DATABASE_URL target with independent evidence or prepare a concrete owner-reviewed re-establishment proposal. Runtime timing only identifies a leading candidate; do not substitute the older local URL or integration-prefixed values. Do not print credentials.

Prepare the production binding/freshness policy and private evidence custody before extending the verification-only resolver or wiring paid call sites. The current local anchor has a 24-hour policy and production re-probe policy is unset; do not silently extend it, edit pinned receipts, serialize authority across workflow steps, or rerun the exhausted probe. Keep all existing entitlement/consent/quote/lifecycle and release gates. Any production configuration, schema, deployment, new provider mutation or spend needs its exact separately authorized scope. Finish with source-bound checks, updated handoff and wiki/log.md.
```

October 1 progress: the owner-created key ending `C2b1` is authenticated, and an explicitly approved disposable asset probe now supplies namespaced provider-space evidence. Upload/read/delete/readback succeeded with exact owner/ID checks and final `404 asset_not_found`. Resume from [the latest proof](execution-notes/20261001-binding-readiness.md). No raw global account/workspace identity was invented; the app runtime/DB binding remains unwritten. The canonical production DB target is still unverified despite a leading candidate from runtime timing. Do not ask again for the supplied key, replay the completed probe, substitute the old `1Tr0` key, or use the older local/integration-prefixed DB URL as canonical proof.

```text
Continue the verified local foundation described in docs/execution-notes/20260930-bridge-foundation.md. Preserve the dirty candidate and immutable migration history (0009 plus additive 0010); do not replay the old implementation prompt. First qualify the exact intended HeyGen application credential/account/scopes using read-only official evidence, and document actual capability, cost and privacy/retention limits. A connected HeyGen profile, environment boolean or provisional credential fingerprint is not verified application-account authority. Never print keys or raw media URLs. Securely establish canonical production DATABASE_URL and Preview private-Blob credential identity without substituting integration-prefixed credentials or querying an unproved target.

Once independently supported evidence exists, prepare and test the local server-side binding/promotion path and its expiry/rotation/revocation checks. Keep creation/render activation off. The current identity route and render workflow intentionally lack a qualified providerBinding and must fail closed until this path is reviewed. Do not broaden the existing single-origin graph across credential rotation. Record unavailable evidence as an explicit hold, not a fabricated promotion. Use only the pinned isolated DB/Blob for writes and tests. No provider upload, clone, render, DELETE, paid call, support email, production mutation, push or deployment. Update handoff, evidence and wiki/log.md. The following step is the reviewed atomic nonce/budget claim-and-resume executor, then an exact disposable Phase A/Phase B canary proposal with owner-controlled execution scope.
```

The older checkpoint below records the preceding enrollment implementation and is superseded where it describes Sandbox work or the next prompt.

## Current checkpoint and next prompt - September 30



The one-time phone photo/video, consented audio extraction and shared Standard/Premium script interfaces are implemented locally. Start with [the runbook](PHONE-ENROLLMENT-RUNBOOK.md) and [execution evidence](execution-notes/20260930-phone-enrollment.md). Earlier phone-video/provider-choice prompts below are historical context; do not rebuild the feature or restart the provider decision.



```text

Continue from the phone-enrollment implementation in C:\Users\ariel\lux-video-os. Preserve the reviewed dirty source. Recheck the exact current candidate against the latest execution note, source ledger, nine-migration/18-table baseline and test receipts. First finish Prompt6's product claims and provider capability review: confirm the intended HeyGen account can create the photo avatar and reusable voice and render the required formats; document actual account pricing, limits, retention/deletion behavior and the Standard credit decision without making paid enrollment/render calls. Compare those facts with the disabled-by-default UI and server capabilities; fix only verified local discrepancies.



In parallel, finish the existing release prerequisites: canonical production DATABASE_URL and private store identity, storage reference/preview credential proof, the known Workflow/Sandbox packaging boundary, and current-candidate CI/CodeQL when publication is authorized. Keep free/open-source ROI research separate. Do not enable flags, migrate production, clone a real voice, spend provider credits or deploy. Prepare a concrete bounded pilot proposal naming the exact candidate, migrations 0007/0008, target/alias, enabled tiers, real-device cases, provider spend/retry ceiling, rollback and private evidence destination. Execute only under the owner's scoped authorization. Record the result in CURRENT-MVP-HANDOFF.md, the execution note and wiki/log.md.

```



## Common contract — include with every prompt



```text

Work in C:\Users\ariel\lux-video-os. Read HANDOFF.md, docs/CURRENT-MVP-HANDOFF.md, docs/MVP-COMPLETION-PLAN-2026-09-29.md, docs/P0-RELEASE-GATE.md and the latest docs/execution-notes entry first. Verify current HEAD, remote identity, git status and the actual .vercel/project.json before acting. Preserve all inherited dirty work. The September 29 audit started at 1c6121f83dd455fc8fbac4c96332a284dd9e0bb9 plus an uncommitted authorization repair; rebaseline if this changed. Do not restore ZIP contents over the checkout or use orphaned worktrees.



Execute the requested bounded local implementation and verification. Use existing patterns and dependencies. Reproduce a claimed defect before changing it; if stale, record the corrected diagnosis and continue only within the same intent. No production deployment, production environment write, migration, provider spend, image publication, billing activation, merge or push is authorized by this prompt. Prepare concrete evidence for any later authorized external step. No secrets/customer media in notes. No mock success presented as real provider/DB acceptance.



When delegating, use bounded native specialist agents with distinct files; agents are not alone and must preserve others' edits. Lead owns repositories, workflows and integration. Follow reference-first-ui/Lazyweb requirements before visual product changes. Run relevant regressions, imports, workflow checks and broader checks appropriate to the final diff. Explicitly report unavailable integration coverage; never count skips as passes.



Before finishing, write docs/execution-notes/<UTC-timestamp>-<lane>-<task>.md with timestamp, start/end SHA, inherited and new file changes, root cause, behavior, commands/exits/counts/skips, target identity, evidence, residual risks and exact next prompt. The integration lead alone updates docs/CURRENT-MVP-HANDOFF.md and appends wiki/log.md; delegated agents return their unique note for sequential integration. If committing is authorized, use the repository Lore commit protocol and include only reviewed scoped files. Do not mark deployed or accepted without actual evidence.

Coordination amendment: only the integration lead updates CURRENT-MVP-HANDOFF, the plan, and wiki/log.md. Delegated agents write timestamp-and-lane-unique execution notes and return evidence; the lead integrates sequentially. Before modifying inherited repairs, save a binary patch and copied untracked source/tests with SHA-256 manifest in a safe local location, or use an explicitly authorized reviewed local commit. Record this baseline identity before edits.



Numbering: this revised pack's Prompt 1 validates the already-implemented old Prompt 2; revised Prompt 2 corresponds to the old Prompt 3 DTO work. Every “Next: Prompt N” below means the corresponding numbered heading in docs/MVP-EXECUTION-PROMPTS-2026-09-29.md, never an earlier pack. When writing a handoff, cite this pack's path and full heading.

```



## 1 — Validate and preserve the existing authorization repair



```text

Audit and finish verification of the existing local authorization repair; do not reimplement old ZIP Prompt 2. Read docs/execution-notes/02-authorization-handoff.md (current section supersedes historical reproduction). Review auth.js, render-v2.js, both repositories, security/testers helpers, new video-os-render-authorization.js and both render workflows. Confirm tier selection precedes tier authority; admin list has no grant side effects; domain-only users cannot gain Premium; persisted grants and revocations survive sign-in; cold workers check persisted authority and job binding; replay and legacy accounts are correct. Run safe offline scenarios first, then real isolated non-production DB/Blob tests only after verifying resource identity. Include Google and magic-link → admin list → sign-in, expired/revoked/wrong-tier/wrong-account grants, admin-created legacy IDs and recovery without resubmission. Record skipped live cases precisely and prepare a reviewable patch/commit boundary. Next: Prompt 2, with live integration coverage still an explicit release prerequisite if unavailable.

Prompt 1 also owns the remaining talent-route consistency gap: `api/video-os/talent.js:118` still uses the legacy containment/exact-email rule. Test persisted admin Premium grant, Standard-only denial, revoked grant and cold process across both talent discovery and render submission, without exposing provider identifiers.

```



## 2 — Persist accepted-output truth and make My Videos work



```text

Repair the completed-output contract spanning db/dto.js, history/results/finalize responses and public/studio.js. Reproduce the real jobDto omission of tier/outputAccepted against resultAccepted(), without adding fields only to fixtures. Define acceptance from persisted validated-output evidence, not status SUCCEEDED alone. Coordinate this schema/contract with Prompt 3; do not authorize download or display false completion for unvalidated legacy artifacts. Add tests using the actual DTO and routes, including ready accepted, ready unaccepted, failed, missing output, Standard and Premium. Verify fresh browser context/history recovery and retain anonymous 401/wrong-account 404. Do not relax privacy sanitization or expose provider IDs/private source URLs. Next: Prompt 3 before production acceptance.

```



## 3 — Reject unusable media before ready status or debit



```text

Implement one shared final-media acceptance contract used by every enabled Standard/Premium/HyperFrames finalization path. First map all callers of finalizeReadyJob and all storage writes. Use existing ffmpeg tooling to validate full decode, required audio/video streams, agreed input/output duration tolerance, dimensions, byte limits and SHA-256. Establish concrete tolerances in tests and document them. Ensure terminal-ready and debit happen only after acceptance; preserve idempotency and release reserved credits on terminal rejection according to the existing ledger contract. Test corrupt/truncated MP4, header-only file, missing audio/video, invalid duration/dimensions and duplicate/recovery races. Keep accepted artifacts private, bind validation to exact bytes and verify downloaded hash. Integrate with Prompt 2's persisted DTO contract; no fixture-only success. Next: Prompt 4 and the selected provider lane.

Media tooling clarification: verify ffprobe availability first; package.json currently supplies ffmpeg-static, not a demonstrated ffprobe binary. Use existing verified tools for an equivalent inspection/decode contract if feasible. Do not add a dependency without explicit approval.

```



## 4 — Make deployment and operational checks fail closed



```text

Repair tools/check-migrations.mjs and tools/build-production.mjs so a production check fails without verified target DB identity, on schema/migration drift and on connectivity failure. Inspect Drizzle's actual migration journal/schema/hash semantics; replace count/index heuristics with a justified exact check. db:check only checks snapshots and is not live schema proof. Do not automatically migrate production. Add tests for absent URL, wrong target, missing journal, equal-count wrong hashes, missing migration, query error and correct state. Resolve current CodeQL clear-text-logging at tools/setup-stripe-products.mjs without weakening the SARIF gate. Make Stripe reconciliation mismatch fail its scheduled workflow even when HTTP is 200. Investigate the baseline Sandbox serialization warning using isolated builds and runtime evidence; document any real compatibility limit. Produce source/deployment/image/migration manifest and rollback instructions; never relink or deploy as part of this prompt. Next: Prompt 5 plus current-SHA CI verification when publishing is authorized.

Prompt 4 additionally owns `tools/verify-p0-release-gate.mjs`: it currently fabricates VERIFIED/APPROVED observations without checking evidence. Replace or disable that behavior. Missing, forged, stale, wrong-account, wrong-job or wrong-deployment observations must fail closed; do not generate an approved receipt from CLI IDs alone. Keep raw evidence private and bind receipt observations to captured correlation/provider/artifact identities. Add negative tests before this tool can participate in release signoff.



Prompt 4 additionally owns private-storage migration readiness: read-only inventory of legacy public objects/references, counts/hashes, proposed private copies and reference migration, rollback, and denial verification. Prepare first; production writes/deletion need explicit approval and cannot be inferred from the plan. Supply an expected nonsecret database target identity manifest and compare live identity to it before migration verification. Complete evidence is required before Prompt 8 release.

```



## 5 — Resolve Standard provider contract and commercial provenance



Status (September 30): **Owner confirmed photo-based output, one-time phone recording, and scripts for BOTH Standard and Premium.** Use [the staged plan](SCRIPTED-PHOTO-MVP-PLAN.md) and [current decision](STANDARD-PROVIDER-DECISION.md). The photo is the visual source; consented internal audio extraction can supply the reusable voice without a third user upload. Current Premium tier-marker parsing is repaired locally. Owner selected HeyGen for BOTH MVP tiers. The shared script backend foundation is implemented locally and disabled by default; see [the backend note](execution-notes/20260930-shared-heygen-backend.md). Next implement phone-video enrollment, derived-voice consent/storage, versioned project creation and frontend/quote integration. Continue that path; continue free/open-source ROI research independently without delaying MVP or authorizing paid benchmarks. Do not repeat per-video narration or direct-video-only LatentSync implementation. The generic historical prompt below is subordinate to this newer owner direction.



```text

**5A — decision/provenance only:** if no recorded owner choice exists, produce the comparison and provenance inventory, then stop this lane before input-flow implementation. Independent lanes may continue. **5B — implementation:** execute the chosen contract only after an explicit recorded choice. For a Premium-only pilot, fail closed for Standard in server capabilities, API and UI, and label the release reduced-scope; it does not complete the two-tier MVP.



First read the owner's Standard decision in the current handoff. If absent, prepare a concrete comparison of keeping portrait+narration with a compatible worker, implementing source-video+narration for LatentSync, and deferring Standard for an explicitly reduced-scope pilot. Do not select a materially different input flow silently. Independently complete workers/latentsync-runpod model provenance inventory: exact source/revision, bytes, hashes, existing license record paths and unresolved commercial terms; distinguish code license from weight/VAE license. Do not claim legal approval yourself.



For the chosen authorized implementation, version the browser-upload-storage-consent-quote-adapter-worker envelope end to end. Bind owned source hashes and reject stale/tampered/replayed inputs; never manufacture a fake source video to satisfy schema. Worker must enforce immutable model identity and reject simulated output for real inference proof. Test actual adapter/handler contract, resource limits and failures without paid calls. Keep provider disabled until licensing and real deployment/canary evidence are complete. No image push, RunPod mutation or paid inference in this prompt. Next: Prompt 6, then Prompt 8 after release prerequisites.

```



## 6 — Align offered capabilities and product claims with reality



```text

Inspect providerList(), the Premium composition catalog and hyperframes-finisher. Ensure each offered composition/ratio is actually consumed and validated, or explicitly unavailable through server-driven capability data. Do not grow the cinematic feature set to finish MVP. Add real metadata/renderer integration tests instead of injecting compositionAvailable only in fixtures. Correct unsupported both-tiers-live, training/privacy and analytics wording using verified data practices; flag legal review separately. Preserve the current visual design unless a functional change requires it; follow reference-first UI instructions for visual work. Recheck consent recovery UX and Copywriter persistence promises, implementing only agreed MVP behavior. Next: Prompt 7 for paid-launch prep or Prompt 8 for an authorized contained proof.

```



## 7 — Prepare billing, without activating live charges



```text

Audit checkout-v2, stripe-webhook-v2, credit ledger and reconciliation against current P0 restrictions. Production Stripe names were absent at audit time; verify names only and never print values. Implement/test exactly-once credit grants, duplicate and out-of-order webhook handling, invalid signature rejection, refund policy and reconciliation failure visibility in test mode using isolated resources. Record exact required price/webhook/account configuration and owner decisions; do not run setup-stripe-products with live keys or enable billing. Billing stays disabled until P0 proof clears and owner authorizes activation. Next: Prompt 8, then a separately authorized live billing configuration/verification step for paid launch.

```



## 8 — Prepare, authorize and verify a bounded release



```text

Prepare the exact reviewed candidate for the owner's chosen launch scope. Require Prompts 1–6 evidence and Prompt 7 for paid launch, current-source CI/CodeQL, non-production DB/Blob integration, actual migration identity, private-storage migration evidence, worker/model provenance and no unaccounted dirty source. Re-read the Vercel project link and stable alias. Produce a concrete release proposal with commit/build/image IDs, target, env names, migrations if any, rollback identity, one-job-per-tier spend ceiling and private receipt destination. Stop before external execution unless the owner already authorized this exact release/spend.



Once authorized, execute only that scope and capture all nine observations in docs/P0-RELEASE-GATE.md for each launched tier: real browser session/input, new unique provider job, validated private MP4, original and fresh-session history, matching downloaded bytes, anonymous/wrong-account/direct-Blob denial, exactly one submission/debit/final event. No seeded results/manual repair can satisfy proof. Re-read stable production alias and deployed identity, correlate watchdog/reconciliation and record private receipt hash. If any gate fails, contain the affected tier and report the failing invariant; no repeated paid retries without the agreed budget. Next: Prompt 9.

Prompt 8 execution boundary: prepare and execute are separate phases. Before any external write, require a dated approval envelope naming candidate SHA/build, project ID, alias, enabled tiers, exact env/migration changes, spend and retry ceiling, rollback identity and private receipt location. Verify those values still match at execution; any mismatch requires revised scope/approval. A generic prior approval or READY preview is insufficient.

```



## 9 — Verify developer handoff and declare only proven completion



```text

Independently compare the completed scope against docs/MVP-COMPLETION-PLAN-2026-09-29.md and P0 receipt. Update docs/CURRENT-MVP-HANDOFF.md with canonical repo/branch/SHA, dirty state, deployment/alias, enabled tiers, provider/image/migration identity, CI links, private receipt reference/hash, tests/skips and owner decisions. Preserve historical notes with clear supersession markers. Ensure README and HANDOFF direct developers to current truth; remove active instructions that rely on stale PRs or an obsolete Vercel link. Check all local documentation links. State whether result is local candidate, contained pilot, two-tier MVP or public paid launch. A new developer must find a single exact next action, or evidence that no scoped work remains, without reading chat. Do not declare full MVP complete if Standard or applicable launch gates are deferred.

```



## Required execution-note template



```markdown

# <task> — <UTC timestamp>

Status: planned / implemented-local / verified-local / verified-integration / deployed / accepted-production

Scope and owner:

Start/end SHA; branch; inherited dirty files:

Target identities (no credentials):

Diagnosis and changes; files owned:

Verification: command | exit | passes/failures/skips | evidence path

External actions actually taken (or none):

Remaining risks / unverified behavior:

Decisions and approvals used:

Exact next prompt and prerequisites:

```

