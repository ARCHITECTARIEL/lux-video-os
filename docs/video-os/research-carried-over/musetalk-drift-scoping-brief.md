# MuseTalk Drift Scoping Brief

**Authority:** L0 read-only investigation and documentation only  
**Captured:** 2026-09-03, America/New_York  
**Committed HEAD:** `2d355b2b7bfe4030c6d15b3079f0c4a505af41ce` (`2026-09-03T15:32:58-04:00`)  
**Scope:** Standard-tier dispatch, MuseTalk/SadTalker working-tree drift, test applicability, and canary reachability. This brief makes no implementation recommendation.

## Executive finding

### COMMITTED HEAD

**Evidence:** `workflows/video-render.js` imports only `submitHeygen`/`pollHeygen` as provider dispatch functions. `submitProvider()` always calls `submitHeygen(...)`; `pollProvider()` always calls `pollHeygen(...)`. It does not normalize or branch on tier or adapter.

**Finding (high confidence):** “HeyGen-only” is correct as a provider-dispatch characterization of committed HEAD. It does not mean HEAD has a valid Standard implementation: a job described as Standard is not routed to a Standard engine; if it reaches this workflow, it follows the same HeyGen submit/poll path as every other job (subject to its existing authorization/input gates).

### WORKING TREE

**Evidence:** The uncommitted workflow normalizes the job contract, checks the tier feature flag, accepts three explicit adapters, then dispatches by adapter:

1. `premium-heygen` → HeyGen.
2. `standard-sadtalker-local` → SadTalker local-simulation submit/poll functions.
3. `standard-musetalk-stub` → MuseTalk in-memory stub submit/poll functions.

The Standard default remains `standard-placeholder`, which is rejected before submission as `FEATURE_DISABLED`. The public `api/video-os-lite/render-v2.js` entrypoint also returns HTTP 503 for every Standard submission before job reservation or workflow dispatch.

**Finding (high confidence):** MuseTalk is one of several mutually exclusive, explicit adapter branches. It is neither the only path nor a fallback for SadTalker. SadTalker is checked before the final MuseTalk expression, and the preceding allowlist guard ensures that the final expression is reached only for `standard-musetalk-stub`. Neither Standard adapter is selected by default.

## 1. Provider dispatch trace

### COMMITTED HEAD

`videoRenderWorkflow(jobId)` → `submitProvider(jobId)` → unconditional `submitHeygen({ ...job, input: submissionInput })` → provider job ID persisted → poll loop → unconditional `pollHeygen(providerJobId)` → finishing.

There is no import or reference to MuseTalk, SadTalker, `normalizeJobRenderRequest`, `assertRenderTierEnabled`, or adapter selection in the committed workflow. Committed HEAD therefore sends any job that reaches provider submission to HeyGen; it does not implement a Standard-tier dispatch path.

### WORKING TREE

`videoRenderWorkflow(jobId)` → `submitProvider(jobId)` → `normalizeJobRenderRequest(job)` → `assertRenderTierEnabled(renderContract.tier)` → explicit adapter allowlist → mutually exclusive provider branch:

| Normalized adapter | Submit path | Poll path | Actual boundary |
|---|---|---|---|
| `premium-heygen` | `submitHeygen(...)` | `pollHeygen(...)` | HeyGen provider integration |
| `standard-sadtalker-local` | `submitSadtalkerStageALocal(...)` | `pollSadtalkerStageALocal(...)` | In-memory local-simulation record only; no network submission and no worker invocation |
| `standard-musetalk-stub` | `submitMusetalkStubJob(...)` | `pollMusetalkStubJob(...)` | Deterministic in-memory stub |
| omitted on a Standard job | normalized to `standard-placeholder` | none | rejected by allowlist with `FEATURE_DISABLED` |
| any other adapter | none | none | rejected by allowlist with `FEATURE_DISABLED` |

The SadTalker and MuseTalk branches are mutually exclusive values of one normalized adapter. There is no runtime fallback from SadTalker to MuseTalk or from MuseTalk to SadTalker.

`services/sadtalker-runpod.js` exposes two distinct surfaces that are not connected to each other by the workflow:

