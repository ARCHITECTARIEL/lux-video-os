import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizePreview } from '../tools/authorize-preview.mjs';
import { explicitPreviewTarget, fingerprint, main, outputInventory } from '../tools/authorize-release.mjs';
import { PREVIEW_DEPLOY_COMMAND, previewUploadLimitWarning, VERCEL_PREBUILT_FILE_LIMIT } from '../tools/preview-upload-limit.mjs';
import {
  identityEnrollmentCleanupWorkflowMetadata,
  identityEnrollmentExpiryWorkflowMetadata,
  identityEnrollmentExtractionWorkflowMetadata,
  identityEnrollmentHashWorkflowMetadata,
} from '../workflows/identity-enrollment-metadata.js';

const BLOCKED_ENV = [
  'DATABASE_URL',
  'BLOB_READ_WRITE_TOKEN',
  'RUNWAY_API_KEY',
  'HEYGEN_API_KEY',
  'RUNWAYML_API_SECRET',
  'VIDEO_OS_RUNWAY_ENABLED',
  'GHL_PIT',
  'RESEND_API_KEY',
  'AUTH_FROM_EMAIL',
];
for (const key of BLOCKED_ENV) delete process.env[key];

const SOURCE = { head: 'abc123def', sha256: 'source-hash', projectLinkSha256: 'link-hash', dirty: true };

function workflowDocument(omitName) {
  const workflows = {
    identityEnrollmentHashWorkflow: { workflowId: identityEnrollmentHashWorkflowMetadata.workflowId },
    identityEnrollmentExtractionWorkflow: { workflowId: identityEnrollmentExtractionWorkflowMetadata.workflowId },
    identityEnrollmentCleanupWorkflow: { workflowId: identityEnrollmentCleanupWorkflowMetadata.workflowId },
    identityEnrollmentExpiryWorkflow: { workflowId: identityEnrollmentExpiryWorkflowMetadata.workflowId },
  };
  if (omitName) delete workflows[omitName];
  return { version: '1.0.0', steps: {}, classes: {}, workflows: { 'workflows/identity-enrollment.js': workflows } };
}

async function writeFunction(output, relativeDir) {
  const directory = join(output, relativeDir);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '.vc-config.json'), '{"runtime":"nodejs20.x"}\n');
  await writeFile(join(directory, 'index.js'), 'exports.handler = function previewWorkflow() { return true; };\n');
}

async function makeArtifact({
  target = 'preview',
  omitManifest = false,
  omitFlow = false,
  omitStep = false,
  omitRoute = null,
  omitWorkflow = null,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'preview-auth-'));
  const output = join(dir, '.vercel', 'review-output-test');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'marker.txt'), 'preview');
  if (!omitFlow) await writeFunction(output, 'functions/.well-known/workflow/v1/flow.func');
  if (!omitStep) await writeFunction(output, 'functions/.well-known/workflow/v1/step.func');
  const routes = ['enrollments', 'enrollment-upload', 'scripted-photo']
    .filter(name => name !== omitRoute)
    .map(name => ({ src: `^/api/video-os-lite/${name}$`, dest: '/api/video-os-lite/workspace.js' }));
  await writeFile(join(output, 'config.json'), `${JSON.stringify({ version: 3, routes }, null, 2)}\n`);
  await mkdir(join(output, 'diagnostics'), { recursive: true });
  await writeFile(join(output, 'diagnostics/workflows-manifest.json'), JSON.stringify(workflowDocument(omitWorkflow)));
  const records = await outputInventory(output);
  const manifest = {
    version: 1,
    target,
    status: 'REVIEW_ONLY',
    releaseAuthorized: false,
    source: { head: SOURCE.head, sha256: SOURCE.sha256, projectLinkSha256: SOURCE.projectLinkSha256, dirty: true },
    output: { sha256: fingerprint(records), location: output },
    database: { verified: false, scope: 'snapshots-only', environment: 'preview' },
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = join(dir, 'release-build-manifest.json');
  if (!omitManifest) await writeFile(manifestPath, bytes);
  await writeFile(`${output}.release-build-manifest.json`, bytes);
  await writeFile(`${output}.packaging-success.json`, `${JSON.stringify({
    packagingComplete: true,
    releaseAuthorized: false,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceSha256: manifest.source.sha256,
    outputSha256: manifest.output.sha256,
  })}\n`);
  return { dir, output, manifestPath, bytes };
}

function argv(manifestPath, extra = []) {
  return ['node', 'authorize-preview.mjs', '--target=preview', '--manifest', manifestPath, ...extra];
}

