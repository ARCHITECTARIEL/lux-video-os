import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import test from 'node:test';
import {runHeygenSpaceReprobeForTests} from '../tools/probe-heygen-space-refresh.mjs';
import {qualifyHeygenCredential} from '../services/heygen-account-qualification.js';
import {assertFreshHeygenSpaceProof, assertPinnedHeygenSpaceAnchor, loadHeygenSpaceReprobeOrigin, validateHeygenSpaceReprobeQualification, validateHeygenQualificationSnapshotForTests} from '../lib/heygen-space-anchor.js';
import {prepareHeygenSpaceRefreshCandidate} from '../lib/heygen-space-refresh.js';

const NOW = '2026-10-02T16:30:00.000Z', KEY = 'offline-synthetic-key-never-valid';
const hash = s => createHash('sha256').update(s).digest('hex');
const domain = (s, v) => hash(Buffer.concat([Buffer.from(`LUX_VIDEO_OS\0${s}\0V1\0`), Buffer.from(v)]));
const keyData = () => ({key_id: 'synthetic-key-id', status: 'active', scope_mode: 'full', scopes: ['*:*'],
  created_at: '2026-10-01T14:35:48.000Z', updated_at: '2026-10-01T14:35:48.000Z', expires_at: null, expires_in_seconds: null});
const profile = () => ({username: 'synthetic-owner', email: null, billing_type: null});
const data = (value, status = 200) => new Response(JSON.stringify({data: value}), {status, headers: {'content-type': 'application/json'}});
const responses = () => [data(keyData()), data(profile()),
  data({asset_id: 'synthetic-new-asset', url: 'https://cdn.example.invalid/private.png', mime_type: 'image/png', size_bytes: 95}),
  data({id: 'synthetic-new-asset', name: 'provider-space-probe.png', type: 'image', owner: 'synthetic-owner', space_id: 'synthetic-space', uploaded_at: 1790958600}),
  data({id: 'synthetic-new-asset'}), new Response(JSON.stringify({error: {code: 'asset_not_found', message: 'Asset not found'}}), {status: 404})];
const snapshot = q => ({observedAt: q.observedAt, credentialKeyFingerprint: q.credentialKeyFingerprint,
  credentialScopeFingerprint: q.credentialScopeFingerprint, keyIdDigest: q.privateEvidence.keyIdDigest,
  keyCreatedAt: q.privateEvidence.createdAt, usernameDigest: domain('HEYGEN_PROFILE_USERNAME', q.privateEvidence.profile.username)});
async function harness(t, options = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'heygen-reprobe-test-')); await chmod(parent, 0o700);
  t.after(() => rm(parent, {recursive: true, force: true}));
  const qResponses = responses();
  const qualification = await qualifyHeygenCredential({apiKey: KEY, now: NOW, fetchImpl: async () => qResponses.shift()});
  const origin = {identityDigest: 'a'.repeat(64), probeResultSha256: 'b'.repeat(64),
    spaceObservedAt: '2026-10-01T15:11:53.953Z', ...snapshot(qualification),
    fixtureSha256: 'f96c86519d1502fd319cdb106ca2a5277a83e09ad4d6e85279756ce77f05563e', fixtureBytes: 95,
    providerSpaceFingerprint: hash(JSON.stringify({provider: 'heygen', scopeType: 'space', spaceId: 'synthetic-space'})),
    canonicalScopeKey: 'c'.repeat(64), policy: {freshQualificationMaxAgeSeconds: 60}, ...options.origin};
  const directory = join(parent, 'run'), approvalFile = join(parent, 'approval.json');
  const approval = {version: 'heygen-space-reprobe-approval/v1', approvalId: randomUUID(), approvedAt: '2026-10-02T16:29:00.000Z', expiresAt: '2026-10-02T16:45:00.000Z',
    runDirectory: directory, originIdentityDigest: origin.identityDigest, fixtureSha256: origin.fixtureSha256,
    operations: {qualificationGets: 2, assetUploads: 1, assetMetadataGets: 1, assetDeletes: 1, assetReadbacks: 1, mutationRetries: 0, generationCalls: 0},
    costPolicy: 'explicitly-approved-without-enforceable-provider-price-cap', ownerApproved: true,
    irreversibleDeletionOfNewProbeOnlyApproved: true, noRetryAndPossibleRetainedAssetAccepted: true, ...options.approval};
  const saveApproval = () => writeFile(approvalFile, JSON.stringify(approval), {mode: 0o600}); await saveApproval();
  const queue = responses(), calls = []; let stdout = '', stderr = '';
  const args = ['--execute', '--private-run-dir', directory, '--approval-file', approvalFile];
  const deps = {env: {HEYGEN_API_KEY: KEY}, now: () => NOW, loadOrigin: async () => origin,
    validateQualification: (o, q, now) => validateHeygenQualificationSnapshotForTests(o, q, now),
    fetchImpl: async (url, request) => {
      calls.push({url, request});
      const claimName = ['qualification-self', 'qualification-profile', 'upload', 'read', 'delete', 'readback'][calls.length - 1];
      assert.equal(JSON.parse(await readFile(join(directory, `${claimName}.claim.json`))).state, 'intent-consumed-before-network');
      assert.equal(request.redirect, 'error'); assert.equal(request.headers['X-Api-Key'], KEY);
      if (queue[0] instanceof Error) throw queue.shift();
      if (typeof queue[0] === 'function') return queue.shift()(url, request);
      return queue.shift();
    }};
  const run = () => runHeygenSpaceReprobeForTests({args, stdout: {write(s) {stdout += s;}}, stderr: {write(s) {stderr += s;}}}, deps);
  return {parent, directory, approvalFile, approval, saveApproval, args, deps, calls, queue, origin, run, output: () => ({stdout, stderr})};
}

