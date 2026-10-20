import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stampWorkspaceGitIdentity } from '../tools/release-git-identity.mjs';

test('prebuilt workspace function receives the exact reviewed source SHA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-os-release-identity-'));
  const path = join(dir, '.vc-config.json');
  const sourceSha = 'a'.repeat(40);
  try {
    await writeFile(path, JSON.stringify({ runtime: 'nodejs24.x', environment: { EXISTING: 'kept' } }));
    await stampWorkspaceGitIdentity(dir, sourceSha);
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(config.environment.VIDEO_OS_RELEASE_GIT_SHA, sourceSha);
    assert.equal(config.environment.EXISTING, 'kept');
    await assert.rejects(stampWorkspaceGitIdentity(dir, 'b'.repeat(40)), /already sealed/);
    await assert.rejects(stampWorkspaceGitIdentity(dir, 'not-a-sha'), /40-character/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