- `submitSadtalkerStageALocal()` validates inputs and manifest identity, then stores a queued item in a module-local `Map`; it explicitly returns `networkSubmitted: false`.
- `pollSadtalkerStageALocal()` reads that item and reports it as not ready.
- `executeSadtalkerStageALocal()` can invoke a caller-supplied `runWorker`, validate the output independently, and clean temporary files, but neither workflow submit nor poll calls it.
- `workers/sadtalker/runner.py` invokes pinned SadTalker `inference.py`, but the workflow/service submit/poll path does not invoke that runner.

Accordingly, the working-tree SadTalker branch is wired only to a local-simulation queue contract, not to the executable Stage-A worker.

## 2. `job-contract.workflow.test.mjs`

The requested root-level path `job-contract.workflow.test.mjs` does not exist. The actual file is the untracked `tests/job-contract.workflow.test.mjs`; because it is untracked, the requested `git diff HEAD -- workflows/video-render.js job-contract.workflow.test.mjs` command contains no test-file diff. Its complete untracked-file patch is separately captured in Appendix C.

### COMMITTED HEAD

Applying the working-tree test’s six source assertions to committed `HEAD:workflows/video-render.js` fails. In fact, all six expected strings/patterns are absent from HEAD:

- normalized render-request call;
- tier enablement assertion;
- submit-attempt metadata construction;
- submit attempt correlation ID;
- the direct-HeyGen statement after `providerMayHaveReceivedRequest = true`;
- normalized poll status metadata.

The test would stop at its first assertion (`normalizeJobRenderRequest`). The test itself is not present in committed HEAD, so it does not run as part of a clean HEAD checkout unless carried in separately.

### WORKING TREE

The test asserts that the workflow contains the normalized tier contract and attempt metadata, and additionally asserts a literal direct-HeyGen source shape:

`providerMayHaveReceivedRequest = true;` followed by `const submitted = await submitHeygen`.

The first four assertions and the final `normalizedStatus` assertion match. The direct-HeyGen assertion fails because the working tree now assigns `const submitted` from an adapter conditional expression. Verified command result: `node --test tests/job-contract.workflow.test.mjs` → 0 passed, 1 failed, at line 11.

**Separate result:** the test fails against both states, for different reasons. HEAD lacks the normalized contract wholesale; the working tree contains the normalized contract but violates the test’s stale direct-HeyGen source-shape assertion.

## 3. Drift timing and provenance

### COMMITTED HEAD

The last five commits touching `workflows/video-render.js` are all earlier than the September 2/3 Standard work; the newest is `3c65dc0` from 2026-08-07. None of the three Stage-A commits touches the workflow:

- `32cc934` (2026-09-03T15:26:47-04:00) adds only the SadTalker dependency-lock files.
- `8539ea7` (2026-09-03T15:31:41-04:00) commits the SadTalker service, worker, Stage-A tests, and re-audit update, but not `workflows/video-render.js`.
- `2d355b2` (2026-09-03T15:32:58-04:00) commits only the Stage-A execution receipt.

Committed HEAD therefore contains the Stage-A service/worker artifacts but not either Standard branch in the workflow.

### WORKING TREE

The two uncommitted Standard branches have different provenance:

- **MuseTalk predates today’s Stage-A build.** The pre-worker version of `cr-001-standard-reaudit.md` as stored at `32cc934` already says the workflow “already conditionally dispatches `standard-musetalk-stub`.” The MuseTalk stub and its workflow-contract tests have filesystem creation/last-write timestamps on 2026-09-02. The Stage-A receipt also labels the workflow-regex failure pre-existing at the baseline before worker changes.
- **SadTalker is a byproduct of today’s Stage-A continuation.** The workflow’s last-write timestamp is `2026-09-03T15:28:17.9364554-04:00`, after the lock commit at 15:26:47 and before the worker commit at 15:31:41. The committed receipt says the workflow retained pre-existing dirty changes and included scoped Stage-A additions from the continuation. The added `standard-sadtalker-local` branch imports the service committed by `8539ea7`.

**Finding (high confidence):** it is inaccurate to classify the combined MuseTalk/SadTalker conditional as wholly created by today’s Stage-A work or wholly pre-existing. The MuseTalk portion was already uncommitted drift from September 2; today’s Stage-A session layered the SadTalker conditional onto that dirty workflow. The pre-existing undocumented/partially documented drift is MuseTalk; the expected Stage-A scaffolding is SadTalker.

