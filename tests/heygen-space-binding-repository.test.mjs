import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertFreshHeygenProviderClaimTx,
  assertHeygenProviderReceiptTx,
  createHeygenSpaceBindingRepository,
  HEYGEN_SPACE_BINDING_VERSION,
  PRODUCTION_BINDING_CONFIRMATION_PHRASE,
  withFreshHeygenSpaceBindingTransaction,
  withHeygenSpaceBindingReceiptTransaction,
} from '../db/heygen-space-binding-repository.js';
import {
  providerAccountBindingPromotions,
  providerAccountBindings,
  providerVerifiedAccountScopes,
  users,
} from '../db/schema.js';

const DIGESTS = Object.freeze({
  credentialKey: '379cce9ec574ca3200393e18b481510e56c3113b8a2175dc2164a8290afbdb80',
  credentialScope: '2'.repeat(64),
  keyId: '3'.repeat(64),
  username: '4'.repeat(64),
  space: '5'.repeat(64),
  preflight: '6'.repeat(64),
  spaceProof: '7'.repeat(64),
  identity: '8'.repeat(64),
  result: '9'.repeat(64),
  database: 'a'.repeat(64),
  canonicalScope: 'c'.repeat(64),
});

const ACCOUNT_ID = 'account-binding-test';
const PRIVATE_EVIDENCE_DIR = process.platform === 'win32'
  ? 'C:\\private\\heygen-space-proof'
  : '/private/heygen-space-proof';
const NOW = '2026-10-01T16:00:00.000Z';

function proof() {
  return Object.freeze({
    version: 'heygen-space-qualification-proof/v1',
    provider: 'heygen',
    providerNativeScopeType: 'space',
    globalAccountIdVerified: false,
    credentialKeyFingerprint: DIGESTS.credentialKey,
    credentialScopeFingerprint: DIGESTS.credentialScope,
    keyIdDigest: DIGESTS.keyId,
    keyCreatedAt: '2026-10-01T14:35:48.000Z',
    usernameDigest: DIGESTS.username,
    providerSpaceFingerprint: DIGESTS.space,
    canonicalScopeKey: DIGESTS.canonicalScope,
    preflightEvidenceSha256: DIGESTS.preflight,
    spaceProofSha256: DIGESTS.spaceProof,
    identityDigest: DIGESTS.identity,
    evidenceRefVersion: 'heygen-space-anchor-evidence/v1',
    probeResultSha256: DIGESTS.result,
    spaceObservedAt: '2026-10-01T15:18:00.000Z',
    qualifiedAt: NOW,
    expiresAt: '2026-10-01T16:01:00.000Z',
    anchorExpiresAt: '2026-10-02T15:18:03.000Z',
  });
}

function tableRows(state, table) {
  if (table === users) return state.users;
  if (table === providerVerifiedAccountScopes) return state.scopes;
  if (table === providerAccountBindings) return state.bindings;
  if (table === providerAccountBindingPromotions) return state.promotions;
  throw new Error('unexpected table');
}

function cloneState(state) {
  return {
    users: state.users.map(row => ({ ...row })),
    scopes: state.scopes.map(row => ({ ...row })),
    bindings: state.bindings.map(row => ({ ...row })),
    promotions: state.promotions.map(row => ({ ...row })),
    sequence: state.sequence,
  };
}

