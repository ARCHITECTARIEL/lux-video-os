import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
// Imports already present in origin/main are used by step functions. This guard
// inspects newly introduced imports without rejecting that established boundary.
const mainImports = {
  'identity-enrollment.js': ['workflow', 'node:crypto', 'node:fs/promises', 'node:os', 'node:path', '../db/enrollment-repository.js', '../db/repositories.js', '../lib/video-os-security.js', '../lib/enrollment-policy.js', '../lib/video-os-private-blob.js', '../services/enrollment-media.js'],
  'standard-render.js': ['workflow', '../db/client.js', '../db/repositories.js', '../db/standard-narration-repository.js', '../lib/video-os-operations.js', '../lib/video-os-observability.js', '../lib/video-os-render-notify.js', '../services/sadtalker-runpod.js', '../services/sadtalker-simulator.js'],
  'video-render.js': ['workflow', 'node:crypto', '../db/repositories.js', '../lib/video-os-security.js', '../lib/video-os-operations.js', '../lib/video-os-observability.js', '../lib/ops-log.js', '../lib/video-os-render-notify.js', '../services/heygen.js', '../db/heygen-space-binding-repository.js', '../db/provider-reconciliation-repository.js', '../services/media-finisher.js', '../services/hyperframes-client.js', '../services/hyperframes-contract.js', '../services/remotion-finisher.js', '../lib/luxify-contract.js', '../lib/scripted-photo-contract.js'],
};

function imports(source) {
  return [...source.matchAll(/^import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map(match => match[1]);
}

async function firstNodeBuiltin(file, seen = new Set()) {
  if (seen.has(file)) return null;
  seen.add(file);
  const source = await readFile(file, 'utf8');
  for (const specifier of imports(source)) {
    if (specifier.startsWith('node:')) return `${file} -> ${specifier}`;
    if (specifier.startsWith('.')) {
      const found = await firstNodeBuiltin(resolve(dirname(file), specifier), seen);
      if (found) return `${file} -> ${found}`;
    }
  }
  return null;
}

async function unsafeImports(name, source) {
  const file = resolve(root, 'workflows', name);
  const baseline = new Set(mainImports[name]);
  const unsafe = [];
  for (const specifier of imports(source)) {
    if (baseline.has(specifier)) continue;
    const path = specifier.startsWith('node:') ? specifier
      : specifier.startsWith('.') ? await firstNodeBuiltin(resolve(dirname(file), specifier)) : null;
    if (path) unsafe.push(`${name} -> ${path}`);
  }
  return unsafe;
}

test('new workflow imports cannot reach Node builtins', async () => {
  for (const name of Object.keys(mainImports)) {
    const source = await readFile(resolve(root, 'workflows', name), 'utf8');
    assert.deepEqual(await unsafeImports(name, source), []);
  }
});

test('guard rejects the previous HeyGen safety import', async () => {
  const name = 'video-render.js';
  const source = await readFile(resolve(root, 'workflows', name), 'utf8');
  const oldImport = "import { heygenSubmissionIdentity } from '../lib/heygen-provider-safety.js';\n";
  assert.match((await unsafeImports(name, oldImport + source)).join('\n'), /node:crypto/);
});

test('main workflow imports are accepted by the guard', async () => {
  for (const [name, specifiers] of Object.entries(mainImports)) {
    const source = specifiers.map(specifier => `import '${specifier}';`).join('\n');
    assert.deepEqual(await unsafeImports(name, source), []);
  }
});
