import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectEvidence, sha256, checkLedger, checkSession, evidenceDigest } from '../tools/p0-evidence/core.mjs';
import { submissionGuard } from '../tools/p0-evidence/browser.mjs';
import { readAllProviderVideos, normalizeVideo } from '../tools/p0-evidence/live-sources.mjs';
import { parseArgs, privateWriter } from '../tools/collect-p0-evidence.mjs';
import { finalOutputPath } from '../lib/video-os-output-acceptance.js';

const startedAt = '2026-10-02T15:00:00.000Z';
const proofId = '01234567-1234-4123-8123-012345678901';
const title = `P0-PROOF-20261002T150000000Z-${proofId}`;
const bytes = Buffer.from('offline-test-byte-fixture-not-media');
const digest = sha256(bytes);
function fixture() {
  const binding = { accountId: 'fixture-owner', jobId: 'job-01234567-1234-4123-8123-012345678902', correlationId: 'fixture-correlation', providerJobId: 'new-provider-id', title, startedAt, maxCredits: 90 };
  const path = finalOutputPath(binding.accountId, binding.jobId, digest);
  const output = { privatePathname: path, bytes: bytes.length, sha256: digest, acceptance: { version: 1,
    policy: 'video-os-media-v1', status: 'accepted', jobId: binding.jobId, accountId: binding.accountId,
    validatorVersion: 'fixture-only', privatePathname: path, bytes: bytes.length, sha256: digest, validatedAt: startedAt,
    media: { fullDecode: true, videoStreams: 1, audioStreams: 1, width: 1920, height: 1080, durationMs: 1000 },
    checks: { duration: true, dimensions: true, byteLimit: true } } };
  const snapshot = { job: { id: binding.jobId, accountId: binding.accountId, correlationId: binding.correlationId, provider: 'heygen',
    providerJobId: binding.providerJobId, title, createdAt: startedAt, status: 'ready', costCredits: 90, output },
    events: ['render.reserved', 'provider.submitted', 'finish.completed'].map((eventType, index) => ({ id: `event-${index}`, jobId: binding.jobId,
      correlationId: binding.correlationId, eventType, stageTo: eventType === 'provider.submitted' ? 'provider_submitted' : 'ready', createdAt: startedAt, details: { sha256: digest, bytes: bytes.length } })),
    debits: [{ accountId: binding.accountId, sourceType: 'render', sourceId: `render:${binding.jobId}`, amount: -90, metadata: { jobId: binding.jobId } }],
    finals: [{ accountId: binding.accountId, jobId: binding.jobId, privatePathname: path, sha256: digest, bytes: bytes.length }],
    operations: [{ id: 'operation', kind: 'video_create', applicationAccountId: binding.accountId, jobId: binding.jobId,
      correlationId: binding.correlationId, originOperationKey: binding.jobId, attempt: 1, state: 'succeeded', submittedAt: startedAt, bindingId: 'binding', originScopeKey: 'scope' }],
    resources: [{ providerResourceId: binding.providerJobId, applicationAccountId: binding.accountId, kind: 'video', originOperationId: 'operation', bindingId: 'binding', originScopeKey: 'scope' }],
    binding: { id: 'binding', applicationAccountId: binding.accountId, lifecycleState: 'active', environment: 'production', originScopeKey: 'scope' } };
  const intent = { ownerAuthorized: true, maxCredits: 90, origin: 'https://app.example.test', deploymentId: 'dpl_fixture', projectId: 'prj_fixture', gitSha: 'a'.repeat(40) };
  const session = { signedIn: true, accountId: binding.accountId, sessionSha256: '1'.repeat(64), emptyContext: true, issuanceObserved: true, contextId: 'original' };
  const writes = [], calls = [];
  let inventoryCount = 0;
  const sources = {
    candidate: async () => ({ ...intent, target: 'production', state: 'READY' }),
    verifyDatabase: async () => ({ verified: true, environment: 'production' }), verifyBinding: async () => {},
    providerInventory: async () => ++inventoryCount === 1 ? { complete: true, ids: ['old-id'] }
      : { complete: true, ids: ['old-id', binding.providerJobId], videos: [{ title, id: binding.providerJobId }] },
    beginProof: async () => ({ proofId, startedAt }), jobSnapshot: async () => structuredClone(snapshot),
    providerJob: async () => ({ id: binding.providerJobId, title, createdAt: startedAt, status: 'completed' }),
    privateArtifact: async () => ({ bytes: bytes.length, sha256: digest, privateUrl: 'https://fixture.private.blob.vercel-storage.com/final.mp4',
      media: { fullDecode: true, audioStreams: 1, videoStreams: 1, sha256: digest, bytes: bytes.length } }),
  };
  const browser = { signIn: async role => ({ ...session, ...(role === 'recovery' ? { sessionSha256: '2'.repeat(64), contextId: 'recovery' }
      : role === 'wrong-account' ? { sessionSha256: '3'.repeat(64), contextId: 'wrong', accountId: 'fixture-other' } : {}) }),
    submitExactlyOne: async () => { calls.push('submit'); return { jobId: binding.jobId, correlationId: binding.correlationId, requestCount: 1, requestHadCorrelationHeader: false }; },
    galleryDownload: async () => ({ galleryRecovered: true, bytes: bytes.length, sha256: digest }), closeSession: async () => {},
    denials: async () => ({ anonymous: 401, wrongAccount: 404, privateBlob: 403 }), assertSingleSubmission: async () => {},
    submissionMayHaveOccurred: async () => calls.includes('submit'), close: async () => calls.push('close') };
  return { intent, session, snapshot, binding, sources, browser, calls, writes, run: () => collectEvidence({ intent, sources, browser,
    writeEvidence: async value => writes.push(structuredClone(value)), now: () => Date.parse(startedAt), sleep: async () => {} }) };
}

