import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ELF_MAGIC = '7f454c46';
const MACHINE = Object.freeze({ x64: 0x3e, arm64: 0xb7 });

export async function assertStepFunctionFfmpeg(stepFunctionDirectory, { architecture = 'x64' } = {}) {
  const expectedMachine = MACHINE[architecture];
  if (!expectedMachine) throw new Error(`Step function architecture is not a supported Linux target: ${architecture}`);
  const binary = join(stepFunctionDirectory, 'ffmpeg');
  let info;
  try { info = await lstat(binary); } catch {
    throw new Error(`Step function is missing ffmpeg (${binary}).`);
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Step function ffmpeg must be a regular file, not a link.');
  if ((info.mode & 0o111) === 0) throw new Error('Step function ffmpeg is not executable.');
  const header = await readFile(binary);
  const machine = header.length >= 20 ? header.readUInt16LE(18) : 0;
  if (header.length < 20 || header.subarray(0, 4).toString('hex') !== ELF_MAGIC || machine !== expectedMachine) {
    throw new Error(`Step function ffmpeg is not a Linux ${architecture} ELF binary.`);
  }
  return binary;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const directory = process.argv[2];
  const architecture = process.argv.includes('--arm64') ? 'arm64' : 'x64';
  if (!directory) {
    console.error('Usage: node tools/assert-step-ffmpeg.mjs <step-function-dir> [--arm64]');
    process.exitCode = 1;
  } else {
    await assertStepFunctionFfmpeg(directory, { architecture });
  }
}
