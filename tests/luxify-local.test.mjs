import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseBrief } from '../lib/luxify-local-brief.js';
import { loadShotImage, planBrief, resolveAssets, resolveFfmpeg, runPipeline, xfadeGraph } from '../services/luxify-local-pipeline.js';
import { main } from '../tools/luxify-local.mjs';

const SECRET = 'key_local_test_NEVER_PRINT_0000';
const TASK = n => `11111111-2222-3333-4444-${String(n).padStart(12, '0')}`;
const FONT_SRC = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/arialbd.ttf'].find(p => existsSync(p));

function baseBrief(overrides = {}) {
  return {
    version: 'luxify-local/v1', slug: 'unit', title: 'Unit', aspect: '16:9', script: 'Hello.',
    shots: [
      { id: 'a', model: 'runway', prompt: 'p1', duration: 2, titles: [{ kind: 'banner', text: "LUX: it's here", start: 0.2, end: 1.8 }] },
      { id: 'b', model: 'seedance', prompt: 'p2', duration: 4, titles: [{ kind: 'lower_third', text: 'Ariel', subtext: 'Founder', start: 0.2, end: 3 }] },
    ],
    transitions: [{ type: 'fade', duration: 0.5 }],
    fontPreset: 'lux-sans-bold', lut: 'id.cube', music: { track: 'bed.wav', volume: 0.5 }, logoOverlay: 'logo.png',
    voice: { source: 'heygen_audio_file', path: 'voice.wav' },
    ...overrides,
  };
}

test('brief schema validates fields and reports readable errors', () => {
  const brief = parseBrief(baseBrief());
  assert.equal(brief.loudnessLufs, -14);
  const bad = [
    baseBrief({ version: 'v0' }),
    baseBrief({ shots: [{ id: 'a', model: 'kling', prompt: 'x', duration: 5 }] , transitions: [] }),
    baseBrief({ lut: '../evil.cube' }),
    baseBrief({ music: { track: 'https://x/y.mp3' } }),
    baseBrief({ voice: { source: 'heygen_job', jobId: 'abc123' } }),
    baseBrief({ voice: { source: 'heygen_audio_file', path: 'https://heygen.com/a.mp3' } }),
    baseBrief({ transitions: [] , shots: baseBrief().shots.concat([{ id: 'a', model: 'runway', prompt: 'x', duration: 3 }]) }),
    baseBrief({ transitions: [{ type: 'fade', duration: 0.5 }, { type: 'fade', duration: 0.5 }] }),
    baseBrief({ shots: [{ id: 'a', model: 'runway', prompt: 'x', duration: 2, titles: [{ kind: 'banner', text: 't', start: 0, end: 3 }] }], transitions: [] }),
    baseBrief({ shots: [{ id: 'a', model: 'seedance', prompt: 'x', duration: 3 }], transitions: [] }),
    baseBrief({ extra: true }),
  ];
  for (const value of bad) assert.throws(() => parseBrief(value), { code: 'BRIEF_INVALID' });
  assert.equal(parseBrief(baseBrief({ voice: { source: 'heygen_job', jobId: 'abc123', path: 'v.wav' } })).voice.jobId, 'abc123');
});

test('example brief in video_productions validates and plans under the caps', async () => {
  const brief = parseBrief(JSON.parse(await readFile(new URL('../video_productions/example-luxify/brief.json', import.meta.url))));
  const plan = planBrief(brief);
  assert.equal(plan.totalCredits, 216);
  assert.equal(plan.totalEstUsd, 2.16);
});

test('caps: $1 per clip and $10 per video are enforced at plan time', () => {
  const one = shots => parseBrief(baseBrief({ shots, transitions: [] }));
  assert.equal(planBrief(one([{ id: 'a', model: 'runway', prompt: 'x', duration: 8 }])).shots[0].credits, 96);
  assert.throws(() => planBrief(one([{ id: 'a', model: 'runway', prompt: 'x', duration: 9 }])), { code: 'CAP_EXCEEDED_CLIP' });
  assert.throws(() => planBrief(one([{ id: 'a', model: 'seedance', prompt: 'x', duration: 5 }])), { code: 'CAP_EXCEEDED_CLIP' });
  assert.equal(planBrief(one([{ id: 'a', model: 'seedance', prompt: 'x', duration: 4 }])).shots[0].estUsd, 0.96);
  const many = n => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, model: 'runway', prompt: 'x', duration: 8 }));
  assert.equal(planBrief(one(many(10))).totalEstUsd, 9.6);
  assert.throws(() => planBrief(one(many(11))), { code: 'CAP_EXCEEDED_VIDEO' });
});

