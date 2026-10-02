# Read-only private-media byte verification

This operator tool is a follow-up to [PR #84](https://github.com/ARCHITECTARIEL/lux-video-os/pull/84), based on its tested `c0688a5` baseline. It performs authenticated metadata discovery and bounded, read-only byte hashing. It never copies, deletes, rewrites references, changes ACLs, configures credentials or certifies migration/release.

The prior inventory helper requires independently known exact count/bytes; rounded dashboard totals are not valid inputs. `tools/verify-private-media.mjs` instead records an authenticated bounded listing first, then verifies against that reviewed snapshot. This removes the need to guess totals while explicitly retaining all provenance, completeness and migration limitations.

## Inputs and safety

Use an already configured terminal with `BLOB_READ_WRITE_TOKEN` in its process environment. Do not put the token in command arguments, files, chat or screenshots. The tool rejects an incompatible store token, alternate Blob endpoint configuration, debug/wire logging and disabled TLS verification. Only the canonical private Blob hostname derived from the explicitly selected store is accepted.

Prepare a private expectations JSON outside the checkout from a current, authorized, read-only canonical production DB query. Schema:

- `schemaVersion`: `video-os-private-media-expectations/v1`
- `observedAt`: actual query observation time in ISO format
- `target`: exact `storeId`, `projectId`, `environment`, `access: "private"`
- `assets`: every in-scope `media_assets` row with `privatePathname`, integer `bytes`, stored SHA-256 `sha256`, and `kind`

Do not manufacture expected hashes or derive them from the same Blob reads being checked. Do not silently omit missing/malformed rows, quarantined references, or paths outside the accepted upload/final prefixes to obtain a passing report. Resolve the scope/completeness problem first. This tool accepts `video-os/uploads/` and `video-os/finals/` paths only; other categories remain inventory/disposition work. A manifest of media rows does not cover every possible legacy account/auth/job/JSON reference.

The current schema has `quarantined_at` but no `deleted_at` column on `media_assets`. The narrow export should include all rows for review; a quarantine timestamp is not deletion authority. A full reference/provenance audit remains a separate prerequisite. Preserve database identity/read-only-transaction evidence separately. The tool does not connect to the database and marks project/environment/database provenance as operator-supplied rather than independently attested.

### Optional read-only SQL export shape

Run only against the separately verified canonical production connection, in a repeatable-read read-only transaction. Confirm the database and role before accepting the resulting private manifest; never paste a connection string into the query or output. The provider project/branch association still requires separate canonical-target evidence.

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT current_database() AS database, current_user AS role;
SELECT jsonb_build_object(
  'schemaVersion', 'video-os-private-media-expectations/v1',
  'observedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'target', jsonb_build_object(
    'storeId', 'store_0OoP7sznVEvMzwQu',
    'projectId', 'prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW',
    'environment', 'production', 'access', 'private'
  ),
  'assets', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'privatePathname', private_pathname, 'bytes', bytes,
      'sha256', sha256, 'kind', kind
    ) ORDER BY private_pathname)
    FROM public.media_assets
  ), '[]'::jsonb)
) AS private_expectations;
ROLLBACK;
```

This SQL was checked against repository schema, not executed by this implementation. Store the JSON object itself, not a UI wrapper or invented sample values. Keep it private.

## Private filesystem requirements

On POSIX, private manifest/snapshot inputs must be mode 0600 with private parents; files and outputs must be outside the checkout where required. On Windows, the tool performs read-only SID/ACL checks: the private parent must be owned by the current user SID, have protected inheritance, and grant only that SID FullControl with file/container inheritance. Existing private files must have the matching owner/effective ACL; reparse points are refused. It neither creates nor changes these ACLs. An unavailable/failed check stops before network access.

Native Windows checks have mocked coverage but have not been executed on a native Windows host during implementation. Do not treat Node's 0600 mode alone as Windows privacy. Use a separately reviewed private-folder preparation procedure if needed. Never work in a shared/synced folder or weaken checks to proceed.

All output filenames are create-only. Choose fresh names for every attempt and retain failed reports. The raw snapshot contains private pathnames, sizes, upload times and ETags. Reports use credential-keyed object IDs instead of raw pathnames; they are still operational evidence and should be kept private by default.

## Step 1: authenticated bounded discovery

Run from the repository checkout after installing its pinned dependencies:

```sh
node tools/verify-private-media.mjs --mode discover \
  --manifest /absolute/private/db-assets.json \
  --store-id store_0OoP7sznVEvMzwQu \
  --project-id prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW \
  --environment production \
  --private-snapshot /absolute/private/new-storage-snapshot.json \
  --report /absolute/private/discovery-report.json
```

These paths are placeholders and must already have supported private protection; the command does not create the containing directory. Windows can use corresponding absolute private paths in a one-line command.

Discovery lists every bounded page and checks token/store/private-host identity, paths, sizes, versions, duplicates and advancing cursors. Hard limits are1,000 objects,256 MiB total,128 MiB per object,20 pages,30 seconds per request and15 minutes per run. `--max-objects`, `--max-total-bytes`, `--max-object-bytes` may only reduce those bounds. A clipped/invalid/over-budget inventory fails rather than claiming completeness.

Review the report and retain its exact `snapshotSha256`. That is a canonical snapshot digest, not a claim that the supplied DB manifest or project association was independently attested. A self-consistent snapshot cannot clear a migration gate.

## Step 2: verify the referenced current private bytes

After reviewing discovery, use its exact digest:

```sh
node tools/verify-private-media.mjs --mode verify \
  --manifest /absolute/private/db-assets.json \
  --store-id store_0OoP7sznVEvMzwQu \
  --project-id prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW \
  --environment production \
  --snapshot /absolute/private/new-storage-snapshot.json \
  --snapshot-sha256 <reviewed-snapshotSha256> \
  --report /absolute/private/verification-report.json
```

The tool requires the snapshot to bind the same expectations manifest/target, relists before transfer, and reads only explicitly referenced upload/final objects. GET uses canonical HTTPS, redirects disabled, cache bypass, `If-Match`, identity encoding and bounded streaming. HTTP status, Content-Length, ETag, full byte count and SHA-256 must match; another complete listing must agree afterward. Bytes are hashed in memory and not written as media files.

A missing/mismatched/ambiguous object stops further media reads and remains retained. Unreferenced objects, including the known containment quarantine, remain listed and retained without transfer or mutation. The post-read listing is still attempted within the overall budget so an incomplete observation is reported honestly.

## Interpretation and next gate

Success status is `current-private-bytes-match-supplied-db-hashes`; failure is `failed-retained`. Discovery/verification may exit 0 when their narrow checks finish, but `migrationVerified`, `sourceCopyVerified`, `dbManifestCompletenessVerified`, all access-denial flags, `releaseAuthorized` and `destructiveActionsAuthorized` remain false.

This is not a storage freeze, legacy-public-source comparison, proof of all DB/JSON references, anonymous/wrong-account access proof, retention decision, P0 receipt or deletion approval. No classified/unreferenced/quarantined object becomes safe to remove just because referenced bytes match.

After checking the private report, obtain the missing independent provenance/retention/source-copy/access evidence and separately scoped approval for any proposed mutation. Any missing artifact, drift or authorization escape remains an immediate release stop.

## Offline verification

`node --test tests/verify-private-media.test.mjs` covers both phases, digest/target/byte/version binding, drift, malformed pagination/redirects/oversize/timeouts, missing and mismatched media, privacy, output preflight, strict environment guards and Windows ACL gating. No live Blob, production DB or native Windows validation was performed by this implementation.