## 4. Un-drifting scope (inventory, not recommendation)

### COMMITTED HEAD baseline scope

Starting strictly from HEAD would be **medium** scope because HEAD has no tier/adapter routing in the workflow even though the SadTalker worker/service artifacts are committed. A single intentional Standard dispatch path would touch these behavior/contract surfaces:

- `workflows/video-render.js` — introduce one Standard dispatch selection and preserve Premium HeyGen behavior.
- `lib/video-os-job-state.js` — make the Standard adapter default/selection consistent with the one intentional path; current default is `standard-placeholder`.
- `lib/video-os-validation.js` — keep request normalization and the chosen Standard input contract aligned.
- The single selected Standard service boundary — currently `services/sadtalker-runpod.js`, `services/musetalk-stub.js`, and `services/musetalk-runpod.js` represent different incomplete boundaries.
- `api/video-os-lite/render-v2.js` — reconcile the unconditional Standard HTTP 503 gate with whatever “reachable” means for the intentional path.
- `tests/job-contract.workflow.test.mjs`, `tests/job-contract.validation.test.mjs`, and the selected adapter’s focused contract tests — assert behavior rather than incompatible source shapes.
- `docs/video-os/MASTER_SPEC.md`, `docs/video-os/cr-001-standard-reaudit.md`, and the relevant decision/mission records — make the selected engine and actual certification boundary agree.

### WORKING TREE delta scope

From the actual working tree, convergence remains **medium**, but it is not a clean-room implementation. Partial progress already exists in tier normalization, attempt metadata, allowlisting, two Standard branches, and focused tests. The concrete reconciliation surface is:

- `workflows/video-render.js` — collapse two explicit Standard branches into one intentional Standard branch and remove the non-selected routing/import/payload/status code.
- `lib/video-os-job-state.js` — replace or deliberately retain `standard-placeholder` as the default contract; today omission reaches neither Standard branch.
- `lib/video-os-validation.js` — align normalized Standard inputs and adapter identity with the single branch.
- `api/video-os-lite/render-v2.js` — account for the pre-dispatch Standard 503 containment gate.
- `services/sadtalker-runpod.js` plus `workers/sadtalker/` if SadTalker is the selected boundary; the current workflow submit/poll functions do not reach `executeSadtalkerStageALocal()` or `runner.py`.
- `services/musetalk-stub.js`, `services/musetalk-runpod.js`, and `workers/musetalk/` if MuseTalk artifacts are retained, retired, or isolated from the canonical path.
- `tests/job-contract.workflow.test.mjs` — remove the stale direct-HeyGen source-shape assumption while preserving the intended contract assertions.
- `tests/m5-workflow-stub-contract.test.mjs`, `tests/m5-musetalk-stub.test.mjs`, `tests/sadtalker-stage-a.test.mjs`, and `tests/job-contract.validation.test.mjs` — reconcile assertions for the one intentional branch and rejected adapters/defaults.
- `docs/video-os/MASTER_SPEC.md`, `docs/video-os/cr-001-standard-reaudit.md`, `docs/video-os/MISSION_BRIEFING.md`, and the applicable ADR/change-request/receipt records — document the owner-selected engine and distinguish local simulation, real worker invocation, and canary certification.

This inventory deliberately does not choose between SadTalker and MuseTalk.

## 5. Critical-path canary answer

### WORKING TREE — what a near-term canary would run locally

**Direct answer: No, an L2 SadTalker canary would not currently reach the real SadTalker Stage-A worker. Existing MuseTalk logic would not intercept an explicitly labeled SadTalker job, but the SadTalker branch itself stops at local simulation.**

Detailed outcomes:

- Through the public `render-v2` endpoint: every Standard request returns HTTP 503 before workflow dispatch, regardless of adapter.
- Through a lower-level workflow invocation with no explicit adapter: Standard normalizes to `standard-placeholder` and fails `FEATURE_DISABLED`; neither MuseTalk nor SadTalker runs.
- Through a lower-level workflow invocation with `adapter: standard-sadtalker-local` and both Standard/local-simulation flags enabled: the SadTalker branch wins; MuseTalk does not intercept. Submission stores an in-memory queued record, polling never invokes `executeSadtalkerStageALocal()` or `workers/sadtalker/runner.py`, and the workflow remains non-ready until its polling deadline.
- Through a lower-level workflow invocation with `adapter: standard-musetalk-stub`: only the MuseTalk stub runs.