function createExecutor(initial = {}) {
  const state = {
    users: initial.users || [{ id: ACCOUNT_ID }],
    scopes: initial.scopes || [],
    bindings: initial.bindings || [],
    promotions: initial.promotions || [],
    sequence: 0,
  };
  const operations = [];

  function buildTransaction(draft) {
    return {
      select() {
        return {
          from(table) {
            operations.push(`select:${tableRows(draft, table) === draft.users ? 'users'
              : tableRows(draft, table) === draft.scopes ? 'scopes'
                : tableRows(draft, table) === draft.bindings ? 'bindings' : 'promotions'}`);
            const rows = tableRows(draft, table);
            const query = {
              where() { return query; },
              limit: async count => rows.slice(0, count),
              then(resolve, reject) { return Promise.resolve(rows.slice()).then(resolve, reject); },
            };
            return query;
          },
        };
      },
      insert(table) {
        return {
          values(values) {
            let ignoreConflict = false;
            const statement = {
              onConflictDoNothing() { ignoreConflict = true; return statement; },
              async returning() {
                const rows = tableRows(draft, table);
                let conflict = false;
                if (table === providerVerifiedAccountScopes) {
                  conflict = rows.some(row => row.provider === values.provider
                    && row.providerAccountFingerprint === values.providerAccountFingerprint);
                } else if (table === providerAccountBindings) {
                  conflict = rows.some(row => row.applicationAccountId === values.applicationAccountId
                    && row.provider === values.provider && row.environment === values.environment
                    && row.projectId === values.projectId
                    && row.databaseBindingSha256 === values.databaseBindingSha256
                    && row.lifecycleState === 'active');
                }
                if (conflict && ignoreConflict) return [];
                if (conflict) throw new Error('unique conflict');
                draft.sequence += 1;
                const now = new Date(NOW);
                const row = {
                  id: `00000000-0000-4000-8000-${String(draft.sequence).padStart(12, '0')}`,
                  ...values,
                  ...(table === providerAccountBindings ? {
                    lifecycleState: values.lifecycleState || 'active',
                    revokedAt: values.revokedAt || null,
                    createdAt: values.createdAt || now,
                    updatedAt: values.updatedAt || now,
                  } : {}),
                  ...(table === providerAccountBindingPromotions ? {
                    revokedAt: values.revokedAt || null,
                  } : {}),
                };
                rows.push(row);
                operations.push(`insert:${table === providerVerifiedAccountScopes ? 'scope'
                  : table === providerAccountBindings ? 'binding' : 'promotion'}`);
                return [row];
              },
            };
            return statement;
          },
        };
      },
    };
  }

  return {
    state,
    operations,
    async transaction(callback) {
      operations.push('transaction');
      const draft = cloneState(state);
      try {
        const result = await callback(buildTransaction(draft));
        Object.assign(state, draft);
        operations.push('commit');
        return result;
      } catch (error) {
        operations.push('rollback');
        throw error;
      }
    },
  };
}

function fixture(options = {}) {
  const events = [];
  const executor = options.executor || createExecutor();
  const env = options.env || {
    VIDEO_OS_SPACE_BINDING_ENVIRONMENT: 'verification',
    DATABASE_URL: 'postgresql://user:secret@verification.example.test/database?sslmode=require',
    HEYGEN_API_KEY: 'secret-test-key',
  };
  const verifiedProof = options.proof || proof();
  const proofBrand = new WeakSet([verifiedProof]);
  const clock = options.now || (() => new Date(NOW));
  const repository = createHeygenSpaceBindingRepository({
    env: () => env,
    now: clock,
    executor,
    targetPreflight: options.targetPreflight || (async () => {
      events.push('target-preflight');
      return Object.freeze({
        environment: 'verification',
        projectId: 'prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW',
        databaseBindingSha256: DIGESTS.database,
        databaseUrl: env.DATABASE_URL,
        unpooledUrl: null,
      });
    }),
    loadVerifiedHeygenSpaceAnchor: async ({ privateEvidenceDirectory }) => {
      events.push(`private-anchor:${privateEvidenceDirectory}`);
      return Object.freeze({ kind: 'private-anchor', credentialKeyFingerprint: DIGESTS.credentialKey });
    },
    loadPinnedHeygenSpaceAnchorProjection: async () => {
      events.push('public-anchor');
      return Object.freeze({ kind: 'public-anchor', credentialKeyFingerprint: DIGESTS.credentialKey });
    },
    qualifyHeygenCredential: async ({ apiKey }) => {
      events.push(`qualify:${apiKey === env.HEYGEN_API_KEY}`);
      if (options.onQualify) options.onQualify(env);
      return Object.freeze({ kind: 'qualification' });
    },
    validateFreshHeygenQualification: () => {
      events.push('join-proof');
      return verifiedProof;
    },
    assertFreshHeygenSpaceProof: candidate => {
      events.push('assert-proof');
      if (!proofBrand.has(candidate) || Date.parse(candidate.expiresAt) < clock().getTime()) {
        throw Object.assign(new Error('stale proof'), { code: 'HEYGEN_SPACE_PROOF_STALE' });
      }
      return candidate;
    },
    assertFreshHeygenBootstrapProof: candidate => {
      events.push('assert-bootstrap-proof');
      if (!proofBrand.has(candidate) || Date.parse(candidate.expiresAt) < clock().getTime()) {
        throw Object.assign(new Error('stale proof'), { code: 'HEYGEN_SPACE_PROOF_STALE' });
      }
      return candidate;
    },
    acquireProviderLifecycleLock: async () => {
      events.push('account-lock');
      executor.operations.push('account-lock');
    },
  });
  return { repository, executor, env, events, verifiedProof };
}

