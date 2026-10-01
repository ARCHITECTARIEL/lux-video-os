import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';

import * as schema from '../../db/schema.js';

const scenario = process.argv[2];
const H64 = value => value.repeat(64);
const ACCOUNT = 'account-reconciliation';
const ENROLLMENT = 'enrollment-reconciliation';
const IDENTITY = 'identity-reconciliation';
const SOURCE_SHA = H64('1');
const ADAPTER_SHA = H64('2');
const DATABASE_SHA = H64('3');
const PHOTO_SHA = H64('a');
const AUDIO_SHA = H64('b');
const SCOPE_SHA_A = H64('4');
const SCOPE_SHA_B = H64('5');
const ORIGIN_A = H64('6');
const ORIGIN_B = H64('7');
const PROVIDER_ACCOUNT = H64('8');
const NOW = new Date('2026-09-30T16:00:00.000Z');
const dialect = new PgDialect();

mock.module('../../db/client.js', {
  namedExports: {
    database: () => ({
      transaction() { throw new Error('A test executor must be injected.'); },
    }),
  },
});

const repository = await import('../../db/provider-reconciliation-repository.js');
const { createReconciliationPlan } = await import('../../lib/heygen-reconciliation-contract.js');

function enrollment(overrides = {}) {
  return {
    id: ENROLLMENT,
    accountId: ACCOUNT,
    identityId: IDENTITY,
    sourceSha256: SOURCE_SHA,
    photoSha256: PHOTO_SHA,
    photoBytes: 1_111,
    derivedAudioSha256: AUDIO_SHA,
    derivedAudioBytes: 2_222,
    providerReceipts: {},
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    id: 'binding-b',
    applicationAccountId: ACCOUNT,
    provider: 'heygen',
    environment: 'preview',
    projectId: 'lux-video-os-preview',
    databaseBindingSha256: DATABASE_SHA,
    credentialScopeFingerprint: SCOPE_SHA_B,
    originScopeKey: ORIGIN_B,
    lifecycleState: 'active',
    createdAt: new Date('2026-09-30T15:00:00.000Z'),
    ...overrides,
  };
}

function promotion(overrides = {}) {
  return {
    id: 'promotion-b',
    bindingId: 'binding-b',
    applicationAccountId: ACCOUNT,
    originScopeKey: ORIGIN_B,
    verifiedAccountScopeId: 'verified-scope',
    state: 'verified',
    observedAt: new Date('2026-09-30T15:05:00.000Z'),
    ...overrides,
  };
}

function verifiedScope(overrides = {}) {
  return {
    id: 'verified-scope',
    provider: 'heygen',
    providerAccountFingerprint: PROVIDER_ACCOUNT,
    canonicalScopeKey: H64('9'),
    ...overrides,
  };
}

function operation(overrides = {}) {
  return {
    id: 'operation-avatar',
    applicationAccountId: ACCOUNT,
    bindingId: 'binding-b',
    originScopeKey: ORIGIN_B,
    kind: 'avatar_create',
    state: 'succeeded',
    correlationId: 'correlation-avatar',
    enrollmentId: ENROLLMENT,
    identityId: IDENTITY,
    sourceSha256: PHOTO_SHA,
    sourceBytes: 1_111,
    ...overrides,
  };
}

function resource(overrides = {}) {
  return {
    id: 'resource-group',
    applicationAccountId: ACCOUNT,
    bindingId: 'binding-b',
    originScopeKey: ORIGIN_B,
    verifiedAccountScopeId: 'verified-scope',
    kind: 'avatar_group',
    providerResourceId: 'provider-group',
    originOperationId: 'operation-avatar',
    voiceNamespace: null,
    parentResourceId: null,
    state: 'ready',
    sourceSha256: PHOTO_SHA,
    sourceBytes: 1_111,
    ...overrides,
  };
}

function snapshotInput(overrides = {}) {
  return {
    accountId: ACCOUNT,
    enrollmentId: ENROLLMENT,
    candidate: { sourceSha256: SOURCE_SHA, adapterSha256: ADAPTER_SHA },
    target: { environment: 'preview', projectId: 'lux-video-os-preview', databaseBindingSha256: DATABASE_SHA },
    now: NOW,
    ...overrides,
  };
}

