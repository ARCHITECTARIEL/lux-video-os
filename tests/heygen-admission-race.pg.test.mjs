import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HEYGEN_ACTIVE_STATUSES } from '../lib/heygen-provider-safety.js';

const raceUrl = process.env.VIDEO_OS_PG_RACE_TEST_URL;
const childMode = process.argv.includes('--pg-race-child');
function assertDisposableRaceTarget() {
  assert.equal(process.env.VIDEO_OS_PG_RACE_TEST_OPT_IN, 'i-understand-this-drops-the-schema', 'destructive race test requires explicit opt-in');
  const parsed = new URL(raceUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'race URL must use Postgres');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'race URL must target loopback');
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /^(?:race|throwaway|vos_race)[a-z0-9_]*$/, 'race URL must name a disposable database');
}
const expectedScenarios = {
  a: { trials: 3, limit: 8, perAccount: 2, admitted: 8 },
  b: { trials: 1, limit: 8, perAccount: 2, admitted: 8 },
  c: { trials: 1, limit: 8, perAccount: 2, admitted: 0 },
  d: { trials: 1, limit: 3, perAccount: 1, admitted: 3 },
};

function conciseDatabaseError(error) {
  let cause = error;
  while (cause?.cause) cause = cause.cause;
  const brief = value => String(value).replace(/\s+/g, ' ').slice(0, 500);
  const parts = [cause?.message && brief(cause.message), cause?.detail && `detail: ${brief(cause.detail)}`, cause?.where && `where: ${brief(cause.where)}`].filter(Boolean);
  return parts.join(' | ') || String(error);
}

