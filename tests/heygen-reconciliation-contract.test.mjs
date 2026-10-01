import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import {
  HEYGEN_RECONCILIATION_APPROVAL_VERSION,
  HEYGEN_RECONCILIATION_ENVELOPE_VERSION,
  HEYGEN_RECONCILIATION_SNAPSHOT_VERSION,
  assertVerifiedApproval,
  canonicalApprovalPayloadBytes,
  canonicalApprovalSigningBytes,
  canonicalJsonBytes,
  createReconciliationPlan,
  redactPlan,
  verifyApproval,
} from '../lib/heygen-reconciliation-contract.js';

const SOURCE_SHA = '1'.repeat(64);
const ADAPTER_SHA = '2'.repeat(64);
const DATABASE_SHA = '3'.repeat(64);
const SCOPE_SHA = '4'.repeat(64);
const ASSET_MEDIA_SHA = 'a'.repeat(64);
const VOICE_MEDIA_SHA = 'b'.repeat(64);
const CREATED_AT = '2026-09-30T12:00:00.000Z';
const EXPIRES_AT = '2026-10-01T12:00:00.000Z';

function snapshot(overrides = {}) {
  const value = {
    version: HEYGEN_RECONCILIATION_SNAPSHOT_VERSION,
    capturedAt: CREATED_AT,
    candidate: {
      candidateId: `source:${SOURCE_SHA}`,
      sourceSha256: SOURCE_SHA,
      adapterSha256: ADAPTER_SHA,
    },
    target: {
      environment: 'preview',
      projectId: 'lux-video-os-preview',
      applicationAccountId: 'account-1',
      databaseBindingSha256: DATABASE_SHA,
      provider: 'heygen',
      providerAccountFingerprint: 'heygen-account-fingerprint',
      providerAccountBindingState: 'verified',
      credentialScopeFingerprint: SCOPE_SHA,
      apiVersion: 'v3',
    },
    resources: [
      {
        resourceKey: 'resource-asset',
        accountId: 'account-1',
        kind: 'asset',
        providerResourceId: 'asset-provider-1',
        originOperationId: 'operation-upload',
        state: 'ready',
        sourceSha256: ASSET_MEDIA_SHA,
        sourceBytes: 1_024,
        dependencies: ['resource-voice'],
      },
      {
        resourceKey: 'resource-voice',
        accountId: 'account-1',
        kind: 'voice',
        providerResourceId: 'voice-provider-1',
        originOperationId: 'operation-voice',
        state: 'ready',
        sourceSha256: VOICE_MEDIA_SHA,
        sourceBytes: 2_048,
        voiceNamespace: 'instant',
      },
    ],
    references: [
      {
        referenceId: 'reference-released',
        accountId: 'account-1',
        resourceKey: 'resource-asset',
        consumerKind: 'enrollment',
        consumerId: 'enrollment-1',
        state: 'released',
      },
    ],
    operations: [
      {
        operationId: 'operation-upload',
        accountId: 'account-1',
        kind: 'asset_upload',
        state: 'succeeded',
        resourceKeys: ['resource-asset'],
      },
      {
        operationId: 'operation-voice',
        accountId: 'account-1',
        kind: 'voice_clone',
        state: 'succeeded',
        resourceKeys: ['resource-voice'],
      },
    ],
  };
  return { ...value, ...overrides };
}

function makePlan(snapshotValue = snapshot(), options = {}) {
  return createReconciliationPlan(snapshotValue, {
    requestedActions: [{ resourceKey: 'resource-asset', verbs: ['readback', 'delete', 'read'] }],
    expiresAt: EXPIRES_AT,
    cohortId: 'disposable-canary-a',
    ...options,
  });
}

function claims(plan, overrides = {}) {
  return {
    version: HEYGEN_RECONCILIATION_APPROVAL_VERSION,
    planDigest: plan.digest,
    candidate: plan.candidate,
    target: plan.target,
    resources: plan.resources.map(({ resourceKey, kind, providerResourceId, verbs }) => ({ resourceKey, kind, providerResourceId, verbs })),
    budget: { maxProviderCalls: 3, maxSpendMicrousd: 0 },
    issuedAt: '2026-09-30T12:01:00.000Z',
    expiresAt: plan.expiresAt,
    nonce: 'nonce-1',
    cohortId: plan.cohortId,
    ...overrides,
  };
}

