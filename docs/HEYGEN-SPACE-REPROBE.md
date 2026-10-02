# One-shot HeyGen neutral-asset space reprobe

This is an **operator-only collection workflow**, not production activation or a freshness installer. It uses the current `HEYGEN_API_KEY` environment variable and the committed neutral PNG. It does not require the October 1 private Windows evidence directory, create/configure credentials, alter a binding/database, generate media, or deploy. The original approval is exhausted. Every run requires new explicit owner approval.

Implementation status: covered by offline injected-transport tests; this implementation task has not run a live probe or measured its cost. A successful run creates five private receipt files. Source review of those real observations and a separate reviewed refresh pin are still required before runtime freshness changes.

## Exact scope and official API contract

The following primary sources were checked on October 2, 2026: [official OpenAPI](https://developers.heygen.com/openapi/external-api.json), [Get Current API Key](https://developers.heygen.com/reference/get-current-api-key), [Get Current User](https://developers.heygen.com/reference/get-current-user), [Upload Asset](https://developers.heygen.com/reference/upload-asset), [Get Asset](https://developers.heygen.com/reference/get-asset), and [Delete Asset](https://developers.heygen.com/reference/delete-asset). Verify them again before execution if this runbook is stale.

All calls target `https://api.heygen.com` with `X-Api-Key` and `Accept: application/json`. Maximum budget, executed serially:

1. `GET /v3/api_keys/self`, no body, through `qualifyHeygenCredential`
2. `GET /v3/users/me`, no body, through that same qualification
3. `POST /v3/assets`, multipart form with **one** field named `file`; MIME `image/png`, filename `provider-space-probe.png`, exactly the committed 95 bytes
4. `GET /v3/assets/{new_asset_id}`, no body; only the exact ID returned by step 3
5. `DELETE /v3/assets/{new_asset_id}`, no body; only after step 4 confirms the ID, image type, authenticated username owner and original native-space fingerprint
6. `GET /v3/assets/{new_asset_id}`, no body; require HTTP 404 and `error.code: asset_not_found`

Upload success is HTTP 200 with `data.asset_id`, `data.mime_type: image/png` and `data.size_bytes: 95`. The metadata response uses `data.type: image`, **not** `file_type` or `mime_type`; identity comes from `data.id`, `data.owner` and `data.space_id`. Delete success is HTTP 200 with matching `data.id`. No existing asset, avatar, logo, video ID, filename, URL, list endpoint, CDN fetch, presigned upload, completion endpoint, generation endpoint or arbitrary asset-ID argument is supported.

The fixture is `docs/execution-notes/binding-readiness-20261001/provider-space-probe.png`: a 32×32 neutral gray PNG, no person/voice/customer data, SHA-256 `f96c86519d1502fd319cdb106ca2a5277a83e09ad4d6e85279756ce77f05563e`. The runner validates the public identity pins, historical result, fixture bytes/hash/dimensions, exact credential fingerprint, active full scope, key-ID digest/creation time and username digest before upload. Credential or scope rotation requires a separately reviewed identity transition, not a refresh.

The qualifier deliberately retains the original pinned policy, including its `undocumented_null` expiry hold. The current OpenAPI describes null expiry as never-expiring, but changing that historical qualification interpretation is outside this refresh workflow.

## Cost, deletion and authorization boundary

**There is no documented per-request monetary ceiling for these asset endpoints. This code enforces six requests and 95 uploaded bytes, not a dollar cap. It does not establish a $0 price or measure charges.** It neither queries account balances beyond the two required qualification reads nor retries to check billing.

Before running, the owner must approve the exact HeyGen account/credential/native-space identity from the existing reviewed evidence, the one neutral upload and lifecycle, irreversible deletion of only that newly returned neutral asset, and the absence of an enforceable provider price cap. They must understand that uncertainty can leave the new asset retained pending separate review. If the owner requires a hard dollar limit or has not accepted the unpriced bounded lifecycle, **do not execute**. Obtain provider pricing/cap assurance or a newly authorized plan first. The JSON approval file is an operator record of actual authorization; editing it or setting its booleans does not obtain that authorization.

Suggested request to the owner (include the existing reviewed identity evidence in context):

> Approve one fresh HeyGen space check with the original pinned credential and native space: two qualification reads, one upload of the pinned 95-byte 32×32 neutral PNG, one metadata read, permanent deletion of only the new asset returned by this run after its owner/space matches, and one absence readback. No retries or generation. These endpoints have no documented enforceable dollar cap, so this is a bounded unpriced lifecycle, not a guaranteed $0 operation. Any uncertain response stops the run and may leave that neutral asset for separately approved cleanup. Do you approve this exact one-time scope and cost limitation?

Ordinary project implementation permission, old exhausted approval, a refresh candidate, or approving deployment does not authorize this provider mutation. Follow any stronger action-time confirmation requirement applicable to the operator.

## Prepare locally, with no provider requests

Use Node 22+ on a trusted POSIX filesystem supporting private modes and fsync. Windows ACL-only operation is intentionally unsupported by this runner. Use a dedicated directory owned by the operator, outside the repository and synced/shared folders, with mode `0700`. The run directory must not already exist. Example:

```sh
umask 077
mkdir -m 700 /absolute/private/heygen-reprobe
node tools/probe-heygen-space-refresh.mjs --approval-template \
  --private-run-dir /absolute/private/heygen-reprobe/run-20261002 \
  > /absolute/private/heygen-reprobe/approval.json
chmod 600 /absolute/private/heygen-reprobe/approval.json
```

`--approval-template` reads only pinned public files; it never reads the key or contacts HeyGen. Its output is deliberately non-executable: `approvalId`, `approvedAt`, `expiresAt` are null and authorization booleans are false. After obtaining and retaining the real approval, the authorized operator completes:

- `approvalId`: a new lowercase UUID v4, unique to this approved run
- `approvedAt`: canonical UTC ISO timestamp, for example `2026-10-02T16:29:00.000Z`
- `expiresAt`: canonical UTC ISO timestamp after approval and no more than one hour later; execution must remain inside that window
- `ownerApproved`, `irreversibleDeletionOfNewProbeOnlyApproved`, `noRetryAndPossibleRetainedAssetAccepted`: true only when the owner has actually approved each

Leave `version`, exact absolute `runDirectory`, origin/fixture digests, complete operation budget and `costPolicy` unchanged. The approval file must be a single-link regular file with mode `0600` in the run directory's existing private parent. No extra fields are accepted. Keep the original authorization reference with the operator's private records, not in source.

Use the already authorized credential in the current process environment as `HEYGEN_API_KEY`. Do not paste it into chat, shell arguments, the approval file, source files, or screenshots. The runner does not read any `.env`, credential store, October 1 private files or configuration fallback. Credential setup/transmission remains a separate user-controlled step.

## Execute once, only after approval

```sh
node tools/probe-heygen-space-refresh.mjs --execute \
  --private-run-dir /absolute/private/heygen-reprobe/run-20261002 \
  --approval-file /absolute/private/heygen-reprobe/approval.json
```

The runner refuses deployed Vercel production/preview environments. Importing it does nothing. Without the exact command, private approval and matching current credential it never sends requests. Endpoint/fixture/identity overrides are unavailable. Tests alone have an in-process dependency seam gated on Node test-runner context; it is not a CLI switch or production configuration.

There are no automatic retries, including 429/5xx, transport errors, timeouts or deletion failures. Each request has an eight-second deadline. The entire accepted chain must finish inside the qualifier's 60-second window and approval window. Redirects are disabled, responses are bounded and cancelled on rejection, final receipts use compact serialization capped at 128 KiB, secret reflection is rejected before writing asset receipts, and console output never prints the key, profile, provider IDs or URLs.

## Evidence, consumed intent and failure recovery

Before any provider request, the runner atomically creates `.heygen-reprobe-<approvalId>.consumed.json` in the private parent. A narrow stop-only guard consumes each fixed qualification GET immediately before the qualifier sends it, rechecking approval after persistence; the request deadline includes that guard. The guard receives only the method/path template, never credentials, transport or result authority. Each asset operation then gets a private exclusive `*.claim.json` and a durable journal entry **before** its request. File data and containing directory entries are synced. These records make restart/replay fail closed within the same protected approval parent. This is a local registry, not cross-machine/global replay protection; never copy or relocate approval/state to bypass it. The exact approved run path also remains bound in the approval file. The approval marker, run directory and claims are deliberately never deleted or reset by the runner.

The private run directory contains:

- `journal.jsonl`, bounded private `*.response.json` records for asset responses (kept even when a later clock/identity check fails), and six one-shot `*.claim.json` records (claims reserve calls; they do not by themselves prove that every request reached HeyGen)
- `partial/` containing receipts collected so far, retained on failure
- Only after successful own-asset cleanup and 404 readback, `partial/` is renamed to `receipts/`, containing **exactly** `qualification.json`, `upload.json`, `read.json`, `delete.json`, `readback.json`

Directories are `0700`; files are `0600`. The qualification receipt contains selected private profile/key metadata and hashes, never the API key. Asset receipts contain private response data, which may include URLs and provider IDs. Do not commit, publish, attach to a public PR, or paste these files into chat. No full request URL, authentication header or cookie is stored in those five receipts. The outer private journal/claims directory is intentionally separate so the receipt consumer can enforce its five-file contract.

A stopped run is not resumable. Preserve all partial evidence and the consumed marker. Do not remove the directory/marker to retry, select an existing ID, repeat DELETE, change identities or authorize another upload merely to clear the error. An ambiguous upload may have created an asset without a usable ID; an ambiguous deletion cannot establish absence. Have an authorized operator inspect the private evidence and provider state under a **separately bounded approval**. This runner intentionally has no recovery/delete-existing command. A local crash before the final rename can leave fully collected receipts in `partial`; review them separately rather than replaying the lifecycle.

A successful 404 proves API absence at that moment. It does not prove CDN denial, removal from backups, physical purge, permanent derivative deletion or absence of charges.

## Prepare, review and install freshness separately

After a completed run:

```sh
node tools/prepare-heygen-space-refresh.mjs \
  --private-evidence-dir /absolute/private/heygen-reprobe/run-20261002/receipts
```

That command is offline. It validates the exact same pinned credential/profile/native space, fixture, asset chain, delete/absence receipts and timing, and produces a public-safe candidate marked `reviewRequired: true`, `installed: false`, `databaseChanged: false`. Keep the raw five files private. Independently review their real request provenance and authorization; JSON relationships and hashes alone cannot authenticate a provider response.

Then follow [the October 2 release-readiness note](execution-notes/20261002-release-readiness.md): source-review the candidate document and exact canonical pin, run checks and exact-candidate packaging, deploy only with separate authorization, and verify the canonical read-only runtime resolution. No original DB evidence row is rewritten by a refresh. Until that reviewed installation, the old expired anchor remains fail-closed.

A trusted existing asset ID plus a read-only metadata call **does not satisfy** the current `reviewed-neutral-asset-reprobe-24h/v1` policy: it requires a fresh neutral upload, correlated own-asset read and completed cleanup. The October 1 proposal mentioned a read-only alternative for initial discovery; that does not authorize or implement a refresh alternative. Supporting one would require its own reviewed policy and code change.

## Offline verification

```sh
node --test tests/heygen-space-reprobe.test.mjs tests/heygen-space-refresh.test.mjs tests/heygen-space-anchor.test.mjs
```

Tests use synthetic credentials, profiles, spaces and injected Responses only. They cover exact methods/payload and six-call budget; intent consumption before network; the five-file consumer; replay denial; unsafe paths/permissions; unauthorized execution; altered identity/fixture metadata; upload/delete ambiguity; no retries; malformed/oversized/redirected responses; wrong-space/owner denial; absence failure; secret-safe console output; and freshness/clock boundaries. Passing these tests is not evidence of a live refresh.
