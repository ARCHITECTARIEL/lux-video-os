# HeyGen credential, user, and space identity research

Date: 2026-10-01  
Status: **official documentation verified; no HeyGen credential or private identifier was read by this research lane**

## Decision

The current authenticated-user response does not document `username` as an immutable internal user, account, or workspace ID. A 32-character hexadecimal value observed in a private response is compatible with an implementation-generated identifier, but its shape is not a contract and must not be used as documentary proof.

The strongest current public identity field is `space_id` on an existing asset returned by `GET /v3/assets/{asset_id}`. HeyGen documents it as the identifier of the space containing that asset. With a trusted existing Assets API `asset_id`, the application can perform a read-only three-way qualification:

1. authenticate the exact credential with `GET /v3/api_keys/self` and retain its `key_id` privately;
2. read `GET /v3/users/me` and retain `username` privately;
3. read the known asset and require `asset.owner === currentUser.username`, then bind the credential to a namespaced hash of `asset.space_id`.

This can support a **HeyGen provider-space binding**. It must not be labeled a global account or workspace ID because the documentation does not state that a space is identical to an account/workspace or that a user can belong to only one space.

No documented read-only path discovered an arbitrary existing asset ID. The application therefore needs a trusted asset ID from a private application receipt/database or an explicit HeyGen UI “Copy ID” readback. Creating or uploading an asset solely to obtain `space_id` would be a separate provider mutation and is outside this research and the current read-only qualification scope.

## What `username` officially means

