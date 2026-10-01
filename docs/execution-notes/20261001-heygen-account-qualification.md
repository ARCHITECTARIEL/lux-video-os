# HeyGen account qualification — October 1, 2026

Status: new credential authenticated and scoped; canonical provider-account/runtime binding still held.

**Later checkpoint:** the owner approved and completed a disposable provider-space probe. The new asset's owner matched the authenticated username, a namespaced `space_id` was captured privately, and exact-resource deletion/readback returned 200/404. Read [binding readiness](20261001-binding-readiness.md) before following the older prerequisites below. Runtime/DB binding is still held; no global account/workspace identity or CDN/backup erasure is claimed.

## Latest result — owner-created replacement credential

The owner explicitly confirmed creating a new key and saved it in the ignored `.env.heygen.local`. Its selected suffix is **`C2b1`**, superseding the earlier `1Tr0` target. Both fixed read-only API probes completed successfully: the key is active, scope mode is full (`*:*`), all required MVP permissions are present, and the returned profile matches the owner-confirmed account.

HeyGen returned `expires_at: null` and `expires_in_seconds: null`. The verifier now accepts that observed pair for inspection without falsely labeling it expired or inventing an expiration guarantee. It retains the expiry-format hold. Two regression tests prove that a dated expiry with null remaining lifetime still fails closed. The focused suite passes **52/52**.

Selected profile evidence is outside Git in the protected local receipt identified by `heygen-binding-20261001/qualification-status.json`; that status file contains only redacted results and the receipt hash. No key value was printed. No production credential was updated, database binding created, or provider mutation invoked. Stable provider-account/workspace identity and canonical application DB targeting remain prerequisites. The historical dashboard inspection below describes the old key, not the new credential.

## Scope and observed facts

The owner requested qualification and binding, identified a key created September 21, and supplied the owning Google account. The owner completed HeyGen sign-in after browser automation could not activate the Google popup. No credential was created, regenerated, deleted or changed.

An authenticated read of `https://app.heygen.com/developers/api` found:

| Field | Observed value |
| --- | --- |
| Key name | VIDEO OS |
| Created | 09-21-2026 |
| Exact displayed suffix | `1Tr0` (lowercase r, final zero) |
| Type | Production |
| Status | Active |
| Permissions | All permissions |
| Expiration | Never |

The key settings dialog confirmed full read/write permissions and Never expiration; it was dismissed without saving. Its action menu offers Settings, Regenerate and Delete, with no reveal/copy action. Account settings match the owner-confirmed login; Workspace General shows the name OSO but no stable workspace ID. Personal profile details are not copied into this repository.

Fresh Vercel metadata confirms `HEYGEN_API_KEY` exists as a Sensitive production variable for `prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW`. The process environment and `.env.local` contain no usable HeyGen credential; the cached Preview and Production env exports contain empty HeyGen values. Neither variable presence nor creation date proves that Vercel currently holds the observed September 21 key. No secret value was retrieved or printed.

## Qualification contract

Official sources and current public capability, pricing and privacy evidence are recorded in [official-research.md](heygen-binding-20261001/official-research.md).

The verifier uses only `GET /v3/api_keys/self` and, when permitted, `GET /v3/users/me` with the same exact key. The first identifies the credential and declared scopes; the second identifies its authenticated profile/billing context. Neither documented response supplies a stable provider workspace/account ID. A key ID, email, workspace display name, plan or their hashes cannot substitute for canonical account ownership.

This operator-only addition does not promote any provider scope, write a database binding, supply `providerBinding` to runtime call sites, enable creation/rendering or implement deletion. It preserves the previous foundation's containment.

## Safe operator command

Store the original full key in a protected local file containing `HEYGEN_API_KEY=...`; do not paste it into chat, command arguments or tracked files. Then run:

```powershell
node tools/qualify-heygen-account.mjs --credential-env C:/Users/ariel/lux-video-os/.env.heygen.local --expected-suffix C2b1 --expected-email OWNER_EMAIL --private-receipt C:/private/heygen-qualification.json
```

The CLI checks the suffix before any request, rejects conflicting key/token aliases, does not auto-load `.env.local`, and does not load unrelated variables from the supplied file. Stdout is redacted. Private evidence is optional, outside the repository, and written exclusively without overwriting. On Windows, use a parent directory with an appropriately restricted inherited ACL.

Exit zero means inspection completed; examine holds and match checks. `bindingEligible`, `accountScopeVerified`, `databaseBindingWritten` and `providerMutationsEnabled` remain false. Customer media, uploads, cloning, video generation, billing changes and DELETE are outside this tool.

## Remaining prerequisites

1. Credential authentication is complete for the owner-created `C2b1` key. Preserve its identity separately from the historical `1Tr0` key; the production Vercel credential has not been changed or matched to this replacement.
2. Correlate credential/profile results with independent stable provider-account/workspace evidence. Do not fabricate a verified promotion from mutable profile fields.
3. Establish the exact application/DB target before any binding persistence. Production changes retain the existing owner-controlled execution boundary.

If the original credential cannot be recovered, rotation is a separate concrete action: it changes the existing credential and may affect callers. No regeneration was performed. Keep the matching HeyGen developer page available for the owner.

## Local verification and changed files

- Added `services/heygen-account-qualification.js` and its test suite: fixed GET-only transport, bounded body/time limits, key/scope fingerprints, exact permission checks, consistent expiry checks, private profile evidence and mandatory account-identity hold.
- Added `tools/qualify-heygen-account.mjs` and its test suite: external credential input, expected-key/profile checks, redacted stdout and optional private receipt. Reused the existing exclusive outside-repository evidence writer; no dependency added.
- Focused qualifier/CLI tests: **50 passed**. Full unit suite: **605 Node passed, 46 credential/environment skips; four Vitest passed**. Syntax, import, client privacy and whitespace checks passed. Independent review approved only the read-only, held scope.
- No product UI or runtime provider call site changed. The previous browser/integration/build evidence remains scoped to the September 30 foundation; those checks were not rerun for this standalone operator tool. The later live credential result and 52-test regression run supersede the initial missing-key condition.

Evidence: `heygen-binding-20261001/unit-tests.log`, `official-research.md`, baseline/current source ledgers and `qualification-status.json`. The September 30 foundation build remains its own historical source-bound checkpoint; this addition has not been deployed. No database promotion, binding write, provider mutation, production environment change, commit or push occurred.
