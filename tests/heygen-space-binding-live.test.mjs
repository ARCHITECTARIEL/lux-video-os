import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { and, eq } from 'drizzle-orm';
import { database, currentPoolForTests, resetDatabaseForTests } from '../db/client.js';
import { acquireProviderLifecycleLock } from '../db/provider-lifecycle-lock.js';
import { providerCreationActivationStatus, reserveProviderOperationTx, recordProviderOperationFailureTx } from '../db/provider-reconciliation-repository.js';
import { createHeygenSpaceBindingRepository, withFreshHeygenSpaceBindingTransaction, withHeygenSpaceBindingReceiptTransaction, assertHeygenProviderReceiptTx } from '../db/heygen-space-binding-repository.js';
import { providerAccountBindings, providerAccountBindingPromotions, providerVerifiedAccountScopes, users } from '../db/schema.js';
import { qualifyHeygenCredential } from '../services/heygen-account-qualification.js';
import { validateTarget } from '../tools/check-migrations.mjs';

const enabled = process.env.VIDEO_OS_ISOLATED_LIVE === '1' && process.env.VIDEO_OS_SPACE_BINDING_ISOLATED_LIVE === '1';

test('isolated live: pinned HeyGen space bootstrap is atomic, idempotent, fresh, and revocable', {
  skip: !enabled && 'Requires the guarded isolated runner and explicit space-binding gate.',
  timeout: 120000,
}, async () => {
  const target = JSON.parse(await readFile(new URL('../config/database-target.verification.json', import.meta.url), 'utf8'));
  const checked = validateTarget(process.env.DATABASE_URL, target, 'verification');
  assert.equal(checked.endpoint, 'ep-lingering-fire-aitvfm3y-pooler.c-4.us-east-1.aws.neon.tech');
  assert.equal(checked.database, 'mvp_verification_20260930');
  assert.equal(target.branchId, 'br-wandering-violet-ai1egt3g');
  const evidenceDir = process.env.VIDEO_OS_SPACE_PRIVATE_EVIDENCE_DIR;
  const credentialFile = process.env.VIDEO_OS_SPACE_CREDENTIAL_ENV;
  assert.ok(evidenceDir && credentialFile, 'Protected evidence and credential paths must be explicit.');
  const credentialEnv = parseEnv(await readFile(credentialFile, 'utf8'));
  const key = String(credentialEnv.HEYGEN_API_KEY || '').trim();
  assert.ok(key.length > 20 && key.endsWith('C2b1'), 'The owner-selected credential must be supplied privately.');
  process.env.HEYGEN_API_KEY = key;
  delete process.env.HEYGEN_TOKEN;
  process.env.VIDEO_OS_SPACE_BINDING_ENVIRONMENT = 'verification';
  const db = database();
  const pool = currentPoolForTests();
  const accountId = `space-binding-fixture-${randomUUID()}`;
  const gets = [];
  let unrelatedPool;
  let clockOffset = 0;
  const repo = createHeygenSpaceBindingRepository({
    now: () => new Date(Date.now() + clockOffset),
    qualifyHeygenCredential: options => qualifyHeygenCredential({
      ...options,
      fetchImpl: async (url, request) => {
        assert.equal(request.method, 'GET');
        assert.ok(['https://api.heygen.com/v3/api_keys/self', 'https://api.heygen.com/v3/users/me'].includes(String(url)));
        gets.push({ method: 'GET', path: new URL(url).pathname });
        return fetch(url, request);
      },
    }),
  });
  try {
    await db.insert(users).values({ id: accountId, name: 'Isolated space binding fixture', email: null });
    const first = await repo.bootstrapVerifiedHeygenSpaceBinding({ accountId, privateEvidenceDir: evidenceDir });
    const replay = await repo.bootstrapVerifiedHeygenSpaceBinding({ accountId, privateEvidenceDir: evidenceDir });
    assert.equal(first.bindingId, replay.bindingId);
    assert.equal(first.verifiedAccountScopeId, replay.verifiedAccountScopeId);
    assert.equal(first.promotionId, replay.promotionId);
    assert.equal((await db.select().from(providerAccountBindings).where(eq(providerAccountBindings.applicationAccountId, accountId))).length, 1);
    assert.equal((await db.select().from(providerAccountBindingPromotions).where(eq(providerAccountBindingPromotions.bindingId, first.bindingId))).length, 1);
    assert.equal((await db.select().from(providerVerifiedAccountScopes).where(eq(providerVerifiedAccountScopes.id, first.verifiedAccountScopeId))).length, 1);

    const fresh = await repo.resolveFreshHeygenSpaceBinding({ accountId });
    const safe = repo.safeHeygenSpaceBindingStatus(fresh);
    assert.equal(safe.scopeType, 'space');
    assert.equal(safe.environment, 'verification');
    assert.equal(safe.runtimeActivation, false);
    assert.equal(safe.providerSpaceFingerprint, '1c1b9eac97b6e38e481d30ddf12e4332ecb04d08f727a4ff55997a733b3f584a');
    assert.equal(JSON.stringify(safe).includes(accountId), false);
    assert.throws(() => repo.assertFreshHeygenSpaceBinding({ ...fresh }), { code: 'HEYGEN_SPACE_BINDING_UNVERIFIED' });
    clockOffset = Date.parse(fresh.expiresAt) - Date.now() + 1;
    assert.throws(() => repo.assertFreshHeygenSpaceBinding(fresh), { code: 'HEYGEN_SPACE_PROOF_STALE' });
    clockOffset = 0;

    // A cached application client must not redirect the binding-owned claim.
    // Constructing this disconnected pool performs no SQL or network request.
    const canonicalUrl = process.env.DATABASE_URL;
    resetDatabaseForTests();
    process.env.DATABASE_URL = 'postgresql://fixture:fixture@unrelated.invalid/unrelated?sslmode=require';
    database();
    unrelatedPool = currentPoolForTests();
    process.env.DATABASE_URL = canonicalUrl;
    const claimInput = {
      accountId, providerBinding: fresh, kind: 'asset_upload',
      originOperationKey: `runtime-claim-${randomUUID()}`,
      correlationId: `runtime-proof-${randomUUID()}`,
      requestDigest: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), sourceBytes: 95,
    };
    const claim = await withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding: fresh },
      tx => reserveProviderOperationTx(tx, claimInput));
    assert.equal(claim.operation.bindingId, fresh.bindingId);
    assert.equal(claim.operation.state, 'pending');
    assert.equal(currentPoolForTests(), unrelatedPool, 'The claim uses its own pinned connection.');
    await assert.rejects(withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding: { ...fresh } },
      tx => reserveProviderOperationTx(tx, claimInput)), { code: 'HEYGEN_SPACE_BINDING_UNVERIFIED' });
    await assert.rejects(withFreshHeygenSpaceBindingTransaction({ accountId: 'different-account', providerBinding: fresh },
      tx => reserveProviderOperationTx(tx, claimInput)));
    clockOffset = Date.parse(fresh.expiresAt) - Date.now() + 1;
    process.env.DATABASE_URL = 'postgresql://fixture:fixture@unrelated.invalid/unrelated?sslmode=require';
    process.env.HEYGEN_API_KEY = 'synthetic-rotated-key';
    try {
      await assert.rejects(withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding: fresh },
        tx => reserveProviderOperationTx(tx, claimInput)));
      const receipt = await withHeygenSpaceBindingReceiptTransaction({ accountId, providerBinding: fresh }, async tx => {
        const authority = assertHeygenProviderReceiptTx(tx, { accountId, providerBinding: fresh });
        assert.equal(authority.bindingId, claim.operation.bindingId);
        return recordProviderOperationFailureTx(tx, { accountId, operationId: claim.operation.id, ambiguous: true, code: 'ISOLATED_RECEIPT_TEST' });
      });
      assert.equal(receipt.id, claim.operation.id);
      assert.equal(receipt.state, 'ambiguous');
    } finally {
      clockOffset = 0;
      process.env.DATABASE_URL = canonicalUrl;
      process.env.HEYGEN_API_KEY = key;
    }
    await unrelatedPool.end();
    unrelatedPool = undefined;
    resetDatabaseForTests();

    const readsBeforeNegative = gets.length;
    process.env.VIDEO_OS_SPACE_BINDING_ENVIRONMENT = 'production';
    await assert.rejects(repo.resolveFreshHeygenSpaceBinding({ accountId }), { code: 'CANONICAL_TARGET_UNVERIFIED' });
    process.env.VIDEO_OS_SPACE_BINDING_ENVIRONMENT = 'verification';
    process.env.HEYGEN_API_KEY = 'synthetic-rotated-credential-C2b1';
    await assert.rejects(repo.resolveFreshHeygenSpaceBinding({ accountId }), { code: 'HEYGEN_CREDENTIAL_ANCHOR_MISMATCH' });
    process.env.HEYGEN_API_KEY = key;
    assert.equal(gets.length, readsBeforeNegative, 'Production and rotated credentials cannot reach HeyGen.');

    await db.transaction(async tx => {
      await acquireProviderLifecycleLock(tx, accountId);
      await tx.update(providerAccountBindingPromotions).set({ state: 'revoked', revokedAt: new Date() })
        .where(and(eq(providerAccountBindingPromotions.id, first.promotionId), eq(providerAccountBindingPromotions.applicationAccountId, accountId)));
    });
    // Fresh authentication obtained before revocation cannot authorize a later claim.
    await assert.rejects(withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding: fresh },
      tx => reserveProviderOperationTx(tx, { ...claimInput, originOperationKey: `revoked-${randomUUID()}` })));
    await assert.rejects(repo.resolveFreshHeygenSpaceBinding({ accountId }), { code: 'HEYGEN_SPACE_PROMOTION_CONFLICT' });
    await assert.rejects(repo.bootstrapVerifiedHeygenSpaceBinding({ accountId, privateEvidenceDir: evidenceDir }), { code: 'HEYGEN_SPACE_PROMOTION_CONFLICT' });
    const promotions = await db.select().from(providerAccountBindingPromotions).where(eq(providerAccountBindingPromotions.bindingId, first.bindingId));
    assert.equal(promotions.length, 1);
    assert.equal(promotions[0].state, 'revoked', 'Bootstrap cannot silently restore revoked authority.');
    assert.equal(providerCreationActivationStatus().enabled, false);
    if (process.env.VIDEO_OS_LIVE_DETAIL_REPORT) await writeFile(process.env.VIDEO_OS_LIVE_DETAIL_REPORT, JSON.stringify({
      passed: true, scopeType: 'space', environment: 'verification',
      bindingRows: 1, providerSpaceRows: 1, promotionRows: 1,
      idempotent: true, staleAndCopiedBindingsRejected: true,
      productionAndRotationRejectedBeforeHeygen: true, revokedAuthorityNotRestored: true,
      runtimeClaimPinnedToVerifiedDatabase: true, unrelatedCachedPoolIgnored: true,
      copiedAndCrossAccountClaimsRejected: true, revokedAfterResolveClaimRejected: true,
      expiredBindingCannotClaimButCanRecordOriginalReceipt: true,
      receiptUsesOriginalDatabaseDespiteEnvironmentDrift: true,
      providerGetRequests: gets.length, providerMutationRequests: 0, runtimeActivation: false,
      fixturesRetainedForGuardedCleanup: true,
    }, null, 2));
  } finally {
    delete process.env.HEYGEN_API_KEY;
    // Immutable audit FKs intentionally survive this test; root's pinned
    // whole-schema cleanup removes the disposable fixture after verification.
    await pool?.end();
    await unrelatedPool?.end();
    resetDatabaseForTests();
  }
});
