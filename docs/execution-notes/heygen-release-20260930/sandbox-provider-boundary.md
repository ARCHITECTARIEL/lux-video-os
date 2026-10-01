# HeyGen MVP Sandbox and release applicability boundary

Timestamp: `2026-09-30T18:55:13Z`

Status: **implemented locally; focused checks pass; full candidate packaging and all live provider evidence remain pending**.

Start/end HEAD: `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`. Baseline source receipt: `baseline.json`, source SHA-256 `4ed666e9b465596427e7c7b20fe36df2364362310e6104f5dc06407624bd262b`. No commit, deployment, environment mutation, Sandbox creation, provider call or paid operation occurred.

## Boundary repair

`services/hyperframes-finisher.js` no longer imports `@vercel/sandbox` or any media/storage runtime dependencies. The pinned composition and operator-proof configuration helpers remain available to `tools/run-hyperframes-sandbox-proof.mjs`, which owns its SDK import outside the application workflow graph.

The workflow-visible `finishMediaWithHyperframes` function now always throws `HYPERFRAMES_MVP_UNSUPPORTED` with category `CONFIG_MISSING`. It does so before source download, storage access, injected factory use or remote compute. FFmpeg remains the default finishing engine. Explicit HyperFrames selection does not silently fall back or manufacture an artifact.

The manifest's existing Sandbox inspection remains strict: any Sandbox evidence in workflow classes, steps, keys or values still blocks production packaging. No warning suppression or allowlist was added.

## Provider applicability

The selected MVP release provider is recorded as HeyGen, a managed API. The manifest now marks worker-image identity as not applicable to that intended provider rather than reporting a false RunPod/image blocker. It does not treat provider readiness as verified. The provider posture retains these fail-closed gates:

- `HEYGEN_ONLY_RUNTIME_SCOPE_UNVERIFIED`
- `HEYGEN_ACCOUNT_CAPABILITIES_UNVERIFIED`
- `HEYGEN_PRICING_UNVERIFIED`
- `HEYGEN_PRIVACY_RETENTION_UNVERIFIED`
- `HEYGEN_DELETION_RECONCILIATION_UNVERIFIED`
- `HEYGEN_LIVE_CANARY_UNVERIFIED`

The runtime-scope gate prevents the provider decision from silently clearing worker-image requirements while a legacy self-hosted path might still be enabled. An editable `verified: true` object cannot clear any provider gate. Self-hosted/RunPod selections retain `WORKER_IMAGE_IDENTITY_UNVERIFIED`; unknown providers fail with `RELEASE_PROVIDER_UNSUPPORTED`.

Existing owner authorization, current-candidate CI, production database, private-storage migration, production P0 and rollback evidence gates are unchanged.

## Verification

- `node --test tests/hyperframes-boundary.test.mjs tests/remotion-composition.test.mjs tests/release-build-gates.test.mjs`: exit 0; **30 pass / 0 fail / 0 skip**.
- `node --check` on the four owned source/test files: exit 0.
- Scoped `git diff --check`: exit 0.
- `rg @vercel/sandbox services workflows`: no matches.

Final file SHA-256 values:

- `services/hyperframes-finisher.js`: `6F6FC0C64A37F28C35D0BC77BA38CFA107A849C03F5C83D194574F1040D2509B`
- `tools/release-build-manifest.mjs`: `9073E530DE907B21EC3E6FA089153C01F95CB8EEC9BB9EC566734FC974CDEC62`
- `tests/hyperframes-boundary.test.mjs`: `1124F804EE461AC7D9B3C8F66848C0319E7421361DF57E67CD2D100372DEC483`
- `tests/release-build-gates.test.mjs`: `BA6DABB7DD149A634DA788806410354F7B67E31FDDF91D34C004E78B99B44D55`

A full Workflow/Vercel build was deliberately not run while shared source was changing. The integration lead must run exact-candidate packaging and confirm the generated workflow manifest contains no Sandbox classes or steps before treating the workflow boundary as verified.

## Integration readback - 2026-09-30T19:41:26.076702+00:00

Root sealed source `b2e7e583a660823f76d32fda8c3f6d4befa2238846d4fc7cba69c7af1743a7f5` and output `b8a3b7dcfe1705b19b5c9a065a78cafb725021485e201b79efcf25476fcca47e`. Full unit451+four Vitest passed. Review-only build42 routes/29 steps/six workflows passed, with `NO_KNOWN_SANDBOX_CLASS_LEAK`; source/project-link matches and default prebuilt output is absent. Earlier pending local packaging statements above are superseded by this readback. External/provider/P0/database/storage/CI/rollback gates remain open. See verification-summary.json and build-summary.json.
