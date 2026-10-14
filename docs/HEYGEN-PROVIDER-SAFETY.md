# HeyGen provider safety (PROV-001)

## Admission

All HeyGen render claims use Postgres transaction advisory lock `730561014001`. The lock covers a global count of `video_jobs` in `provider_submitting`, `provider_submitted`, `provider_rendering`, and `provider_submit_unknown`, the per-account count, and the transition to `provider_submitting`. The last state retains a slot because an ambiguous POST may have created a running video. `provider_ready` releases the slot because the provider has completed generation. This is deliberately conservative when unknown jobs accumulate; operators can resolve those held jobs.

`VIDEO_OS_HEYGEN_MAX_CONCURRENCY` defaults to 8 and clamps to 1–10. `VIDEO_OS_HEYGEN_MAX_PER_ACCOUNT` defaults to 2 and clamps to 1–global. Invalid values use defaults. A refused admission remains `workflow_started`, records a five-second `nextAttemptAt` in `video_jobs.output.heygenSubmission`, and creates a job event. It does not fail or release the credit reservation. Both the VPS worker query and the durable Workflow respect the delay.

No schema change was needed. Migration 0014 and the main-branch 0012/0013 journal gap are untouched.

## HTTP retries and identity

Every `/v3/videos` POST uses `vos-` plus the first 32 hex characters of SHA-256 over `jobId|attempt`. The current attempt is 0; an ambiguous retry **always** uses the same key, as does a retry after a definitive 429/503. A stable `vos-` job hash marker is appended to the provider title for inventory lookup. The key, marker, attempt, retry count, and claim time are persisted in `video_jobs.output.heygenSubmission` before POST. The key contains no script, title, account identifier, or credential.

A 429 or 503 response to POST is treated as definitive rejection. It marks the lifecycle operation failed and returns the job to `workflow_started`; the next claim gets a new lifecycle attempt but the same provider idempotency key. `VIDEO_OS_HEYGEN_MAX_RETRY_ATTEMPTS` defaults to 6 (six requeues after the first submission); exhaustion fails with `PROVIDER_RETRY_EXHAUSTED` and releases reserved credits. A lost response, timeout, network error, malformed success, or other 5xx remains `provider_submit_unknown` and requires reconciliation. That state is never handled by the normal submit loop.

Retry-After supports seconds and HTTP-date, clamped to 0–900 seconds. Without a valid header, delay uses full jitter from `[0, min(900 seconds, 1 second × 2^(retry number − 1)))`; clock and RNG can be injected in tests. A 429/503 on GET delays the next poll while retaining the provider job ID and state. Requeueing that job for another POST would risk duplicate generation.

## Held submission reconciliation

`VIDEO_OS_HEYGEN_SUBMIT_RECONCILER_ENABLED` defaults off. When enabled, the VPS worker scans held jobs once per minute. The resolver uses the existing read-only v3 inventory adapter against `GET /v3/videos`; only a complete, bounded inventory can establish absence. A single matching title marker is attached to the existing provider lifecycle operation and moves the job to `provider_submitted`. Multiple matches, incomplete inventory, invalid IDs, or transport/binding failures stay held and are logged for attention. After `VIDEO_OS_HEYGEN_RECONCILE_GRACE_SECONDS` (default 1800, allowed 60–86400), verified absence releases the held job to `workflow_started` with the **same** idempotency key. After 24 hours from claim, automatic resubmission remains held because the documented idempotency replay window may have expired. Reaching the ambiguous retry limit also holds the job for attention; an unresolved provider outcome cannot safely be labelled a definitive failure.

The existing `services/heygen-reconciliation.js` signed deletion contract and read-only resource adapter remain separate. This reconciliation adds no delete path. The exact v3 list response shape is validated by the existing explicit pagination contract; an unsupported shape fails closed and needs provider qualification before enabling the flag.

## RunPod

`VIDEO_OS_RUNPOD_JOB_TIMEOUT_MS` defaults to 30 minutes. Standard submissions persist `runpodSubmissionStartedAt` in `video_jobs.output`. Once the deadline passes, polling requests `POST /cancel/{id}` on the configured RunPod endpoint base and raises `PROVIDER_TIMEOUT` for the workflow failure path. The cancellation call is injectable in tests. A cancellation transport failure is `PROVIDER_CANCEL_UNKNOWN`; an operator must check the remote job before treating it as cancelled.

## Verification limits

The regular provider tests inject fetch and use synthetic responses. The separate `npm run test:pg-race` suite exercises `transitionJob` concurrently against a disposable local Postgres through Neon's WebSocket proxy. It checks actual advisory-lock admission and persisted job statuses. The suite uses fixture binding/ledger adapters, so it does not qualify provider credentials, provider calls, or the complete live binding path. The exact v3 inventory shape still needs review before the default-off reconciler can be activated.

### Run the local admission race

Use a **throwaway** Postgres 17 database. The suite drops `public` and `drizzle`, applies every migration in `drizzle/meta/_journal.json`, and truncates fixture tables between trials. Never give it a shared or production database URL. One Docker setup on a machine where host port 5432 is free is:

```powershell
docker run -d --name video-os-pg-race -e POSTGRES_USER=race -e POSTGRES_PASSWORD=local-only -e POSTGRES_DB=race -p 127.0.0.1:5432:5432 -p 127.0.0.1:55433:80 postgres:17
docker run -d --name video-os-wsproxy-race --network container:video-os-pg-race -e 'ALLOW_ADDR_REGEX=^localhost:5432$' ghcr.io/neondatabase/wsproxy:latest ./app
```

The shared container network namespace lets wsproxy reach Postgres at `localhost:5432`; both published host ports are loopback only. Wait until `docker exec video-os-pg-race pg_isready -U race -d race` succeeds. Stop and remove these two disposable containers after the run. The wsproxy image's `ALLOW_ADDR_REGEX` setting was inspected from the locally installed image; confirm it if using a different image version.

Set `VIDEO_OS_PG_RACE_TEST_URL` to the throwaway `postgresql://` URL with hostname `localhost`, `127.0.0.1`, or `::1`, and set `VIDEO_OS_PG_RACE_TEST_WSPROXY` to `localhost:<port>` or `127.0.0.1:<port>`. The database name must match `^(?:race|throwaway|vos_race)[a-z0-9_]*$`. Set `VIDEO_OS_PG_RACE_TEST_OPT_IN` to the exact phrase below. The test connects through wsproxy's `/v1` endpoint. For example, in PowerShell, after the two containers are running:

```powershell
$env:VIDEO_OS_PG_RACE_TEST_URL = 'postgresql://race:local-only@localhost:5432/race?sslmode=disable'
$env:VIDEO_OS_PG_RACE_TEST_WSPROXY = 'localhost:55433'
$env:VIDEO_OS_PG_RACE_TEST_OPT_IN = 'i-understand-this-drops-the-schema'
npm run test:pg-race
```

The URL, database name, opt-in, and proxy validation fail closed before any database connection. If the URL is set but either the host, database name, or opt-in check fails, the suite fails rather than skipping. With the URL unset, the suite skips and makes no database connection. `npm test` does not include this destructive integration suite.
