import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreativeFinishRevisionService } from '../services/creative-finish-revision.js';

const NOW = Date.UTC(2026, 9, 14, 12);
const PROJECT = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const LOGO = '33333333-3333-4333-8333-333333333333';
const ENV = {
  VIDEO_OS_CREATIVE_FINISH_ENABLED: 'true',
  VIDEO_OS_CREATIVE_FINISH_ACCOUNT_ID: 'account-one',
  VIDEO_OS_CREATIVE_FINISH_REVISION_CREDITS: '7',
};

function selection() {
  return {
    version: 'creative-finish/v1',
    music: { assetId: 'licensed-track', mix: 'quiet', startMs: 500 },
    graphic: { templateId: 'clean-intro', headline: 'Owner approved headline', cta: '', logoAssetId: LOGO },
    color: { lutId: 'warm-look', strength: 50 },
    captions: 'none',
  };
}

function catalog() {
  return {
    revision: 'approved-catalog-v1',
    music: [{ id: 'licensed-track', status: 'approved', sha256: 'a'.repeat(64), licenseReceiptSha256: 'b'.repeat(64), allowedScopes: ['social'], durationMs: 10_000 }],
    graphics: [{ id: 'clean-intro', status: 'approved', sha256: 'c'.repeat(64), version: 'template-v1', formats: ['landscape'], maxHeadlineChars: 80, maxCtaChars: 40 }],
    logos: [{ id: LOGO, accountId: 'account-one', status: 'approved', sha256: 'd'.repeat(64) }],
    luts: [{ id: 'warm-look', status: 'approved', sha256: 'e'.repeat(64), version: 'lut-v1' }],
  };
}

function fixture() {
  const state = {
    project: { id: PROJECT, accountId: 'account-one', bindingSha256: '9'.repeat(64), mode: 'premium_presenter', format: 'landscape', distributionScope: 'social' },
    base: {
      accountId: 'account-one', projectId: PROJECT, sourceJobId: 'provider-job-one',
      projectMode: 'premium_presenter', acceptance: 'accepted', withdrawnAt: null,
      sha256: 'f'.repeat(64), privatePathname: 'video-os/creative-base/55555555-5555-4555-8555-555555555555.mp4',
    },
    catalog: catalog(),
    authorizationCalls: 0,
    reserveCalls: [],
    jobs: new Map(),
  };
  const repository = {
    async getProject() { return state.project; },
    async getRetainedBase() { return state.base; },
    async reserveRevisionAtomic(input) {
      state.reserveCalls.push(input);
      const prior = state.jobs.get(input.idempotencyKey);
      if (prior) {
        if (prior.selectionDigest !== input.selectionDigest || prior.sourceJobId !== input.sourceJobId) {
          throw Object.assign(new Error('Revision binding changed.'), { statusCode: 409 });
        }
        return prior;
      }
      const job = { id: 'finish-revision-one', status: 'reserved', accountId: input.accountId,
        projectId: input.projectId, idempotencyKey: input.idempotencyKey, sourceJobId: input.sourceJobId,
        selectionDigest: input.selectionDigest, mode: input.mode, privatePathname: input.basePrivatePathname };
      state.jobs.set(input.idempotencyKey, job);
      return job;
    },
    async findRevision({ idempotencyKey }) { return state.jobs.get(idempotencyKey) || null; },
  };
  const service = createCreativeFinishRevisionService({
    repository,
    catalogFor: async () => state.catalog,
    authorizePremium: async () => { state.authorizationCalls += 1; return {
      version: 1, accountId: 'account-one', tier: 'premium', entitlementKey: 'liveRendering',
    }; },
    environment: ENV,
    quoteOptions: { secret: 'synthetic-creative-finish-signing-secret-1234567890', now: NOW, nonce: 'synthetic-nonce-1234567890' },
  });
  return { state, service, repository };
}

const request = () => ({ projectId: PROJECT, sourceJobId: 'provider-job-one', idempotencyKey: KEY, selection: selection() });

test('held service issues a project-bound quote and passes only approved assets to atomic revision reservation', async () => {
  const { state, service } = fixture();
  const offered = await service.quoteRevision('account-one', request());
  assert.equal(offered.quote.credits, 7);
  assert.equal(offered.mode, 'finish_only_v1');
  const reserved = await service.reserveRevision('account-one', request(), offered.quote.token);
  assert.deepEqual(reserved, { id: 'finish-revision-one', status: 'reserved', projectId: PROJECT, mode: 'finish_only_v1' });
  assert.equal(state.reserveCalls.length, 1);
  assert.equal(state.reserveCalls[0].basePrivatePathname, state.base.privatePathname);
  assert.equal(state.reserveCalls[0].assetBinding.music.licenseReceiptSha256, 'b'.repeat(64));
  assert.equal(state.reserveCalls[0].assetBinding.graphic.logo.sha256, 'd'.repeat(64));
  assert.equal(state.reserveCalls[0].credits, 7);
  assert.ok(state.authorizationCalls >= 2);
  assert.deepEqual(await service.reserveRevision('account-one', request(), offered.quote.token), reserved);
  assert.equal(state.jobs.size, 1, 'same-key retry must remain one revision');
  assert.deepEqual(await service.recoverRevision('account-one', { projectId: PROJECT, idempotencyKey: KEY }),
    { id: 'finish-revision-one', status: 'reserved', projectId: PROJECT, mode: 'finish_only_v1' });
});

