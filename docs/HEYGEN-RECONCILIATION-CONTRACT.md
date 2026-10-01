# HeyGen reconciliation contract

Status: local foundation implemented; provider DELETE execution remains disabled.

This reference freezes the interfaces in [`lib/heygen-reconciliation-contract.js`](../lib/heygen-reconciliation-contract.js) and [`services/heygen-reconciliation.js`](../services/heygen-reconciliation.js). The policy rationale and activation gates remain in the [temporary-upload bridge design](HEYGEN-BRIDGE-TEMP-UPLOAD-DESIGN.md) and [test specification](HEYGEN-BRIDGE-TEST-SPEC.md).

## Repository snapshot

`createReconciliationPlan(snapshot, options)` accepts only a normalized repository snapshot. Callers select existing `resourceKey` values; they cannot supply provider IDs or URLs.

```js
{
  version: 'heygen-reconciliation-snapshot/v1',
  capturedAt: '2026-09-30T12:00:00.000Z',
  candidate: {
    candidateId: `source:${sourceSha256}`,
    sourceSha256,       // code-tree/source candidate SHA-256, not enrollment media
    adapterSha256,      // lowercase 64-character SHA-256
  },
  target: {
    environment,
    projectId,
    applicationAccountId,
    databaseBindingSha256,
    provider: 'heygen',
    providerAccountFingerprint,     // string or null
    providerAccountBindingState,    // provisional | verified | conflict | revoked
    credentialScopeFingerprint,     // SHA-256 or null
    apiVersion: 'v3',
  },
  resources: [{
    resourceKey,
    accountId,
    kind,                 // asset | avatar_look | avatar_group | voice | video
    providerResourceId,
    originOperationId,
    state,                // unknown | processing | present | ready | failed |
                          // delete_claimed | delete_acknowledged | api_absent |
                          // pending_reconciliation
    sourceSha256,         // exact provider-resource media provenance, or null
    sourceBytes,          // positive safe integer paired with sourceSha256, or null
    voiceNamespace,       // optional; only "instant" is supported
    dependencies,         // optional resourceKey[]
    parentResourceKey,    // optional look -> group relationship
    membership: {         // optional; avatar_group only
      state,              // complete | incomplete | unknown
      memberResourceKeys,
    },
  }],
  references: [{
    referenceId,
    accountId,
    resourceKey,
    consumerKind,
    consumerId,
    state,                // active | pending | ambiguous | released
  }],
  operations: [{
    operationId,
    accountId,
    kind,                 // asset_upload | avatar_create | voice_clone |
                          // video_create | resource_read | resource_delete | url_probe
    state,                // reserved | pending | succeeded | failed | ambiguous
    resourceKeys,
  }],
}
```

`providerAccountFingerprint: null` is valid input so read-only planning can describe unavailable proof. A null fingerprint, non-`verified` binding, or null scope fingerprint creates a blocker. Scope evidence never substitutes for provider-account identity.

Options are `{ requestedActions, createdAt?, expiresAt, cohortId }`, where each requested action is `{ resourceKey, verbs }` and verbs are `read`, `delete`, or `readback`. Plan lifetime is at most seven days.

The private result contains:

```js
{
  version: 'heygen-reconciliation-plan/v1',
  digest,
  createdAt,
  expiresAt,
  candidate,
  target,
  cohortId,
  resources: [{
    resourceKey, kind, providerResourceId, originOperationId,
    sourceSha256, sourceBytes, verbs,
  }],
  blockers,
}
```

The digest is SHA-256 over the plan domain and canonical plan body. `redactPlan(plan)` verifies that digest, then replaces account, project, provider-resource, operation, cohort, database-binding and candidate identifiers with hashes. Operator output must use the redacted form.