test('bootstrap creates exactly one immutable scope, binding, and verified promotion and is idempotent', async () => {
  const { repository, executor, events } = fixture();
  const first = await repository.bootstrapVerifiedHeygenSpaceBinding({
    accountId: ACCOUNT_ID,
    privateEvidenceDir: PRIVATE_EVIDENCE_DIR,
  });
  const second = await repository.bootstrapVerifiedHeygenSpaceBinding({
    accountId: ACCOUNT_ID,
    privateEvidenceDir: PRIVATE_EVIDENCE_DIR,
  });

  assert.equal(first.version, HEYGEN_SPACE_BINDING_VERSION);
  assert.equal(second.bindingId, first.bindingId);
  assert.equal(executor.state.scopes.length, 1);
  assert.equal(executor.state.bindings.length, 1);
  assert.equal(executor.state.promotions.length, 1);
  assert.equal(executor.state.scopes[0].providerAccountFingerprint, DIGESTS.space);
  assert.equal(executor.state.scopes[0].canonicalScopeKey, DIGESTS.canonicalScope);
  assert.equal(executor.state.scopes[0].evidenceDigest, DIGESTS.spaceProof);
  assert.equal(executor.state.bindings[0].credentialEvidenceDigest, DIGESTS.preflight);
  assert.equal(executor.state.promotions[0].evidenceDigest, DIGESTS.identity);
  assert.equal(executor.state.promotions[0].observedAt.toISOString(), proof().spaceObservedAt);
  assert.deepEqual(events.slice(0, 5), [
    'target-preflight',
    `private-anchor:${PRIVATE_EVIDENCE_DIR}`,
    'qualify:true',
    'join-proof',
    'assert-bootstrap-proof',
  ]);
  const firstTransaction = executor.operations.indexOf('transaction');
  assert.equal(executor.operations[firstTransaction + 1], 'account-lock');
  assert.equal(executor.operations[firstTransaction + 2], 'select:users');
});

test('fresh resolver joins live qualification to exact persisted graph and returns only branded authority', async () => {
  const { repository } = fixture();
  await repository.bootstrapVerifiedHeygenSpaceBinding({ accountId: ACCOUNT_ID, privateEvidenceDir: PRIVATE_EVIDENCE_DIR });
  const binding = await repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID });
  assert.equal(repository.assertFreshHeygenSpaceBinding(binding), binding);
  assert.throws(
    () => repository.assertFreshHeygenSpaceBinding(JSON.parse(JSON.stringify(binding))),
    error => error.code === 'HEYGEN_SPACE_BINDING_UNVERIFIED',
  );
  const status = repository.safeHeygenSpaceBindingStatus(binding);
  assert.equal(status.verified, true);
  assert.equal(status.runtimeActivation, false);
  assert.equal(status.globalAccountIdVerified, false);
  assert.equal(status.providerSpaceFingerprint, DIGESTS.space);
  assert.equal(Object.hasOwn(status, 'applicationAccountId'), false);
  assert.equal(Object.hasOwn(status, 'bindingId'), false);
  assert.equal(JSON.stringify(status).includes(ACCOUNT_ID), false);
});

test('claim transaction stays on the executor captured by the branded binding', async () => {
  const intendedExecutor = createExecutor();
  const unrelatedCachedExecutor = createExecutor();
  const { repository } = fixture({ executor: intendedExecutor });
  const binding = await repository.bootstrapVerifiedHeygenSpaceBinding({
    accountId: ACCOUNT_ID,
    privateEvidenceDir: PRIVATE_EVIDENCE_DIR,
  });
  const before = intendedExecutor.operations.length;
  const value = await withFreshHeygenSpaceBindingTransaction({ accountId: ACCOUNT_ID, providerBinding: binding }, async tx => {
    assert.equal(assertFreshHeygenProviderClaimTx(tx, { accountId: ACCOUNT_ID, providerBinding: binding }), binding);
    return 'claimed';
  });
  assert.equal(value, 'claimed');
  assert.equal(intendedExecutor.operations[before], 'transaction');
  assert.equal(intendedExecutor.operations[before + 1], 'account-lock');
  assert.equal(unrelatedCachedExecutor.operations.length, 0);
  await assert.rejects(
    withFreshHeygenSpaceBindingTransaction({ accountId: ACCOUNT_ID, providerBinding: { ...binding } }, async () => {}),
    error => error.code === 'HEYGEN_SPACE_BINDING_UNVERIFIED',
  );
  await assert.rejects(
    withFreshHeygenSpaceBindingTransaction({ accountId: 'different-account', providerBinding: binding }, async () => {}),
    error => error.code === 'HEYGEN_SPACE_BINDING_ACCOUNT_MISMATCH',
  );
});

