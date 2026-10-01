# Prompt 4 storage migration readiness

Date: 2026-09-30. Status: **read-only inventory completed for the production and isolated-verification Blob stores; migration execution remains blocked**.

Source HEAD stayed `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`. This lane did not relink, deploy, change an environment variable, query or mutate a production database, create a store, copy/download/delete a customer object, or modify any external resource. The inherited dirty worktree was preserved. The repository Vercel link remained byte-identical at SHA-256 `12FD6EF128686D8ED4918A6F214780CA46BA87A9397892F46EC55356F75054F2`.

## Scope and implementation

Added `tools/inventory-release-storage.mjs`, a read-only Blob metadata inventory. It:

- requires an exact expected store ID, project ID, environment, access level, object count and byte count;
- proves the credential is bound to that store, follows every list page, rejects duplicate paths/non-advancing cursors, and verifies every returned object hostname matches the expected store and access mode;
- fails if listed count/bytes differ from the separately read Vercel store metadata;
- publishes only category totals and credential-keyed HMAC object IDs;
- hashes the complete private manifest while keeping raw paths/ETags/timestamps outside the repository;
- refuses to place the raw manifest under the repository root and uses create-only output files.

Five focused tests pass with no skips. They cover all governed prefixes, sanitized stable output, pagination, duplicate/cursor failure, wrong credential/store/access/count/bytes/path failure, and the outside-repository raw-evidence guard.

## Vercel metadata readback

Authenticated read-only `/v1/storage/stores` and `/v1/storage/stores/{id}` responses established the access mode; names were not treated as proof.

| Store | Project/environment connection | Access | Objects | Bytes | Object enumeration |
|---|---|---:|---:|---:|---|
| `store_0OoP7sznVEvMzwQu` | `prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW` / production | private | 77 | 69,417,975 | complete and count/byte matched |
| `store_LC1XGHwpUvan4WD3` | `prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW` / preview | private | 92 | 19,075,901 | unavailable; see blocker below |
| `store_8uyr0JDWkUyha8sy` | `prj_vbZKWodyUtKSJMhgLUiTSjoVnlQB` / development only | private | 0 | 0 | complete and count/byte matched |

The current team inventory exposed four Blob stores total and all four reported `access: private`; none reported public. This proves the access metadata of currently visible team stores only. It does not prove that a deleted store, a store in another scope, an old public URL, or a production database reference is absent.

Sanitized metadata: [Vercel store metadata](prompt4-storage-20260930/vercel-store-metadata.json), file SHA-256 `35AD7124174F4FF9F19196A806D4D2F89373855A7E4B303483D6BE7DF75EC1D2`.

## Production object inventory

[Sanitized production inventory](prompt4-storage-20260930/production-private-store-inventory.json) contains no pathnames, URLs, account details, ETAGs or media. Its file SHA-256 is `673FD8AEFCDBFA2E1BFF4068F0919655CABAD7C82A40A61D3BB8343BB4245C5A`; canonical sanitized manifest SHA-256 is `b55bb0044fb7fc9f92acc55f66d490276f6b22888d3cbf1eded9a2f01f9caf6b`.

| Category | Objects | Bytes |
|---|---:|---:|
| Account state | 3 | 1,520 |
| Authentication state | 15 | 4,228 |
| Rate-limit state | 0 | 0 |
| Customer upload | 30 | 49,231,100 |
| Finished customer video | 0 | 0 |
| Job state | 0 | 0 |
| Credit state | 3 | 495 |
| Stripe event | 0 | 0 |
| Recovery receipt | 0 | 0 |
| Unclassified | 26 | 20,180,632 |
| **Total** | **77** | **69,417,975** |

