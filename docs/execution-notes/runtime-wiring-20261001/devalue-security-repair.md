# devalue security repair

Date: 2026-10-01  
Status: **source and lockfile repaired; runtime audit clean; no deployment or live-run migration performed**

## Finding

`workflow@4.8.9` installs `@workflow/core@4.8.9`, whose published manifest pins `devalue` exactly to `5.9.2`. The runtime audit disclosed three new high-severity advisories in that version:

| Advisory | Vulnerable range | First patched | Maintainer fix represented in 5.9.3 |
| --- | --- | --- | --- |
| [GHSA-j22f-vq7h-c4qm](https://github.com/advisories/GHSA-j22f-vq7h-c4qm) — shared-memory disclosure during `stringify`/`uneval` | `>=5.1.0 <=5.9.2` | `5.9.3` | `46dc877`: serialize only the visible bytes of Node Buffers |
| [GHSA-mcm9-63f2-9j32](https://github.com/advisories/GHSA-mcm9-63f2-9j32) — quadratic `uneval` expansion for repeated primitives | `<=5.9.2` | `5.9.3` | `84f6f67`: prevent quadratic repeated-string/bigint output |
| [GHSA-x5rw-q4pp-hg5g](https://github.com/advisories/GHSA-x5rw-q4pp-hg5g) — caught `stringifyAsync` call can still cause an unhandled rejection | `>=5.8.0 <=5.9.2` | `5.9.3` | `dae8153`: contain internal promise rejections |

The ranges and first-patched versions above come from GitHub's Advisory API. The corresponding fixes are listed in the maintainer's [v5.9.4 changelog](https://github.com/sveltejs/devalue/blob/v5.9.4/CHANGELOG.md).

## Repair decision

The repository now scopes an npm override to `@workflow/core`:

```json
{
  "overrides": {
    "@workflow/core": {
      "devalue": "5.9.4"
    }
  }
}
```

This keeps `workflow` and `@workflow/core` at `4.8.9`. It does not introduce a Workflow SDK upgrade or a new direct application dependency.

`5.9.3` is the first patched release. `5.9.4` is preferable because it contains every 5.9.3 security repair and adds only a module-level pure annotation for tree-shaking. The official `5.9.2` and `5.9.4` package manifests expose the same ESM entrypoint, type entrypoint, file set and `sideEffects: false`; neither declares a Node engine requirement.

No currently published Workflow upgrade removes the need for the override: npm registry metadata shows both `@workflow/core@4.8.10` and `@workflow/core@5.0.0` still pin `devalue@5.9.2`. Moving to `devalue@6.0.2` would add an unnecessary major-version and Node `>=22.17` requirement, so it is outside this minimal repair.

## Durable-state compatibility boundary

Workflow SDK documents that its serializer is built on devalue and that step arguments and return values persist across suspension and resumption. Devalue explicitly treats cross-version serialization stability as a non-goal, so this repair does not claim universal wire compatibility.

The risk is bounded by Workflow's deployment versioning contract:

- a run remains pinned to the deployment that started it and continues on that deployment's code;
- new runs use the new deployment;
- therefore an ordinary deployment does not silently resume an old run under the new devalue parser.

Local compatibility evidence covers the application's representative plain Workflow value graph:

- a synthetic wire fixture generated with `devalue@5.9.2` is parsed by `5.9.4`;
- the revived cyclic/repeated-reference graph, `Map`, `Set`, `Date`, bigint, typed bytes and `undefined` remain correct;
- `5.9.4` round-trips the revived value;
- no live persisted Workflow run was replayed or migrated.

The security backport intentionally changes or rejects edge cases that should not be relied upon: Node Buffer serialization no longer includes unrelated backing-pool bytes, malformed null-prototype keys and invalid typed-array backing buffers are rejected, and vulnerable `uneval`/`stringifyAsync` behavior is corrected. Workflow's published supported types include `Uint8Array`; it does not promise Node Buffer wire compatibility.

## Verification

| Check | Result |
| --- | --- |
| Dependency update | `changed 1 package` |
| Installed resolution | `@workflow/core@4.8.9 -> devalue@5.9.4` as an override |
| Runtime npm audit | 0 vulnerabilities: info 0, low 0, moderate 0, high 0, critical 0 |
| Audit/compatibility gate | 8 tests passed |
| Compatibility receipt | `oldVersion: 5.9.2`, `newVersion: 5.9.4`, synthetic old-to-new proof true, `liveRunReplay: false` |

Evidence files:

- `docs/execution-notes/runtime-wiring-20261001/audit-before.json`
- `docs/execution-notes/runtime-wiring-20261001/audit-runtime-after.json`
- `docs/execution-notes/runtime-wiring-20261001/audit-compatibility.log`
- `docs/execution-notes/runtime-wiring-20261001/devalue-compatibility.json`
- `docs/execution-notes/runtime-wiring-20261001/dependency-install.log`
- `tests/devalue-compatibility.test.mjs`
- `tests/fixtures/devalue-5.9.2-wire.json`

Official package evidence:

- [devalue v5.9.4 package manifest](https://github.com/sveltejs/devalue/blob/v5.9.4/package.json)
- [devalue v5.9.2 package manifest](https://github.com/sveltejs/devalue/blob/v5.9.2/package.json)
- [@workflow/core 4.8.9 registry metadata](https://registry.npmjs.org/@workflow%2fcore/4.8.9)
- Workflow's installed official docs: `node_modules/@workflow/core/docs/foundations/serialization.mdx` and `node_modules/@workflow/core/docs/foundations/versioning.mdx`

## Cutover requirement

This is a source-only repair. No Vercel deployment, run cancellation, run migration or production cutover occurred.

Before any future deployment that claims the old vulnerable runtime is fully retired:

1. inventory active Workflow runs and their deployment IDs;
2. reconcile each run's persisted provider operation/job ID before choosing a cutover; let safe old runs finish, or prepare an explicitly approved recovery using the existing provider result. Do not blindly rerun upload/clone/render inputs or create a new job to replace an uncertain paid operation;
3. do not force an old run to resume in place under a different deployment/parser;
4. repeat runtime audit, Workflow validation/build, and representative serialization tests on the exact release candidate.

Until that inventory and an authorized deployment occur, the repository dependency is repaired but any still-running old deployment remains on its original dependency set.
