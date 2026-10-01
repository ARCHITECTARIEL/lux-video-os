> Local implementation updated 2026-09-30. Prompt 4 refreshed production alias/storage metadata; GitHub findings below retain their dated audit scope unless stated otherwise.

# VIDEO OS — current developer handoff

**Last audited: 2026-10-01. Start here after root HANDOFF.md.** This file supersedes older status, priority, branch and deployment claims in HANDOFF.md, DEVELOPER_HANDOFF.md, README.md and the September 29 ZIP. Historical architecture notes remain references, not release evidence.

## Latest October 1 (afternoon) — production migrations 0007-0010 applied; HeyGen binding wiring next

With owner approval, migrations `0007`-`0010` were applied to real production (Neon `still-voice-83326863`). Production now has all 11 migrations and the full 27-table catalogue; previously it had 7/11. Functional-contract checks (the specific FKs/constraints/indexes the application depends on) were independently verified against production and pass. A strict full-structural schema-fingerprint comparison against `config/database-schema.lock.json` still fails (`SCHEMA_DRIFT`), most likely pre-existing historical drift in the already-applied `0000`-`0006` portion rather than anything introduced by this migration — the owner has accepted this as non-blocking. See [the execution note](execution-notes/20261001-production-migration-applied.md) for full detail. Also merged this session: PRs #61,62,64,65,66,67 (dependabot), the accumulated local WIP work from the Sept 29-Oct 1 sessions (previously uncommitted — see that work's own notes below), and light-touch branch protection was added to `main` (CI required, force-push/deletion blocked).

**Exact next action:** wire the already-qualified HeyGen provider-space binding into the live creation/render routes (still disabled). Production DB is no longer the blocker for this.

## Earlier October 1 — canonical DB confirmed; runtime wiring verified locally

Read [the completed runtime receipt](execution-notes/20261001-runtime-wiring.md). Enrollment, provider submission, polling/preview and finishing now use canonical resource/job proofs and exact-target binding transactions. Late receipts retain their original target; incomplete submissions are not replayed; uncertain polling and pre-download failures hold for reconciliation. Both provider creation gates and production binding remain disabled.

Canonical production target provenance is **confirmed**: Neon `still-voice-83326863` / `br-broad-sunset-awrsmiwa` / `neondb`. The owner-approved read-only check found **7 of 11 migrations applied**, with `0007`–`0010` missing and 16 tables versus 27 expected. See [the evidence](execution-notes/runtime-wiring-20261001/canonical-db-investigation.md). No production rows, schema, environment or deployment were changed; no customer rows were read.

Final tests: **722 Node passed, 47 explicit skips, four Vitest passed**, plus four real isolated DB/Blob suites. Cleanup confirmed 27 empty tables and zero Blob objects. Review packaging passed 42 routes / 29 steps / six workflows; actual file tracing and artifact readback found no recursive output or private-file inclusion. A newly surfaced `devalue` advisory family was repaired with the scoped `5.9.4` backport while retaining Workflow `4.8.9`; runtime audit is zero, and no advisory exception was added.

Source is `77a5fd7de66f5ecbe8e2b6852bac882ad43da218a7dc285e53a31a05153e5ee4`; review output is `eff1e634df81ff03c270500dfa38bdd1699f2f63a27b5cf3e262dcf531089e03`. The artifact is quarantined, `.vercel/output` is absent, and no commit, push or deployment occurred.

**Exact next action:** [prepare the four-migration rehearsal](execution-notes/runtime-wiring-20261001/production-migration-next-step.md), then present the exact production application scope for owner approval. Do not replay account discovery, the exhausted asset probe or the completed wiring. Production freshness policy, provider capabilities/privacy/pricing/canaries, private storage, CI/CodeQL, rollback and P0 gates remain. Workflow custody of raw provider URLs needs privacy/retention verification before activation; active old Workflow runs need inventory and provider reconciliation before any version cutover. The verification anchor still expires October 2 at 15:11:53.953 UTC.