test('preview artifact is accepted with database and provider env unset', async () => {
  for (const key of BLOCKED_ENV) assert.equal(process.env[key], undefined, key);
  const artifact = await makeArtifact();
  const errors = [];
  try {
    const result = await authorizePreview({
      argv: argv(artifact.manifestPath),
      root: artifact.dir,
      deps: { captureSource: async () => SOURCE, log() {}, logError: message => errors.push(message) },
    });
    assert.equal(result.target, 'preview');
    assert.equal(result.previewDeployAuthorized, true);
    assert.equal(result.routineDeployAuthorized, false);
    assert.equal(result.releaseAuthorized, false);
    assert.equal(result.deployCommand, PREVIEW_DEPLOY_COMMAND);
    assert.equal(result.deployCommand, 'vercel deploy --prebuilt --archive=tgz');
    assert.equal(result.deployCommand.includes('--prod'), false);
    assert.equal(result.uploadLimitWarning, null);
    assert.ok(errors.includes('Run: vercel deploy --prebuilt --archive=tgz'));
    assert.equal(errors.some(message => message.includes('--prod')), false);
    const restored = join(artifact.dir, '.vercel/output');
    assert.equal((await stat(join(restored, 'functions/.well-known/workflow/v1/flow.func/index.js'))).isFile(), true);
    assert.equal((await stat(join(restored, 'functions/.well-known/workflow/v1/step.func/index.js'))).isFile(), true);
    await assert.rejects(() => stat(artifact.output), error => error.code === 'ENOENT');
  } finally {
    await rm(artifact.dir, { recursive: true, force: true });
  }
});

test('production artifact or target is refused', async () => {
  const production = await makeArtifact({ target: 'production' });
  const preview = await makeArtifact();
  const restored = [];
  const restoreOutput = async (...args) => { restored.push(args); };
  try {
    await assert.rejects(() => authorizePreview({
      argv: argv(production.manifestPath),
      root: production.dir,
      deps: { captureSource: async () => SOURCE, restoreOutput, log() {}, logError() {} },
    }), /production artifact/);
    await assert.rejects(() => authorizePreview({
      argv: ['node', 'authorize-preview.mjs', '--target=production', '--manifest', preview.manifestPath],
      root: preview.dir,
      deps: { captureSource: async () => SOURCE, restoreOutput, log() {}, logError() {} },
    }), /production target/);
    await assert.rejects(() => authorizePreview({
      argv: argv(preview.manifestPath, ['--prod']),
      root: preview.dir,
      deps: { captureSource: async () => SOURCE, restoreOutput, log() {}, logError() {} },
    }), /production deploy flag/);
    await assert.rejects(() => main({
      argv: ['node', 'authorize-release.mjs', '--target=production', '--manifest', preview.manifestPath, '--owner-authorized'],
      root: preview.dir,
      deps: { captureSource: async () => SOURCE, restoreOutput, log() {}, logError() {}, runMigrationCheck: () => { restored.push(['db']); return { status: 0, stdout: '' }; } },
    }), /not a production candidate/);
    assert.equal(restored.length, 0);
    await stat(production.output);
    await stat(preview.output);
  } finally {
    await rm(production.dir, { recursive: true, force: true });
    await rm(preview.dir, { recursive: true, force: true });
  }
});

