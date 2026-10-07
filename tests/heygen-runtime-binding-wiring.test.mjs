import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertIdentitySubmissionAllowed,
  assertIdentityProviderReadClaim,
  createIdentityProviderBindingBoundary,
} from '../routes/video-os-lite/identities.js';
import { assertProviderAvatarConsentClaim, assertProviderVideoReadClaim } from '../workflows/video-render.js';

const ACCOUNT_ID = 'runtime-binding-account';

test('identity runtime resolves before claim and resolution failure prevents claim', async () => {
  const calls = [];
  const boundary = createIdentityProviderBindingBoundary({
    resolveFreshHeygenSpaceBinding: async ({ accountId }) => {
      calls.push(['resolve', accountId]);
      throw Object.assign(new Error('binding unavailable'), { failureCategory: 'RECONCILIATION' });
    },
    claimEnrollmentProviderOperation: async () => { calls.push(['claim']); },
    assertFreshHeygenSpaceBinding: () => { calls.push(['assert']); },
  });
  await assert.rejects(
    boundary.claim({ accountId: ACCOUNT_ID, identityId: 'identity-1', component: 'avatar', stage: 'asset', operationKey: 'operation-1' }),
    /binding unavailable/,
  );
  assert.deepEqual(calls, [['resolve', ACCOUNT_ID]]);
});