Candidate and media provenance are separate bindings. `candidate.sourceSha256` identifies the reviewed code/source tree used by the CLI. Each resource's `sourceSha256` and `sourceBytes` come from the normalized provider-resource ledger and bind the actual photo, derived WAV, or other media provenance for that remote resource. The pair must be both present or both null; byte counts must be positive safe integers. Omitted legacy fields normalize deterministically to null/null. Non-video resources with missing provenance produce `MISSING_RESOURCE_SOURCE_BINDING`; generated videos may intentionally use null/null. Because the private plan contains this pair, any media provenance change changes `plan.digest` and invalidates an earlier signed approval even though approval resource entries remain compact.

Plans fail closed for cross-account rows, unsettled origin operations, reserved/pending/ambiguous no-ID operations, active references, unsafe dependencies, unsupported professional/model voice namespaces, and incomplete avatar membership or cascade scope. A group delete must explicitly scope every affected look for `read`, `delete`, and `readback`. A last-look delete must explicitly include the parent group with those verbs.

## Canonical approval envelope

The raw UTF-8 envelope is:

```js
{
  version: 'heygen-reconciliation-approval-envelope/v1',
  kid,
  payload,    // unpadded base64url canonical claims bytes
  signature,  // unpadded base64url Ed25519 signature
}
```

Claims are:

```js
{
  version: 'heygen-reconciliation-approval/v1',
  planDigest,
  candidate,
  target,
  resources: [{ resourceKey, kind, providerResourceId, verbs }],
  budget: { maxProviderCalls, maxSpendMicrousd },
  issuedAt,
  expiresAt,
  nonce,
  cohortId,
}
```

Signed bytes are exactly:

```text
UTF8("LUX_VIDEO_OS\0HEYGEN_RECONCILIATION_APPROVAL\0V1\0")
+ UTF8(kid)
+ 0x00
+ canonicalClaimsBytes
```

Use `canonicalApprovalSigningBytes(kid, claims)` to produce those bytes. The `kid` is part of the signature and selects an own-property entry in `trustedContext.pinnedKeys`. The entry must be an Ed25519 public key. A private key, unpinned key, changed `kid`, forged signature, or alias substitution fails. The production worker receives pinned public keys only; signing and private-key custody belong to a separate owner-controlled issuer.

Canonical JSON uses sorted object keys, ordered arrays, valid Unicode, and safe integers only. Raw envelope and payload parsing rejects duplicate fields, trailing data, noncanonical payload bytes, unsupported fields, and payloads outside the bounded envelope size. Resource and verb arrays have deterministic order.

## Verification and future claim integration

`verifyApproval(rawEnvelope, trustedContext)` requires:

```js
{
  plan,
  pinnedKeys: { [kid]: publicKey },
  expectedBudget,
  now,
  nonceState: { nonce, status: 'fresh' },
  approvalStatus: 'active',
}
```

It returns a deeply frozen approval branded in a private process-local `WeakSet`. Copied claims, JSON-round-tripped values, persisted `{ verified: true }` flags, and values created in another process do not carry that brand.

The database claim/nonce integration is **not implemented in this foundation**. When added, the repository must acquire the account lifecycle guard and ordered row locks, recompute the snapshot and plan under those locks, read current revocation/nonce/budget state, then call:

```js
assertVerifiedApproval(verifiedApproval, {
  plan: freshlyRecomputedPlan,
  expectedBudget,
  now,
  nonce,
  approvalStatus,
});
```

The same transaction must atomically consume the nonce and commit the exact resource claim and remaining call/spend budget. No provider HTTP belongs inside that transaction. A new worker process must re-run `verifyApproval` from the raw signed envelope; a serialized branded result is never authority.

## Credential-free signing example

This example generates an ephemeral key pair in memory and performs no network call. It colocates issuer and verifier only to demonstrate byte compatibility. Production must keep the private key out of the worker.

