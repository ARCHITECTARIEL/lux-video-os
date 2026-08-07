import { Sandbox } from '@vercel/sandbox';
import crypto from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { LUX_MARKETING_COMPOSITION_HTML } from '../media/hyperframes/lux-marketing-proof/composition.js';
import { HYPERFRAMES_VERSION, hyperframesRenderCommand, sandboxCreateOptions } from '../services/hyperframes-finisher.js';

const EXPECTED_SOURCE_BYTES = 951_537;
const EXPECTED_SOURCE_SHA256 = 'b13d1610c9ba56ffd79089c99e425c710b098f1fd9466f393f36d9ff11dc4674';

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  const snapshotId = valueAfter('--snapshot-id') || process.env.VIDEO_OS_HYPERFRAMES_SNAPSHOT_ID;
  if (!snapshotId) throw new Error('Pass --snapshot-id or set VIDEO_OS_HYPERFRAMES_SNAPSHOT_ID.');
  const inputPath = resolve(valueAfter('--input') || '.proof/private/presenter.mp4');
  const outputPath = resolve(valueAfter('--output') || '.proof/outputs/hyperframes-sandbox-proof.mp4');
  const presenter = await readFile(inputPath);
  const sourceSha256 = sha256(presenter);
  if (presenter.length !== EXPECTED_SOURCE_BYTES || sourceSha256 !== EXPECTED_SOURCE_SHA256) {
    throw new Error(`Private source mismatch: ${presenter.length} bytes / ${sourceSha256}.`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const composition = Buffer.from(LUX_MARKETING_COMPOSITION_HTML);
  let sandbox;
  const startedAt = Date.now();
  try {
    sandbox = await Sandbox.create(sandboxCreateOptions(snapshotId));
    await sandbox.writeFiles([
      { path: 'composition/index.html', content: composition },
      { path: 'composition/assets/presenter.mp4', content: presenter },
    ]);
    const command = await sandbox.runCommand(hyperframesRenderCommand());
    if (command.exitCode !== 0) throw new Error(`HyperFrames render failed (exit ${command.exitCode}): ${(await command.stderr()).slice(-2_000)}`);
    const downloaded = await sandbox.downloadFile({ path: 'final.mp4' }, { path: outputPath }, { mkdirRecursive: true });
    if (!downloaded) throw new Error('Sandbox produced no final.mp4.');
    const output = await readFile(outputPath);
    if (output.subarray(4, 8).toString('ascii') !== 'ftyp') throw new Error('Sandbox output is not MP4.');
    console.log(JSON.stringify({
      engine: 'hyperframes',
      engineVersion: HYPERFRAMES_VERSION,
      snapshotId,
      sandbox: { runtime: sandbox.runtime, vcpus: sandbox.vcpus, memoryMb: sandbox.memory, persistent: sandbox.persistent },
      source: { bytes: presenter.length, sha256: sourceSha256 },
      compositionSha256: sha256(composition),
      output: { path: outputPath, bytes: output.length, sha256: sha256(output) },
      elapsedMs: Date.now() - startedAt,
    }, null, 2));
  } finally {
    await sandbox?.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