test('dry run is the default, prints plan + cost, and never constructs a client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'luxify-dry-'));
  try {
    await writeFile(join(dir, 'brief.json'), JSON.stringify(baseBrief()));
    let out = '';
    let factoryCalls = 0;
    const result = await main(['--brief', join(dir, 'brief.json'), '--assets', join(dir, 'assets')], { env: { RUNWAYML_API_SECRET: SECRET }, stdout: { write: s => { out += s; } }, runwayDeps: { clientFactory: async () => { factoryCalls++; } } });
    assert.equal(result.mode, 'dry-run');
    const view = JSON.parse(out);
    assert.equal(view.mode, 'dry-run');
    assert.equal(view.totalCredits, 24 + 96);
    assert.equal(view.totalEstUsd, 1.2);
    assert.equal(view.shots[1].model, 'seedance2_fast');
    assert.ok(view.missingAssets.length >= 4);
    assert.equal(factoryCalls, 0);
    assert.ok(!out.includes(SECRET));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('--live refuses without RUNWAYML_API_SECRET and on cap breach, before any submit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'luxify-live-'));
  try {
    const assets = join(dir, 'assets');
    for (const sub of ['fonts', 'luts', 'music', 'overlays']) await mkdir(join(assets, sub), { recursive: true });
    for (const f of ['fonts/lux-sans-bold.ttf', 'luts/id.cube', 'music/bed.wav', 'overlays/logo.png']) await writeFile(join(assets, f), 'x');
    await writeFile(join(dir, 'voice.wav'), 'x');
    const brief = baseBrief({ voice: { source: 'heygen_audio_file', path: join(dir, 'voice.wav') } });
    await writeFile(join(dir, 'brief.json'), JSON.stringify(brief));
    let factoryCalls = 0;
    const deps = { env: {}, stdout: { write() {} }, runwayDeps: { clientFactory: async () => { factoryCalls++; } } };
    await assert.rejects(main(['--brief', join(dir, 'brief.json'), '--assets', assets, '--live'], deps), { code: 'SECRET_MISSING' });
    await writeFile(join(dir, 'brief.json'), JSON.stringify({ ...brief, shots: [{ id: 'a', model: 'runway', prompt: 'x', duration: 10 }], transitions: [] }));
    await assert.rejects(main(['--brief', join(dir, 'brief.json'), '--assets', assets, '--live'], { ...deps, env: { RUNWAYML_API_SECRET: SECRET } }), { code: 'CAP_EXCEEDED_CLIP' });
    await assert.rejects(main(['--brief', join(dir, 'brief.json'), '--live', '--dry-run'], deps), { code: 'USAGE' });
    assert.equal(factoryCalls, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M3: shot images must be local files inside the brief folder or the assets folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'luxify-img-'));
  try {
    const briefDir = join(dir, 'brief'); const assetsRoot = join(dir, 'assets'); const outside = join(dir, 'outside');
    for (const d of [briefDir, assetsRoot, outside]) await mkdir(d, { recursive: true });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    await writeFile(join(briefDir, 'a.png'), png);
    await writeFile(join(assetsRoot, 'b.png'), png);
    await writeFile(join(outside, 'c.png'), png);
    await writeFile(join(briefDir, 'd.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.match(await loadShotImage('a.png', { briefDir, assetsRoot }), /^data:image\/png;base64,/);
    assert.match(await loadShotImage(join(assetsRoot, 'b.png'), { briefDir, assetsRoot }), /^data:image\/png/);
    await assert.rejects(loadShotImage('../outside/c.png', { briefDir, assetsRoot }), { code: 'IMAGE_OUTSIDE_ROOTS' });
    await assert.rejects(loadShotImage('d.svg', { briefDir, assetsRoot }), { code: 'RUNWAY_IMAGE_INVALID' });
    await assert.rejects(loadShotImage('missing.png', { briefDir, assetsRoot }), { code: 'IMAGE_NOT_FOUND' });
    await writeFile(join(briefDir, 'big.png'), Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)]));
    await assert.rejects(loadShotImage('big.png', { briefDir, assetsRoot }), { code: 'RUNWAY_IMAGE_INVALID' });
    assert.throws(() => parseBrief(baseBrief({ shots: [{ id: 'a', model: 'runway', prompt: 'x', duration: 2, promptImage: 'https://example.com/a.png' }], transitions: [] })), { code: 'BRIEF_INVALID' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('xfade offsets accumulate and concat is used without transitions', () => {
  const g = xfadeGraph([2, 4, 3], [{ type: 'fade', duration: 0.5 }, { type: 'wipeleft', duration: 1 }]);
  assert.match(g.graph, /xfade=transition=fade:duration=0.5:offset=1.5\[x1\]/);
  assert.match(g.graph, /xfade=transition=wipeleft:duration=1:offset=4.5\[vout\]/);
  assert.equal(g.duration, 7.5);
  assert.equal(xfadeGraph([2, 3], []).graph, '[0:v][1:v]concat=n=2:v=1:a=0[vout]');
});

let ffmpeg = null;
try { ffmpeg = resolveFfmpeg(); } catch { ffmpeg = null; }

function ff(args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  assert.equal(r.status, 0, String(r.stderr));
}
function probeStreams(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  return r.stderr;
}

async function fixtures(dir) {
  const assets = join(dir, 'assets');
  for (const sub of ['fonts', 'luts', 'music', 'overlays']) await mkdir(join(assets, sub), { recursive: true });
  await copyFile(FONT_SRC, join(assets, 'fonts', 'lux-sans-bold.ttf'));
  await writeFile(join(assets, 'luts', 'id.cube'), 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=8:sample_rate=48000', join(assets, 'music', 'bed.wav')]);
  ff(['-f', 'lavfi', '-i', 'color=c=white:s=64x32', '-frames:v', '1', join(assets, 'overlays', 'logo.png')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=48000', join(dir, 'voice.wav')]);
  const clipA = join(dir, 'srcA.mp4'); const clipB = join(dir, 'srcB.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=2', '-pix_fmt', 'yuv420p', clipA]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4', '-pix_fmt', 'yuv420p', clipB]);
  return { assets, clips: [await readFile(clipA), await readFile(clipB)] };
}

function mockRunway(clips, calls) {
  let n = 0;
  return {
    clientFactory: async options => {
      calls.factory.push(options);
      return {
        textToVideo: { create: async (body, opts) => { calls.create.push({ body, opts }); return { id: TASK(++n) }; } },
        imageToVideo: { create: async () => { throw new Error('unexpected'); } },
        tasks: {
          retrieve: id => ({ waitForTaskOutput: async () => { calls.retrieve.push(id); return { id, status: 'SUCCEEDED', output: [`https://dnznrvs05pmza.cloudfront.net/${id}.mp4?_jwt=x`] }; } }),
          delete: async () => {},
        },
      };
    },
    sdkErrors: async () => ({ TaskFailedError: class extends Error {}, TaskTimedOutError: class extends Error {}, AbortError: class extends Error {} }),
    fetchImpl: async url => {
      const idx = Number(String(url).match(/-(\d{12})\.mp4/)[1]) - 1;
      const bytes = clips[idx];
      let sent = false;
      return { ok: true, headers: new Map(), body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: new Uint8Array(bytes) })), cancel: async () => {} }) } };
    },
  };
}

test('end-to-end offline: mocked Runway -> grade/LUT -> titles -> xfade -> ducked music -> loudnorm -> final.mp4 + receipt', { skip: !ffmpeg || !FONT_SRC ? 'no ffmpeg with drawtext or no font' : false, timeout: 180000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'luxify-e2e-'));
  try {
    const { assets, clips } = await fixtures(dir);
    const brief = parseBrief(baseBrief({ voice: { source: 'heygen_job', jobId: 'hg_job_123', path: join(dir, 'voice.wav') } }));
    const plan = planBrief(brief);
    const calls = { factory: [], create: [], retrieve: [] };
    const outDir = join(dir, 'render');
    const receipt = await runPipeline({ brief, briefDir: dir, plan, outDir, assets: resolveAssets(brief, assets), ffmpeg, runwayEnv: { VIDEO_OS_RUNWAY_ENABLED: 'true', RUNWAYML_API_SECRET: SECRET }, runwayDeps: mockRunway(clips, calls) });
    assert.equal(calls.create.length, 2);
    assert.ok(calls.create.every(c => c.opts.maxRetries === 0));
    assert.deepEqual(calls.create.map(c => c.body.model), ['gen4.5', 'seedance2_fast']);
    assert.equal(calls.create[1].body.audio, false);
    const info = probeStreams(join(outDir, 'final.mp4'));
    assert.match(info, /Video: h264.*1280x720/);
    assert.match(info, /Audio: aac/);
    const duration = info.match(/Duration: (\d+):(\d+):([\d.]+)/);
    const seconds = Number(duration[2]) * 60 + Number(duration[3]);
    assert.ok(Math.abs(seconds - 5.5) < 0.25, `duration ${seconds}`);
    const saved = JSON.parse(await readFile(join(outDir, 'receipt.json'), 'utf8'));
    assert.equal(saved.status, 'complete');
    assert.equal(saved.totalCredits, 120);
    assert.equal(saved.totalEstUsd, 1.2);
    assert.deepEqual(saved.shots.map(s => s.model), ['gen4.5', 'seedance2_fast']);
    assert.equal(saved.tasks.a.taskId, TASK(1));
    assert.equal(saved.tasks.b.status, 'stored');
    assert.match(saved.final.sha256, /^[0-9a-f]{64}$/);
    assert.equal(saved.assets.heygenJobId, 'hg_job_123');
    assert.match(saved.assets.lut.sha256, /^[0-9a-f]{64}$/);
    const text = JSON.stringify(saved);
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes('cloudfront'));
    assert.equal(receipt.final.sha256, saved.final.sha256);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M2 (local): a timeout aborts the run and the receipt keeps the task id as unresolved', { skip: !ffmpeg || !FONT_SRC ? 'no ffmpeg' : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'luxify-to-'));
  try {
    const brief = parseBrief(baseBrief({ voice: { source: 'heygen_audio_file', path: join(dir, 'voice.wav') } }));
    const plan = planBrief(brief);
    class TaskTimedOutError extends Error {}
    let receiptAtPoll = null;
    const outDir = join(dir, 'render');
    let creates = 0;
    const runwayDeps = {
      clientFactory: async () => ({
        textToVideo: { create: async () => { creates++; return { id: TASK(7) }; } },
        tasks: { retrieve: () => ({ waitForTaskOutput: async () => { receiptAtPoll = JSON.parse(await readFile(join(outDir, 'receipt.json'), 'utf8')); throw new TaskTimedOutError('t'); } }), delete: async () => {} },
      }),
      sdkErrors: async () => ({ TaskFailedError: class extends Error {}, TaskTimedOutError, AbortError: class extends Error {} }),
    };
    await assert.rejects(runPipeline({ brief, briefDir: dir, plan, outDir, assets: resolveAssets(brief, join(dir, 'assets')), ffmpeg, runwayEnv: { VIDEO_OS_RUNWAY_ENABLED: 'true', RUNWAYML_API_SECRET: SECRET }, runwayDeps }), { code: 'RUNWAY_TIMEOUT' });
    assert.equal(receiptAtPoll.tasks.a.taskId, TASK(7), 'task id written before polling');
    assert.equal(receiptAtPoll.tasks.a.status, 'submitted');
    const saved = JSON.parse(await readFile(join(outDir, 'receipt.json'), 'utf8'));
    assert.equal(saved.status, 'aborted');
    assert.equal(saved.tasks.a.status, 'unresolved');
    assert.equal(saved.tasks.a.taskId, TASK(7));
    assert.equal(creates, 1, 'no retry and no further shots');
    assert.equal(saved.tasks.b, undefined);
    assert.ok(!JSON.stringify(saved).includes(SECRET));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