test('tampered or missing manifest is refused', async () => {
  const missing = await makeArtifact({ omitManifest: true });
  try {
    await assert.rejects(() => authorizePreview({
      argv: argv(missing.manifestPath),
      root: missing.dir,
      deps: { captureSource: async () => SOURCE, restoreOutput: async () => { throw new Error('restored'); }, log() {}, logError() {} },
    }), /manifest is missing/);
    await stat(missing.output);
  } finally {
    await rm(missing.dir, { recursive: true, force: true });
  }

  const invalid = await makeArtifact();
  try {
    await writeFile(invalid.manifestPath, '{');
    await assert.rejects(() => authorizePreview({
      argv: argv(invalid.manifestPath),
      root: invalid.dir,
      deps: { captureSource: async () => SOURCE, restoreOutput: async () => { throw new Error('restored'); }, log() {}, logError() {} },
    }), /not valid JSON/);
    await stat(invalid.output);
  } finally {
    await rm(invalid.dir, { recursive: true, force: true });
  }

  const tampered = await makeArtifact();
  try {
    const manifest = JSON.parse(tampered.bytes.toString('utf8'));
    manifest.output.sha256 = manifest.output.sha256.replace(/^./, manifest.output.sha256.startsWith('a') ? 'b' : 'a');
    await writeFile(tampered.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(() => authorizePreview({
      argv: argv(tampered.manifestPath),
      root: tampered.dir,
      deps: { captureSource: async () => SOURCE, restoreOutput: async () => { throw new Error('restored'); }, log() {}, logError() {} },
    }), /tampered manifest/);
    await stat(tampered.output);
  } finally {
    await rm(tampered.dir, { recursive: true, force: true });
  }

  const edited = await makeArtifact();
  try {
    await writeFile(join(edited.output, 'marker.txt'), 'changed-after-packaging');
    await assert.rejects(() => authorizePreview({
      argv: argv(edited.manifestPath),
      root: edited.dir,
      deps: { captureSource: async () => SOURCE, restoreOutput: async () => { throw new Error('restored'); }, log() {}, logError() {} },
    }), /manifest hash/);
    await stat(edited.output);
  } finally {
    await rm(edited.dir, { recursive: true, force: true });
  }

  const outside = await makeArtifact();
  try {
    const manifest = JSON.parse(outside.bytes.toString('utf8'));
    manifest.output.location = outside.dir;
    await writeFile(outside.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(() => authorizePreview({
      argv: argv(outside.manifestPath),
      root: outside.dir,
      deps: { captureSource: async () => SOURCE, restoreOutput: async () => { throw new Error('restored'); }, log() {}, logError() {} },
    }), /must stay inside/);
    await stat(outside.output);
  } finally {
    await rm(outside.dir, { recursive: true, force: true });
  }
});

test('missing flow or step function is refused', async () => {
  for (const [omit, pattern] of [[{ omitFlow: true }, /flow\.func/], [{ omitStep: true }, /step\.func/]]) {
    const artifact = await makeArtifact(omit);
    try {
      await assert.rejects(() => authorizePreview({
        argv: argv(artifact.manifestPath),
        root: artifact.dir,
        deps: { captureSource: async () => SOURCE, restoreOutput: async () => { throw new Error('restored'); }, log() {}, logError() {} },
      }), pattern);
      await stat(artifact.output);
    } finally {
      await rm(artifact.dir, { recursive: true, force: true });
    }
  }
});

test('missing enrollment route or workflow id is refused', async () => {
  for (const [omit, pattern] of [[{ omitRoute: 'enrollments' }, /\/api\/video-os-lite\/enrollments/], [{ omitWorkflow: 'identityEnrollmentHashWorkflow' }, /identityEnrollmentHashWorkflow/]]) {
    const artifact = await makeArtifact(omit);
    try {
      await assert.rejects(() => authorizePreview({
        argv: argv(artifact.manifestPath),
        root: artifact.dir,
        deps: { captureSource: async () => SOURCE, restoreOutput: async () => { throw new Error('restored'); }, log() {}, logError() {} },
      }), pattern);
      await stat(artifact.output);
    } finally {
      await rm(artifact.dir, { recursive: true, force: true });
    }
  }
});

test('preview authorization makes no database check', async () => {
  for (const key of BLOCKED_ENV) assert.equal(process.env[key], undefined, key);
  const artifact = await makeArtifact();
  const calls = [];
  try {
    const result = await main({
      argv: ['node', 'authorize-release.mjs', '--target=preview', '--manifest', artifact.manifestPath],
      root: artifact.dir,
      deps: {
        captureSource: async () => SOURCE,
        restoreOutput: async () => {},
        log() {},
        logError() {},
        runMigrationCheck: () => { calls.push('db'); return { status: 0, stdout: '{}\n' }; },
      },
    });
    assert.equal(calls.length, 0);
    assert.equal(result.previewDeployAuthorized, true);
    assert.equal(result.routineDeployAuthorized, false);
    assert.equal(result.releaseAuthorized, false);
    assert.equal(explicitPreviewTarget(['node', 'authorize-release.mjs', '--owner-authorized']), false);
  } finally {
    await rm(artifact.dir, { recursive: true, force: true });
  }
});

test('production authorization still rejects a preview manifest before any database check', async () => {
  const artifact = await makeArtifact();
  const calls = [];
  try {
    await assert.rejects(() => main({
      argv: ['node', 'authorize-release.mjs', '--manifest', artifact.manifestPath, '--owner-authorized'],
      root: artifact.dir,
      deps: {
        captureSource: async () => SOURCE,
        restoreOutput: async () => { throw new Error('restored'); },
        log() {},
        logError() {},
        runMigrationCheck: () => { calls.push('db'); return { status: 0, stdout: '' }; },
      },
    }), /not a production candidate/);
    assert.equal(calls.length, 0);
    await stat(artifact.output);
  } finally {
    await rm(artifact.dir, { recursive: true, force: true });
  }
});

test('changed source identity is refused', async () => {
  const artifact = await makeArtifact();
  try {
    await assert.rejects(() => authorizePreview({
      argv: argv(artifact.manifestPath),
      root: artifact.dir,
      deps: {
        captureSource: async () => ({ ...SOURCE, sha256: 'other-source' }),
        restoreOutput: async () => { throw new Error('restored'); },
        log() {},
        logError() {},
      },
    }), /source identity/);
    await stat(artifact.output);
  } finally {
    await rm(artifact.dir, { recursive: true, force: true });
  }
});

test('an existing .vercel/output is left in place', async () => {
  const artifact = await makeArtifact();
  try {
    await mkdir(join(artifact.dir, '.vercel/output'), { recursive: true });
    await writeFile(join(artifact.dir, '.vercel/output/keep.txt'), 'keep');
    await assert.rejects(() => authorizePreview({
      argv: argv(artifact.manifestPath),
      root: artifact.dir,
      deps: { captureSource: async () => SOURCE, log() {}, logError() {} },
    }), /existing output/);
    assert.equal(await readFile(join(artifact.dir, '.vercel/output/keep.txt'), 'utf8'), 'keep');
    await stat(artifact.output);
  } finally {
    await rm(artifact.dir, { recursive: true, force: true });
  }
});

test('preview restore warns when the output is over 15000 files and still restores', async () => {
  assert.equal(previewUploadLimitWarning(VERCEL_PREBUILT_FILE_LIMIT), null);
  const warning = previewUploadLimitWarning(VERCEL_PREBUILT_FILE_LIMIT + 1);
  assert.match(warning, /15001 files/);
  assert.match(warning, /vercel deploy --prebuilt --archive=tgz/);
  assert.doesNotMatch(warning, /--prod/);
  const artifact = await makeArtifact();
  try {
    const records = Array.from({ length: VERCEL_PREBUILT_FILE_LIMIT + 1 }, (_, index) => ({
      path: `extra/${index}.txt`, bytes: 1, sha256: 'ab'.repeat(32),
    }));
    const manifest = JSON.parse(artifact.bytes.toString('utf8'));
    manifest.output.sha256 = fingerprint(records);
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(artifact.manifestPath, bytes);
    await writeFile(`${artifact.output}.release-build-manifest.json`, bytes);
    await writeFile(`${artifact.output}.packaging-success.json`, `${JSON.stringify({
      packagingComplete: true,
      releaseAuthorized: false,
      manifestSha256: createHash('sha256').update(bytes).digest('hex'),
      sourceSha256: manifest.source.sha256,
      outputSha256: manifest.output.sha256,
    })}\n`);
    const errors = [];
    const restored = [];
    const result = await authorizePreview({
      argv: argv(artifact.manifestPath),
      root: artifact.dir,
      deps: {
        captureSource: async () => SOURCE,
        inventory: async () => records,
        restoreOutput: async (from, to) => { restored.push([from, to]); },
        log() {},
        logError: message => errors.push(message),
      },
    });
    assert.equal(restored.length, 1);
    assert.equal(result.fileCount, 15001);
    assert.match(result.uploadLimitWarning, /15001/);
    assert.ok(errors.some(message => message.includes('15,000-file')));
    assert.equal(result.deployCommand, 'vercel deploy --prebuilt --archive=tgz');
  } finally {
    await rm(artifact.dir, { recursive: true, force: true });
  }
});

test('preview tooling does not reference database env or a production deploy', async () => {
  const source = await readFile(new URL('../tools/authorize-preview.mjs', import.meta.url), 'utf8');
  const limit = await readFile(new URL('../tools/preview-upload-limit.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /DATABASE_URL/);
  assert.doesNotMatch(source, /check-migrations/);
  assert.doesNotMatch(source, /child_process/);
  assert.doesNotMatch(source, /vercel deploy --prebuilt --prod/);
  assert.match(source, /PREVIEW_DEPLOY_COMMAND/);
  assert.match(limit, /export const PREVIEW_DEPLOY_COMMAND = 'vercel deploy --prebuilt --archive=tgz'/);
  assert.doesNotMatch(limit, /--prod/);
  const production = await readFile(new URL('../tools/authorize-release.mjs', import.meta.url), 'utf8');
  assert.match(production, /manifest\.target !== 'production'/);
  assert.match(production, /check-migrations\.mjs/);
  assert.match(production, /vercel deploy --prebuilt --prod/);
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['release:authorize-preview'], 'node tools/authorize-preview.mjs --target=preview');
  const build = await readFile(new URL('../tools/build-production.mjs', import.meta.url), 'utf8');
  assert.match(build, /target === 'preview'/);
  assert.match(build, /previewUploadLimitWarning\(releaseManifest\.output\.files/);
});
