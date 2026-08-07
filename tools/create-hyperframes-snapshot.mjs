import { Sandbox } from '@vercel/sandbox';

const HYPERFRAMES_VERSION = '0.7.64';
const SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;

async function run(sandbox, label, command) {
  const result = await sandbox.runCommand({ ...command, timeoutMs: SETUP_TIMEOUT_MS - 30_000 });
  if (result.exitCode === 0) return;
  throw new Error(`${label} failed (exit ${result.exitCode}): ${(await result.stderr()).slice(-2_000)}`);
}

async function main() {
  let sandbox;
  try {
    sandbox = await Sandbox.create({
      runtime: 'node22',
      resources: { vcpus: 4 },
      timeout: SETUP_TIMEOUT_MS,
      persistent: false,
      tags: { workload: 'video-os-snapshot', engine: 'hyperframes' },
    });
    await Promise.all([
      run(sandbox, 'system dependency install', {
        cmd: 'dnf',
        args: ['install', '-y', '--setopt=install_weak_deps=False', 'nss', 'nspr', 'atk', 'at-spi2-atk', 'cups-libs', 'libdrm', 'libxkbcommon', 'libXcomposite', 'libXdamage', 'libXext', 'libXfixes', 'libXrandr', 'mesa-libgbm', 'alsa-lib', 'pango'],
        sudo: true,
      }),
      run(sandbox, 'pinned media dependency install', {
        cmd: 'npm',
        args: ['install', '--no-save', '--no-audit', '--no-fund', `hyperframes@${HYPERFRAMES_VERSION}`, 'ffmpeg-static@5.3.0', 'ffprobe-static@3.1.0'],
      }),
    ]);
    await Promise.all([
      run(sandbox, 'FFmpeg link', { cmd: 'ln', args: ['-sf', '/vercel/sandbox/node_modules/ffmpeg-static/ffmpeg', '/usr/local/bin/ffmpeg'], sudo: true }),
      run(sandbox, 'FFprobe link', { cmd: 'ln', args: ['-sf', '/vercel/sandbox/node_modules/ffprobe-static/bin/linux/x64/ffprobe', '/usr/local/bin/ffprobe'], sudo: true }),
    ]);
    await run(sandbox, 'Chrome download', { cmd: 'npx', args: ['--no-install', 'hyperframes', 'browser', 'ensure'] });
    await run(sandbox, 'engine version check', { cmd: 'npx', args: ['--no-install', 'hyperframes', '--version'] });
    const snapshot = await sandbox.snapshot({ expiration: SNAPSHOT_EXPIRATION_MS });
    console.log(JSON.stringify({ snapshotId: snapshot.snapshotId, bytes: snapshot.sizeBytes, hyperframesVersion: HYPERFRAMES_VERSION, expiresAt: snapshot.expiresAt?.toISOString() || null }, null, 2));
    sandbox = null;
  } finally {
    await sandbox?.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
