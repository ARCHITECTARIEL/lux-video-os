import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';

const ORIGIN = 'https://video.example';
const ACCOUNT_ID = 'core-release-render-owner';
const OTHER_ACCOUNT_ID = 'core-release-other-owner';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const IDENTITY_ID = '22222222-2222-4222-8222-222222222222';
const AUDIO_ID = '33333333-3333-4333-8333-333333333333';
const CONSENT_ID = '44444444-4444-4444-8444-444444444444';
const STANDARD_QUOTE_ID = '55555555-5555-4555-8555-555555555555';
const SESSION_SECRET = 'core-release-render-session-secret-at-least-32-bytes';

const title = 'Core Premium render proof';
const script = 'This exact Premium script is reserved once and dispatched without provider access.';
const sourceBinding = Object.freeze({
  consentId: CONSENT_ID,
  photoSha256: 'a'.repeat(64),
  voiceSha256: 'b'.repeat(64),
  providerAvatarGroupId: 'private-avatar-group',
  providerRenderableAvatarId: 'private-avatar-look',
  providerVoiceId: 'private-instant-voice',
});
const providerBinding = Object.freeze({
  applicationAccountId: ACCOUNT_ID,
  bindingId: 'verified-binding',
  originScopeKey: 'c'.repeat(64),
  verifiedAccountScopeId: 'verified-account-scope',
});

let externalFetches = 0;
globalThis.fetch = async () => {
  externalFetches += 1;
  throw new Error('External provider transport is forbidden in the core release fixture.');
};

const jobsByKey = new Map();
const jobsById = new Map();
const standardJobsByKey = new Map();
const calls = {
  authorizations: [],
  premiumReservations: [],
  standardReservations: [],
  providerReads: 0,
  workflowStarts: 0,
  releases: 0,
  capturedErrors: 0,
};
let premiumConsentWithdrawn = false;
let standardConsentWithdrawn = false;
let failWorkflowStart = false;

function failure(message, statusCode, code, failureCategory) {
  return Object.assign(new Error(message), { statusCode, code, failureCategory });
}

mock.module('../db/dto.js', {
  namedExports: {
    accountDto: account => ({ account: { accountId: account.accountId }, credits: account.credits }),
    jobDto: job => ({
      id: job.id,
      title: job.title,
      tier: job.tier,
      status: job.status,
      stage: job.status,
      outputAccepted: false,
      url: null,
      format: job.format,
    }),
  },
});

