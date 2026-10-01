# VIDEO OS code readiness audit

Date: 2026-09-29  
Scope: current code plus the latest local execution notes; Standard/Premium authorization, consent, credits, workflows, billing, and release gates.  
Baseline: `main` at `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`, tracking the same `origin/main`, plus an inherited uncommitted authorization repair.  
External actions: none. No deployment, database write, provider call, billing call, image publication, commit, push, or merge was performed.

## Readiness verdict

The repository contains most of the transactional render lifecycle, but the current worktree is not an MVP release candidate.

- Premium has a real provider lifecycle and defensively holds ambiguous submissions, but the current bytes have no candidate-bound production receipt and the accepted-output/media boundary is incomplete.
- Standard has a strong portrait+narration consent/quote/reservation contract, but the newly merged LatentSync worker requires source video while the application still sends a portrait. Real Standard inference is therefore blocked on an explicit product/provider decision and a matching end-to-end contract.
- The local authorization repair materially improves tier-specific permission checks and worker replay safety. It is uncommitted and has no real database/Blob verification. The Premium talent endpoint still uses the legacy configuration-based gate.
- Billing code is contained behind a feature flag and performs useful Stripe signature/economic checks. Production Stripe configuration is absent according to current external evidence, reconciliation mismatches do not fail automation, and refunds/out-of-order lifecycle behavior is not an established acceptance surface.
- Production release cannot be certified with the existing `tools/verify-p0-release-gate.mjs`: it generates a fully approved receipt without reading the API, database, Blob storage, provider, logs, browser, or downloaded artifact.

## Evidence boundaries

| State | What is established | What is not established |
|---|---|---|
| Committed `HEAD` | Recent merged render, worker, migration-gate, admin, and entitlement changes exist through `1c6121f`. Standard source/consent/quote binding, provider state transitions, private output storage, credit reservation/debit, and Stripe verification are present in source. | A green current-source production deployment, current-source provider image, real Standard inference, accepted-output browser recovery, and the nine P0 observations. |
| Inherited dirty repair | Tier-specific persisted authorization, server-bound reservation decisions, worker rechecks, read-only tester listing, admin grant/revocation provenance, and account identity reconciliation are implemented across 18 modified tracked files plus a new helper and tests. See `docs/execution-notes/02-authorization-handoff.md`. | Commit/PR identity, live SQL locking and legacy identity behavior, non-production DB/Blob acceptance, deployed behavior, or production approval. |
| Fresh local verification | Two bounded offline commands completed with 66 tests: 65 pass, 0 fail, 1 live-DB skip. No configured DB, Blob, RunPod, HeyGen, or Stripe credentials were present in the process. | The skipped database case, real storage, provider calls, browser-to-real-route behavior, concurrency against Postgres, or payment/provider spend. |
| Production proof | No P0 receipt exists under `docs/proofs/`; only the HyperFrames composition proof is present. | Any complete, independently observed receipt for either tier. A deployment marked READY or a generated receipt hash does not supply these observations. |

## Findings by subsystem

### 1. Authorization repair is useful local work, with two remaining acceptance gaps

**Evidence.** The dirty route now reads the bounded body, classifies Standard versus Premium, and checks the matching persisted permission before entering the tier handler (`api/video-os-lite/render-v2.js:185-198`). Premium reservation writes a server-generated permission decision inside the credit transaction (`db/repositories.js:151-163`); Standard writes the equivalent binding during its locked quote reservation (`db/standard-narration-repository.js:493-557`). Both worker submission paths recheck current permission and the job binding (`workflows/video-render.js:28-49`, `workflows/standard-render.js:36-65`). `lib/video-os-render-authorization.js:8-28` binds version, account, tier, entitlement key, and job ID. Admin listing is read-only in the dirty repository, and sign-in no longer provisions a domain-only account as a Premium tester.

**Evidence gap.** The new scenarios use explicit repository/provider seams. The focused run skipped the live database case. Real sign-in, row locking, persisted revocation, old admin-created account IDs, replay, and cold-worker behavior still need an isolated non-production Postgres/Blob proof.

