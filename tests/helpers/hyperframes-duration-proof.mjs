// Manual local engine proof; no provider or paid Sandbox calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { chromium } from '@playwright/test';
import { hyperframesComposition } from '../../services/hyperframes-finisher.js';
import { inspectMedia, validateFinalMedia } from '../../services/final-media-validation.js';

const root = await mkdtemp(join(tmpdir(), 'hyperframes-duration-proof-'));
await mkdir(join(root, 'assets'));
const source = join(root, 'assets', 'presenter.mp4');
const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', source], { timeout: 30000, encoding: 'utf8', windowsHide: true });
assert.equal(generated.status, 0, generated.stderr);
const input = await inspectMedia(source);
await writeFile(join(root, 'index.html'), hyperframesComposition(input.durationMs));
const output = join(root, 'final.mp4');
const result = spawnSync(process.execPath, [resolve('node_modules/hyperframes/bin/hyperframes.mjs'), 'render', root, '--output', output, '--quality', 'draft', '--workers', '1', '--strict-all', '--no-best-effort', '--sdr', '--no-browser-gpu', '--quiet', '--browser-timeout', '30', '--player-ready-timeout', '30000'], {
  timeout: 120000, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, DO_NOT_TRACK: '1', PUPPETEER_EXECUTABLE_PATH: chromium.executablePath() },
});
await writeFile(join(root, 'render.log'), (result.stdout || '') + (result.stderr || ''));
if (result.status !== 0) {
  console.log(JSON.stringify({ status: 'renderer-unverified', directory: root, exit: result.status, error: result.error?.code, log: (result.stderr || result.stdout || '').slice(-3000) }));
  process.exit(1);
}
const accepted = await validateFinalMedia(output, { job: { id: 'local-hyperframes-duration', accountId: 'local-test', provider: 'heygen', format: 'landscape' }, expectedDurationMs: input.durationMs });
const receipt = { status: 'local-render-verified', directory: root, inputDurationMs: input.durationMs, outputDurationMs: accepted.durationMs, bytes: accepted.bytes, sha256: accepted.sha256, width: accepted.width, height: accepted.height };
await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