## Earlier October 1 — credential and provider-space binding checkpoint

**Newer October 1 investigation:** canonical production target provenance is now confirmed as Neon `still-voice-83326863`, branch `br-broad-sunset-awrsmiwa`, database `neondb`. Historical exact-copy commands and unchanged Vercel variable timestamps resolve the earlier inference-only blocker. The owner-approved read-only inspection found an exact seven-migration prefix (`0000`–`0006`), with `0007`–`0010` missing: 16 tables versus the candidate's 27. See [the database investigation](execution-notes/runtime-wiring-20261001/canonical-db-investigation.md). No production migration, environment update or deployment occurred. Local runtime wiring is being verified; the checkpoint below describes the preceding completed binding phase.

**Latest local implementation:** the verification-only provider-space binding layer is implemented and independently reviewed. It pins the exact 13-file evidence chain, requires fresh process-bound API qualification, creates/reuses the three-row binding graph atomically, and rejects stale, copied, rotated or revoked authority. The real isolated DB test and standalone bootstrap/status CLI both passed; all fixture rows were then removed. **676 Node tests and four Vitest tests passed** (47 explicit skips). Review packaging passed 42 routes, 29 steps and six workflows. No creation/render route has been wired to it and production remains disabled. Read [the binding runbook](HEYGEN-SPACE-BINDING-RUNBOOK.md) and [exact implementation receipt](execution-notes/20261001-local-space-binding.md).

Current source is `0ae748b0f212b5da4d082808461106543db45e052c342fda79f736588a81bd5a`; review output is `fb04cc6cab3491261ade031f657b49a7f2d7cea2fb7af6d042c91cb7e6e8b89c`, quarantined with no default deployable output. The verification anchor expires **October 2, 15:11:53.953 UTC** under a 24-hour local policy; production re-probe policy is unset. Do not extend timestamps or rerun the exhausted provider probe without its own scope.

The owner subsequently **created a new key ending `C2b1`** and saved it in ignored `.env.heygen.local`. Read-only key-self and user-profile checks succeeded: active credential, full permissions, required MVP scopes, and matching owner profile. The paired null expiry fields are recorded without inventing an expiry guarantee. Redacted results and a private receipt reference/hash are in `execution-notes/heygen-binding-20261001/qualification-status.json`. **No runtime/database binding or production credential update has occurred.**

The owner then explicitly approved a disposable provider-space probe. Exactly one 95-byte neutral PNG was uploaded and read; its owner matched the authenticated username and its documented `space_id` was retained privately. Deleting that exact new asset returned 200, followed by documented `404 asset_not_found`. This establishes a **namespaced provider-space association**, not a global account/workspace identity or CDN/backup purge. No generation or mutation retry occurred. See [the new proof and next step](execution-notes/20261001-binding-readiness.md).

The production DB remains the unresolved target: `.env.local` differs from the Vercel integration. Runtime timing supports `still-voice-83326863` as the leading candidate, but does not attest the hidden canonical connection string. No production SQL or configuration change was made. Next is canonical application DB targeting and a reviewed production binding/freshness policy, then controlled runtime wiring; do not reimplement the completed local resolver or substitute the old local/integration-prefixed URL.

The earlier authenticated dashboard inspection identified the old VIDEO OS key dated September 21, suffix `1Tr0`, under workspace display name OSO. That masked key is historical context; do not substitute it for the owner-created replacement. The agent did not create, regenerate, delete or edit either credential in HeyGen.

The earlier credential-only checkpoint passed 605 Node tests and four Vitest tests. Its read-only verifier uses the documented key-self/profile endpoints and cannot by itself promote or activate a binding. The separately approved asset probe and new pinned binding layer extend that evidence without inventing a global account ID. Read [the qualification history](execution-notes/20261001-heygen-account-qualification.md). The latest source ledger is `execution-notes/space-binding-local-20261001/current-source.json`; older hashes below belong to their dated checkpoints.

