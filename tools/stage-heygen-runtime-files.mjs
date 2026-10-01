import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function heygenRuntimeFiles(root) {
  const journal = JSON.parse(await readFile(join(root, 'drizzle/meta/_journal.json'), 'utf8'));
  if (!Array.isArray(journal.entries) || !journal.entries.length
    || journal.entries.some(entry => !/^\d{4}_[a-z0-9_]+$/.test(entry.tag))) {
    throw new Error('Runtime migration journal is invalid.');
  }
  return [
    'config/heygen-space-anchor.json',
    'config/database-target.verification.json',
    'config/database-target.production.json',
    'config/database-schema.lock.json',
    'drizzle/meta/_journal.json',
    ...journal.entries.map(entry => `drizzle/${entry.tag}.sql`),
    'db/schema.js', 'db/standard-narration-schema.js', 'db/provider-lifecycle-guards.sql',
  ];
}

export async function stageHeygenRuntimeFiles(root, functionRoot, { bundled = false } = {}) {
  const destination = bundled ? join(functionRoot, 'runtime-repository') : functionRoot;
  const files = await heygenRuntimeFiles(root);
  for (const file of files) {
    const target = join(destination, file);
    const sourceBytes = await readFile(join(root, file));
    try {
      const existing = await readFile(target);
      if (!existing.equals(sourceBytes)) throw new Error(`Existing runtime verification file mismatch: ${file}`);
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, file), target);
    if (!(await readFile(target)).equals(sourceBytes)) {
      throw new Error(`Runtime verification file mismatch: ${file}`);
    }
  }
  return files;
}
