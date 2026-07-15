import { readdir } from 'node:fs/promises';

const files = (await readdir(new URL('../api/video-os-lite/', import.meta.url))).filter((name) => name.endsWith('.js') && !name.includes('.backup'));
for (const file of files) {
  await import(new URL(`../api/video-os-lite/${file}`, import.meta.url));
  console.log(`OK ${file}`);
}