Thus “MuseTalk interception” is not the blocker in the working-tree branch order. The blocking gaps are the public Standard containment gate, the `standard-placeholder` default, and the absence of a submit/poll connection to the real Stage-A worker.

### COMMITTED HEAD — canary environment provisioned without the working-tree changes

**Direct answer: No, a canary built from committed HEAD would not reach SadTalker either. It would have no SadTalker or MuseTalk workflow branch at all; any job that gets as far as provider submission follows the unconditional HeyGen path.**

This committed-vs-working-tree gap is operationally material:

- a local dirty-tree canary attempt can observe adapter validation, MuseTalk stub routing, or SadTalker local-simulation routing;
- a clean environment provisioned from HEAD cannot observe any of those paths and instead retains HeyGen-only provider dispatch;
- therefore evidence from one environment cannot be treated as evidence for the other without recording the exact source state.

## Appendix A — initial `git status` (verbatim)

```text
On branch main
Your branch is ahead of 'origin/main' by 25 commits.
  (use "git push" to publish your local commits)

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   api/video-os-lite/finalize-v2.js
	modified:   api/video-os-lite/render-v2.js
	modified:   db/repositories.js
	modified:   db/schema.js
	modified:   docs/video-os/MISSION_BRIEFING.md
	modified:   docs/video-os/REPOSITORY_ANCHOR.md
	modified:   drizzle/meta/_journal.json
	modified:   lib/video-os-observability.js
	modified:   lib/video-os-validation.js
	modified:   package.json
	modified:   public/lite.js
	modified:   routes/video-os-lite/admin.js
	modified:   routes/video-os-lite/results-v2.js
	modified:   workflows/video-render.js

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	.tmp-sadtalker-checksums/
	.tmp-sadtalker-clean-001/
	.tmp-sadtalker-clean-002/
	.tmp-sadtalker-clean-003/
	.tmp-sadtalker-detectors/
	.tmp-sadtalker-full-facevid/
	.tmp-sadtalker-pip-cache/
	.tmp-sadtalker-range-facevid/
	.tmp-sadtalker-torch-wheels/
	.tmp-torch-cu113-index.html
	.tmp-torch-cu113-torch.html
	.tmp-torch-cu113-torchaudio.html
	.tmp-torch-cu113-torchvision.html
	LUX_VIDEO_OS_MASTER_SPEC_V4.md
	SadTalker/
	docs/video-os/AGENT_HARNESS.md
	docs/video-os/GOVERNANCE.md
	docs/video-os/HOOKS.md
	docs/video-os/INTENT.md
	docs/video-os/PLAN.md
	docs/video-os/RELEASE_PLAN.md
	docs/video-os/SPEC.md
	docs/video-os/TEST_PLAN.md
	docs/video-os/adr/
	docs/video-os/agent-reports/
	docs/video-os/agent-work-orders/
	docs/video-os/blocker-register.md
	docs/video-os/canary-incident-protocol.md
	docs/video-os/change-requests/
	docs/video-os/current-state-audit.md
	docs/video-os/decision-log.md
	docs/video-os/facevid2vid-acquisition-diagnosis.md
	docs/video-os/governance-remediation-addendum-2026-09-03.md
	docs/video-os/governance-remediation-plan.md
	docs/video-os/missions/mission-4b-standard-evaluation.md
	docs/video-os/pip-compile-stall-diagnosis.md
	docs/video-os/receipts/additional-worktree-audit-2026-09-02.md
	docs/video-os/receipts/architecture/
	docs/video-os/receipts/discovery/
	docs/video-os/receipts/evaluation/
	docs/video-os/receipts/implementation/
	docs/video-os/receipts/incidents/
	docs/video-os/receipts/mission-governance-remediation-executed.md
	docs/video-os/receipts/mission-rebase-audit.md
	docs/video-os/risk-register.md
	docs/video-os/spec-rebase-delta.md
	docs/video-os/wav2lip-checksum-mismatch-diagnosis.md
	drizzle/0005_video_os_core_foundation.sql
	drizzle/meta/0005_snapshot.json
	lib/video-os-governance.js
	lib/video-os-job-state.js
	services/musetalk-runpod.js
	services/musetalk-stub.js
	tests/job-contract.state.test.mjs
	tests/job-contract.validation.test.mjs
	tests/job-contract.workflow.test.mjs
	tests/m4-api-contract.test.mjs
	tests/m4-governance-tools.test.mjs
	tests/m4-governance.test.mjs
	tests/m5-musetalk-stub.test.mjs
	tests/m5-worker.contract.test.mjs
	tests/m5-workflow-stub-contract.test.mjs
	tests/video-os-foundation-db.test.mjs
	tools/video-os-governance-preflight.mjs
	tools/video-os-traceability-check.mjs
	workers/musetalk/

no changes added to commit (use "git add" and/or "git commit -a")
```