function rowsFor(table, state, queryState = {}) {
  if (table === schema.identityVideoEnrollments) return state.enrollments;
  if (table === schema.providerAccountBindings) return state.bindings;
  if (table === schema.providerAccountBindingPromotions) return state.promotions;
  if (table === schema.providerVerifiedAccountScopes) return state.scopes;
  if (table === schema.providerLifecycleOperations) {
    const sql = queryState.condition ? dialect.sqlToQuery(queryState.condition).sql : '';
    if (/binding_id|origin_scope_key/.test(sql)) {
      const current = state.bindings.find(item => item.lifecycleState === 'active') || state.bindings[0];
      return state.operations.filter(item => item.bindingId === current?.id && item.originScopeKey === current?.originScopeKey);
    }
    return state.operations;
  }
  if (table === schema.providerResources) return state.resources;
  if (table === schema.providerConsumerReferences) return state.references;
  if (table === schema.providerLifecycleEvents) {
    if (!queryState.ordered) return state.events;
    return [...state.events].sort((left, right) => new Date(right.observedAt).getTime() - new Date(left.observedAt).getTime());
  }
  throw new Error('Unexpected snapshot table.');
}

function query(resolveRows) {
  const state = { table: null, condition: null, ordered: false };
  const chain = {
    from(table) { state.table = table; return chain; },
    where(condition) { state.condition = condition; return chain; },
    orderBy() { state.ordered = true; return chain; },
    for() { return chain; },
    limit() { return chain; },
    then(resolve, reject) { return Promise.resolve(resolveRows(state.table, state)).then(resolve, reject); },
  };
  return chain;
}

function snapshotExecutor(state) {
  const transactionOptions = [];
  const tx = { select: () => query((table, queryState) => rowsFor(table, state, queryState)) };
  return {
    transactionOptions,
    executor: {
      transaction(callback, options) {
        transactionOptions.push(options);
        return callback(tx);
      },
    },
  };
}

function baseSnapshotState(overrides = {}) {
  return {
    enrollments: [enrollment()],
    bindings: [binding()],
    promotions: [promotion()],
    scopes: [verifiedScope()],
    operations: [],
    resources: [],
    references: [],
    events: [],
    ...overrides,
  };
}

async function readSnapshot(state, input = snapshotInput()) {
  const { executor, transactionOptions } = snapshotExecutor(state);
  const snapshot = await repository.getProviderReconciliationSnapshot(input, { executor });
  return { snapshot, transactionOptions, executor };
}

function mutationTx({ operationRow, bindingRow = binding(), promotionRow = promotion(), resourceSelects = [], insertResource }) {
  let currentOperation = { ...operationRow };
  const selectQueues = new Map([
    [schema.providerLifecycleOperations, [[currentOperation]]],
    [schema.providerAccountBindings, [[bindingRow]]],
    [schema.providerAccountBindingPromotions, [[promotionRow]]],
    [schema.providerResources, resourceSelects.map(rows => [...rows])],
  ]);
  const inserted = { resources: [], events: [] };
  const tx = {
    select() {
      return query(table => {
        const queue = selectQueues.get(table);
        if (!queue?.length) return [];
        const rows = queue.shift();
        if (table === schema.providerLifecycleOperations && rows.length) rows[0] = currentOperation;
        return rows;
      });
    },
    insert(table) {
      return {
        values(value) {
          if (table === schema.providerLifecycleEvents) inserted.events.push(value);
          if (table === schema.providerResources) inserted.resources.push(value);
          const returningRows = table === schema.providerResources
            ? (() => {
              const result = insertResource ? insertResource(value, inserted.resources.length - 1) : { ...value, id: `created-${inserted.resources.length}` };
              return result ? [result] : [];
            })()
            : [];
          const result = {
            onConflictDoNothing() { return result; },
            returning: async () => returningRows,
            then(resolve, reject) { return Promise.resolve([]).then(resolve, reject); },
          };
          return result;
        },
      };
    },
    update(table) {
      assert.equal(table, schema.providerLifecycleOperations);
      return {
        set(value) {
          currentOperation = { ...currentOperation, ...value };
          return {
            where() {
              return { returning: async () => [currentOperation] };
            },
          };
        },
      };
    },
  };
  return { tx, inserted, operation: () => currentOperation };
}

function resourceInput(overrides = {}) {
  return {
    kind: 'asset',
    providerResourceId: 'provider-asset',
    state: 'ready',
    sourceSha256: PHOTO_SHA,
    sourceBytes: 1_111,
    ...overrides,
  };
}

