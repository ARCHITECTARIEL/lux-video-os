# Watchdog native Cron candidate — October 17, 2026

Status: local source candidate, not deployed. No production schedule, provider, job, credit, database, or configuration change was made.

## Incident and diagnosis

At 08:22:56 UTC, the active production deployment reported source `13cd882` and a last successful watchdog heartbeat at 04:54:07 UTC. The age was 3 hours 28 minutes, beyond the 45-minute contract. GitHub's last scheduled sweep succeeded at 04:53:58 UTC; the previous scheduled run was 00:16:00 UTC, a 4-hour-38-minute gap. The last scheduled heartbeat succeeded at 05:05 UTC and correctly observed an 11-minute-old sweep. Neither workflow had a queued or in-progress run at the readback. The exact cause of the missing scheduled invocations is not established. Existing successful runs prove that the deployed sweep endpoint and credentials worked at those times; they do not prove scheduler cadence.

The production Vercel team reported `billing.plan=pro` through authenticated read-only metadata. This supersedes the old source comment claiming Hobby's daily-only Cron limit for the current team. Current official [Vercel Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) permit once-per-minute Pro schedules. Vercel's [Cron documentation](https://vercel.com/docs/cron-jobs/manage-cron-jobs) says it sends `Authorization: Bearer CRON_SECRET`, uses GET, and delivers best effort with possible missed or duplicate invocations. The [Build Output API](https://vercel.com/docs/build-output-api/v3/configuration) supports `crons` in `config.json`.

## Local change

- `vercel.json` schedules `/api/video-os-lite/watchdog-cron` every 15 minutes. That path routes through the existing consolidated workspace function; no tenth application function is added.
- Only an authenticated GET with the existing cron Bearer secret can execute this route; an admin credential cannot. The route records the same persisted `watchdog_heartbeat` only after success and returns no job identifiers. The old authenticated admin POST remains available.
- Production health now reports watchdog `ok` and a bounded failure code, and reports `degraded` when the persisted heartbeat is missing, future-dated, or older than 45 minutes. DB and Blob failures retain `fail` status.
- Scheduled GitHub sweeps become fallback-only: they skip when the last native heartbeat is at most 25 minutes old, run after an aging heartbeat, and still run when the only degraded health reason is stale watchdog state. Manual dispatch remains available. The separate GitHub heartbeat checker remains an independent alarm, but its own observed scheduling is delayed.
- The production build rejects Vercel output that omits or changes this exact native Cron and preserves it when merging Workflow output.

## Activation and proof boundary

Before a production promotion, require a clean exact source, exact-head CI/CodeQL, a release build whose final `.vercel/output/config.json` includes this Cron, a current database/rollback receipt, and explicit owner authorization for the production deployment. After promotion, read back the active alias, Vercel Cron registration, a successful authorized native invocation, persisted `lastSweepAt`, and multiple 15-minute intervals. Exercise the GitHub fallback only under a separately reviewed scope; it is a mutation-capable operation. Do not claim the 45-minute contract from local tests or Cron registration alone.

Vercel Cron is best effort and may duplicate or miss invocations. Existing job transitions use row-level and idempotency guards, but a production overlap and provider recovery race has not been exercised by this candidate. If native delivery and the independent heartbeat both miss, neither this change nor GitHub Actions alone guarantees a hard 45-minute service level. An independently operated monitor with a verified alert path remains the next reliability step if the contract must be guaranteed rather than observed over a pilot window.

## Independent review follow-up — October 17

An adversarial review found three release risks in the first commit: native Cron lacked the GitHub preflight's DB/Blob/provider health guard; the GitHub fallback returned 200 after a failed heartbeat write; and overlapping deliveries could repeat provider recovery or alerts. The follow-up requires all three dependency checks and a bounded DB probe before native work, makes either HTTP route fail when heartbeat persistence fails, and uses the existing atomic `rate_limits` table to claim the entire selected job set for ten minutes across native Cron, GitHub fallback and the VPS worker. The claims commit together in one short transaction or roll back together. A losing sweep has no provider call, credit mutation or alert and cannot certify a fresh heartbeat. Reserved-only and actionable timeout releases now require the exact selected status and update timestamp under the row lock; only an actual transition is reported as a release or timeout. No schema migration or new external resource is needed.

The claim window allows a crashed winner to be retried on the next nominal 15-minute native tick. It does not prove a hard delivery deadline when Vercel misses ticks, and an unusually long provider operation exceeding ten minutes could outlive its claim. Synthetic tests cover concurrent mixed-bucket deliveries, all-or-nothing claim rollback and expiry, claim failures, guarded reserved-only transitions, duplicate side effects and truthful counters. Independent re-review found no remaining concrete high or medium issue within this source scope; production overlap remains an explicit post-deploy observation.