The 26 unclassified objects are a release blocker, not an assertion that they are safe or unused. Their identifiers in the checked-in receipt are credential-keyed HMACs. The raw manifest is retained outside Git at `%TEMP%\lux-video-os-prompt4-storage-20260930\production-store-0OoP7sznVEvMzwQu-20260930T102816Z.json`; its file SHA-256 is `1004204E2057093041774003C333E1B7ADA95548C820064CB50714A2EB23801C` and canonical content SHA-256 is `7fce6b4cfa820c66d8cf922ce6d897eca61530b57b24b17599faaa80cc737440`. It must remain private.

The isolated verification store was independently confirmed empty. [Its sanitized inventory](prompt4-storage-20260930/verification-private-store-inventory.json) has file SHA-256 `0429B141A6C60FCF19A1CC41A6AEE5F540E40719836F9F71356047FBB2E131F6` and manifest SHA-256 `f3ae147b1092855088d096b1443abaf97870e037ef0a1fa70ea746defaf1d8f6`.

## Explicit unknowns and blockers

1. **Production database references were not inventoried.** The Vercel production pull contains canonical `DATABASE_URL` and `DATABASE_URL_UNPOOLED`, but both values are opaque/non-parsable in that readback. The application uses the canonical `DATABASE_URL`, so the parsable integration-prefixed URL cannot be substituted silently. Separately, the `videoos_*` variables and read-only Neon API agree on project `still-voice-83326863`, default/primary branch `br-broad-sunset-awrsmiwa` (`main`), endpoint `ep-autumn-morning-awa4hmb6`, pooled host `ep-autumn-morning-awa4hmb6-pooler.c-12.us-east-1.aws.neon.tech`, database `neondb`, and role `neondb_owner`. This establishes the connected integration's identity, but not that the canonical application secret targets it. [Sanitized identity evidence](prompt4-storage-20260930/production-database-identity-metadata.json), SHA-256 `D47C30AD7CC472D75B275C2002E831B7DEA836AFDA7D7A26166CCF1025A7B0C0`, records the distinction. Until the canonical mapping is independently established, the live values of `media_assets.private_pathname` and possible storage references inside `video_jobs.input/output`, `projects.avatar/voice/settings`, `job_events.details`, `credit_transactions.metadata`, and entitlement metadata are unknown. The existing local default/main URL and isolated verification database remain invalid substitutes.
2. **Legacy public sources remain unproven.** No currently visible team Blob store reports public access, but a database reference may still point at an old external/public host. Only an identity-gated production reference scan can settle this.
3. **Twenty-six production objects are unclassified.** The private raw manifest needs an authorized review against verified database references. They cannot be declared orphaned, migrated or deleted from pathname shape alone.
4. **Preview connection is inconsistent.** Vercel metadata says `store_LC1XGHwpUvan4WD3` is connected to Preview, but the credential returned by a generic `vercel env pull --environment preview` did not bind to that store and object listing failed. No preview object receipt was written. This may be a branch-scoped or stale token/configuration issue; resolve by reading the exact deployment/branch environment binding, without rotating or replacing credentials implicitly.
5. **Object metadata is not byte proof.** This read-only lane intentionally did not download customer media. Vercel list metadata and ETAGs do not establish content SHA-256. Byte verification belongs to the approved copy phase.

Therefore private-storage migration is **not ready to execute**, and Prompt 8/P0 remains blocked. The positive finding is narrower: the currently connected production Blob store itself is private, and all 77 objects returned private-store hostnames.

## Reviewed migration procedure for later authorization

### 1. Fresh read-only freeze and reference inventory

1. Record the exact candidate source SHA, deployment ID, stable alias, Vercel project/team and store metadata.
2. Compare the live production database identity to the approved nonsecret target manifest. Stop on any mismatch or missing identity signal.
3. In one repeatable read-only database snapshot, inventory direct and JSON storage references from the columns listed above. Keep raw references outside Git. Publish only category counts, HMAC reference IDs, and a canonical manifest hash.
4. Re-run this Blob inventory against fresh count/byte metadata. Join references to object metadata privately and report referenced, missing, unreferenced and unclassified counts. Do not infer that an unreferenced object is deletable.
5. Resolve the preview token binding separately. Preview evidence must never be counted as production evidence.

