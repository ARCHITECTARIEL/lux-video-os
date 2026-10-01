# Sandbox and provider release boundary plan

Status: pre-edit plan. Scope is limited to `services/hyperframes-finisher.js`, `tools/release-build-manifest.mjs`, their focused tests, and this lane's execution note.

## Preserved behavior

- Keep FFmpeg as the default finishing engine and preserve every enabled HeyGen render, authorization, media-acceptance, storage and accounting path.
- Keep the pinned HyperFrames composition, snapshot options and render-command helpers used by explicit operator proof tooling.
- Keep release output review-only and retain owner authorization, current-candidate CI, database, private-storage, P0 and rollback gates.

## Cleanup and boundary repair

1. Remove the static `@vercel/sandbox` import and paid Sandbox runtime implementation from the workflow-imported HyperFrames service. The optional HyperFrames path will throw a typed configuration failure before downloads, storage writes or remote calls. Operator-only proof tools may continue importing the SDK directly outside the workflow graph.
2. Assert in tests that the application service has no Sandbox import, injected factories cannot bypass the hold, FFmpeg remains the default, and explicit HyperFrames selection never falls back to FFmpeg or creates a false artifact.
3. Make the release posture provider-aware. The selected MVP provider is HeyGen, so worker-image identity is explicitly not applicable only within that intended release scope. Replace its generic release gate with unverified HeyGen-only runtime-scope, account capability, pricing, privacy/retention, deletion/reconciliation and live-canary gates. These gates remain until an independent verifier is designed; editable booleans and hashes cannot clear them.
4. Preserve the workflow-manifest boundary gate. A manifest containing any Sandbox class/step evidence still fails production packaging; removing the application import must make a clean manifest pass rather than suppressing the check.

## Verification

- Focused HyperFrames boundary tests, release-build gate tests and syntax/whitespace checks.
- Installed Workflow compiler discovery/build check after shared edits settle; no full Vercel build in this lane.
- Report remaining provider/account, P0, storage, database, rollback, CI and owner-authorization gates without claiming provider proof.
