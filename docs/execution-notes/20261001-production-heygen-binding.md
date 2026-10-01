# Production HeyGen provider-space binding bootstrapped — October 1, 2026

Status: executed, owner-approved. Production now has a verified HeyGen provider-space binding for the owner's account. `providerCreationActivationStatus()` remains hardcoded disabled -- no provider creation/render is possible yet.

## Background

`tools/bind-heygen-space.mjs` and `db/heygen-space-binding-repository.js` previously supported only a pinned `verification` target, with a comment stating "There is deliberately no production override or general approval flag." Supporting production required a genuine refactor (see [the code change](../../db/heygen-space-binding-repository.js) and its commit, `e90f5c7`), not a flag addition: `environment` was hardcoded as the literal string `'verification'` in roughly a dozen places, including the core binding-identity validation (`assertBindingIdentity`), not just at the CLI entry point.

The refactor generalized the pinned-target and binding-identity logic to support both `verification` and `production`, while adding a new, independent requirement specific to production: requesting `--environment production` alone is not sufficient. The CLI additionally requires `--owner-authorized`, which sets `VIDEO_OS_PRODUCTION_BINDING_CONFIRMED` to an exact phrase the repository checks (`PRODUCTION_BINDING_NOT_EXPLICITLY_CONFIRMED` otherwise) before any file, provider, or database access. The existing, separate hard block against this tool ever running inside the actual deployed Vercel production runtime (`VERCEL_ENV === 'production'`) is untouched and unconditional regardless of target -- this is an operator CLI, never meant to run as part of the live app.

The pinned production target hash (`0207fdc0d223cd91e94478623502472d89eb2b2b3aadcf137c2b8584c32fc3d1`) was computed via the same `canonicalJsonBytes()` the verification pin uses, from the real, current `config/database-target.production.json`.

New tests (`tests/heygen-space-binding-repository.test.mjs`, `tests/heygen-space-binding-cli.test.mjs`) cover: production without confirmation rejects before any access, a wrong confirmation value still rejects, a live-production-runtime `VERCEL_ENV` hard-blocks regardless of confirmation, the real (unmocked) `defaultTargetPreflight` succeeds for production with exact real target content, a full mocked bootstrap yields a production-tagged binding, and the CLI wires the confirmation phrase through end to end. All existing verification-path tests and behavior are unchanged. Full suite: 740 passed, 0 failed, both before and after. CI (`verify` + `analyze`) green on the exact commit before this was run against production.

## What happened

With the owner's explicit go-ahead, immediately after confirming CI was green on commit `e90f5c7`:

```
node --env-file=<production DB credential> --env-file=.env.heygen.local tools/bind-heygen-space.mjs bootstrap \
  --environment production --account-id user-af738329999cec793560f0a4 \
  --private-evidence-dir <the existing, already owner-approved disposable probe evidence from earlier today> \
  --owner-authorized
```

Result: `{"verified":true,"environment":"production","runtimeActivation":false,...}`, exit code 0.

Independently verified read-only against production afterward: `provider_verified_account_scopes` (1 row), `provider_account_bindings` (1 row, `lifecycle_state: active`, `environment: production`), `provider_account_binding_promotions` (1 row). `provider_resources` remains 0, as expected -- that table tracks real usage artifacts, not the binding itself.

Re-ran `status --environment production --account-id user-af738329999cec793560f0a4 --owner-authorized` afterward: resolves the same binding (matching `providerSpaceFingerprint`, `credentialScopeFingerprint`, `databaseBindingSha256`, `identityDigest`), confirming the fresh resolver path works against the real persisted graph, not just the bootstrap path.

The account bound is `user-af738329999cec793560f0a4` -- the owner's own account (`ariel@luxmarketingcompany.com`), the only match for that email among production's 3 total user rows at the time of this check.

## What this does and does not establish

- Does establish: a real, verified, revocable HeyGen provider-space binding exists in production, using the newly rotated credential (`...C2b1`), tied to the owner's own account.
- Does not establish: any ability for a real customer (or the owner) to actually create an identity or render a video through HeyGen yet. `providerCreationActivationStatus()` (`db/provider-reconciliation-repository.js`) remains hardcoded `{ enabled: false }` -- both `assertIdentitySubmissionAllowed()` and the render workflow's own check independently hold on this, regardless of binding validity.
- Does not establish: billing, the P0 release-gate receipt, or any of the other `outstandingLaunchGates` tracked by `tools/authorize-release.mjs` and `tools/release-build-manifest.mjs`.

## Next action

The remaining piece of the original Phase 2 goal is the activation switch itself (`providerCreationActivationStatus()`). That is a separate, later, explicitly owner-gated decision -- per the project's own execution-mode ladder (SIMULATION -> CANARY -> PRODUCTION), it should not be flipped casually, and realistically should wait until closer to the actual P0 production-proof run, since flipping it without a billing/P0 plan in place would let real customers attempt real spend with no reconciliation safety net yet in place.