## Appendix B — requested workflow/test diff (verbatim)

Command: `git diff HEAD -- workflows/video-render.js job-contract.workflow.test.mjs`

The command names a nonexistent root-level test path, so the verbatim output contains only `workflows/video-render.js`:

```diff
warning: in the working copy of 'workflows/video-render.js', LF will be replaced by CRLF the next time Git touches it
diff --git a/workflows/video-render.js b/workflows/video-render.js
index e514ff6..4eb7c9f 100644
--- a/workflows/video-render.js
+++ b/workflows/video-render.js
@@ -4,7 +4,11 @@ import { featureEnabled, requireRenderAccountAuthorization } from '../lib/video-
 import { assertTalentSelectionsAvailable, loadTalentInventory } from '../api/video-os/talent.js';
 import { classifyFailure } from '../lib/video-os-operations.js';
 import { captureJobError } from '../lib/video-os-observability.js';
+import { assertRenderTierEnabled, buildProviderAttempt, normalizeProviderPollLifecycle } from '../lib/video-os-job-state.js';
+import { normalizeJobRenderRequest } from '../lib/video-os-validation.js';
 import { pollHeygen, submitHeygen } from '../services/heygen.js';
+import { pollMusetalkStubJob, submitMusetalkStubJob } from '../services/musetalk-stub.js';
+import { pollSadtalkerStageALocal, submitSadtalkerStageALocal } from '../services/sadtalker-runpod.js';
 import { finishMedia } from '../services/media-finisher.js';
 import { finishMediaWithHyperframes } from '../services/hyperframes-finisher.js';
 
@@ -22,10 +26,27 @@ async function submitProvider(jobId) {
   if (!job) throw new FatalError('Video job not found.');
   if (job.providerJobId) return { providerJobId: job.providerJobId };
   if (job.status === 'provider_submitting' || job.status === 'provider_submit_unknown') throw Object.assign(new FatalError('Provider submission requires reconciliation.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
+  const renderContract = normalizeJobRenderRequest(job);
+  assertRenderTierEnabled(renderContract.tier);
+  if (renderContract.adapter !== 'premium-heygen' && !isMusetalkStub(renderContract) && !isSadtalkerStageA(renderContract)) {
+    throw Object.assign(new FatalError(`Render adapter ${renderContract.adapter} is not implemented in the hosted workflow.`), { failureCategory: 'FEATURE_DISABLED' });
+  }
+  const submitAttempt = buildProviderAttempt(job, { phase: 'submit' });
+  let providerMayHaveReceivedRequest = false;
   try {
-    await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started' });
+    await transitionJob({
+      jobId,
+      stageTo: 'provider_submitting',
+      eventType: 'provider.submit_started',
+      details: {
+        tier: renderContract.tier,
+        adapter: renderContract.adapter,
+        attempt: submitAttempt.attempt,
+        attemptCorrelationId: submitAttempt.attemptCorrelationId,
+      },
+    });
     let submissionInput = job.input;
-    if (!job.input?.identityId) {
+    if (renderContract.adapter === 'premium-heygen' && !job.input?.identityId) {
       requireRenderAccountAuthorization(job.accountId);
       const inventory = await loadTalentInventory();
       const { providerSelections } = assertTalentSelectionsAvailable(inventory.talent, job.input);
@@ -35,25 +56,110 @@ async function submitProvider(jobId) {
         voice: { ...job.input.voice, voiceId: providerSelections.voiceId },
       };
     }
-    const submitted = await submitHeygen({ ...job, input: submissionInput });
-    await transitionJob({ jobId, stageTo: 'provider_submitted', eventType: 'provider.submitted', providerJobId: submitted.providerJobId });
+    providerMayHaveReceivedRequest = true;
+    const submitted = renderContract.adapter === 'premium-heygen'
+      ? await submitHeygen({ ...job, input: submissionInput })
+      : isSadtalkerStageA(renderContract)
+        ? await submitSadtalkerStageALocal(sadtalkerStageAPayload(job))
+        : submitMusetalkStubJob(musetalkStubPayload(job), { scenario: job.input?.musetalkStubScenario });
+    const submittedAttempt = buildProviderAttempt({ ...job, providerJobId: submitted.providerJobId }, { phase: 'poll', providerJobId: submitted.providerJobId });
+    await transitionJob({
+      jobId,
+      stageTo: 'provider_submitted',
+      eventType: 'provider.submitted',
+      providerJobId: submitted.providerJobId,
+      details: {
+        tier: renderContract.tier,
+        adapter: renderContract.adapter,
+        attempt: submittedAttempt.attempt,
+        attemptCorrelationId: submittedAttempt.attemptCorrelationId,
+      },
+    });
     return submitted;
   } catch (error) {
-    captureJobError(error, { jobId, accountId: job.accountId, correlationId: job.correlationId, stage: 'provider_submit', failureCategory: classifyFailure(error, 'PROVIDER_SUBMIT') });
-    await transitionJob({ jobId, stageTo: 'provider_submit_unknown', eventType: 'provider.submit_unknown', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
+    if (!providerMayHaveReceivedRequest) throw error;
+    captureJobError(error, {
+      jobId,
+      accountId: job.accountId,
+      correlationId: job.correlationId,
+      stage: 'provider_submit',
+      attempt: submitAttempt.attempt,
+      failureCategory: classifyFailure(error, 'PROVIDER_SUBMIT'),
+    });
+    await transitionJob({
+      jobId,
+      stageTo: 'provider_submit_unknown',
+      eventType: 'provider.submit_unknown',
+      failureCategory: 'PROVIDER_SUBMIT_UNKNOWN',
+      details: {
+        attempt: submitAttempt.attempt,
+        attemptCorrelationId: submitAttempt.attemptCorrelationId,
+      },
+    });
     throw Object.assign(new FatalError('Provider submission outcome is uncertain; automatic resubmission is blocked to prevent duplicate charges.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
   }
 }
 
+function isMusetalkStub(renderContract) {
+  return renderContract.adapter === 'standard-musetalk-stub';
+}
+
+function isSadtalkerStageA(renderContract) {
+  return renderContract.adapter === 'standard-sadtalker-local';
+}
+
+function sadtalkerStageAPayload(job) {
+  return { jobId: job.id, accountId: job.accountId, correlationId: job.correlationId, portrait: job.input?.portrait, drivenAudio: job.input?.drivenAudio };
+}
+
+function musetalkStubPayload(job) {
+  return { jobId: job.id, correlationId: job.correlationId, accountId: job.accountId, idempotencyKey: job.idempotencyKey || job.id, attempt: Number(job.output?.providerAttempt?.attempt || 1), portrait: job.input?.avatar || { id: job.input?.identityId }, audio: job.input?.drivenAudio };
+}
+
+function normalizeMusetalkStubStatus(event) {
+  return { status: event.providerStatus, ready: event.normalizedStatus === 'SUCCEEDED', failed: event.normalizedStatus === 'FAILED_FINAL', sourceUrl: event.outputUrl, error: event.error };
+}
+
 async function pollProvider(jobId, providerJobId) {
   'use step';
   const job = await getJob(jobId);
   if (!job) throw new FatalError('Video job not found.');
-  const status = await pollHeygen(providerJobId);
+  const renderContract = normalizeJobRenderRequest(job);
+  const pollAttempt = buildProviderAttempt({ ...job, providerJobId }, { phase: 'poll', providerJobId });
+  const status = renderContract.adapter === 'premium-heygen'
+    ? await pollHeygen(providerJobId)
+    : isSadtalkerStageA(renderContract)
+      ? pollSadtalkerStageALocal(providerJobId)
+      : normalizeMusetalkStubStatus(pollMusetalkStubJob(providerJobId));
+  if (status.failed) throw Object.assign(new FatalError(status.error?.message || 'Standard render failed.'), { failureCategory: 'PROVIDER_FAILED_FINAL' });
   if (['provider_ready', 'finishing'].includes(job.status) && status.ready) return status;
   if (['provider_ready', 'finishing'].includes(job.status)) throw Object.assign(new FatalError('Provider state regressed after media became ready.'), { failureCategory: 'RECONCILIATION' });
-  if (!status.ready) await transitionJob({ jobId, stageTo: 'provider_rendering', eventType: 'provider.polled', details: { providerStatus: status.status } });
-  else await transitionJob({ jobId, stageTo: 'provider_ready', eventType: 'provider.ready' });
+  const normalizedStatus = normalizeProviderPollLifecycle(status);
+  if (!status.ready) await transitionJob({
+    jobId,
+    stageTo: 'provider_rendering',
+    eventType: 'provider.polled',
+    details: {
+      providerStatus: status.status,
+      normalizedStatus,
+      tier: renderContract.tier,
+      adapter: renderContract.adapter,
+      attempt: pollAttempt.attempt,
+      attemptCorrelationId: pollAttempt.attemptCorrelationId,
+    },
+  });
+  else await transitionJob({
+    jobId,
+    stageTo: 'provider_ready',
+    eventType: 'provider.ready',
+    details: {
+      normalizedStatus,
+      tier: renderContract.tier,
+      adapter: renderContract.adapter,
+      attempt: pollAttempt.attempt,
+      attemptCorrelationId: pollAttempt.attemptCorrelationId,
+    },
+  });
   return status;
 }
```

