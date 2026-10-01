import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { and, eq } from 'drizzle-orm';
import { database, currentPoolForTests } from '../db/client.js';
import { users, entitlements, creditAccounts, creditTransactions, mediaAssets, jobEvents } from '../db/schema.js';
import { ensureAccount, reserveRender, claimWorkflowStart, transitionJob, finalizeReadyJob, getJob, markJobFailedAndRelease } from '../db/repositories.js';
import { acceptedJobOutput, finalOutputPath } from '../lib/video-os-output-acceptance.js';
import { putPrivateBlob, getPrivateBlob, deletePrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS } from '../lib/video-os-private-blob.js';
import { makeSession } from '../lib/video-os-account.js';
import download from '../api/video-os-lite/download-v2.js';

test('isolated live DB/Blob: atomic acceptance, immutable bytes, download ownership, and revoke-before-claim', {
  skip: process.env.VIDEO_OS_ISOLATED_LIVE !== '1' && 'Run only through the guarded isolated-live runner.',
  timeout: 120000,
}, async t => {
  assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/mvp_verification_\d{8}$/);
  const db = database();
  const accountId = `live-final-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'live-final-proof-'));
  const objects = [];
  t.after(async () => {
    for (const pathname of objects) {
      const stored = await getPrivateBlob(pathname);
      if (stored?.blob?.etag) await deletePrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, pathname, { ifMatch: stored.blob.etag });
    }
    await db.delete(users).where(eq(users.id, accountId));
    await rm(directory, { recursive: true, force: true });
    await currentPoolForTests()?.end();
  });
  await ensureAccount({ accountId, email: null, name: 'Isolated Live Verification', initialCredits: 500 });
  await db.insert(entitlements).values({ accountId, entitlementKey: 'liveRendering', enabled: true, sourceType: 'test_fixture' });

  async function jobAt(stage = 'finishing') {
    const jobId = randomUUID();
    await reserveRender({ jobId, accountId, idempotencyKey: randomUUID(), correlationId: randomUUID(), provider: 'heygen', title: 'Isolated Verification', format: 'landscape', costCredits: 90, input: {} });
    await claimWorkflowStart(jobId);
    if (stage === 'finishing') for (const stageTo of ['provider_submitting', 'provider_submitted', 'provider_ready', 'finishing']) {
      await transitionJob({ jobId, stageTo, eventType: 'test.progress', ...(stageTo === 'provider_submitted' ? { providerJobId: `synthetic-no-provider-call-${jobId}` } : {}) });
    }
    return jobId;
  }
  const file = join(directory, 'source.mp4');
  const encoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=5:d=1', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', file], { timeout: 30000, encoding: 'utf8', windowsHide: true });
  assert.equal(encoded.status, 0, encoded.stderr);
  const bytes = await readFile(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const jobId = await jobAt();
  const pathname = finalOutputPath(accountId, jobId, sha256); objects.push(pathname);
  const firstWrite = await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, pathname, bytes, { contentType: 'video/mp4', addRandomSuffix: false });
  const replayWrite = await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, pathname, bytes, { contentType: 'video/mp4', allowOverwrite: true });
  assert.equal(firstWrite.created, true); assert.equal(replayWrite.created, false);
  const artifact = { privatePathname: pathname, sha256, bytes: bytes.length, sourceDurationMs: 1000, filename: 'proof.mp4' };
  const completions = await Promise.all([finalizeReadyJob(jobId, artifact), finalizeReadyJob(jobId, artifact)]);
  assert.equal(completions.filter(value => value.justCompleted).length, 1);
  const completed = await getJob(jobId); assert.equal(acceptedJobOutput(completed), true);
  const ledger = await db.select().from(creditTransactions).where(eq(creditTransactions.accountId, accountId));
  assert.equal(ledger.length, 1); assert.equal(ledger[0].amount, -90);
  const finalAssets = await db.select().from(mediaAssets).where(eq(mediaAssets.jobId, jobId));
  const completionEvents = await db.select().from(jobEvents).where(and(eq(jobEvents.jobId, jobId), eq(jobEvents.eventType, 'finish.completed')));
  assert.equal(finalAssets.length, 1); assert.equal(completionEvents.length, 1);
  const downloads = [];
  for (const owner of [accountId, null, 'wrong-account']) {
    const chunks = [];
    const res = { setHeader() {}, write(chunk) { chunks.push(chunk); }, end() {} };
    await download({ method: 'GET', url: `/api/video-os-lite/download?jobId=${jobId}`, headers: owner ? { cookie: `vos_session=${makeSession(owner, 'test@example.invalid')}` } : {} }, res);
    assert.equal(res.statusCode, owner === accountId ? 200 : owner ? 404 : 401);
    const downloadedHash = owner === accountId ? createHash('sha256').update(Buffer.concat(chunks)).digest('hex') : null;
    if (owner === accountId) assert.equal(downloadedHash, sha256);
    downloads.push({ actor: owner === accountId ? 'owner' : owner ? 'wrong-account' : 'anonymous', status: res.statusCode, sha256: downloadedHash });
  }
  const privateStatus = (await fetch(firstWrite.url, { redirect: 'manual' })).status;
  assert.ok([401, 403, 404].includes(privateStatus));

  const rejectedId = await jobAt();
  const bad = Buffer.from('0000ftypbad!'); const badHash = createHash('sha256').update(bad).digest('hex');
  const badPath = finalOutputPath(accountId, rejectedId, badHash); objects.push(badPath);
  await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, badPath, bad, { contentType: 'video/mp4' });
  let rejection;
  try { await finalizeReadyJob(rejectedId, { privatePathname: badPath, sha256: badHash, bytes: bad.length, sourceDurationMs: 1000 }); } catch (error) { rejection = error; }
  assert.equal(rejection?.failureCategory, 'FINAL_MEDIA_VALIDATION');
  await markJobFailedAndRelease(rejectedId, rejection.failureCategory, rejection.message, rejection.rejectedArtifact);
  const [credits] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
  assert.equal(credits.balance, 410); assert.equal(credits.reserved, 0); assert.equal(credits.spent, 90);

  // Hold a real row lock while the claim reaches FOR SHARE, then commit revoke.
  const claimId = await jobAt('workflow_started');
  const pool = currentPoolForTests(); const revoker = await pool.connect();
  try {
    await revoker.query('begin');
    await revoker.query('update entitlements set enabled=false where account_id=$1 and entitlement_key=$2', [accountId, 'liveRendering']);
    const claim = transitionJob({ jobId: claimId, stageTo: 'provider_submitting', eventType: 'test.claim' }).then(value => ({ value }), error => ({ error }));
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const observed = await pool.query("select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%entitlements%'");
      if (observed.rows[0].n > 0) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await revoker.query('commit');
    const outcome = await claim;
    assert.equal(waiting, true, 'claim must actually block behind the revoke row lock');
    assert.equal(outcome.error?.failureCategory, 'ENTITLEMENT');
    assert.equal((await getJob(claimId)).status, 'workflow_started');
    await markJobFailedAndRelease(claimId, 'ENTITLEMENT', 'Isolated revocation proof');
    const [settled] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    assert.equal(settled.balance, 410); assert.equal(settled.reserved, 0);
    if (process.env.VIDEO_OS_LIVE_DETAIL_REPORT) await writeFile(process.env.VIDEO_OS_LIVE_DETAIL_REPORT, JSON.stringify({
      at: new Date().toISOString(), accountHash: createHash('sha256').update(accountId).digest('hex'), jobId,
      artifact: { sha256, bytes: bytes.length, media: completed.output.acceptance.media },
      accepted: acceptedJobOutput(completed), settlements: ledger.length,
      finalAssets: finalAssets.length, completionEvents: completionEvents.length,
      newlyCompletedResults: completions.filter(value => value.justCompleted).length,
      finalBalance: settled.balance, finalReserved: settled.reserved, finalSpent: settled.spent,
      blobReuseVerified: replayWrite.created === false, anonymousBlobStatus: privateStatus,
      downloads,
      corruptOutputRejected: rejection.failureCategory, revocationBlockedClaim: outcome.error.failureCategory,
      postgresLockWaitObserved: waiting, paidProviderCalls: 0,
    }, null, 2));
  } finally { await revoker.query('rollback').catch(() => {}); revoker.release(); }
});
