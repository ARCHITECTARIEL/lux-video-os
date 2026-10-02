import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyHeygenSpaceRefreshForTests, heygenRefreshDigest, loadReviewedHeygenSpaceRefresh, prepareHeygenSpaceRefreshCandidate } from '../lib/heygen-space-refresh.js';
import { assertFreshHeygenSpaceProof, loadPinnedHeygenSpaceAnchorProjection, prepareReviewedHeygenSpaceRefresh } from '../lib/heygen-space-anchor.js';
import { heygenRuntimeFiles, stageHeygenRuntimeFiles } from '../tools/stage-heygen-runtime-files.mjs';
import { runRefreshPreparation } from '../tools/prepare-heygen-space-refresh.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const NOW = '2026-10-02T16:00:00.000Z';
function fixture() {
  const origin = {
    identityDigest: 'a'.repeat(64), probeResultSha256: 'b'.repeat(64), spaceObservedAt: '2026-10-01T15:00:00.000Z',
    anchorExpiresAt: '2026-10-02T15:00:00.000Z', credentialKeyFingerprint: 'c'.repeat(64),
    credentialScopeFingerprint: 'd'.repeat(64), keyIdDigest: 'e'.repeat(64), keyCreatedAt: '2026-10-01T14:00:00.000Z',
    usernameDigest: 'f'.repeat(64), providerSpaceFingerprint: hash(JSON.stringify({provider: 'heygen', scopeType: 'space', spaceId: 'space-fixture'})),
    canonicalScopeKey: '1'.repeat(64), fixtureSha256: '2'.repeat(64), fixtureBytes: 95,
    policy: { anchorMaxAgeSeconds: 86400, freshQualificationMaxAgeSeconds: 60, productionReprobePolicy: 'UNSET', productionReprobeMaxAgeSeconds: null },
  };
  const qualification = { ...Object.fromEntries(['credentialKeyFingerprint', 'credentialScopeFingerprint', 'keyIdDigest', 'keyCreatedAt', 'usernameDigest'].map(key => [key, origin[key]])),
    observedAt: '2026-10-02T15:58:00.000Z', privateEvidence: { profile: {username: 'synthetic-owner'} } };
  const common = {assetIdSha256: hash('probe-asset'), fixtureSha256: origin.fixtureSha256, errorCode: null};
  const files = {
    'qualification.json': qualification,
    'upload.json': {...common, method: 'POST', pathTemplate: '/v3/assets', observedAt: '2026-10-02T15:58:01.000Z', status: 200, data: {asset_id: 'probe-asset', mime_type: 'image/png', size_bytes: 95}},
    'read.json': {...common, method: 'GET', pathTemplate: '/v3/assets/{probe_asset_id}', observedAt: '2026-10-02T15:58:02.000Z', status: 200, data: {id: 'probe-asset', owner: 'synthetic-owner', space_id: 'space-fixture'}},
    'delete.json': {...common, method: 'DELETE', pathTemplate: '/v3/assets/{probe_asset_id}', observedAt: '2026-10-02T15:58:03.000Z', status: 200, data: {id: 'probe-asset'}},
    'readback.json': {...common, method: 'GET', pathTemplate: '/v3/assets/{probe_asset_id}', observedAt: '2026-10-02T15:58:04.000Z', status: 404, errorCode: 'asset_not_found', data: null},
  };
  return {origin, files};
}
async function directory(t, files) {
  const path = await mkdtemp(join(tmpdir(), 'heygen-refresh-test-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  for (const [name, value] of Object.entries(files)) await writeFile(join(path, name), JSON.stringify(value), {mode: 0o600});
  return path;
}
async function candidate(t, mutate = () => {}) {
  const f = fixture(); mutate(f);
  const path = await directory(t, f.files);
  return { ...f, document: await prepareHeygenSpaceRefreshCandidate(path, f.origin, value => value, {now: NOW}) };
}

test('pinned empty refresh preserves expiry and never grants authority', async () => {
  const {origin} = fixture();
  assert.equal(await loadReviewedHeygenSpaceRefresh(origin, {now: NOW}), origin);
  await assert.rejects(loadPinnedHeygenSpaceAnchorProjection({now: NOW}), error => error.code === 'HEYGEN_SPACE_ANCHOR_STALE');
  assert.throws(() => assertFreshHeygenSpaceProof(origin, {now: NOW}), error => error.code === 'UNVERIFIED_HEYGEN_SPACE_PROOF');
});

test('fresh review candidate retains all original provenance and has a separate evidence horizon', async t => {
  const {origin, document} = await candidate(t);
  const refreshed = applyHeygenSpaceRefreshForTests(document, origin, NOW);
  assert.equal(refreshed.originSpaceObservedAt, origin.spaceObservedAt);
  assert.equal(refreshed.identityDigest, origin.identityDigest);
  assert.equal(refreshed.probeResultSha256, origin.probeResultSha256);
  assert.equal(refreshed.freshnessEvidenceSha256, heygenRefreshDigest(document));
  assert.equal(refreshed.anchorExpiresAt, '2026-10-03T15:58:02.000Z');
  assert.ok(Object.isFrozen(refreshed)); assert.ok(Object.isFrozen(refreshed.policy));
  assert.throws(() => assertFreshHeygenSpaceProof(refreshed, {now: NOW}), error => error.code === 'UNVERIFIED_HEYGEN_SPACE_PROOF');
  const text = JSON.stringify(document);
  for (const secret of ['probe-asset', 'synthetic-owner', 'space-fixture', 'https://']) assert.ok(!text.includes(secret));
});

test('review candidates fail closed on broken provider receipt relationships', async t => {
  const mutations = {
    'credential changed': f => { f.files['qualification.json'].credentialKeyFingerprint = '0'.repeat(64); },
    'profile changed': f => { f.files['qualification.json'].usernameDigest = '0'.repeat(64); },
    'upload failure': f => { f.files['upload.json'].status = 500; },
    'wrong fixture': f => { f.files['upload.json'].fixtureSha256 = '0'.repeat(64); },
    'wrong size': f => { f.files['upload.json'].data.size_bytes = 96; },
    'wrong asset': f => { f.files['read.json'].data.id = 'other'; },
    'wrong owner': f => { f.files['read.json'].data.owner = 'other'; },
    'wrong space': f => { f.files['read.json'].data.space_id = 'other'; },
    'delete failure': f => { f.files['delete.json'].status = 500; },
    'delete wrong asset': f => { f.files['delete.json'].data.id = 'other'; },
    'missing absence': f => { f.files['readback.json'].status = 200; },
    'wrong absence reason': f => { f.files['readback.json'].errorCode = 'unauthorized'; },
    'wrong claim': f => { f.files['readback.json'].assetIdSha256 = '0'.repeat(64); },
    'wrong endpoint': f => { f.files['readback.json'].pathTemplate = '/v3/assets/unbounded'; },
    'nonmonotonic': f => { f.files['delete.json'].observedAt = '2026-10-02T15:57:00.000Z'; },
    'slow qualification': f => { f.files['qualification.json'].observedAt = '2026-10-02T15:55:00.000Z'; },
    'future': f => { f.files['readback.json'].observedAt = '2026-10-02T16:01:00.000Z'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => { await assert.rejects(candidate(t, mutate)); });
});

test('reviewed projection cannot change identity, freshness, evidence, or policy', async t => {
  const {origin, document} = await candidate(t);
  for (const [key, value] of [ ['credentialKeyFingerprint','0'.repeat(64)], ['credentialScopeFingerprint','0'.repeat(64)],
    ['providerSpaceFingerprint','0'.repeat(64)], ['canonicalScopeKey','0'.repeat(64)], ['originIdentityDigest','0'.repeat(64)],
    ['originSpaceObservedAt', '2026-10-01T14:59:00.000Z'], ['policy','UNSET'], ['maxAgeSeconds',172800],
    ['freshQualificationMaxAgeSeconds',120], ['expiresAt','2026-10-04T15:58:02.000Z'], ['bundleSha256','0'.repeat(64)] ]) {
    const changed = structuredClone(document); changed.observation[key] = value;
    assert.throws(() => applyHeygenSpaceRefreshForTests(changed, origin, NOW), /failed closed/);
  }
  assert.throws(() => applyHeygenSpaceRefreshForTests(document, origin, document.observation.expiresAt), error => error.code === 'HEYGEN_SPACE_REFRESH_STALE');
  assert.throws(() => applyHeygenSpaceRefreshForTests(document, origin, '2026-10-02T15:58:03.000Z'), error => error.code === 'HEYGEN_SPACE_REFRESH_STALE');
});

test('private candidate preparation rejects missing, extra, linked or invalid raw evidence', async t => {
  for (const mode of ['missing', 'extra', 'link', 'malformed', ...(process.platform !== 'win32' ? ['public-permissions'] : [])]) await t.test(mode, async t => {
    const {origin, files} = fixture(); const path = await directory(t, files);
    if (mode === 'missing') await rm(join(path, 'delete.json'));
    if (mode === 'extra') await writeFile(join(path, 'unexpected.json'), '{}');
    if (mode === 'link') { await rm(join(path, 'delete.json')); await symlink(join(path, 'read.json'), join(path, 'delete.json')); }
    if (mode === 'public-permissions') await chmod(join(path, 'read.json'), 0o644);
    if (mode === 'malformed') await writeFile(join(path, 'delete.json'), '{');
    await assert.rejects(prepareHeygenSpaceRefreshCandidate(path, origin, value => value, {now: NOW}));
  });
});

test('real preparation uses strict qualification validation rather than the test identity extractor', async t => {
  const {files} = fixture(); const path = await directory(t, files);
  await assert.rejects(prepareReviewedHeygenSpaceRefresh(path, {now: NOW}), error => error.code === 'HEYGEN_QUALIFICATION_MISMATCH');
});

test('refresh is staged byte-for-byte for bundled runtime', async t => {
  const root = new URL('..', import.meta.url).pathname;
  const path = await mkdtemp(join(tmpdir(), 'heygen-refresh-stage-')); t.after(() => rm(path, {recursive: true, force: true}));
  assert.ok((await heygenRuntimeFiles(root)).includes('config/heygen-space-refresh.json'));
  await stageHeygenRuntimeFiles(root, path, {bundled: true});
  assert.deepEqual(await readFile(join(root, 'config/heygen-space-refresh.json')), await readFile(join(path, 'runtime-repository/config/heygen-space-refresh.json')));
});

test('review helper suppresses raw file/path errors and rejects caller-selected authority', async () => {
  for (const args of [['--verified','true'], ['--private-evidence-dir', '/missing/private-provider-evidence']]) {
    let output = '', error = '';
    assert.equal(await runRefreshPreparation({args, stdout: {write: value => {output += value;}}, stderr: {write: value => {error += value;}}}), 1);
    assert.equal(output, ''); assert.ok(!error.includes('/missing')); assert.ok(error.includes('No refresh was installed'));
  }
});