## Appendix C — actual untracked workflow-test patch

```diff
diff --git a/tests/job-contract.workflow.test.mjs b/tests/job-contract.workflow.test.mjs
new file mode 100644
index 0000000..202954d
--- /dev/null
+++ b/tests/job-contract.workflow.test.mjs
@@ -0,0 +1,13 @@
+import assert from 'node:assert/strict';
+import { readFile } from 'node:fs/promises';
+import test from 'node:test';
+
+test('video render workflow applies the normalized tier contract and attempt metadata', async () => {
+  const source = await readFile(new URL('../workflows/video-render.js', import.meta.url), 'utf8');
+  assert.match(source, /normalizeJobRenderRequest/);
+  assert.match(source, /assertRenderTierEnabled\(renderContract\.tier\)/);
+  assert.match(source, /buildProviderAttempt\(job, \{ phase: 'submit' \}\)/);
+  assert.match(source, /attemptCorrelationId: submitAttempt\.attemptCorrelationId/);
+  assert.match(source, /providerMayHaveReceivedRequest = true;\s+const submitted = await submitHeygen/s);
+  assert.match(source, /normalizedStatus,/);
+});
```

## Appendix D — workflow commit history (verbatim)

```text
3c65dc0d853ff1081385c76459306cf7368ae749 2026-08-07T11:38:19-04:00 Keep HyperFrames composition behind a Preview gate
b2da4d43ad70de57b69626c1cc4f4662ba5a0695 2026-07-24T14:22:02-04:00 Preserve secure foundations while reconciling Identity Studio
d659806203f6129b8a9004d41839fc48fc1a79f1 2026-07-22T14:30:57-04:00 fix: protect provider inventory and server-resolve featured cast
bcf782efc00b34007a6a51af91bff59f71bccad0 2026-07-16T13:55:49-04:00 Recover the existing provider result without duplicate billing
586c8c10b933b5ded24270ab278e44b6128528ef 2026-07-15T14:42:51-04:00 Establish a controlled baseline before production containment
```

## Evidence/inference boundary

- **Evidence:** direct source, Git object, test-run, status/diff, and filesystem-timestamp observations are identified above.
- **Inference:** the exact keystroke-level edit sequence is not recoverable from Git because the workflow changes are uncommitted. The provenance split is nevertheless high-confidence because the pre-worker committed re-audit records the MuseTalk branch before Stage-A worker implementation, while the Stage-A receipt and timestamp window identify the later SadTalker overlay.
- **Unknown:** no repository artifact proves how a future L2 environment would be provisioned or which adapter value its caller would submit. The state-specific outcomes above cover each code-supported case without assuming that operational choice.
