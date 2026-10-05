# Phone enrollment and scripted videos: developer runbook

Updated September 30, 2026. Scope: local MVP implementation. Activation and a real HeyGen canary remain separate release work.

> 2026-10-04 candidate: the account-bound private enrollment canary below is
> local and inactive. Use the current handoff and live readback for production
> migration and deployment status; September 30 observations are historical.

## Product contract

The customer supplies a photo and one phone video. The photo determines the visible presenter. With explicit permission, the application extracts the recording's audio into a private reusable voice sample. There is no third mandatory upload. Once the photo avatar and voice are both ready, Standard and Premium accept a title, script, identity and output format, followed by an explicit credit quote and confirmation.

HeyGen is the selected provider for both MVP tiers. Their entitlements and prices remain separate. Lower-cost and open-source research is a nonblocking ROI track. Enrollment does not prove the speaker's identity, and an audio-energy check does not prove usable speech or successful voice cloning.

## Code map

- `public/identity.html`, `identity.js`, `identity.css`, `enrollment-client.js`: photo/video preview, camera capture, consent, upload and recovery.
- `routes/video-os-lite/enrollments.js`, `enrollment-upload.js`: owned enrollment API, private video preview, signed direct-upload authorization and callback/reconciliation.
- `lib/enrollment-policy.js`, `enrollment-dto.js`, `enrollment-private-store.js`: strict versioned contract, runtime private-store proof, capabilities and safe browser projection.
- `db/enrollment-repository.js`: transactional state transitions, source hashes, consent, operation leases, retries, identity finalization and revocation.
- `workflows/identity-enrollment.js`: durable hash, extraction, expiry and cleanup work. The uploaded video is never the avatar source; derived audio is never a customer-supplied third input.
- `services/enrollment-media.js`: bounded FFmpeg decoding and WAV extraction.
- `routes/video-os-lite/identities.js`, `services/heygen.js`: existing photo-avatar and voice provisioning under provider/account/privacy gates.
- `public/scripted-photo-client.js`, `studio.js`, `index.html`: shared script drafts, capabilities, quotes and submission recovery.
- `routes/video-os-lite/scripted-photo.js`, `lib/scripted-photo-quote.js`, `api/video-os-lite/render-v2.js`, `db/repositories.js`: saved projects, signed quotes, reservation and final source/authorization checks.

## Enrollment lifecycle

`identity-phone-video-v1` progresses through AWAITING_UPLOAD, SOURCE_HASHING, AWAITING_EXTRACTION_CONSENT, EXTRACTION_QUEUED, EXTRACTING and IDENTITY_READY. FAILED, REVOKED and EXPIRED are explicit outcomes. State versions and stable operation keys reject stale mutation and prevent duplicate finalization.

IDENTITY_READY means that local sources and an identity record exist. It does not mean HeyGen has accepted either component. Rendering requires the identity's real avatar and voice readiness. Do not auto-submit provider work simply because extraction completed.

The current consent policy is `identity-provider-bridge-v2`, purpose `identity-voice-enrollment`. It separately requires extraction, likeness, reusable voice, provider processing, archive/deletion acknowledgment, and `temporaryPublicProviderExposureAuthorization`. The sixth permission is initially unchecked and explains that provider photo/voice links can be accessed by anyone who has them. The original phone video stays in private application storage.

Historical `identity-video-audio-extraction-v1` remains historical extraction evidence; it cannot authorize the new exposure scope. An owned `IDENTITY_READY` enrollment can use `provider-reconsent` with the exact current photo, phone-video and derived-voice hashes, state version and idempotency key. It preserves consent history and does not record, extract or start provider work again. Missing, changed, quarantined or revoked sources fail closed. New source bytes require new authorization.

Supported source transport is private multipart Blob upload, not base64 JSON. The contract accepts MP4/MOV/WebM up to 100 MiB and 5–60 seconds, subject to decoded codec and resource checks. A native file capture fallback remains important on mobile. A declared MIME type or file extension is not media validation.

## Configuration and migration

The temporary-bridge foundation adds normalized provider account/resource/operation/reference/event records and account-first lifecycle guards. See the [reconciliation runbook](HEYGEN-RECONCILIATION-RUNBOOK.md) for safe inspection. Provider API account qualification and server-side binding remain explicit activation prerequisites; legacy IDs without verified ledger provenance are held. Read-only inspection and local signed-plan validation do not enable deletion execution.

New enrollment and extraction flags are off by default:

- `VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED`
- `VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED`

For a contained Vercel production canary, the candidate also requires
`VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID` to equal the authenticated owner's
account ID exactly, and `VIDEO_OS_ENROLLMENT_CANARY_STARTED_AT` to be the
reviewed UTC start of this new cohort. Production enrollment capability is
hidden from every
other account; create/consent/retry, private upload-token issuance and generic
identity photo/voice source uploads fail before media writes for other
accounts. New enrollment creation refuses an older photo; consent, retry,
upload reconciliation and callback acceptance refuse pre-canary enrollment
records. Provider reconsent is excluded from this private-only canary. A
missing pin or start timestamp fails closed. Revocation and owner-scoped existing
record reads remain available. This is an account boundary, not approval to
enable the flags. Keep the pin in place until an authorized attempt reaches a
terminal state or its upload token expires and cleanup is reconciled; do not
advance the cohort start timestamp while callbacks remain possible. While
the production pin is set, `providerCreationActivationStatus()` also holds
provider creation and render submission off even if their separate flag is
accidentally enabled. Removing the pin to pursue later provider work requires
a new scoped review; it disables new production enrollment until replaced.