```js
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  assertVerifiedApproval,
  canonicalApprovalPayloadBytes,
  canonicalApprovalSigningBytes,
  canonicalJsonBytes,
  verifyApproval,
} from '../lib/heygen-reconciliation-contract.js';

const kid = 'owner-key-example';

function signAndVerifyExample(plan, { issuedAt, verifyAt, claimAt }) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'); // example only
  const budget = { maxProviderCalls: 1, maxSpendMicrousd: 0 };
  const claims = {
    version: 'heygen-reconciliation-approval/v1',
    planDigest: plan.digest,
    candidate: plan.candidate,
    target: plan.target,
    resources: plan.resources.map(({ resourceKey, kind, providerResourceId, verbs }) => ({
      resourceKey, kind, providerResourceId, verbs,
    })),
    budget,
    issuedAt,
    expiresAt: plan.expiresAt,
    nonce: 'nonce-example',
    cohortId: plan.cohortId,
  };

  const payload = canonicalApprovalPayloadBytes(claims);
  const signature = sign(null, canonicalApprovalSigningBytes(kid, claims), privateKey);
  const envelope = canonicalJsonBytes({
    version: 'heygen-reconciliation-approval-envelope/v1',
    kid,
    payload: payload.toString('base64url'),
    signature: signature.toString('base64url'),
  });

  const verified = verifyApproval(envelope, {
    plan,
    pinnedKeys: { [kid]: publicKey },
    expectedBudget: budget,
    now: verifyAt,
    nonceState: { nonce: 'nonce-example', status: 'fresh' },
    approvalStatus: 'active',
  });

  return assertVerifiedApproval(verified, {
    plan, // future DB integration supplies a fresh under-lock plan here
    expectedBudget: budget,
    now: claimAt,
    nonce: 'nonce-example',
    approvalStatus: 'active',
  });
}
```

## Provider transport

`getResource(kind, id, options)` accepts a validated provider ID and constructs only these HTTPS paths on `api.heygen.com`:

| Kind | GET path | Exact API-absence code |
| --- | --- | --- |
| `asset` | `/v3/assets/{asset_id}` | `asset_not_found` |
| `avatar_look` | `/v3/avatars/looks/{look_id}` | `not_found` |
| `avatar_group` | `/v3/avatars/{group_id}` | `avatar_not_found` |
| `voice` | `/v3/voices/{voice_id}` | `voice_not_found` |
| `video` | `/v3/videos/{video_id}` | `not_found` |

Options are `{ apiKey, fetchImpl?, timeoutMs?, now?, correlationId? }`. The timeout spans headers and the bounded response-body drain. Redirects fail, response bodies are capped, IDs reject path/URL injection, and errors expose only sanitized category, HTTP status, safe provider code, method and fixed path template.

A matching resource returns `PRESENT`. Only the exact path's documented `404` code returns `API_ABSENT`; another `404`, authentication error, timeout, network error, rate limit, malformed body or mismatched returned ID remains an error. Results always report `publicUrlOutcome: 'NOT_OBSERVED'`. `API_ABSENT` is separate from `URL_DENIAL_OBSERVED`, privacy-request handling, physical purge, and backup retention.

`deleteResource(kind, id, options)` has no production network branch and returns `DELETE_EXECUTION_DISABLED` without an opaque test context. Node tests can create an in-memory response queue with `createMockDeleteAuthorizationForTests`; it cannot accept a fetch callback or perform a live request. A mocked acknowledgement validates the fixed method/path and documented response shape only. A DELETE `404` is `DELETE_ABSENCE_UNPROVEN`, never proof of prior ownership or successful deletion.

## Rotation and unavailable gates

Pinned signing keys are an explicit reviewed allowlist. Rotation introduces a new `kid` and public key; signatures bind that `kid`. Retiring a key means omitting it from the active `pinnedKeys` map and issuing fresh approval where policy requires it.

Provider credential rotation does not inherit account authority. It changes the credential/scope binding and holds affected plans until the exact application credential is read back again, the provider-account fingerprint and scope evidence are re-established, and a fresh snapshot, plan, and approval are issued. Cross-credential approval reuse is not automatic.

The local contract does not prove application-account identity, source-asset dependency survival, old-CDN-URL denial, provider deletion behavior, or physical/backup purge. Those remain separate app-key and disposable-canary release gates. No customer upload, provider mutation, spend, activation, or deletion authority is created by this module or this document.