async function runRaceChild() {
  assertDisposableRaceTarget();
  const parsed = new URL(raceUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'race URL must use Postgres');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'race URL must target loopback');
  const proxy = process.env.VIDEO_OS_PG_RACE_TEST_WSPROXY;
  assert.match(proxy || '', /^(?:localhost|127\.0\.0\.1):(?:[1-9]\d{0,4})$/, 'wsproxy must be a loopback host:port');
  assert.ok(Number(proxy.split(':')[1]) <= 65535, 'wsproxy port must be valid');
  for (const key of Object.keys(process.env)) {
    if (/^(?:HEYGEN_|VIDEO_OS_HEYGEN_|VIDEO_OS_PROVIDER_|RUNPOD_|VIDEO_OS_RUNPOD_)/.test(key)) delete process.env[key];
  }
  // Set the connection target before any database module is imported. The
  // child runs as a plain script, isolated from the parent's test context.
  process.env.DATABASE_URL = raceUrl;
  // node:test has already initialized from the static import above. Enable
  // repository test dependency injection only in this plain-script child,
  // before any dynamic import can evaluate a module-level test gate.
  process.env.NODE_TEST_CONTEXT = 'child-pg-race';
  const { Pool, neonConfig } = await import('@neondatabase/serverless');
  const { eq } = await import('drizzle-orm');
  const ws = (await import('ws')).default;
  const configureNeon = () => {
    neonConfig.webSocketConstructor = ws;
    neonConfig.wsProxy = () => `${proxy}/v1`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineTLS = false;
    neonConfig.pipelineConnect = false;
  };
  configureNeon();
  const { database, currentPoolForTests } = await import('../db/client.js');
  const schema = await import('../db/schema.js');
  configureNeon(); // db/client.js sets the constructor during module evaluation.
  const { createHeygenSpaceBindingRepository } = await import('../db/heygen-space-binding-repository.js');
  const { acquireProviderLifecycleLock } = await import('../db/provider-lifecycle-lock.js');
  const { transitionJob } = await import('../db/repositories.js');
  configureNeon();
  const admin = new Pool({ connectionString: raceUrl, max: 2, connectionTimeoutMillis: 15_000, query_timeout: 30_000 });
  admin.on('error', () => {});
  try {
    await admin.query('DROP SCHEMA IF EXISTS public CASCADE');
    await admin.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await admin.query('CREATE SCHEMA public');
    const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
    for (const entry of journal.entries) {
      const migration = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean)) {
        await admin.query(statement);
      }
    }

    const H = value => createHash('sha256').update(String(value)).digest('hex');
    const fixtureNow = new Date();
    const fixtureCredential = 'race-local-synthetic-credential';
    const credentialKeyFingerprint = createHash('sha256')
      .update(Buffer.from('LUX_VIDEO_OS\0HEYGEN_CREDENTIAL_KEY\0V1\0', 'utf8'))
      .update(fixtureCredential, 'utf8').digest('hex');
    const proof = Object.freeze({
      version: 'heygen-space-qualification-proof/v1', provider: 'heygen', providerNativeScopeType: 'space',
      globalAccountIdVerified: false, credentialKeyFingerprint,
      credentialScopeFingerprint: H('race-credential-scope'), keyIdDigest: H('race-key-id'),
      keyCreatedAt: fixtureNow.toISOString(), usernameDigest: H('race-username'),
      providerSpaceFingerprint: H('race-provider-space'), canonicalScopeKey: H('race-canonical-scope'),
      preflightEvidenceSha256: H('race-preflight'), spaceProofSha256: H('race-space-proof'),
      identityDigest: H('race-identity-proof'), evidenceRefVersion: 'heygen-space-anchor-evidence/v1',
      probeResultSha256: H('race-probe'), spaceObservedAt: new Date(fixtureNow.getTime() - 1_000).toISOString(),
      qualifiedAt: fixtureNow.toISOString(), expiresAt: new Date(fixtureNow.getTime() + 60_000).toISOString(),
      anchorExpiresAt: new Date(fixtureNow.getTime() + 3_600_000).toISOString(),
    });
    const fixtureEnv = { VIDEO_OS_SPACE_BINDING_ENVIRONMENT: 'verification', DATABASE_URL: raceUrl, HEYGEN_API_KEY: fixtureCredential };
    const bindings = createHeygenSpaceBindingRepository({
      env: () => fixtureEnv, now: () => fixtureNow, executor: database(),
      targetPreflight: async () => ({ environment: 'verification', projectId: 'race-local',
        databaseBindingSha256: H('race-database'), databaseUrl: raceUrl, unpooledUrl: null }),
      // The synthetic anchor projection has the same fingerprint as the in-process
      // credential. No real key or production anchor is loaded by this test.
      loadVerifiedHeygenSpaceAnchor: async () => ({ credentialKeyFingerprint }),
      loadPinnedHeygenSpaceAnchorProjection: async () => ({ credentialKeyFingerprint }),
      qualifyHeygenCredential: async () => ({}), validateFreshHeygenQualification: () => proof,
      assertFreshHeygenSpaceProof: value => { assert.equal(value, proof); return value; },
      assertFreshHeygenBootstrapProof: value => { assert.equal(value, proof); return value; },
    });
    async function seed(accountCount, jobsPerAccount, { held = 0, otherActive = 0 } = {}) {
      // Each trial starts from the same migrated schema without re-running DDL.
      await admin.query('TRUNCATE TABLE users CASCADE');
      const pending = [];
      for (let account = 0; account < accountCount; account++) {
        const id = `race-account-${account}`;
        const photoId = randomUUID();
        const voiceId = randomUUID();
        const sourceVideoId = randomUUID();
        const enrollmentId = randomUUID();
        const identityId = randomUUID();
        const avatarId = `avatar_${account}`;
        const providerVoiceId = `voice_${account}`;
        await database().insert(schema.users).values({ id, email: `${id}@example.invalid` });
        await database().insert(schema.entitlements).values({ accountId: id, entitlementKey: 'liveRendering', enabled: true, sourceType: 'admin_tester_grant' });
        const heldForAccount = account === 0 ? held : account <= otherActive ? 1 : 0;
        await database().insert(schema.creditAccounts).values({ accountId: id, balance: 100,
          reserved: jobsPerAccount + heldForAccount });
        const bootstrapped = await bindings.bootstrapVerifiedHeygenSpaceBinding({ accountId: id,
          privateEvidenceDir: process.platform === 'win32' ? 'C:\\race-local-fixture' : '/race-local-fixture' });
        // Use the same fresh binding object that the production resolver returns.
        const providerBinding = await bindings.resolveFreshHeygenSpaceBinding({ accountId: id });
        assert.deepEqual(providerBinding, bootstrapped, `${id}: binding and verified receipt agree`);
        await database().insert(schema.mediaAssets).values([
          { id: photoId, accountId: id, kind: 'identity-photo-source', privatePathname: `video-os/uploads/${id}/photo`, contentType: 'image/png', bytes: 1, sha256: H('photo') },
          { id: voiceId, accountId: id, kind: 'identity-voice-source', privatePathname: `video-os/enrollment-sources/${id}/voice`, contentType: 'audio/wav', bytes: 1, sha256: H('voice') },
          { id: sourceVideoId, accountId: id, kind: 'identity-phone-video-source', privatePathname: `video-os/enrollment-sources/${id}/source`, contentType: 'video/mp4', bytes: 1, sha256: H('source') },
        ]);
        await database().insert(schema.userIdentities).values({ id: identityId, accountId: id, displayName: 'Race fixture', overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', sourcePhotoAssetId: photoId, sourceVoiceAssetId: voiceId, providerAvatarGroupId: `group_${account}`, providerRenderableAvatarId: avatarId, providerVoiceId });
        const { ENROLLMENT_CONSENT_POLICY_VERSION, ENROLLMENT_CONTRACT_VERSION } = await import('../lib/enrollment-policy.js');
        const consentAuthorizations = { audioExtractionAuthorization: true, faceAuthorization: true, voiceAuthorization: true,
          providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true, temporaryPublicProviderExposureAuthorization: true };
        await database().insert(schema.identityConsents).values({ accountId: id, identityId, ...consentAuthorizations,
          policyVersion: ENROLLMENT_CONSENT_POLICY_VERSION, consentPurpose: 'identity-voice-enrollment',
          photoSha256: H('photo'), sourceVideoSha256: H('source'), voiceSha256: H('voice') });
        await database().insert(schema.identityVideoEnrollments).values({ id: enrollmentId, accountId: id,
          idempotencyKey: randomUUID(), correlationId: `enrollment-${id}`, contractVersion: ENROLLMENT_CONTRACT_VERSION,
          status: 'IDENTITY_READY', displayName: 'Race fixture', photoAssetId: photoId, photoSha256: H('photo'),
          declaredFilename: 'source.mp4', declaredContentType: 'video/mp4', declaredBytes: 1,
          uploadPathname: `video-os/enrollment-sources/${id}/source`, uploadOperationKey: randomUUID(),
          uploadExpiresAt: new Date(fixtureNow.getTime() + 60_000), expiresAt: new Date(fixtureNow.getTime() + 3_600_000),
          sourceSha256: H('source'), sourceBytes: 1, sourceVideoAssetId: sourceVideoId,
          derivedVoiceAssetId: voiceId, derivedAudioSha256: H('voice'), derivedAudioBytes: 1,
          derivedAudioDurationMs: 1_000, derivationVersion: 'fixture-v1', identityId,
          consentPolicyVersion: ENROLLMENT_CONSENT_POLICY_VERSION, consentPurpose: 'identity-voice-enrollment',
          consentedSourceSha256: H('source'), consentAuthorizations, consentedAt: fixtureNow, completedAt: fixtureNow });
        const resources = [
          { id: randomUUID(), kind: 'avatar_look', providerResourceId: avatarId, operationKind: 'avatar_create', originOperationId: randomUUID() },
          { id: randomUUID(), kind: 'voice', providerResourceId: providerVoiceId, voiceNamespace: 'instant', operationKind: 'voice_clone', originOperationId: randomUUID() },
        ];
        const avatarGroupId = randomUUID();
        await database().transaction(async tx => {
          await acquireProviderLifecycleLock(tx, id);
          await tx.insert(schema.providerLifecycleOperations).values(resources.map(resource => ({
            id: resource.originOperationId, applicationAccountId: id, bindingId: providerBinding.bindingId,
            originScopeKey: providerBinding.originScopeKey, kind: resource.operationKind, state: 'reserved',
            originOperationKey: `${resource.operationKind}-${id}`, correlationId: `${resource.operationKind}-${id}`,
            enrollmentId, identityId, requestDigest: H(`${resource.operationKind}-${id}`),
            createdAt: fixtureNow, updatedAt: fixtureNow })));
          for (const resource of resources) {
            await tx.update(schema.providerLifecycleOperations).set({ state: 'pending', submittedAt: fixtureNow })
              .where(eq(schema.providerLifecycleOperations.id, resource.originOperationId));
            await tx.update(schema.providerLifecycleOperations).set({ state: 'succeeded', completedAt: fixtureNow })
              .where(eq(schema.providerLifecycleOperations.id, resource.originOperationId));
          }
          await tx.insert(schema.providerResources).values({
            id: avatarGroupId, applicationAccountId: id, bindingId: providerBinding.bindingId,
            originScopeKey: providerBinding.originScopeKey, verifiedAccountScopeId: providerBinding.verifiedAccountScopeId,
            kind: 'avatar_group', providerResourceId: `group_${account}`,
            originOperationId: resources[0].originOperationId, state: 'ready',
        });
        await tx.insert(schema.providerResources).values(resources.map(({ operationKind: _operationKind, ...resource }) => ({ ...resource,
          applicationAccountId: id, bindingId: providerBinding.bindingId, originScopeKey: providerBinding.originScopeKey,
          verifiedAccountScopeId: providerBinding.verifiedAccountScopeId,
          parentResourceId: resource.kind === 'avatar_look' ? avatarGroupId : null, state: 'ready' })));
        await tx.insert(schema.providerConsumerReferences).values(resources.map(resource => ({
          applicationAccountId: id, originScopeKey: providerBinding.originScopeKey, resourceId: resource.id,
          consumerKind: 'identity', consumerId: identityId, originOperationId: resource.originOperationId, state: 'active' })));
        for (let index = 0; index < jobsPerAccount; index++) {
          const jobId = `race-${account}-${index}`;
          await tx.insert(schema.videoJobs).values({ id: jobId, accountId: id, idempotencyKey: jobId, correlationId: jobId,
            provider: 'heygen', status: 'workflow_started', title: 'Race fixture', format: 'vertical', costCredits: 1,
            input: { identityId, avatar: { avatarId }, voice: { voiceId: providerVoiceId }, script: 'Race fixture',
              renderAuthorization: { version: 1, accountId: id, tier: 'premium', entitlementKey: 'liveRendering', jobId } } });
          await tx.insert(schema.providerConsumerReferences).values(resources.map(resource => ({
            applicationAccountId: id, originScopeKey: providerBinding.originScopeKey, resourceId: resource.id,
            consumerKind: 'job', consumerId: jobId, originOperationId: resource.originOperationId, state: 'active' })));
          pending.push({ jobId, providerBinding });
        }
        });
      }
      // Held unknown submissions reserve capacity even without a provider id.
      for (let index = 0; index < held + otherActive; index++) {
        const account = index < held ? 0 : index - held + 1;
        const accountId = `race-account-${account}`;
        const jobId = `preseed-${index}`;
        await database().insert(schema.videoJobs).values({ id: jobId, accountId, idempotencyKey: jobId, correlationId: jobId,
          provider: 'heygen', status: index < held ? 'provider_submit_unknown' : 'provider_submitted',
          title: 'Preseed active', format: 'vertical', costCredits: 1 });
      }
      return pending;
    }

    const scenarios = new Map();
    async function race(name, label, accountCount, jobsPerAccount, expected, limits = {}, preseed = {}) {
      const originalGlobal = process.env.VIDEO_OS_HEYGEN_MAX_CONCURRENCY;
      const originalAccount = process.env.VIDEO_OS_HEYGEN_MAX_PER_ACCOUNT;
      if (limits.global) process.env.VIDEO_OS_HEYGEN_MAX_CONCURRENCY = String(limits.global);
      else delete process.env.VIDEO_OS_HEYGEN_MAX_CONCURRENCY;
      if (limits.perAccount) process.env.VIDEO_OS_HEYGEN_MAX_PER_ACCOUNT = String(limits.perAccount);
      else delete process.env.VIDEO_OS_HEYGEN_MAX_PER_ACCOUNT;
      try {
        const pending = await seed(accountCount, jobsPerAccount, preseed);
        const outcomes = await Promise.allSettled(pending.map(({ jobId, providerBinding }) =>
          transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding })));
        const errors = [...new Set(outcomes.filter(outcome => outcome.status === 'rejected')
          .map(outcome => conciseDatabaseError(outcome.reason)))];
        if (errors.length) throw new Error(`${label}: unexpected transition errors: ${errors.slice(0, 5).join(' | ')}`);
        const admittedResults = outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value.status === 'provider_submitting');
        const deferredResults = outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value.admissionDeferred === true);
        assert.equal(admittedResults.length, expected, `${label}: returned admissions`);
        assert.ok(admittedResults.every(outcome => outcome.value.providerClaimProof?.bindingId
          && outcome.value.providerClaimProof?.originScopeKey), `${label}: admitted jobs have lifecycle claim proof`);
        assert.equal(deferredResults.length, pending.length - expected, `${label}: returned capacity deferrals`);
        assert.ok(deferredResults.every(outcome => outcome.value.status === 'workflow_started'), `${label}: deferred status`);
        const rows = (await admin.query("SELECT account_id, status, count(*)::int AS count FROM video_jobs WHERE id LIKE 'race-%' GROUP BY account_id, status")).rows;
        const admitted = rows.filter(row => row.status === 'provider_submitting');
        const deferred = rows.filter(row => row.status === 'workflow_started');
        assert.equal(admitted.reduce((sum, row) => sum + row.count, 0), expected, `${label}: admitted count`);
        assert.equal(deferred.reduce((sum, row) => sum + row.count, 0), pending.length - expected, `${label}: refused jobs remain workflow_started`);
        assert.ok(admitted.every(row => row.count <= (limits.perAccount ?? 2)), `${label}: per-account cap`);
        const active = (await admin.query("SELECT account_id, count(*)::int AS count FROM video_jobs WHERE provider = 'heygen' AND status = ANY($1::text[]) GROUP BY account_id", [HEYGEN_ACTIVE_STATUSES])).rows;
        const activeCount = active.reduce((sum, row) => sum + row.count, 0);
        const maxPerAccount = Math.max(0, ...active.map(row => row.count));
        assert.ok(activeCount <= (limits.global ?? 8), `${label}: global cap`);
        assert.ok(maxPerAccount <= (limits.perAccount ?? 2), `${label}: active account cap`);
        assert.ok((await admin.query("SELECT count(*)::int AS count FROM video_jobs WHERE id LIKE 'race-%' AND status = 'failed'")).rows[0].count === 0);
        if (preseed.held) assert.equal(active.find(row => row.account_id === 'race-account-0')?.count, preseed.held, `${label}: unknown account held`);
        console.log(`${label}: ${admittedResults.length} admitted, ${deferredResults.length} capacity deferred, 0 unexpected errors`);
        const scenario = scenarios.get(name) ?? { name, trials: 0, maxActive: 0, maxPerAccount: 0, admitted: 0, unexpectedErrors: 0 };
        scenario.trials++;
        scenario.maxActive = Math.max(scenario.maxActive, activeCount);
        scenario.maxPerAccount = Math.max(scenario.maxPerAccount, maxPerAccount);
        scenario.admitted += admittedResults.length;
        scenario.unexpectedErrors += errors.length;
        scenarios.set(name, scenario);
      } finally {
        if (originalGlobal === undefined) delete process.env.VIDEO_OS_HEYGEN_MAX_CONCURRENCY;
        else process.env.VIDEO_OS_HEYGEN_MAX_CONCURRENCY = originalGlobal;
        if (originalAccount === undefined) delete process.env.VIDEO_OS_HEYGEN_MAX_PER_ACCOUNT;
        else process.env.VIDEO_OS_HEYGEN_MAX_PER_ACCOUNT = originalAccount;
      }
    }

    for (let trial = 1; trial <= 3; trial++) await race('a', `20 jobs / 5 accounts trial ${trial}`, 5, 4, 8);
    await race('b', '40 jobs / 20 accounts', 20, 2, 8);
    await race('c', 'unknown account consumes two slots and six other slots are held', 7, 2, 0, {}, { held: 2, otherActive: 6 });
    await race('d', 'configured 3 global / 1 account', 5, 4, 3, { global: 3, perAccount: 1 });
    console.log(`PG_RACE_RESULT ${JSON.stringify({ scenarios: [...scenarios.values()], ok: true })}`);
  } catch (error) {
    throw new Error(conciseDatabaseError(error));
  } finally {
    await admin.end();
    await currentPoolForTests()?.end();
  }
}