Enrollment additionally requires Blob storage, durable Vercel Workflow dispatch, an exact HTTPS `VIDEO_OS_PUBLIC_ORIGIN`, a strong existing session secret, and `VIDEO_OS_ENROLLMENT_BLOB_STORE_ID` matching the configured private store token. Never put tokens in browser state, logs or handoff files. Existing provider, account, privacy, scripted-render and pricing gates still apply; enabling enrollment alone does not enable paid generation. The existing gates include `VIDEO_OS_IDENTITY_PROVIDER_ENABLED`, `VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID` (the contained pilot account), `HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED`, `VIDEO_OS_SCRIPTED_PHOTO_ENABLED`, `VIDEO_OS_STANDARD_SCRIPTED_CREDITS` and `VIDEO_OS_DURABLE_WORKFLOW_ENABLED`. Provider credentials remain server-only. These names are configuration requirements, not instructions to enable them now.

Migration `drizzle/0007_exotic_bruce_banner.sql` adds `identity_video_enrollments` and `identity_enrollment_events` without altering existing tables. Additive migration `drizzle/0008_ambiguous_scalphunter.sql` records dispatch and provider-reconciliation receipts and makes source/derived asset ownership unique. The September 30 isolated verification database had nine migrations and 18 application tables. The current handoff records production migrations `0007`-`0010` applied on October 1; reverify the canonical live target before activation. Do not substitute integration-prefixed database variables for the application's canonical DATABASE_URL or treat snapshot checks as live verification.

`tools/build-browser-clients.mjs` bundles the installed Blob upload client using the existing esbuild dependency. `tools/build-production.mjs` regenerates it before source attestation, validates all four enrollment workflow IDs and all three new API routes through the existing workspace function, and stages a Linux FFmpeg binary. Build output remains quarantined and review-only.

## Recovery and withdrawal

Recover the existing enrollment after an interrupted upload or hash step. Reconciliation checks the exact private object and operation. Retry only the allowed failed operation; never infer success from a timeout. Abandoned unfinished records expire; callback cleanup and a post-token-expiry check cover uploads that complete after revocation. Persist IDs and intent metadata, never media bytes or upload credentials, in browser recovery state.

Keep a stable render idempotency key across quote refresh, retries and uncertain responses. A quote belongs to one intent and one key. Recover a matching existing job before submitting again. Source, consent, tier, price and expiry checks must still pass under the reservation lock for new work.

Revocation must block further enrollment/provider/render claims even when new enrollment has been disabled. Preserve the audit record and report local cleanup failure honestly. Archiving locally is not evidence that a remote provider has deleted its resources. Provider deletion and retention are activation blockers: verify the exact HeyGen behavior and operator reconciliation path before enabling provider mutation. Pending remote receipts deliberately block repeat submissions.

## Verification and release handoff

Execution evidence is in `docs/execution-notes/enrollment-20260930/` and the dated execution note. Browser tests use controlled API responses; local FFmpeg tests use real generated media; isolated database/Blob tests must use the guarded runner and return the dedicated resources to zero rows and objects. None of these observations replace real-device capture or hosted Workflow/provider proof.

Next release work: validate current HeyGen account capabilities, pricing and privacy/retention terms; verify the exact production database and private store mapping; retain the verified Workflow/Sandbox packaging boundary; run current-candidate CI/CodeQL; prepare a bounded, owner-authorized canary and rollback plan. Test real iPhone and Android uploads, HTTPS camera permissions and the hosted FFmpeg resource envelope before activation. Keep billing and render flags contained until the applicable release gates pass.






## Operator checks after an authorized migration

Use the verified target and a read-only database session. This query lists local work requiring attention without exposing recordings, scripts or provider credentials:

```sql
SELECT id, status, cleanup_status, cleanup_attempts,
       provider_reconciliation_status, updated_at
FROM identity_video_enrollments
WHERE cleanup_status = 'FAILED'
   OR provider_reconciliation_status IN ('PENDING', 'FAILED')
ORDER BY updated_at;
```

An unresolved provider receipt is a hold, not permission to submit the same remote operation again. Compare the stored private receipt with the provider account, then follow an explicitly reviewed reconciliation/deletion procedure. Never mark a remote resource deleted based only on a local archive. The app blocks affected reuse while reconciliation remains pending.


The release manifest now marks a worker image inapplicable to the selected HeyGen managed API and retains explicit runtime-scope, account, price, privacy, deletion and canary gates. Self-hosted provider selections still require image/model proof.

## September30 bridge follow-up

The owner selected a temporary-public provider-upload design. Read [the reviewed bridge design](HEYGEN-BRIDGE-TEMP-UPLOAD-DESIGN.md) before implementing deletion. The new consent version, normalized resource ledger, independent approval authority and provider cleanup executor are planned; existing local source cleanup does not implement remote cleanup. Official DELETE contracts are documented, but raw-source independence and CDN denial remain live-canary gates. The local Sandbox boundary is now repaired; source-bound build proof is in [the latest execution note](execution-notes/20260930-heygen-bridge-release-gates.md).