mock.module('../db/repositories.js', {
  namedExports: {
    consumeRateLimit: async () => true,
    requirePersistedRenderAuthorization: async (accountId, tier) => {
      calls.authorizations.push({ accountId, tier });
      if (accountId !== ACCOUNT_ID) throw failure('Render authority is not owned by this account.', 403, 'render_not_authorized', 'AUTH_FORBIDDEN');
      return true;
    },
    ensureAccount: async ({ accountId }) => ({ accountId, credits: { balance: 500, reserved: 0 } }),
    getOwnedProject: async () => null,
    getRenderAuthorizedIdentity: async () => null,
    getOwnedScriptedPhotoJobByIdempotency: async intent => {
      const job = jobsByKey.get(intent.idempotencyKey) || null;
      if (!job || job.accountId !== intent.accountId) return null;
      const exact = job.input.projectId === intent.projectId
        && job.input.tier === intent.tier
        && job.input.identityId === intent.identityId
        && job.title === intent.title
        && job.input.script === intent.script
        && job.format === intent.format;
      if (!exact) throw failure('Existing render intent does not match.', 409, 'recovery_binding_mismatch', 'RECONCILIATION');
      return job;
    },
    getScriptedPhotoReservationContext: async ({ accountId, projectId, identityId, title: requestedTitle, script: requestedScript, tier }) => {
      assert.equal(accountId, ACCOUNT_ID);
      assert.equal(projectId, PROJECT_ID);
      assert.equal(identityId, IDENTITY_ID);
      assert.equal(requestedTitle, title);
      assert.equal(requestedScript, script);
      assert.equal(tier, 'PREMIUM');
      if (premiumConsentWithdrawn) throw failure('Presenter consent was withdrawn.', 409, 'provider_consent_withdrawn', 'CONSENT');
      return {
        project: {
          id: PROJECT_ID,
          accountId: ACCOUNT_ID,
          identityId: IDENTITY_ID,
          title,
          script,
          settings: { contractVersion: 'scripted-photo-v1', tier: 'PREMIUM', format: 'landscape' },
        },
        identity: { id: IDENTITY_ID },
        input: {
          contractVersion: 'scripted-photo-v1',
          tier: 'PREMIUM',
          projectId: PROJECT_ID,
          identityId: IDENTITY_ID,
          script,
          avatar: { avatarId: sourceBinding.providerRenderableAvatarId },
          voice: { voiceId: sourceBinding.providerVoiceId },
          sourceBinding,
        },
      };
    },
    prepareIdentityProviderRead: async ({ accountId, identityId, component, providerBinding: binding }) => {
      calls.providerReads += 1;
      assert.equal(accountId, ACCOUNT_ID);
      assert.equal(identityId, IDENTITY_ID);
      assert.equal(component, 'avatar');
      assert.equal(binding, providerBinding);
      return Object.freeze({
        accountId,
        identityId,
        component,
        providerAvatarGroupId: sourceBinding.providerAvatarGroupId,
        providerRenderableAvatarId: sourceBinding.providerRenderableAvatarId,
      });
    },
    reserveRender: async input => {
      calls.premiumReservations.push(input);
      assert.equal(input.accountId, ACCOUNT_ID);
      assert.equal(input.provider, 'heygen');
      assert.equal(input.tier, 'premium');
      assert.equal(input.costCredits, 90);
      assert.deepEqual(input.input, {
        contractVersion: 'scripted-photo-v1',
        tier: 'PREMIUM',
        projectId: PROJECT_ID,
        identityId: IDENTITY_ID,
        script,
      });
      assert.equal(input.providerAvatarConsentObservation.accountId, ACCOUNT_ID);
      assert.equal(input.providerAvatarConsentObservation.identityId, IDENTITY_ID);
      const job = {
        id: input.jobId,
        accountId: input.accountId,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        provider: input.provider,
        tier: input.tier,
        title: input.title,
        format: input.format,
        costCredits: input.costCredits,
        status: 'reserved',
        workflowRunId: null,
        input: {
          contractVersion: 'scripted-photo-v1',
          tier: 'PREMIUM',
          projectId: PROJECT_ID,
          identityId: IDENTITY_ID,
          script,
          avatar: { avatarId: sourceBinding.providerRenderableAvatarId },
          voice: { voiceId: sourceBinding.providerVoiceId },
          sourceBinding,
        },
      };
      jobsByKey.set(input.idempotencyKey, job);
      jobsById.set(job.id, job);
      return { job, replayed: false };
    },
    claimWorkflowStart: async jobId => {
      const job = jobsById.get(jobId);
      if (!job || job.status !== 'reserved') return null;
      job.status = 'workflow_started';
      return job;
    },
    getJob: async jobId => jobsById.get(jobId) || null,
    setWorkflowRun: async (jobId, runId) => {
      const job = jobsById.get(jobId);
      if (!job) return null;
      job.workflowRunId = runId;
      return job;
    },
    markJobFailedAndRelease: async () => { calls.releases += 1; },
  },
});

mock.module('../db/heygen-space-binding-repository.js', {
  namedExports: {
    resolveFreshHeygenSpaceBinding: async ({ accountId }) => {
      assert.equal(accountId, ACCOUNT_ID);
      return providerBinding;
    },
  },
});

