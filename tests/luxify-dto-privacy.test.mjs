import assert from 'node:assert/strict';
import test from 'node:test';

import { jobDto, projectDto } from '../db/dto.js';
import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
} from '../lib/luxify-contract.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const LOOK_IDENTITY = '22222222-2222-4222-8222-222222222222';
const PROMPT = 'PRIVATE_LUXIFY_PROMPT_DO_NOT_EXPOSE';
const PROVIDER_LOOK = 'private-provider-look-do-not-expose';
const QUOTE_TOKEN = 'private-luxify-quote-token-do-not-expose';
const PROOF_MARKER = 'private-luxify-proof-do-not-expose';

function luxifyMarkers(overrides = {}) {
  return {
    contractVersion: LUXIFY_CONTRACT_VERSION,
    renderMode: LUXIFY_RENDER_MODE,
    providerCapability: LUXIFY_PROVIDER_CAPABILITY,
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    id: 'job-luxify-dto-proof',
    accountId: 'owner-account',
    providerJobId: 'provider-job-do-not-expose',
    correlationId: 'correlation-luxify-safe',
    provider: 'heygen',
    title: 'LUXIFY cinematic scene',
    format: 'landscape',
    projectId: PROJECT_ID,
    input: {
      ...luxifyMarkers(),
      projectId: PROJECT_ID,
      prompt: PROMPT,
      lookIdentityIds: [LOOK_IDENTITY],
      eligibleLookIds: [PROVIDER_LOOK],
      lookBindings: [{ identityId: LOOK_IDENTITY, providerLookId: PROVIDER_LOOK }],
      eligibilityRevision: 'luxify-look-eligibility-v1:canary:private-revision',
      quoteToken: QUOTE_TOKEN,
      quoteProof: { marker: PROOF_MARKER, providerLookId: PROVIDER_LOOK },
      identityId: LOOK_IDENTITY,
      avatar: { avatarId: PROVIDER_LOOK },
      voice: { voiceId: 'private-provider-voice-do-not-expose' },
      productionKit: { reason: PROMPT },
    },
    output: {
      avatar: { avatarId: PROVIDER_LOOK },
      voice: { voiceId: 'private-provider-voice-do-not-expose' },
      filename: PROMPT,
      effects: { reason: PROMPT },
      metadata: { quoteToken: QUOTE_TOKEN, proof: PROOF_MARKER },
    },
    costCredits: 60,
    status: 'provider_rendering',
    createdAt: new Date('2026-10-11T14:00:00.000Z'),
    updatedAt: new Date('2026-10-11T14:01:00.000Z'),
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    id: PROJECT_ID,
    accountId: 'owner-account',
    identityId: LOOK_IDENTITY,
    title: 'LUXIFY cinematic project',
    script: PROMPT,
    avatar: { id: PROVIDER_LOOK },
    voice: { id: 'private-provider-voice-do-not-expose' },
    settings: {
      ...luxifyMarkers(),
      prompt: PROMPT,
      lookIdentityIds: [LOOK_IDENTITY],
      providerLookId: PROVIDER_LOOK,
      quoteToken: QUOTE_TOKEN,
      quoteProof: { marker: PROOF_MARKER },
    },
    createdAt: new Date('2026-10-11T13:00:00.000Z'),
    updatedAt: new Date('2026-10-11T13:01:00.000Z'),
    ...overrides,
  };
}

function assertPrivateLuxifyEvidenceHidden(dto) {
  const serialized = JSON.stringify(dto);
  for (const forbidden of [
    PROMPT,
    LOOK_IDENTITY,
    PROVIDER_LOOK,
    'private-provider-voice-do-not-expose',
    QUOTE_TOKEN,
    PROOF_MARKER,
    LUXIFY_RENDER_MODE,
    LUXIFY_PROVIDER_CAPABILITY,
    LUXIFY_CONTRACT_VERSION,
    'provider-job-do-not-expose',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `DTO leaked ${forbidden}`);
  }
  for (const privateKey of [
    'prompt',
    'lookIdentityIds',
    'eligibleLookIds',
    'lookBindings',
    'providerLookId',
    'eligibilityRevision',
    'quoteToken',
    'quoteProof',
    'renderMode',
    'providerCapability',
  ]) {
    assert.equal(serialized.includes(`"${privateKey}"`), false, `DTO leaked private field ${privateKey}`);
  }
  assert.equal('input' in dto, false);
  assert.equal('settings' in dto && dto.settings !== undefined && Object.keys(dto.settings).length > 0, false);
}

test('exact persisted LUXIFY job markers emit only a sanitized mode discriminator', () => {
  const dto = jobDto(job());
  assert.equal(dto.mode, 'luxify');
  assert.equal(dto.tier, 'premium');
  assert.equal(dto.identityId, null);
  assert.equal(dto.avatar, null);
  assert.equal(dto.voice, null);
  assert.deepEqual(dto.productionKit, {});
  assert.deepEqual(dto.effects, {});
  assert.equal(dto.filename, undefined);
  assert.equal(dto.title, 'LUXIFY cinematic scene');
  assert.equal(dto.projectId, PROJECT_ID);
  assertPrivateLuxifyEvidenceHidden(dto);
});

