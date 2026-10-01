import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DISABLED_EXIT_CODE, runCli } from '../tools/verify-p0-release-gate.mjs';

const toolPath = fileURLToPath(new URL('../tools/verify-p0-release-gate.mjs', import.meta.url));
const proofsDir = fileURLToPath(new URL('../docs/proofs/', import.meta.url));

function p0ReceiptInventory() {
  if (!existsSync(proofsDir)) return [];
  return readdirSync(proofsDir)
    .filter((name) => /^p0-release-gate-receipt-.*\.json$/u.test(name))
    .sort();
}

const historicalReceiptInventory = p0ReceiptInventory();

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p0-verifier-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function invoke(args, cwd) {
  const result = spawnSync(process.execPath, [toolPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

function assertFailClosed(result, sensitiveValues = []) {
  assert.equal(result.status, DISABLED_EXIT_CODE);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /P0.*DISABLED/is);
  assert.match(output, /No evidence was read, accepted, or written/i);
  assert.doesNotMatch(output, /gate cleared|criteria satisfied|receipt generated successfully/i);
  assert.doesNotMatch(output, /\b(?:APPROVED|VERIFIED)\b/i);
  for (const value of sensitiveValues) {
    assert.doesNotMatch(output, new RegExp(value, 'iu'));
  }
  assert.deepEqual(p0ReceiptInventory(), historicalReceiptInventory);
}

test('module import has no CLI output, exit mutation, or receipt side effect', async () => {
  await withTempDir(async (dir) => {
    const harnessPath = path.join(dir, 'import-harness.mjs');
    const toolUrl = pathToFileURL(toolPath).href;
    await writeFile(
      harnessPath,
      `await import(${JSON.stringify(toolUrl)});\nprocess.stdout.write('import-safe\\n');\n`,
      'utf8',
    );

    const result = spawnSync(process.execPath, [harnessPath], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'import-safe\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(readdirSync(dir).sort(), ['import-harness.mjs']);
    assert.deepEqual(p0ReceiptInventory(), historicalReceiptInventory);
  });
});

test('help describes the disabled gate and authentic future proof prerequisite', async () => {
  await withTempDir(async (dir) => {
    const result = invoke(['--help'], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /verification is DISABLED/i);
    assert.match(result.stdout, /owner-authorized production run/i);
    assert.match(result.stdout, /writes no artifact/i);
    assert.doesNotMatch(result.stdout, /gate cleared|criteria satisfied/i);
    assert.equal(result.stderr, '');
    assert.deepEqual(readdirSync(dir), []);
    assert.deepEqual(p0ReceiptInventory(), historicalReceiptInventory);
  });
});

test('missing evidence exits nonzero and writes no artifact', async () => {
  await withTempDir(async (dir) => {
    const result = invoke([], dir);
    assertFailClosed(result);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test('legacy positional job and account IDs cannot clear the gate or leak identifiers', async () => {
  await withTempDir(async (dir) => {
    const jobId = 'job-sensitive-legacy-7851';
    const accountId = 'account-sensitive-legacy-9246';
    const result = invoke([jobId, accountId], dir);
    assertFailClosed(result, [jobId, accountId]);
    assert.deepEqual(readdirSync(dir), []);
  });
});

const rejectedEvidenceCases = [
  {
    name: 'forged self-asserted receipt',
    payload: {
      signoff: { status: 'APPROVED' },
      observations: { provider: { status: 'VERIFIED' } },
    },
    args: ['--receipt', 'evidence.json'],
  },
  {
    name: 'stale receipt',
    payload: {
      capturedAt: '2020-01-01T00:00:00.000Z',
      deploymentId: 'deployment-stale-4821',
    },
    args: ['--receipt', 'evidence.json', '--deployment', 'deployment-stale-4821'],
    sensitive: ['deployment-stale-4821'],
  },
  {
    name: 'wrong-account receipt',
    payload: {
      accountHash: 'account-wrong-7712',
      jobId: 'job-expected-0042',
      deploymentId: 'deployment-expected-5513',
    },
    args: ['--receipt', 'evidence.json', '--account', 'account-expected-6394'],
    sensitive: ['account-expected-6394'],
  },
  {
    name: 'wrong-job receipt',
    payload: {
      accountHash: 'account-expected-6394',
      jobId: 'job-wrong-8930',
      deploymentId: 'deployment-expected-5513',
    },
    args: ['--receipt', 'evidence.json', '--job', 'job-expected-0042'],
    sensitive: ['job-expected-0042'],
  },
  {
    name: 'wrong-deployment receipt',
    payload: {
      accountHash: 'account-expected-6394',
      jobId: 'job-expected-0042',
      deploymentId: 'deployment-wrong-2188',
    },
    args: ['--receipt', 'evidence.json', '--deployment', 'deployment-expected-5513'],
    sensitive: ['deployment-expected-5513'],
  },
];

for (const evidenceCase of rejectedEvidenceCases) {
  test(`${evidenceCase.name} exits nonzero and cannot create a receipt`, async () => {
    await withTempDir(async (dir) => {
      const evidencePath = path.join(dir, 'evidence.json');
      const outputPath = path.join(dir, 'candidate-receipt.json');
      await writeFile(evidencePath, JSON.stringify(evidenceCase.payload), 'utf8');

      const result = invoke(
        [...evidenceCase.args, '--output', outputPath],
        dir,
      );

      assertFailClosed(result, evidenceCase.sensitive);
      assert.deepEqual(readdirSync(dir).sort(), ['evidence.json']);
      assert.equal(existsSync(outputPath), false);
    });
  });
}

test('runCli is injectable and remains fail closed without touching process state', () => {
  let stdout = '';
  let stderr = '';
  const originalExitCode = process.exitCode;
  const code = runCli(['--receipt', 'untrusted.json'], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(code, DISABLED_EXIT_CODE);
  assert.equal(stdout, '');
  assert.match(stderr, /DISABLED/i);
  assert.equal(process.exitCode, originalExitCode);
});
