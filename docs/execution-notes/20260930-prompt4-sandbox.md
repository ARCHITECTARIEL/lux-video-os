# Prompt 4 — Sandbox workflow serialization investigation

Timestamp: `2026-09-30T14:28:53Z`

Status: **compatibility limit reproduced; no safe local source repair established; HyperFrames release gate remains closed**.

Start/end HEAD: `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9` on `main`. No commit, push, deployment, environment write, Sandbox creation, provider call, or production mutation occurred.

## Scope and preserved work

This lane investigated the existing Vercel Workflow build warning only. It owned `services/hyperframes-finisher.js` and `tests/hyperframes-boundary.test.mjs` for a bounded experiment. Before editing, both files were copied to `C:\Users\ariel\AppData\Local\Temp\lux-prompt4-sandbox-20260930T102107Z`.

- Baseline `hyperframes-finisher.js` SHA-256: `04C043C3F6EE17A82CC6E8CD896ED8ED160C955EB578F0436C33FFD2A75E981F`.
- Baseline `hyperframes-boundary.test.mjs` SHA-256: `51BB47AE09DB68584314F92E5FFA0D85BA92D989E2307360DC670D2CD54F160C`.
- The experiment was reverted byte-for-byte after it failed to remove the compiler warning. The final hashes match those baselines, so Prompt 3 timing, media validation, immutable storage, cleanup, and dependency-injection behavior are unchanged.

The only retained file from this lane is this execution note.

## Reproduction and root cause

Installed versions are `workflow` 4.8.9 and `@vercel/sandbox` 2.8.0. The application imports `finishMediaWithHyperframes` into the `finishProviderMedia` Workflow step. `hyperframes-finisher.js` statically imports the Sandbox SDK and creates, uses, and stops the SDK instance entirely inside that outer step.

`npm run workflow:build` exits 0 but reports:

```text
Serde warning for classes "Snapshot", "Command", "CommandFinished", "Session", "Sandbox", "SandboxUser", "FileSystem": Workflow bundle contains Node.js built-in imports: buffer, crypto, events, fs, http, https, net, os, path, stream, tls, url, util, zlib. These will fail at runtime in the workflow sandbox.
```

The build reports 93 steps and two workflows. Generated evidence explains the inflation and warning:

- `.vercel/output/functions/.well-known/workflow/v1/manifest.json` registers seven Sandbox SDK classes and about 70 SDK class methods as Workflow steps.
- The flow bundle debug record lists the SDK command, sandbox, session, and snapshot modules as `serdeOnlyFiles`.
- The flow function contains the SDK serializer classes plus Node built-in imports.
- The step function contains the complete Sandbox SDK and the application `finishProviderMedia` step. The SDK is packaged, but it is not confined to the step bundle.
- `npm run workflow:validate` still exits 0 with “No serde issues found,” so validation does not enforce the build warning.

The SDK itself places `'use step'` directives on its methods and documents Workflow serialization support. An isolated local workflow that used `Sandbox.create`, `runCommand`, and `stop` directly from a `'use workflow'` function compiled as 72 SDK steps, one workflow, seven classes, and did not emit this warning. That is the SDK's intended Workflow shape. The application deliberately keeps all Sandbox operations inside one outer application step because the surrounding operation downloads and validates customer media, uses local temporary files, uploads an immutable private final, and settles the job atomically. Moving the SDK instance into the workflow root would require a new artifact-transfer and authorization design; it is not a safe import-only repair.

## Failed bounded repairs

Two local-only variants were tested and then reverted:

1. Replacing the static SDK import with `await import('@vercel/sandbox')` inside the default Sandbox factory.
2. Loading the CommonJS entry through Node `createRequire` inside that factory.

Both builds still emitted the same warning, registered the same SDK classes/methods, and produced 93 steps. Workflow's compiler follows both analyzable forms and discovers the SDK's own directives. The step bundle retained the SDK in each experiment, but the flow bundle leakage remained.

An opaque computed import was rejected. It could hide the package from static analysis, but the generated step function has no `node_modules` directory or include-files declaration. Hiding the dependency would therefore remove packaging proof and create a deployment-only module-resolution failure. Suppressing or parsing away the warning would also leave the runtime risk unchanged.

## Verification

| Check | Result |
|---|---|
| Baseline/final `npm run workflow:build` | Exit 0; 93 steps, two workflows; warning reproduced |
| Literal dynamic-import build | Exit 0; 93 steps, same warning and SDK manifest entries |
| `createRequire` build | Exit 0; 93 steps, same warning and SDK manifest entries |
| Final `node --test tests/hyperframes-boundary.test.mjs` | Exit 0; 8 pass, 0 fail, 0 skip |
| Final `npm run workflow:validate` | Exit 0; four files scanned, two workflow files, no serde issues reported |
| Scoped `git diff --check` | Exit 0 |
| Final source/test hashes | Match pre-investigation backups exactly |

No paid or remote Sandbox runtime was exercised. This note is build evidence, not hosted runtime acceptance.

## Release consequence and next action

Do not describe the Sandbox warning as benign or clear HyperFrames for production from this evidence. Fail closed when `VIDEO_OS_COMPOSITION_ENGINE=hyperframes` is selected until one of these is proven:

1. Workflow/Sandbox versions produce a build where SDK/Node code is absent from the flow bundle while the SDK remains packaged in the step function; or
2. a reviewed architecture moves Sandbox's native steps to the workflow layer with bounded private artifact transfer and preserves Prompt 3 acceptance/accounting guarantees; or
3. Vercel supplies an upstream-supported pattern for using the SDK wholly inside an application step, followed by an authorized hosted runtime proof.

The integration lead owns the production build guard and source/deployment manifest. That guard should inspect the generated workflow build, not merely `workflow validate`, because validation currently passes while the build emits the compatibility warning.