test('exact persisted LUXIFY project markers prevent Presenter restoration without leaking settings', () => {
  const dto = projectDto(project());
  assert.deepEqual(dto, {
    id: PROJECT_ID,
    mode: 'luxify',
    title: 'LUXIFY cinematic project',
    script: '',
    identityId: null,
    avatar: null,
    voice: null,
    settings: {},
    createdAt: new Date('2026-10-11T13:00:00.000Z'),
    updatedAt: new Date('2026-10-11T13:01:00.000Z'),
  });
  assertPrivateLuxifyEvidenceHidden(dto);
});

test('partial, conflicting, and non-HeyGen LUXIFY-like jobs become unavailable and private', () => {
  const cases = [
    job({ input: { ...job().input, contractVersion: 'luxify-cinematic-v0' } }),
    job({ input: { ...job().input, renderMode: 'premium_presenter_v1' } }),
    job({ input: { ...job().input, providerCapability: 'avatar' } }),
    job({ provider: 'sadtalker' }),
    job({ input: { ...job().input, contractVersion: 'LUXIFY-CINEMATIC-V2', renderMode: null, providerCapability: null } }),
    job({ input: { ...job().input, contractVersion: null, renderMode: 'luxify_cinematic_v2', providerCapability: null } }),
    job({ input: { ...job().input, contractVersion: null, renderMode: null, providerCapability: 'cinematic_avatar_v2' } }),
  ];
  for (const candidate of cases) {
    const dto = jobDto(candidate);
    assert.equal(dto.mode, 'unavailable');
    assert.equal(dto.tier, null);
    assert.equal(dto.identityId, null);
    assert.equal(dto.avatar, null);
    assert.equal(dto.voice, null);
    assert.deepEqual(dto.productionKit, {});
    assert.deepEqual(dto.effects, {});
    assert.equal(dto.filename, undefined);
    assertPrivateLuxifyEvidenceHidden(dto);
  }
});

test('output-only job markers do not relabel an otherwise legacy persisted input', () => {
  const dto = jobDto(job({ input: {}, output: { ...job().output, ...luxifyMarkers() } }));
  assert.equal(Object.hasOwn(dto, 'mode'), false);
  assert.equal(dto.tier, 'premium');
});

test('partial and conflicting LUXIFY-like projects become unavailable and private', () => {
  const cases = [
    project({ settings: { ...project().settings, contractVersion: 'luxify-cinematic-v0' } }),
    project({ settings: { ...project().settings, renderMode: 'premium_presenter_v1' } }),
    project({ settings: { ...project().settings, providerCapability: 'avatar' } }),
    project({ settings: { contractVersion: 'LUXIFY-CINEMATIC-V2' } }),
    project({ settings: { renderMode: 'luxify_cinematic_v2' } }),
    project({ settings: { providerCapability: 'cinematic_avatar_v2' } }),
  ];
  for (const candidate of cases) {
    const dto = projectDto(candidate);
    assert.equal(dto.mode, 'unavailable');
    assert.equal(dto.script, '');
    assert.equal(dto.identityId, null);
    assert.equal(dto.avatar, null);
    assert.equal(dto.voice, null);
    assert.deepEqual(dto.settings, {});
    assertPrivateLuxifyEvidenceHidden(dto);
  }
});

test('top-level-only project markers cannot relabel legacy settings', () => {
  const dto = projectDto({ ...project({ settings: {} }), ...luxifyMarkers(), script: 'Legacy script' });
  assert.equal(Object.hasOwn(dto, 'mode'), false);
  assert.equal(dto.script, 'Legacy script');
});

test('Premium Presenter and Standard DTO shapes remain mode-free and retain their existing safe fields', () => {
  const presenter = jobDto(job({
    input: {
      avatar: { avatarId: 'featured:ariel' },
      voice: { voiceId: 'featured:ariel:voice' },
    },
    output: {},
  }));
  assert.equal(Object.hasOwn(presenter, 'mode'), false);
  assert.equal(presenter.tier, 'premium');
  assert.equal(presenter.avatar.avatarId, 'featured:ariel');
  assert.equal(presenter.voice.voiceId, 'featured:ariel:voice');

  const standard = jobDto(job({
    provider: 'sadtalker',
    input: {},
    output: { filename: 'standard-output.mp4', effects: { music: { name: 'Safe Music' } } },
  }));
  assert.equal(Object.hasOwn(standard, 'mode'), false);
  assert.equal(standard.tier, 'standard');
  assert.equal(standard.filename, 'standard-output.mp4');
  assert.deepEqual(standard.effects, { music: { name: 'Safe Music' } });

  const legacyProject = projectDto(project({
    identityId: null,
    script: 'Presenter script',
    avatar: { id: 'featured:ariel' },
    voice: { id: 'featured:ariel:voice' },
    settings: {},
  }));
  assert.equal(Object.hasOwn(legacyProject, 'mode'), false);
  assert.equal(legacyProject.script, 'Presenter script');
  assert.equal(legacyProject.avatar.avatarId, 'featured:ariel');
  assert.equal(legacyProject.voice.voiceId, 'featured:ariel:voice');
});
