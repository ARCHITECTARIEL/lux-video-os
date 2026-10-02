# Authenticated P0 observation collector

Implemented October 2, 2026. **This is an observation collector, not a release verifier.**

`tools/collect-p0-evidence.mjs` coordinates a real Playwright browser, the canonical production Postgres database, authenticated HeyGen reads, Vercel control-plane reads and private Blob reads. It does not accept an input receipt or plug-in adapter. `tools/verify-p0-release-gate.mjs` remains disabled and unchanged.

## Scope and prerequisites

The implemented path is one new **Premium scripted-photo / HeyGen** render through the shipped UI, using an existing authorized identity. Standard/RunPod qualification is outside this collector. Provider creation activation and billing remain off in this change. The operator must first obtain separately scoped approval for the exact bounded production proof and provider spend, complete the reviewed private-storage migration, and review deployed configuration/source-policy gates in `P0-RELEASE-GATE.md`. The operator's acknowledgement is **not** machine evidence those gates passed.

The collector checks a maximum application-credit charge before submitting and against settlement. **Application credits are not a HeyGen dollar spending limit.** The separate provider-spend approval and server-side provider budget must cover the selected identity, script, format and quoted render. No automatic retry occurs after a request might have reached the application.

Existing credentials are read only from an approved environment: `DATABASE_URL`, `HEYGEN_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `VERCEL_TOKEN`, optionally `VERCEL_TEAM_ID`. No credential is printed, saved, configured or obtained by this tool. No session signing secret is needed. A headed Playwright Chromium, display and functioning bundled FFmpeg are required. POSIX filesystem permissions are required; Windows is refused until an ACL-aware private sink is implemented.

Run `node tools/collect-p0-evidence.mjs --help` for the explicit invocation. Required arguments pin the production HTTPS origin, deployment ID, project ID, full Git SHA, application-credit ceiling and a new private directory **outside the checkout**. Both `--collect` and `--owner-authorized` are required. There is no dry-run that silently escalates to spend, no arbitrary module loading, no storage-state input, and no receipt-import path.

## What is actually observed

1. Authenticate Vercel alias/deployment metadata before and after collection; require the exact pinned candidate, project, production target, READY state and recorded Git SHA. Metadata does not attest source bytes.
2. Validate the canonical database URL against the repository target manifest, then run the existing migration/schema verifier in a read-only transaction. All collector SQL transactions are repeatable-read and read-only, with server database/user identity checked.
3. Open an empty, nonpersistent browser context. Observe an actual allowed sign-in route issuing `vos_session`, hash that cookie in memory, and require the live session endpoint to accept it. No cookie injection, local-storage restoration, request replay, HAR, trace or screenshot is used.
4. Requalify the actual HeyGen key, validate the repository's fresh pinned native-space anchor, and independently read the active binding, verified scope and promotion rows. Qualification fingerprints, target digest, scope identity and promotion evidence/timestamps must agree. No new binding, promotion, anchor refresh or provider probe is created.
5. Enumerate every provider-video page. Missing pagination metadata, repeated IDs/tokens, oversized responses or the safety page limit fail closed, never claim a complete inventory. Capture a server-generated UUID and timestamp using the authenticated database's `gen_random_uuid()` and `clock_timestamp()`. Embed that UUID in the unique proof title, tying it to the subsequently reserved app/provider job.
6. Operator prepares an approved Premium draft. The collector fills the proof title, observes the actual save-project and quote request/response, checks the numeric server price and expiry, and asks the operator to review the visible exact quote. It binds the approved title/script/identity/format/project/idempotency key/quote token in memory. All render aliases are guarded; only the single exact request can reach the network. A supplied correlation header is forbidden. Immediately before arming, the live account and session-cookie hash must still match the original sign-in, and candidate/binding reads are refreshed. The app's new job and correlation IDs must agree in the response. Unknown submission outcomes are never replayed.
7. Poll the actual application job and provider status. The provider ID must be absent from preflight, have the proof title, and have a provider creation time at or after the DB proof start. The terminal graph must include exactly one render reservation, provider-submitted event, successful first-attempt provider creation operation/resource, matching credit debit, final media row and final event. The SQL queries have no row limit and cover both job and correlation IDs. Repair/recovery/ambiguous events fail.
8. Read the private stored artifact through the Blob SDK without cache, check exact pathname/bytes/hash, and independently fully decode its audio and video with the existing media inspector. The direct private URL must name that same path. Recover it from the original UI gallery and click its actual download link; compare bytes and SHA-256.
9. Close the original context. Start another empty context, observe another real sign-in, require the same account and a distinct issued session cookie, and recover through normal navigation and gallery loading. No result-route replay or storage repair is performed. Repeat the gallery download/hash check.
10. Sign into a third empty context as a genuinely different existing account. Observe its session identity. In a cookie-free context require anonymous app download 401, wrong-account download 404 and direct private Blob denial 401/403/404. Redirects and successful content never count as denial. Re-read the full ledger, provider inventory and alias afterward to detect late changes or duplicate proof titles.

The original/session account IDs, raw cookie tokens, scripts, source URLs and private storage paths are not written. Cookie and account hashes remain private evidence.

## Retained evidence and independent review

Each checkpoint is created exclusively in the new mode-0700 private directory, with mode-0600 files. Checkpoints are append-only numbered JSON files plus exact-file-byte SHA-256 sidecars. The first checkpoint is persisted **before possible spend**. A failure preserves an incomplete checkpoint and whether submission may have occurred. Do not remove that history or start another render to compensate.

The final checkpoint includes a strict-allowlist source bundle: candidate readbacks, database verification, preflight provider IDs, provider job ID/title/status/time, fresh binding summaries, complete relevant ledger/event/operation/resource projections, accepted-output validation fields, hashed account/path bindings, session-issuance hashes, download hashes and denial status codes. Unrelated provider titles are hashed. `snapshotSha256` names the retained ledger projection so its preimage is available for review. Each account reference uses the same hash convention; each private pathname uses its digest. Arbitrary event details and job input are excluded.

An independent reviewer should verify the file-byte sidecars, re-evaluate the retained graph and ordering, compare live trusted-source readbacks as appropriate, confirm the candidate/source-byte relationship, and inspect the separate migration/configuration evidence. Preserve the private canonical evidence and its hash under the approved evidence-custody process. A local hash detects changes; it is **not** a trusted signature or proof that the operator did not alter local code.

Even after all nine observation classes succeed, the status is `collected_requires_independent_review`, qualification is `incomplete_release_evidence`, and both `p0Cleared` and `releaseAuthorized` are **false**. Success exits **2**, not zero. Errors/incomplete collection exit **1**; help exits zero. No signoff or authorization key is fabricated. Remaining hard gates are:

- Independent exact deployed source-byte attestation (Vercel recorded Git metadata alone is insufficient)
- Deployed configuration and source-policy attestation
- Complete independently reviewed legacy-public-object migration, including all unclassified objects and explicitly approved destructive removal
- Independent observation review, private canonical receipt custody and signoff

A production proof must not be called complete or launchable merely because the collector completed. These gates need their own evidence and review before the disabled verifier can be replaced.

## Validation and limits

- `node --test tests/p0-evidence-collector.test.mjs tests/p0-release-verifier.test.mjs`: offline core, pagination, ledger, session, privacy, single-submit and CLI refusal tests; the legacy verifier remains fail-closed
- `npx playwright test tests/e2e/p0-evidence-browser.spec.js`: offline browser integration using the **actual shipped scripted-photo client**, a local HTTP fixture for app/session/quote/download behavior, and a stubbed private-Blob denial. It tests `/render-v2`, uppercase `PREMIUM`, fresh sign-in/gallery recovery and a 1,200-credit quote against a 300-credit limit. Fixture results are never production evidence
- Browser test execution is blocked in the current managed workspace before a test body: Chromium's singleton socket cannot be created (`EPERM`) even after a supported escalation retry; the pinned browser download also failed with an invalid ZIP. These browser tests are not claimed locally passing. Run them in the supported CI environment before relying on the collector for a paid proof
- No live collector run, production query, provider render, Blob mutation, deployment, merge or secret configuration was performed during implementation

Provider schemas were checked against primary documentation on October 2: [HeyGen list videos](https://developers.heygen.com/reference/list-videos), [HeyGen get video](https://developers.heygen.com/reference/get-video), and [Vercel get alias](https://vercel.com/docs/rest-api/aliases/get-an-alias). Unknown or changed schemas fail closed.
