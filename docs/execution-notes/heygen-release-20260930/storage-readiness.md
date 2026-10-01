# HeyGen release storage and database readiness

Observed 2026-09-30. Status: **production database/reference gate blocked; production Blob inventory verified; Preview Blob runtime binding blocked; current candidate undeployed**.

This was a read-only external audit. It did not query a production database, download customer media, call HeyGen, deploy, relink, migrate, change an environment variable, issue a new credential, copy/delete an object, or change a Vercel/Neon resource. Temporary environment files were removed. `.vercel/project.json` remained byte-identical at SHA-256 `12FD6EF128686D8ED4918A6F214780CA46BA87A9397892F46EC55356F75054F2`.

## Release/deployment identity

| Surface | Current evidence |
|---|---|
| Dirty local candidate | Git HEAD `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`; source digest `4ed666e9b465596427e7c7b20fe36df2364362310e6104f5dc06407624bd262b` over 383 source files. Not deployed. |
| Stable production alias | `lux-video-os.vercel.app` resolves to `dpl_AEUWrAaSPEyvNjkkZxCbDAg427WP`, READY/PROMOTED, created 2026-09-24, recorded Git SHA `a04e59513e7cbd5684bf56790311d2ab14676499`. |
| Latest main Preview | `dpl_DLi3r7gP11RoanJLpVeTVW6k86wy`, READY/STAGED, created 2026-09-29, recorded Git SHA `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`. |

The stable alias is older than committed main and excludes the complete local candidate. Neither READY state proves the new enrollment/provider/reconciliation behavior.

[Sanitized deployment receipt](storage-deployments.json), SHA-256 `8F5E7ABE84374943270337B3E9404A1B43DD77573853552865DCB838180A644C`.

## Database identity

Authenticated Vercel environment metadata proves that both deployments include canonical `DATABASE_URL` and `DATABASE_URL_UNPOOLED` names. The corresponding project variables are `sensitive`; even the exact per-variable authenticated endpoint withholds their values and provides no integration-store content hint. `vercel env pull --id` cannot read a READY deployment (`INITIALIZING` is required). Therefore the canonical application connection cannot be safely parsed or compared.

The separate Vercel Neon integration is fully identified:

- Vercel integration store `store_iz6hgCg4fbRQkg3Y`, external resource `still-voice-83326863`;
- Neon project `still-voice-83326863` (`neon-byzantium-drum`), region `aws-us-east-1`, PostgreSQL 18;
- default/primary branch `br-broad-sunset-awrsmiwa` (`main`);
- read-write endpoint `ep-autumn-morning-awa4hmb6`;
- pooled host `ep-autumn-morning-awa4hmb6-pooler.c-12.us-east-1.aws.neon.tech`;
- direct host `ep-autumn-morning-awa4hmb6.c-12.us-east-1.aws.neon.tech`;
- database `neondb`, role `neondb_owner`.

Authenticated per-variable reads of the `videoos_*` integration values match that provider identity exactly. They are not the app's canonical variables, so they were not used to query production.

Conclusion: **canonical production and Preview database identities remain unverified**. Production schema/migration state and database-to-Blob references remain unknown.

[Sanitized database identity receipt](storage-database-identity.json), SHA-256 `F8781EE2F20697136E51BD263C61AEEA7437ADFF84C21D6BF0AF89C73B153521`.

## Blob stores and objects

The current team inventory exposes four Blob stores, all reporting `access: private`; none reports public access. This is current control-plane scope, not proof about deleted/external stores or database references.

### Production

- Store `store_0OoP7sznVEvMzwQu`, private, available, iad1, connected only to production.
- The production token's Vercel content hint binds it to that exact store.
- A complete read-only list returned **77 objects / 69,417,975 bytes**, exactly matching control-plane metadata.
- The canonical sanitized manifest remains `b55bb0044fb7fc9f92acc55f66d490276f6b22888d3cbf1eded9a2f01f9caf6b`; the private raw manifest remains `7fce6b4cfa820c66d8cf922ce6d897eca61530b57b24b17599faaa80cc737440`.
- The inventory is unchanged from the earlier Prompt 4 receipt.
- **26 objects / 20,180,632 bytes remain unclassified.** They are not declared orphaned or safe to remove.