test('all nine synthetic observations produce only a non-clearing collection with bound private hashes', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.p0Cleared, false); assert.equal(result.releaseAuthorized, false);
  const receipt = f.writes.at(-1);
  assert.equal(receipt.status, 'collected_requires_independent_review');
  assert.equal(receipt.qualification, 'incomplete_release_evidence');
  assert.equal(receipt.observations.privateArtifact.pathnameSha256, sha256(f.snapshot.job.output.privatePathname));
  assert.equal(receipt.observations.ledger.submissions, 1);
  assert.equal(result.evidenceSha256, evidenceDigest(receipt));
  assert.deepEqual(f.calls, ['submit', 'close']);
  assert.equal(f.writes[0].jobId, undefined);
  const saved = JSON.stringify(f.writes);
  for (const forbidden of ['fixture-owner', 'fixture-other', f.snapshot.job.output.privatePathname]) assert.ok(!saved.includes(forbidden));
});

const mutations = [
  ['old provider job', f => { f.sources.providerInventory = async () => ({ complete: true, ids: [f.binding.providerJobId] }); }, 'PROVIDER_JOB_NOT_NEW'],
  ['incomplete inventory', f => { f.sources.providerInventory = async () => ({ complete: false, ids: [] }); }, 'PROVIDER_PREFLIGHT_INCOMPLETE'],
  ['self asserted candidate', f => { f.sources.candidate = async () => ({ verified: true }); }, 'CANDIDATE_MISMATCH'],
  ['wrong database', f => { f.sources.verifyDatabase = async () => ({ verified: true, environment: 'verification' }); }, 'DATABASE_UNVERIFIED'],
  ['stale server proof', f => { f.sources.beginProof = async () => ({ proofId, startedAt: '2020-01-01' }); }, 'SERVER_PROOF_UNVERIFIED'],
  ['caller correlation', f => { f.browser.submitExactlyOne = async () => ({ ...f.binding, requestCount: 1, requestHadCorrelationHeader: true }); }, 'SUBMISSION_UNVERIFIED'],
  ['replayed job', f => { f.browser.submitExactlyOne = async () => ({ ...f.binding, requestCount: 1, requestHadCorrelationHeader: false, recovered: true }); }, 'SUBMISSION_UNVERIFIED'],
  ['wrong provider id', f => { f.sources.providerJob = async () => ({ id: 'other', title, createdAt: startedAt, status: 'completed' }); }, 'PROVIDER_JOB_BINDING_MISMATCH'],
  ['old provider timestamp', f => { f.sources.providerJob = async () => ({ id: f.binding.providerJobId, title, createdAt: '2020-01-01', status: 'completed' }); }, 'PROVIDER_JOB_BINDING_MISMATCH'],
  ['stored hash mismatch', f => { f.sources.privateArtifact = async () => ({ bytes: bytes.length, sha256: 'b'.repeat(64) }); }, 'PRIVATE_ARTIFACT_MISMATCH'],
  ['gallery hash mismatch', f => { f.browser.galleryDownload = async () => ({ galleryRecovered: true, bytes: bytes.length, sha256: 'b'.repeat(64) }); }, 'ORIGINAL_GALLERY_MISMATCH'],
  ['anonymous escape', f => { f.browser.denials = async () => ({ anonymous: 200, wrongAccount: 404, privateBlob: 403 }); }, 'DOWNLOAD_DENIAL_FAILED'],
  ['wrong user escape', f => { f.browser.denials = async () => ({ anonymous: 401, wrongAccount: 200, privateBlob: 403 }); }, 'DOWNLOAD_DENIAL_FAILED'],
  ['blob redirect', f => { f.browser.denials = async () => ({ anonymous: 401, wrongAccount: 404, privateBlob: 302 }); }, 'DOWNLOAD_DENIAL_FAILED'],
];
for (const [name, mutate, code] of mutations) test(`${name} fails closed`, async () => {
  const f = fixture(); mutate(f); await assert.rejects(f.run(), { code });
  assert.ok(f.writes.every(value => value.p0Cleared === false && value.releaseAuthorized === false));
});

