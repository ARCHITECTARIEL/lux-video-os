import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HYPERFRAMES_SANDBOX_TIMEOUT_MS,
  HYPERFRAMES_SANDBOX_VCPUS,
  HYPERFRAMES_VERSION,
  hyperframesRenderCommand,
  hyperframesSnapshotId,
  sandboxCreateOptions,
} from '../services/hyperframes-finisher.js';
import { finishingEngine } from '../workflows/video-render.js';
import { classifyFailure } from '../lib/video-os-operations.js';

test('FFmpeg remains the default finishing engine', () => {
  assert.equal(finishingEngine({}), 'ffmpeg');
  assert.equal(classifyFailure({ failureCategory: 'FINISH_HYPERFRAMES' }), 'FINISH_HYPERFRAMES');
});

test('HyperFrames selection is explicit and fail-closed', () => {
  assert.throws(() => finishingEngine({ VIDEO_OS_COMPOSITION_ENGINE: 'hyperframes' }), /requested but disabled/);
  assert.equal(finishingEngine({ VIDEO_OS_COMPOSITION_ENGINE: 'hyperframes', VIDEO_OS_HYPERFRAMES_ENABLED: 'true' }), 'hyperframes');
  assert.throws(() => finishingEngine({ VIDEO_OS_COMPOSITION_ENGINE: 'unknown' }), /Unsupported composition engine/);
  assert.throws(() => hyperframesSnapshotId({}), /snapshot is not configured/);
});

test('HyperFrames is pinned and isolated in bounded Sandbox compute', () => {
  assert.equal(HYPERFRAMES_VERSION, '0.7.64');
  const options = sandboxCreateOptions('snap-proof');
  assert.deepEqual(options.source, { type: 'snapshot', snapshotId: 'snap-proof' });
  assert.equal(options.resources.vcpus, HYPERFRAMES_SANDBOX_VCPUS);
  assert.equal(options.resources.vcpus, 4);
  assert.equal(options.timeout, HYPERFRAMES_SANDBOX_TIMEOUT_MS);
  assert.equal(options.persistent, false);
  assert.deepEqual(options.networkPolicy.allowedDomains, ['fonts.googleapis.com', 'fonts.gstatic.com']);
});

test('the bundled composition exactly matches the authoring HTML', async () => {
  const [{ readFile }, { LUX_MARKETING_COMPOSITION_HTML }] = await Promise.all([
    import('node:fs/promises'),
    import('../media/hyperframes/lux-marketing-proof/composition.js'),
  ]);
  const normalizeHtml = (value) => value.replace(/\r\n/g, '\n').trimEnd();
  const authored = normalizeHtml(await readFile(new URL('../media/hyperframes/lux-marketing-proof/index.html', import.meta.url), 'utf8'));
  assert.equal(normalizeHtml(LUX_MARKETING_COMPOSITION_HTML), authored);
});

test('render command invokes HyperFrames directly and rejects best-effort output', () => {
  const command = hyperframesRenderCommand();
  assert.deepEqual(command.args.slice(0, 3), ['--no-install', 'hyperframes', 'render']);
  assert.ok(command.args.includes('--strict-all'));
  assert.ok(command.args.includes('--no-best-effort'));
  assert.ok(command.args.includes('--no-browser-gpu'));
  assert.ok(command.args.includes('--workers'));
  assert.ok(command.args.includes('1'));
});

test('the initial bounded composition is landscape-only', async () => {
  const { finishMediaWithHyperframes } = await import('../services/hyperframes-finisher.js');
  await assert.rejects(
    finishMediaWithHyperframes({ id: 'job-proof', format: 'portrait' }, 'https://example.test/source.mp4', { env: { VIDEO_OS_HYPERFRAMES_SNAPSHOT_ID: 'snap-proof' } }),
    /supports landscape jobs only/,
  );
});

test('workflow does not silently fall back after selecting HyperFrames', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../workflows/video-render.js', import.meta.url), 'utf8'));
  const finishingBody = source.slice(source.indexOf('async function finishProviderMedia'), source.indexOf('async function failWorkflow'));
  assert.match(source, /finishingEngine\(\) === 'hyperframes'/);
  assert.match(source, /await finishMediaWithHyperframes\(job, sourceUrl\)/);
  assert.doesNotMatch(finishingBody, /catch/);
});
