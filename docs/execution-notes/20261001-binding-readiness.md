# Provider-space proof and database-target readiness — October 1

Status: provider-space observation and disposable asset API cleanup verified; application/runtime binding still held.

**Later local milestone:** the [verification-only binding layer](20261001-local-space-binding.md) is now implemented and tested against the isolated DB, including real fresh key/profile reads and standalone CLI bootstrap/status. Production and creation/render wiring remain held. This note retains the earlier provider probe and target-mapping evidence.

## Completed provider proof

The owner explicitly approved the prepared one-asset probe. The uploaded fixture was a 32×32 neutral gray PNG, 95 bytes, SHA-256 `f96c86519d1502fd319cdb106ca2a5277a83e09ad4d6e85279756ce77f05563e`. It contained no customer media, face, voice, script or logo.

The exact owner-selected key ending `C2b1` was fingerprint-checked and requalified before mutation. Its authenticated profile matched the expected owner. The approved lifecycle then completed:

| Operation | Observed result |
| --- | --- |
| Upload the fixture once | HTTP 200; returned asset ID retained privately |
| Read that exact asset | HTTP 200; ID matched; owner equaled the authenticated username; nonempty `space_id` returned |
| Delete only that new asset | HTTP 200; returned ID matched the upload receipt |
| Read back the same ID | HTTP 404 with exact code `asset_not_found` |

There were two read-only qualification requests and four asset requests, no mutation retry, and no avatar/voice/video generation. The observed provider-space fingerprint is `1c1b9eac97b6e38e481d30ddf12e4332ecb04d08f727a4ff55997a733b3f584a`. Its canonical input is explicitly namespaced as `{provider:"heygen",scopeType:"space",spaceId:<private value>}`. This is a provider **space** association, not proof of a global account, billing organization or every resource namespace.

The asset GET exposes `type`, not `file_type` or `mime_type`. The one-off validator initially stopped on that incorrect field expectation before deletion. Official schema review resolved it: content facts came from the saved POST receipt (`image/png`, 95 bytes) and exact request hash; identity facts came from the saved GET (`id`, `owner`, `space_id`). No additional provider request was used to repair the local proof. The exact approved asset was then deleted and read back as absent.

Evidence: [redacted result and private receipt hashes](binding-readiness-20261001/provider-space-probe-result.json), [approved scope](binding-readiness-20261001/provider-space-probe-proposal.md), and [official identity research](binding-readiness-20261001/heygen-identity-research.md). Raw IDs/profile fields stay outside Git in the protected local receipt directory. The product deletion executor remains disabled; this was an explicitly approved operator probe.

Independent review [passed](binding-readiness-20261001/provider-space-probe-review.md): all 13 evidence hashes, exact credential/scope fingerprints, the single-resource ID chain, owner equality and namespaced space fingerprint were recomputed. The fixture decoded as 32×32 RGB PNG. JSON, documentation links and whitespace checks passed. No application source or dependency changed during this probe. The preserved one-off script contains the superseded metadata assertion and is evidence only; do not rerun it or reuse this exhausted approval.

## Limits

- API absence is observed. Public CDN denial and physical/backup erasure were not tested or claimed.
- No derivative was created. This does not prove that avatars/voices survive source deletion, or qualify their deletion/cascade behavior.
- Asset-operation prices are not explicitly published; the owner accepted the single unpriced lifecycle. Its charge was not measured. Do not claim a zero-cost result.
- No database binding, production environment update, schema migration, commit, push or deployment occurred.
- Username equality was used only as the documented owner relationship; no immutability was inferred from its hexadecimal shape.

## Database finding

The local `.env.local` and the Vercel Neon integration point at different endpoints. Runtime log timing and Neon control-plane metadata support `still-voice-83326863` / `br-broad-sunset-awrsmiwa` / `ep-autumn-morning-awa4hmb6` as the production candidate, but this remains an inference rather than direct attestation of the hidden canonical connection string. The older local URL must not be substituted. See [database mapping evidence and limits](binding-readiness-20261001/database-mapping.md).

## Exact next developer step

Use the namespaced provider-space proof when preparing the local binding resolver; do not invent a global HeyGen workspace/account ID or enable runtime mutations from this JSON alone. Preserve key fingerprint, evidence hashes, freshness/revocation checks and the existing cross-credential hold.

The existing key-only qualifier does not yet consume the separate space receipt and therefore still returns its account-identity hold. The next resolver must join the exact key/scope fingerprints to the verified private space evidence; a JSON flag alone is not authority.

Before persisting a production application binding, independently establish its canonical DB target/credential and intended application account. A protected original canonical connection or a separately approved, concrete configuration change is required; an integration-prefixed URL and temporal correlation are not replacements for that evidence. The production schema/CI/private-storage/rollback/P0 gates remain separate. No additional provider upload or cleanup is authorized by completion of this one-off probe.
