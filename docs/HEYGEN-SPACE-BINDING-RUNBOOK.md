# HeyGen provider-space binding: local operator runbook

Status: implemented and wired into the local enrollment/render/continuation paths. Verified binding and receipt transactions use the pinned isolated database. Production resolution and runtime activation remain disabled. See [the runtime implementation receipt](execution-notes/20261001-runtime-wiring.md).

This follows the [owner-approved space probe](execution-notes/20261001-binding-readiness.md). The identifier is a HeyGen `space`, not a global account/workspace ID. Legacy account-named database columns store the explicitly namespaced space fingerprint; they do not redefine the provider's identity semantics.

## Trust and lifetime

- `config/heygen-space-anchor.json` pins the reviewed probe result, exact 13-file private evidence bundle, fixture hash and safe identity projection. The loader pins the manifest itself using canonical JSON, so Git line-ending conversion does not change authority.
- Private receipt bytes remain exact. Missing, changed or unexpected files, mismatched IDs/owner/space, a changed credential, or a changed scope fail closed. Do not edit the pinned probe result to append later status; use separate execution notes.
- Saved JSON is historical evidence, not fresh authentication. Fresh qualification and derived anchor/proof/binding objects carry separate process-local brands. Copies and JSON round trips lose authority.
- Each bootstrap/status operation performs fresh read-only HeyGen authentication outside the database transaction. Its observation is valid for at most 60 seconds and is checked again under the account lifecycle lock.
- The space anchor is limited to 24 hours for this verification-only implementation. The current anchor expires **2026-10-02T15:11:53.953Z**. This is a local test policy, not a provider guarantee. Production re-probe policy is explicitly unset.
- A fresh key/profile read does not refresh the historical space observation. Do not alter timestamps, extend policy, or rerun the exhausted asset probe to bypass expiry. New provider mutations require their own authorized scope.

## Commands

Use the protected isolated database env file and the ignored owner-selected HeyGen credential file. No env file is loaded automatically. The example account must already exist in the verification database; these commands do not create users, credit grants or entitlements.

```powershell
node --env-file=C:/private/isolated-video-os.env --env-file=C:/Users/ariel/lux-video-os/.env.heygen.local tools/bind-heygen-space.mjs bootstrap --environment verification --account-id EXISTING_VERIFICATION_ACCOUNT_ID --private-evidence-dir C:/Users/ariel/AppData/Local/Temp/lux-heygen-space-probe-20261001

node --env-file=C:/private/isolated-video-os.env --env-file=C:/Users/ariel/lux-video-os/.env.heygen.local tools/bind-heygen-space.mjs status --environment verification --account-id EXISTING_VERIFICATION_ACCOUNT_ID
```

The module independently verifies the fixed verification target and current migration/schema lock before provider access. It connects through a short-lived pool bound to that exact URL, rather than reusing a potentially stale cached client. Production, another database target, caller-provided fingerprints/targets/roles, or a changed key are rejected.

Bootstrap atomically creates or reuses the exact provider-space scope, application-account binding and verified promotion under the account lock. Repeated bootstrap is idempotent. A revoked or conflicting promotion is not revived, rewritten or transferred. Status resolves fresh authority and returns only safe hashes and status fields, including `scopeType: space` and `runtimeActivation: false`.

Evidence refs are internal, versioned references containing the pinned probe-result digest. The composite identity digest is reproducible from the pinned projection and fresh qualification. No evidence URL, raw provider ID, profile email or key is exposed by CLI output. The private bundle remains outside Git; keep it protected and available while this verification anchor is used.

## Explicit boundaries

- Creation and render resolve fresh bindings at each claim and recheck before provider HTTP. Canonical source/job proofs determine the submitted data. Polling, preview and finishing also verify the owned provider resource; finishing checks the ready-event URL digest.
- Receipt-only transactions retain the original database even after freshness or configuration changes. They can preserve an already-started result; they cannot authorize new provider work. Uncertain submissions, incomplete replay, transient polling and pre-download authority failures remain held for reconciliation.
- `providerCreationActivationStatus()` independently holds both identity and render creation. A valid verification binding is not activation authority. The deletion executor remains disabled.
- Verification bootstrap success does not configure the production key, migrate production, create an owner production binding, or qualify avatar/voice/video generation behavior.
- Test accounts/bindings were removed by the guarded final cleanup. There is no persistent production binding to find after these tests.
- Canonical production target provenance is now confirmed by the [database investigation](execution-notes/runtime-wiring-20261001/canonical-db-investigation.md). The old local URL still points elsewhere. Production is missing migrations `0007`–`0010`; no schema or environment write occurred.
- The existing Workflow flow still serializes the provider result URL between steps. Its storage encryption/access/retention guarantees have not been established against the temporary-upload design. Treat that custody question as a release privacy hold; the URL digest proves integrity, not retention compliance.

Source files: `lib/heygen-space-anchor.js`, `db/heygen-space-binding-repository.js`, `tools/bind-heygen-space.mjs`, and the qualifier transport in `services/heygen-account-qualification.js`. See [the implementation receipt](execution-notes/20261001-local-space-binding.md) for exact verification and current source/build identities.
