import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createStandardContractHandler } from '../routes/video-os-lite/standard.js';
import { createScriptedPhotoHandler } from '../routes/video-os-lite/scripted-photo.js';
import {
  STANDARD_CONTRACT_VERSION,
  STANDARD_NARRATION_POLICY_VERSION,
} from '../lib/standard-narration-contract.js';
import { verifyScriptedPhotoQuote } from '../lib/scripted-photo-quote.js';

const ORIGIN = 'https://video.example';
const ACCOUNT_ID = 'core-release-owner';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const IDENTITY_ID = '22222222-2222-4222-8222-222222222222';
const AUDIO_ID = '33333333-3333-4333-8333-333333333333';
const CONSENT_ID = '44444444-4444-4444-8444-444444444444';
const QUOTE_ID = '55555555-5555-4555-8555-555555555555';
const IDEMPOTENCY_KEY = '66666666-6666-4666-8666-666666666666';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(raw) { this.body = raw ? JSON.parse(raw) : null; },
  };
}

function request(method, body, url = '/api/video-os-lite/standard') {
  return {
    method,
    url,
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body,
  };
}

test('core Standard route keeps consent, quote, withdrawal, and account authority server-bound', async (t) => {
  t.mock.method(console, 'error', () => {});
  const previousOrigin = process.env.VIDEO_OS_PUBLIC_ORIGIN;
  process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.VIDEO_OS_PUBLIC_ORIGIN;
    else process.env.VIDEO_OS_PUBLIC_ORIGIN = previousOrigin;
  });

  let withdrawn = false;
  const calls = { consent: [], quote: [], revoke: [] };
  const repository = {
    async grantConsent(actor, owner, payload) {
      calls.consent.push({ actor, owner, payload });
      return {
        id: CONSENT_ID,
        projectId: payload.projectId,
        identityId: payload.identityId,
        audioAssetId: payload.audioAssetId,
        policyVersion: payload.policyVersion,
        grantedAt: new Date('2026-10-08T14:00:00.000Z'),
        privateEvidenceRef: 'must-never-reach-the-browser',
      };
    },
    async createQuote(actor, owner, payload) {
      calls.quote.push({ actor, owner, payload });
      if (withdrawn) {
        throw Object.assign(new Error('Narration consent was withdrawn.'), {
          statusCode: 409,
          code: 'standard_narration_consent_invalid',
          failureCategory: 'CONSENT',
        });
      }
      return {
        id: QUOTE_ID,
        contractVersion: STANDARD_CONTRACT_VERSION,
        projectId: payload.projectId,
        identityId: payload.identityId,
        audioAssetId: payload.audioAssetId,
        narrationConsentId: payload.narrationConsentId,
        policyVersion: STANDARD_NARRATION_POLICY_VERSION,
        pricingVersion: 'standard-narration-pricing-v1-proposed',
        format: payload.format,
        credits: 90,
        createdAt: new Date('2026-10-08T14:01:00.000Z'),
        expiresAt: new Date('2026-10-08T14:06:00.000Z'),
        privateQuoteDigest: 'must-never-reach-the-browser',
      };
    },
    async revokeConsent(actor, owner, payload) {
      calls.revoke.push({ actor, owner, payload });
      withdrawn = true;
      return {
        id: payload.consentId,
        projectId: PROJECT_ID,
        identityId: IDENTITY_ID,
        audioAssetId: AUDIO_ID,
        policyVersion: STANDARD_NARRATION_POLICY_VERSION,
        revokedAt: new Date('2026-10-08T14:02:00.000Z'),
      };
    },
  };
  const handler = createStandardContractHandler({
    authenticate: () => ({ accountId: ACCOUNT_ID }),
    repository,
  });

  const consentBody = {
    operation: 'consent',
    contractVersion: STANDARD_CONTRACT_VERSION,
    projectId: PROJECT_ID,
    identityId: IDENTITY_ID,
    audioAssetId: AUDIO_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    policyVersion: STANDARD_NARRATION_POLICY_VERSION,
    consent: true,
  };
  const consent = response();
  await handler(request('POST', consentBody), consent);
  assert.equal(consent.statusCode, 201);
  assert.equal(consent.body.consent.id, CONSENT_ID);
  assert.equal(Object.hasOwn(consent.body.consent, 'privateEvidenceRef'), false);
  assert.deepEqual(calls.consent[0], {
    actor: ACCOUNT_ID,
    owner: ACCOUNT_ID,
    payload: {
      projectId: PROJECT_ID,
      identityId: IDENTITY_ID,
      audioAssetId: AUDIO_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      policyVersion: STANDARD_NARRATION_POLICY_VERSION,
      consent: true,
    },
  });

  const quoteBody = {
    operation: 'quote',
    contractVersion: STANDARD_CONTRACT_VERSION,
    projectId: PROJECT_ID,
    identityId: IDENTITY_ID,
    audioAssetId: AUDIO_ID,
    narrationConsentId: CONSENT_ID,
    format: 'vertical',
  };
  const quote = response();
  await handler(request('POST', quoteBody), quote);
  assert.equal(quote.statusCode, 201);
  assert.equal(quote.body.quote.credits, 90);
  assert.equal(Object.hasOwn(quote.body.quote, 'privateQuoteDigest'), false);
  assert.deepEqual(calls.quote[0], {
    actor: ACCOUNT_ID,
    owner: ACCOUNT_ID,
    payload: {
      projectId: PROJECT_ID,
      identityId: IDENTITY_ID,
      audioAssetId: AUDIO_ID,
      narrationConsentId: CONSENT_ID,
      format: 'vertical',
    },
  });

  const revoke = response();
  await handler(request('POST', {
    operation: 'revoke',
    contractVersion: STANDARD_CONTRACT_VERSION,
    consentId: CONSENT_ID,
  }), revoke);
  assert.equal(revoke.statusCode, 200);
  assert.equal(revoke.body.consent.revokedAt, '2026-10-08T14:02:00.000Z');
  assert.deepEqual(calls.revoke[0], {
    actor: ACCOUNT_ID,
    owner: ACCOUNT_ID,
    payload: { consentId: CONSENT_ID },
  });

  const withdrawnQuote = response();
  await handler(request('POST', quoteBody), withdrawnQuote);
  assert.equal(withdrawnQuote.statusCode, 409);
  assert.equal(withdrawnQuote.body.code, 'standard_narration_consent_invalid');
  assert.equal(withdrawnQuote.body.quote, undefined);

  const clientOwnedAccount = response();
  await handler(request('POST', { ...quoteBody, accountId: 'another-account' }), clientOwnedAccount);
  assert.equal(clientOwnedAccount.statusCode, 400);
  assert.equal(calls.quote.length, 2, 'a browser account field must be rejected before repository access');
});

