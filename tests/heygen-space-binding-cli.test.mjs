import assert from 'node:assert/strict';
import test from 'node:test';
import { runSpaceBindingCli } from '../tools/bind-heygen-space.mjs';

const accountId = 'isolated-fixture-account';
const base = ['--environment', 'verification', '--account-id', accountId];
const privateDir = process.platform === 'win32' ? 'C:/private/probe' : '/private/probe';
async function run(args, repository) {
  let output = ''; let error = ''; let loads = 0;
  const result = await runSpaceBindingCli({ args,
    loadRepository: async () => { loads++; return repository; },
    stdout: { write: v => { output += v; } }, stderr: { write: v => { error += v; } },
  });
  return { ...result, output, error, loads };
}

test('production and unsupported commands reject before dependency loading', async () => {
  for (const args of [
    ['bootstrap', '--environment', 'production', '--account-id', accountId, '--private-evidence-dir', privateDir],
    ['execute', ...base], ['delete', ...base],
    ['status', ...base, '--verified', 'true'],
    ['status', ...base, '--database-url', 'postgres://untrusted'],
  ]) {
    const result = await run(args, {});
    assert.equal(result.exitCode, 1); assert.equal(result.loads, 0); assert.equal(result.output, '');
  }
});

test('bootstrap forwards only the application account and private evidence path', async () => {
  const branded = {};
  const result = await run(['bootstrap', ...base, '--private-evidence-dir', privateDir], {
    bootstrapVerifiedHeygenSpaceBinding: async input => {
      assert.deepEqual(input, { accountId, privateEvidenceDir: privateDir }); return branded;
    },
    safeHeygenSpaceBindingStatus: binding => {
      assert.equal(binding, branded);
      return { scopeType: 'space', environment: 'verification', runtimeActivation: false, verified: true, privateProfile: 'private-profile-must-not-print' };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.ok(!result.output.includes(accountId)); assert.ok(!result.output.includes(privateDir));
  assert.ok(!result.output.includes('private-profile-must-not-print'));
});

test('status resolves current authority instead of accepting serialized binding state', async () => {
  let calls = 0;
  const result = await run(['status', ...base], {
    resolveFreshHeygenSpaceBinding: async input => { calls++; assert.deepEqual(input, { accountId }); return {}; },
    safeHeygenSpaceBindingStatus: () => ({ scopeType: 'space', environment: 'verification', runtimeActivation: false }),
  });
  assert.equal(result.exitCode, 0); assert.equal(calls, 1);
});

test('CLI suppresses database/provider error payloads and rejects unsafe status', async () => {
  const failed = await run(['status', ...base], { resolveFreshHeygenSpaceBinding: async () => { throw new Error('postgres://private-secret private@example.test'); } });
  assert.equal(failed.exitCode, 1); assert.ok(!failed.error.includes('private-secret')); assert.ok(!failed.error.includes('private@example.test'));
  const unsafe = await run(['status', ...base], { resolveFreshHeygenSpaceBinding: async () => ({}), safeHeygenSpaceBindingStatus: () => ({ scopeType: 'space', environment: 'production', runtimeActivation: true }) });
  assert.equal(unsafe.exitCode, 1); assert.equal(unsafe.output, '');
});

test('production bootstrap requires --owner-authorized and wires the confirmation phrase through to the repository', async () => {
  const withoutFlag = await run(
    ['bootstrap', '--environment', 'production', '--account-id', accountId, '--private-evidence-dir', privateDir],
    {},
  );
  assert.equal(withoutFlag.exitCode, 1);
  assert.equal(withoutFlag.loads, 0, 'must fail before even loading the repository');

  const branded = {};
  let observedConfirmation;
  const result = await run(
    ['bootstrap', '--environment', 'production', '--account-id', accountId, '--private-evidence-dir', privateDir, '--owner-authorized'],
    {
      PRODUCTION_BINDING_CONFIRMATION_PHRASE: 'confirmation-phrase-from-repository',
      bootstrapVerifiedHeygenSpaceBinding: async input => {
        observedConfirmation = process.env.VIDEO_OS_PRODUCTION_BINDING_CONFIRMED;
        assert.deepEqual(input, { accountId, privateEvidenceDir: privateDir });
        return branded;
      },
      safeHeygenSpaceBindingStatus: binding => {
        assert.equal(binding, branded);
        return { scopeType: 'space', environment: 'production', runtimeActivation: false, verified: true };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(observedConfirmation, 'confirmation-phrase-from-repository', 'CLI must forward the repository\'s own exported phrase, not a duplicated string');
  assert.equal(process.env.VIDEO_OS_SPACE_BINDING_ENVIRONMENT, 'production');
});