test('returned binding rejects clock rollback and the exact expiry boundary', async () => {
  let current = new Date(NOW);
  const { repository } = fixture({ now: () => current });
  const binding = await repository.bootstrapVerifiedHeygenSpaceBinding({
    accountId: ACCOUNT_ID,
    privateEvidenceDir: PRIVATE_EVIDENCE_DIR,
  });
  current = new Date('2026-10-01T15:59:59.999Z');
  assert.throws(
    () => repository.assertFreshHeygenSpaceBinding(binding),
    error => error.code === 'HEYGEN_SPACE_BINDING_STALE',
  );
  current = new Date('2026-10-01T16:01:00.000Z');
  assert.throws(
    () => repository.assertFreshHeygenSpaceBinding(binding),
    error => error.code === 'HEYGEN_SPACE_BINDING_STALE',
  );
});

test('receipt transaction preserves accepted evidence after claim freshness or key expires', async () => {
  let current = new Date(NOW);
  const { repository, env, executor } = fixture({ now: () => current });
  const binding = await repository.bootstrapVerifiedHeygenSpaceBinding({
    accountId: ACCOUNT_ID,
    privateEvidenceDir: PRIVATE_EVIDENCE_DIR,
  });
  current = new Date(binding.expiresAt);
  env.HEYGEN_API_KEY = 'rotated-after-provider-response';
  assert.throws(() => repository.assertFreshHeygenSpaceBinding(binding), error => (
    ['HEYGEN_SPACE_BINDING_STALE', 'HEYGEN_BINDING_INPUT_DRIFT'].includes(error.code)
  ));
  const before = executor.operations.length;
  const saved = await withHeygenSpaceBindingReceiptTransaction({ accountId: ACCOUNT_ID, providerBinding: binding }, async tx => {
    assert.equal(assertHeygenProviderReceiptTx(tx, { accountId: ACCOUNT_ID, providerBinding: binding }), binding);
    return 'receipt-saved';
  });
  assert.equal(saved, 'receipt-saved');
  assert.equal(executor.operations[before], 'transaction');
  assert.equal(executor.operations[before + 1], 'account-lock');
});

test('returned binding expires at the anchor boundary even when qualification lasts longer', async () => {
  let current = new Date(NOW);
  const shortAnchorProof = Object.freeze({ ...proof(), anchorExpiresAt: '2026-10-01T16:00:30.000Z' });
  const { repository } = fixture({ proof: shortAnchorProof, now: () => current });
  const binding = await repository.bootstrapVerifiedHeygenSpaceBinding({
    accountId: ACCOUNT_ID,
    privateEvidenceDir: PRIVATE_EVIDENCE_DIR,
  });
  assert.equal(binding.expiresAt, shortAnchorProof.anchorExpiresAt);
  current = new Date(shortAnchorProof.anchorExpiresAt);
  assert.throws(
    () => repository.assertFreshHeygenSpaceBinding(binding),
    error => error.code === 'HEYGEN_SPACE_BINDING_STALE',
  );
});

test('production environment without the explicit confirmation fails before target files, provider access, or a transaction', async () => {
  const executor = createExecutor();
  let fileAccesses = 0;
  let providerCalls = 0;
  const repository = createHeygenSpaceBindingRepository({
    env: () => ({
      VIDEO_OS_SPACE_BINDING_ENVIRONMENT: 'production',
      // Deliberately no VIDEO_OS_PRODUCTION_BINDING_CONFIRMED -- requesting
      // the environment string alone must never be enough.
      DATABASE_URL: 'postgresql://do-not-use',
      HEYGEN_API_KEY: 'do-not-use',
    }),
    executor,
    lstat: async () => { fileAccesses += 1; throw new Error('must not run'); },
    qualifyHeygenCredential: async () => { providerCalls += 1; throw new Error('must not run'); },
  });
  await assert.rejects(
    repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
    error => error.code === 'PRODUCTION_BINDING_NOT_EXPLICITLY_CONFIRMED',
  );
  assert.equal(fileAccesses, 0);
  assert.equal(providerCalls, 0);
  assert.equal(executor.operations.length, 0);
});

