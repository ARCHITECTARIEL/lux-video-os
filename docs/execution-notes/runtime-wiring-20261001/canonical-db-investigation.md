# Canonical production database investigation

Date: 2026-10-01. Scope: redacted provenance recovery and the owner-approved read-only inspection of the integrated production database. No customer/application row read, migration, schema write, password reset, Vercel environment change, deployment, or alias change occurred.

## Conclusion

The hidden production `DATABASE_URL` and `DATABASE_URL_UNPOOLED` were originally populated from the Vercel Neon integration variables `videoos_DATABASE_URL` and `videoos_DATABASE_URL_UNPOOLED`. Their target is therefore confirmed as:

- Neon project `still-voice-83326863` (`neon-byzantium-drum`)
- default/primary branch `br-broad-sunset-awrsmiwa` (`main`)
- endpoint family `ep-autumn-morning-awa4hmb6`
- pooled host `ep-autumn-morning-awa4hmb6-pooler.c-12.us-east-1.aws.neon.tech`
- direct host `ep-autumn-morning-awa4hmb6.c-12.us-east-1.aws.neon.tech`
- database `neondb`
- role `neondb_owner`

This supersedes the earlier timing-only inference in `binding-readiness-20261001/database-mapping.md`. It confirms target provenance, not recoverability of the current hidden password bytes. Vercel still returns no value for either Sensitive canonical variable.

## Redacted provenance chain

1. Vercel connected integration store `store_iz6hgCg4fbRQkg3Y` and added the `videoos_*` variables at `2026-09-21T19:34:22Z` under one request (`8plvs-1790019262566-8a2071f04282`).
2. A private operator session pulled the production variables at `19:37:52Z`, then extracted the two `videoos_` URLs and supplied those exact in-memory values to `vercel env add DATABASE_URL` and `DATABASE_URL_UNPOOLED` at `19:38:12Z`.
3. After an initial CLI handling problem, the pair was deleted and re-added. The final command at `19:41:21Z` again extracted the two integration-prefixed values from the Vercel production pull and supplied them with `--force --sensitive` to the canonical variable names.
4. Vercel audit events record successful canonical additions at `19:41:26.462Z` and `19:41:29.752Z`. These align with the current variables' unchanged `updatedAt` values (`19:41:26.416Z` and `19:41:29.706Z`). No later canonical update is recorded.
5. A redacted historical pull observation at `19:40:18Z` safely parses the integration values to the exact pooled/direct hosts, database, and role listed above.
6. Stable production deployment `dpl_AEUWrAaSPEyvNjkkZxCbDAg427WP` was created on September 24, after those canonical writes, and its runtime inventory includes both canonical names. Its source reads only `process.env.DATABASE_URL`.

Private source reference: `C:\Users\ariel\.claude\projects\C--Users-ariel\88016a59-7c5a-43d4-a1a3-d5a7ac158f0c.jsonl`, SHA-256 `E93F93C735F9C6EAE8F6FA3443E9A0C948023D0829C357E0DB40DA59EB28E9E7`. The source contains credentials and remains outside the repository; this note records only timestamps, command provenance, and sanitized target identity.

## Fresh provider readback and protected credential

The owner designated the integrated target and authorized read-only inspection. Fresh Neon control-plane readback confirmed the project, default branch, endpoint pair, sole user database, and sole listed role. A fresh pooled/direct credential pair for that exact branch was retrieved through the authenticated Neon interface, validated locally without printing, and written only to:

`C:\Users\ariel\AppData\Local\Temp\lux-video-os-production-db-inspection-20261001\database.env`

That file is outside Git and contains the only fresh connection values used by this inspection. Its secret-derived hash is intentionally not published.

The reviewed nonsecret target is now [config/database-target.production.json](../../../config/database-target.production.json), SHA-256 `987C494527ADB6F4E7A08C0B68C38BE6A1EB3D7430CDBDD4927CE6CFDD9961EF`.

## Read-only database result

The repository's strict checker first passed Drizzle snapshot consistency, validated both fresh connection URLs against the target manifest, connected inside a repeatable-read/read-only transaction, and confirmed SQL identity `neondb` / `neondb_owner`. It then failed closed on the migration count, as intended.

The bounded follow-up inspected only `current_database()`, `current_user`, the Drizzle migration journal, and the schema catalogue. It did not select from application/customer tables.

- Expected migrations: **11**
- Applied migrations: **7**
- Exact matching prefix: `0000` through `0006` (timestamps and hashes all match)
- Unexpected applied migrations: **0**
- Missing migrations:
  - `0007_exotic_bruce_banner`
  - `0008_ambiguous_scalphunter`
  - `0009_absurd_meteorite`
  - `0010_provider_source_binding`
- Expected tables: **27**
- Observed tables: **16**
- Reviewed schema SHA-256: `2338bdba6521ebf6e6de6226218671ec92eeff34eff910b3f1f5424fb4de8bd0`
- Observed schema SHA-256: `3a0221951ef2f0819c6da97e866a0de6bd013b9518e625a96cc2986605d281fa`

Redacted receipt: [production-database-inspection.json](production-database-inspection.json), SHA-256 `EA47596732F9B824E0E29FD318011439796AB8193E6E3612F8C5F115A1EF6016`.

## Gate decision

Canonical target identity: **confirmed**. Production schema readiness for the current candidate: **failed closed**.

Runtime provider-space wiring cannot be activated against production until migrations `0007`–`0010` are separately reviewed, tested against a production-derived branch, explicitly authorized, applied, and followed by the same strict read-only check. This investigation does not authorize that migration or a deployment.

The earlier re-establishment proposal no longer needs a secret reset merely to determine the target. A future configuration refresh may still be desirable because Vercel cannot reveal the old password and the fresh inspection credential is not proven byte-identical to the hidden canonical value. Any such two-variable update and deployment remain separate owner-controlled actions. The current stable deployment retains its captured environment and remains the application rollback baseline.
