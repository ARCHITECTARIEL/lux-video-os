# HeyGen v3 deletion, reconciliation, limits, and privacy research

Date: 2026-09-30. Status: **official documentation verified; account-bound deletion proof unavailable**.

This research used DeepAPI web search and website scraping against official HeyGen sources only for conclusions. It made no HeyGen API request, upload, create, render, or delete. A separate root-lane read-only connector call observed a Creator subscription and 200 premium credits, but that connector identity is not proven to use the application's `HEYGEN_API_KEY`; it is not account-bound release evidence.

## Release decisions

1. **HeyGen's uploaded asset is public at the provider.** The official [Upload Assets guide](https://developers.heygen.com/docs/upload-assets) describes the `url` returned by `POST /v3/assets` as the uploaded file's **public URL**. The multipart endpoint used by `services/heygen.js` documents no private/access/expiry option. A separate direct-upload flow uses an expiring presigned upload URL, but completion still creates a normal reusable asset. Private Vercel Blob storage does not prove the HeyGen copy is private.
2. **Deletion APIs exist for every v3 resource used by the current adapter:** uploaded asset, avatar group, avatar look, instant-cloned voice, and generated video. Professional/model-backed voice deletion exists in a separate namespace.
3. **Deletion is not yet release-proven.** The repository has no HeyGen read/list/delete adapters, the application API key's account identity has not been read back, no exact live resource roster has been reconciled, and no delete-then-GET test has run.
4. **Do not delete source assets automatically after provider creation yet.** Official docs do not say whether deleting a source `asset_id` can affect a created avatar or voice. Prove that dependency with a bounded canary before adopting source cleanup.
5. **Instant voice cloning has an ambiguity gap.** The official [`POST /v3/voices/clone` reference](https://developers.heygen.com/reference/clone-a-voice) does not document `Idempotency-Key`, 24-hour replay, or `409 request_in_progress`; its examples omit the header. The current durable PENDING receipt correctly prevents blind repeats, but a timeout before the voice ID is returned requires read-only inventory/reconciliation rather than another clone call.

## Owner-selected temporary-public bridge

The MVP will keep HeyGen as the provider and treat uploaded provider assets as **temporary public bridge copies**, not private storage. That is viable only with an event-bound lifecycle and receipts that never imply more than they prove.

### Source-photo and derived-voice bridge

1. Keep the authoritative photo, phone video, and derived WAV in private application storage.
2. Immediately before upload, re-read and hash the exact approved photo or derived WAV. Never upload the original phone video for this flow.
3. Upload with a stable operation key where the API documents it, and record the provider `asset_id`, a hash of the returned public URL, exact bytes/hash, exposure start, account fingerprint, and operation receipt privately.
4. Create the avatar/voice and persist provider IDs before changing local state. Ambiguous calls remain PENDING; never repeat them blindly.
5. Poll until the derived avatar look/group or cloned voice is READY/complete. “Request accepted” is not the deletion trigger.
6. **Dependency deletion remains unverified.** Five varied official searches found no statement that deleting a source asset after avatar/voice READY preserves the reusable avatar or voice. Before automating source deletion, run one owner-authorized canary per resource type: delete the source asset, require asset GET 404, then prove the derived avatar/voice remains readable and usable. No paid generation or live delete was authorized in this research lane.
7. After the dependency canary passes, delete each temporary source asset at the earliest safe event—derived resource READY plus durable local/provider receipt—and require exact asset GET 404. HeyGen publishes no source-asset retention TTL, so do not claim a provider-defined number of hours or days. Any operational cleanup SLA is an owner policy and must be labeled as such.
8. Separately test the old public CDN URL without credentials and require a non-success result before closing exposure. Official docs do not say that `DELETE 200` or API `GET 404` immediately revokes the old CDN URL; this is a distinct, currently unverified gate.

Suggested receipt states: `LOCAL_PRIVATE_VALIDATED -> PROVIDER_PUBLIC_UPLOADED -> DERIVATION_ACCEPTED -> DERIVED_READY -> ASSET_DELETE_AUTHORIZED -> ASSET_DELETE_ACCEPTED -> ASSET_API_ABSENT -> PUBLIC_URL_DENIED -> CLOSED`. A failure, timeout, dependency regression, or still-readable public URL moves the item to `PENDING_RECONCILIATION`, never back to upload/create.

Minimum private fields: local owner/resource IDs, provider account fingerprint, resource type, provider ID, public-URL hash, exact byte SHA-256 and count, operation key, exposure start, derived provider IDs/status, deletion authorization reference, DELETE status/code, GET status/code, public URL denial result, timestamps, and retry count. Keep raw URLs and customer identifiers out of Git and routine logs.

### Generated-video bridge

Download the completed provider video into private storage, fully decode and validate it, verify the authorized download hash, and atomically accept/debit the job first. Only then may an authorized cleanup operator delete `DELETE /v3/videos/{video_id}`, require `GET /v3/videos/{video_id}` to return `404 not_found`, and separately test the old delivery URL. A provider-ready state or successful download alone is insufficient deletion authority.

## Official API matrix

| Resource | Create / read / list | Delete | Success and absence | Restrictions and retry semantics |
|---|---|---|---|---|
| Uploaded asset | `POST /v3/assets`; `GET /v3/assets/{asset_id}`; bulk known-ID status via `GET /v3/assets/statuses`. No list-all-assets endpoint was found in the official index or permission table. | `DELETE /v3/assets/{asset_id}` ([reference](https://developers.heygen.com/reference/delete-asset)) | `200 {data:{id}}`; absent `404 asset_not_found`. | Requires `assets:write`; upload accepts optional `Idempotency-Key`. The upload key replays the original response for 24 hours; an in-flight duplicate returns `409 request_in_progress`. The delete page does not document an idempotency header or explicitly classify repeat-delete 404 as success. |
| Avatar group | `POST /v3/avatars`; `GET /v3/avatars/{group_id}`; `GET /v3/avatars`. | `DELETE /v3/avatars/{group_id}` ([reference](https://developers.heygen.com/reference/delete-avatar-group)) | `200 {data:{id}}`; absent `404 avatar_not_found`. | Permanently deletes the group and all looks. Public/community groups cannot be deleted. Create accepts the documented 24-hour idempotency contract. |
| Avatar look / `avatar_id` | Creation returns `avatar_item.id`; read `GET /v3/avatars/looks/{look_id}`; list `GET /v3/avatars/looks`. The look ID is passed as `avatar_id` to video creation. | `DELETE /v3/avatars/looks/{look_id}` ([reference](https://developers.heygen.com/reference/delete-avatar-look)) | `200 {data:{id}}`; absent `404 not_found`; unsupported type `400`; public look `403 forbidden`. | Supports photo-avatar, digital-twin, and kit looks. Studio/model-index looks cannot be deleted by API. Deleting the last look also deletes its parent group; subsequent group reads return 404. Do not blindly delete both look and group without cascade-aware readback. |
| Instant-cloned voice (current app path) | `POST /v3/voices/clone` returns `voice_clone_id`; poll `GET /v3/voices/{voice_id}`; list `GET /v3/voices`. | `DELETE /v3/voices/{voice_id}` ([reference](https://developers.heygen.com/reference/delete-a-voice)) | `200 {data:{voice_id}}`; unknown/already-deleted `404 voice_not_found`. | An active template using the voice blocks deletion with `403 resource_access_denied`. Official docs explicitly say a delete-then-list flow may treat `voice_not_found` as successful absence. Deletion frees the instant-clone allowance. Clone creation has no documented idempotency header. |
| Professional/model-backed voice (not the current app clone path) | `POST /v3/models/audio/voices`; `GET /v3/models/audio/voices/{voice_id}`; list `GET /v3/models/audio/voices`. | `DELETE /v3/models/audio/voices/{voice_id}` ([reference](https://developers.heygen.com/reference/delete-an-audio-voice)) | `200 {data:{status:"ok"}}`; absent `404 voice_not_found`; training `409 resource_not_ready`. | Only `ACTIVE` or `FAILED` voices may be deleted; wait for `PENDING`. The official [MCP overview](https://developers.heygen.com/mcp/overview) says a repeated successful deletion returns the same successful response. Deletion frees the purchased professional-voice slot. Keep this namespace separate from instant clones. |
| Generated video | `POST /v3/videos`; `GET /v3/videos/{video_id}`; `GET /v3/videos`. | `DELETE /v3/videos/{video_id}` ([reference](https://developers.heygen.com/reference/delete-video)) | `200 {data:{id,deleted:true}}`; absent `404 not_found`. | Official docs describe deletion as permanent and inclusive of associated files. Create supports optional 24-hour `Idempotency-Key`; current adapter correctly sends the internal job ID. Delete docs do not specify repeat-delete handling beyond 404. |

The API key permission matrix is documented at [API Key Permission Scopes](https://developers.heygen.com/docs/api-key-permissions): reads use `assets:read`, `avatars:read`, `voices:read`, or `videos:read`; deletes require the corresponding `*:write` scope.

## Current adapter comparison

| Current `services/heygen.js` path | Official behavior | Current status |
|---|---|---|
| `POST /v3/assets` | 200 asset metadata; public URL; max 32 MB; optional 24-hour idempotency key | Adapter validates bytes/type but does **not** send `Idempotency-Key` and discards the public URL. An ambiguous upload can therefore create an unreconciled public provider copy. |
| `POST /v3/avatars` | 200 asynchronous `avatar_item` look plus `avatar_group`; create supports optional 24-hour idempotency key | Adapter sends its durable operation key as `Idempotency-Key`, records group/look IDs, and polls both IDs. |
| `POST /v3/voices/clone` | 200 `voice_clone_id`; async poll via `GET /v3/voices/{id}`; account-specific clone allowance | Adapter matches the documented path and response but cannot use a documented idempotency header. PENDING reconciliation must inventory private voices before any retry. |
| `POST /v3/videos` | 200 video ID in waiting state; create supports optional 24-hour idempotency key | Adapter sends the internal job ID as the key and polls `GET /v3/videos/{id}`. |
| Delete/read/list reconciliation | Official endpoints above | Not implemented. No local receipt can currently prove provider deletion. |

## Pricing and operational limits

- The official [Usage Limits](https://developers.heygen.com/docs/usage-limits) page documents 10 included concurrent workflows for Pay-As-You-Go and 20 for Enterprise; excess returns `429` with `Retry-After`. Enterprise burst can add up to 50 per workflow type at 1.5x the contract rate.
- `POST /v3/assets` is capped at 32 MB and supports PNG/JPEG, MP4/WebM, MP3/WAV, and PDF. MIME is detected from bytes. The application's 20 MB generic upload ceiling and stricter 3 MB identity photo/voice limits are within this provider limit.
- Video input URLs must be public; direct video resources are capped at 100 MB and below 2K resolution. Output dimensions may be 128–4096 pixels; an avatar/image scene is capped at 30 minutes.
- The official [API pricing article](https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained) says API purchasing is standalone Pay-As-You-Go. As of its 2026-09-16 update: Photo Avatar creation is $1.32 / 26 API credits per call; default Avatar IV Photo Avatar video generation is $2.31 / 46 credits per generated minute; Avatar III Photo Avatar is $0.99 / 20 credits per minute. `POST /v3/videos` uses Avatar IV when `engine` is omitted, per the official [MCP overview](https://developers.heygen.com/mcp/overview).
- Pay-As-You-Go credits expire after 12 months; deprecated API Pro/Scale credits expire after 30 days. HeyGen states it has offered no free API credits since February 2026.
- Instant voice clones have an account-specific allowance. The reference's example error says “limit reached (10),” but the guide deliberately describes the allowance as account-specific; do not hard-code 10 without app-key account readback.
- Professional voices use purchased slots. The [HeyGen Voice guide](https://developers.heygen.com/docs/models/heygen-voice) documents one slot per professional voice, five pooled trainings per slot per monthly billing period, failed trainings free, and synthesis at 0.6 API credits/minute.

The root-lane connector's Creator/200-credit observation may describe a different HeyGen identity from the application's API key. It cannot set pricing, concurrency, resource limits, or deletion scope for production until exact identity binding is proven.

## Privacy and retention

- `POST /v3/assets` returns a **publicly accessible** provider URL. “Encrypted at rest” and tenant-isolation statements on HeyGen's [Security Practices](https://www.heygen.com/security) page do not make that URL private.
- HeyGen's [Privacy Policy](https://www.heygen.com/privacy) says User Input includes voice, scripts, images, and videos and may contain facial imagery. It states that non-enterprise data may be used to train/improve models, with opt-out by emailing `privacy@heygen.com`; the security page says Enterprise customer data is excluded from training by default.
- The general policy retains data as needed to provide the service, maintain generated content, resolve disputes, enforce agreements, and protect safety. It says deletion requests are acted on within 72 hours unless retention is legally allowed/required; deleted/account data remains in disaster-recovery backups for 60 days before automatic permanent erasure.
- The [Biometric Information Privacy Notice](https://www.heygen.com/biometric-privacy-notice) covers face geometry and possible voiceprints. Verification-only biometrics are described as deleted after comparison, typically within minutes. For EEA/UK/Swiss users, avatar-creation biometric data remains while the avatar is active and is destroyed within 60 days after avatar deletion or account termination. Training data is subject to separate consent/objection language and a 60-day identifiable-data deletion target where technically feasible.
- An API `DELETE` followed by resource-specific `GET 404` proves logical API absence only. Official endpoint docs do not promise immediate physical purge or backup removal. Keep API deletion receipts separate from privacy-request and backup-retention evidence.

## Required reconciliation design before any live delete

1. **Bind the account first.** With the exact application credential, read `GET /v3/users/me` and record a sanitized identity fingerprint. Do not substitute the connector account.
2. **Inventory from stored IDs.** Persist every provider asset/group/look/voice/video ID at acceptance time. HeyGen documents exact asset reads and bulk status for known asset IDs, but no list-all-assets endpoint. Missing asset receipts cannot be recovered reliably by enumerating the account.
3. **Plan one exact resource at a time.** The plan must name resource type, provider ID, owning local account/identity/job, upstream receipt, current GET result, dependency relationships, requested action, and expected post-delete error code.
4. **Respect dependencies.** Decide between group deletion and look deletion using current look count. A group delete removes all looks; last-look deletion removes the group. Voice deletion may be blocked by templates. Do not delete a source asset until a canary proves the derived avatar/voice remains functional without it.
5. **Delete only with fresh owner authorization.** No broad “cleanup all” operation. Use one bounded batch with a stop on the first unexpected status.
6. **Read back immediately.** After 200, call the exact GET and require the documented resource-specific 404. For instant voices, `voice_not_found` is explicitly documented as successful absence. For asset/video/avatar 404-as-success is an operator inference, not an explicit repeat-delete promise; record that distinction.
7. **Keep an immutable private receipt.** Record request correlation, resource type/ID hash, method/path, pre-state, response status/code, post-delete read status/code, timestamp, and operator authorization reference. Never store API keys or public asset URLs in Git.
8. **Reconcile ambiguous creation before retry.** Asset and avatar/video creation can use documented idempotency keys. Instant voice clone cannot rely on a documented key; query `GET /v3/voices` and match only strong server evidence. If a unique match cannot be proven, hold PENDING and escalate rather than creating another clone.

## Evidence boundaries and remaining unknowns

- **Documented:** paths, normal success bodies, listed error codes, public asset URL, avatar cascade behavior, voice template blocker, professional PENDING blocker, limits, published pricing, and privacy-policy timeframes.
- **Inference:** treating asset/video/avatar absence codes as reconciled repeat-delete success; dependency safety after source-asset deletion; exact deletion latency between DELETE 200 and GET 404.
- **Unavailable without app-key readback/canary:** production account identity and scopes, real resource inventory, account-specific clone/avatar limits, current credit balance, delete behavior for the exact account, public URL accessibility after DELETE, dependency survival, and physical purge timing.
- **Not performed:** any HeyGen API GET by this lane, or any upload/create/delete/paid call. The root-lane connector GET is separately recorded and explicitly unbound to the app key.

## Research receipts

DeepAPI searches: `ef19ea92-43cb-4d5c-b8a3-084afe72fbb1`, `8c944f54-8e4c-45fe-92de-9b4ed5b994cd`, `50f74b51-c1d4-4555-8bdc-5496561941be`, `5abcaaaf-55ba-4a69-bbd5-ba3293a27854`, `cd2eb9ab-8262-42ee-b2af-965f4d6c22b0`, `c983771c-eb37-4dde-94cb-90d92e9039b1`, plus six endpoint-specific and five privacy/retention variants.

Temporary-bridge dependency searches: `c54d39ef-db5f-4d7f-bad7-1c61e55ecf8d`, `15ac2658-b0dc-4f8d-b7b6-502224ae2165`, `d6a8bcea-81a2-4f02-9a54-3fe91a411089`, `578c145a-b329-44b3-8450-22d01418b998`, `1fe4bdd0-ec75-46d0-8db2-b42e7f044691`. They found the official deletion pages but no official statement that deleting a source preserves derived avatars/voices or immediately revokes the CDN URL.

DeepAPI official-page scrapes: `108aedd9-7c88-42de-9f7f-f61d765d000f`, `902e8fd6-458d-42e3-af72-5bcdb8a9d1bb`, `4835892f-8315-46d0-93fe-10f584a3354e`, `ee78b319-2d22-4cc3-9b09-6dc2c7745180`, `871a126b-ccea-4d83-b26b-4739bd99c6e0`, `af1e6545-21bf-4bde-8ecc-abf6d0be9856`, `91e939d4-9f78-455a-8e16-80a2129ad9e4`, and `08393cbf-3c93-43c4-aee6-b0cd1f2800b2`. All completed successfully. DeepAPI balance remained above the low-balance warning threshold.
