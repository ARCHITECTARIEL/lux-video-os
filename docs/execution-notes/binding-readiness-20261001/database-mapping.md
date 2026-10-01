# Production database mapping readiness

Date: 2026-10-01. Scope: read-only Vercel and Neon control-plane evidence. No production SQL, environment write, deployment, connection-string disclosure, or secret rotation occurred.

## Outcome

New temporal evidence makes Neon project `still-voice-83326863`, default/primary branch `br-broad-sunset-awrsmiwa` (`main`) and endpoint family `ep-autumn-morning-awa4hmb6` the leading production-target candidate. It does **not** independently prove the hidden canonical `DATABASE_URL` mapping.

An authenticated production admin request that necessarily reached the repository layer completed at `2026-10-01T14:43:21Z`, and the Neon control plane reports `ep-autumn-morning-awa4hmb6.last_active` as `2026-10-01T14:43:23Z`. No other visible project endpoint has a `last_active` value on October 1. This is a strong temporal correlation, but the available metadata does not define `last_active` as a per-query timestamp and provides no shared request/correlation ID. The candidate branch's sole user database is `neondb` and its sole listed role is `neondb_owner`; those are provider control-plane facts, not an attestation that the hidden canonical URL selects them.

The older local `.env.local` tuple maps instead to project `dawn-scene-51988854`, branch `br-young-base-ai9mgkgd`. This proves a second plausible target exists and makes substitution unsafe; it does not by itself prove which target the hidden production secret uses.

The canonical Vercel secret bytes remain unavailable. Authenticated reads of the two production `sensitive` variables return metadata and `value: null`; the deployment record exposes the variable names, not their values. The temporal evidence does not directly identify the canonical hostname, database, or role.

Verdict:

- Runtime provider target mapping: **high-confidence candidate inference; unverified**.
- Canonical secret-value attestation: **unavailable**.
- Production migration/schema query from this lane: **not performed and still held**, because the exact canonical credential is not retrievable and substituting `videoos_DATABASE_URL` or the older local URL would violate the release boundary.

## Evidence chain

1. Vercel project `prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW` has one production `DATABASE_URL` and one production `DATABASE_URL_UNPOOLED`, both type `sensitive`, without an integration content hint. Their authenticated per-variable endpoints currently return no value.
2. Stable production deployment `dpl_AEUWrAaSPEyvNjkkZxCbDAg427WP` is `READY`, targets production, and records both canonical variable names in its runtime environment inventory.
3. The deployment's recorded source, `a04e59513e7cbd5684bf56790311d2ab14676499`, reads only `process.env.DATABASE_URL` in `db/client.js`; it has no integration-prefixed fallback.
4. Vercel runtime logs record `POST /api/video-os-lite/admin` returning 200 at `14:43:21Z`. At that deployed source, every recognized 200 POST operation reaches a database-backed repository, watchdog, or reconciliation path; an unknown/default POST returns 400.
5. Neon control-plane metadata records `ep-autumn-morning-awa4hmb6.last_active` as `14:43:23Z`. No endpoint in the other two visible projects has a `last_active` value on October 1. This is supporting correlation only; the field's exact event semantics were not independently established.
6. That endpoint belongs to project `still-voice-83326863`, branch `br-broad-sunset-awrsmiwa`; the branch lists one user database (`neondb`) and one role (`neondb_owner`). The direct and pooled candidate hosts are recorded in the redacted metadata companion.
7. The separate Vercel Neon integration points to the same project and endpoint family. It corroborates the runtime observation but is not used as a substitute for the canonical variables.

## Local-target conflict resolved

The checkout's `.env.local` contains a parsable canonical pair for endpoint `ep-broad-sunset-aiua1fld` on project `dawn-scene-51988854`, branch `br-young-base-ai9mgkgd` (`main`). The file predates the production canonical variables and maps to a different Neon project. No evidence ties that local file to the current Vercel secret, so it must not be used to query or migrate production.

## Minimal next action

If the original current production canonical values were retained in an owner-controlled secret store, provide them through a protected absolute file. Parse them locally, compare only host/database/role against the verified target, then run the existing strict checker read-only; do not print the URLs.

If those values are not retained, Vercel cannot reveal them. The smallest definitive repair is a separately authorized owner action to re-save `DATABASE_URL` and `DATABASE_URL_UNPOOLED` from the verified `still-voice-83326863` / `br-broad-sunset-awrsmiwa` target, followed by an authorized deployment and the strict read-only identity/schema check. That write/deployment is not authorized or performed by this audit.

[Redacted machine-readable metadata](database-mapping-metadata.json) contains the exact nonsecret observations.