if (childMode) {
  try {
    await runRaceChild();
  } catch (error) {
    console.error(`PG_RACE_FAILURE ${conciseDatabaseError(error)}`);
    process.exitCode = 1;
  }
} else {
  test('HeyGen admission is atomic on isolated local Postgres', { skip: !raceUrl, timeout: 300_000 }, () => {
    assertDisposableRaceTarget();
    const parsed = new URL(raceUrl);
    assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'race URL must use Postgres');
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'race URL must target loopback');
    const proxy = process.env.VIDEO_OS_PG_RACE_TEST_WSPROXY;
    assert.match(proxy || '', /^(?:localhost|127\.0\.0\.1):(?:[1-9]\d{0,4})$/, 'wsproxy must be a loopback host:port');
    assert.ok(Number(proxy.split(':')[1]) <= 65535, 'wsproxy port must be valid');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const child = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', fileURLToPath(import.meta.url), '--pg-race-child',
    ], { encoding: 'utf8', timeout: 270_000, windowsHide: true, env });
    const diagnostic = [...new Set(`${child.stdout || ''}\n${child.stderr || ''}`
      .replaceAll(raceUrl, '[local-race-url]').split(/\r?\n/).map(line => line.trim()).filter(Boolean))].join('\n');
    assert.equal(child.status, 0, `race child failed (${child.error?.message ?? child.signal ?? child.status}):\n${diagnostic}`);
    const resultLines = (child.stdout || '').split(/\r?\n/).filter(line => line.startsWith('PG_RACE_RESULT '));
    assert.equal(resultLines.length, 1, `expected one PG_RACE_RESULT line:\n${diagnostic}`);
    let result;
    try {
      result = JSON.parse(resultLines[0].slice('PG_RACE_RESULT '.length));
    } catch (error) {
      assert.fail(`invalid PG_RACE_RESULT JSON: ${error.message}\n${diagnostic}`);
    }
    assert.equal(result.ok, true, `race child reported failure:\n${diagnostic}`);
    assert.ok(Array.isArray(result.scenarios), 'race child must report scenarios');
    assert.deepEqual(result.scenarios.map(scenario => scenario.name).sort(), Object.keys(expectedScenarios));
    for (const scenario of result.scenarios) {
      const expected = expectedScenarios[scenario.name];
      assert.equal(scenario.trials, expected.trials, `${scenario.name}: trials`);
      assert.ok(Number.isInteger(scenario.maxActive) && scenario.maxActive >= 0 && scenario.maxActive <= expected.limit, `${scenario.name}: global cap`);
      assert.ok(Number.isInteger(scenario.maxPerAccount) && scenario.maxPerAccount >= 0 && scenario.maxPerAccount <= expected.perAccount, `${scenario.name}: account cap`);
      assert.equal(scenario.unexpectedErrors, 0, `${scenario.name}: unexpected errors`);
      assert.equal(scenario.admitted, expected.admitted * expected.trials, `${scenario.name}: admissions`);
    }
    process.stdout.write(`${diagnostic}\n`);
  });
}