## Latest provider-bridge decision - September 30

**Latest implementation:** the temporary-provider bridge foundation is implemented locally. It adds six-scope `identity-provider-bridge-v2` consent, existing-source re-consent without rerecording, immutable provider provenance, account-first lifecycle guards, canonical signed plans, bounded provider read adapters and read-only reconciliation commands. `execute` and `resume` are disabled. See [the current execution note](execution-notes/20260930-bridge-foundation.md) for exact source/build evidence and the [operator runbook](HEYGEN-RECONCILIATION-RUNBOOK.md).

Owner selected a temporary-upload design: Video OS is the bridge to HeyGen. The [reviewed design](HEYGEN-BRIDGE-TEMP-UPLOAD-DESIGN.md) separates temporary public source uploads, reusable avatar/voice resources, generated provider videos and private application history. The original phone video stays in private app storage. Raw-source deletion still waits for verified derivative readiness and dependency/CDN canaries; reusable identity resources remain until withdrawal. Local records and simulated responses are not evidence of provider deletion or backup purge.

Latest verification: **555 Node passes, 46 explicit credential/environment skips, four Vitest passes, 118 browser passes and one gated production-proof skip**. Four real isolated DB/Blob tests passed, covering SQL guards, actual ledger APIs, enrollment/re-consent and the scripted reservation/revocation race. Eleven migrations and 27 tables were verified only on the pinned verification database; cleanup confirmed every table empty and zero Blob objects. HEAD remains `1c6121f`; no commit, push or deployment occurred. The prior `b2e7e583` release-repair checkpoint is historical; its Sandbox boundary repair remains part of this candidate.

September 30 foundation source: `f64e77d220008d1c310eb16d8d2f45c2630feb20692251ca4da9f79cc1b0bd5e`. Its review packaging passed 42 routes, 29 steps and six workflows with no known Sandbox leakage; output `93fec4087d7ea541e043191796dd00d89699b28e67dbc9bcb5892edbc41c73af` was quarantined. These historical local build identities are superseded by the October 1 checkpoint above, not deployed proof.

**Exact next action:** use the updated [qualification/binding prompt](MVP-EXECUTION-PROMPTS-2026-09-29.md). Qualify the actual application credential/account/scopes, costs and privacy terms, and establish canonical production DB/Preview Blob credential identity. The provider route/workflow intentionally lack a qualified `providerBinding`; creation cannot be activated merely by enabling old flags. Cross-credential resources remain visible but held. The later deletion executor must atomically consume a verified nonce/budget under the lifecycle locks before a separately scoped disposable canary. Production migration, provider uploads/deletions/spending and publication remain separate owner-controlled actions.

## Next developer action

Prompt 4 release checks are implemented locally; production release is still blocked. Read [the Prompt 4 execution note](execution-notes/20260930-prompt4.md) and [release preflight/rollback instructions](RELEASE-PREFLIGHT.md). Database verification now fails on missing/wrong target, journal/hash/schema drift and connectivity failure; P0 fabrication is disabled; reconciliation mismatches fail CI; review build artifacts are quarantined. Real isolated database fault tests passed. The Sandbox import graph is now removed from the supported MVP finishing path; the fresh review build verifies no known Sandbox class leakage. Production remains blocked by the other release gates.

**September 30 implementation: one-time phone photo/video enrollment and scripts for BOTH tiers are now implemented locally.** The photo sets the finished appearance; the current policy adds a sixth explicit exposure permission to the original five scopes. There is no third upload or per-render recording. The shared interface saves an owned project, displays a server-issued credit quote and submits with stable idempotency and recovery. Both tiers use HeyGen while retaining separate permissions and prices. All new activation flags remain off by default.

