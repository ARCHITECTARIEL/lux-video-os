# Independent review — HeyGen provider-space probe

Date: 2026-10-01. Scope: offline review of the approved probe's saved private receipts and redacted result. This review made no provider request and performed no database, environment, deployment, billing, or provider mutation.

## Verdict

**PASS for a versioned local HeyGen provider-space binding plan.** The evidence binds the exact qualified credential to one provider-native `space_id` namespace through a disposable asset created by that credential, an authenticated-owner equality check, and one exact-resource lifecycle. It is stronger than a fingerprint made from profile text.

**It is not a global HeyGen account/workspace/organization/billing identifier.** Any plan or ledger promotion based on this proof must say `scopeType: "space"`, retain `globalAccountIdVerified: false`, and fail closed if a future observation yields a different provider-space fingerprint.

The current ledger and wire contract use account-named fields such as `providerAccountFingerprint`. The proof is sufficient input to a local binding plan, but an implementation must explicitly version the semantic as a provider authorization scope of type `space` and preserve that type in immutable evidence. It must not silently relabel this hash as a documented HeyGen account ID. An additive native-scope field is clearer; a no-schema MVP representation requires equally explicit contract documentation and regression tests before any promotion write.

## Receipt verification

- All 13 private evidence files match the SHA-256 manifest in `provider-space-probe-result.json`.
- The checked-in fixture is exactly 95 bytes and its independently computed SHA-256 is `f96c86519d1502fd319cdb106ca2a5277a83e09ad4d6e85279756ce77f05563e`.
- The upload claim binds that same fixture hash. The POST receipt records `image/png`, 95 bytes, and HTTP 200.
- The actual protected credential was used only for an offline equality calculation during review. Its credential-key and credential-scope fingerprints independently recompute to the saved qualification fingerprints. The credential itself appears in zero private evidence files and zero public result/proposal files.
- The single provider resource identity is consistent across the POST response, saved resource handle, GET response, DELETE response, and all three claim digests. Public evidence contains no raw asset ID, raw space ID, username, email, or key ID.
- The GET receipt returned HTTP 200; its resource ID matches the POST ID, its `owner` exactly equals the authenticated `/v3/users/me.username`, and `space_id` is nonempty and syntactically bounded.
- The namespaced fingerprint independently recomputes from canonical JSON `{provider:"heygen",scopeType:"space",spaceId:<protected value>}` and matches both the private space proof and redacted result.
- The DELETE receipt returned HTTP 200 and the returned ID matches the created resource. The exact follow-up GET returned HTTP 404 with `asset_not_found`.
- Receipt timestamps are monotonic. Qualification through final readback completed in about 290 seconds, inside the probe's 30-minute freshness gate.
- Source inspection shows one request wrapper, separate one-shot modes, no request retry loop, and console output limited to hashes/statuses. The saved receipts and journal are consistent with two qualification GETs, one asset POST, one asset GET, one asset DELETE, and one exact readback GET. This is local evidence; no provider-side request audit or billing statement was available to prove a universal negative.

## Validation correction

The first asset-read run correctly stopped before deletion because the probe expected undocumented GET fields `file_type`/`mime_type`. Official `GET /v3/assets/{id}` documentation instead defines required `type` and does not define MIME or byte size. The saved GET receipt already contained the exact ID, owner, and space fields needed for identity proof.

The offline correction validly separates the facts:

- content proof comes from the approved 95-byte fixture, the pre-request hash check, the exact multipart request construction, and the saved POST receipt (`mime_type: image/png`, `size_bytes: 95`);
- provider-space identity comes from the saved GET receipt's exact ID, `owner`, and `space_id`;
- the corrected private `space-proof.json` binds the GET receipt hash and exact resource ID before deletion.

No second metadata GET, upload retry, or replacement resource was used. The preserved `probe.mjs` still contains the superseded validation and must not be rerun as a current probe implementation. A future probe should validate documented GET `type` and `uploaded_at`, while continuing to source MIME/size/hash facts from the request and POST receipt.

## What the cleanup proves

The DELETE 200 plus exact GET 404/`asset_not_found` proves logical API absence for this disposable asset. It does not prove CDN URL denial, physical erasure, backup purge, privacy-request completion, or a zero charge. The redacted result correctly leaves `cdnDenialObserved`, `backupPurgeVerified`, and `chargeMeasured` false.

## Binding constraints carried forward

1. Bind the exact credential-scope fingerprint and namespaced provider-space fingerprint separately.
2. Store the protected evidence digest/reference; do not place raw provider IDs, profile values, URLs, or credentials in public logs or browser DTOs.
3. Treat provider-native scope as `space`, not account. Keep global account identity unresolved.
4. Credential rotation, scope change, owner mismatch, or a changed `space_id` requires a fresh proof and must not inherit the old resource graph automatically.
5. Continue exact-origin binding for each accepted provider resource. This one asset proves the credential-space relationship at observation time; it does not prove every unrelated HeyGen resource namespace.
6. Keep creation/render activation off until the local promotion representation and runtime resolver are reviewed and tested under the existing account-first lock.

Reviewed artifacts: [redacted result](provider-space-probe-result.json), [approved proposal](provider-space-probe-proposal.md), and private evidence directory named in the redacted result.
