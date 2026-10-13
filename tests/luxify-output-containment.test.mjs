import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mock, test } from 'node:test';

import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
} from '../lib/luxify-contract.js';
import { issueLuxifyQuote, safeLuxifyQuoteProof, verifyLuxifyQuote } from '../lib/luxify-quote.js';
import { makeSession } from '../lib/video-os-account.js';
import { acceptedJobOutput } from '../lib/video-os-output-acceptance.js';
import { jobDto } from '../db/dto.js';
import { acceptedJob } from './helpers/output-acceptance-fixture.mjs';

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IDEMPOTENCY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IDENTITY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LOOK_BINDINGS = [{ identityId: IDENTITY, providerLookId: 'look_a' }];
const REVISION = 'luxify-look-eligibility-v1:canary:output-r1';
const SECRET = 'luxify-output-containment-secret-at-least-32-bytes';
const ENV = { VIDEO_OS_LUXIFY_720P_LUX_CREDITS: '41', VIDEO_OS_LUXIFY_1080P_LUX_CREDITS: '97' };
const NOW = Date.parse('2026-10-11T18:00:00.000Z');

function validLuxifyJob() {
  const base = acceptedJob('heygen', {
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    format: 'landscape',
    title: 'LUXIFY accepted output',
    costCredits: 41,
  });
  const binding = {
    accountId: base.accountId,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: base.title,
    prompt: 'A cinematic accepted-output scene with generated audio.',
    lookBindings: LOOK_BINDINGS,
    eligibilityRevision: REVISION,
    aspectRatio: '16:9',
    resolution: '720p',
    durationSeconds: 8,
  };
  const token = issueLuxifyQuote(binding, {
    secret: SECRET,
    env: ENV,
    now: NOW,
    nonce: 'luxify-output-nonce-123456789',
  }).token;
  const quoteProof = safeLuxifyQuoteProof(verifyLuxifyQuote(token, binding, { secret: SECRET, env: ENV, now: NOW }));
  base.input = {
    contractVersion: LUXIFY_CONTRACT_VERSION,
    renderMode: LUXIFY_RENDER_MODE,
    providerCapability: LUXIFY_PROVIDER_CAPABILITY,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: base.title,
    prompt: binding.prompt,
    lookIdentityIds: [IDENTITY],
    aspectRatio: binding.aspectRatio,
    resolution: binding.resolution,
    durationSeconds: binding.durationSeconds,
    lookBindings: LOOK_BINDINGS.map(value => ({ ...value })),
    eligibleLookIds: ['look_a'],
    eligibilityRevision: REVISION,
    quoteProof,
    renderAuthorization: {
      version: 1,
      accountId: base.accountId,
      tier: 'premium',
      entitlementKey: 'liveRendering',
      sourceType: 'admin_tester_grant',
      sourceId: null,
      jobId: base.id,
    },
  };
  Object.assign(base.output.acceptance, {
    renderMode: LUXIFY_RENDER_MODE,
    providerCapability: LUXIFY_PROVIDER_CAPABILITY,
    resolution: '720p',
    aspectRatio: '16:9',
  });
  Object.assign(base.output.acceptance.media, {
    width: 1280,
    height: 720,
    durationMs: 8_000,
    expectedDurationMs: 8_000,
  });
  return base;
}

function unavailableLuxifyLikeJob() {
  const job = acceptedJob('heygen');
  job.input = { contractVersion: LUXIFY_CONTRACT_VERSION };
  return job;
}

const malformedLuxifyMarkers = Object.freeze([
  Object.freeze({ providerCapability: 'cinematic_avatar_v2' }),
  Object.freeze({ contractVersion: ' LUXIFY-CINEMATIC-V2 ' }),
  Object.freeze({ renderMode: ' LUXIFY_CINEMATIC_V2 ' }),
]);

function malformedLuxifyLikeJob(input) {
  const job = acceptedJob('heygen');
  job.input = { ...input };
  return job;
}

test('exact mode-bound LUXIFY acceptance is readable while generic older evidence is insufficient', () => {
  const valid = validLuxifyJob();
  assert.equal(acceptedJobOutput(valid), true);
  for (const mutate of [
    job => { delete job.output.acceptance.renderMode; },
    job => { job.output.acceptance.providerCapability = 'avatar'; },
    job => { job.output.acceptance.resolution = '1080p'; },
    job => { job.output.acceptance.aspectRatio = '9:16'; },
    job => { delete job.output.acceptance.media.expectedDurationMs; },
    job => { job.output.acceptance.media.expectedDurationMs = 10_000; },
    job => { job.output.acceptance.media.width = 1920; },
  ]) {
    const job = structuredClone(valid);
    mutate(job);
    assert.equal(acceptedJobOutput(job), false);
  }
});