Read [the phone-enrollment runbook](PHONE-ENROLLMENT-RUNBOOK.md) and [execution evidence](execution-notes/20260930-phone-enrollment.md). Real isolated private multipart upload, hashing, FFmpeg extraction, identity persistence, consent through the shared script path, revocation and durable provider-orphan receipts passed. Synthetic provider-ready IDs in the database test are explicitly fixtures, not HeyGen proof. Nine migrations and the 18-table schema were verified only on the dedicated verification database. Production migration has not run. Final checks: 449 Node passes plus four Vitest passes, 110 browser passes, 48 Python passes and two real isolated integration passes. Skips are explicit in the execution note. Runtime audit reports zero vulnerabilities. Preview packaging passed with 42 routes, 98 steps and 6 workflows; its output is quarantined and the source ledger matches. That enrollment checkpoint retained the Sandbox gate; the later bridge/release-gate checkpoint below clears that specific local build boundary.

**Exact next action:** use the current checkpoint prompt in [the prompt pack](MVP-EXECUTION-PROMPTS-2026-09-29.md) to finish provider-account/pricing/privacy qualification, product-claim review and the release prerequisites. Establish canonical production DB/private-store mapping, resolve the known Workflow/Sandbox boundary and obtain current-candidate CI/CodeQL evidence before preparing a bounded real-device/HeyGen canary. Provider choice and the recording's purpose are settled. Keep [low-cost ROI research](LOW-COST-RENDERING-RESEARCH.md) separate and nonblocking. No public free plan, production activation, commit, push or deployment is implied.

Earlier security/live proof remains scoped to its receipts: five requested advisory IDs removed, runtime audit zero, 102 isolated DB/Blob checks passed and test data cleaned. The broader dev-tool audit still has 43 unrelated findings.

Full sequence, owners and gates: [MVP completion plan](MVP-COMPLETION-PLAN-2026-09-29.md). The audit was followed by Prompts 1-4 local authorization, output-contract and real media-validation repairs. Nothing was committed, pushed or deployed.

## Source and deployment truth

| Surface | Observed current state |

|---|---|

| Repository | `ARCHITECTARIEL/lux-video-os`; GitHub currently **PUBLIC**, not private |

| Local branch/HEAD and remote main | `main`, `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9` |

| Inherited changes | 18 modified tracked files, new authorization helper/tests, execution notes and wiki; no staged changes at audit start |

| Merge conflict status | `git ls-files -u` returned no entries; older wiki conflict statements are historical |

| Current local Vercel link | **lux-video-os production project**, `prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW`, team `lux-3035s-projects` |

| Stable production | `https://lux-video-os.vercel.app` → `dpl_AEUWrAaSPEyvNjkkZxCbDAg427WP`, READY, created September 24 |

| Production recorded SHA | `a04e59513e7cbd5684bf56790311d2ab14676499`, 28 commits behind local HEAD by history count; metadata is not byte attestation |

| Main preview | `https://lux-video-aypocwqwi-lux-3035s-projects.vercel.app`, `dpl_DLi3r7gP11RoanJLpVeTVW6k86wy`, READY, GitHub source `1c6121f...` |

| Authorization repair deployed? | **No evidence.** It is uncommitted and outside both recorded deployment SHAs |

| PRs #43–46 | #43, #45, #46 merged; #44 closed unmerged. Do not repeat this old task |

| PRs #79–83 | All merged; open PRs are dependency PRs #59–67, not missing MVP feature merges |

| Current main checks | CI run `36579873920` passed; CodeQL `36579873886` failed at Stripe setup logging; Stripe reconciliation `36589393600` failed for absent configuration |

Never assume a routine command targets the old rebuild project. This audit does not change the link. Deployment/environment changes and paid canaries still require the project's owner-controlled authorization.

## What the ZIP actually contains

`C:\Users\ariel\OneDrive\Documents\Desktop\lux-video-os-HANDOFF-2026-09-29.zip`

SHA-256: `430E5886B1363DEA553E49E8F0E11F5B0FA54ED4003A112E0B13D87BAC2F22DE`.

