import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { jobDto, projectDto } from '../db/dto.js';
import { FEATURED_CAST } from '../lib/video-os-featured-cast.js';
import { projectRequestSchema } from '../lib/video-os-validation.js';
import { providerList } from '../lib/video-os-account.js';

const OWNED_AVATAR_ID = '11111111-2222-4333-8444-555555555555';
const OWNED_VOICE_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PRIVATE_PREVIEW_URL = 'https://private-provider.example/inventory/preview.png';

function baseJob(overrides = {}) {
  return {
    id: 'job-legacy-proof',
    accountId: 'account-owner',
    providerJobId: 'provider-job-private',
    correlationId: 'correlation-safe',
    provider: 'heygen',
    title: 'Legacy completed video',
    format: 'vertical',
    projectId: 'project-owner',
    input: {},
    output: {},
    costCredits: 90,
    status: 'ready',
    createdAt: new Date('2026-07-20T12:00:00.000Z'),
    updatedAt: new Date('2026-07-20T12:05:00.000Z'),
    ...overrides,
  };
}

function assertSerializedExcludes(value, forbidden) {
  const serialized = JSON.stringify(value);
  for (const item of forbidden) {
    assert.equal(serialized.includes(item), false, 'serialized DTO must exclude forbidden legacy identity data');
  }
}

function configuredIds() {
  return FEATURED_CAST.flatMap((item) => [item.avatarId, item.voiceId]);
}

test('ordinary render DTO labels and provider setup hints do not name processors', () => {
  for (const provider of ['heygen', 'argil', 'tavus', 'did']) {
    const dto = jobDto(baseJob({ provider }));
    assert.equal(dto.provider.id, provider, 'machine ID remains compatible with existing clients');
    assert.equal(dto.provider.name, 'The Render');
  }
  assert.equal(jobDto(baseJob({ provider: 'sadtalker' })).provider.name, 'Standard');

  const listed = providerList();
  for (const provider of listed) {
    assert.equal(provider.name, 'Managed');
    assert.doesNotMatch(`${provider.name} ${provider.label} ${provider.missing.join(' ')}`, /heygen|argil|tavus|d-id|did[_-]|api[_-]?key/i);
    assert.deepEqual(provider.missing, provider.configured ? [] : ['setup']);
  }
});

test('legacy raw provider identities and polluted fallback metadata fail closed', () => {
  const [ariel, oso, kd] = FEATURED_CAST;
  const forbidden = [
    ...configuredIds(),
    PRIVATE_PREVIEW_URL,
    'private-look-count:48',
    'pagination-next:private',
    'account-completeness:private',
  ];
  const dto = jobDto(baseJob({
    input: {
      avatar: { avatarId: ariel.avatarId, name: 'Legacy presenter', previewUrl: PRIVATE_PREVIEW_URL },
      voice: { voiceId: oso.voiceId, metadata: { raw: kd.voiceId } },
      productionKit: {
        music: { name: ariel.voiceId },
        overlay: { name: PRIVATE_PREVIEW_URL },
        privateInventory: 'private-look-count:48',
      },
    },
    output: {
      avatar: PRIVATE_PREVIEW_URL,
      voice: { id: kd.voiceId, error: `rejected:${ariel.avatarId}` },
      effects: {
        cta: { name: 'pagination-next:private' },
        debug: { completeness: 'account-completeness:private' },
      },
      error: `provider rejected ${oso.avatarId}`,
      metadata: { providerVoice: oso.voiceId },
    },
  }));

  assert.equal(dto.avatar, null);
  assert.equal(dto.voice, null);
  assert.equal('providerJobId' in dto, false);
  assert.deepEqual(dto.productionKit, {});
  assert.deepEqual(dto.effects, {});
  assertSerializedExcludes(dto, forbidden);
});

test('alternate URI schemes and UUID-shaped metadata are rejected', () => {
  const leakedUuid = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const leakedUri = 's3://private-provider/inventory/item';
  const dto = jobDto(baseJob({
    input: {
      productionKit: { reason: leakedUuid },
      avatar: 'featured:ariel',
      voice: 'featured:ariel:voice',
    },
    output: { effects: { music: { name: leakedUri } } },
  }));
  assert.deepEqual(dto.productionKit, {});
  assert.deepEqual(dto.effects, {});
  assertSerializedExcludes(dto, [leakedUuid, leakedUri]);
});

test('safe featured references survive while invalid namespaces and malformed values fail closed', () => {
  for (const featured of FEATURED_CAST) {
    const dto = jobDto(baseJob({
      status: 'rendering',
      input: {
        avatar: { avatarId: `featured:${featured.key}` },
        voice: { voiceId: `featured:${featured.key}:voice` },
      },
    }));
    assert.equal(dto.avatar.avatarId, `featured:${featured.key}`);
    assert.equal(dto.voice.voiceId, `featured:${featured.key}:voice`);
    assert.equal(dto.avatar.name, featured.label);
    assert.equal(dto.voice.name, `${featured.label} voice`);
  }

  for (const [avatar, voice] of [
    ['featured:unknown', 'featured:unknown:voice'],
    ['featured:ariel:voice', 'featured:ariel'],
    ['provider:ariel', 'provider:voice'],
    [{ id: { nested: true } }, { voiceId: ['invalid'] }],
    [null, null],
  ]) {
    const dto = jobDto(baseJob({ input: { avatar, voice } }));
    assert.equal(dto.avatar, null);
    assert.equal(dto.voice, null);
  }
});

