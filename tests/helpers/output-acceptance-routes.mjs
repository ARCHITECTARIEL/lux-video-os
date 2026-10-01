import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { acceptedJob } from './output-acceptance-fixture.mjs';
import { makeSession } from '../../lib/video-os-account.js';

// Synthetic persistence boundary; real repository queries, handlers and DTO run.
const records = [];
const accepted = acceptedJob('sadtalker'); records.push(accepted);
const legacy = acceptedJob(); legacy.id = '22222222-2222-4333-8444-555555555555'; legacy.title = 'Legacy pending'; delete legacy.output.acceptance; records.push(legacy);
const deleted = acceptedJob('heygen', { id: '33333333-2222-4333-8444-555555555555' }); deleted.title = 'Deleted accepted'; deleted.videoDeletedAt = '2026-09-29T13:00:00Z'; records.push(deleted);
const db = { select() {
  let params = [];
  return { from() { return this; }, where(condition) { params = new PgDialect().sqlToQuery(condition).params; return this; }, orderBy() { return this; }, limit() { return this; }, then(resolve, reject) {
    return Promise.resolve(records.filter(job => job.accountId === params[0] && (params.length === 1 || job.id === params[1]))).then(resolve, reject);
  } };
} };
mock.module('../../db/client.js', { namedExports: { database: () => db } });
let blobReads = 0;
let storedBytes = Buffer.from('video');
mock.module('../../lib/video-os-private-blob.js', { namedExports: { getPrivateBlob: async pathname => {
  blobReads++; assert.equal(pathname, accepted.output.privatePathname);
  return { blob: { etag: 'test-etag' }, stream: (async function* () { yield storedBytes; })() };
} } });
const { default: history } = await import('../../routes/video-os-lite/results-v2.js');
const { default: finalize } = await import('../../api/video-os-lite/finalize-v2.js');
const { default: download } = await import('../../api/video-os-lite/download-v2.js');
process.env.VIDEO_OS_SESSION_SECRET = 'synthetic-contract-test-secret';

let issuedSession = 0;
async function call(handler, { accountId = accepted.accountId, method = 'GET', jobId = accepted.id } = {}) {
  const token = accountId ? makeSession(accountId, `${accountId}@example.test`, 3600 + issuedSession++) : null;
  const chunks = [];
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, write(value) { chunks.push(value); }, end(value) { if (value) this.body = JSON.parse(value); } };
  await handler({ method, url: `/api/video-os-lite/download?jobId=${jobId}`, headers: token ? { cookie: `vos_session=${encodeURIComponent(token)}` } : {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ jobId })); } }, res);
  return { status: res.statusCode, body: res.body, headers: res.headers, bytes: Buffer.concat(chunks).toString() };
}

const first = await call(history);
const freshSession = await call(history);
assert.deepEqual(freshSession.body, first.body, 'fresh session recovers real route DTOs');
assert.equal(first.body.results[0].tier, 'standard');
assert.equal(first.body.results[0].outputAccepted, true);
assert.equal(first.body.results[1].outputAccepted, false);
assert.equal(first.body.results[1].url, null);
assert.equal(first.body.results[2].outputAccepted, true);
assert.equal(first.body.results[2].url, null);
accepted.provider = 'heygen';
assert.equal((await call(history)).body.results[0].tier, 'premium');
assert.equal((await call(finalize, { method: 'POST' })).body.ready, true);
accepted.provider = 'sadtalker';
const acceptedOutput = accepted.output;
accepted.output = {};
assert.equal((await call(finalize, { method: 'POST' })).status, 202);
assert.equal((await call(download)).status, 409);
accepted.output = acceptedOutput;
accepted.status = 'failed';
assert.equal((await call(finalize, { method: 'POST' })).status, 409);
assert.equal((await call(download)).status, 409);
accepted.status = 'ready';
for (const handler of [history, finalize, download]) assert.equal((await call(handler, { accountId: null, method: handler === finalize ? 'POST' : 'GET' })).status, 401);
for (const handler of [finalize, download]) assert.equal((await call(handler, { accountId: 'wrong-owner', method: handler === finalize ? 'POST' : 'GET' })).status, 404);
assert.deepEqual((await call(history, { accountId: 'wrong-owner' })).body.results, []);
for (const [jobId, finalStatus, downloadStatus, ready] of [[accepted.id, 200, 200, true], [legacy.id, 202, 409, false], [deleted.id, 410, 410, false]]) {
  const f = await call(finalize, { jobId, method: 'POST' });
  assert.equal(f.status, finalStatus); assert.equal(f.body.ready, ready);
  assert.equal((await call(download, { jobId })).status, downloadStatus);
}
assert.equal(blobReads, 1, 'denied/unaccepted/deleted requests never read storage');
assert.equal((await call(download)).bytes, 'video');
storedBytes = Buffer.from('other');
const corrupted = await call(download);
assert.equal(corrupted.status, 409);
assert.equal(corrupted.bytes, '', 'never stream bytes before identity verification');
storedBytes = Buffer.from('video');
// No mutation/backfill is performed on a status/history read.
assert.equal(legacy.output.acceptance, undefined);
// Notification gate uses the same evidence; no email is actually sent.
const repo = await import('../../db/repositories.js');
let emails = 0;
mock.module('../../db/repositories.js', { namedExports: { ...repo, getAccount: async () => ({ user: { email: 'synthetic@example.test' } }) } });
mock.module('../../lib/video-os-notifications.js', { namedExports: { sendRenderReadyEmail: async () => { emails++; } } });
process.env.VIDEO_OS_PUBLIC_ORIGIN = 'https://synthetic.example';
const { notifyRenderReady } = await import('../../lib/video-os-render-notify.js');
await notifyRenderReady(accepted, { ...accepted, justCompleted: true });
assert.equal(emails, 1);
for (const job of [legacy, deleted, { ...accepted, status: 'failed' }]) await notifyRenderReady(job, { ...job, justCompleted: true });
await notifyRenderReady(accepted, accepted);
assert.equal(emails, 1, 'legacy/unavailable/failed/replayed outputs never trigger ready email');
if (process.argv.includes('--emit-history')) process.stdout.write(JSON.stringify(first.body));
