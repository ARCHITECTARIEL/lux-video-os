import assert from 'node:assert/strict';
import test from 'node:test';
import { runQualificationCli } from '../tools/qualify-heygen-account.mjs';

const args = ['--expected-suffix', 'TEST', '--expected-email', 'owner@example.test', '--expected-created-date', '2026-09-21'];
const receipt = () => ({
  version: 'heygen-account-qualification/v1', observedAt: '2026-10-01T12:00:00.000Z',
  credentialKeyFingerprint: 'a'.repeat(64), credentialScopeFingerprint: 'b'.repeat(64),
  publicSummary: { credentialStatus: 'active', holds: [{ code: 'STABLE_PROVIDER_ACCOUNT_ID_UNAVAILABLE' }] },
  privateEvidence: { keyId: 'private-key-id', createdAt: '2026-09-21T12:00:00.000Z', profile: { email: 'owner@example.test', username: 'private-user' } },
});
async function run(overrides = {}) {
  let out = ''; let err = '';
  const result = await runQualificationCli({ args, env: { HEYGEN_API_KEY: 'synthetic-secret-TEST' },
    dependencies: { qualify: async () => receipt() },
    stdout: { write: value => { out += value; } }, stderr: { write: value => { err += value; } }, ...overrides });
  return { ...result, out, err };
}

test('missing, mismatched and ambiguous credentials never reach HeyGen', async () => {
  for (const env of [{}, { HEYGEN_API_KEY: 'wrong-key' }, { HEYGEN_API_KEY: 'one-TEST', HEYGEN_TOKEN: 'two-TEST' }]) {
    const result = await run({ env, dependencies: { qualify: () => assert.fail('No request allowed') } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.out, '');
    assert.ok(!result.err.includes('one-TEST'));
  }
});

test('matched credential/profile remains held and stdout never contains private identity', async () => {
  const result = await run();
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.result.matchChecks, { keySuffix: true, profileEmail: true, createdDate: true });
  assert.equal(result.result.bindingEligible, false);
  assert.equal(result.result.databaseBindingWritten, false);
  for (const value of ['owner@example.test', 'private-user', 'private-key-id', 'synthetic-secret']) assert.ok(!result.out.includes(value));
});

test('wrong profile or key creation date produces explicit holds', async () => {
  const result = await run({ dependencies: { qualify: async () => {
    const value = receipt(); value.privateEvidence.profile.email = 'other@example.test'; value.privateEvidence.createdAt = '2026-09-22T01:00:00.000Z'; return value;
  } } });
  assert.ok(result.result.holds.some(hold => hold.code === 'EXPECTED_PROFILE_NOT_CONFIRMED'));
  assert.ok(result.result.holds.some(hold => hold.code === 'EXPECTED_KEY_CREATION_DATE_MISMATCH'));
});

test('provider exceptions cannot echo secrets, URLs or private profile data', async () => {
  const result = await run({ dependencies: { qualify: async () => { throw new Error('synthetic-secret-TEST owner@example.test https://private.example'); } } });
  assert.equal(result.exitCode, 1);
  for (const value of ['synthetic-secret', 'owner@example.test', 'private.example']) assert.ok(!result.err.includes(value));
});

test('external credential file does not load unrelated variables or default env files', async () => {
  const filename = process.platform === 'win32' ? 'C:/private/heygen.env' : '/private/heygen.env';
  let read = 0;
  const result = await run({ args: [...args, '--credential-env', filename], env: {}, dependencies: {
    lstat: async path => { assert.equal(path, filename); return { isFile: () => true, isSymbolicLink: () => false, size: 100 }; },
    readFile: async path => { assert.equal(path, filename); read++; return 'HEYGEN_API_KEY=synthetic-secret-TEST\nDATABASE_URL=unused'; },
    qualify: async input => { assert.deepEqual(Object.keys(input), ['apiKey']); return receipt(); },
  } });
  assert.equal(result.exitCode, 0); assert.equal(read, 1);
});