### 2. Copy and verify (new explicit production-write approval required)

1. Prepare an immutable source-to-private mapping with source store/path/version, destination governed prefix/path, owning account/job reference and expected bytes. Keep it private.
2. Copy in bounded batches with destination overwrite disabled. A cross-store migration must stream bytes through an approved operator; never expose public URLs to the app as a shortcut.
3. Hash the exact source stream and the exact private readback. Require equal SHA-256 and bytes; ETAG equality is insufficient.
4. Require anonymous direct access to each destination to return 401/403/404. Verify owner API download returns the same bytes and wrong-account API access returns 404.
5. Record a private, append-only per-object receipt. Stop the batch on the first mismatch. Do not touch source references or objects in a failed batch.

### 3. Reference migration (separate reviewed database-write step)

1. Recheck the production database identity immediately before the transaction.
2. Update only references whose current value/version still equals the frozen source mapping. Use a transaction and fail on any changed or missing row.
3. Re-read every updated row, run owner/fresh-session gallery and authorized-download checks, and reconcile referenced private objects to database ownership/job identity.
4. Keep public originals in place during an agreed stabilization window. A successful copy is not deletion authority.

### 4. Public-source removal (separate destructive approval)

1. Prove there are zero live database references to each public source and that every destination passes byte and access-denial verification.
2. Capture a final private source manifest and versions. Delete only exact reviewed source objects, conditionally on the frozen version/ETAG where supported.
3. Verify direct source access is gone and repeat application download/history/reconciliation checks. Any cross-account or missing-artifact result is an immediate launch stop.

### 5. Rollback

- Before public deletion: transactionally restore reference values from the private mapping; source objects remain untouched. Keep private copies for forensic comparison.
- After public deletion: prefer rolling application/database references to the verified private copies. Do not recreate public exposure as an automatic rollback. Rehydrating a removed public source requires its own security and destructive-change approval.
- Application rollback must name the exact prior deployment/commit and remain compatible with the private reference format. Never delete the new private copies during rollback until reconciliation proves no references remain.
- Every rollback must produce a fresh private receipt and repeat owner/anonymous/wrong-account/direct-Blob checks.

## Verification commands and results

- `node --test tests/inventory-release-storage.test.mjs`: exit 0, 5 pass / 0 fail / 0 skip.
- `node --check tools/inventory-release-storage.mjs`: exit 0.
- `git diff --check -- tools/inventory-release-storage.mjs tests/inventory-release-storage.test.mjs docs/execution-notes/prompt4-storage-20260930`: exit 0.
- Authenticated `GET /v1/storage/stores` plus three store detail reads: exit 0; access/count/size/connection results captured above.
- Production environment identity parse plus authenticated Neon project/branch/endpoint/database/role reads: exit 0. Integration-prefixed identity is exact; canonical app URL remains opaque and unmapped. No SQL connection was opened.
- Production object inventory: exit 0; 77/69,417,975 exactly matched store metadata; all returned hosts matched the expected private store.
- Isolated verification inventory: exit 0; 0/0 exactly matched store metadata.
- Preview inventory: failed closed; no evidence file created and no write attempted.
- Temporary Vercel environment files were removed after each attempt. No credential value was printed or retained in Git.

## Changed files in this lane

- `tools/inventory-release-storage.mjs`
- `tests/inventory-release-storage.test.mjs`
- `docs/execution-notes/20260930-prompt4-storage.md`
- `docs/execution-notes/prompt4-storage-20260930/vercel-store-metadata.json`
- `docs/execution-notes/prompt4-storage-20260930/production-database-identity-metadata.json`
- `docs/execution-notes/prompt4-storage-20260930/production-private-store-inventory.json`
- `docs/execution-notes/prompt4-storage-20260930/verification-private-store-inventory.json`

No package, application route, database schema, workflow, provider, environment or deployment file changed in this storage lane.