mock.module('../db/standard-narration-repository.js', {
  namedExports: {
    standardNarrationRepository: {
      async reserveRender(input) {
        if (standardConsentWithdrawn) {
          throw failure('Narration consent was withdrawn.', 409, 'standard_narration_consent_invalid', 'CONSENT');
        }
        const existing = standardJobsByKey.get(input.idempotencyKey);
        if (existing) return { job: existing, replayed: true };
        calls.standardReservations.push(input);
        const job = {
          id: input.jobId,
          accountId: input.accountId,
          idempotencyKey: input.idempotencyKey,
          correlationId: input.correlationId,
          provider: 'sadtalker',
          tier: 'standard',
          title: input.title,
          format: input.format,
          costCredits: 90,
          status: 'reserved',
          workflowRunId: null,
          input: input.input,
        };
        standardJobsByKey.set(input.idempotencyKey, job);
        jobsById.set(job.id, job);
        return { job, replayed: false };
      },
    },
  },
});

mock.module('../api/video-os/talent.js', {
  namedExports: {
    assertTalentSelectionsAvailable: () => true,
    loadTalentInventory: async () => ({ avatars: [], voices: [] }),
  },
});

mock.module('../lib/video-os-observability.js', {
  namedExports: {
    captureJobError: () => { calls.capturedErrors += 1; },
  },
});

mock.module('../services/heygen.js', {
  namedExports: {
    getHeygenPhotoAvatarStatus: async ({ groupId, lookId }) => {
      assert.equal(groupId, sourceBinding.providerAvatarGroupId);
      assert.equal(lookId, sourceBinding.providerRenderableAvatarId);
      return {
        ready: true,
        avatarGroup: {
          providerGroupId: groupId,
          status: 'completed',
          consentStatus: 'accepted',
          ready: true,
        },
        avatarLook: {
          providerLookId: lookId,
          providerGroupId: groupId,
          avatarType: 'photo_avatar',
          status: 'completed',
          ready: true,
        },
      };
    },
  },
});

mock.module('workflow/api', {
  namedExports: {
    start: async (_metadata, [jobId]) => {
      calls.workflowStarts += 1;
      if (failWorkflowStart) throw new Error('synthetic workflow acknowledgement loss');
      return { runId: `run-${jobId}` };
    },
  },
});

process.env.VIDEO_OS_SESSION_SECRET = SESSION_SECRET;
process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
process.env.VIDEO_OS_DURABLE_WORKFLOW_ENABLED = 'true';
process.env.VIDEO_OS_SCRIPTED_PHOTO_ENABLED = 'true';
process.env.VIDEO_OS_STANDARD_NARRATION_SCHEMA_READY = 'true';
process.env.VIDEO_OS_STANDARD_NARRATION_POLICY_APPROVED = 'true';
process.env.VIDEO_OS_STANDARD_NARRATION_PRICING_APPROVED = 'true';
process.env.VIDEO_OS_STANDARD_RENDER_ENABLED = 'true';
process.env.WORKFLOW_DISPATCH_MODE = 'poll';

const { makeSession } = await import('../lib/video-os-account.js');
const { issueScriptedPhotoQuote } = await import('../lib/scripted-photo-quote.js');
const { default: renderHandler } = await import('../api/video-os-lite/render-v2.js');

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(raw) { this.body = raw ? JSON.parse(raw) : null; },
  };
}

