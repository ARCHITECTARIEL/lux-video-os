import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { enrollmentFailureIsRetryable } from '../lib/enrollment-policy.js';
import { ENROLLMENT_MEDIA_CONSENT_PURPOSE, prepareEnrollmentMedia } from '../services/enrollment-media.js';
import { resolveEnrollmentFfmpeg } from '../services/enrollment-ffmpeg.js';
import { assertStepFunctionFfmpeg } from '../tools/assert-step-ffmpeg.mjs';

function elf(machine = 0x3e) {
  const header = Buffer.alloc(64);
  header[0] = 0x7f;
  header[1] = 0x45;
  header[2] = 0x4c;
  header[3] = 0x46;
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(machine, 18);
  return header;
}

async function withDir(run) {
  const directory = await mkdtemp(join(tmpdir(), 'lux-ffmpeg-resolve-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('ffmpeg resolution prefers an explicit path, then the step module, then cwd, then ffmpeg-static', async () => {
  await withDir(async directory => {
    const override = join(directory, 'override');
    const moduleBinary = join(directory, 'module', 'ffmpeg');
    const cwdBinary = join(directory, 'cwd', 'ffmpeg');
    const staticBinary = join(directory, 'static-ffmpeg');
    await writeFile(override, 'override');
    await chmod(override, 0o755);
    await mkdir(join(directory, 'module'));
    await mkdir(join(directory, 'cwd'));
    await writeFile(moduleBinary, 'module');
    await chmod(moduleBinary, 0o755);
    await writeFile(cwdBinary, 'cwd');
    await chmod(cwdBinary, 0o755);
    await writeFile(staticBinary, 'static');
    await chmod(staticBinary, 0o755);
    const moduleUrl = pathToFileURL(join(directory, 'module', 'step.js')).href;
    const shared = { moduleUrl, cwd: join(directory, 'cwd'), staticPath: staticBinary };
    assert.equal(await resolveEnrollmentFfmpeg({ ...shared, override }), override);
    await rm(override);
    assert.equal(await resolveEnrollmentFfmpeg(shared), moduleBinary);
    await rm(moduleBinary);
    assert.equal(await resolveEnrollmentFfmpeg(shared), cwdBinary);
    await rm(cwdBinary);
    assert.equal(await resolveEnrollmentFfmpeg(shared), staticBinary);
    await rm(staticBinary);
    assert.equal(await resolveEnrollmentFfmpeg(shared), undefined);
  });
});

test('a staged ffmpeg without the exec bit is made executable when chmod is allowed', async () => {
  await withDir(async directory => {
    const binary = join(directory, 'ffmpeg');
    await writeFile(binary, 'staged');
    await chmod(binary, 0o644);
    const resolved = await resolveEnrollmentFfmpeg({
      moduleUrl: pathToFileURL(join(directory, 'step.js')).href,
      cwd: join(directory, 'missing-cwd'),
      staticPath: join(directory, 'missing-static'),
    });
    assert.equal(resolved, binary);
    const info = await stat(binary);
    assert.notEqual(info.mode & 0o111, 0);
  });
});

test('chmod refusal still selects the first existing binary so spawn can report that errno', async () => {
  await withDir(async directory => {
    const binary = join(directory, 'ffmpeg');
    const fallback = join(directory, 'fallback');
    await writeFile(binary, 'staged');
    await chmod(binary, 0o644);
    await writeFile(fallback, 'fallback');
    await chmod(fallback, 0o755);
    const resolved = await resolveEnrollmentFfmpeg({
      moduleUrl: pathToFileURL(join(directory, 'step.js')).href,
      cwd: directory,
      staticPath: fallback,
      chmodImpl: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); },
    });
    assert.equal(resolved, binary);
    assert.equal((await stat(binary)).mode & 0o111, 0);
  });
});

test('a missing ffmpeg logs the path and errno and stays FFMPEG_UNAVAILABLE', async () => {
  await withDir(async directory => {
    const source = join(directory, 'source.bin');
    const missing = join(directory, 'missing-ffmpeg');
    await writeFile(source, Buffer.from('not a video'));
    const sha256 = createHash('sha256').update(await readFile(source)).digest('hex');
    const logs = [];
    const original = console.log;
    console.log = line => logs.push(String(line));
    try {
      await assert.rejects(prepareEnrollmentMedia({
        filePath: source,
        expectedSha256: sha256,
        consent: { granted: true, purpose: ENROLLMENT_MEDIA_CONSENT_PURPOSE, sourceSha256: sha256 },
        ffmpegPath: missing,
        tempRoot: directory,
      }), error => error.code === 'FFMPEG_UNAVAILABLE' && !/[\\/]/.test(error.message));
    } finally {
      console.log = original;
    }
    const event = logs.map(line => JSON.parse(line)).find(item => item.event === 'enrollment.ffmpeg.spawn_failed');
    assert.equal(event.code, 'FFMPEG_UNAVAILABLE');
    assert.equal(event.ffmpegPath, missing);
    assert.equal(event.spawnCode, 'ENOENT');
    assert.equal(typeof event.errno, 'number');
    assert.equal(enrollmentFailureIsRetryable(event.code), true);
    assert.equal(event.ffmpegPath.includes('secret'), false);
  });
});

test('the step-function packaging check requires an executable Linux x64 ffmpeg ELF', async () => {
  await withDir(async directory => {
    const binary = join(directory, 'ffmpeg');
    await assert.rejects(() => assertStepFunctionFfmpeg(directory), /missing ffmpeg/);
    await writeFile(binary, Buffer.from('not an elf'));
    await chmod(binary, 0o755);
    await assert.rejects(() => assertStepFunctionFfmpeg(directory), /not a Linux x64 ELF/);
    await writeFile(binary, elf(0xb7));
    await chmod(binary, 0o755);
    await assert.rejects(() => assertStepFunctionFfmpeg(directory), /not a Linux x64 ELF/);
    await writeFile(binary, elf(0x3e));
    await chmod(binary, 0o644);
    await assert.rejects(() => assertStepFunctionFfmpeg(directory), /not executable/);
    await chmod(binary, 0o755);
    assert.equal(await assertStepFunctionFfmpeg(directory), binary);
    const build = await readFile(new URL('../tools/build-production.mjs', import.meta.url), 'utf8');
    assert.match(build, /assertStepFunctionFfmpeg\(fileURLToPath\(stepFunction\)/);
  });
});