test('every partial, conflicting, or Presenter-contaminated LUXIFY marker keeps accepted output unavailable', () => {
  const jobs = [];
  for (const input of [
    { contractVersion: LUXIFY_CONTRACT_VERSION },
    { renderMode: LUXIFY_RENDER_MODE },
    { providerCapability: LUXIFY_PROVIDER_CAPABILITY },
    { contractVersion: LUXIFY_CONTRACT_VERSION, renderMode: 'premium_presenter_v1' },
    ...malformedLuxifyMarkers,
  ]) {
    const job = acceptedJob('heygen');
    job.input = input;
    jobs.push(job);
  }
  for (const mutate of [
    job => { delete job.input.quoteProof; },
    job => { delete job.input.lookBindings; },
    job => { job.input.script = 'Presenter words must remain unavailable.'; },
    job => { job.input.voice = { voiceId: 'voice_1' }; },
  ]) {
    const job = structuredClone(validLuxifyJob());
    mutate(job);
    jobs.push(job);
  }
  for (const job of jobs) assert.equal(acceptedJobOutput(job), false);
});

test('generic DTO cannot expose an unavailable LUXIFY-like output URL', () => {
  for (const job of [
    unavailableLuxifyLikeJob(),
    ...malformedLuxifyMarkers.map(malformedLuxifyLikeJob),
  ]) {
    const dto = jobDto(job);
    assert.equal(dto.mode, 'unavailable');
    assert.equal(dto.outputAccepted, false);
    assert.equal(dto.url, null);
    assert.equal(dto.message, 'Output acceptance pending.');
  }
});

test('Presenter and Standard accepted output behavior remains unchanged', () => {
  assert.equal(acceptedJobOutput(acceptedJob('heygen')), true);
  assert.equal(acceptedJobOutput(acceptedJob('sadtalker')), true);
});

const runDownloadFixture = process.argv.includes('--luxify-output-download-fixture');

if (runDownloadFixture) {
  process.env.VIDEO_OS_SESSION_SECRET = SECRET;
  let currentJob = unavailableLuxifyLikeJob();
  let blobReads = 0;
  mock.module('../db/repositories.js', { namedExports: {
    getOwnedJob: async (accountId, jobId) => currentJob.accountId === accountId && currentJob.id === jobId ? currentJob : null,
  } });
  mock.module('../lib/video-os-final-bytes.js', { namedExports: {
    readVerifiedFinalBytes: async () => { blobReads += 1; return { bytes: Buffer.from('video'), etag: 'fixture-etag' }; },
  } });
  const { default: download } = await import('../api/video-os-lite/download-v2.js');
  async function call() {
    const chunks = [];
    const token = makeSession(currentJob.accountId, 'owner@example.test');
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      write(value) { chunks.push(Buffer.from(value)); },
      end(value) { if (value) this.body = JSON.parse(value); },
    };
    await download({
      method: 'GET',
      url: `/api/video-os-lite/download?jobId=${currentJob.id}`,
      headers: { cookie: `vos_session=${encodeURIComponent(token)}` },
    }, res);
    return { body: res.body, bytes: Buffer.concat(chunks), status: res.statusCode };
  }

  test('download rejects unavailable LUXIFY-like output before storage read', async () => {
    for (const job of [
      unavailableLuxifyLikeJob(),
      ...malformedLuxifyMarkers.map(malformedLuxifyLikeJob),
    ]) {
      currentJob = job;
      const denied = await call();
      assert.equal(denied.status, 409);
      assert.equal(denied.bytes.length, 0);
    }
    assert.equal(blobReads, 0);
  });

  test('download serves exact mode-bound LUXIFY accepted output', async () => {
    currentJob = validLuxifyJob();
    const accepted = await call();
    assert.equal(accepted.status, 200);
    assert.equal(accepted.bytes.toString(), 'video');
    assert.equal(blobReads, 1);
  });
} else {
  test('download gate denies malformed LUXIFY output and serves exact accepted output', () => {
    const path = new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1));
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', path, '--luxify-output-download-fixture',
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