test('production environment with the wrong confirmation value still fails before any access', async () => {
  const executor = createExecutor();
  let fileAccesses = 0;
  const repository = createHeygenSpaceBindingRepository({
    env: () => ({
      VIDEO_OS_SPACE_BINDING_ENVIRONMENT: 'production',
      VIDEO_OS_PRODUCTION_BINDING_CONFIRMED: 'yes', // not the exact pinned phrase
      DATABASE_URL: 'postgresql://do-not-use',
      HEYGEN_API_KEY: 'do-not-use',
    }),
    executor,
    lstat: async () => { fileAccesses += 1; throw new Error('must not run'); },
  });
  await assert.rejects(
    repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
    error => error.code === 'PRODUCTION_BINDING_NOT_EXPLICITLY_CONFIRMED',
  );
  assert.equal(fileAccesses, 0);
  assert.equal(executor.operations.length, 0);
});

test('a running Vercel production runtime is rejected regardless of requested environment or confirmation', async () => {
  const executor = createExecutor();
  const repository = createHeygenSpaceBindingRepository({
    env: () => ({
      VERCEL_ENV: 'production',
      VIDEO_OS_SPACE_BINDING_ENVIRONMENT: 'verification',
      DATABASE_URL: 'postgresql://do-not-use',
      HEYGEN_API_KEY: 'do-not-use',
    }),
    executor,
    lstat: async () => { throw new Error('must not run'); },
  });
  await assert.rejects(
    repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
    error => error.code === 'CANONICAL_TARGET_UNVERIFIED',
  );
  assert.equal(executor.operations.length, 0);
});

test('missing verification selector fails closed before provider or database access', async () => {
  const executor = createExecutor();
  let providerCalls = 0;
  const repository = createHeygenSpaceBindingRepository({
    env: () => ({ DATABASE_URL: 'postgresql://do-not-use', HEYGEN_API_KEY: 'do-not-use' }),
    executor,
    qualifyHeygenCredential: async () => { providerCalls += 1; throw new Error('must not run'); },
  });
  await assert.rejects(
    repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
    error => error.code === 'HEYGEN_BINDING_ENVIRONMENT_UNSUPPORTED',
  );
  assert.equal(providerCalls, 0);
  assert.equal(executor.operations.length, 0);
});

test('target preflight failure occurs before anchor loading, qualification, or database transaction', async () => {
  const executor = createExecutor();
  const { repository, events } = fixture({
    executor,
    targetPreflight: async () => {
      events?.push('target-failed');
      throw Object.assign(new Error('target held'), { code: 'DATABASE_PREFLIGHT_FAILED' });
    },
  });
  await assert.rejects(
    repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
    error => error.code === 'DATABASE_PREFLIGHT_FAILED',
  );
  assert.equal(events.some(event => event.startsWith('qualify:')), false);
  assert.equal(executor.operations.length, 0);
});

test('missing application account is checked after the account lock and rolls back all rows', async () => {
  const executor = createExecutor({ users: [] });
  const { repository } = fixture({ executor });
  await assert.rejects(
    repository.bootstrapVerifiedHeygenSpaceBinding({ accountId: ACCOUNT_ID, privateEvidenceDir: PRIVATE_EVIDENCE_DIR }),
    error => error.code === 'APPLICATION_ACCOUNT_NOT_FOUND',
  );
  const transaction = executor.operations.indexOf('transaction');
  assert.equal(executor.operations[transaction + 1], 'account-lock');
  assert.equal(executor.operations[transaction + 2], 'select:users');
  assert.equal(executor.operations.at(-1), 'rollback');
  assert.equal(executor.state.scopes.length, 0);
  assert.equal(executor.state.bindings.length, 0);
  assert.equal(executor.state.promotions.length, 0);
});

test('credential drift after qualification fails before the database transaction', async () => {
  const executor = createExecutor();
  const { repository } = fixture({
    executor,
    onQualify(env) { env.HEYGEN_API_KEY = 'rotated-test-key'; },
  });
  await assert.rejects(
    repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
    error => error.code === 'HEYGEN_BINDING_INPUT_DRIFT',
  );
  assert.equal(executor.operations.length, 0);
});

test('credential drift after claim resolution invalidates the HTTP-boundary assertion', async () => {
  const { repository, env, executor } = fixture();
  const binding = await repository.bootstrapVerifiedHeygenSpaceBinding({
    accountId: ACCOUNT_ID,
    privateEvidenceDir: PRIVATE_EVIDENCE_DIR,
  });
  env.HEYGEN_API_KEY = 'rotated-after-resolution';
  assert.throws(
    () => repository.assertFreshHeygenSpaceBinding(binding),
    error => error.code === 'HEYGEN_BINDING_INPUT_DRIFT',
  );
  const before = executor.operations.length;
  await assert.rejects(
    withFreshHeygenSpaceBindingTransaction({ accountId: ACCOUNT_ID, providerBinding: binding }, async () => {}),
    error => error.code === 'HEYGEN_BINDING_INPUT_DRIFT',
  );
  assert.equal(executor.operations.length, before);
});

