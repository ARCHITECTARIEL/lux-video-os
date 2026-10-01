# MVP audit and planning handoff — 2026-09-29

Status: audit and planning complete; product release not approved.

## Scope and identity

Read-only local-source/GitHub/Vercel/ZIP audit, followed by local documentation updates. Start/end source HEAD: `1c6121f83dd455fc8fbac4c96332a284dd9e0bb9`, main. Preserved inherited 18 tracked product/test changes and new authorization source/tests. No source repair, commit, push, merge, deploy, environment update, DB operation, provider call or paid transaction performed.

Used native specialists for independent ZIP, GitHub and code audits, with an independent plan critic. No tmux/OMX runtime was launched.

## Findings and changes

- ZIP is documentation-only, anchored to main, omitting the newer uncommitted authorization repair. Hash/inventory in audit folder.
- Production stable alias points to September 24 `a04e595...` deployment; main preview points to `1c6121f...`. Local Vercel link is production, contradicting old orientation.
- GitHub is public; old PR #43–46 work is resolved. Current CI passes but CodeQL fails; Stripe reconciliation fails absent configuration.
- Real DTO omits accepted-output/tier fields, media acceptance is insufficient, talent authorization remains inconsistent, migration verification fails open, Standard portrait/LatentSync input contracts differ.
- P0 verification script fabricates successful observations and must not be used as proof. Added this blocker to all release planning.
- Created canonical current handoff, completion plan, nine execution prompts (with explicit decision/preparation/execution boundaries), four audit reports and sanitized evidence.
- Added supersession notices to AGENTS, HANDOFF, README and developer atlas; added prompt-number routing clarification to execution note 02. Existing history preserved.
- Critic recommendations integrated: private-storage migration ownership, immutable dirty baseline, exclusive lead ownership of shared docs, Standard decision gate, exact release approval envelope, prompt-number mapping, media-tool availability and expected DB identity manifest.

## Verification

Fresh focused Node tests: 66 total, 65 pass, 0 fail, 1 live-DB skip, exits 0. Exact commands and logs: `docs/audit-2026-09-29/code-readiness-audit.md`. Prior full suite remains historical evidence, not rerun here. `git diff --check` passed. Final local link/reference check recorded with audit evidence.

Final validation: 22 local documentation links resolved; all six copy-critical prompt checks passed; evidence JSON parsed. Independent plan critic found no remaining high-severity gaps after revisions. Tracked inherited source diff fingerprint remained `d4b0e6f9ffd0fc5a5791661341bcfbf04ddc57b2` (`git diff -- api db lib tests workflows | git hash-object --stdin`), matching the audit baseline. HEAD remained unchanged.

No authenticated browser/provider/DB/Blob production proof. READY deployments do not imply functional acceptance. Current source modifications remain local and uncommitted.

## Resuming

Read `docs/CURRENT-MVP-HANDOFF.md`, then `docs/MVP-EXECUTION-PROMPTS-2026-09-29.md`, **Prompt 1 — Validate and preserve the existing authorization repair**. Include the talent route gap, then use Prompt 2 for the real DTO/accepted-output contract. Do not rerun historical old Prompt 2 implementation from scratch.

Open owner decision: portrait Standard, versioned source-video Standard, or reduced-scope Premium pilot. Independent local lanes may proceed while this remains pending. Legal/commercial model clearance, exact production release/spend, visibility settings and live billing are not approved by this planning session.
