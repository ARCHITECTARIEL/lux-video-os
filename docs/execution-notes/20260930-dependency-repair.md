# Production dependency advisory repair — 2026-09-30

Status: **implemented locally; production dependency audit is clean; no release or production action performed**.

## Scope and preservation

Only `package.json`, `package-lock.json`, and this note were intentionally changed for this lane. The inherited Prompt 1–3 source/test/documentation edits were preserved. No audit exception, allowlist entry, audit-gate behavior, application source, database, Blob store, provider, Vercel project, Git branch, commit, push, or deployment was changed.

Before mutation, both manifests were copied to:

`C:\Users\ariel\AppData\Local\Temp\lux-video-os-dependency-repair-20260930T1336Z`

| File | Before SHA-256 | After SHA-256 |
| --- | --- | --- |
| `package.json` | `D746A4EB87A42C22440800299D79A7C4E38A8F450E3FC5BE23AAFFD0A5E18833` | `6FD466A9136D368BB3465AB1E5B6C9389D5B1D687D1300B453D13AF6AF02B0ED` |
| `package-lock.json` | `3A9DBC5F31543CC1F13B97DE6D91ADF9EFA34A8D8A7595BF6ED5F5FCA90EF9B2` | `1E222C9EF89A8610610D09ECCBE54B468CDB4225C8E930DAC092A0F00910F092` |

## Resolution

The five new blocking advisories from Prompt 3 are gone:

- `GHSA-hrh2-vp3x-79xf` (`@xhmikosr/decompress`, critical)
- `GHSA-6j4f-fj2g-mc7p` and `GHSA-qhr7-859c-m2p7` (`brace-expansion`, high)
- `GHSA-rfgv-xxqx-mfg5` and `GHSA-w293-vg96-wgc3` (`undici`, high)

The direct `workflow` dependency moved from `^4.6.0` to the current compatible `^4.8.9` release. Patch-level resolutions now used by the production graph are:

| Package/path | Before | After | Reason |
| --- | ---: | ---: | --- |
| `@xhmikosr/decompress` | 11.1.3 | 11.1.4 | First release outside the critical advisory range; satisfies the existing `^11.1.3` peer range. |
| `brace-expansion` (Minimatch 9 path) | 2.0.2 | 2.1.7 | Same major, clears all current 2.x brace advisories. |
| `brace-expansion` (Minimatch 10 paths) | 5.0.7 | 5.0.12 | Same major, clears all current 5.x brace advisories. |
| `@ts-morph/common > minimatch > brace-expansion` (development Vercel CLI path) | 1.1.16 | 1.1.21 | Same major and satisfies `^1.1.7`; clears every current 1.x brace advisory. |
| `@vercel/nft > glob > minimatch > brace-expansion` (development Vercel CLI path) | 5.0.7 | 5.0.12 | Same major and satisfies `^5.0.5`; clears every current 5.x brace advisory. |
| `@vercel/blob > undici` | 6.27.0 | 6.28.1 | Same major and within Blob's existing `^6.23.0` range. |
| `@vercel/sandbox > undici` | 7.28.0 | 7.29.1 | Same major and within Sandbox's existing `^7.27.1` range. |
| Workflow world packages `> undici` | 7.28.0 | 7.29.1 | Narrow parent-scoped overrides are required because both upstream packages pin 7.28.0 exactly. |
| `@workflow/core > nanoid` | 5.1.6 | 5.1.16 | Narrow parent-scoped patch removes both previously accepted Nano ID advisories too. |
| `tar` (development Vercel CLI path) | 7.5.7 | 7.5.22 | One root override repairs the sole shared copy used by `@vercel/fun` and `@mapbox/node-pre-gyp`; removes the remaining unrelated critical plus eight lower-severity tar advisories. |

The overrides are limited to `@vercel/blob`, `@vercel/sandbox`, `@workflow/core`, `@workflow/world-local`, `@workflow/world-vercel`, and `tar`. CI uses Node 24 and the affected runtime paths use Node 22; Undici 7.29.1 requires Node 20.18.1 or newer. Tar 7.5.22 retains the existing Node 18-or-newer engine floor and dependency shape.

## Verification

| Check | Result |
| --- | --- |
| `npm audit --omit=dev --json` | Exit 0; **0 total production vulnerabilities**. |
| `npm audit --omit=dev` | Exit 0; `found 0 vulnerabilities`. |
| Full `npm audit --json`, exact requested-ID scan | Audit itself exits 1 for unrelated development findings; exact scan found **0 matches** for all five requested GHSA IDs across every production and development copy. Full metadata now reports **0 critical** findings. |
| `node --test tests/npm-audit-gate.test.mjs` | Exit 0; 7 passed, 0 failed. |
| `npm ls workflow ...` focused dependency tree | Exit 0; all repaired versions and overrides resolved as listed above. |
| `npm run check:imports` | Exit 0; all eight checked API modules import successfully. |
| `npm run workflow:validate` | Exit 0; 4 files scanned, 2 workflows, no serde issues. |
| `npm run workflow:build` | Exit 0; 93 steps and 2 workflows built. The pre-existing Sandbox/Node built-in serde warning remains. |
| `npm ci --dry-run --ignore-scripts --no-audit --no-fund` | Exit 0; lockfile/install plan consistent. |
| `git diff --check -- package.json package-lock.json` | Exit 0. |

`npm run build:production` advanced through migration snapshot verification and Vercel packaging, then generated a parseable Build Output API v3 `.vercel/output/config.json` with 39 routes plus functions/static output. The tool yielded while the process was still running and did not retain its final exit code; subsequent process inspection confirmed all three build processes had exited. Treat the artifact verification as positive evidence, but not as an exact captured build exit. The build also repeated the known warning that no real production `DATABASE_URL` was available, so its live database drift check was skipped.

## Residual development-only audit findings

The unfiltered `npm audit --json` still exits 1 with 43 development-tool findings: 1 low, 18 moderate, 24 high, and **0 critical**. **None of the five requested advisory IDs remains anywhere in that full graph.** Remaining clusters are primarily the Vercel CLI, HyperFrames/ONNX tooling, Drizzle tooling, and Vitest. No forced downgrade, unrelated major upgrade, or new exception was added in this lane. These should be handled as separate dependency upgrades with their own compatibility tests; they do not reintroduce any of the five Prompt 3 blockers or any critical-severity finding.

## Remaining release boundaries

This repair proves dependency resolution and local build compatibility only. It does not establish live Postgres/Blob concurrency, hosted capacity, provider inference, billing, deployment, or P0 release readiness.
