import assert from 'node:assert/strict';
import test from 'node:test';
import { jobDto } from '../db/dto.js';
import { acceptedJob } from './helpers/output-acceptance-fixture.mjs';

test('real job DTO carries accepted-output truth and tier without private evidence', () => {
  for (const [provider, tier] of [['heygen', 'premium'], ['sadtalker', 'standard']]) {
    const job = acceptedJob(provider);
    const dto = jobDto(job);
    assert.equal(dto.tier, tier);
    assert.equal(dto.outputAccepted, true);
    assert.equal(dto.url, `/api/video-os-lite/download?jobId=${job.id}`);
    for (const hidden of [job.accountId, job.output.privatePathname, job.output.sha256, 'validatedAt', 'fullDecode']) assert.equal(JSON.stringify(dto).includes(hidden), false);
  }
});

test('a Standard scripted-photo HeyGen job is displayed as Standard from its durable tier binding', () => {
  const job = acceptedJob('heygen', {
    input: {
      contractVersion: 'scripted-photo-v1',
      tier: 'STANDARD',
      renderAuthorization: {
        version: 1,
        accountId: 'acceptance-owner',
        tier: 'standard',
        entitlementKey: 'standardRendering',
        sourceType: 'test_fixture',
        sourceId: null,
        jobId: '11111111-2222-4333-8444-555555555555',
      },
    },
  });
  assert.equal(jobDto(job).tier, 'standard');

  delete job.input.renderAuthorization;
  assert.throws(() => jobDto(job), { failureCategory: 'RECONCILIATION' });
});

test('an unknown legacy provider remains unlabeled instead of being reported as Premium', () => {
  assert.equal(jobDto(acceptedJob('unknown-provider')).tier, null);
});

test('ready status alone or mismatched/missing validation never exposes output', () => {
  const mutations = [
    job => { job.output = {}; },
    job => { delete job.output.acceptance; job.output.outputAccepted = true; },
    job => { job.status = 'failed'; },
    job => { job.output.acceptance.status = 'rejected'; },
    job => { job.output.acceptance.version = 99; },
    job => { job.output.acceptance.validatorVersion = ''; },
    job => { job.output.acceptance.policy = 'unknown'; },
    job => { job.output.acceptance.jobId = 'different'; },
    job => { job.output.acceptance.accountId = 'different'; },
    job => { job.output.sha256 = 'b'.repeat(64); },
    job => { job.output.bytes++; },
    job => { job.output.privatePathname = 'https://public.example/video.mp4'; },
    job => { job.output.privatePathname = job.output.acceptance.privatePathname = `video-os/finals/another-account/${job.id}-${job.output.sha256}.mp4`; },
    job => { job.output.acceptance.media.fullDecode = false; },
    job => { job.output.acceptance.media.audioStreams = 0; },
    job => { job.output.acceptance.media.videoStreams = 0; },
    job => { job.output.acceptance.media.durationMs = 0; },
    job => { job.output.acceptance.media.width = 0; },
    job => { job.output.acceptance.media.height = 0; },
    job => { job.output.acceptance.checks.duration = false; },
    job => { job.output.acceptance.validatedAt = 'invalid'; },
  ];
  for (const mutate of mutations) {
    const job = acceptedJob(); mutate(job);
    const dto = jobDto(job);
    assert.equal(dto.outputAccepted, false);
    assert.equal(dto.url, null);
    assert.notEqual(dto.message, 'Final MP4 ready.');
  }
});

test('deleted accepted output remains terminal but has no playable URL', () => {
  const job = acceptedJob(); job.videoDeletedAt = '2026-09-29T13:00:00Z';
  const dto = jobDto(job);
  assert.equal(dto.outputAccepted, true);
  assert.equal(dto.url, null);
  assert.equal(dto.message, 'This video is no longer available.');
});