The official [Get Current User guide](https://developers.heygen.com/user-profile) describes the field as:

> `username` — Account username.

The current [Get Current User reference source](https://developers.heygen.com/reference/get-current-user.md) defines:

```yaml
username:
  title: Username
  type: string
```

It gives no description, format, pattern, stability promise, immutability promise, or relationship to an account, organization, team, workspace, or space. Official examples use both human-looking and generated-looking placeholders. Consequently:

- do not assert that `username` is mutable;
- do not assert that it is immutable;
- do not rename it `user_id`, `account_id`, or `workspace_id`;
- do not derive canonical authority from its 32-hex shape;
- do retain its protected equality relationship to other fields that HeyGen explicitly labels as usernames.

## Existing asset metadata provides a stronger boundary

The official [Get Asset reference source](https://developers.heygen.com/reference/get-asset.md) says the endpoint returns metadata for an asset in the caller's workspace. Its response requires:

```yaml
owner:
  description: Username of the asset owner.
  type: string
space_id:
  description: Identifier of the space the asset belongs to.
  type: string
```

It also requires `id`, `name`, `type`, and `uploaded_at`; `folder_id` and the public `url` may be null. The documented file-category field is exactly `type` (examples: `image`, `video`, `audio`, or `font`), not `file_type` or `mime_type`. `GetAssetV3Response` documents no byte-size or MIME field. For identity qualification, only `id`, `owner`, and `space_id` are needed. Source-photo hash, byte count, and MIME evidence must come from the application's pre-upload/POST receipt rather than being invented from the GET response. The qualifier should discard filenames, URLs, and unrelated metadata from public output.

The evidence supports these conclusions:

- equality between `asset.owner` and `/v3/users/me.username` links the current authenticated user to the asset-owner username at the time of observation;
- `space_id` is a documented provider identifier, not a hash of mutable profile text;
- the credential's ability to read the exact asset proves access to that resource in the caller's workspace;
- a private receipt proving the asset was created for this application strengthens provenance.

It does **not** prove:

- that `username` is immutable;
- that the current user is the only owner or member of the space;
- that `space_id` is a HeyGen account ID, workspace ID, organization ID, or billing identity;
- that the API key created the asset merely because it can read it;
- that every unrelated resource namespace uses the same space boundary;
- that access or membership cannot later be revoked.

The ledger fingerprint should therefore be explicitly namespaced, for example as the hash of a canonical object containing `{provider:"heygen", scopeType:"space", spaceId:<exact value>}`. The raw `space_id`, username, asset ID, and returned public URL remain protected evidence rather than routine logs or Git artifacts. Requalification must fail closed on a different space fingerprint.

## Read-only discovery paths checked

The following official read schemas do not expose a source Assets API ID or a space/account identifier:

- avatar group list/detail: group ID, names, previews, status, look count, consent status, and defaults;
- avatar look list/detail: look/group IDs, previews, avatar type, engine support, dimensions, status, and defaults;
- video list/detail: video ID, title, status, delivery URLs, timestamps, duration, and folder ID;
- voice list/detail: voice metadata and engine availability, without source audio asset metadata;
- brand kit list/detail: brand-kit IDs, colors, fonts, and logos.

The [Get Video Scenes reference](https://developers.heygen.com/reference/get-video-scenes.md) mentions the create-input name `image_asset_id` in aspect-ratio documentation, but its read response represents image/video/audio elements with element IDs and URLs. It does not return the original Assets API ID. It is not an asset-ID recovery path.

The [Get Brand Kit reference](https://developers.heygen.com/reference/get-brand-kit.md) returns `logos[].logo_id` and optional logo URLs. It labels `logo_id` only as a unique logo identifier; it does not label it an asset ID. It must not be passed to `GET /v3/assets/{asset_id}` or treated as a source ID. CDN URLs must not be parsed for undocumented identifiers.

The current API permission matrix documents exact reads and known-ID bulk status for assets but no list-all-assets endpoint. The official documentation index likewise lists Get Asset, Bulk Asset Statuses, upload/finalization, and deletion, but no list-all-assets operation. A trusted known `asset_id` is therefore a real prerequisite.

## Safe qualification sequence if a trusted asset ID is found

All values remain in protected evidence; public status should contain only hashes, booleans, counts, and reason codes.

1. Call `GET /v3/api_keys/self`; require active status, supported scope mode, valid expiry, and the required MVP permissions.
2. Call `GET /v3/users/me`; require a bounded non-empty string `username`. Do not interpret its syntax.
3. Call `GET /v3/assets/{trusted_asset_id}`; require returned `id` to equal the exact requested ID, non-empty `owner`, and non-empty `space_id`.
4. Require exact string equality between `owner` and `username`. Any mismatch is a binding conflict.
5. Hash `key_id` independently as credential identity and hash the namespaced provider-space identity independently. Do not collapse them into one fingerprint.
6. Record the private receipt that supplied the trusted asset ID and the observation timestamp. Never emit the asset URL.
7. Promote only to the ledger meaning explicitly approved for a HeyGen **space**. If the current schema calls that record an account scope, retain metadata that its provider-native scope type is `space` and avoid user-facing claims that HeyGen documented it as an account.
8. Re-read before any future provider mutation. A changed `space_id`, owner mismatch, missing asset, revoked key, changed scopes, or expired key blocks execution.

If no trusted existing asset ID is available, the correct result remains `provider_space_identity_unavailable`. It is not repaired by hashing `username`, email, plan, balance, key name, or a connector profile.

## If no trusted asset ID exists: bounded neutral-asset decision

The official pricing sources do **not** explicitly say that asset upload, asset metadata reads, or asset deletion are free or unbilled. HeyGen's [API Pricing Explained](https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained) says:

> API usage is measured in US dollar amount, and is based on the type and length of what you generate.

The self-serve table prices generated video, translation, lipsync, clipping, filler removal, speech, and avatar creation. The [Enterprise Pricing](https://developers.heygen.com/docs/enterprise-pricing) page also lists generation rates and places `POST /v3/assets` under endpoint/input limits, but assigns no rate to it. That omission is not an authoritative statement that the operation costs zero.

If no existing asset ID can be recovered, the smallest concrete owner decision is whether to authorize one non-customer neutral-asset lifecycle solely to establish the provider-space identifier:

- input: one deterministic, metadata-free neutral PNG containing no person, voice, customer content, brand content, or biometric data;
- scope: one `POST /v3/assets`, one `GET /v3/assets/{new_id}`, one `DELETE /v3/assets/{new_id}`, and one final exact GET expecting `404 asset_not_found`;
- preflight: the same credential must first pass `/v3/api_keys/self` and `/v3/users/me`; capture the applicable balance before and after privately;
- identity proof: require the returned asset ID to equal the new ID, `asset.owner === currentUser.username`, and a non-empty `space_id` before forming the namespaced provider-space fingerprint;
- retries: none for the upload or delete; stop on the first unexpected status and hold the new resource for reconciliation rather than repeat a mutation;
- exclusions: no avatar, voice, video, render, clone, translation, customer-media upload, or other provider write;
- cleanup: delete only the asset created in this exact operation and retain a private DELETE/GET receipt. Public-CDN URL denial is a separate deletion-exposure check because API absence does not prove immediate CDN revocation.

A hard dollar ceiling cannot be honestly guaranteed from the published documentation because no asset-operation rate or request-level spend-cap mechanism is documented. The approval must therefore choose one of two precise positions:

1. authorize exactly one currently unpriced neutral asset lifecycle, accepting that the public docs do not prove a zero charge; or
2. keep binding held until HeyGen provides account-specific written pricing that establishes a hard ceiling.

“Expected $0” may be recorded only as an operational hypothesis based on the absence of an asset rate, never as verified pricing or an approval ceiling.

## Evidence quality and remaining questions

Documented facts:

- `/v3/users/me.username` is a string named Username; the guide calls it Account username.
- `GET /v3/assets/{asset_id}` returns required `owner` and `space_id` fields.
- `owner` is documented as the asset owner's username.
- `space_id` is documented as the identifier of the asset's space.
- the asset endpoint describes the returned resource as belonging to the caller's workspace.
- no checked list/avatar/look/video/voice/brand-kit schema yielded an Assets API ID or stronger account/workspace identity.

Supported inference:

- matching `owner` and `username` links the same documented username value across current-user and asset metadata;
- a namespaced `space_id` fingerprint is stronger and more provider-native than a profile-field hash for resource-scope conflict detection.

Still unknown from public documentation:

- whether the private 32-hex username is immutable or globally unique;
- whether one user/API key can move between or access multiple spaces;
- whether HeyGen equates `space` with workspace, team, organization, billing account, or account;
- whether a space ID changes during account migration or workspace restructuring;
- whether a provider export or support response offers a separately documented canonical workspace/account ID.

## Research receipts

DeepAPI official-source searches, using generic questions only:

- `f8a343b4-a3ac-4869-b923-4da20a5f8c20`
- `baac3da1-098f-486e-8e45-40115f549e16`
- `acec1165-f8b5-455a-918c-7ea7693e4e02`
- `c75a48c4-92f3-4d12-95d1-68f2e0c8c3f4`
- `2f6f0fb4-7d26-4a75-bfc6-8bc2f0b0c9bf`

Official-page and schema scrapes:

- current-user guide/reference and documentation index: `e1b4c43c-e45e-4338-86fe-f6cd35533d78`
- public OpenAPI path check: `617209b8-6c55-49f3-87bc-675893d2182b` (the returned v4.0.8 file did not contain the current v3 user schema and was not used to infer identity semantics)
- exact current-user/current-key/asset reference sources: `300383b1-62be-4f03-ab83-0727eac19649`, `4b92a3d8-6024-4d1b-8a55-59f9ae4a5209`
- asset/folder/avatar/video resource schemas: `70efae04-e298-4a7c-b566-532adcb89ec1`, `dfb96b18-6739-48d8-8ceb-40149135e24c`
- list schemas checked for owner/space/source IDs: `6182b72e-b441-451f-b1b6-bf4c62b93e5b`
- brand-kit logo schema: `29aff89c-2d44-46c0-892b-183f4855bdff`
- public GitHub SDK discovery: `3c2ad190-322c-492b-8094-61564b6c7510` (no official HeyGen SDK establishing stronger identity semantics was found)
- neutral-asset pricing searches: `ba26d1f3-e3fc-4ba0-b544-9271407ecbbe`, `3dee7cbd-7678-4ca5-acd4-5b5e9f57e847`, `2e9d3bd0-8484-4b2b-b09f-64fcb6a3585e`, `91928b02-485e-476d-b912-0380ba36a5a8`, `44826c24-c14a-4937-8422-823484bd0761`
- pricing, upload, and delete source pages: `5a5c33a0-b64f-4f74-a4ae-e414c51d12ef`
- self-serve developer pricing path check: `2a76b24c-478e-4766-92c7-2781941183f6` (no page was returned; not used as evidence)

DeepAPI balance remained above the mandatory low-balance threshold. This lane made no HeyGen API call, read no HeyGen secret or private identifier, created no provider resource, downloaded no customer media, and performed no provider write.