function envelopeFor(claimValue, privateKey, overrides = {}) {
  const payload = canonicalApprovalPayloadBytes(claimValue);
  const signature = sign(null, canonicalApprovalSigningBytes('owner-key-1', claimValue), privateKey);
  return canonicalJsonBytes({
    version: HEYGEN_RECONCILIATION_ENVELOPE_VERSION,
    kid: 'owner-key-1',
    payload: payload.toString('base64url'),
    signature: signature.toString('base64url'),
    ...overrides,
  });
}

function trust(plan, publicKey, overrides = {}) {
  return {
    plan,
    pinnedKeys: { 'owner-key-1': publicKey },
    expectedBudget: { maxProviderCalls: 3, maxSpendMicrousd: 0 },
    now: '2026-09-30T12:02:00.000Z',
    nonceState: { nonce: 'nonce-1', status: 'fresh' },
    approvalStatus: 'active',
    ...overrides,
  };
}

test('createReconciliationPlan builds a deterministic private plan from normalized resource keys', () => {
  const first = makePlan();
  const reordered = snapshot({
    resources: [...snapshot().resources].reverse(),
    operations: [...snapshot().operations].reverse(),
  });
  const second = makePlan(reordered);

  assert.equal(first.digest, second.digest);
  assert.equal(first.version, 'heygen-reconciliation-plan/v1');
  assert.deepEqual(first.blockers, []);
  assert.deepEqual(first.resources[0].verbs, ['delete', 'read', 'readback']);
  assert.equal(first.candidate.sourceSha256, SOURCE_SHA, 'candidate source remains the code-tree digest');
  assert.deepEqual(
    { sourceSha256: first.resources[0].sourceSha256, sourceBytes: first.resources[0].sourceBytes },
    { sourceSha256: ASSET_MEDIA_SHA, sourceBytes: 1_024 },
    'resource media provenance is independently bound',
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.target), true);
});

