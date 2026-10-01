import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import * as schema from '../../db/schema.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { finalOutputPath, acceptedJobOutput } from '../../lib/video-os-output-acceptance.js';
import { putPrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS } from '../../lib/video-os-private-blob.js';

// Real FFmpeg and real filesystem store. SQL is the sole synthetic boundary.
const directory = await mkdtemp(join(tmpdir(), 'finalization-acceptance-'));
process.env.STORAGE_DRIVER = 'fs'; process.env.STORAGE_FS_ROOT = join(directory, 'store');
let state;
function reset() {
  state = { job: { id: 'job-final', accountId: 'account-final', provider: 'heygen', format: 'landscape', status: 'finishing', costCredits: 90, input: {}, correlationId: 'test-correlation' },
    account: { accountId: 'account-final', balance: 500, reserved: 90, spent: 0 }, transactions: [], media: [], events: [] };
}
reset();
let queue = Promise.resolve();
const db = {
  async execute(statement) {
    const query = new PgDialect().sqlToQuery(statement);
    assert.match(query.sql, /pg_advisory_xact_lock\(hashtextextended\(/);
    assert.deepEqual(query.params, ['provider-lifecycle-v1:13:account-final']);
    return { rows: [] };
  },
  transaction(fn) {
    const run = queue.then(async () => { const previous = structuredClone(state); try { return await fn(db); } catch (error) { state = previous; throw error; } });
    queue = run.catch(() => {}); return run;
  },
  select() {
    let table; let params = [];
    return { from(value) { table = value; return this; }, where(condition) { params = new PgDialect().sqlToQuery(condition).params; return this; }, for() { return this; }, limit() { return this; }, then(resolve, reject) {
      return Promise.resolve(table === schema.videoJobs ? [state.job] : table === schema.creditAccounts ? [state.account] : table === schema.creditTransactions ? state.transactions : table === schema.mediaAssets ? (params.includes('audio-source') ? [state.sourceAudio].filter(Boolean) : state.media) : []).then(resolve, reject);
    } };
  },
  update(table) { return { set(value) { return { where() {
    const next = table === schema.videoJobs ? (state.job = { ...state.job, ...value }) : (state.account = { ...state.account, ...value });
    return { returning: async () => [next], then(resolve) { return Promise.resolve().then(resolve); } };
  } }; } }; },
  insert(table) { return { values(value) {
    const target = table === schema.creditTransactions ? state.transactions : table === schema.mediaAssets ? state.media : state.events;
    const insert = () => { if (table !== schema.mediaAssets || !target.length) target.push(value); };
    return { onConflictDoNothing: async () => insert(), onConflictDoUpdate: async () => insert(), returning: async () => { insert(); return [value]; }, then(resolve) { insert(); return Promise.resolve().then(resolve); } };
  } }; },
};
mock.module('../../db/client.js', { namedExports: { database: () => db } });
const providerBinding = Object.freeze({ applicationAccountId: state.job.accountId, fixture: 'finalization-provider-binding' });
const { acquireProviderLifecycleLock } = await import('../../db/provider-lifecycle-lock.js');
let activeBindingTx = null;
mock.module('../../db/heygen-space-binding-repository.js', { namedExports: {
  resolveFreshHeygenSpaceBinding: async () => providerBinding,
  assertFreshHeygenSpaceBinding: binding => { assert.equal(binding, providerBinding); return binding; },
  withFreshHeygenSpaceBindingTransaction: async (input, callback) => db.transaction(async tx => {
    assert.equal(input.providerBinding, providerBinding); await acquireProviderLifecycleLock(tx, input.accountId);
    activeBindingTx = tx; try { return await callback(tx); } finally { activeBindingTx = null; }
  }),
  withHeygenSpaceBindingReceiptTransaction: async (input, callback) => db.transaction(async tx => {
    assert.equal(input.providerBinding, providerBinding); await acquireProviderLifecycleLock(tx, input.accountId);
    activeBindingTx = tx; try { return await callback(tx); } finally { activeBindingTx = null; }
  }),
  assertFreshHeygenProviderClaimTx: tx => { assert.equal(tx, activeBindingTx); return providerBinding; },
  assertHeygenProviderReceiptTx: tx => { assert.equal(tx, activeBindingTx); return providerBinding; },
} });
const providerLedger = await import('../../db/provider-reconciliation-repository.js');
mock.module('../../db/provider-reconciliation-repository.js', { namedExports: {
  ...providerLedger,
  markProviderVideoReadyTx: async () => ({ state: 'ready' }),
  releaseProviderVideoConsumerTx: async () => ({ state: 'released' }),
} });
const { finalizeReadyJob, finalizeRenderCredit, transitionJob } = await import('../../db/repositories.js');
const { failWorkflow } = await import('../../workflows/video-render.js');

async function artifact(bytes) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const pathname = finalOutputPath(state.job.accountId, state.job.id, sha256);
  const stored = await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, pathname, bytes, { addRandomSuffix: false, allowOverwrite: true });
  return { privatePathname: pathname, bytes: bytes.length, sha256, filename: 'final.mp4', sourceDurationMs: 1000, storageCreated: stored.created, storageEtag: stored.etag };
}
const finalizeHeygen = artifactValue => finalizeReadyJob(state.job.id, artifactValue, { providerBinding });
try {
  await assert.rejects(finalizeRenderCredit(state.job.id), { statusCode: 409 });
  await assert.rejects(transitionJob({ jobId: state.job.id, stageTo: 'ready' }), { statusCode: 409 });
  assert.equal((await transitionJob({ jobId: state.job.id, stageTo: 'finishing', eventType: 'finish.started', providerBinding })).status, 'finishing');
  assert.equal(state.events.length, 0, 'concurrent finishing claim is an idempotent no-op');
  for (const stageTo of ['provider_rendering', 'provider_ready']) {
    assert.equal((await transitionJob({ jobId: state.job.id, stageTo, providerBinding, ...(stageTo === 'provider_ready' ? { providerSourceUrlDigest: 'a'.repeat(64) } : {}) })).status, 'finishing');
  }
  assert.equal(state.events.length, 0, 'stale polls cannot regress a finishing job');
  state.job.status = 'finish_contained';
  assert.equal((await transitionJob({ jobId: state.job.id, stageTo: 'finish_contained', providerBinding })).status, 'finish_contained');
  assert.equal(state.events.length, 0, 'duplicate containment must not fail/release a job');
  state.job.status = 'finishing';
  const invalid = await artifact(Buffer.from('0000ftypbad!'));
  invalid.acceptance = { status: 'accepted' }; // must never trust supplied proof
  await assert.rejects(finalizeReadyJob(state.job.id, invalid), { failureCategory: 'MISSING_PROVIDER_ACCOUNT_BINDING' });
  let validationError;
  try { await finalizeHeygen(invalid); } catch (error) { validationError = error; }
  assert.equal(validationError?.failureCategory, 'FINAL_MEDIA_VALIDATION');
  assert.equal(state.account.balance, 500); assert.equal(state.transactions.length, 0); assert.equal(state.job.status, 'finishing');
  await failWorkflow(state.job.id, validationError);
  assert.equal(state.account.reserved, 0); assert.equal(state.job.status, 'failed');
  await assert.rejects(finalizeHeygen(invalid), { statusCode: 409 });

  reset();
  const file = join(directory, 'valid.mp4');
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=5:d=1', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', file], { timeout: 30000, encoding: 'utf8', windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  const good = await artifact(await readFile(file));
  const completed = await Promise.all([finalizeHeygen(good), finalizeHeygen(good)]);
  assert.equal(completed.filter(job => job.justCompleted).length, 1);
  assert.equal(acceptedJobOutput(state.job), true);
  assert.equal(state.account.balance, 410); assert.equal(state.account.reserved, 0); assert.equal(state.account.spent, 90);
  assert.equal(state.transactions.length, 1); assert.equal(state.media.length, 1);
  assert.equal(state.events.filter(event => event.eventType === 'finish.completed').length, 1);
  assert.equal(state.media[0].widthPx, 1920); assert.equal(state.media[0].heightPx, 1080);
  const { default: download } = await import('../../api/video-os-lite/download-v2.js');
  const { makeSession } = await import('../../lib/video-os-account.js');
  process.env.VIDEO_OS_SESSION_SECRET = 'local-final-media-download-proof';
  const downloaded = [];
  const response = { setHeader() {}, write(chunk) { downloaded.push(chunk); }, end() {} };
  await download({ method: 'GET', url: `/api/video-os-lite/download?jobId=${state.job.id}`, headers: { cookie: `vos_session=${makeSession(state.job.accountId, 'local@example.test')}` } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(createHash('sha256').update(Buffer.concat(downloaded)).digest('hex'), state.job.output.sha256);
  assert.equal((await finalizeRenderCredit(state.job.id)).replayed, true);
  assert.equal((await finalizeHeygen(good)).justCompleted, undefined);
  const alternateFile = join(directory, 'alternate.mp4');
  const remux = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-c', 'copy', '-metadata', 'comment=alternate', alternateFile], { timeout: 30000, encoding: 'utf8', windowsHide: true });
  assert.equal(remux.status, 0, remux.stderr);
  const alternate = await artifact(await readFile(alternateFile));
  await assert.rejects(finalizeHeygen(alternate), { statusCode: 409 });
  assert.equal(state.media.length, 1); assert.equal(state.transactions.length, 1);

  await assert.rejects(finalizeHeygen({ ...good, sha256: 'b'.repeat(64) }));
  assert.equal(state.transactions.length, 1);
  delete state.job.output.acceptance;
  await assert.rejects(finalizeHeygen(good), { statusCode: 409 });

  reset();
  state.transactions = [{ sourceType: 'render', sourceId: `render:${state.job.id}`, accountId: 'wrong-account', amount: -90, metadata: { jobId: state.job.id } }];
  await assert.rejects(finalizeHeygen(await artifact(await readFile(file))), { statusCode: 409 });
  assert.equal(state.account.balance, 500); assert.equal(state.job.status, 'finishing');

  reset();
  state.job.provider = 'sadtalker'; state.job.input = { audioReference: { assetId: 'audio-source' } };
  state.sourceAudio = { id: 'audio-source', accountId: state.job.accountId, durationMs: 1000 };
  const standard = await artifact(await readFile(file));
  standard.sourceDurationMs = 99999; // provider-supplied duration is not authority
  await finalizeReadyJob(state.job.id, standard);
  assert.equal(acceptedJobOutput(state.job), true);
  assert.equal(state.transactions.length, 1);

  reset(); state.job.provider = 'sadtalker'; state.job.input = { audioReference: { assetId: 'audio-source' } };
  state.sourceAudio = { id: 'audio-source', accountId: state.job.accountId, durationMs: 10000 };
  await assert.rejects(finalizeReadyJob(state.job.id, await artifact(await readFile(file))), error => error.failureCategory === 'FINAL_MEDIA_VALIDATION');
  assert.equal(state.transactions.length, 0); assert.equal(state.account.balance, 500);
} finally {
  await rm(directory, { recursive: true, force: true });
}