**Remaining inconsistency.** `api/video-os/talent.js:118-131` still authorizes through `VIDEO_OS_RENDER_ACCOUNT_ID`/exact-email legacy logic rather than the persisted Premium grant used by the render route and worker. An admin-designated Premium account can therefore be authorized to render while being denied the presenter/voice inventory needed to create that render. Align the talent read with persisted Premium permission and prove denial occurs before provider fetch.

**Assessment.** `implemented-local`; not `verified-integration`, committed, deployed, or production-accepted.

### 2. Standard consent, quote, and reservation contracts are strong, but inference contracts conflict

**Evidence.** The Standard repository checks owned private portrait/audio records, content limits, immutable SHA-256 identity, identity consent, and narration consent (`db/standard-narration-repository.js:91-119`, `144-179`). Quotes bind account/actor, project, identity, portrait hash, identity consent, narration consent, audio hash, policy version, pricing version, format, 90-credit cost, and exact TTL (`db/standard-narration-repository.js:198-216`, `428-455`). Reservation locks the credit account and quote, rechecks entitlement/expiry/sources/consent, consumes the quote once, reserves exactly 90 credits, and writes one canonical job (`db/standard-narration-repository.js:493-558`). Idempotent replay revalidates the same binding (`db/standard-narration-repository.js:303-320`). Four independent activation flags fail closed and were covered by the fresh offline run.

**Provider blocker.** The application adapter reads a portrait and driven audio and sends `input.portrait` (`services/sadtalker-runpod.js:102-126`). The LatentSync worker explicitly states that it cannot animate a still image and requires `input.sourceVideo` plus `drivenAudio` (`workers/latentsync-runpod/handler.py:1-12`, `113-120`). The current adapter and new worker cannot interoperate. The existing `tests/sadtalker-runpod.test.mjs` asserts the portrait envelope, so it protects the incompatible old contract rather than the LatentSync integration.

**Proof gap.** The historical September 23 consent timeout has not been disproved against the exact current candidate. The client retains a 15-second default request timeout, while consent performs an advisory lock and several awaited reads/writes. Treat cold start as an old hypothesis, not a current root cause; capture correlated stage latency on an isolated environment before claiming recovery.

**Acceptance decision.** Choose one explicitly: retain portrait+narration with a verified compatible worker; version and implement source-video+narration through upload/storage/consent/quote/adapter/worker; or authorize a reduced Premium-only pilot. Do not point the current portrait adapter at LatentSync or count simulation as inference proof.

### 3. Premium workflow protects against duplicate submission, but offered composition and talent capabilities are not coherent

**Evidence.** Premium reserves credits before dispatch, validates owned project/identity or current provider selections, and holds any submission-time uncertainty in `provider_submit_unknown` instead of automatically retrying (`api/video-os-lite/render-v2.js:207-251`, `workflows/video-render.js:28-54`). Polling and finishing use explicit state transitions and preserve a containment state while hosted finishing is disabled (`workflows/video-render.js:57-87`). These are sound duplicate-spend controls in source.

**Capability gaps.** Provider metadata exposes configuration and cost only; it does not expose composition readiness (`lib/video-os-account.js:99-109`). The browser offers two backgrounds and two layouts (`public/premium-composition-catalog.js:9-94`), but HyperFrames always renders the fixed `LUX_MARKETING_COMPOSITION_HTML` and fixed composition ID (`services/hyperframes-finisher.js:7-12`, `74-115`) without resolving the saved selection. Fixtures can therefore show choices that the renderer ignores. The talent authorization mismatch described above can block a legitimately persisted Premium grant before inventory load.

**Assessment.** Premium can become a contained pilot only after authorization integration, accepted-media truth, deployment integrity, and one candidate-bound proof. It is not presently a proven launch tier.

### 4. Credit accounting is transactional, but `ready` currently means stored bytes, not accepted playable media

**Evidence.** Premium and Standard reserve credits under account row locks. `finalizeReadyJob()` locks job and credit rows, uses unique `render:<jobId>` transaction identity, debits once, inserts/updates the private final asset, sets `ready`, and records `finish.completed` in one transaction (`db/repositories.js:702-725`). Failure releases an uncharged reservation (`db/repositories.js:744-756`). These are good exactly-once ledger primitives.

**Blocking defect.** Every enabled finisher can reach that debit/ready transaction without a shared decode-level acceptance result:

