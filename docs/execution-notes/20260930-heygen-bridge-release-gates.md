# HeyGen bridge design and release-gate verification - September 30, 2026

Status: reviewed design/local implementation handoff; local release-boundary repairs verified. Live provider deletion and production activation remain unverified and unauthorized.

## Owner direction

The owner requested HeyGen deletion/reconciliation and existing release-gate verification, then selected: "prep a temp upload design. the MVP should be a bridge to the provider."

Prepared [the canonical design](../HEYGEN-BRIDGE-TEMP-UPLOAD-DESIGN.md), PRD and 39-case test specification under `.omx/plans/`. It separates raw temporary provider assets, reusable identity resources, provider output and private history. It requires explicit bridge-v2 consent, exact resource origins, normalized durable claims/events, a frozen account-first lock order, a separate signed approval issuer, and truthful API/CDN/backup proof states. Independent architecture and risk reviews both approve design/local implementation handoff only. Preset native-role models were unsupported; working-agent advisory reviews were used and a formal Ralplan consensus gate was not fabricated.

No deletion adapter/executor, consent-v2 UI or normalized ledger migration was implemented by this design task. The earlier local enrollment and shared-script implementation remains intact.

## Official and live read-only evidence

- [Official HeyGen research](heygen-release-20260930/heygen-official-research.md): v3 create/read/delete contracts, absence codes, cascade/template/pending restrictions, API pricing and privacy terms.
- Asset upload returns a public URL. No documentation establishes that source deletion preserves reusable resources or revokes the old CDN URL; both require bounded canaries. API absence is not backup purge. Broader model-training use/opt-out is a separate account qualification.
- Connected HeyGen account read succeeded; it is not bound to the application's API key. No upload, clone, render or DELETE occurred. [Sanitized observation](heygen-release-20260930/connected-heygen-account.json).
- [Storage/DB read-only refresh](heygen-release-20260930/storage-readiness.md): production Blob metadata/token binding/listing verified (77 objects; 26 unclassified); canonical production DB and Preview Blob runtime credential binding remain unresolved because values are write-only. No production SQL or media download was performed.
- [GitHub audit](heygen-release-20260930/github-release-gates.md): main remains 1c6121f; old-main CI is green while CodeQL/Stripe reconciliation are red. Current dirty candidate has no CI/CodeQL proof. Unprotected main is a recommendation/risk, not an invented mandatory release gate.

## Local implementation changes

Changed `services/hyperframes-finisher.js`, `tools/release-build-manifest.mjs`, `tests/hyperframes-boundary.test.mjs` and `tests/release-build-gates.test.mjs`.

Removed optional Sandbox runtime imports from the supported application/workflow graph. HyperFrames now fails clearly before media/storage/remote work; FFmpeg/HeyGen behavior remains. Kept the existing strict Sandbox scanner and operator-only proof helpers. The manifest now marks a worker image inapplicable to the selected managed HeyGen API, while preserving explicit runtime-scope/account/capability/pricing/privacy/deletion/canary gates. Self-hosted selections retain image evidence requirements. No dependency added and no node_modules workaround used.

## Verified candidate

- HEAD: `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`; inherited dirty checkout preserved. Baseline receipt/private backup: `heygen-release-20260930/baseline.json`.
- Source SHA256: `b2e7e583a660823f76d32fda8c3f6d4befa2238846d4fc7cba69c7af1743a7f5`.
- Output SHA256: `b8a3b7dcfe1705b19b5c9a065a78cafb725021485e201b79efcf25476fcca47e`.
- Full unit suite: 451 Node passes, 44 expected credential/guarded skips; four Vitest passes; exit 0.
- Focused boundary/gate tests: 30/30 passed; syntax and whitespace passed.
- Review-only preview packaging: 42 routes, 29 steps, six workflows; exit 0.
- Workflow manifest: `NO_KNOWN_SANDBOX_CLASS_LEAK`, verified true with no Sandbox class/step leakage.
- Source/project-link readback matches; `.vercel/output` remains absent. [Build summary](heygen-release-20260930/build-summary.json) and [source ledger](heygen-release-20260930/source-files.json).

Earlier browser/media/DB proofs remain bound to the enrollment checkpoint; no new UI or database behavior was changed in this local boundary repair. They are not relabeled as new live provider proof.

## Remaining gates and next work

Implement the design's local ledger/consent/plan/status foundations and disabled signed executor, then qualify the actual app-key account/scopes, pricing and privacy/opt-out. Prepare an exact disposable canary envelope with approved media, operations, spend/call ceilings, receipt destination and cleanup scope; observe source independence, API absence and old-URL denial before any customer activation.

Production canonical DB identity, Preview Blob binding, production reference disposition, exact-candidate CI/CodeQL, rollback-byte attestation and real P0 remain unresolved. Production secret rotation/re-save, migrations, object changes, publication, billing, deployment and real provider operations require their own concrete scope. No such write occurred.