test('credential mismatch with pinned anchor fails before any provider request', async () => {
  const executor = createExecutor();
  let providerCalls = 0;
  const env = {
    VIDEO_OS_SPACE_BINDING_ENVIRONMENT: 'verification',
    DATABASE_URL: 'postgresql://user:secret@verification.example.test/database?sslmode=require',
    HEYGEN_API_KEY: 'different-key',
  };
  const repository = createHeygenSpaceBindingRepository({
    env: () => env,
    now: () => new Date(NOW),
    executor,
    targetPreflight: async () => ({
      environment: 'verification',
      projectId: 'prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW',
      databaseBindingSha256: DIGESTS.database,
      databaseUrl: env.DATABASE_URL,
      unpooledUrl: null,
    }),
    loadPinnedHeygenSpaceAnchorProjection: async () => ({ credentialKeyFingerprint: DIGESTS.credentialKey }),
    qualifyHeygenCredential: async () => { providerCalls += 1; throw new Error('must not run'); },
  });
  await assert.rejects(
    repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
    error => error.code === 'HEYGEN_CREDENTIAL_ANCHOR_MISMATCH',
  );
  assert.equal(providerCalls, 0);
  assert.equal(executor.operations.length, 0);
});

test('resolver rejects persisted scope evidence drift without changing rows', async () => {
  const { repository, executor } = fixture();
  await repository.bootstrapVerifiedHeygenSpaceBinding({ accountId: ACCOUNT_ID, privateEvidenceDir: PRIVATE_EVIDENCE_DIR });
  executor.state.scopes[0].evidenceDigest = 'f'.repeat(64);
  await assert.rejects(
    repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
    error => error.code === 'HEYGEN_SPACE_SCOPE_CONFLICT',
  );
  assert.equal(executor.state.scopes[0].evidenceDigest, 'f'.repeat(64));
  assert.equal(executor.operations.at(-1), 'rollback');
});

test('resolver rejects a promotion that rewrites the original provider observation time', async () => {
  const { repository, executor } = fixture();
  await repository.bootstrapVerifiedHeygenSpaceBinding({ accountId: ACCOUNT_ID, privateEvidenceDir: PRIVATE_EVIDENCE_DIR });
  executor.state.promotions[0].observedAt = new Date('2026-10-01T15:19:00.000Z');
  await assert.rejects(
    repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
    error => error.code === 'HEYGEN_SPACE_PROMOTION_CONFLICT',
  );
  assert.equal(executor.state.promotions[0].observedAt.toISOString(), '2026-10-01T15:19:00.000Z');
  assert.equal(executor.operations.at(-1), 'rollback');
});

test('revoked bindings and promotions cannot be revived by the fresh resolver', async () => {
  for (const revoke of ['binding', 'promotion']) {
    const { repository, executor } = fixture();
    await repository.bootstrapVerifiedHeygenSpaceBinding({ accountId: ACCOUNT_ID, privateEvidenceDir: PRIVATE_EVIDENCE_DIR });
    if (revoke === 'binding') {
      executor.state.bindings[0].lifecycleState = 'revoked';
      executor.state.bindings[0].revokedAt = new Date(NOW);
    } else {
      executor.state.promotions[0].state = 'revoked';
      executor.state.promotions[0].revokedAt = new Date(NOW);
    }
    const before = JSON.stringify(executor.state);
    await assert.rejects(
      repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
      error => ['HEYGEN_SPACE_BINDING_CONFLICT', 'HEYGEN_SPACE_BINDING_NOT_ACTIVE', 'HEYGEN_SPACE_PROMOTION_CONFLICT'].includes(error.code),
    );
    assert.equal(JSON.stringify(executor.state), before);
    assert.equal(executor.operations.at(-1), 'rollback');
  }
});

test('multiple promotion history fails closed without selecting or writing a replacement', async () => {
  const { repository, executor } = fixture();
  await repository.bootstrapVerifiedHeygenSpaceBinding({ accountId: ACCOUNT_ID, privateEvidenceDir: PRIVATE_EVIDENCE_DIR });
  executor.state.promotions.push({
    ...executor.state.promotions[0],
    id: '00000000-0000-4000-8000-999999999999',
    state: 'revoked',
    revokedAt: new Date(NOW),
  });
  const before = JSON.stringify(executor.state);
  await assert.rejects(
    repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
    error => error.code === 'HEYGEN_SPACE_PROMOTION_CONFLICT',
  );
  assert.equal(JSON.stringify(executor.state), before);
  assert.equal(executor.operations.at(-1), 'rollback');
});