- FFmpeg and Remotion check only that the output file is nonempty before hashing/upload (`services/media-finisher.js:133-159`, `services/remotion-finisher.js:50-106`).
- HyperFrames adds file size and an eight-byte `ftyp` signature, but no stream/decode/duration check (`services/hyperframes-finisher.js:60-71`, `94-115`).
- RunPod Standard accepts bounded Base64, declared byte count, `ftyp`, and payload hash (`services/sadtalker-runpod.js:71-93`, `168-189`). The current unit fixture is a 12-byte header-like buffer and passes.

None proves decodable video, an audio stream, expected duration, valid dimensions, or agreement between the stored/downloaded bytes and an acceptance record. A corrupt/header-only/silent artifact can therefore be stored, marked ready, and charged.

**Required acceptance.** Centralize final media validation before `finalizeReadyJob`: full decode, required audio and video streams, bounded duration/dimensions/bytes, explicit tolerance against expected input, and SHA-256 of the exact accepted bytes. Persist sufficient acceptance evidence and make invalid output terminal without debit; preserve retry/idempotency semantics.

### 5. Real `ready` jobs are hidden by the DTO/browser contract

**Reproduction.** A direct `jobDto()` call for a ready job with private output produced:

```json
{"hasTier":false,"hasOutputAccepted":false,"status":"ready","url":"/api/video-os-lite/download?jobId=job-proof"}
```

`db/dto.js:125-151` omits both `tier` and `outputAccepted`. `public/studio.js:147-183` maps backend `ready` to `SUCCEEDED` but accepts it only when `item.outputAccepted === true` and an owned download URL is present. Thus the real API result is displayed as `PROCESSING` / “Output acceptance pending,” with preview and download hidden. Browser fixtures inject `tier` and `outputAccepted`, masking the production DTO defect.

**Required acceptance.** Derive tier and output acceptance from persisted server validation, return them consistently from render/results/finalize, and test the actual DTO/route payload through a fresh browser context. Do not define acceptance as `status === ready` alone and do not add fixture-only fields.

### 6. Billing is correctly contained, but it is not ready to activate

**Evidence.** Checkout requires an authenticated session, `VIDEO_OS_BILLING_ENABLED`, a secret, and a configured package price (`api/video-os-lite/checkout-v2.js:9-23`). The webhook verifies the raw Stripe signature, explicit live/test mode, client/account binding, paid status, expected price and quantity before calling the ledger (`api/video-os-lite/stripe-webhook-v2.js:14-37`). `issueStripeCredit()` records the event and account credit in one transaction and detects conflicting same-event replays (`db/repositories.js:268-283`). Reconciliation compares paid sessions, events, and Stripe credit transactions without auto-repair (`lib/video-os-stripe-reconciliation.js:58-132`).

**Blocking gaps.** The admin reconciliation route always returns HTTP 200 with `ok: true`, even when `mismatchCount > 0` (`routes/video-os-lite/admin.js:179-183`), while the scheduled workflow fails only on non-200 (`.github/workflows/stripe-reconciliation.yml:43-49`). The production configuration readback currently shows no `STRIPE_*` names and its scheduled check fails configuration. Refund/dispute treatment and multiple/out-of-order event handling are not an established product/ledger contract.

**Required acceptance.** Keep billing disabled. In isolated Stripe test mode, prove exactly-once grant, conflicting replay rejection, duplicate/new-event behavior for one session, invalid signature/mode/price denial, reconciliation that fails automation on any mismatch, and a documented refund/dispute policy. Configure or activate live billing only after the media/release gates and explicit owner authorization.

### 7. Release tooling can currently produce false confidence

**False receipt generator.** `tools/verify-p0-release-gate.mjs:46-108` constructs every observation with `status: 'VERIFIED'` and signoff `APPROVED` from only two command-line strings, writes it under the public repository's `docs/proofs/`, and reports “P0 Gate Cleared.” It performs no observation. This contradicts `docs/P0-RELEASE-GATE.md`, which requires private, correlated evidence from the real session, provider, MP4 streams, fresh browser, download hashes, access denials, logs, and ledger.

**Fail-open migration check.** `checkDatabaseMigrations()` skips when no URL is supplied (`tools/check-migrations.mjs:27-31`). The production build attempts an environment pull, then explicitly warns and continues if no database URL is available (`tools/build-production.mjs:51-83`). Existing tests pin the no-URL strict command to exit 0. The live comparison is also count/index-oriented and does not establish target database identity or exact applied migration hashes.