It is a 15-entry documentation packet (60,364 compressed bytes), not a source backup. Twelve repository document snapshots matched the initial worktree bytes; packet-only start/access/history records add orientation. It is anchored to the current committed main, but omits the later uncommitted authorization repair. Several included reference docs are September 23/24 snapshots with obsolete claims. Audit-time matches predate this session's new supersession banners.

Do not restore it over the repository. [ZIP audit and inventories](audit-2026-09-29/zip-audit.md) preserve its value and exact comparison evidence.

## Capability and risk register

| Area | Status and next proof |

|---|---|

| Authorization | Prompt 1 verified locally: talent uses persisted Premium authority; submission claim checks permission transactionally; changed-input replay rejects; legacy email lookup normalizes and rejects ambiguity. Admin revocation survives all sign-in methods. Unit run: 311 Node passes, 40 skips, four Vitest passes. Isolated DB/Blob and SQL concurrency proof now passes for the documented cases. |

| History/download UX | Prompt 2 verified locally: real DTO emits tier/acceptance, status/download/email share the evidence gate, deleted output is unavailable rather than processing. 31 browser tests pass with synthetic persistence/media. Prompt 3 now creates evidence from actual stored media; deployed behavior remains unverified. |

| Media/accounting | Prompt 3 now full-decodes actual stored media before atomic ready/debit, enforces canonical path/hash/bytes and timing/dimensions/codecs, prevents overwrites, and verifies download bytes. Simulation restart, poll/finish races and renderer timing were repaired. Isolated DB/Blob concurrency is verified; deployment capacity remains unverified. |

| Release proof tooling | Prompt 4 disabled fabricated signoff: every verification attempt exits 2, with no approved receipt. Ten negative/import/privacy tests pass. Historical receipts are not proof; real P0 observations remain pending. |

| Deployment/schema | Prompt 4 exact target/journal/hash/schema checks and pre/post-build verification fail closed. Isolated live faults were rejected and rolled back. Production canonical DB mapping is unconfirmed. Review builds are quarantined; known Sandbox class leakage blocks production packaging. `db:check` remains snapshot-only. |

| Standard | Owner requires photo-based output, one-time phone recording and scripts for both tiers. Proposed video use is consented reusable voice enrollment. HeyGen is selected for both tiers. Shared script backend, phone-video enrollment, consented extraction, project/frontend integration and price acceptance are implemented locally and disabled by default; hosted/provider proof remains. App sends portrait+narration, LatentSync requires sourceVideo+narration; requested output format is also unintegrated. Publisher weight sizes/hashes, candidate VAE revision and license research records are captured. Self-hosted model/image enforcement and component-license gaps now belong to the separate ROI track. The HeyGen MVP still needs account capability/economics, consent/resource binding and actual provider/P0 verification. |

| Premium composition | Capability metadata and selected composition are not consistently consumed; hide unsupported choices or implement the promised contract. |

| Billing | Current production env-name inventory has no STRIPE_*; scheduled reconciliation fails 503. Prompt 4 makes mismatch/malformed/failed HTTP responses fail the scheduled workflow, including mismatches returned with HTTP 200. New CodeQL CI is pending publication; account logging was removed locally. Billing activation remains gated by P0. |

| Product/legal | Privacy analytics statement conflicts with loaded Vercel Analytics; tier-live claims exceed proof. Legal/commercial review is an owner dependency, not an agent certification. |

| Historical consent hang | September 23 symptom is not a currently established root cause; re-test consent with exact candidate and correlated timings after contracts are repaired. |

| Public exposure | GitHub is public and main has no branch protection. Assess intended visibility/protection with owner; no settings changed in this audit. Do not place secrets/private evidence in this repository. |

## Initial lane status ledger

| Lane | Current state |

|---|---|

| A authorization | implemented-local; selected isolated DB/Blob sign-in/entitlement and real revoke-vs-claim locking verified; hosted production proof pending |

| B accepted output/history/media | local and isolated-live verification passed for documented paths; hosted/provider production evidence pending |