if (scenario === 'snapshot') {
  const op = operation({ id: 'operation-asset', kind: 'asset_upload' });
  const asset = resource({
    id: 'resource-asset', kind: 'asset', providerResourceId: 'provider-asset', originOperationId: op.id,
    sourceSha256: PHOTO_SHA, sourceBytes: 1_111, publicUrlDigest: H64('a'), privateEvidenceRef: 'provider/evidence/asset.json',
  });
  const reference = {
    id: 'reference-asset', applicationAccountId: ACCOUNT, originScopeKey: ORIGIN_B, resourceId: asset.id,
    consumerKind: 'enrollment', consumerId: ENROLLMENT, originOperationId: op.id, state: 'active',
  };
  const state = baseSnapshotState({ operations: [op], resources: [asset], references: [reference] });
  const { snapshot, transactionOptions, executor } = await readSnapshot(state);

  assert.deepEqual(transactionOptions, [{ isolationLevel: 'repeatable read', accessMode: 'read only' }]);
  assert.deepEqual(Object.keys(snapshot).sort(), ['candidate', 'capturedAt', 'operations', 'references', 'resources', 'target', 'version']);
  assert.deepEqual(snapshot.target, {
    environment: 'preview', projectId: 'lux-video-os-preview', applicationAccountId: ACCOUNT,
    databaseBindingSha256: DATABASE_SHA, provider: 'heygen', providerAccountFingerprint: PROVIDER_ACCOUNT,
    providerAccountBindingState: 'verified', credentialScopeFingerprint: SCOPE_SHA_B, apiVersion: 'v3',
  });
  assert.deepEqual(snapshot.resources, [{
    resourceKey: asset.id, accountId: ACCOUNT, kind: 'asset', providerResourceId: 'provider-asset',
    originOperationId: op.id, state: 'ready', sourceSha256: PHOTO_SHA, sourceBytes: 1_111,
    voiceNamespace: null, dependencies: [], parentResourceKey: null, membership: null,
  }]);
  assert.deepEqual(snapshot.references, [{
    referenceId: reference.id, accountId: ACCOUNT, resourceKey: asset.id,
    consumerKind: 'enrollment', consumerId: ENROLLMENT, state: 'active',
  }]);
  assert.deepEqual(snapshot.operations, [{ operationId: op.id, accountId: ACCOUNT, kind: 'asset_upload', state: 'succeeded', resourceKeys: [asset.id] }]);
  assert.equal(JSON.stringify(snapshot).includes('provider/evidence/asset.json'), false);
  assert.equal(JSON.stringify(snapshot).includes('publicUrl'), false);
  const plan = createReconciliationPlan(snapshot, {
    requestedActions: [{ resourceKey: asset.id, verbs: ['read', 'readback'] }],
    expiresAt: '2026-10-01T16:00:00.000Z',
    cohortId: 'repository-shape-proof',
  });
  assert.deepEqual(plan.blockers, [], 'the repository snapshot must satisfy the frozen contract without adaptation');

  const status = await repository.getProviderReconciliationStatus(snapshotInput(), { executor });
  assert.deepEqual(status.counts, { resources: 1, references: 1, operations: 1, ambiguousOperations: 0, activeReferences: 1 });
  assert.deepEqual(status.execution, { enabled: false, reason: 'execution_not_implemented' });
  assert.equal(Object.isFrozen(repository.providerReconciliationExecutionStatus()), true);

} else if (scenario === 'rotation') {
  const bindingA = binding({
    id: 'binding-a', credentialScopeFingerprint: SCOPE_SHA_A, originScopeKey: ORIGIN_A,
    lifecycleState: 'revoked', createdAt: new Date('2026-09-29T15:00:00.000Z'),
  });
  const opA = operation({ id: 'operation-a', bindingId: bindingA.id, originScopeKey: ORIGIN_A, kind: 'asset_upload' });
  const opB = operation({ id: 'operation-b', kind: 'voice_clone', sourceSha256: AUDIO_SHA, sourceBytes: 2_222 });
  const resourceA = resource({
    id: 'resource-a', bindingId: bindingA.id, originScopeKey: ORIGIN_A, kind: 'asset',
    providerResourceId: 'provider-a', originOperationId: opA.id,
  });
  const resourceB = resource({
    id: 'resource-b', kind: 'voice', providerResourceId: 'provider-b', originOperationId: opB.id, voiceNamespace: 'instant',
    sourceSha256: AUDIO_SHA, sourceBytes: 2_222,
  });
  const state = baseSnapshotState({
    bindings: [binding(), bindingA],
    operations: [opA, opB],
    resources: [resourceA, resourceB],
  });
  const { snapshot } = await readSnapshot(state);
  assert.equal(snapshot.target.credentialScopeFingerprint, SCOPE_SHA_B);
  assert.equal(snapshot.target.providerAccountFingerprint, PROVIDER_ACCOUNT);
  assert.deepEqual(snapshot.resources.map(item => item.resourceKey).sort(), ['resource-a', 'resource-b']);
  assert.equal(snapshot.operations.some(item => item.operationId === 'scope-conflict:resource-a' && item.state === 'ambiguous' && item.resourceKeys.length === 0), true);
  assert.equal(snapshot.operations.some(item => item.operationId === 'scope-conflict:resource-b'), false);

} else if (scenario === 'binding-holds') {
  const unannotated = resource({ id: 'resource-unannotated', verifiedAccountScopeId: null });
  const missingScopeState = baseSnapshotState({ operations: [operation()], resources: [unannotated], scopes: [] });
  const missing = (await readSnapshot(missingScopeState)).snapshot;
  assert.equal(missing.target.providerAccountBindingState, 'provisional');
  assert.equal(missing.target.providerAccountFingerprint, null);
  assert.equal(missing.operations.some(item => item.operationId === 'scope-conflict:resource-unannotated'), true);

  const mismatched = resource({ id: 'resource-mismatch', verifiedAccountScopeId: 'other-scope' });
  const mismatchState = baseSnapshotState({ operations: [operation()], resources: [mismatched] });
  const mismatch = (await readSnapshot(mismatchState)).snapshot;
  assert.equal(mismatch.target.providerAccountBindingState, 'verified');
  assert.equal(mismatch.operations.some(item => item.operationId === 'scope-conflict:resource-mismatch'), true);

  const conflict = (await readSnapshot(mismatchState, snapshotInput({
    target: { environment: 'preview', projectId: 'lux-video-os-preview', databaseBindingSha256: H64('b') },
  }))).snapshot;
  assert.equal(conflict.target.providerAccountBindingState, 'conflict');

} else if (scenario === 'legacy-membership') {
  const avatarOp = operation();
  const readOp = operation({ id: 'operation-membership', kind: 'resource_read', correlationId: 'correlation-membership' });
  const emptyOp = operation({ id: 'operation-empty', kind: 'voice_clone', state: 'pending', sourceSha256: AUDIO_SHA, sourceBytes: 2_222 });
  const group = resource();
  const look = resource({
    id: 'resource-look', kind: 'avatar_look', providerResourceId: 'provider-look',
    originOperationId: avatarOp.id, parentResourceId: group.id,
  });
  const currentEvent = {
    id: 'event-membership-current', resourceId: group.id, operationId: readOp.id,
    eventType: 'provider.avatar_group_membership', outcome: 'PRESENT',
    observedAt: new Date('2026-09-30T15:55:00.000Z'),
    details: { membershipComplete: true, memberResourceKeys: [look.id], validUntil: '2026-10-01T15:55:00.000Z' },
  };
  const providerReceipts = {
    'avatar:asset': { status: 'COMPLETE', providerIds: { providerAssetId: 'provider-known-asset' } },
    'voice:asset': { status: 'ACCEPTED', providerIds: {} },
    'avatar:create': { status: 'COMPLETE', providerIds: { providerRenderableAvatarId: 'provider-orphan-look' } },
    'voice:create': { status: 'FAILED', providerIds: {} },
    'unexpected:receipt': { status: 'COMPLETE', providerIds: {} },
  };
  const knownAssetOp = operation({ id: 'operation-known-asset', kind: 'asset_upload' });
  const knownAsset = resource({
    id: 'resource-known-asset', kind: 'asset', providerResourceId: 'provider-known-asset', originOperationId: knownAssetOp.id,
  });
  const state = baseSnapshotState({
    enrollments: [enrollment({ providerReceipts })],
    operations: [avatarOp, readOp, emptyOp, knownAssetOp],
    resources: [group, look, knownAsset],
    events: [currentEvent],
  });
  let snapshot = (await readSnapshot(state)).snapshot;
  assert.deepEqual(snapshot.resources.find(item => item.resourceKey === group.id).membership, { state: 'complete', memberResourceKeys: [look.id] });
  assert.deepEqual(snapshot.operations.find(item => item.operationId === emptyOp.id), {
    operationId: emptyOp.id, accountId: ACCOUNT, kind: 'voice_clone', state: 'pending', resourceKeys: [],
  });
  const legacyIds = snapshot.operations.filter(item => item.operationId.startsWith('legacy:')).map(item => item.operationId);
  assert.equal(legacyIds.some(value => value.includes('voice:asset:providerAssetId:missing')), true);
  assert.equal(legacyIds.some(value => value.includes('avatar:create:providerRenderableAvatarId') && !value.endsWith(':missing')), true);
  assert.equal(legacyIds.some(value => value.includes('avatar:create:providerAvatarGroupId:missing')), true);
  assert.equal(legacyIds.some(value => value.includes('unexpected')), false, 'unknown receipt keys are hashed');
  assert.equal(legacyIds.some(value => value.includes(':unknown:')), true);
  assert.equal(legacyIds.some(value => value.includes('avatar:asset')), false, 'a normalized known receipt is not held');
  assert.equal(snapshot.operations.filter(item => item.state === 'ambiguous' && item.resourceKeys.length === 0).length >= 4, true);

  const olderComplete = { ...currentEvent, id: 'event-old', observedAt: new Date('2026-09-30T15:00:00.000Z') };
  state.events = [olderComplete, { ...currentEvent, id: 'event-new-incomplete', observedAt: new Date('2026-09-30T15:58:00.000Z'), details: { ...currentEvent.details, membershipComplete: false } }];
  snapshot = (await readSnapshot(state)).snapshot;
  assert.equal(snapshot.resources.find(item => item.resourceKey === group.id).membership.state, 'incomplete', 'the latest observation wins');

  for (const invalidEvent of [
    { ...currentEvent, observedAt: new Date('2026-09-30T16:01:00.000Z') },
    { ...currentEvent, details: { ...currentEvent.details, validUntil: '2026-09-30T15:59:59.000Z' } },
    { ...currentEvent, details: { ...currentEvent.details, validUntil: '2026-10-10T15:55:00.000Z' } },
    { ...currentEvent, details: { ...currentEvent.details, memberResourceKeys: [] } },
  ]) {
    state.events = [invalidEvent];
    snapshot = (await readSnapshot(state)).snapshot;
    assert.equal(snapshot.resources.find(item => item.resourceKey === group.id).membership.state, 'unknown');
  }

  state.operations = [avatarOp, { ...readOp, bindingId: 'binding-other', originScopeKey: ORIGIN_A }, emptyOp, knownAssetOp];
  state.events = [currentEvent];
  snapshot = (await readSnapshot(state)).snapshot;
  assert.equal(snapshot.resources.find(item => item.resourceKey === group.id).membership.state, 'unknown', 'membership evidence must come from the current binding and origin');

} else if (scenario === 'resource-recording') {
  const pendingUpload = operation({ id: 'operation-upload', kind: 'asset_upload', state: 'pending' });
  let fixture = mutationTx({ operationRow: pendingUpload });
  let result = await repository.recordProviderOperationResourcesTx(fixture.tx, {
    accountId: ACCOUNT, operationId: pendingUpload.id, resources: [], now: NOW,
  });
  assert.equal(result.operation.state, 'ambiguous');
  assert.deepEqual(result.conflicts, [{ reason: 'PROVIDER_ID_MISSING' }]);
  assert.equal(fixture.inserted.events.some(item => item.eventType === 'provider.operation_missing_resource'), true);

  fixture = mutationTx({ operationRow: pendingUpload });
  result = await repository.recordProviderOperationResourcesTx(fixture.tx, {
    accountId: ACCOUNT, operationId: pendingUpload.id, resources: [resourceInput({ kind: 'video', providerResourceId: 'provider-video' })], now: NOW,
  });
  assert.equal(result.operation.state, 'ambiguous');
  assert.equal(result.conflicts[0].reason, 'OPERATION_RESOURCE_KIND_MISMATCH');
  assert.equal(fixture.inserted.resources.length, 0);
  assert.equal(fixture.inserted.events[0].eventType, 'provider.resource_kind_conflict');

  const pendingAvatar = operation({ state: 'pending' });
  fixture = mutationTx({
    operationRow: pendingAvatar,
    insertResource: value => ({ ...value, id: value.kind === 'avatar_group' ? 'created-group' : 'created-look' }),
  });
  result = await repository.recordProviderOperationResourcesTx(fixture.tx, {
    accountId: ACCOUNT,
    operationId: pendingAvatar.id,
    resources: [
      resourceInput({ kind: 'avatar_look', providerResourceId: 'provider-look', parentProviderResourceId: 'provider-group' }),
      resourceInput({ kind: 'avatar_group', providerResourceId: 'provider-group' }),
    ],
    now: NOW,
  });
  assert.equal(result.operation.state, 'succeeded');
  assert.deepEqual(result.resources.map(item => item.id), ['created-group', 'created-look']);
  assert.equal(fixture.inserted.resources.find(item => item.kind === 'avatar_look').parentResourceId, 'created-group');

  const existingParent = { ...resource({ id: 'existing-group' }), kind: 'avatar_group', providerResourceId: 'provider-existing-group' };
  fixture = mutationTx({ operationRow: pendingAvatar, resourceSelects: [[existingParent]] });
  result = await repository.recordProviderOperationResourcesTx(fixture.tx, {
    accountId: ACCOUNT,
    operationId: pendingAvatar.id,
    resources: [resourceInput({ kind: 'avatar_look', providerResourceId: 'provider-new-look', parentProviderResourceId: 'provider-existing-group' })],
    now: NOW,
  });
  assert.equal(result.resources[0].parentResourceId, existingParent.id);

  fixture = mutationTx({ operationRow: pendingAvatar, resourceSelects: [[]] });
  result = await repository.recordProviderOperationResourcesTx(fixture.tx, {
    accountId: ACCOUNT,
    operationId: pendingAvatar.id,
    resources: [resourceInput({ kind: 'avatar_look', providerResourceId: 'provider-orphan-look', parentProviderResourceId: 'provider-missing-group' })],
    now: NOW,
  });
  assert.equal(result.operation.state, 'ambiguous');
  assert.equal(result.conflicts[0].reason, 'PARENT_NOT_FOUND');
  assert.equal(fixture.inserted.events.some(item => item.eventType === 'provider.resource_parent_conflict'), true);

  const terminalOperation = operation({ id: 'operation-terminal', kind: 'asset_upload', state: 'succeeded' });
  const exactTerminal = {
    id: 'resource-terminal', applicationAccountId: ACCOUNT, bindingId: 'binding-b', originScopeKey: ORIGIN_B,
    verifiedAccountScopeId: 'verified-scope', kind: 'asset', providerResourceId: 'provider-terminal',
    originOperationId: terminalOperation.id, voiceNamespace: null, parentResourceId: null, state: 'ready',
    sourceSha256: PHOTO_SHA, sourceBytes: 1_111, publicUrlDigest: null, privateEvidenceRef: null, evidenceExpiresAt: null,
  };
  fixture = mutationTx({ operationRow: terminalOperation, resourceSelects: [[exactTerminal], [exactTerminal]], insertResource: () => null });
  result = await repository.recordProviderOperationResourcesTx(fixture.tx, {
    accountId: ACCOUNT, operationId: terminalOperation.id,
    resources: [resourceInput({ providerResourceId: 'provider-terminal' })], now: NOW,
  });
  assert.equal(result.operation.state, 'succeeded');
  assert.deepEqual(result.resources.map(item => item.id), ['resource-terminal']);
  assert.deepEqual(result.conflicts, []);

  const changedTerminal = { ...exactTerminal, sourceBytes: 9_999 };
  fixture = mutationTx({ operationRow: terminalOperation, resourceSelects: [[changedTerminal]], insertResource: () => { throw new Error('terminal conflict must not insert'); } });
  result = await repository.recordProviderOperationResourcesTx(fixture.tx, {
    accountId: ACCOUNT, operationId: terminalOperation.id,
    resources: [resourceInput({ providerResourceId: 'provider-terminal' })], now: NOW,
  });
  assert.equal(result.operation.state, 'succeeded');
  assert.equal(result.conflicts[0].reason, 'TERMINAL_OPERATION_RESOURCE_CONFLICT');
  assert.equal(fixture.inserted.events.some(item => item.eventType === 'provider.resource_after_terminal_operation'), true);

  fixture = mutationTx({
    operationRow: pendingUpload,
    insertResource: value => ({ ...value, id: 'resource-lifecycle-replay' }),
  });
  const accepted = await repository.recordProviderOperationResourcesTx(fixture.tx, {
    accountId: ACCOUNT,
    operationId: pendingUpload.id,
    resources: [resourceInput({ providerResourceId: 'provider-lifecycle-replay', state: 'present' })],
    now: NOW,
  });
  assert.equal(accepted.operation.state, 'succeeded');
  assert.equal(accepted.resources[0].state, 'present');
  const advancedResource = { ...accepted.resources[0], state: 'ready' };
  fixture = mutationTx({
    operationRow: accepted.operation,
    resourceSelects: [[advancedResource], [advancedResource]],
    insertResource: () => null,
  });
  const replayedAfterAdvance = await repository.recordProviderOperationResourcesTx(fixture.tx, {
    accountId: ACCOUNT,
    operationId: accepted.operation.id,
    resources: [resourceInput({ providerResourceId: 'provider-lifecycle-replay', state: 'present' })],
    now: new Date('2026-09-30T16:05:00.000Z'),
  });
  assert.deepEqual(replayedAfterAdvance.conflicts, []);
  assert.equal(replayedAfterAdvance.resources[0].id, advancedResource.id);
  assert.equal(replayedAfterAdvance.resources[0].state, 'ready', 'receipt replay must not write lifecycle state backward');

  const ambiguousOperation = operation({ id: 'operation-ambiguous', kind: 'asset_upload', state: 'ambiguous' });
  fixture = mutationTx({ operationRow: ambiguousOperation });
  result = await repository.recordProviderOperationResourcesTx(fixture.tx, {
    accountId: ACCOUNT, operationId: ambiguousOperation.id,
    resources: [resourceInput({ providerResourceId: 'provider-ambiguous' })], now: NOW,
  });
  assert.equal(result.operation.state, 'ambiguous', 'accepted evidence cannot silently settle an ambiguous terminal operation');
  assert.equal(result.resources.length, 1);

  const otherOwner = { ...exactTerminal, id: 'resource-other', bindingId: 'binding-other', originOperationId: 'operation-other' };
  fixture = mutationTx({ operationRow: pendingUpload, resourceSelects: [[otherOwner]], insertResource: () => null });
  result = await repository.recordProviderOperationResourcesTx(fixture.tx, {
    accountId: ACCOUNT, operationId: pendingUpload.id,
    resources: [resourceInput()], now: NOW,
  });
  assert.equal(result.operation.state, 'ambiguous');
  assert.equal(result.resources.length, 0);
  assert.equal(fixture.inserted.events.some(item => item.eventType === 'provider.resource_ownership_conflict' && !('resourceId' in item)), true);

  for (const bad of [
    { providerResourceId: 'https://evil.example/resource' },
    { providerResourceId: '.' },
    { providerResourceId: '..' },
    { providerResourceId: 'provider/id' },
    { privateEvidenceRef: 'https://evil.example/evidence' },
    { privateEvidenceRef: 'provider/../secret' },
    { privateEvidenceRef: 'provider\\secret' },
    { publicUrlDigest: 'https://evil.example/raw' },
  ]) {
    fixture = mutationTx({ operationRow: pendingUpload });
    await assert.rejects(repository.recordProviderOperationResourcesTx(fixture.tx, {
      accountId: ACCOUNT, operationId: pendingUpload.id, resources: [resourceInput(bad)], now: NOW,
    }), { code: 'VALIDATION' }, JSON.stringify(bad));
    assert.equal(fixture.inserted.resources.length, 0);
    assert.equal(fixture.inserted.events.length, 0);
  }

  fixture = mutationTx({ operationRow: pendingAvatar, resourceSelects: [[]] });
  await assert.rejects(repository.recordProviderOperationResourcesTx(fixture.tx, {
    accountId: ACCOUNT,
    operationId: pendingAvatar.id,
    resources: [resourceInput({
      kind: 'avatar_look',
      providerResourceId: 'provider-look-safe',
      parentProviderResourceId: 'https://evil.example/group',
    })],
    now: NOW,
  }), { code: 'VALIDATION' });
  assert.equal(fixture.inserted.resources.length, 0);
  assert.equal(fixture.inserted.events.length, 0);

} else {
  throw new Error(`Unknown scenario: ${scenario}`);
}