// All requests in this file are injected in-process Responses. Never use real credentials.
test('six fixed calls, pinned multipart and durable one-shot claims produce exact consumer receipt contract', async t => {
  const h = await harness(t); assert.equal(await h.run(), 0);
  assert.deepEqual(h.calls.map(c => [c.request.method, new URL(c.url).pathname]), [
    ['GET', '/v3/api_keys/self'], ['GET', '/v3/users/me'], ['POST', '/v3/assets'],
    ['GET', '/v3/assets/synthetic-new-asset'], ['DELETE', '/v3/assets/synthetic-new-asset'], ['GET', '/v3/assets/synthetic-new-asset']]);
  const form = h.calls[2].request.body;
  assert.deepEqual([...form.keys()], ['file']);
  const file = form.get('file'); assert.equal(file.name, 'provider-space-probe.png'); assert.equal(file.type, 'image/png'); assert.equal(file.size, 95);
  assert.equal(hash(Buffer.from(await file.arrayBuffer())), h.origin.fixtureSha256);
  assert.equal(h.calls[4].request.body, undefined);
  const receipts = join(h.directory, 'receipts');
  assert.deepEqual((await readdir(receipts)).sort(), ['delete.json', 'qualification.json', 'read.json', 'readback.json', 'upload.json']);
  const candidate = await prepareHeygenSpaceRefreshCandidate(receipts, h.origin, snapshot, {now: NOW});
  assert.equal(candidate.observation.providerSpaceFingerprint, h.origin.providerSpaceFingerprint);
  assert.equal(candidate.observation.completedAt, NOW);
  for (const name of await readdir(receipts)) assert.equal((await stat(join(receipts, name))).mode & 0o777, 0o600);
  assert.equal((await stat(receipts)).mode & 0o777, 0o700);
  const journal = await readFile(join(h.directory, 'journal.jsonl'), 'utf8'); assert.match(journal, /safe-api-cleanup-observed/);
  assert.doesNotMatch(JSON.stringify(h.output()), /synthetic|https:|offline-synthetic|space_id/);
  assert.doesNotMatch(journal, /offline-synthetic|cdn.example/);
});
test('same run and consumed approval cannot replay in a new directory', async t => {
  const h = await harness(t); assert.equal(await h.run(), 0); assert.equal(await h.run(), 1); assert.equal(h.calls.length, 6);
  h.approval.runDirectory = join(h.parent, 'other-run'); h.args[2] = h.approval.runDirectory; await h.saveApproval();
  assert.equal(await h.run(), 1); assert.equal(h.calls.length, 6);
});
test('approval template is offline and lacks executable approval', async t => {
  const h = await harness(t); h.args.splice(0, h.args.length, '--approval-template', '--private-run-dir', h.directory);
  assert.equal(await h.run(), 0); assert.equal(h.calls.length, 0);
  const a = JSON.parse(h.output().stdout); assert.equal(a.ownerApproved, false); assert.equal(a.approvalId, null);
});
for (const [name, mutate] of [
  ['owner approval missing', h => {h.approval.ownerApproved = false;}],
  ['delete approval missing', h => {h.approval.irreversibleDeletionOfNewProbeOnlyApproved = false;}],
  ['unbounded approval', h => {h.approval.expiresAt = '2026-10-03T16:45:00.000Z';}],
  ['expired approval', h => {h.approval.expiresAt = '2026-10-02T16:29:01.000Z';}],
  ['retry requested', h => {h.approval.operations.mutationRetries = 1;}],
  ['generation requested', h => {h.approval.operations.generationCalls = 1;}],
  ['invented zero-cost guarantee', h => {h.approval.costPolicy = 'zero-cost';}],
  ['unknown approval property', h => {h.approval.assetId = 'existing-asset';}],
  ['different key', h => {h.deps.env.HEYGEN_API_KEY = 'another-key';}],
  ['missing key', h => {delete h.deps.env.HEYGEN_API_KEY;}],
  ['future historical origin', h => {h.origin.spaceObservedAt = '2026-10-03T00:00:00.000Z';}],
  ['changed fixture hash', h => {h.origin.fixtureSha256 = 'f'.repeat(64); h.approval.fixtureSha256 = h.origin.fixtureSha256;}],
  ['deployed environment', h => {h.deps.env.VERCEL_ENV = 'production';}],
  ['arbitrary asset option', h => {h.args.push('--asset-id', 'existing-asset');}],
  ['relative path', h => {h.args[2] = './relative';}],
  ['dot segments', h => {h.args[2] = `${h.parent}/child/../run`;}],
  ['output in repository', h => {h.args[2] = resolve('private-probe');}],
  ['duplicate options', h => {h.args.push('--private-run-dir', h.directory);}]
]) test(`preflight denies ${name} without network`, async t => {
  const h = await harness(t); mutate(h); await h.saveApproval(); assert.equal(await h.run(), 1); assert.equal(h.calls.length, 0);
});
test('symlink approval, unsafe permissions, hardlink-like and existing output all fail closed', async t => {
  const h = await harness(t);
  await chmod(h.approvalFile, 0o644); assert.equal(await h.run(), 1); assert.equal(h.calls.length, 0);
  await chmod(h.approvalFile, 0o600);
  const alternate = join(h.parent, 'linked.json'); await symlink(h.approvalFile, alternate); h.args[4] = alternate;
  assert.equal(await h.run(), 1); h.args[4] = h.approvalFile;
  const hardlink = join(h.parent, 'hardlink.json'); await link(h.approvalFile, hardlink); assert.equal(await h.run(), 1); await rm(hardlink);
  await mkdir(h.directory, {mode: 0o700}); assert.equal(await h.run(), 1); assert.equal(h.calls.length, 0);
});
for (const [name, index, replacement, expectedCalls] of [
  ['wrong key id', 0, () => data({...keyData(), key_id: 'different'}), 2],
  ['wrong key creation', 0, () => data({...keyData(), created_at: '2025-01-01T00:00:00.000Z'}), 2],
  ['wrong profile owner', 1, () => data({...profile(), username: 'different'}), 2],
  ['read-only scope', 0, () => data({...keyData(), scope_mode: 'read_only', scopes: ['*:read']}), 2],
  ['authorization denied', 0, () => new Response('{"error":{"code":"unauthorized"}}', {status: 401}), 1],
  ['upload timeout/network ambiguity', 2, () => new Error('private-id https://untrusted.invalid'), 3],
  ['rate limit has no retry', 2, () => new Response('{"error":{"code":"rate_limit_exceeded"}}', {status: 429, headers: {'retry-after': '0'}}), 3],
  ['wrong upload type', 2, () => data({asset_id: 'synthetic-new-asset', mime_type: 'video/mp4', size_bytes: 95}), 3],
  ['wrong upload size', 2, () => data({asset_id: 'synthetic-new-asset', mime_type: 'image/png', size_bytes: 96}), 3],
  ['path traversal asset id', 2, () => data({asset_id: '../other', mime_type: 'image/png', size_bytes: 95}), 3],
  ['dot segment asset id', 2, () => data({asset_id: '..', mime_type: 'image/png', size_bytes: 95}), 3],
  ['different metadata asset', 3, () => data({id: 'existing-other-asset', type: 'image', owner: 'synthetic-owner', space_id: 'synthetic-space'}), 4],
  ['different metadata owner', 3, () => data({id: 'synthetic-new-asset', type: 'image', owner: 'someone-else', space_id: 'synthetic-space'}), 4],
  ['different native space', 3, () => data({id: 'synthetic-new-asset', type: 'image', owner: 'synthetic-owner', space_id: 'other-space'}), 4],
  ['different metadata type', 3, () => data({id: 'synthetic-new-asset', type: 'video', owner: 'synthetic-owner', space_id: 'synthetic-space'}), 4],
  ['delete network ambiguity', 4, () => new Error('sensitive provider details'), 5],
  ['delete wrong id', 4, () => data({id: 'another-asset'}), 5],
  ['delete already absent', 4, () => new Response('{"error":{"code":"asset_not_found"}}', {status: 404}), 5],
  ['readback still present', 5, () => data({id: 'synthetic-new-asset'}), 6],
  ['readback different error', 5, () => new Response('{"error":{"code":"other_error"}}', {status: 404}), 6],
  ['contradictory readback data', 5, () => new Response('{"error":{"code":"asset_not_found"},"data":{"id":"synthetic-new-asset"}}', {status: 404}), 6],
  ['redirect denied', 2, () => new Response(null, {status: 302, headers: {location: 'https://untrusted.invalid'}}), 3],
  ['malformed response', 2, () => new Response('not json'), 3],
  ['oversize declared response', 2, () => new Response('{}', {headers: {'content-length': String(1024 * 1024)}}), 3],
  ['oversize streamed response', 2, () => new Response(' '.repeat(125000)), 3],
  ['reflected secret never saved', 2, () => data({asset_id: 'synthetic-new-asset', private: KEY}), 3]
]) test(`stops on ${name}; retains journal, never retries or broadens deletion`, async t => {
  const h = await harness(t); h.queue[index] = replacement();
  assert.equal(await h.run(), 1); assert.equal(h.calls.length, expectedCalls);
  assert.equal((await readdir(h.directory)).includes('receipts'), false);
  assert.match(await readFile(join(h.directory, 'journal.jsonl'), 'utf8'), /stopped-no-retry/);
  assert.doesNotMatch(JSON.stringify(h.output()), /private-id|https:|sensitive|synthetic-new|someone-else/);
  assert.equal(await h.run(), 1); assert.equal(h.calls.length, expectedCalls);
});
test('qualification expiry after upload stops before any further provider call', async t => {
  const h = await harness(t); let current = NOW; h.deps.now = () => current;
  const reply = h.queue[2]; h.queue[2] = () => {current = '2026-10-02T16:31:00.000Z'; return reply;};
  assert.equal(await h.run(), 1); assert.equal(h.calls.length, 3); assert.match(h.output().stderr, /QUALIFICATION_STALE/);
});
test('clock regression stops before deletion', async t => {
  const h = await harness(t); let current = NOW; h.deps.now = () => current;
  const reply = h.queue[3]; h.queue[3] = () => {current = '2026-10-02T16:29:59.000Z'; return reply;};
  assert.equal(await h.run(), 1); assert.equal(h.calls.length, 4); assert.match(h.output().stderr, /CLOCK_REGRESSED/);
});
test('test transport and origin injection is denied outside Node test runner', () => {
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT; delete env.HEYGEN_API_KEY;
  const source = "import {runHeygenSpaceReprobeForTests} from './tools/probe-heygen-space-refresh.mjs'; try {await runHeygenSpaceReprobeForTests({}, {}); process.exitCode=9;} catch(e) {process.stdout.write(e.code);}";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {cwd: resolve(import.meta.dirname, '..'), env, encoding: 'utf8'});
  assert.equal(result.status, 0); assert.equal(result.stdout, 'REPROBE_TEST_ONLY');
});