| C release/CI/storage integrity | implemented-local with live isolated DB verification; production store inventory 77 private objects, 26 unclassified. Production DB references, preview token binding, Sandbox compatibility and exact-candidate hosted CI remain blocked/pending. |

| D Standard provider/provenance | Photo-based output and record-once/scripts-both-tiers confirmed. Staged plan and provider screening prepared; Premium tier marker fixed locally. Shared HeyGen backend foundation verified locally; phone-video enrollment/project/frontend/quote integration remain. Lower-cost research has a separate backlog and partial LongCat source/model inventory. Prompt 5B implementation, runtime hash enforcement, exact image/weight readback and commercial review remain open. |

| E capability/product truth | planned |

| F paid billing | planned; production configuration absent in name inventory |

| G production acceptance | planned; no verified complete receipt established |

| H continuity | current for this audit; must be updated after every later lane |

## Test and evidence boundaries

Latest checks (2026-09-30): normal local suite exits 0 with 336 Node passes / 41 credential-gated skips and four Vitest passes. Separate isolated live suite exits 0 with 102 passes and zero skips. Runtime npm audit is clean; all five requested advisory IDs and all critical findings are gone from the full graph. Full development-inclusive audit still exits 1 for 43 unrelated dev-tool findings. Workflow build/import/validation pass, with the inherited Sandbox warning. [Details and receipts](execution-notes/20260930-security-live-verification.md).

Live database/Blob verification has now occurred on isolated targets. No real provider inference, live billing transaction or nine-observation production proof occurred; earlier browser tests used test media. Vercel READY and current CI are not substitutes. No complete independently verified production P0 receipt was established by this audit.

## Evidence index and authority order

1. Current source, current readbacks and reproducible tests take precedence over status prose.

2. [Git/GitHub audit](audit-2026-09-29/git-github-audit.md), [Vercel audit](audit-2026-09-29/vercel-audit.md), [ZIP audit](audit-2026-09-29/zip-audit.md), [code readiness audit](audit-2026-09-29/code-readiness-audit.md).

3. [Dependency/live verification continuation](execution-notes/20260930-security-live-verification.md), then [Prompt 3 continuation](execution-notes/20260929T211246Z-B-prompt3.md), then [Prompt 2 continuation](execution-notes/20260929T204451Z-B-prompt2.md), then [Prompt 1 continuation](execution-notes/20260929T202952Z-A-prompt1.md), then [Authorization note 02](execution-notes/02-authorization-handoff.md), newest implementation section first; its historical reproduction intentionally describes the old defect and is not an acceptance command.

4. [Rebaseline note 01](execution-notes/01-rebaseline-handoff.md), subject to its correction and newer note 02.

5. Root HANDOFF / developer atlas / ZIP: historical reference only where not contradicted.

## Keep the handoff current

For every implementation lane: update this file's status/next action; write one execution note using the prompt-pack template; append `wiki/log.md`; record exact tested SHA/dirty state and deployed target separately. Never replace a historical failure with an unsupported “fixed” claim. Keep private receipts outside the public repo and retain only safe hash/reference. Preserve old notes with explicit supersession. Do not update global agent memory unless Ariel explicitly requests it.

## Open decisions

Exact HeyGen account economics, limits and supported photo/voice capabilities; required model commercial-use and legal approvals; repository visibility/protection; per-canary spend/target authorization; eventual paid billing activation. Until answered, keep the plan conditional and continue independent local work.

## Premium request-boundary repair

The prior mismatch is now repaired locally: the strict Premium schema accepts only optional `tier: 'PREMIUM'` and strips it from the canonical payload. Legacy omitted-tier clients remain compatible; invalid tiers, providers and server-owned fields remain rejected. The separate Standard contract and authorization/voice-selection policy were not changed. This is parser/regression evidence, not a hosted Premium render proof. See [the execution note](execution-notes/20260930-scripted-photo-next-step.md).

