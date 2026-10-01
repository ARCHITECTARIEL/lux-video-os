import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Use the already locked SDK and bundler. Do not load upload code from a CDN.
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = new URL('../public/vendor/', import.meta.url);
await mkdir(destination, { recursive: true });
const sdk = JSON.parse(await readFile(new URL('../node_modules/@vercel/blob/package.json', import.meta.url), 'utf8'));
await build({
  absWorkingDir: root,
  stdin: { contents: "export { upload } from '@vercel/blob/client';", resolveDir: root, sourcefile: 'blob-browser-entry.js' },
  outfile: fileURLToPath(new URL('vercel-blob-client.js', destination)),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2020'],
  minify: true,
  legalComments: 'linked',
  banner: { js: `// Generated from locked @vercel/blob ${sdk.version}; run node tools/build-browser-clients.mjs.` },
});
console.log(`Bundled private-upload browser client from @vercel/blob ${sdk.version}.`);