const ledgerMutations = [
  ['second submit event', s => s.events.push({ ...s.events[1], id: 'duplicate' }), 'EVENT_COUNT_MISMATCH'],
  ['second debit', s => s.debits.push(s.debits[0]), 'DEBIT_MISMATCH'],
  ['second final', s => s.finals.push(s.finals[0]), 'FINAL_ROW_MISMATCH'],
  ['wrong event correlation', s => { s.events[0].correlationId = 'wrong'; }, 'EVENT_CORRELATION_MISMATCH'],
  ['wrong submission event provider id', s => { s.events[1].details.providerJobId = 'wrong'; }, 'SUBMISSION_EVENT_MISMATCH'],
  ['credit ceiling exceeded', s => { s.job.costCredits = 91; }, 'JOB_BINDING_MISMATCH'],
  ['repaired event', s => s.events.push({ ...s.events[0], eventType: 'workflow.recovery_reserved' }), 'REPAIRED_OR_AMBIGUOUS_JOB'],
  ['wrong media owner', s => { s.finals[0].accountId = 'other'; }, 'FINAL_ROW_MISMATCH'],
  ['second provider operation', s => s.operations.push(s.operations[0]), 'PROVIDER_OPERATION_MISMATCH'],
  ['wrong resource scope', s => { s.resources[0].originScopeKey = 'other'; }, 'PROVIDER_RESOURCE_MISMATCH'],
  ['revoked binding', s => { s.binding.revokedAt = startedAt; }, 'PROVIDER_BINDING_MISMATCH'],
  ['forged acceptance', s => { s.job.output.acceptance.accountId = 'other'; }, 'FINAL_NOT_ACCEPTED'],
];
for (const [name, mutate, code] of ledgerMutations) test(`${name} is rejected`, () => {
  const f = fixture(); mutate(f.snapshot); assert.throws(() => checkLedger(f.snapshot, f.binding), { code });
});
test('copied sessions and same-account wrong-user tests are rejected', () => {
  const { session } = fixture();
  assert.throws(() => checkSession({ ...session, contextId: 'new' }, { differentSession: session }), { code: 'FRESH_SESSION_REQUIRED' });
  assert.throws(() => checkSession(session, { differentAccount: session }), { code: 'WRONG_ACCOUNT_REQUIRED' });
  assert.throws(() => checkSession({ ...session, issuanceObserved: false }), { code: 'SESSION_UNVERIFIED' });
});
test('lost submit response saves incomplete evidence and never retries', async () => {
  const f = fixture(); f.browser.submitExactlyOne = async () => { f.calls.push('submit'); throw new Error('private secret must not be saved'); };
  await assert.rejects(f.run()); assert.equal(f.calls.filter(x => x === 'submit').length, 1);
  assert.equal(f.writes.at(-1).submissionMayHaveOccurred, true);
  assert.ok(!JSON.stringify(f.writes).includes('private secret'));
});
test('single request guard consumes before network and blocks retry, wrong title, or caller correlation', () => {
  const request = body => ({ url: () => 'https://app.example.test/api/video-os-lite/render', method: () => 'POST', postDataJSON: () => body, headers: () => ({}) });
  const state = { armed: true, sent: 0, expectedRequestDigest: evidenceDigest({ title, tier: 'PREMIUM', idempotencyKey: 'key' }) }; 
  const guard = { origin: 'https://app.example.test', title, state };
  assert.equal(submissionGuard(guard, request({ title, tier: 'PREMIUM', idempotencyKey: 'key' })), true);
  assert.throws(() => submissionGuard(guard, request({ title, tier: 'PREMIUM', idempotencyKey: 'key' })), { code: 'ADDITIONAL_SUBMISSION_BLOCKED' });
  assert.equal(state.sent, 1);
});
test('provider inventory follows every page and rejects clipped, repeated, or ambiguous pages', async () => {
  const raw = id => ({ id, title: 'video', status: 'completed', created_at: 1790953200 });
  let count = 0;
  const result = await readAllProviderVideos(async url => ++count === 1 ? { data: [raw('one')], has_more: true, next_token: 'next' }
    : (assert.equal(url.searchParams.get('token'), 'next'), { data: [raw('two')], has_more: false }));
  assert.deepEqual(result.ids, ['one', 'two']);
  await assert.rejects(readAllProviderVideos(async () => ({ data: [], has_more: true, next_token: 'same' })), { code: 'PROVIDER_PAGINATION_INVALID' });
  await assert.rejects(readAllProviderVideos(async () => ({ data: [] })), { code: 'PROVIDER_INVENTORY_INVALID' });
  await assert.rejects(readAllProviderVideos(async () => ({ data: [raw('one'), raw('one')], has_more: false })), { code: 'PROVIDER_INVENTORY_DUPLICATE' });
  assert.throws(() => normalizeVideo({ id: 'x', title: 'x', status: 'completed' }), { code: 'PROVIDER_VIDEO_INVALID' });
});
test('private checkpoints are exclusive, mode-restricted and file-byte hashed', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'p0-writer-test-'));
  try {
    const directory = join(parent, 'new'); const write = await privateWriter(directory);
    await write({ p0Cleared: false, n: 1 }); await write({ p0Cleared: false, n: 2 });
    assert.equal((await readdir(directory)).length, 4);
    const path = join(directory, 'observation-001.json');
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await readFile(`${path}.sha256`, 'utf8')).trim(), sha256(await readFile(path)));
    await assert.rejects(privateWriter(directory));
  } finally { await rm(parent, { recursive: true, force: true }); }
});
test('CLI is import-safe, help-only without auth, rejects receipt inputs without echo', () => {
  assert.throws(() => parseArgs(['--receipt', 'private-sentinel']), { code: 'ARGUMENTS_INVALID' });
  for (const args of [[], ['--receipt', 'private-sentinel']]) {
    const result = spawnSync(process.execPath, ['tools/collect-p0-evidence.mjs', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.ok(!`${result.stdout}${result.stderr}`.includes('private-sentinel'));
  }
  const help = spawnSync(process.execPath, ['tools/collect-p0-evidence.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /gate remains BLOCKED/);
});

test('render-v2 shipped client route is explicitly guarded and exact approved request changes fail before network', async () => {
  const source = await readFile(new URL('../public/scripted-photo-client.js', import.meta.url), 'utf8');
  assert.match(source, /request\('\/api\/video-os-lite\/render-v2'/);
  const approved = { title, tier: 'PREMIUM', idempotencyKey: 'key', identityId: 'identity', script: 'approved', format: 'landscape', projectId: 'project', quoteToken: 'token', contractVersion: 'scripted-photo-v1' };
  const request = (body = approved, path = '/api/video-os-lite/render-v2', headers = {}) => ({ url: () => `https://app.example.test${path}`, method: () => 'POST', postDataJSON: () => body, headers: () => headers });
  for (const path of ['/api/video-os-lite/render-v2', '/api/video-os-lite/render', '/api/video-os-lite/render-v2.js']) {
    const state = { armed: true, sent: 0, expectedRequestDigest: evidenceDigest(approved) };
    assert.equal(submissionGuard({ origin: 'https://app.example.test', title, state }, request(approved, path)), true);
    assert.equal(state.sent, 1);
  }
  for (const changed of [{ ...approved, title: 'other' }, { ...approved, script: 'changed' }, { ...approved, identityId: 'other' },
    { ...approved, quoteToken: 'changed' }, { ...approved, tier: 'premium' }, { ...approved, format: 'square' }]) {
    const state = { armed: true, sent: 0, expectedRequestDigest: evidenceDigest(approved) };
    assert.throws(() => submissionGuard({ origin: 'https://app.example.test', title, state }, request(changed)), { code: 'SUBMISSION_INTENT_MISMATCH' });
    assert.equal(state.sent, 0);
  }
  const state = { armed: true, sent: 0, expectedRequestDigest: evidenceDigest(approved) };
  assert.throws(() => submissionGuard({ origin: 'https://app.example.test', title, state }, request(approved, '/api/video-os-lite/render-other')), { code: 'SUBMISSION_ROUTE_MISMATCH' });
  assert.throws(() => submissionGuard({ origin: 'https://app.example.test', title, state }, request(approved, '/api/video-os-lite/render-v2', { 'x-request-id': 'caller-correlation' })), { code: 'SUBMISSION_INTENT_MISMATCH' });
});