test('compact near-limit provider data still produces consumer-sized receipts', async t => {
  const h = await harness(t);
  h.queue[2] = data({asset_id: 'synthetic-new-asset', mime_type: 'image/png', size_bytes: 95, extra: Array(30000).fill(1)});
  assert.equal(await h.run(), 0);
  const receipt = await readFile(join(h.directory, 'receipts', 'upload.json')); assert.ok(receipt.length < 131072);
  await prepareHeygenSpaceRefreshCandidate(join(h.directory, 'receipts'), h.origin, snapshot, {now: NOW});
});
test('symlinked private parent is rejected before network', async t => {
  const h = await harness(t), alias = `${h.parent}-alias`; await symlink(h.parent, alias); t.after(() => rm(alias));
  h.args[2] = join(alias, 'run'); assert.equal(await h.run(), 1); assert.equal(h.calls.length, 0);
});
test('hung upload times out once, preserves consumed intent and never deletes', {timeout: 12000}, async t => {
  const h = await harness(t); h.queue[2] = () => new Promise(() => {});
  assert.equal(await h.run(), 1); assert.equal(h.calls.length, 3); assert.match(h.output().stderr, /TIMEOUT_UNCERTAIN/);
});

for (const [name, before, expectedCalls] of [['first qualification GET', 'qualification-self', 0], ['second qualification GET', 'qualification-profile', 1], ['upload', 'upload', 2], ['delete', 'delete', 4]]) {
  test(`approval expiry during ${name} claim persistence prevents its network request`, async t => {
    const h = await harness(t);
    h.deps.now = () => existsSync(join(h.directory, `${before}.claim.json`)) ? h.approval.expiresAt : NOW;
    assert.equal(await h.run(), 1); assert.equal(h.calls.length, expectedCalls);
  });
}
test('upload clock regression preserves private response ID for separately authorized recovery', async t => {
  const h = await harness(t); let current = NOW; h.deps.now = () => current;
  const reply = h.queue[2]; h.queue[2] = () => {current = '2026-10-02T16:29:59.000Z'; return reply;};
  assert.equal(await h.run(), 1); assert.equal(h.calls.length, 3);
  const raw = JSON.parse(await readFile(join(h.directory, 'upload.response.json')));
  assert.equal(raw.payload.data.asset_id, 'synthetic-new-asset'); assert.equal(raw.status, 200);
  assert.equal((await readdir(h.directory)).includes('receipts'), false);
});
test('rejected oversized response cancels its body without retry', async t => {
  const h = await harness(t); let cancelled = false;
  h.queue[2] = new Response(new ReadableStream({cancel() {cancelled = true;}}), {headers: {'content-length': '999999'}});
  assert.equal(await h.run(), 1); assert.equal(h.calls.length, 3); assert.equal(cancelled, true);
});
test('qualifier stop-only hook sees frozen method/path and cannot continue after its deadline', async () => {
  let requests = 0, hookRequest;
  await assert.rejects(qualifyHeygenCredential({apiKey: KEY, now: NOW, timeoutMs: 2,
    fetchImpl: async () => {requests++; return data(keyData());},
    beforeRequest: async request => {hookRequest = request; await new Promise(resolve => setTimeout(resolve, 25));},
  }), {code: 'HEYGEN_QUALIFICATION_TIMEOUT'});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(requests, 0); assert.ok(Object.isFrozen(hookRequest));
  assert.deepEqual(hookRequest, {method: 'GET', pathTemplate: '/v3/api_keys/self'});
});
test('qualifier denies invalid request guard and stop requests without calling transport', async () => {
  let requests = 0; const fetchImpl = async () => {requests++; return data(keyData());};
  await assert.rejects(qualifyHeygenCredential({apiKey: KEY, now: NOW, fetchImpl, beforeRequest: true}), {code: 'INVALID_HEYGEN_QUALIFICATION_OPTIONS'});
  await assert.rejects(qualifyHeygenCredential({apiKey: KEY, now: NOW, fetchImpl, beforeRequest() {throw new Error('stop');}}), {code: 'HEYGEN_QUALIFICATION_NETWORK_FAILURE'});
  assert.equal(requests, 0);
});

