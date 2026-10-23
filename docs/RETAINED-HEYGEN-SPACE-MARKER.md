# Retained HeyGen space marker

## Purpose

Presenter creation currently relies on a reviewed space observation that expires after 24 hours. A retained neutral marker makes the space check read-only at runtime. This is a provider **space** proof, not a claim about a global HeyGen account or billing organization.

The marker is the existing 95-byte synthetic gray PNG fixture. It contains no customer image, voice, face, script, or brand material. HeyGen may retain it and may expose an asset URL. A later DELETE and 404 would prove API absence, not immediate CDN or backup erasure.

## Authority boundary

`config/heygen-space-marker.json` declares the authority mode. `marker: null` leaves the released 24-hour refresh path in force. An active reviewed marker selects the live-read path in deployed production with **no fallback** to the static refresh. No browser field or environment flag can select a weaker mode.

An active manifest pins the digest of one asset ID, original fixture and credential identity, owner digest, provider-space fingerprint, upload time and type, and protected upload/read receipt digests. The raw asset ID belongs only in the production `HEYGEN_SPACE_MARKER_ASSET_ID` secret and protected operator evidence. The manifest and exact packaged copies must match the source pin; the secret must match its asset-ID digest.

For each binding resolution, the server validates the pinned production database, qualifies the current HeyGen key/profile, then makes one bounded `GET /v3/assets/{id}`. It requires the exact ID, owner, type, upload time, and space. It discards raw provider values after producing a branded proof valid for at most 60 seconds. A missing, deleted, mismatched, or unreadable marker holds creation before any provider upload or clone. Existing binding, scope, and promotion rows stay unchanged.

## Activation sequence

1. Obtain owner approval to retain one neutral asset and separately approve the exact production secret write and deploy.
2. Upload the pinned 95-byte fixture **once** with the qualified owner key. Save the request claim, response, exact asset ID, and fixture hash in a private, non-Git directory. Do not retry an uncertain upload.
3. Read that exact new asset. Require owner equality with the fresh qualified profile; `type: image`; integer `uploaded_at`; and the original pinned `space_id` fingerprint. Save the private GET receipt. Do not create a video, avatar, or voice in this step.
4. Independently review the private receipts. Commit only the sanitized active manifest and its canonical digest pin. Set the raw ID as a Vercel **production Secret**, never a public variable or source file.
5. Run tests, a clean exact-head production build and final authorization. Both gates validate marker identity, the supplied marker ID digest, and packaged bytes. Confirm the production secret name is configured; its injected value is only proven when the deployed runtime makes the marker GET.
6. After release, the owner performs one consented presenter creation. Verify one avatar and one voice chain, terminal status, and no duplicate provider work. The full product launch/P0 gates remain separate.

## Rotation and offboarding

If the key, owner, provider space, or marker changes, hold creation. Review a new neutral marker and secret together; never silently fall back to an expired refresh. Delete the retired exact marker when it is no longer an active authority, and record DELETE acknowledgement plus exact 404 readback. Do not infer physical or CDN purge from that readback.

The retained marker is a single tiny provider asset. There is no daily upload/delete schedule, database migration, new dependency, or customer-media re-enrollment in this design.
