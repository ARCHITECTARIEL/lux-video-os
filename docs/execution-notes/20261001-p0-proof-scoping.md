# P0 production proof — scoping assessment, October 1, 2026

Status: read-only investigation only. No code written, no production state changed. Billing (Stripe or Authorize.net) explicitly deferred by the owner to a later session -- not evaluated here.

## Why this note exists

After bootstrapping the production HeyGen binding, the owner asked to proceed directly to the P0 production proof (`docs/P0-RELEASE-GATE.md`). Before touching the activation switch or spending real money, the actual prerequisites were checked against current reality. Two of them are substantial, unbuilt pieces of work, not quick continuations -- this note exists so a future session doesn't have to rediscover that from scratch.

## What's actually required, and its current state

1. **A real P0 evidence collector.** `tools/verify-p0-release-gate.mjs` is permanently disabled by design (every invocation exits 2) -- see [the Prompt 4 P0 note](20260930-prompt4-p0.md). The deliberate reasoning: "Accepting a self-asserted JSON envelope would only move the fabrication boundary and would not authenticate the deployed candidate, provider, database, private artifact, browser sessions, or correlated billing records." A real collector needs to authenticate a live signed-in session, submit one real render, poll the real provider job, download and hash the private artifact, then independently repeat checks from a **fresh browser context** (anonymous download 401, wrong-account 404, direct private Blob access denied). This is real browser-automation integration work, not a script.
2. **Private storage migration, explicitly found "not ready to execute."** Per [the Prompt 4 storage note](20260930-prompt4-storage.md): production has 77 Blob objects (69.4MB), of which **26 are unclassified** (20.2MB) -- not provably safe to touch. `docs/P0-RELEASE-GATE.md`'s required configuration gates include "all legacy public account, auth, rate, job, upload, and final objects have been copied to private storage, verified, references migrated, and public originals removed." The reviewed migration procedure is 4 phases (freeze/inventory, copy-and-verify, reference migration, public-source removal), **each explicitly requiring its own separate production-write approval**, with the last phase marked "destructive approval" and "any cross-account or missing-artifact result is an immediate launch stop."

Both of these are real engineering projects, not configuration flips. Neither was started today.

## Current environment state (checked, non-sensitive)

Confirmed present in production (values not read, existence only): `VIDEO_OS_DURABLE_WORKFLOW_ENABLED`, `VIDEO_OS_PROVIDER_MEDIA_HOSTS`, `CRON_SECRET`, `VIDEO_OS_PUBLIC_ORIGIN`, `BLOB_READ_WRITE_TOKEN`, `VIDEO_OS_SESSION_SECRET`. `VIDEO_OS_BILLING_ENABLED` and `VIDEO_OS_HOSTED_FINISHING_ENABLED` are absent (unset), matching the gate's required containment state. `providerCreationActivationStatus()` remains hardcoded disabled -- untouched.

One correction to the Sept 30 storage note's blocker #1: the canonical production `DATABASE_URL`'s mapping to Neon project `still-voice-83326863` was independently confirmed earlier this same day (see [the canonical DB investigation](runtime-wiring-20261001/canonical-db-investigation.md)), which that note had flagged as unresolved. That specific blocker is resolved; the 26-unclassified-object and migration-execution blockers are not.

## Owner decision

Given the scope of both prerequisites, and the amount of real production-impacting work already completed this session (migrations applied, schema lock fixed, code deployed, HeyGen binding bootstrapped), the owner chose to stop here rather than start either piece. Billing (Stripe vs. Authorize.net, undecided) is explicitly deferred to a later session and does not block this proof directly -- `VIDEO_OS_BILLING_ENABLED` stays unset throughout the P0 proof itself per the gate's own configuration requirements.

## Next action

Treat the P0 proof as its own dedicated, multi-session project. Recommended order when picked back up: (1) re-run the storage inventory read-only to see if the 26 unclassified objects have changed, then work through the 4 migration phases with explicit approval at each; (2) build the real evidence collector in parallel or after, since it depends on storage being migrated (the gate's own config requirement) before a real proof run can count. Flipping `providerCreationActivationStatus()` should happen only immediately before the actual proof run, not before -- it is the one step that makes real customer-facing render submission possible, and should not sit enabled with no proof run actually in progress.