test('core Premium quote binds the owned presenter, voice, script, consent readback, and server price', async (t) => {
  t.mock.method(console, 'error', () => {});
  const secret = 'core-release-premium-quote-secret-at-least-32-bytes';
  const title = 'Core Premium presenter proof';
  const script = 'This exact Premium script is bound to the saved presenter and voice.';
  const sourceBinding = {
    consentId: CONSENT_ID,
    photoSha256: 'a'.repeat(64),
    voiceSha256: 'b'.repeat(64),
    providerAvatarGroupId: 'private-avatar-group',
    providerRenderableAvatarId: 'private-avatar-look',
    providerVoiceId: 'private-instant-voice',
  };
  const project = {
    id: PROJECT_ID,
    accountId: ACCOUNT_ID,
    identityId: IDENTITY_ID,
    title,
    script,
    settings: { contractVersion: 'scripted-photo-v1', tier: 'PREMIUM', format: 'landscape' },
    createdAt: new Date('2026-10-08T14:00:00.000Z'),
    updatedAt: new Date('2026-10-08T14:01:00.000Z'),
  };
  const calls = { authorize: [], context: [], providerRead: [], providerStatus: [] };
  let withdrawn = false;
  const handler = createScriptedPhotoHandler({
    authenticate: () => ({ accountId: ACCOUNT_ID, email: 'owner@example.test' }),
    environment: { VIDEO_OS_PUBLIC_ORIGIN: ORIGIN, VIDEO_OS_SCRIPTED_PHOTO_ENABLED: 'true' },
    rateLimit: async () => true,
    getProject: async () => project,
    authorizeTier: async (owner, tier) => { calls.authorize.push({ owner, tier }); },
    getReservationContext: async input => {
      calls.context.push(input);
      if (withdrawn) {
        throw Object.assign(new Error('Presenter consent was withdrawn.'), {
          statusCode: 409,
          code: 'provider_consent_withdrawn',
          failureCategory: 'CONSENT',
        });
      }
      return {
        project,
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
    recoverExistingJob: async () => null,
    resolveProviderBinding: async ({ accountId }) => ({
      applicationAccountId: accountId,
      bindingId: 'verified-binding',
      originScopeKey: 'c'.repeat(64),
      verifiedAccountScopeId: 'verified-account-scope',
    }),
    prepareProviderRead: async input => {
      calls.providerRead.push(input);
      return {
        accountId: ACCOUNT_ID,
        identityId: IDENTITY_ID,
        component: 'avatar',
        providerAvatarGroupId: sourceBinding.providerAvatarGroupId,
        providerRenderableAvatarId: sourceBinding.providerRenderableAvatarId,
      };
    },
    readProviderAvatarStatus: async input => {
      calls.providerStatus.push(input);
      return {
        ready: true,
        avatarGroup: {
          providerGroupId: sourceBinding.providerAvatarGroupId,
          status: 'completed',
          consentStatus: 'accepted',
          ready: true,
        },
        avatarLook: {
          providerLookId: sourceBinding.providerRenderableAvatarId,
          providerGroupId: sourceBinding.providerAvatarGroupId,
          avatarType: 'photo_avatar',
          status: 'completed',
          ready: true,
        },
      };
    },
    providerObservationNow: () => Date.parse('2026-10-08T14:02:00.000Z'),
    quoteOptions: {
      secret,
      now: Date.parse('2026-10-08T14:02:00.000Z'),
      nonce: 'core-release-premium-nonce',
    },
  });
  const quoteRequest = {
    action: 'quote',
    projectId: PROJECT_ID,
    tier: 'PREMIUM',
    format: 'landscape',
    idempotencyKey: IDEMPOTENCY_KEY,
  };
  const quote = response();
  await handler(request('POST', quoteRequest, '/api/video-os-lite/scripted-photo'), quote);
  assert.equal(quote.statusCode, 201, JSON.stringify(quote.body));
  assert.equal(quote.body.quote.credits, 90);
  assert.equal(quote.body.project.tier, 'PREMIUM');
  assert.equal(quote.body.project.provider, undefined);
  assert.equal(quote.body.project.sourceBinding, undefined);
  assert.deepEqual(calls.authorize, [{ owner: ACCOUNT_ID, tier: 'premium' }]);
  assert.deepEqual(calls.context, [{
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    identityId: IDENTITY_ID,
    title,
    script,
    tier: 'PREMIUM',
  }]);
  assert.deepEqual(calls.providerStatus, [{
    groupId: sourceBinding.providerAvatarGroupId,
    lookId: sourceBinding.providerRenderableAvatarId,
  }]);
  assert.doesNotMatch(quote.body.quote.token, /private-avatar|private-instant-voice/);
  assert.doesNotThrow(() => verifyScriptedPhotoQuote(quote.body.quote.token, {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    identityId: IDENTITY_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    title,
    script,
    format: 'landscape',
    tier: 'PREMIUM',
    sourceBinding,
    credits: 90,
  }, { secret, now: Date.parse('2026-10-08T14:03:00.000Z') }));

  withdrawn = true;
  const withdrawnQuote = response();
  await handler(request('POST', { ...quoteRequest, idempotencyKey: randomUUID() }, '/api/video-os-lite/scripted-photo'), withdrawnQuote);
  assert.equal(withdrawnQuote.statusCode, 409);
  assert.equal(withdrawnQuote.body.code, 'provider_consent_withdrawn');
  assert.equal(withdrawnQuote.body.quote, undefined);
  assert.equal(calls.providerRead.length, 1, 'withdrawal must fail before provider readback');
});

test('core render routes preserve reservations across uncertain dispatch and never invoke a provider', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks',
    'tests/core-release-render-route-scenario.mjs',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      DATABASE_URL: '',
      DATABASE_URL_UNPOOLED: '',
      BLOB_READ_WRITE_TOKEN: '',
      HEYGEN_API_KEY: '',
      HEYGEN_TOKEN: '',
      RUNPOD_API_KEY: '',
      VIDEO_OS_RUNPOD_ENDPOINT_ID: '',
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