**Other current gates.** Current-source CodeQL is reported failed by the latest execution note; the authorization repair is outside any deployment SHA; and the production alias is reported behind current main. These states must be re-read at release time rather than copied forward.

**Required acceptance.** Disable or replace the canned P0 signer so missing evidence fails. Make production build verification fail when target identity, connectivity, journal, exact migration state, or required hashes are unavailable. Bind release evidence to source commit, clean/dirty manifest, deployment ID, worker image/model identity, database target/migrations, environment-name inventory, and stable-alias readback.

## Prioritized completion lanes

| Priority | Lane | Concrete exit criteria |
|---:|---|---|
| P0 | Preserve authorization repair | Review/integrate the inherited diff without losing it; align the talent endpoint with persisted Premium permission; focused offline suite stays green; isolated non-production DB/Blob tests prove both sign-in methods, admin list, grants/revocation/expiry, legacy IDs, cold workers, replay, anonymous 401, and wrong-account 404. Record exact commit/diff identity. |
| P0 | Accepted media + DTO/history | One shared validator precedes ready/debit for every enabled finisher; corrupt/header-only/missing-audio/missing-video/bad-duration/bad-dimension inputs fail without debit. Persist acceptance evidence. Real route DTO returns tier/acceptance, and a fresh browser shows/downloads the accepted bytes with matching hash. |
| P0 | Release integrity | Canned verifier cannot approve absent evidence. Production checks fail closed on absent/wrong DB identity, connection errors, missing journal, drift, and exact-hash mismatch. Current-candidate CI/CodeQL/workflow build pass; release manifest binds all target identities. |
| P0 for Standard | Resolve provider/input contract | Owner records portrait-worker versus source-video LatentSync decision. Selected version is consistent across browser, storage, consent, quote, adapter and worker; immutable source hashes and model/image/license records are enforced; simulation is rejected for real proof. |
| P1 | Premium capability truth | Persisted Premium grants can load bounded talent. Every advertised composition is actually consumed and validated, or the unavailable choice is not offered. Current copy does not claim unproved tier/provider behavior. |
| P0 for paid launch | Billing | Test-mode economic matrix passes; any reconciliation mismatch fails automation; refund/dispute behavior is explicit; Stripe configuration is added and billing enabled only after P0 evidence and separate owner authorization. |
| Final gate | Candidate-bound proof | Deploy the exact approved candidate, then collect all nine observations from real system state for every launched tier. Receipt is private; repository keeps only a safe hash/reference. Exactly one provider submission, debit, and accepted final artifact; original and fresh-session gallery recovery; authorized download hash; anonymous/wrong-account/direct-Blob denial. |

## Verification performed in this audit

Environment-name check before tests: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `BLOB_READ_WRITE_TOKEN`, `RUNPOD_API_KEY`, `HEYGEN_API_KEY`, and `STRIPE_SECRET_KEY` were absent from the process. Values were never printed.

| Command | Result |
|---|---|
| `node --test tests/authorization-repair.test.mjs tests/render-authorization-policy.test.mjs tests/job-dto-privacy.test.mjs tests/media-finisher-empty-output.test.mjs tests/hyperframes-boundary.test.mjs tests/talent-inventory.test.mjs tests/render-auth.test.mjs` | Exit 0; 48 total, 47 pass, 0 fail, 1 skip. The skipped case requires a real database. Media tests use local FFmpeg and injected storage/download seams. |
| `node --test tests/standard-narration-contract.test.mjs tests/sadtalker-runpod.test.mjs tests/standard-rendering-email-domain.test.mjs` | Exit 0; 18 pass, 0 fail, 0 skip. Provider calls are injected; this is contract evidence only. |
| Direct `jobDto()` ready-job probe | Exit 0; confirmed `tier` and `outputAccepted` are absent while a download URL is returned. |

No full suite, Playwright suite, live DB/Blob test, build, external provider, Stripe API, or production proof was run in this bounded audit. The prior execution note reports a full local unit/workflow build result for the dirty authorization repair; that evidence is historical to that exact dirty state and does not substitute for current integration or deployment proof.