test('plan requests cannot introduce provider IDs, URLs, or unknown resource keys', () => {
  assert.throws(() => makePlan(snapshot(), {
    requestedActions: [{ resourceKey: 'resource-asset', providerResourceId: 'caller-id', verbs: ['read'] }],
  }), { code: 'UNKNOWN_CONTRACT_FIELD' });
  assert.throws(() => makePlan(snapshot(), {
    requestedActions: [{ resourceKey: 'https://evil.example/id', verbs: ['read'] }],
  }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => makePlan(snapshot(), {
    requestedActions: [{ resourceKey: 'resource-invented', verbs: ['read'] }],
  }), { code: 'UNKNOWN_RESOURCE_KEY' });
  for (const dependencies of [false, 0, '']) {
    const malformed = snapshot();
    malformed.resources[0] = { ...malformed.resources[0], dependencies };
    assert.throws(() => makePlan(malformed), { code: 'INVALID_CONTRACT' });
  }
});

test('provisional provider identity, cross-account data, active references, and professional voices fail closed as blockers', () => {
  const unsafe = snapshot();
  unsafe.target = {
    ...unsafe.target,
    providerAccountFingerprint: null,
    providerAccountBindingState: 'provisional',
    credentialScopeFingerprint: null,
  };
  unsafe.resources[0] = { ...unsafe.resources[0], accountId: 'other-account' };
  unsafe.resources[1] = { ...unsafe.resources[1], voiceNamespace: 'professional' };
  unsafe.references[0] = { ...unsafe.references[0], state: 'active' };
  unsafe.operations.push({
    operationId: 'operation-ambiguous',
    accountId: 'account-1',
    kind: 'voice_clone',
    state: 'ambiguous',
    resourceKeys: [],
  });
  unsafe.operations.push({
    operationId: 'operation-reserved',
    accountId: 'account-1',
    kind: 'asset_upload',
    state: 'reserved',
    resourceKeys: [],
  });
  const plan = createReconciliationPlan(unsafe, {
    requestedActions: [
      { resourceKey: 'resource-asset', verbs: ['read', 'delete', 'readback'] },
      { resourceKey: 'resource-voice', verbs: ['read', 'delete', 'readback'] },
    ],
    expiresAt: EXPIRES_AT,
    cohortId: 'disposable-canary-a',
  });
  const codes = new Set(plan.blockers.map((item) => item.code));
  for (const code of [
    'PROVIDER_ACCOUNT_BINDING_NOT_VERIFIED',
    'MISSING_PROVIDER_ACCOUNT_BINDING',
    'MISSING_CREDENTIAL_SCOPE_BINDING',
    'CROSS_ACCOUNT_RESOURCE',
    'ACTIVE_CONSUMER_REFERENCE',
    'UNSUPPORTED_PROFESSIONAL_VOICE',
    'UNRESOLVED_OPERATION_WITHOUT_RESOURCE',
  ]) assert.equal(codes.has(code), true, code);
  assert.deepEqual(
    new Set(plan.blockers.filter((item) => item.code === 'UNRESOLVED_OPERATION_WITHOUT_RESOURCE').map((item) => item.operationId)),
    new Set(['operation-ambiguous', 'operation-reserved']),
  );
});

test('resource source provenance is a strict nullable pair with deterministic legacy normalization', () => {
  for (const changed of [
    { sourceSha256: ASSET_MEDIA_SHA, sourceBytes: null },
    { sourceSha256: null, sourceBytes: 10 },
    { sourceSha256: ASSET_MEDIA_SHA, sourceBytes: 0 },
    { sourceSha256: ASSET_MEDIA_SHA, sourceBytes: -1 },
    { sourceSha256: ASSET_MEDIA_SHA, sourceBytes: 1.5 },
    { sourceSha256: 'not-a-digest', sourceBytes: 10 },
  ]) {
    const malformed = snapshot();
    malformed.resources[0] = { ...malformed.resources[0], ...changed };
    assert.throws(() => makePlan(malformed), (error) => ['INVALID_RESOURCE_SOURCE_BINDING', 'INVALID_CONTRACT'].includes(error.code));
  }

  const omitted = snapshot();
  delete omitted.resources[0].sourceSha256;
  delete omitted.resources[0].sourceBytes;
  const explicitNull = snapshot();
  explicitNull.resources[0] = { ...explicitNull.resources[0], sourceSha256: null, sourceBytes: null };
  const omittedPlan = makePlan(omitted);
  const explicitPlan = makePlan(explicitNull);
  assert.equal(omittedPlan.digest, explicitPlan.digest);
  assert.equal(omittedPlan.blockers.some(item => item.code === 'MISSING_RESOURCE_SOURCE_BINDING'), true);

  const videoSnapshot = snapshot();
  videoSnapshot.resources = [{
    resourceKey: 'resource-video', accountId: 'account-1', kind: 'video', providerResourceId: 'video-1',
    originOperationId: 'operation-video', state: 'ready', sourceSha256: null, sourceBytes: null,
  }];
  videoSnapshot.references = [];
  videoSnapshot.operations = [{
    operationId: 'operation-video', accountId: 'account-1', kind: 'video_create', state: 'succeeded', resourceKeys: ['resource-video'],
  }];
  const videoPlan = createReconciliationPlan(videoSnapshot, {
    requestedActions: [{ resourceKey: 'resource-video', verbs: ['read', 'readback'] }],
    expiresAt: EXPIRES_AT,
    cohortId: 'disposable-canary-a',
  });
  assert.deepEqual(videoPlan.blockers, [], 'video provenance may intentionally be null/null');
});

test('avatar deletion plans require complete membership and parent readback scope', () => {
  const base = snapshot();
  base.resources = [
    {
      resourceKey: 'resource-group', accountId: 'account-1', kind: 'avatar_group', providerResourceId: 'group-1',
      originOperationId: 'operation-avatar', state: 'ready', sourceSha256: ASSET_MEDIA_SHA, sourceBytes: 1_024,
      membership: { state: 'unknown', memberResourceKeys: ['resource-look'] },
    },
    {
      resourceKey: 'resource-look', accountId: 'account-1', kind: 'avatar_look', providerResourceId: 'look-1',
      originOperationId: 'operation-avatar', state: 'ready', sourceSha256: ASSET_MEDIA_SHA, sourceBytes: 1_024,
      parentResourceKey: 'resource-group',
    },
  ];
  base.references = [];
  base.operations = [{ operationId: 'operation-avatar', accountId: 'account-1', kind: 'avatar_create', state: 'succeeded', resourceKeys: ['resource-group', 'resource-look'] }];
  const plan = createReconciliationPlan(base, {
    requestedActions: [{ resourceKey: 'resource-look', verbs: ['read', 'delete', 'readback'] }],
    expiresAt: EXPIRES_AT,
    cohortId: 'disposable-canary-a',
  });
  assert.deepEqual(new Set(plan.blockers.map((item) => item.code)), new Set([
    'AVATAR_LOOK_PARENT_MEMBERSHIP_NOT_COMPLETE',
    'AVATAR_LOOK_PARENT_READBACK_OUTSIDE_SCOPE',
  ]));
});

test('avatar cascade scope names every affected look and the last-look parent explicitly', () => {
  const base = snapshot();
  base.resources = [
    {
      resourceKey: 'resource-group', accountId: 'account-1', kind: 'avatar_group', providerResourceId: 'group-1',
      originOperationId: 'operation-avatar', state: 'ready', sourceSha256: ASSET_MEDIA_SHA, sourceBytes: 1_024,
      membership: { state: 'complete', memberResourceKeys: ['resource-look'] },
    },
    {
      resourceKey: 'resource-look', accountId: 'account-1', kind: 'avatar_look', providerResourceId: 'look-1',
      originOperationId: 'operation-avatar', state: 'ready', sourceSha256: ASSET_MEDIA_SHA, sourceBytes: 1_024,
      parentResourceKey: 'resource-group',
    },
  ];
  base.references = [];
  base.operations = [{ operationId: 'operation-avatar', accountId: 'account-1', kind: 'avatar_create', state: 'succeeded', resourceKeys: ['resource-group', 'resource-look'] }];

  const incomplete = createReconciliationPlan(base, {
    requestedActions: [
      { resourceKey: 'resource-group', verbs: ['read', 'delete', 'readback'] },
      { resourceKey: 'resource-look', verbs: ['read', 'readback'] },
    ],
    expiresAt: EXPIRES_AT,
    cohortId: 'disposable-canary-a',
  });
  assert.equal(incomplete.blockers.some((item) => item.code === 'AVATAR_GROUP_MEMBER_DELETE_SCOPE_INCOMPLETE'), true);

  const lastLookIncomplete = createReconciliationPlan(base, {
    requestedActions: [
      { resourceKey: 'resource-group', verbs: ['read', 'readback'] },
      { resourceKey: 'resource-look', verbs: ['read', 'delete', 'readback'] },
    ],
    expiresAt: EXPIRES_AT,
    cohortId: 'disposable-canary-a',
  });
  assert.equal(lastLookIncomplete.blockers.some((item) => item.code === 'AVATAR_LOOK_LAST_MEMBER_CASCADE_SCOPE_INCOMPLETE'), true);

  const complete = createReconciliationPlan(base, {
    requestedActions: [
      { resourceKey: 'resource-group', verbs: ['read', 'delete', 'readback'] },
      { resourceKey: 'resource-look', verbs: ['read', 'delete', 'readback'] },
    ],
    expiresAt: EXPIRES_AT,
    cohortId: 'disposable-canary-a',
  });
  assert.deepEqual(complete.blockers, []);
});

test('avatar group membership rejects missing, cross-kind, cross-account, and reverse-link-invalid members', () => {
  const invalid = snapshot();
  invalid.resources = [
    {
      resourceKey: 'resource-group', accountId: 'account-1', kind: 'avatar_group', providerResourceId: 'group-1',
      originOperationId: 'operation-avatar', state: 'ready', sourceSha256: ASSET_MEDIA_SHA, sourceBytes: 1_024,
      membership: { state: 'complete', memberResourceKeys: ['resource-voice', 'resource-missing'] },
    },
    {
      resourceKey: 'resource-voice', accountId: 'other-account', kind: 'voice', providerResourceId: 'voice-1',
      originOperationId: 'operation-voice', state: 'ready', sourceSha256: VOICE_MEDIA_SHA, sourceBytes: 2_048,
      voiceNamespace: 'instant',
    },
    {
      resourceKey: 'resource-omitted-look', accountId: 'account-1', kind: 'avatar_look', providerResourceId: 'look-1',
      originOperationId: 'operation-avatar', state: 'ready', sourceSha256: ASSET_MEDIA_SHA, sourceBytes: 1_024,
      parentResourceKey: 'resource-group',
    },
  ];
  invalid.references = [];
  invalid.operations = [
    { operationId: 'operation-avatar', accountId: 'account-1', kind: 'avatar_create', state: 'succeeded', resourceKeys: ['resource-group', 'resource-omitted-look'] },
    { operationId: 'operation-voice', accountId: 'other-account', kind: 'voice_clone', state: 'succeeded', resourceKeys: ['resource-voice'] },
  ];
  const plan = createReconciliationPlan(invalid, {
    requestedActions: [{ resourceKey: 'resource-group', verbs: ['read'] }],
    expiresAt: EXPIRES_AT,
    cohortId: 'disposable-canary-a',
  });
  const codes = new Set(plan.blockers.map((item) => item.code));
  assert.equal(codes.has('AVATAR_GROUP_MEMBER_UNKNOWN'), true);
  assert.equal(codes.has('AVATAR_GROUP_MEMBER_GRAPH_INVALID'), true);
  assert.equal(codes.has('AVATAR_GROUP_MEMBERSHIP_OMITS_LOOK'), true);
});

test('redactPlan removes all raw account, resource, provider, operation, and cohort identifiers', () => {
  const plan = makePlan();
  const redacted = redactPlan(plan);
  const serialized = JSON.stringify(redacted);
  for (const secret of [
    'account-1',
    'lux-video-os-preview',
    'heygen-account-fingerprint',
    'resource-asset',
    'asset-provider-1',
    'operation-upload',
    'disposable-canary-a',
    ASSET_MEDIA_SHA,
  ]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(serialized.includes('sourceBytes'), false);
  assert.equal(serialized.includes('1024'), false, 'exact source byte metadata must not enter redacted output');
  assert.equal(redacted.resources[0].sourceBound, true);
  assert.equal(redacted.summary.resourceCount, 1);
  assert.equal(redacted.summary.blockerCount, 0);
});

test('plan digest drift is rejected before redaction or approval verification', () => {
  const keys = generateKeyPairSync('ed25519');
  const plan = makePlan();
  const tampered = { ...plan, target: { ...plan.target, databaseBindingSha256: 'd'.repeat(64) } };
  assert.throws(() => redactPlan(tampered), { code: 'PLAN_DIGEST_MISMATCH' });
  assert.throws(
    () => verifyApproval(envelopeFor(claims(plan), keys.privateKey), trust(tampered, keys.publicKey)),
    { code: 'PLAN_DIGEST_MISMATCH' },
  );
});

test('changing only per-resource media provenance changes the plan digest and invalidates old approval', () => {
  const keys = generateKeyPairSync('ed25519');
  const originalPlan = makePlan();
  const changed = snapshot();
  changed.resources[0] = { ...changed.resources[0], sourceSha256: 'c'.repeat(64), sourceBytes: 4_096 };
  const changedPlan = makePlan(changed);
  assert.notEqual(changedPlan.digest, originalPlan.digest);
  assert.equal(changedPlan.candidate.sourceSha256, originalPlan.candidate.sourceSha256);
  assert.throws(
    () => verifyApproval(envelopeFor(claims(originalPlan), keys.privateKey), trust(changedPlan, keys.publicKey)),
    { code: 'APPROVAL_SCOPE_MISMATCH' },
  );
});

test('verifyApproval accepts only canonical Ed25519 claims bound to the exact plan and trust context', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const plan = makePlan();
  const verified = verifyApproval(envelopeFor(claims(plan), privateKey), trust(plan, publicKey));
  assert.equal(verified.planDigest, plan.digest);
  assert.equal(verified.kid, 'owner-key-1');
  assert.match(verified.approvalDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(verified.resources), true);
  assert.equal(assertVerifiedApproval(verified, {
    plan,
    expectedBudget: { maxProviderCalls: 3, maxSpendMicrousd: 0 },
    now: '2026-09-30T12:03:00.000Z',
    nonce: 'nonce-1',
    approvalStatus: 'active',
  }), verified);
});

test('local claim assertion rejects copied, serialized, stale, and scope-drifted approvals', () => {
  const keys = generateKeyPairSync('ed25519');
  const plan = makePlan();
  const verified = verifyApproval(envelopeFor(claims(plan), keys.privateKey), trust(plan, keys.publicKey));
  const lock = {
    plan,
    expectedBudget: { maxProviderCalls: 3, maxSpendMicrousd: 0 },
    now: '2026-09-30T12:03:00.000Z',
    nonce: 'nonce-1',
    approvalStatus: 'active',
  };
  assert.throws(() => assertVerifiedApproval({ ...verified, verified: true }, lock), { code: 'UNVERIFIED_APPROVAL' });
  assert.throws(() => assertVerifiedApproval(JSON.parse(JSON.stringify(verified)), lock), { code: 'UNVERIFIED_APPROVAL' });
  assert.throws(() => assertVerifiedApproval(verified, { ...lock, now: EXPIRES_AT }), { code: 'APPROVAL_EXPIRED' });
  assert.throws(() => assertVerifiedApproval(verified, { ...lock, nonce: 'nonce-2' }), { code: 'APPROVAL_NONCE_UNAVAILABLE' });
  assert.throws(() => assertVerifiedApproval(verified, { ...lock, approvalStatus: 'revoked' }), { code: 'APPROVAL_REVOKED' });
  assert.throws(() => assertVerifiedApproval(verified, {
    ...lock,
    expectedBudget: { maxProviderCalls: 4, maxSpendMicrousd: 0 },
  }), { code: 'APPROVAL_SCOPE_MISMATCH' });
  const changedSnapshot = snapshot();
  changedSnapshot.target = { ...changedSnapshot.target, databaseBindingSha256: 'e'.repeat(64) };
  const changedPlan = makePlan(changedSnapshot);
  assert.throws(() => assertVerifiedApproval(verified, { ...lock, plan: changedPlan }), { code: 'APPROVAL_SCOPE_MISMATCH' });
});

test('verifyApproval rejects forged signatures, unpinned keys, revoked approvals, consumed nonces, and expired claims', async (t) => {
  const keys = generateKeyPairSync('ed25519');
  const otherKeys = generateKeyPairSync('ed25519');
  const plan = makePlan();
  const validEnvelope = envelopeFor(claims(plan), keys.privateKey);

  await t.test('forged signature', () => assert.throws(
    () => verifyApproval(envelopeFor(claims(plan), otherKeys.privateKey), trust(plan, keys.publicKey)),
    { code: 'INVALID_APPROVAL_SIGNATURE' },
  ));
  await t.test('unpinned kid', () => assert.throws(
    () => verifyApproval(validEnvelope, { ...trust(plan, keys.publicKey), pinnedKeys: {} }),
    { code: 'UNTRUSTED_APPROVAL_KEY' },
  ));
  await t.test('key ID is bound into the signature', () => assert.throws(
    () => verifyApproval(
      envelopeFor(claims(plan), keys.privateKey, { kid: 'owner-key-alias' }),
      { ...trust(plan, keys.publicKey), pinnedKeys: { 'owner-key-alias': keys.publicKey } },
    ),
    { code: 'INVALID_APPROVAL_SIGNATURE' },
  ));
  await t.test('private key is not a pinned public key', () => assert.throws(
    () => verifyApproval(validEnvelope, trust(plan, keys.privateKey)),
    { code: 'INVALID_APPROVAL_KEY' },
  ));
  await t.test('revoked approval', () => assert.throws(
    () => verifyApproval(validEnvelope, trust(plan, keys.publicKey, { approvalStatus: 'revoked' })),
    { code: 'APPROVAL_REVOKED' },
  ));
  await t.test('consumed nonce', () => assert.throws(
    () => verifyApproval(validEnvelope, trust(plan, keys.publicKey, { nonceState: { nonce: 'nonce-1', status: 'consumed' } })),
    { code: 'APPROVAL_NONCE_UNAVAILABLE' },
  ));
  await t.test('expired', () => assert.throws(
    () => verifyApproval(validEnvelope, trust(plan, keys.publicKey, { now: EXPIRES_AT })),
    { code: 'APPROVAL_EXPIRED' },
  ));
});

test('verifyApproval rejects every changed scope dimension', async (t) => {
  const keys = generateKeyPairSync('ed25519');
  const plan = makePlan();
  const cases = {
    plan: { planDigest: 'f'.repeat(64) },
    candidate: { candidate: { ...plan.candidate, adapterSha256: 'a'.repeat(64) } },
    target: { target: { ...plan.target, projectId: 'other-project' } },
    account: { target: { ...plan.target, applicationAccountId: 'other-account' } },
    database: { target: { ...plan.target, databaseBindingSha256: 'b'.repeat(64) } },
    providerAccount: { target: { ...plan.target, providerAccountFingerprint: 'other-provider-account' } },
    credentialScope: { target: { ...plan.target, credentialScopeFingerprint: 'c'.repeat(64) } },
    resource: { resources: [{ ...claims(plan).resources[0], providerResourceId: 'other-resource' }] },
    kind: { resources: [{ ...claims(plan).resources[0], kind: 'video' }] },
    verbs: { resources: [{ ...claims(plan).resources[0], verbs: ['read'] }] },
    expiry: { expiresAt: '2026-10-01T11:59:59.000Z' },
    cohort: { cohortId: 'other-cohort' },
  };
  for (const [name, changed] of Object.entries(cases)) {
    await t.test(name, () => assert.throws(
      () => verifyApproval(envelopeFor(claims(plan, changed), keys.privateKey), trust(plan, keys.publicKey)),
      { code: 'APPROVAL_SCOPE_MISMATCH' },
    ));
  }
  await t.test('budget', () => assert.throws(
    () => verifyApproval(envelopeFor(claims(plan, { budget: { maxProviderCalls: 4, maxSpendMicrousd: 0 } }), keys.privateKey), trust(plan, keys.publicKey)),
    { code: 'APPROVAL_SCOPE_MISMATCH' },
  ));
  await t.test('nonce', () => assert.throws(
    () => verifyApproval(envelopeFor(claims(plan, { nonce: 'nonce-2' }), keys.privateKey), trust(plan, keys.publicKey)),
    { code: 'APPROVAL_NONCE_UNAVAILABLE' },
  ));
});

test('verifyApproval rejects duplicate JSON fields and noncanonical signed payload bytes', () => {
  const keys = generateKeyPairSync('ed25519');
  const plan = makePlan();
  const valid = JSON.parse(envelopeFor(claims(plan), keys.privateKey).toString('utf8'));
  const duplicateEnvelope = `{"version":"${HEYGEN_RECONCILIATION_ENVELOPE_VERSION}","kid":"owner-key-1","kid":"owner-key-1","payload":"${valid.payload}","signature":"${valid.signature}"}`;
  assert.throws(() => verifyApproval(duplicateEnvelope, trust(plan, keys.publicKey)), { code: 'DUPLICATE_JSON_FIELD' });

  const canonicalPayloadText = canonicalApprovalPayloadBytes(claims(plan)).toString('utf8');
  const duplicatePayload = Buffer.from(canonicalPayloadText.replace('"nonce":"nonce-1"', '"nonce":"nonce-1","nonce":"nonce-1"'));
  const duplicateSignature = sign(null, Buffer.concat([
    canonicalApprovalSigningBytes('owner-key-1', claims(plan)).subarray(0, -canonicalApprovalPayloadBytes(claims(plan)).length),
    duplicatePayload,
  ]), keys.privateKey);
  const duplicatePayloadEnvelope = canonicalJsonBytes({
    version: HEYGEN_RECONCILIATION_ENVELOPE_VERSION,
    kid: 'owner-key-1',
    payload: duplicatePayload.toString('base64url'),
    signature: duplicateSignature.toString('base64url'),
  });
  assert.throws(() => verifyApproval(duplicatePayloadEnvelope, trust(plan, keys.publicKey)), { code: 'DUPLICATE_JSON_FIELD' });

  const canonical = canonicalPayloadText;
  const noncanonicalPayload = Buffer.from(canonical.replace('{', '{\n  '), 'utf8');
  const signature = sign(null, Buffer.concat([
    canonicalApprovalSigningBytes('owner-key-1', claims(plan)).subarray(0, -canonicalApprovalPayloadBytes(claims(plan)).length),
    noncanonicalPayload,
  ]), keys.privateKey);
  const envelope = canonicalJsonBytes({
    version: HEYGEN_RECONCILIATION_ENVELOPE_VERSION,
    kid: 'owner-key-1',
    payload: noncanonicalPayload.toString('base64url'),
    signature: signature.toString('base64url'),
  });
  assert.throws(() => verifyApproval(envelope, trust(plan, keys.publicKey)), { code: 'NON_CANONICAL_APPROVAL_PAYLOAD' });
  assert.throws(() => verifyApproval(JSON.parse(envelope.toString('utf8')), trust(plan, keys.publicKey)), { code: 'INVALID_APPROVAL_ENVELOPE' });
});

test('verifyApproval refuses a valid signature for a blocked plan', () => {
  const keys = generateKeyPairSync('ed25519');
  const blockedSnapshot = snapshot();
  blockedSnapshot.target = { ...blockedSnapshot.target, providerAccountFingerprint: null, providerAccountBindingState: 'provisional' };
  const plan = makePlan(blockedSnapshot);
  assert.notEqual(plan.blockers.length, 0);
  assert.throws(() => verifyApproval(envelopeFor(claims(plan), keys.privateKey), trust(plan, keys.publicKey)), { code: 'PLAN_BLOCKED' });
});