test('opaque shared references survive DTO boundaries without provider identifiers', () => {
  const dto = jobDto(baseJob({ input: {
    avatar: { avatarId: 'shared:avatar:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', name: 'Shared presenter' },
    voice: { voiceId: 'shared:voice:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', name: 'Shared voice' },
  } }));
  assert.equal(dto.avatar.avatarId, 'shared:avatar:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(dto.voice.voiceId, 'shared:voice:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
  assert.equal(dto.avatar.source, 'heygen');
  assert.equal(dto.voice.source, 'heygen');
  assert.equal(jobDto(baseJob({ input: { avatar: 'raw-provider-avatar', voice: 'raw-provider-voice' } })).avatar, null);
});

test('owned application assets require an explicit verified ownership context', () => {
  const input = {
    avatar: { id: `owned-asset:${OWNED_AVATAR_ID}`, name: 'Owner photo' },
    voice: { id: `owned-asset:${OWNED_VOICE_ID}`, name: 'Owner voice' },
  };
  const denied = jobDto(baseJob({ input }));
  assert.equal(denied.avatar, null);
  assert.equal(denied.voice, null);

  const allowed = jobDto(baseJob({ input }), {
    ownedApplicationAssetIds: [OWNED_AVATAR_ID, OWNED_VOICE_ID],
  });
  assert.equal(allowed.avatar.avatarId, `owned-asset:${OWNED_AVATAR_ID}`);
  assert.equal(allowed.voice.voiceId, `owned-asset:${OWNED_VOICE_ID}`);
  assert.equal(allowed.avatar.name, 'Owner photo');
  assert.equal(allowed.voice.name, 'Owner voice');
});

test('persisted project responses use the same identity sanitizer and drop untrusted settings', () => {
  const project = {
    id: 'project-legacy',
    title: 'Legacy project',
    script: 'Existing script remains available.',
    avatar: { id: FEATURED_CAST[0].avatarId, previewUrl: PRIVATE_PREVIEW_URL },
    voice: { id: FEATURED_CAST[0].voiceId },
    settings: { providerPreviewUrl: PRIVATE_PREVIEW_URL, privateLookCount: 48 },
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    updatedAt: new Date('2026-07-20T10:05:00.000Z'),
  };
  const dto = projectDto(project);
  assert.equal(dto.avatar, null);
  assert.equal(dto.voice, null);
  assert.deepEqual(dto.settings, {});
  assert.equal(dto.title, project.title);
  assert.equal(dto.script, project.script);
  assertSerializedExcludes(dto, [...configuredIds(), PRIVATE_PREVIEW_URL]);

  const safe = projectDto({
    ...project,
    avatar: { id: 'featured:oso' },
    voice: { id: 'featured:oso:voice' },
  });
  assert.equal(safe.avatar.avatarId, 'featured:oso');
  assert.equal(safe.voice.voiceId, 'featured:oso:voice');
});

test('sanitized output takes precedence and rejected output safely falls back to sanitized input', () => {
  const safeInput = {
    avatar: { avatarId: 'featured:ariel' },
    voice: { voiceId: 'featured:ariel:voice' },
  };
  const safeOutput = jobDto(baseJob({
    input: safeInput,
    output: {
      avatar: { avatarId: 'featured:kd' },
      voice: { voiceId: 'featured:kd:voice' },
    },
  }));
  assert.equal(safeOutput.avatar.avatarId, 'featured:kd');
  assert.equal(safeOutput.voice.voiceId, 'featured:kd:voice');

  const rejectedOutput = jobDto(baseJob({
    input: safeInput,
    output: {
      avatar: PRIVATE_PREVIEW_URL,
      voice: FEATURED_CAST[0].voiceId,
    },
  }));
  assert.equal(rejectedOutput.avatar.avatarId, 'featured:ariel');
  assert.equal(rejectedOutput.voice.voiceId, 'featured:ariel:voice');
  assertSerializedExcludes(rejectedOutput, [PRIVATE_PREVIEW_URL, FEATURED_CAST[0].voiceId]);
});

test('legacy MP4 metadata survives sanitization but cannot authorize unvalidated playback', () => {
  const dto = jobDto(baseJob({
    input: {
      avatar: FEATURED_CAST[0].avatarId,
      voice: FEATURED_CAST[0].voiceId,
    },
    output: {
      filename: 'legacy-completed-video.mp4',
      effects: { music: { name: 'Crystal Clear.wav' }, lut: { name: 'Studio Contrast.cube' } },
    },
  }));
  assert.equal(dto.avatar, null);
  assert.equal(dto.voice, null);
  assert.equal(dto.filename, 'legacy-completed-video.mp4');
  assert.equal(dto.url, null);
  assert.equal(dto.outputAccepted, false);
  assert.equal(dto.message, 'Output acceptance pending.');
  assert.deepEqual(dto.effects, {
    music: { name: 'Crystal Clear.wav' },
    lut: { name: 'Studio Contrast.cube' },
  });
});

test('failure, cancellation, retry, and recovery DTOs never reintroduce rejected identities', () => {
  for (const status of ['failed', 'cancelled', 'provider_submit_unknown', 'rendering']) {
    const dto = jobDto(baseJob({
      status,
      input: {
        avatar: FEATURED_CAST[1].avatarId,
        voice: FEATURED_CAST[1].voiceId,
        productionKit: { reason: `retry ${FEATURED_CAST[1].avatarId}` },
      },
      output: {
        avatar: FEATURED_CAST[2].avatarId,
        voice: FEATURED_CAST[2].voiceId,
        message: `failed ${FEATURED_CAST[2].voiceId}`,
      },
    }));
    assert.equal(dto.avatar, null);
    assert.equal(dto.voice, null);
    assert.equal(dto.url, null);
    assertSerializedExcludes(dto, configuredIds());
  }
});

test('job DTO sanitization is side-effect free and never logs rejected values', () => {
  const captured = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => captured.push(args);
  console.warn = (...args) => captured.push(args);
  console.error = (...args) => captured.push(args);
  try {
    const job = baseJob({ input: { avatar: FEATURED_CAST[0].avatarId, voice: FEATURED_CAST[0].voiceId } });
    const before = structuredClone(job);
    const first = jobDto(job);
    const second = jobDto(job);
    assert.deepEqual(first, second);
    assert.deepEqual(job, before);
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  assert.deepEqual(captured, []);
});

test('all externally reachable persisted identity responses use the common DTO boundary', async () => {
  const [results, finalize, render, download, projects, standard, routesText] = await Promise.all([
    readFile(new URL('../routes/video-os-lite/results-v2.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/video-os-lite/finalize-v2.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/video-os-lite/render-v2.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/video-os-lite/download-v2.js', import.meta.url), 'utf8'),
    readFile(new URL('../routes/video-os-lite/projects.js', import.meta.url), 'utf8'),
    readFile(new URL('../routes/video-os-lite/standard.js', import.meta.url), 'utf8'),
    readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
  ]);

  assert.match(results, /\.map\(jobDto\)/);
  assert.match(finalize, /const dto = jobDto\(job\)/);
  // Legacy Standard, legacy Premium, and scripted-photo each have success and
  // uncertain-dispatch responses, all using the same privacy boundary.
  assert.equal((render.match(/job: jobDto\(reservedJob\)/g) || []).length, 6);
  assert.doesNotMatch(download, /avatar|voice|jobDto/);
  assert.match(projects, /\.map\(projectDto\)/);
  assert.match(projects, /project: projectDto\(project\)/);
  assert.match(projects, /event: 'video_os_project_failure'/);
  assert.match(projects, /error: publicMessage/);
  assert.doesNotMatch(projects, /error:\s*error\.message/);
  assert.match(standard, /event: 'video_os_standard_failure'/);
  assert.match(standard, /error: 'Standard narration request could not be completed\.'/);
  assert.doesNotMatch(standard, /error:\s*error\.message/);
  const routes = JSON.parse(routesText).routes.map((route) => route.src);
  assert.equal(routes.includes('/api/video-os-lite/results'), true);
  assert.equal(routes.includes('/api/video-os-lite/finalize'), true);
  assert.equal(routes.includes('/api/video-os-lite/render'), true);
  assert.equal(routes.includes('/api/video-os-lite/download'), true);
  assert.equal(routes.includes('/api/video-os-lite/projects'), true);
});


test('project writes reject provider preview URLs and keep typed identity authority canonical', async () => {
  const parsed = projectRequestSchema.safeParse({
    title: 'Canonical project',
    script: 'A sufficiently explicit script.',
    identityId: '11111111-2222-4333-8444-555555555555',
    avatar: { id: 'featured:ariel', name: 'Ariel', source: 'featured', previewUrl: PRIVATE_PREVIEW_URL },
    voice: { id: 'featured:ariel:voice', name: 'Ariel voice', source: 'featured' },
    settings: { identityId: '66666666-7777-4888-8999-aaaaaaaaaaaa' },
  });
  assert.equal(parsed.success, false);

  const repositorySource = await readFile(new URL('../db/repositories.js', import.meta.url), 'utf8');
  const renderSource = await readFile(new URL('../api/video-os-lite/render-v2.js', import.meta.url), 'utf8');
  const clientSource = await readFile(new URL('../public/lite.js', import.meta.url), 'utf8');
  assert.equal(repositorySource.includes('avatar: projectSelectionForStorage(avatar)'), true);
  assert.equal(repositorySource.includes('voice: projectSelectionForStorage(voice)'), true);
  assert.equal(repositorySource.includes('settings: {}'), true);
  assert.equal(renderSource.includes('project?.settings?.identityId'), false);
  assert.equal(clientSource.includes('project.settings?.identityId'), false);
  assert.equal(clientSource.includes('previewUrl: appState.avatar'), false);
});