test('changed selection, project revision, base bytes and catalog cannot consume an earlier quote', async () => {
  for (const mutate of [
    (state, req) => { req.selection.graphic.headline = 'Different headline'; },
    state => { state.project.bindingSha256 = '8'.repeat(64); },
    state => { state.base.sha256 = '1'.repeat(64); },
    state => { state.catalog.revision = 'approved-catalog-v2'; },
  ]) {
    const { state, service } = fixture();
    const req = request();
    const offered = await service.quoteRevision('account-one', req);
    mutate(state, req);
    await assert.rejects(service.reserveRevision('account-one', req, offered.quote.token),
      { code: 'CREATIVE_FINISH_QUOTE_INVALID' });
    assert.equal(state.reserveCalls.length, 0);
  }
});

test('withdrawn base, revoked music, wrong owner and missing Premium authority stop before reservation', async () => {
  const { state, service } = fixture();
  const offered = await service.quoteRevision('account-one', request());
  state.base.withdrawnAt = new Date(NOW).toISOString();
  await assert.rejects(service.reserveRevision('account-one', request(), offered.quote.token),
    { code: 'CREATIVE_FINISH_BASE_UNAVAILABLE' });
  state.base.withdrawnAt = null;
  state.catalog.music[0].status = 'revoked';
  await assert.rejects(service.reserveRevision('account-one', request(), offered.quote.token),
    { code: 'CREATIVE_FINISH_ASSET_UNAVAILABLE' });
  state.catalog.music[0].status = 'approved';
  state.base.projectMode = 'luxify';
  await assert.rejects(service.reserveRevision('account-one', request(), offered.quote.token),
    { code: 'CREATIVE_FINISH_BASE_UNAVAILABLE' });
  state.base.projectMode = 'premium_presenter';
  state.base.privatePathname = 'video-os/finals/55555555-5555-4555-8555-555555555555.mp4';
  await assert.rejects(service.reserveRevision('account-one', request(), offered.quote.token),
    { code: 'CREATIVE_FINISH_BASE_UNAVAILABLE' });
  await assert.rejects(service.quoteRevision('account-two', request()), { code: 'CREATIVE_FINISH_DISABLED' });
  assert.equal(state.reserveCalls.length, 0);
  const denied = createCreativeFinishRevisionService({
    repository: fixture().repository,
    catalogFor: async () => catalog(),
    authorizePremium: async () => { throw Object.assign(new Error('Denied.'), { statusCode: 403 }); },
    environment: ENV,
    quoteOptions: { secret: 'synthetic-creative-finish-signing-secret-1234567890', now: NOW },
  });
  await assert.rejects(denied.quoteRevision('account-one', request()), { statusCode: 403 });
  const falseAuthorization = createCreativeFinishRevisionService({
    repository: fixture().repository,
    catalogFor: async () => catalog(),
    authorizePremium: async () => false,
    environment: ENV,
    quoteOptions: { secret: 'synthetic-creative-finish-signing-secret-1234567890', now: NOW },
  });
  await assert.rejects(falseAuthorization.quoteRevision('account-one', request()),
    { code: 'CREATIVE_FINISH_PREMIUM_REQUIRED' });
  const wrongProject = fixture();
  wrongProject.state.project.accountId = 'account-two';
  await assert.rejects(wrongProject.service.quoteRevision('account-one', request()),
    { code: 'CREATIVE_FINISH_PROJECT_UNAVAILABLE' });
});

test('the same held contract accepts a correctly bound LUXIFY project', async () => {
  const { state, service } = fixture();
  state.project.mode = 'luxify';
  state.project.bindingSha256 = '8'.repeat(64);
  state.base.projectMode = 'luxify';
  const offered = await service.quoteRevision('account-one', request());
  const reserved = await service.reserveRevision('account-one', request(), offered.quote.token);
  assert.equal(reserved.mode, 'finish_only_v1');
  assert.equal(state.reserveCalls[0].projectMode, 'luxify');
});

test('new quote/reservation stays disabled while owned recovery remains available after closure', async () => {
  const { state, repository } = fixture();
  state.jobs.set(KEY, { id: 'existing', status: 'reserved', accountId: 'account-one', projectId: PROJECT,
    idempotencyKey: KEY, mode: 'finish_only_v1' });
  const service = createCreativeFinishRevisionService({
    repository,
    catalogFor: async () => catalog(),
    authorizePremium: async () => ({ version: 1, accountId: 'account-one', tier: 'premium', entitlementKey: 'liveRendering' }),
    environment: { ...ENV, VIDEO_OS_CREATIVE_FINISH_ENABLED: 'false' },
  });
  await assert.rejects(service.quoteRevision('account-one', request()), { code: 'CREATIVE_FINISH_DISABLED' });
  assert.deepEqual(await service.recoverRevision('account-one', { projectId: PROJECT, idempotencyKey: KEY }),
    { id: 'existing', status: 'reserved', projectId: PROJECT, mode: 'finish_only_v1' });
  assert.equal(await service.recoverRevision('account-one', { projectId: PROJECT,
    idempotencyKey: '44444444-4444-4444-8444-444444444444' }), null);
  state.jobs.set(KEY, { ...state.jobs.get(KEY), accountId: 'account-two' });
  await assert.rejects(service.recoverRevision('account-one', { projectId: PROJECT, idempotencyKey: KEY }),
    { code: 'CREATIVE_FINISH_REVISION_INVALID' });
});

test('a no-op finish selection cannot reserve credits', async () => {
  const { state, service } = fixture();
  const input = request();
  input.selection = { version: 'creative-finish/v1', music: null, graphic: null, color: null, captions: 'none' };
  await assert.rejects(service.quoteRevision('account-one', input), { code: 'CREATIVE_FINISH_NO_CHANGES' });
  assert.equal(state.reserveCalls.length, 0);
});