for (const [name, before, expectedCalls] of [['upload', 'upload', 2], ['delete', 'delete', 4]]) {
  test(`60-second qualification expiry during ${name} claim persistence prevents dispatch`, async t => {
    const h = await harness(t);
    h.deps.now = () => existsSync(join(h.directory, `${before}.claim.json`)) ? '2026-10-02T16:31:00.000Z' : NOW;
    assert.equal(await h.run(), 1); assert.equal(h.calls.length, expectedCalls);
  });
}
test('historical reprobe origin and compare-only output never confer runtime anchor/proof authority', async t => {
  const origin = await loadHeygenSpaceReprobeOrigin();
  assert.equal(origin.verificationMode, 'refresh_review_only');
  assert.throws(() => assertPinnedHeygenSpaceAnchor(origin, {now: NOW}), {code: 'UNVERIFIED_HEYGEN_SPACE_ANCHOR'});
  assert.throws(() => validateHeygenSpaceReprobeQualification({...origin}, {}, {now: NOW}), {code: 'UNVERIFIED_HEYGEN_REPROBE_ORIGIN'});
  assert.throws(() => validateHeygenSpaceReprobeQualification(origin, {}, {now: NOW}), {code: 'UNVERIFIED_HEYGEN_QUALIFICATION'});
  const h = await harness(t);
  const queue = responses(), q = await qualifyHeygenCredential({apiKey: KEY, now: NOW, fetchImpl: async () => queue.shift()});
  const proof = validateHeygenQualificationSnapshotForTests(h.origin, q, {now: NOW});
  assert.throws(() => assertFreshHeygenSpaceProof(proof, {now: NOW}), {code: 'UNVERIFIED_HEYGEN_SPACE_PROOF'});
  assert.throws(() => validateHeygenSpaceReprobeQualification(origin, q, {now: NOW}), {code: 'HEYGEN_QUALIFICATION_MISMATCH'});
});