async function call(body, accountId = ACCOUNT_ID) {
  const req = {
    method: 'POST',
    headers: {
      cookie: `vos_session=${makeSession(accountId, `${accountId}@example.test`)}`,
      origin: ORIGIN,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  };
  const res = response();
  await renderHandler(req, res);
  return res;
}

function premiumBody(idempotencyKey = randomUUID()) {
  const binding = {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    identityId: IDENTITY_ID,
    idempotencyKey,
    title,
    script,
    format: 'landscape',
    tier: 'PREMIUM',
    sourceBinding,
    credits: 90,
  };
  return {
    contractVersion: 'scripted-photo-v1',
    tier: 'PREMIUM',
    projectId: PROJECT_ID,
    identityId: IDENTITY_ID,
    idempotencyKey,
    quoteToken: issueScriptedPhotoQuote(binding).token,
    title,
    script,
    format: 'landscape',
  };
}

function standardBody(idempotencyKey = randomUUID()) {
  return {
    tier: 'STANDARD',
    contractVersion: 'standard-narration-v1',
    quoteId: STANDARD_QUOTE_ID,
    narrationConsentId: CONSENT_ID,
    projectId: PROJECT_ID,
    identityId: IDENTITY_ID,
    audioReference: { assetId: AUDIO_ID },
    idempotencyKey,
    title: 'Core Standard narration proof',
    format: 'vertical',
  };
}

const standard = standardBody();
const standardAccepted = await call(standard);
assert.equal(standardAccepted.statusCode, 202, JSON.stringify(standardAccepted.body));
assert.equal(standardAccepted.body.status, 'workflow_started');
assert.equal(calls.standardReservations.length, 1);
assert.deepEqual(calls.standardReservations[0].input, {
  contractVersion: 'standard-narration-v1',
  quoteId: STANDARD_QUOTE_ID,
  narrationConsentId: CONSENT_ID,
  projectId: PROJECT_ID,
  identityId: IDENTITY_ID,
  audioReference: { assetId: AUDIO_ID },
  initiatingUser: ACCOUNT_ID,
});
const standardReplay = await call(standard);
assert.equal(standardReplay.statusCode, 200);
assert.equal(calls.standardReservations.length, 1, 'Standard replay must not create a second reservation');

standardConsentWithdrawn = true;
const standardWithdrawn = await call(standardBody());
assert.equal(standardWithdrawn.statusCode, 409);
assert.equal(standardWithdrawn.body.code, 'standard_narration_consent_invalid');
assert.equal(calls.standardReservations.length, 1);
standardConsentWithdrawn = false;

const premium = premiumBody();
const premiumAccepted = await call(premium);
assert.equal(premiumAccepted.statusCode, 202, JSON.stringify(premiumAccepted.body));
assert.equal(premiumAccepted.body.status, 'workflow_started');
assert.equal(calls.premiumReservations.length, 1);
assert.equal(calls.providerReads, 1);
const premiumReplay = await call(premium);
assert.equal(premiumReplay.statusCode, 200);
assert.equal(calls.premiumReservations.length, 1, 'Premium replay must not create a second reservation');
assert.equal(calls.providerReads, 1, 'Premium replay must not repeat provider consent readback');

premiumConsentWithdrawn = true;
const withdrawnPremium = await call(premiumBody());
assert.equal(withdrawnPremium.statusCode, 409);
assert.equal(withdrawnPremium.body.code, 'provider_consent_withdrawn');
assert.equal(calls.premiumReservations.length, 1);
premiumConsentWithdrawn = false;

const authorizationCount = calls.authorizations.length;
const wrongAccount = await call(premiumBody(), OTHER_ACCOUNT_ID);
assert.equal(wrongAccount.statusCode, 403);
assert.equal(calls.authorizations.length, authorizationCount + 1);
assert.equal(calls.premiumReservations.length, 1);

process.env.WORKFLOW_DISPATCH_MODE = 'vercel';
failWorkflowStart = true;
const capturedErrorsBeforeUncertainDispatch = calls.capturedErrors;
const uncertainPremiumBody = premiumBody();
const uncertainPremium = await call(uncertainPremiumBody);
assert.equal(uncertainPremium.statusCode, 202);
assert.equal(uncertainPremium.body.code, 'workflow_dispatch_uncertain');
assert.equal(calls.releases, 0, 'dispatch uncertainty must preserve the reservation');
assert.equal(calls.workflowStarts, 1);
const recoveredPremium = await call(uncertainPremiumBody);
assert.equal(recoveredPremium.statusCode, 200);
assert.equal(calls.workflowStarts, 1, 'recovery must not dispatch a second workflow');
assert.equal(calls.premiumReservations.length, 2, 'only the original and uncertain intents reserve');

assert.equal(calls.capturedErrors, capturedErrorsBeforeUncertainDispatch + 1);
assert.equal(externalFetches, 0, 'fixture route QA must never contact HeyGen or RunPod');
