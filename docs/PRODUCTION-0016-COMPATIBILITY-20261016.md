# Production 0016 compatibility preparation — October 16, 2026

**Candidate:** draft PR #111, `76e3ecac5f788916d778dc8cea12af0992ef9259`. **Scope:** read-only production observations and disposable local PostgreSQL 18.6 rehearsal. No production migration, row write, provider call, deployment, schema-lock change or feature activation occurred. Detailed private source-archive hashes and local fixture custody are under ignored `.omx/artifacts/production-0016-compat/`.

## Identity and production readback

At 19:52 UTC, the active production alias still resolved to a READY prebuilt deployment whose metadata records Git source `03ccac30e815eacfabbb3b902f55bfe9304b6cee`. All 80 first-party JS/JSON/SQL files in its deployed render-function source subtree, plus two workspace-function files and the workflow-step migration journal, matched the Git blobs at that commit byte for byte. This is **selected-function source attestation**, not a whole-artifact digest. The deployment's injected `DATABASE_URL` value still has no target-bound readback, so the following database results apply to the separately owner-designated production target; they do not prove the active app uses it.

That Neon target reported PostgreSQL 18.6, **15 ordered journal rows whose full hashes and timestamps match `0000–0014`**, and 28 public tables. The bounded application-row counts are retained in the private receipt. Evaluating the exact checked-in `0016` classifier expression as a read-only aggregate found **zero unclassifiable rows**. The source-consent-to-identity account join had zero mismatches. No raw customer row or identifier was exported.

Bounded table sizes are retained in the private receipt. Separate lock readbacks and the final readback showed zero held locks; the long-running-query diagnostic returned zero. Those are observations, **not a maintenance window or a migration-duration guarantee**. A new writer, a different active DB binding, or changed rows invalidates this precheck.

## Exact recorded-source rehearsal on a forward schema

A detached worktree at the recorded deployment commit used dependency manifests identical to the candidate checkout. An isolated local PostgreSQL 18.6 database received the supported Drizzle `0000–0016` sequence. Its 17 journal rows, 29-table catalogue and schema digest `6cbb37c27e0e2f7532f821e92b2d8c21ea2e9e330c8200b22011cb64bd8c5490` matched the reviewed canonical lock.

Against that forward schema, the recorded old repository code completed a synthetic **Standard** reservation, same-key replay, old-app read, workflow start, and idempotent failure/credit release. The new trigger persisted `standard_narration_v1`. The old ORM also inserted and read a synthetic **Premium Presenter-shaped** job, started it, and failed/released its reserved credits; the trigger persisted `premium_presenter_v1`.

A further exact-old-source local run resolved a saved Premium identity and source consent, issued and verified a quote, reserved and replayed the job, started its workflow, failed/released credits, and denied a fresh reservation after source-consent withdrawal. The forward trigger retained `premium_presenter_v1` throughout. The provider avatar status was an injected synthetic observation and provider-ledger resource lookup/reference attachment were stubbed. This proves the old application and forward-schema transaction shape with those boundaries; it does **not** prove a live provider, full ledger transaction or deployed environment configuration. No provider or email side effect was allowed.

An independent local `0014`-prefix database held 10,000 synthetic jobs (2,500 in each of four supported modes). `0015` completed in 162 ms with empty identity/consent parent tables. A concurrent `ACCESS SHARE` lock on `video_jobs` made atomic `0016` hit a 1-second lock timeout in 1,175 ms. The failed transaction left no `render_mode` column or classifier function and preserved all rows. After lock release, atomic `0016` completed in 361 ms with a 2-second lock timeout and 30-second statement timeout; all four mode counts were correct. Timings include local CLI overhead and must not be extrapolated to production load or Vercel behavior.

## Remaining gates before a live migration

1. Obtain a sanitized readback from the **active deployment's own injected database binding**, or retain the target mismatch as a hard block. Git metadata and project-level environment metadata alone are insufficient.
2. Refresh the full live journal, classifier aggregate, parent-row integrity, row counts, active sessions and lock/wait statistics immediately before a separately approved migration. Abort on any source/target drift, unknown row, unexpected client, lock wait or unsupported provider marker.
3. Qualify an exclusive migration authority, bounded traffic/worker admission, backup/recovery and exact rollback artifact. The local held-lock result supports a fail-fast lock timeout; it does not choose the production timeout or authorize an automatic down migration.
4. Exercise the unproven Premium **provider-ledger/resource transaction and external provider path** separately. The quote-to-reservation application path passed locally with a stubbed ledger and synthetic consent observation. Recheck the active deployment after any alias change.
5. Keep LUXIFY and Creative Finish off. The separate [consent lifecycle plan](LUXIFY-CONSENT-LIFECYCLE-PLAN-20261016.md) is an optional-feature gate, not a core Standard/Premium prerequisite.

**Memory Protocol reversal:** revert this documentation-only change after checking the branch and worktree. Preserve the ignored private receipt for audit or remove its exact local files under the custody note. Source rollback does not down-migrate a database or delete a cloud resource.