test('per-call inputs reject caller-supplied targets, digests, actors, and raw bindings', async () => {
  const { repository, executor } = fixture();
  for (const extra of ['target', 'databaseBindingSha256', 'actor', 'providerBinding']) {
    await assert.rejects(
      repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID, [extra]: 'untrusted' }),
      error => error.code === 'INVALID_HEYGEN_SPACE_BINDING_INPUT',
    );
  }
  assert.equal(executor.operations.length, 0);
});

test('default target preflight validates pinned URL and schema before provider access', async () => {
  const executor = createExecutor();
  const order = [];
  const env = {
    VIDEO_OS_SPACE_BINDING_ENVIRONMENT: 'verification',
    DATABASE_URL: 'postgresql://user:secret@verification.example.test/database?sslmode=require',
    DATABASE_URL_UNPOOLED: 'postgresql://user:secret@verification-direct.example.test/database?sslmode=require',
    HEYGEN_API_KEY: 'secret-test-key',
  };
  const target = {
    version: 1,
    environment: 'verification',
    projectId: 'dawn-scene-51988854',
    branchId: 'br-wandering-violet-ai1egt3g',
    parentBranchId: 'br-young-base-ai9mgkgd',
    isDefault: false,
    hosts: [
      'ep-lingering-fire-aitvfm3y.c-4.us-east-1.aws.neon.tech',
      'ep-lingering-fire-aitvfm3y-pooler.c-4.us-east-1.aws.neon.tech',
    ],
    database: 'mvp_verification_20260930',
    roles: ['neondb_owner'],
    port: 5432,
    schemaLock: 'database-schema.lock.json',
  };
  const verifiedProof = proof();
  const repository = createHeygenSpaceBindingRepository({
    env: () => env,
    now: () => new Date(NOW),
    executor,
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    loadTargetManifest: async () => {
      order.push('load-target');
      return {
        target,
        targetManifestSha256: 'b443ea305508910ddae9cee231d056be35e7511ab96e212c66b6770d09090fa9',
        targetManifestBinding: 'verification-manifest',
      };
    },
    loadSchemaLock: async () => {
      order.push('load-schema-lock');
      return { schemaLock: {}, schemaLockSha256: 'b'.repeat(64), schemaLockBinding: 'verification-schema-lock' };
    },
    validateTarget: url => {
      order.push(`validate-url:${url.includes('direct') ? 'unpooled' : 'canonical'}`);
      return { endpoint: 'verified', port: 5432, database: 'database', role: 'user', environment: 'verification' };
    },
    checkDatabaseMigrations: async () => {
      order.push('check-schema');
      return {
        verified: true,
        scope: 'live-database',
        journalVerified: true,
        environment: 'verification',
        targetManifestSha256: 'b443ea305508910ddae9cee231d056be35e7511ab96e212c66b6770d09090fa9',
      };
    },
    databaseBindingSha256: () => DIGESTS.database,
    loadVerifiedHeygenSpaceAnchor: async () => Object.freeze({ credentialKeyFingerprint: DIGESTS.credentialKey }),
    loadPinnedHeygenSpaceAnchorProjection: async () => {
      order.push('load-anchor');
      return Object.freeze({ credentialKeyFingerprint: DIGESTS.credentialKey });
    },
    qualifyHeygenCredential: async () => {
      order.push('qualify');
      return Object.freeze({});
    },
    validateFreshHeygenQualification: () => verifiedProof,
    assertFreshHeygenSpaceProof: () => verifiedProof,
    assertFreshHeygenBootstrapProof: () => verifiedProof,
    acquireProviderLifecycleLock: async () => executor.operations.push('account-lock'),
  });
  await assert.rejects(
    repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
    error => error.code === 'HEYGEN_SPACE_BINDING_NOT_ACTIVE',
  );
  assert.deepEqual(order.slice(0, 7), [
    'load-target',
    'validate-url:canonical',
    'validate-url:unpooled',
    'load-schema-lock',
    'check-schema',
    'load-anchor',
    'qualify',
  ]);
});