[Sanitized production object receipt](storage-production-blob-inventory.json), file SHA-256 `DEECF81DBA0D16C5DBADFBCDD9AAFBABA6994E47FE0809F3EC33175CCDD04B4A`. The raw pathname/ETag manifest remains outside Git at `%TEMP%\lux-video-os-heygen-release-20260930\production-store-0OoP7sznVEvMzwQu-20260930T185625Z.json`; file SHA-256 `1004204E2057093041774003C333E1B7ADA95548C820064CB50714A2EB23801C`. It contains metadata only and must remain private.

### Preview

- Store `store_LC1XGHwpUvan4WD3`, private, available, iad1, 92 objects / 19,075,901 bytes.
- Vercel control-plane metadata connects it to Preview and names `dpl_DLi3r7gP11RoanJLpVeTVW6k86wy` as the latest deployment.
- The Preview `BLOB_READ_WRITE_TOKEN` is a write-only `sensitive` variable with no store content hint. Its value is withheld by the authenticated per-variable endpoint and omitted by a branch-specific Preview pull.
- Deployment metadata proves that a variable with that name was injected, but not which store its runtime value targets.

Conclusion: Preview store access/count/connection are current, but **runtime credential binding and object enumeration remain unverified**. No Preview success receipt exists.

[Sanitized Blob metadata receipt](storage-blob-metadata.json), SHA-256 `1E3E3A82BA32C1BFAA46013C558ACC605F35ED23D842D02EC036950EDAA7E01A`.

## Required owner-controlled resolution

1. **Canonical production database:** obtain the canonical pooled/direct values from their authoritative secret source. Confirm their host/database/role map to the proposed Neon identity above. Because Vercel cannot reveal these sensitive variables, the practical fallback is an explicitly authorized rotation/re-save from the Neon console or an authorized candidate deployment exposing only a nonsecret, fail-closed identity receipt. Do not copy `videoos_DATABASE_URL` into `DATABASE_URL` by inference.
2. **Production target manifest:** after confirmation, the integration lead may create `config/database-target.production.json` from the proposal in `storage-database-identity.json`. Then run the fail-closed migration/schema verifier against the canonical variables. Do not migrate automatically.
3. **Production reference inventory:** only after step 1, query storage-reference columns read-only, keep raw references outside Git, and join them to the private raw Blob manifest. Resolve all missing/unreferenced/unclassified counts before any migration or deletion proposal.
4. **Preview Blob credential:** owner must either prove the hidden Preview token targets `store_LC1XGHwpUvan4WD3`, reconnect/rotate it to that exact private store, or provide a temporary securely scoped read mechanism. Any reconnection/rotation is an environment write and needs explicit authorization. Re-run the sanitized object inventory afterward.
5. **Candidate publication:** the current source digest is not deployed. Deployment, alias promotion, environment changes and real-provider work remain separate owner-authorized actions.

## Gate verdict

- Stable alias identity: **PASS, but stale candidate**.
- Production Blob metadata/token binding/full object listing: **PASS**.
- Production database-to-Blob reference inventory: **BLOCKED by canonical DB identity**.
- Production unclassified-object disposition: **BLOCKED (26)**.
- Preview private-store metadata: **PASS**.
- Preview runtime credential binding/object inventory: **BLOCKED**.
- Production migration/schema verification: **BLOCKED by canonical DB identity**.
- Current local candidate hosted proof: **NOT EXECUTED**.

These blockers are independent of HeyGen API deletion semantics. Verifying or executing remote provider deletion requires the provider account and an explicitly authorized provider operation; this lane made no HeyGen call.

## Files written by this lane

- `docs/execution-notes/heygen-release-20260930/storage-deployments.json`
- `docs/execution-notes/heygen-release-20260930/storage-database-identity.json`
- `docs/execution-notes/heygen-release-20260930/storage-blob-metadata.json`
- `docs/execution-notes/heygen-release-20260930/storage-production-blob-inventory.json`
- `docs/execution-notes/heygen-release-20260930/storage-readiness.md`

No application, schema, migration, configuration manifest, environment, deployment, provider or external data was changed.
