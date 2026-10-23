import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SHA = /^[a-f0-9]{40}$/;

export async function stampWorkspaceGitIdentity(functionDirectory, sourceSha) {
  if (!SHA.test(sourceSha)) throw new Error('Release source must have a full 40-character Git SHA.');
  const path = join(functionDirectory, '.vc-config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (!config.environment || typeof config.environment !== 'object' || Array.isArray(config.environment)) {
    throw new Error('Workspace function environment is unavailable.');
  }
  const prior = config.environment.VIDEO_OS_RELEASE_GIT_SHA;
  if (prior && prior !== sourceSha) throw new Error('Workspace release identity is already sealed to another commit.');
  config.environment.VIDEO_OS_RELEASE_GIT_SHA = sourceSha;
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
