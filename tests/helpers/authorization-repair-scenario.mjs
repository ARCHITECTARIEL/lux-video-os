import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { FatalError } from 'workflow';
import { containedRenderingEntitlementKeys } from '../../lib/video-os-security.js';
import { REGISTERED_TESTER_ACCOUNTS } from '../../lib/video-os-testers.js';
import { parseDurableRenderFailure } from '../../lib/scripted-photo-contract.js';

const scenario = process.argv[2];
const accountId = 'test-domain-account';
const email = 'test-member@luxmarketingcompany.com';

if (scenario === 'claim') {
  const schema = await import('../../db/schema.js');
  let active = false;
  let enabled = false;
  let updates = 0;
  let sharedGrantRead = false;
  const providerBinding = { fixture: 'authorization-only-verified-binding', applicationAccountId: accountId };
  let job = { id: 'claim-job', accountId, projectId: null, title: 'Authorization fixture', format: 'vertical', correlationId: 'claim-fixture', provider: 'heygen', status: 'workflow_started', input: {} };
  const db = {
    async transaction(fn) { active = true; try { return await fn(db); } finally { active = false; } },
    async execute(statement) {
      assert.equal(active, true);
      const query = new PgDialect().sqlToQuery(statement);
      assert.match(query.sql, /pg_advisory_xact_lock\(hashtextextended\(/);
      assert.deepEqual(query.params, [`provider-lifecycle-v1:${Buffer.byteLength(accountId)}:${accountId}`]);
      return { rows: [] };
    },
    select() {
      let table;
      return { from(value) { table = value; return this; }, where() { return this; }, limit() { return this; }, for(mode) { if (table === schema.entitlements) { assert.equal(active, true); assert.equal(mode, 'share'); sharedGrantRead = true; } return this; }, then(resolve, reject) {
        return Promise.resolve(table === schema.videoJobs ? [job] : table === schema.users ? [{ id: accountId, email }] : [{ accountId, enabled, entitlementKey: job.provider === 'sadtalker' ? 'standardRendering' : 'liveRendering', sourceType: 'admin_tester_grant' }]).then(resolve, reject);
      } };
    },
    update() { return { set(value) { updates++; job = { ...job, ...value }; return { where() { return { returning: async () => [job] }; } }; } }; },
    insert() { return { values: async () => {} }; },
  };
  mock.module('../../db/client.js', { namedExports: { database: () => db } });
  const { acquireProviderLifecycleLock } = await import('../../db/provider-lifecycle-lock.js');
  let activeBindingTransaction = null;
  mock.module('../../db/heygen-space-binding-repository.js', { namedExports: {
    withFreshHeygenSpaceBindingTransaction: async (input, callback) => {
      assert.equal(input.accountId, accountId); assert.equal(input.providerBinding, providerBinding);
      return db.transaction(async tx => {
        await acquireProviderLifecycleLock(tx, accountId);
        activeBindingTransaction = tx;
        try { return await callback(tx); } finally { activeBindingTransaction = null; }
      });
    },
    withHeygenSpaceBindingReceiptTransaction: async (input, callback) => db.transaction(callback),
    assertFreshHeygenProviderClaimTx: (tx, input) => {
      assert.equal(tx, activeBindingTransaction); assert.equal(input.providerBinding, providerBinding); return providerBinding;
    },
    assertHeygenProviderReceiptTx: () => providerBinding,
  } });
  const ledger = await import('../../db/provider-reconciliation-repository.js');
  mock.module('../../db/provider-reconciliation-repository.js', { namedExports: {
    ...ledger,
    reserveProviderOperationTx: async (tx, input) => {
      assert.equal(tx, db); assert.equal(input.accountId, accountId);
      assert.equal(input.binding, providerBinding); assert.equal(input.kind, 'video_create');
      assert.equal(input.jobId, job.id); assert.equal(enabled, true);
      return { binding: { id: 'fixture-binding', originScopeKey: '6'.repeat(64) }, operation: { id: 'fixture-video-operation', state: 'pending' } };
    },
  } });
  const { transitionJob } = await import('../../db/repositories.js');
  for (const provider of ['heygen', 'sadtalker']) {
    job = { ...job, provider, status: 'workflow_started' }; enabled = false; updates = 0; sharedGrantRead = false;
    await assert.rejects(
      transitionJob({ jobId: job.id, stageTo: 'provider_submitting' }),
      { statusCode: provider === 'heygen' ? 503 : 403 },
    );
    assert.equal(updates, 0, 'revocation before claim prevents the submission transition');
    assert.equal(sharedGrantRead, provider !== 'heygen', 'a missing HeyGen binding fails before entitlement/provider mutation');
    enabled = true;
    if (provider === 'heygen') {
      await assert.rejects(
        transitionJob({ jobId: job.id, stageTo: 'provider_submitting', providerBinding }),
        { failureCategory: 'PROVIDER_RESOURCE_UNVERIFIED' },
      );
      assert.equal(updates, 0, 'unbound stock talent cannot cross the verified provider-space claim');
      continue;
    }
    const claimed = await transitionJob({
      jobId: job.id,
      stageTo: 'provider_submitting',
      ...(provider === 'heygen' ? { providerBinding } : {}),
    });
    assert.equal(claimed.status, 'provider_submitting');
    await assert.rejects(transitionJob({ jobId: job.id, stageTo: 'provider_submitting' }), { statusCode: 409 });
    assert.equal(updates, 1, 'the claim cannot be replayed');
  }
} else if (scenario === 'admin') {
  const schema = await import('../../db/schema.js');
  const { accountIdForEmail } = await import('../../lib/video-os-account.js');
  let user;
  let duplicate = false;
  const conditions = [];
  const { PgDialect } = await import('drizzle-orm/pg-core');
  let credits;
  let grants = [];
  const db = {
    transaction: async fn => fn(db),
    select(fields) {
      let table;
      return { from(value) { table = value; return this; }, where(condition) { conditions.push(new PgDialect().sqlToQuery(condition).sql); return this; }, for() { return this; }, limit() { return this; }, innerJoin() { return this; }, then(resolve, reject) {
        return Promise.resolve(table === schema.entitlements ? grants : user ? (duplicate && table === schema.users ? [user, { ...user, id: 'duplicate-id' }] : [fields ? { user, credits } : user]) : []).then(resolve, reject);
      } };
    },
    insert(table) { return { values(value) { return { onConflictDoUpdate() {
      if (table === schema.users) user = value;
      else if (table === schema.creditAccounts) credits = value;
      else if (table === schema.entitlements) grants.push(value);
      return Promise.resolve();
    } }; } }; },
  };
  mock.module('../../db/client.js', { namedExports: { database: () => db } });
  const { registerAdminTester, authenticatedAccountId } = await import('../../db/repositories.js');
  const created = await registerAdminTester({ email, credits: 1234 });
  assert.equal(created.user.id, accountIdForEmail(email), 'admin and sign-in must address the same new account');
  assert.equal(created.credits.balance, 1234);
  assert.equal(created.entitlements.liveRendering, true);
  assert.equal(REGISTERED_TESTER_ACCOUNTS.size, 0);
  user = { ...user, id: 'legacy-existing-account' };
  grants = [];
  const existing = await registerAdminTester({ email });
  assert.equal(existing.user.id, 'legacy-existing-account', 'existing identities are preserved');
  assert.equal(await authenticatedAccountId(accountIdForEmail(email), email), 'legacy-existing-account', 'verified sign-in resolves the original grant owner');
  user.email = email.toUpperCase();
  assert.equal(await authenticatedAccountId(accountIdForEmail(email), email), 'legacy-existing-account');
  assert.match(conditions.at(-1), /lower\(/, 'stored email must be normalized by the query, not only its parameter');
  duplicate = true;
  await assert.rejects(authenticatedAccountId(accountIdForEmail(email), email), { statusCode: 409 });
  await assert.rejects(registerAdminTester({ email }), { statusCode: 409 });

} else if (scenario === 'signin') {
  const account = await import('../../lib/video-os-account.js');
  const oauth = await import('../../lib/google-oauth.js');
  const rows = [];
  let currentEmail = email;
  const query = { from() { return this; }, leftJoin() { return this; }, where() { return this; }, orderBy() { return rows; } };
  mock.module('../../db/client.js', { namedExports: { database: () => ({ select: () => query }) } });
  const repo = await import('../../db/repositories.js');
  const captured = [];
  mock.module('../../db/repositories.js', { namedExports: { ...repo,
    authenticatedAccountId: async id => id,
    recordSignIn: async () => {},
    updateAuthenticatedAccount: async input => {
      captured.push(input);
      rows.push({ accountId: input.accountId, email: input.email, role: input.role });
      return { user: { id: input.accountId, email: input.email }, credits: { balance: input.initialCredits }, entitlements: Object.fromEntries(input.entitlementKeys.map(key => [key, true])) };
    },
  } });
  mock.module('../../lib/video-os-account.js', { namedExports: { ...account,
    validateMagicToken: async () => ({ accountId: account.accountIdForEmail(currentEmail), email: currentEmail }),
    consumeMagicToken: async () => {},
  } });
  mock.module('../../lib/google-oauth.js', { namedExports: { ...oauth,
    exchangeGoogleCode: async () => ({ access_token: 'synthetic' }),
    fetchGoogleProfile: async () => ({ email: currentEmail, name: 'Synthetic' }),
  } });
  process.env.VIDEO_OS_SESSION_SECRET = 'synthetic-test-session-secret-32-characters';
  process.env.VIDEO_OS_PUBLIC_ORIGIN = 'https://test.example';
  const { default: handler } = await import('../../api/video-os-lite/auth.js');
  for (const method of ['auth-verify', 'google-callback']) {
    currentEmail = email;
    for (let signIn = 0; signIn < 2; signIn++) {
      const res = { setHeader() {}, end(raw) { this.body = raw; } };
      await handler({ method: 'GET', url: `/api/video-os-lite/${method}?token=synthetic&code=synthetic&state=test-state`, headers: { cookie: 'vos_oauth_state=test-state' } }, res);
      assert.equal(res.statusCode, 302, res.body);
      const provision = captured.at(-1);
      assert.equal(provision.role, 'customer');
      assert.equal(provision.initialCredits, 5000, 'domain credit policy remains separate from role');
      assert.equal(provision.entitlementKeys.includes('standardRendering'), true);
      assert.equal(provision.entitlementKeys.includes('liveRendering'), false);
      assert.equal(provision.entitlementKeys.includes('tester'), false);
      await repo.listAdminTesters();
    }
    currentEmail = 'arielsmailbox@gmail.com';
    const res = { setHeader() {}, end() {} };
    await handler({ method: 'GET', url: `/api/video-os-lite/${method}?token=synthetic&code=synthetic&state=test-state`, headers: { cookie: 'vos_oauth_state=test-state' } }, res);
    assert.equal(res.statusCode, 302);
    assert.equal(captured.at(-1).entitlementKeys.includes('liveRendering'), true);
    assert.equal(REGISTERED_TESTER_ACCOUNTS.size, 0);
  }
} else if (scenario === 'persistence') {
  const schema = await import('../../db/schema.js');
  let grants = [{ accountId, entitlementKey: 'liveRendering', enabled: true, sourceType: 'admin_tester_grant' }];
  const jobs = [];
  let reservationUpdates = 0;
  const databaseOperations = [];
  const db = {
    transaction: async fn => {
      const first = databaseOperations.length;
      try { return await fn(db); }
      finally { assert.equal(databaseOperations[first], 'account-lifecycle-guard'); }
    },
    execute: async statement => {
      const query = new PgDialect().sqlToQuery(statement);
      assert.match(query.sql, /pg_advisory_xact_lock\(hashtextextended\(/);
      assert.deepEqual(query.params, [`provider-lifecycle-v1:${Buffer.byteLength(accountId)}:${accountId}`]);
      databaseOperations.push('account-lifecycle-guard');
      return { rows: [] };
    },
    select() {
      databaseOperations.push('select');
      let table;
      const query = { from(value) { table = value; return this; }, where() { return this; }, for() { return this; }, limit() { return this; }, then(resolve, reject) {
        const values = table === schema.entitlements ? grants : table === schema.users ? [{ id: accountId, email }]
          : table === schema.creditAccounts ? [{ accountId, balance: 5000, reserved: 0 }] : table === schema.videoJobs ? jobs : [];
        return Promise.resolve(values).then(resolve, reject);
      } };
      return query;
    },
    update(table) { return { set() { if (table === schema.creditAccounts) reservationUpdates++; return { where: async () => {} }; } }; },
    insert(table) { return { values(value) { if (table === schema.videoJobs) { jobs.push(value); return { returning: async () => [value] }; } return Promise.resolve(); } }; },
  };
  mock.module('../../db/client.js', { namedExports: { database: () => db } });
  const repo = await import('../../db/repositories.js');
  const request = { jobId: 'persisted-job', accountId, idempotencyKey: 'synthetic-key', correlationId: 'synthetic-correlation', provider: 'heygen', title: 'Synthetic', format: 'vertical', costCredits: 90, input: { projectId: randomUUID(), renderAuthorization: { accountId: 'attacker', tier: 'standard' } } };
  const reserved = await repo.reserveRender(request);
  assert.equal(reserved.job.input.renderAuthorization.accountId, accountId);
  assert.equal(reserved.job.input.renderAuthorization.tier, 'premium');
  assert.equal(reserved.job.input.renderAuthorization.jobId, request.jobId);
  REGISTERED_TESTER_ACCOUNTS.clear();
  await repo.requireJobRenderAuthorization(reserved.job, 'premium');
  assert.equal((await repo.reserveRender(request)).replayed, true);
  assert.equal(reservationUpdates, 1);
  for (const changed of [{ provider: 'sadtalker' }, { title: 'Changed' }, { costCredits: 1 }, { format: 'square' }, { input: { projectId: randomUUID() } }]) {
    await assert.rejects(repo.reserveRender({ ...request, ...changed }), { statusCode: 409 }, 'changed input cannot replay a reserved job');
  }

  grants[0].enabled = false;
  await assert.rejects(() => repo.requireJobRenderAuthorization(reserved.job, 'premium'), { statusCode: 403 });
  grants = [{ ...grants[0], enabled: true, sourceType: 'validated_auth', sourceId: 'google_oauth' }];
  await assert.rejects(() => repo.requirePersistedRenderAuthorization(accountId, 'premium'), { statusCode: 403 });
  grants[0].sourceId = 'workspace_password';
  await repo.requirePersistedRenderAuthorization(accountId, 'premium');
  grants[0].expiresAt = '2000-01-01';
  await assert.rejects(() => repo.requirePersistedRenderAuthorization(accountId, 'premium'), { statusCode: 403 });
} else if (scenario === 'list') {
  const query = { from() { return this; }, leftJoin() { return this; }, where() { return this; }, orderBy() { return [{ accountId, email, role: 'tester' }]; } };
  mock.module('../../db/client.js', { namedExports: { database: () => ({ select: () => query }) } });
  const { listAdminTesters } = await import('../../db/repositories.js');
  assert.equal(containedRenderingEntitlementKeys(accountId, email).includes('liveRendering'), false);
  await listAdminTesters();
  assert.equal(REGISTERED_TESTER_ACCOUNTS.has(accountId), false, 'listing an existing tester-role domain member must never register authority');
  assert.equal(containedRenderingEntitlementKeys(accountId, email).includes('liveRendering'), false);
} else {
  let workerProviderBindings;
  if (scenario === 'worker') {
    workerProviderBindings = new WeakSet();
    mock.module('../../db/heygen-space-binding-repository.js', { namedExports: {
      resolveFreshHeygenSpaceBinding: async () => {
        const binding = Object.freeze({
          fixture: 'authorization-worker-space-binding',
          applicationAccountId: accountId,
          bindingId: 'fixture-authorization-binding',
          originScopeKey: 'a'.repeat(64),
        });
        workerProviderBindings.add(binding);
        return binding;
      },
      assertFreshHeygenSpaceBinding: binding => {
        assert.equal(workerProviderBindings.has(binding), true);
        return binding;
      },
      assertFreshHeygenProviderClaimTx: (_tx, { providerBinding }) => {
        assert.equal(workerProviderBindings.has(providerBinding), true);
        return providerBinding;
      },
      assertHeygenProviderReceiptTx: (_tx, { providerBinding }) => {
        assert.equal(workerProviderBindings.has(providerBinding), true);
        return providerBinding;
      },
      withFreshHeygenSpaceBindingTransaction: async (_input, callback) => callback({}),
      withHeygenSpaceBindingReceiptTransaction: async (_input, callback) => callback({}),
    } });
    const providerLedger = await import('../../db/provider-reconciliation-repository.js');
    mock.module('../../db/provider-reconciliation-repository.js', { namedExports: {
      ...providerLedger,
      providerCreationActivationStatus: () => Object.freeze({ enabled: true, reason: 'test_fixture_only' }),
    } });
  }
  const repo = await import('../../db/repositories.js');
  const projectId = randomUUID();
  const standardTier = scenario === 'route' || scenario === 'worker-standard';
  const authorization = { version: 1, accountId, tier: standardTier ? 'standard' : 'premium', entitlementKey: standardTier ? 'standardRendering' : 'liveRendering' };
  let job = { id: 'test-job', accountId, provider: 'heygen', projectId, status: 'workflow_started', input: { identityId: 'fixture-owned-identity', renderAuthorization: authorization, avatar: { avatarId: 'a' }, voice: { voiceId: 'v' } } };
  let submissions = 0;
  let revokedAtClaim = false;
  let releasedCategory;
  mock.module('../../db/repositories.js', { namedExports: {
    ...repo,
    requirePersistedRenderAuthorization: async (id, tier) => {
      assert.equal(id, accountId);
      if (tier !== authorization.tier) throw Object.assign(new Error('Tier denied'), { statusCode: 403 });
      return authorization;
    },
    requireJobRenderAuthorization: async (candidate, tier) => {
      assert.equal(candidate.input.renderAuthorization.accountId, candidate.accountId);
      assert.equal(candidate.input.renderAuthorization.tier, tier);
      return authorization;
    },
    consumeRateLimit: async () => true,
    ensureAccount: async () => ({ user: { id: accountId }, credits: { balance: 5000 }, entitlements: {} }),
    getOwnedProject: async () => null,
    getOwnedJob: async (id, requestedJob) => { assert.equal(id, accountId); assert.equal(requestedJob, 'other-account-job'); return null; },
    getOwnedMediaAsset: async (id, requestedAsset) => { assert.equal(id, accountId); assert.equal(requestedAsset, 'other-account-asset'); return null; },
    getJob: async () => job,
    claimWorkflowStart: async () => job,
    markJobFailedAndRelease: async (id, category) => { releasedCategory = category; },
    transitionJob: async ({ stageTo, providerJobId, providerBinding }) => {
      if (scenario === 'worker' && ['provider_submitting', 'provider_submitted', 'provider_submit_unknown'].includes(stageTo)) {
        assert.equal(workerProviderBindings.has(providerBinding), true);
      }
      if (revokedAtClaim && stageTo === 'provider_submitting') throw Object.assign(new Error('Revoked at claim'), { statusCode: 403, failureCategory: 'ENTITLEMENT' });
      job = { ...job, status: stageTo, ...(providerJobId ? { providerJobId } : {}) };
      if (scenario === 'worker' && stageTo === 'provider_submitting') {
        return Object.freeze({
          ...job,
          providerClaimProof: Object.freeze({
            version: 'heygen-render-provider-claim/v1',
            operationId: 'fixture-authorization-operation',
            operationState: 'pending',
            requestDigest: 'b'.repeat(64),
            bindingId: providerBinding.bindingId,
            originScopeKey: providerBinding.originScopeKey,
            accountId,
            jobId: job.id,
          }),
        });
      }
      return job;
    },
  } });
  mock.module('../../api/video-os/talent.js', { namedExports: {
    loadTalentInventory: async () => ({ talent: {} }),
    assertTalentSelectionsAvailable: () => ({ providerSelections: { avatarId: 'a', voiceId: 'v' } }),
  } });
  mock.module('../../services/heygen.js', { namedExports: {
    assertHeygenConfigured: () => true,
    submitHeygen: async () => { submissions++; return { providerJobId: 'synthetic-provider-job' }; },
    pollHeygen: async () => ({}),
  } });
  if (scenario.startsWith('worker')) {
    let submitProvider;
    let failWorkflow;
    if (scenario === 'worker-standard') {
      const service = await import('../../services/sadtalker-runpod.js');
      const client = await import('../../db/client.js');
      mock.module('../../db/client.js', { namedExports: { ...client, database: () => ({ transaction: async fn => fn({}) }) } });
      mock.module('../../db/standard-narration-repository.js', { namedExports: { standardNarrationRepository: { resolveSources: async () => ({ input: {}, assets: {} }) } } });
      mock.module('../../services/sadtalker-runpod.js', { namedExports: { ...service, submitRunpodStandard: async () => { submissions++; return { providerJobId: 'synthetic-provider-job' }; } } });
      ({ submitStandardProvider: submitProvider, failWorkflow } = await import('../../workflows/standard-render.js'));
      job.provider = 'sadtalker';
    } else {
      ({ submitProvider, failWorkflow } = await import('../../workflows/video-render.js'));
    }
    const result = await submitProvider(job.id);
    assert.equal(result.providerJobId, 'synthetic-provider-job');
    assert.equal(submissions, 1);
    await submitProvider(job.id);
    assert.equal(submissions, 1, 'worker replay must not submit twice');
    job = { ...job, providerJobId: null, status: 'workflow_started' }; revokedAtClaim = true;
    let denial;
    try { await submitProvider(job.id); } catch (error) { denial = error; }
    if (scenario === 'worker-standard') assert.equal(denial?.failureCategory, 'ENTITLEMENT', 'revocation before claim is not provider uncertainty');
    else assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'heygen-preclaim', failureCategory: 'ENTITLEMENT' });
    assert.equal(job.status, 'workflow_started');
    assert.equal(submissions, 1, 'revoked claim makes no additional provider call');
    await failWorkflow(job.id, scenario === 'worker-standard' ? denial : new FatalError(denial.message));
    assert.equal(releasedCategory, 'ENTITLEMENT');
    job.status = 'provider_submitting'; releasedCategory = undefined;
    await assert.rejects(submitProvider(job.id), error => error.failureCategory === 'PROVIDER_SUBMIT_UNKNOWN' || parseDurableRenderFailure(error)?.failureCategory === 'PROVIDER_SUBMIT_UNKNOWN');
    assert.equal(releasedCategory, undefined, 'already claimed submission stays held');

  } else {
    mock.module('../../db/standard-narration-repository.js', { namedExports: { standardNarrationRepository: {
      reserveRender: async ({ input }) => { job = { ...job, provider: 'sadtalker', input }; return { job, replayed: false }; },
    } } });
    const contract = await import('../../lib/standard-narration-contract.js');
    mock.module('../../lib/standard-narration-contract.js', { namedExports: { ...contract, standardNarrationActivation: () => ({ ready: true }) } });
    const { makeSession } = await import('../../lib/video-os-account.js');
    const { default: handler } = await import('../../api/video-os-lite/render-v2.js');
    process.env.VIDEO_OS_SESSION_SECRET = 'synthetic-test-session-secret-32-characters';
    process.env.VIDEO_OS_DURABLE_WORKFLOW_ENABLED = 'true';
    process.env.VIDEO_OS_PUBLIC_ORIGIN = 'https://test.example';
    process.env.WORKFLOW_DISPATCH_MODE = 'poll';
    const cookie = `vos_session=${makeSession(accountId, email)}`;
    async function call(body, signedIn = true) {
      const req = { method: 'POST', headers: { ...(signedIn ? { cookie } : {}), origin: 'https://test.example', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
      const res = { setHeader() {}, end(raw) { this.body = JSON.parse(raw); } };
      await handler(req, res);
      return res;
    }
    const standard = { tier: 'STANDARD', contractVersion: contract.STANDARD_CONTRACT_VERSION, quoteId: randomUUID(), narrationConsentId: randomUUID(), projectId, identityId: randomUUID(), idempotencyKey: randomUUID(), title: 'Synthetic', format: 'vertical', audioReference: { assetId: randomUUID() } };
    assert.equal((await call(standard, false)).statusCode, 401);
    const accepted = await call(standard);
    assert.equal(accepted.statusCode, 202, JSON.stringify(accepted.body));
    assert.equal((await call({})).statusCode, 403, 'Standard permission must not authorize Premium');
    assert.equal((await call({ ...standard, renderAuthorization: { tier: 'premium' } })).statusCode, 400, 'client cannot provide authority');
    authorization.tier = 'premium';
    const premium = { provider: 'heygen', projectId, idempotencyKey: randomUUID(), title: 'Synthetic', script: 'Synthetic text', avatar: { avatarId: 'a' }, voice: { voiceId: 'v' } };
    assert.equal((await call(premium)).statusCode, 404, 'foreign/missing project must be non-enumerating');
    const { default: download } = await import('../../api/video-os-lite/download-v2.js');
    const { default: finalize } = await import('../../api/video-os-lite/finalize-v2.js');
    const { default: asset } = await import('../../routes/video-os-lite/asset.js');
    for (const [ownedHandler, method, url] of [[download, 'GET', '/api/video-os-lite/download?jobId=other-account-job'], [finalize, 'POST', '/api/video-os-lite/finalize'], [asset, 'GET', '/api/video-os-lite/asset?assetId=other-account-asset']]) {
      for (const signedIn of [false, true]) {
        const res = { setHeader() {}, end(raw) { this.body = JSON.parse(raw); } };
        await ownedHandler({ method, url, headers: signedIn ? { cookie } : {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ jobId: 'other-account-job' })); } }, res);
        assert.equal(res.statusCode, signedIn ? 404 : 401);
      }
    }
    assert.equal(submissions, 0);
  }
}
