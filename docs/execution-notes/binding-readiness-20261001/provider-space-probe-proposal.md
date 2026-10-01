# Proposed disposable provider-space probe

Status: explicitly approved by the owner and executed. See [the redacted result](provider-space-probe-result.json). Original proposal SHA-256 at approval: `1f036e224568f5dac558ae3ffd2315b1baee61ac9aa65f6284cac6e932c578f3`.

## Why this exists

The new key ending `C2b1` authenticates and matches the owner profile. HeyGen's user/key endpoints do not document a stable provider space ID. Its Get Asset endpoint does expose `owner` and `space_id`; comparing owner with the authenticated username can establish a specifically named provider-space observation. No trusted existing Assets API asset ID has been located. Resource names, logo IDs, avatar IDs and CDN URLs must not be substituted.

This proposal crosses the existing project boundary against provider uploads/deletions without separately scoped owner authorization. It does not authorize production configuration, database writes, generation, broad inventory, or general cleanup.

## Exact proposed scope

- Credential: the owner-created key ending `C2b1` in ignored `.env.heygen.local`, with the fingerprint pinned by [the qualification status](../heygen-binding-20261001/qualification-status.json).
- Fixture: `provider-space-probe.png` in this directory; 32 by 32 neutral gray RGB PNG, 95 bytes, no metadata, person, face, voice, customer material or script.
- SHA-256: `f96c86519d1502fd319cdb106ca2a5277a83e09ad4d6e85279756ce77f05563e`.
- Before mutation: verify the file hash, exact credential fingerprint, active status and matching owner profile using read-only checks.
- At most one `POST https://api.heygen.com/v3/assets`, uploading only this fixture.
- One `GET /v3/assets/{id}` using only the exact ID returned by that successful POST. Require matching ID, expected file metadata, a nonempty space ID and owner equality with the authenticated profile.
- One `DELETE /v3/assets/{id}` for that same new ID only, followed by one exact-resource GET readback. No previously existing asset may be selected.
- No mutation retry. Timeout, inconsistent ownership, unexpected IDs, authentication failure or ambiguous responses stop further writes and retain private evidence for review.
- Store selected identity/receipt evidence outside Git. Public notes contain hashes, safe statuses and scope, never the key, raw media URL or private identity values.

No avatar creation, voice cloning, video generation, billing change, environment update or deployment is included. This is a space-identification probe, not the later derivative-survival or CDN-denial canary. API acknowledgement/absence must not be described as physical, CDN or backup purge.

## Cost boundary

Official sources do not explicitly state a price or zero-cost guarantee for asset upload/read/delete, and no per-request dollar cap is documented. This proposal therefore cannot honestly guarantee a hard zero-dollar charge. Approval must explicitly accept this single bounded, unpriced asset lifecycle; otherwise remain read-only and request a trusted existing asset ID or written provider pricing.

## Alternative

An existing Assets API asset ID from a protected creation receipt or an explicit provider UI Copy ID action allows a GET-only proof. Merely identifying a logo, avatar, video, filename, or image URL is insufficient.