test('identity mutations remain hard-disabled even when legacy provider flags are enabled', () => {
  const names = [
    'HEYGEN_API_KEY', 'HEYGEN_TOKEN', 'VIDEO_OS_IDENTITY_PROVIDER_ENABLED',
    'HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED', 'VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID',
  ];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.HEYGEN_API_KEY = 'test-only-key';
    delete process.env.HEYGEN_TOKEN;
    process.env.VIDEO_OS_IDENTITY_PROVIDER_ENABLED = 'true';
    process.env.HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED = 'true';
    process.env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID = ACCOUNT_ID;
    assert.throws(
      () => assertIdentitySubmissionAllowed(ACCOUNT_ID),
      { failureCategory: 'IDENTITY_PROVIDER_DISABLED', statusCode: 503 },
    );
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test('identity asset and create claims resolve distinct bindings and assert immediately before mutation', async () => {
  const calls = [];
  let sequence = 0;
  const boundary = createIdentityProviderBindingBoundary({
    resolveFreshHeygenSpaceBinding: async () => {
      const binding = Object.freeze({ sequence: ++sequence });
      calls.push(['resolve', binding.sequence]);
      return binding;
    },
    claimEnrollmentProviderOperation: async input => {
      calls.push(['claim', input.stage, input.providerBinding.sequence]);
      return { stage: input.stage };
    },
    assertFreshHeygenSpaceBinding: binding => calls.push(['assert', binding.sequence]),
  });
  const asset = await boundary.claim({ accountId: ACCOUNT_ID, identityId: 'identity-1', component: 'avatar', stage: 'asset', operationKey: 'operation-1' });
  const create = await boundary.claim({ accountId: ACCOUNT_ID, identityId: 'identity-1', component: 'avatar', stage: 'create', operationKey: 'operation-1' });
  assert.notStrictEqual(asset.providerBinding, create.providerBinding);
  assert.deepEqual(calls, [
    ['resolve', 1], ['claim', 'asset', 1],
    ['resolve', 2], ['claim', 'create', 2],
  ]);
  const result = boundary.mutate(create.providerBinding, () => { calls.push(['provider', 2]); return 'submitted'; });
  assert.equal(result, 'submitted');
  assert.deepEqual(calls.slice(-2), [['assert', 2], ['provider', 2]]);

  let providerCalls = 0;
  const stale = createIdentityProviderBindingBoundary({
    resolveFreshHeygenSpaceBinding: async () => Object.freeze({ stale: true }),
    claimEnrollmentProviderOperation: async () => ({}),
    assertFreshHeygenSpaceBinding: () => { throw Object.assign(new Error('stale'), { code: 'HEYGEN_SPACE_BINDING_STALE' }); },
  });
  const claimed = await stale.claim({ accountId: ACCOUNT_ID, identityId: 'identity-1', component: 'voice', stage: 'create', operationKey: 'operation-2' });
  assert.throws(() => stale.mutate(claimed.providerBinding, () => { providerCalls += 1; }), { code: 'HEYGEN_SPACE_BINDING_STALE' });
  assert.equal(providerCalls, 0);
});

test('delayed provider-read proofs reject copied and cross-resource identities before HTTP', () => {
  const identityClaim = Object.freeze({
    version: 'heygen-identity-read-claim/v1',
    accountId: ACCOUNT_ID,
    identityId: 'identity-1',
    component: 'voice',
    operationKey: 'operation-1',
    providerAvatarGroupId: null,
    providerRenderableAvatarId: null,
    providerVoiceId: 'voice-1',
    resourceIds: Object.freeze(['resource-1']),
  });
  assert.strictEqual(assertIdentityProviderReadClaim(identityClaim, { accountId: ACCOUNT_ID, identityId: 'identity-1', component: 'voice' }), identityClaim);
  assert.throws(
    () => assertIdentityProviderReadClaim(structuredClone(identityClaim), { accountId: ACCOUNT_ID, identityId: 'identity-1', component: 'voice' }),
    { code: 'PROVIDER_CLAIM_SOURCE_MISMATCH' },
  );
  assert.throws(
    () => assertIdentityProviderReadClaim(identityClaim, { accountId: ACCOUNT_ID, identityId: 'other-identity', component: 'voice' }),
    { code: 'PROVIDER_CLAIM_SOURCE_MISMATCH' },
  );

  const binding = Object.freeze({ applicationAccountId: ACCOUNT_ID });
  const job = Object.freeze({ id: 'job-1', accountId: ACCOUNT_ID, provider: 'heygen', providerJobId: 'video-1', status: 'provider_rendering' });
  const videoClaim = Object.freeze({
    version: 'heygen-video-read-claim/v1',
    job,
    providerJobId: 'video-1',
    operationId: 'operation-1',
    resourceId: 'resource-1',
    sourceUrlDigest: null,
  });
  assert.strictEqual(assertProviderVideoReadClaim(videoClaim, binding, { jobId: 'job-1', providerJobId: 'video-1' }), videoClaim);
  assert.throws(
    () => assertProviderVideoReadClaim(videoClaim, binding, { jobId: 'job-1', providerJobId: 'different-video' }),
    { failureCategory: 'PROVIDER_OPERATION_CONFLICT' },
  );
  assert.throws(
    () => assertProviderVideoReadClaim(structuredClone(videoClaim), binding, { jobId: 'job-1', providerJobId: 'video-1' }),
    { failureCategory: 'PROVIDER_OPERATION_CONFLICT' },
  );
  const readyClaim = Object.freeze({
    ...videoClaim,
    job: Object.freeze({ ...job, status: 'provider_ready' }),
    sourceUrlDigest: 'd'.repeat(64),
  });
  assert.strictEqual(assertProviderVideoReadClaim(readyClaim, binding, { jobId: 'job-1', providerJobId: 'video-1' }), readyClaim);
  assert.throws(
    () => assertProviderVideoReadClaim(Object.freeze({ ...readyClaim, sourceUrlDigest: null }), binding, { jobId: 'job-1', providerJobId: 'video-1' }),
    { failureCategory: 'PROVIDER_OPERATION_CONFLICT' },
  );
});

test('actual route and Workflow keep bindings local to each Node mutation boundary', async () => {
  const identitySource = await readFile(new URL('../routes/video-os-lite/identities.js', import.meta.url), 'utf8');
  assert.equal((identitySource.match(/identityProviderBindingBoundary\.claim\(/g) || []).length, 3);
  assert.equal((identitySource.match(/identityProviderBindingBoundary\.mutate\(/g) || []).length, 6);
  assert.match(identitySource, /stage:\s*'asset'/);
  assert.equal((identitySource.match(/stage:\s*'create'/g) || []).length >= 2, true);
  const submitComponentAt = identitySource.indexOf('async function submitComponent');
  const reservationResolution = identitySource.indexOf('const reservationBinding = await resolveFreshHeygenSpaceBinding', submitComponentAt);
  const reservationWrite = identitySource.indexOf('await reserveIdentityComponentCreation', submitComponentAt);
  assert.equal(submitComponentAt >= 0 && reservationResolution > submitComponentAt && reservationResolution < reservationWrite, true);
  assert.match(identitySource, /prepareIdentityProviderRead[\s\S]{0,500}getHeygenPhotoAvatarStatus/);
  assert.match(identitySource, /proxyVoicePreview[\s\S]{0,900}prepareIdentityProviderRead[\s\S]{0,500}getHeygenVoiceStatus/);

  const workflowSource = await readFile(new URL('../workflows/video-render.js', import.meta.url), 'utf8');
  assert.match(workflowSource, /export async function submitProvider\(jobId\)\s*{\s*'use step';/);
  assert.match(workflowSource, /videoRenderWorkflow\(jobId\)[\s\S]*submitProvider\(jobId\)/);
  assert.doesNotMatch(workflowSource, /videoRenderWorkflow\([^)]*providerBinding/);
  const providerJobGuard = workflowSource.indexOf('if (job.providerJobId)');
  const claimedStatusGuard = workflowSource.indexOf("if (job.status === 'provider_submitting'");
  const legacyHold = workflowSource.indexOf("code: 'LEGACY_PROVIDER_RESOURCE_UNREGISTERED'");
  const freshClaim = workflowSource.indexOf('providerBinding = await resolveFreshHeygenSpaceBinding');
  const identityConsentRead = workflowSource.indexOf('await prepareIdentityProviderRead', freshClaim);
  const providerConsentRead = workflowSource.indexOf('await getHeygenPhotoAvatarStatus', identityConsentRead);
  const databaseClaim = workflowSource.indexOf("stageTo: 'provider_submitting'", freshClaim);
  assert.ok(freshClaim < identityConsentRead && identityConsentRead < providerConsentRead && providerConsentRead < databaseClaim, 'exact group consent readback must precede the paid provider claim');
  const freshAssertion = workflowSource.indexOf('assertFreshHeygenSpaceBinding(providerBinding)', databaseClaim);
  const providerSubmit = workflowSource.indexOf('submitHeygen(claimedJob)', freshAssertion);
  assert.equal(providerJobGuard > 0 && providerJobGuard < freshClaim, true);
  assert.equal(claimedStatusGuard > providerJobGuard && claimedStatusGuard < freshClaim, true);
  assert.equal(legacyHold > claimedStatusGuard && legacyHold < freshClaim, true);
  assert.equal(freshClaim < databaseClaim && databaseClaim < freshAssertion && freshAssertion < providerSubmit, true);
  assert.match(workflowSource, /stageTo:\s*'provider_submitted'[\s\S]{0,180}providerBinding/);
  assert.match(workflowSource, /stageTo:\s*'provider_submit_unknown'[\s\S]{0,220}providerBinding/);
  assert.doesNotMatch(workflowSource, /submitHeygen\(\{\s*\.\.\.job/);
  assert.match(workflowSource, /prepareProviderVideoRead[\s\S]{0,500}pollHeygen\(readClaim\.providerJobId\)/);
  assert.match(workflowSource, /providerSourceUrlDigest[\s\S]{0,500}stageTo:\s*'provider_ready'/);
  assert.match(workflowSource, /prepareProviderVideoFinish[\s\S]{0,700}readClaim\.sourceUrlDigest/);
  assert.match(workflowSource, /finalizeReadyJob\(jobId, artifact, \{ providerBinding \}\)/);
});

test('runtime dependency injection is unavailable outside the captured Node test context', () => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const script = `
    import { createIdentityProviderBindingBoundary } from './routes/video-os-lite/identities.js';
    const codes = [];
    for (const operation of [
      () => createIdentityProviderBindingBoundary({ resolveFreshHeygenSpaceBinding() {} }),
    ]) {
      try { operation(); codes.push('UNEXPECTED_SUCCESS'); }
      catch (error) { codes.push(error.failureCategory); }
    }
    console.log(JSON.stringify(codes));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ['CONFIG_MISSING']);
});

test('provider avatar consent claim requires the exact owned group and look before paid submission', () => {
  const job = { accountId: ACCOUNT_ID, input: { identityId: 'identity-1', avatar: { avatarId: 'look-1' } } };
  const readClaim = { accountId: ACCOUNT_ID, identityId: 'identity-1', providerAvatarGroupId: 'group-1', providerRenderableAvatarId: 'look-1' };
  const provider = { ready: true, avatarGroup: { providerGroupId: 'group-1' }, avatarLook: { providerLookId: 'look-1' } };
  assert.equal(assertProviderAvatarConsentClaim(job, readClaim, provider), true);
  for (const [claim, status] of [
    [readClaim, { ...provider, ready: false }],
    [{ ...readClaim, accountId: 'other-account' }, provider],
    [{ ...readClaim, providerRenderableAvatarId: 'other-look' }, provider],
    [readClaim, { ...provider, avatarGroup: { providerGroupId: 'other-group' } }],
  ]) {
    assert.throws(() => assertProviderAvatarConsentClaim(job, claim, status), { failureCategory: 'CONSENT' });
  }
});
