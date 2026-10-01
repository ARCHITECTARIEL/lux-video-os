import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateStripeReconciliationResponse } from '../tools/check-stripe-reconciliation-response.mjs';

const cli = fileURLToPath(new URL('../tools/check-stripe-reconciliation-response.mjs', import.meta.url));

function response({ mismatchCount = 0, mismatches = [], ...reconciliation } = {}) {
  return {
    ok: true,
    reconciliation: {
      lookbackHours: 48,
      sessionsChecked: 3,
      creditTransactionsChecked: 3,
      mismatchCount,
      mismatches,
      ...reconciliation,
    },
  };
}

test('reconciliation response gate accepts only an explicit, internally consistent zero-mismatch result', () => {
  assert.deepEqual(
    evaluateStripeReconciliationResponse({ httpStatus: 200, body: response() }),
    { sessionsChecked: 3, creditTransactionsChecked: 3, mismatchCount: 0 },
  );
});

test('reconciliation response gate rejects a nonzero mismatch result even when HTTP is 200 and ok is true', () => {
  assert.throws(
    () => evaluateStripeReconciliationResponse({
      httpStatus: 200,
      body: response({ mismatchCount: 1, mismatches: [{ type: 'missing_grant', accountId: 'private-account' }] }),
    }),
    /reported 1 mismatch/i,
  );
});

test('reconciliation response gate fails closed on malformed JSON shape and missing count fields', () => {
  assert.throws(
    () => evaluateStripeReconciliationResponse({ httpStatus: 200, body: { ok: true } }),
    /missing the reconciliation/i,
  );
  assert.throws(
    () => evaluateStripeReconciliationResponse({
      httpStatus: 200,
      body: response({ sessionsChecked: undefined }),
    }),
    /sessionsChecked must be a non-negative integer/i,
  );
  assert.throws(
    () => evaluateStripeReconciliationResponse({
      httpStatus: 200,
      body: response({ mismatchCount: 0, mismatches: [{ type: 'unexpected' }] }),
    }),
    /inconsistent/i,
  );
});

test('reconciliation response gate rejects non-200 responses and ok=false', () => {
  assert.throws(
    () => evaluateStripeReconciliationResponse({ httpStatus: 503, body: { ok: false, error: 'configuration missing' } }),
    /HTTP 503/i,
  );
  assert.throws(
    () => evaluateStripeReconciliationResponse({ httpStatus: 200, body: { ok: false, reconciliation: {} } }),
    /ok=true/i,
  );
});

test('CLI fails without echoing private mismatch payloads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'stripe-reconciliation-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'response.json');
  await writeFile(file, JSON.stringify(response({
    mismatchCount: 1,
    mismatches: [{ type: 'missing_grant', accountId: 'acct-private-value', sessionId: 'cs-private-value' }],
  })));

  const result = spawnSync(process.execPath, [cli, '--status', '200', '--file', file], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reported 1 mismatch/i);
  assert.doesNotMatch(result.stderr, /acct-private-value|cs-private-value/);
  assert.equal(result.stdout, '');
});

test('CLI rejects malformed JSON and reports a clean zero-count result', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'stripe-reconciliation-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const malformed = join(directory, 'malformed.json');
  const clean = join(directory, 'clean.json');
  await writeFile(malformed, '{broken');
  await writeFile(clean, JSON.stringify(response()));

  const bad = spawnSync(process.execPath, [cli, '--status', '200', '--file', malformed], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not valid JSON/i);

  const good = spawnSync(process.execPath, [cli, '--status', '200', '--file', clean], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /mismatches=0/);
});

test('scheduled workflow invokes the gate, fails on missing config, and never dumps the response payload', async () => {
  const workflow = await readFile(new URL('../.github/workflows/stripe-reconciliation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node tools\/check-stripe-reconciliation-response\.mjs --status "\$status" --file response\.json/);
  assert.match(workflow, /configuration is incomplete[\s\S]*exit 1/);
  assert.doesNotMatch(workflow, /cat\s+response\.json/);
});

test('Stripe setup does not derive or print an account identifier', async () => {
  const setup = await readFile(new URL('../tools/setup-stripe-products.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(setup, /STRIPE_ACCOUNT_ID|Target account|console\.(?:log|error)\([^\n]*accountId/i);
});
