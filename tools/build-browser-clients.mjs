import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Use the already locked SDK and bundler. Do not load upload code from a CDN.
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = new URL('../public/vendor/', import.meta.url);
await mkdir(destination, { recursive: true });
const sdk = JSON.parse(await readFile(new URL('../node_modules/@vercel/blob/package.json', import.meta.url), 'utf8'));
const output = await build({
  absWorkingDir: root,
  stdin: { contents: "export { upload } from '@vercel/blob/client';", resolveDir: root, sourcefile: 'blob-browser-entry.js' },
  outfile: fileURLToPath(new URL('vercel-blob-client.js', destination)),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2020'],
  minify: true,
  legalComments: 'linked',
  write: false,
  banner: { js: `// Generated from locked @vercel/blob ${sdk.version}; run node tools/build-browser-clients.mjs.` },
});
for (const file of output.outputFiles) {
  const existing = await readFile(file.path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const sameSourceText = existing?.toString('utf8').replaceAll('\r\n', '\n')
    === Buffer.from(file.contents).toString('utf8').replaceAll('\r\n', '\n');
  if (!sameSourceText) await writeFile(file.path, file.contents);
}
console.log(`Bundled private-upload browser client from @vercel/blob ${sdk.version}.`);