test('default target preflight validates the pinned production target only with explicit confirmation, same pipeline as verification', async () => {
  const executor = createExecutor();
  const order = [];
  const env = {
    VIDEO_OS_SPACE_BINDING_ENVIRONMENT: 'production',
    VIDEO_OS_PRODUCTION_BINDING_CONFIRMED: PRODUCTION_BINDING_CONFIRMATION_PHRASE,
    DATABASE_URL: 'postgresql://user:secret@production.example.test/database?sslmode=require',
    HEYGEN_API_KEY: 'secret-test-key',
  };
  // Exact real content of config/database-target.production.json -- the
  // pinned hash this test must satisfy is computed from this file, so a
  // realistic fixture (not an arbitrary one) is required for this to pass.
  const target = {
    version: 1,
    environment: 'production',
    projectId: 'still-voice-83326863',
    branchId: 'br-broad-sunset-awrsmiwa',
    isDefault: true,
    hosts: [
      'ep-autumn-morning-awa4hmb6.c-12.us-east-1.aws.neon.tech',
      'ep-autumn-morning-awa4hmb6-pooler.c-12.us-east-1.aws.neon.tech',
    ],
    database: 'neondb',
    roles: ['neondb_owner'],
    port: 5432,
    schemaLock: 'database-schema.lock.json',
    note: 'Owner-designated production target. Populated from independent Neon control-plane metadata and the redacted canonical-variable provenance audit; contains no credential.',
  };
  const verifiedProof = proof();
  const repository = createHeygenSpaceBindingRepository({
    env: () => env,
    now: () => new Date(NOW),
    executor,
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    loadTargetManifest: async () => {
      order.push('load-target');
      return { target, targetManifestSha256: 'c'.repeat(64), targetManifestBinding: 'canonical-repository-manifest' };
    },
    loadSchemaLock: async () => {
      order.push('load-schema-lock');
      return { schemaLock: {}, schemaLockSha256: 'd'.repeat(64), schemaLockBinding: 'canonical-repository-schema-lock' };
    },
    validateTarget: url => {
      order.push(`validate-url:${url.includes('verification') ? 'unexpected' : 'canonical'}`);
      return { endpoint: 'verified', port: 5432, database: 'neondb', role: 'neondb_owner', environment: 'production' };
    },
    checkDatabaseMigrations: async () => {
      order.push('check-schema');
      return { verified: true, scope: 'live-database', journalVerified: true, environment: 'production', targetManifestSha256: 'c'.repeat(64) };
    },
    databaseBindingSha256: input => { assert.equal(input.environment, 'production'); return DIGESTS.database; },
    loadPinnedHeygenSpaceAnchorProjection: async () => {
      order.push('load-anchor');
      return Object.freeze({ credentialKeyFingerprint: DIGESTS.credentialKey });
    },
    qualifyHeygenCredential: async () => { order.push('qualify'); return Object.freeze({}); },
    validateFreshHeygenQualification: () => verifiedProof,
    assertFreshHeygenSpaceProof: () => verifiedProof,
    acquireProviderLifecycleLock: async () => executor.operations.push('account-lock'),
  });
  await assert.rejects(
    repository.resolveFreshHeygenSpaceBinding({ accountId: ACCOUNT_ID }),
    error => error.code === 'HEYGEN_SPACE_BINDING_NOT_ACTIVE',
  );
  assert.deepEqual(order.slice(0, 5), ['load-target', 'validate-url:canonical', 'load-schema-lock', 'check-schema', 'load-anchor']);
});

test('bootstrap succeeds end to end for the confirmed production environment and yields a production-tagged binding', async () => {
  const { repository, executor } = fixture({
    env: {
      VIDEO_OS_SPACE_BINDING_ENVIRONMENT: 'production',
      VIDEO_OS_PRODUCTION_BINDING_CONFIRMED: PRODUCTION_BINDING_CONFIRMATION_PHRASE,
      DATABASE_URL: 'postgresql://user:secret@production.example.test/database?sslmode=require',
      HEYGEN_API_KEY: 'secret-test-key',
    },
    targetPreflight: async () => Object.freeze({
      environment: 'production',
      projectId: 'prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW',
      databaseBindingSha256: DIGESTS.database,
      databaseUrl: 'postgresql://user:secret@production.example.test/database?sslmode=require',
      unpooledUrl: null,
    }),
  });
  const binding = await repository.bootstrapVerifiedHeygenSpaceBinding({
    accountId: ACCOUNT_ID,
    privateEvidenceDir: PRIVATE_EVIDENCE_DIR,
  });
  assert.equal(binding.environment, 'production');
  assert.equal(executor.state.bindings[0].environment, 'production');
  const status = repository.safeHeygenSpaceBindingStatus(binding);
  assert.equal(status.environment, 'production');
  assert.equal(status.runtimeActivation, false);
  assert.equal(repository.assertFreshHeygenSpaceBinding(binding), binding);
});
