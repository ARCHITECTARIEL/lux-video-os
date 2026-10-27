import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCurrentCandidateCi, fetchAllCheckRuns, ghApiJson, main, resolveCurrentCandidateCi, checkQuarantinedMarkerFiles, checkQuarantinedRefreshFiles, checkQuarantinedSpaceAuthority, computeAuthorizationResult, outputInventory, fingerprint } from '../tools/authorize-release.mjs';
import { heygenSpaceMarkerAssetIdDigest, reviewHeygenSpaceMarkerForTests } from '../lib/heygen-space-marker.js';

const baseManifest = {
  source: { head: 'abc123', sha256: 'srchash', projectLinkSha256: 'linkhash' },
  output: { sha256: 'outhash' },
  database: { migrationSetSha256: 'm1', schemaSha256: 's1', targetManifestSha256: 't1' },
  remainingReleaseGates: ['OWNER_EXECUTION_AUTHORIZATION', 'PRODUCTION_P0_RECEIPT'],
};
const cleanSource = { head: 'abc123', sha256: 'srchash', projectLinkSha256: 'linkhash', dirty: false };
const passingDb = { ok: true, result: { verified: true, migrationSetSha256: 'm1', schemaSha256: 's1', targetManifestSha256: 't1' } };
const passingBoundary = { verified: true };
const passingCi = { passed: true, detail: { verify: 'success', analyze: 'success' } };

// --- current-candidate CI: GitHub Actions check-runs (REL-PAGING-1027) ---
// All GitHub API traffic below is mocked; no test reaches the network.
const GA = { id: 15368, slug: 'github-actions' };
const CI_SHA = 'abc';
function ciRun(id, name, conclusion = 'success', time = '2026-10-26T00:00:00Z', extra = {}) {
  return { id, name, head_sha: CI_SHA, app: GA, status: 'completed', conclusion, started_at: time, completed_at: time, ...extra };
}
function pendingRun(id, name, status, time = '2026-10-27T00:00:00Z', extra = {}) {
  return { id, name, head_sha: CI_SHA, app: GA, status, conclusion: null, started_at: time, completed_at: null, ...extra };
}
function fillerRuns(count, base = 100_000) {
  return Array.from({ length: count }, (_, i) => ciRun(base + i, `scheduled-${base + i}`, 'success', '2026-10-20T00:00:00Z'));
}
const passingPair = () => [ciRun(1, 'verify'), ciRun(2, 'analyze')];
const check = runs => checkCurrentCandidateCi(runs, { sha: CI_SHA });
const R = { repo: 'o/r', sha: CI_SHA };
const pagePath = (page, sha = CI_SHA) => `repos/o/r/commits/${sha}/check-runs?app_id=15368&filter=all&per_page=100&page=${page}`;

function pagedApi(allRuns, { failOnPage = null, totalCount = () => allRuns.length, pageOverride = null } = {}) {
  const calls = [];
  const api = async path => {
    calls.push(path);
    const url = new URL(path, 'https://api.invalid/');
    const perPage = Math.min(Number(url.searchParams.get('per_page') || 30), 100);
    const page = Number(url.searchParams.get('page') || 1);
    if (failOnPage === page) throw new Error('GitHub API request failed (exit 1).');
    if (pageOverride) { const r = pageOverride(page, perPage); if (r !== undefined) return r; }
    return { total_count: totalCount(page), check_runs: allRuns.slice((page - 1) * perPage, page * perPage) };
  };
  return { api, calls };
}

test('checkCurrentCandidateCi requires every named check to succeed', () => {
  assert.deepEqual(check(passingPair()), { passed: true, detail: { verify: 'success', analyze: 'success' } });
});

test('checkCurrentCandidateCi fails if any required check is missing or not successful', () => {
  assert.equal(check([ciRun(1, 'verify')]).passed, false);
  assert.equal(check([ciRun(1, 'verify', 'failure'), ciRun(2, 'analyze')]).passed, false);
  assert.equal(check([]).passed, false);
  assert.equal(check(undefined).passed, false);
  assert.equal(checkCurrentCandidateCi(passingPair(), { sha: CI_SHA, requiredChecks: [] }).passed, false, 'an empty requirement list must not pass vacuously');
});

// M10: only conclusion 'success' passes; anything else blocks.
for (const conclusion of ['failure', 'neutral', 'skipped', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure', 'SUCCESS', '', null, undefined]) {
  test(`checkCurrentCandidateCi blocks a newest completed verify with conclusion ${JSON.stringify(conclusion)}`, () => {
    const only = check([{ ...ciRun(9, 'verify'), conclusion }, ciRun(2, 'analyze')]);
    assert.equal(only.passed, false);
    assert.equal(only.detail.verify, conclusion ?? null);
    const overOlderSuccess = check([ciRun(1, 'verify', 'success', '2026-10-25T00:00:00Z'), { ...ciRun(9, 'verify', 'success', '2026-10-26T00:00:00Z'), conclusion }, ciRun(2, 'analyze')]);
    assert.equal(overOlderSuccess.passed, false);
  });
}

test('checkCurrentCandidateCi blocks a completed run with no conclusion field at all', () => {
  const { conclusion, ...noConclusion } = ciRun(9, 'verify');
  assert.equal(conclusion, 'success');
  assert.equal(check([noConclusion, ciRun(2, 'analyze')]).passed, false);
});

// M1: newest run per name regardless of status; a newer non-completed run blocks.
for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
  test(`checkCurrentCandidateCi blocks when the newest verify run is ${status}`, () => {
    const runs = [pendingRun(9, 'verify', status), ciRun(5, 'verify', 'success', '2026-10-26T00:00:00Z'), ciRun(2, 'analyze')];
    assert.deepEqual(check(runs), { passed: false, detail: { verify: `pending:${status}`, analyze: 'success' } });
    assert.equal(check([...runs].reverse()).passed, false, 'input order must not matter');
  });
}

test('checkCurrentCandidateCi uses the newest run when a check name repeats', () => {
  // Failed, then re-run passed: passes.
  assert.equal(check([ciRun(1, 'verify', 'failure', '2026-10-25T10:00:00Z'), ciRun(5, 'verify', 'success', '2026-10-26T10:00:00Z'), ciRun(2, 'analyze')]).passed, true);
  // Passed, then re-run failed: blocks.
  assert.deepEqual(check([ciRun(9, 'verify', 'failure', '2026-10-27T10:00:00Z'), ciRun(5, 'verify', 'success', '2026-10-26T10:00:00Z'), ciRun(2, 'analyze')]).detail.verify, 'failure');
  // Passed, then a re-run is in progress: blocks (old behavior ignored the in-progress run and passed).
  assert.equal(check([ciRun(5, 'verify', 'success', '2026-10-26T10:00:00Z'), pendingRun(6, 'verify', 'in_progress', '2026-10-26T11:00:00Z'), ciRun(2, 'analyze')]).passed, false);
  // An older pending run does not block a newer completed success.
  assert.equal(check([pendingRun(4, 'verify', 'queued', '2026-10-25T00:00:00Z'), ciRun(5, 'verify', 'success', '2026-10-26T10:00:00Z'), ciRun(2, 'analyze')]).passed, true);
});

test('checkCurrentCandidateCi orders by run id first (R2-L1); a higher id wins even with an older timestamp', () => {
  // Higher id but older completed_at still wins (time-first ordering would pass here).
  for (const order of [x => x, x => [...x].reverse()]) {
    assert.equal(check(order([ciRun(9, 'verify', 'failure', '2026-10-25T00:00:00Z'), ciRun(5, 'verify', 'success', '2026-10-26T00:00:00Z'), ciRun(2, 'analyze')])).detail.verify, 'failure');
    assert.equal(check(order([ciRun(9, 'verify', 'success', '2026-10-25T00:00:00Z'), ciRun(5, 'verify', 'failure', '2026-10-26T00:00:00Z'), ciRun(2, 'analyze')])).passed, true);
  }
  // Same time: higher id wins, in either input order.
  const tie = [ciRun(7, 'verify', 'success'), ciRun(8, 'verify', 'cancelled'), ciRun(2, 'analyze')];
  assert.equal(check(tie).detail.verify, 'cancelled');
  assert.equal(check([...tie].reverse()).detail.verify, 'cancelled');
  // An older-id pending run that started later does not outrank a newer-id completed run.
  assert.equal(check([ciRun(5, 'verify', 'success', '2026-10-26T00:00:00Z'), pendingRun(3, 'verify', 'queued', '2026-10-26T00:00:01Z'), ciRun(2, 'analyze')]).passed, true);
});

test('N-ORD4: a newer (higher id) in-progress run that started before the older success finished still blocks', () => {
  const runs = [
    ciRun(5, 'verify', 'success', '2026-10-26T10:00:00Z', { completed_at: '2026-10-26T10:30:00Z' }),
    pendingRun(9, 'verify', 'in_progress', '2026-10-26T10:10:00Z'),
    ciRun(2, 'analyze'),
  ];
  assert.deepEqual(check(runs), { passed: false, detail: { verify: 'pending:in_progress', analyze: 'success' } });
  assert.equal(check([...runs].reverse()).passed, false);
});

test('N-ORD5: a newer run that started later and failed before the older success finished still wins and blocks', () => {
  const runs = [
    ciRun(5, 'verify', 'success', '2026-10-26T10:00:00Z', { completed_at: '2026-10-26T10:40:00Z' }),
    ciRun(9, 'verify', 'failure', '2026-10-26T10:20:00Z', { completed_at: '2026-10-26T10:25:00Z' }),
    ciRun(2, 'analyze'),
  ];
  assert.deepEqual(check(runs), { passed: false, detail: { verify: 'failure', analyze: 'success' } });
  assert.equal(check([...runs].reverse()).passed, false);
});

test('timestamps break the tie only when ids are equal or unusable', () => {
  const noId = (run) => { const { id, ...rest } = run; return rest; };
  // No ids: later completed_at wins, then started_at for a pending run.
  assert.equal(check([noId(ciRun(1, 'verify', 'success', '2026-10-25T00:00:00Z')), noId(ciRun(2, 'verify', 'failure', '2026-10-26T00:00:00Z')), ciRun(3, 'analyze')]).detail.verify, 'failure');
  assert.equal(check([noId(ciRun(1, 'verify', 'failure', '2026-10-25T00:00:00Z')), noId(ciRun(2, 'verify', 'success', '2026-10-26T00:00:00Z')), ciRun(3, 'analyze')]).passed, true);
  assert.equal(check([noId(ciRun(1, 'verify', 'success', '2026-10-25T00:00:00Z')), noId(pendingRun(2, 'verify', 'queued', '2026-10-26T00:00:00Z')), ciRun(3, 'analyze')]).detail.verify, 'pending:queued');
  // Equal ids: later time wins.
  assert.equal(check([ciRun(4, 'verify', 'success', '2026-10-25T00:00:00Z'), ciRun(4, 'verify', 'failure', '2026-10-26T00:00:00Z'), ciRun(3, 'analyze')]).detail.verify, 'failure');
});

test('the check-runs query asks for filter=all so in-progress re-runs are returned (R2-L2)', async () => {
  const { api, calls } = pagedApi(passingPair());
  await fetchAllCheckRuns({ ...R, ghApi: api });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0], 'https://api.invalid/');
  assert.equal(url.pathname, '/repos/o/r/commits/abc/check-runs');
  assert.equal(url.searchParams.get('filter'), 'all');
  assert.equal(url.searchParams.get('app_id'), '15368');
  assert.equal(url.searchParams.get('per_page'), '100');
  assert.equal(url.searchParams.get('page'), '1');
});

test('head_sha must match the candidate sha exactly: no case-insensitive or prefix match (X4/X5)', async () => {
  const full = '0123456789abcdef0123456789abcdef01234567';
  const forSha = (head) => passingPair().map(run => ({ ...run, head_sha: head }));
  assert.equal(checkCurrentCandidateCi(forSha(full), { sha: full }).passed, true);
  const variants = [full.toUpperCase(), full.slice(0, 7), full.slice(0, 12), `${full}0`];
  for (const candidate of variants) {
    // Runs carry the real sha; the candidate is a case/prefix variant.
    assert.equal(checkCurrentCandidateCi(forSha(full), { sha: candidate }).passed, false, `candidate ${candidate}`);
    const viaFetch = await resolveCurrentCandidateCi({ repo: 'o/r', sha: candidate, ghApi: async () => ({ total_count: 2, check_runs: forSha(full) }) });
    assert.equal(viaFetch.passed, false, `candidate ${candidate}`);
    assert.match(viaFetch.error, /not for the candidate commit/);
    // The candidate is the real sha; runs carry a case/prefix variant.
    assert.equal(checkCurrentCandidateCi(forSha(candidate), { sha: full }).passed, false, `head_sha ${candidate}`);
    const viaFetch2 = await resolveCurrentCandidateCi({ repo: 'o/r', sha: full, ghApi: async () => ({ total_count: 2, check_runs: forSha(candidate) }) });
    assert.equal(viaFetch2.passed, false, `head_sha ${candidate}`);
    assert.match(viaFetch2.error, /not for the candidate commit/);
  }
});

test('de-duplication keeps the first copy of an id, not a later one with different content (X6)', async () => {
  const p1 = [ciRun(1, 'verify', 'failure'), ...fillerRuns(98), ciRun(2, 'analyze')];
  const p2 = [ciRun(1, 'verify', 'success'), ciRun(3000, 'late')];
  const ghApi = async path => (new URL(path, 'https://x/').searchParams.get('page') === '1' ? { total_count: 101, check_runs: p1 } : { total_count: 101, check_runs: p2 });
  const fetched = await fetchAllCheckRuns({ ...R, ghApi });
  assert.equal(fetched.checkRuns.find(run => run.id === 1).conclusion, 'failure');
  assert.deepEqual(await resolveCurrentCandidateCi({ ...R, ghApi }), { passed: false, detail: { verify: 'failure', analyze: 'success' } });
});

test('checkCurrentCandidateCi blocks on a non-completed run that cannot be ordered (no timestamps, or no status)', () => {
  const untimed = { ...pendingRun(3, 'verify', 'queued'), started_at: null };
  assert.equal(check([ciRun(5, 'verify'), untimed, ciRun(2, 'analyze')]).detail.verify, 'pending:queued');
  const { status, ...noStatus } = ciRun(9, 'verify', 'success', '2026-10-27T00:00:00Z');
  assert.equal(status, 'completed');
  assert.equal(check([ciRun(5, 'verify'), noStatus, ciRun(2, 'analyze')]).detail.verify, 'pending:unknown');
});

test('checkCurrentCandidateCi trusts status over conclusion (M7b): an in-progress run carrying conclusion success blocks', () => {
  const runs = [ciRun(5, 'verify', 'success', '2026-10-26T00:00:00Z'), { ...pendingRun(9, 'verify', 'in_progress'), conclusion: 'success' }, ciRun(2, 'analyze')];
  assert.equal(check(runs).passed, false);
});

test('checkCurrentCandidateCi ignores runs without a usable name', () => {
  assert.equal(check([{ ...ciRun(1, 'verify'), name: undefined }, ciRun(2, 'analyze')]).passed, false);
});

// M2: GitHub Actions only.
test('a same-named success from another app cannot override a GitHub Actions failure', async () => {
  const runs = [
    ciRun(5, 'verify', 'failure', '2026-10-26T00:00:00Z'),
    ciRun(6, 'verify', 'success', '2026-10-26T01:00:00Z', { app: { id: 999, slug: 'some-other-app' } }),
    ciRun(2, 'analyze'),
  ];
  assert.deepEqual(check(runs), { passed: false, detail: { verify: 'failure', analyze: 'success' } });
  const result = await resolveCurrentCandidateCi({ ...R, ghApi: pagedApi(runs).api });
  assert.equal(result.passed, false);
  assert.match(result.error, /not from GitHub Actions/);
});

test('a run with no app field (or an empty or contradictory app) is rejected', async () => {
  const { app, ...noApp } = ciRun(1, 'verify');
  assert.deepEqual(app, GA);
  for (const bad of [noApp, { ...noApp, app: null }, { ...noApp, app: {} }, { ...noApp, app: { id: 15368, slug: 'imposter' } }, { ...noApp, app: { id: 999, slug: 'github-actions' } }, { ...noApp, app: { id: '15368' } }]) {
    assert.equal(check([bad, ciRun(2, 'analyze')]).detail.verify, null, JSON.stringify(bad.app));
    const result = await resolveCurrentCandidateCi({ ...R, ghApi: pagedApi([bad, ciRun(2, 'analyze')]).api });
    assert.equal(result.passed, false);
    assert.equal(result.detail, null);
    assert.match(result.error, /not from GitHub Actions/);
  }
  // Either matching field alone is accepted.
  assert.equal(check([{ ...noApp, app: { slug: 'github-actions' } }, ciRun(2, 'analyze', 'success', undefined, { app: { id: 15368 } })]).passed, true);
});

// head_sha re-check.
test('runs for a different commit are rejected, and a missing sha fails closed', async () => {
  const otherSha = passingPair().map(run => ({ ...run, head_sha: 'def' }));
  assert.equal(check(otherSha).passed, false);
  const missing = passingPair().map(({ head_sha: _ignored, ...run }) => run);
  assert.equal(check(missing).passed, false);
  for (const runs of [otherSha, missing]) {
    const result = await resolveCurrentCandidateCi({ ...R, ghApi: pagedApi(runs).api });
    assert.equal(result.passed, false);
    assert.match(result.error, /not for the candidate commit/);
  }
  assert.equal(checkCurrentCandidateCi(passingPair()).passed, false, 'no sha means nothing is eligible');
  assert.equal(checkCurrentCandidateCi(passingPair(), { sha: '' }).passed, false);
  assert.equal(checkCurrentCandidateCi(missing).passed, false, 'a missing head_sha never matches a missing sha');
  assert.equal(checkCurrentCandidateCi(passingPair().map(run => ({ ...run, head_sha: '' })), { sha: '' }).passed, false, 'an empty sha never matches');
});

// M17: repo/sha guard.
test('resolveCurrentCandidateCi fails closed without calling GitHub when repo or sha is missing', async () => {
  for (const args of [{ repo: 'o/r', sha: '' }, { repo: 'o/r', sha: undefined }, { repo: 'o/r', sha: null }, { repo: '', sha: CI_SHA }, { repo: undefined, sha: CI_SHA }]) {
    let calls = 0;
    const ghApi = async () => { calls += 1; return { total_count: 2, check_runs: passingPair() }; };
    const result = await resolveCurrentCandidateCi({ ...args, ghApi });
    assert.equal(result.passed, false, JSON.stringify(args));
    assert.match(result.error, /requires repo and sha/);
    assert.equal(calls, 0);
  }
});

// Pagination.
test('fetchAllCheckRuns queries Actions-only runs at per_page=100 and finds verify on page 2', async () => {
  const runs = [...fillerRuns(100), ...passingPair()];
  const { api, calls } = pagedApi(runs);
  const fetched = await fetchAllCheckRuns({ ...R, ghApi: api });
  assert.equal(fetched.checkRuns.length, 102);
  assert.equal(fetched.pages, 2);
  assert.deepEqual(calls, [pagePath(1), pagePath(2)]);
  assert.equal(check(runs.slice(0, 100)).passed, false, 'the first page alone (old behavior) misses verify');
  assert.deepEqual(await resolveCurrentCandidateCi({ ...R, ghApi: api }), { passed: true, detail: { verify: 'success', analyze: 'success' } });
});

test('fetchAllCheckRuns follows more than 100 runs across pages and stops exactly at total_count', async () => {
  for (const [count, pages] of [[252, 3], [200, 2], [150, 2], [2000, 20]]) {
    const runs = [...fillerRuns(count - 2), ...passingPair()];
    const { api, calls } = pagedApi(runs);
    const fetched = await fetchAllCheckRuns({ ...R, ghApi: api });
    assert.equal(fetched.checkRuns.length, count);
    assert.equal(calls.length, pages, `${count} runs`);
    assert.equal(check(fetched.checkRuns).passed, true);
  }
});

test('fetchAllCheckRuns reads the final page even when only one run is missing (M8e)', async () => {
  // 101 runs: page 1 already has passing verify+analyze; the 101st run is a newer verify failure.
  const runs = [...passingPair(), ...fillerRuns(98), ciRun(77, 'verify', 'failure', '2026-10-27T00:00:00Z')];
  const { api, calls } = pagedApi(runs);
  const result = await resolveCurrentCandidateCi({ ...R, ghApi: api });
  assert.equal(calls.length, 2);
  assert.deepEqual(result, { passed: false, detail: { verify: 'failure', analyze: 'success' } });
});

test('fetchAllCheckRuns fails closed when the page cap is hit before total_count', async () => {
  const runs = [...passingPair(), ...fillerRuns(1999)];
  const { api, calls } = pagedApi(runs);
  const result = await resolveCurrentCandidateCi({ ...R, ghApi: api });
  assert.equal(result.passed, false);
  assert.equal(result.detail, null);
  assert.match(result.error, /page cap/);
  assert.equal(calls.length, 20);
  const small = [...fillerRuns(99), ...passingPair()];
  assert.equal((await resolveCurrentCandidateCi({ ...R, ghApi: pagedApi(small).api, maxPages: 1 })).passed, false);
  assert.equal((await resolveCurrentCandidateCi({ ...R, ghApi: pagedApi(small).api, maxPages: 2 })).passed, true);
});

test('fetchAllCheckRuns fails closed when pages end before total_count', async () => {
  const { api } = pagedApi(passingPair(), { totalCount: () => 5 });
  await assert.rejects(fetchAllCheckRuns({ ...R, ghApi: api }), /ended early/);
  const runs = [...passingPair(), ...fillerRuns(148)];
  const short = pagedApi(runs, { pageOverride: p => ({ total_count: 150, check_runs: p === 1 ? runs.slice(0, 60) : p === 2 ? runs.slice(60, 100) : [] }) });
  const result = await resolveCurrentCandidateCi({ ...R, ghApi: short.api });
  assert.equal(result.passed, false);
  assert.match(result.error, /ended early/);
});

test('fetchAllCheckRuns accepts total_count 0 as an empty, failing (not erroring) result', async () => {
  const result = await resolveCurrentCandidateCi({ ...R, ghApi: pagedApi([]).api });
  assert.deepEqual(result, { passed: false, detail: { verify: null, analyze: null } });
});

// L1 / M9: total_count must not change between pages.
test('fetchAllCheckRuns fails closed when total_count changes between pages (M9)', async () => {
  const runs = [...passingPair(), ...fillerRuns(148)];
  // Shrinking total on the last page would let a last-page total pass; it must not.
  for (const second of [101, 140, 151]) {
    const { api } = pagedApi(runs, { totalCount: page => (page === 1 ? 150 : second) });
    const result = await resolveCurrentCandidateCi({ ...R, ghApi: api });
    assert.equal(result.passed, false, `page 2 total ${second}`);
    assert.equal(result.detail, null);
    assert.match(result.error, /total_count changed/);
  }
});

// L1: de-duplicate by id across pages.
test('fetchAllCheckRuns de-duplicates by id across pages', async () => {
  const runs = [...fillerRuns(100), ...passingPair()];
  const page2 = [runs[99], runs[100], runs[101]];
  const { api } = pagedApi(runs, { pageOverride: p => (p === 2 ? { total_count: 102, check_runs: page2 } : undefined), totalCount: () => 102 });
  const fetched = await fetchAllCheckRuns({ ...R, ghApi: api });
  assert.equal(fetched.checkRuns.length, 102);
  assert.equal(new Set(fetched.checkRuns.map(run => run.id)).size, 102);
});

test('duplicate ids cannot stand in for unread runs (a shifted page hides a newer failure)', async () => {
  const p1 = [ciRun(1, 'verify', 'success', '2026-10-20T00:00:00Z'), ...fillerRuns(98), ciRun(2, 'analyze')];
  const p2 = [p1[99], ...fillerRuns(99, 200_000)];
  const p3 = [ciRun(77, 'verify', 'failure', '2026-10-27T00:00:00Z')];
  const pages = { 1: p1, 2: p2, 3: p3 };
  const ghApi = async path => ({ total_count: 200, check_runs: pages[Number(new URL(path, 'https://x/').searchParams.get('page'))] || [] });
  const result = await resolveCurrentCandidateCi({ ...R, ghApi });
  assert.deepEqual(result.detail, { verify: 'failure', analyze: 'success' });
  assert.equal(result.passed, false);
});

test('a server that ignores page= (repeats page 1) is not accepted as complete', async () => {
  const p1 = [...passingPair(), ...fillerRuns(98)];
  const result = await resolveCurrentCandidateCi({ ...R, ghApi: async () => ({ total_count: 200, check_runs: p1 }) });
  assert.equal(result.passed, false);
  assert.match(result.error, /ended early/);
});

test('fetchAllCheckRuns fails closed when unique runs exceed total_count', async () => {
  const result = await resolveCurrentCandidateCi({ ...R, ghApi: async () => ({ total_count: 1, check_runs: passingPair() }) });
  assert.equal(result.passed, false);
  assert.match(result.error, /more unique runs/);
});

// Errors and malformed responses.
test('resolveCurrentCandidateCi fails closed on an API error on any page, even after page 1 passed', async () => {
  const runs = [...passingPair(), ...fillerRuns(100)];
  for (const failOnPage of [1, 2]) {
    const result = await resolveCurrentCandidateCi({ ...R, ghApi: pagedApi(runs, { failOnPage }).api });
    assert.equal(result.passed, false);
    assert.equal(result.detail, null);
    assert.match(result.error, /GitHub API request failed/);
  }
  const nonError = await resolveCurrentCandidateCi({ ...R, ghApi: async () => { throw 'boom'; } });
  assert.equal(nonError.passed, false);
  assert.equal(nonError.error, 'check-runs lookup failed');
});

test('resolveCurrentCandidateCi fails closed on a malformed page (M5c: negative total_count included)', async () => {
  for (const body of [null, {}, { total_count: 2 }, { check_runs: [] }, { total_count: '2', check_runs: passingPair() }, { total_count: 1.5, check_runs: [] }, { total_count: -1, check_runs: passingPair() }, { total_count: -1, check_runs: [] }, { total_count: 2, check_runs: {} }]) {
    const result = await resolveCurrentCandidateCi({ ...R, ghApi: async () => body });
    assert.equal(result.passed, false, JSON.stringify(body));
    assert.match(result.error, /Malformed check-runs response/);
  }
  const runs = [...passingPair(), ...fillerRuns(150)];
  const { api } = pagedApi(runs, { pageOverride: p => (p === 2 ? { total_count: -1, check_runs: [] } : undefined) });
  assert.match((await resolveCurrentCandidateCi({ ...R, ghApi: api })).error, /Malformed check-runs response on page 2/);
});

test('resolveCurrentCandidateCi fails closed on a malformed run', async () => {
  for (const bad of [null, 'verify', { ...ciRun(1, 'verify'), id: undefined }, { ...ciRun(1, 'verify'), id: '1' }]) {
    const result = await resolveCurrentCandidateCi({ ...R, ghApi: async () => ({ total_count: 2, check_runs: [bad, ciRun(2, 'analyze')] }) });
    assert.equal(result.passed, false);
    assert.match(result.error, /Malformed check-run on page 1/);
  }
});

test('ghApiJson throws on a non-zero gh exit, spawn error, signal or non-JSON output without echoing stderr', () => {
  assert.throws(() => ghApiJson('x', { spawn: () => ({ status: 1, stdout: '', stderr: 'secret-ish detail' }) }), err => /exit 1/.test(err.message) && !/secret-ish/.test(err.message));
  assert.throws(() => ghApiJson('x', { spawn: () => ({ status: null, error: new Error('ENOENT') }) }), /exit none/);
  assert.throws(() => ghApiJson('x', { spawn: () => ({ status: null, signal: 'SIGTERM', stdout: '{}' }) }), /failed/);
  assert.throws(() => ghApiJson('x', { spawn: () => ({ status: 0, error: new Error('ENOBUFS'), stdout: '{}' }) }), /failed/);
  assert.throws(() => ghApiJson('x', { spawn: () => ({ status: 0, stdout: 'not json' }) }), /non-JSON/);
  assert.throws(() => ghApiJson('x', { spawn: () => ({ status: 0, stdout: '' }) }), /non-JSON/);
  const calls = [];
  assert.deepEqual(ghApiJson(pagePath(1), { spawn: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '{"total_count":0,"check_runs":[]}' }; } }), { total_count: 0, check_runs: [] });
  assert.deepEqual(calls, [['gh', 'api', pagePath(1)]]);
});

// M18/M19: main() wiring, driven end to end with injected dependencies.
async function runMain({ checkRuns, ghApiError = null, head = 'f'.repeat(40) } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'authorize-release-main-'));
  try {
    const output = join(dir, 'quarantine');
    await mkdir(output);
    const dbResult = { verified: true, migrationSetSha256: 'm1', schemaSha256: 's1', targetManifestSha256: 't1' };
    const manifest = {
      target: 'production',
      source: { head, sha256: 'srchash', projectLinkSha256: 'linkhash' },
      output: { location: output, sha256: fingerprint([]) },
      database: { migrationSetSha256: 'm1', schemaSha256: 's1', targetManifestSha256: 't1' },
      remainingReleaseGates: ['OWNER_EXECUTION_AUTHORIZATION'],
    };
    const manifestPath = join(dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const ghCalls = [];
    const restored = [];
    const errors = [];
    const exitCodes = [];
    const runsForHead = (checkRuns ?? passingPair()).map(run => ({ head_sha: head, ...run, ...(run.head_sha === CI_SHA ? { head_sha: head } : {}) }));
    const result = await main({
      argv: ['node', 'authorize-release.mjs', '--manifest', manifestPath, '--repo', 'o/r', '--owner-authorized'],
      root: dir,
      deps: {
        captureSource: async () => ({ head, sha256: 'srchash', projectLinkSha256: 'linkhash', dirty: false }),
        inventory: async () => [],
        workflowBoundaryCheck: async () => ({ verified: true }),
        runMigrationCheck: () => ({ status: 0, stdout: `${JSON.stringify(dbResult)}\n` }),
        ghApi: async path => {
          ghCalls.push(path);
          if (ghApiError) throw ghApiError;
          return { total_count: runsForHead.length, check_runs: runsForHead };
        },
        spaceAuthorityCheck: async () => ({ verified: true }),
        restoreOutput: async (from, to) => { restored.push([from, to]); },
        log: () => {},
        logError: message => errors.push(message),
        setExitCode: code => exitCodes.push(code),
      },
    });
    return { result, ghCalls, restored, errors, exitCodes, head };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('main() queries the pinned candidate head and authorizes only on a passing Actions CI (M18)', async () => {
  const run = await runMain();
  assert.deepEqual(run.ghCalls, [`repos/o/r/commits/${run.head}/check-runs?app_id=15368&filter=all&per_page=100&page=1`]);
  assert.equal(run.result.automatableChecks.currentCandidateCiPassed, true);
  assert.deepEqual(run.result.ciDetail, { verify: 'success', analyze: 'success' });
  assert.equal(run.result.routineDeployAuthorized, true);
  assert.equal(run.restored.length, 1);
  assert.deepEqual(run.exitCodes, []);
});

test('main() blocks the deploy when the candidate CI failed or is pending (M19)', async () => {
  for (const checkRuns of [[ciRun(1, 'verify', 'failure'), ciRun(2, 'analyze')], [pendingRun(1, 'verify', 'in_progress'), ciRun(2, 'analyze')]]) {
    const run = await runMain({ checkRuns });
    assert.equal(run.ghCalls.length, 1);
    assert.equal(run.result.automatableChecks.currentCandidateCiPassed, false);
    assert.notEqual(run.result.ciDetail.verify, 'success');
    assert.equal(run.result.routineDeployAuthorized, false);
    assert.deepEqual(run.restored, []);
    assert.deepEqual(run.exitCodes, [1]);
  }
});

test('main() fails closed when check-runs belong to another commit or the API errors', async () => {
  const otherCommit = await runMain({ checkRuns: passingPair().map(run => ({ ...run, head_sha: 'e'.repeat(40) })) });
  assert.equal(otherCommit.result.automatableChecks.currentCandidateCiPassed, false);
  assert.equal(otherCommit.result.ciDetail, null);
  assert.ok(otherCommit.errors.some(message => /failed closed: .*not for the candidate commit/.test(message)));
  assert.deepEqual(otherCommit.exitCodes, [1]);
  const apiError = await runMain({ ghApiError: new Error('GitHub API request failed (exit 1).') });
  assert.equal(apiError.result.automatableChecks.currentCandidateCiPassed, false);
  assert.ok(apiError.errors.some(message => /failed closed: GitHub API request failed/.test(message)));
  assert.deepEqual(apiError.restored, []);
  assert.deepEqual(apiError.exitCodes, [1]);
});

test('computeAuthorizationResult authorizes a routine deploy only when every automatable check passes and the owner flag is set', () => {
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableGatesCleared, true);
  assert.equal(result.routineDeployAuthorized, true);
  assert.equal(result.releaseAuthorized, false, 'must never claim full release authorization');
  assert.deepEqual(result.outstandingLaunchGates, baseManifest.remainingReleaseGates);
});

test('computeAuthorizationResult withholds routine deploy without the explicit owner flag, even if every check passes', () => {
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: false,
  });
  assert.equal(result.automatableGatesCleared, true);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when source changed since packaging', () => {
  const driftedSource = { ...cleanSource, head: 'different-head' };
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: driftedSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.sourceUnchangedSincePackaging, false);
  assert.equal(result.automatableGatesCleared, false);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when the working tree is dirty', () => {
  const dirtySource = { ...cleanSource, dirty: true };
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: dirtySource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.sourceClean, false);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when the quarantined output fingerprint no longer matches', () => {
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'tampered-hash',
    freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.outputIntegrityIntact, false);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when the fresh production DB check does not verify', () => {
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: { ok: false, result: null }, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.databaseVerifiedNow, false);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when the DB identity drifted since packaging despite verifying now', () => {
  const driftedDb = { ok: true, result: { verified: true, migrationSetSha256: 'DIFFERENT', schemaSha256: 's1', targetManifestSha256: 't1' } };
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: driftedDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.databaseVerifiedNow, true);
  assert.equal(result.automatableChecks.databaseUnchangedSincePackaging, false);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when the Workflow sandbox boundary is unverified', () => {
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: passingDb, workflowBoundary: { verified: false }, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.workflowBoundaryVerifiedNow, false);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when current-candidate CI has not passed', () => {
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: { passed: false, detail: { verify: 'pending', analyze: null } }, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.currentCandidateCiPassed, false);
  assert.equal(result.routineDeployAuthorized, false);
  assert.deepEqual(result.ciDetail, { verify: 'pending', analyze: null });
});

test('outputInventory records path/bytes/sha256 in that exact key order, matching release-build-manifest.mjs -- regression for a silent fingerprint mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'authorize-release-inventory-'));
  try {
    await writeFile(join(dir, 'a.txt'), 'hello');
    const sub = join(dir, 'nested');
    await import('node:fs/promises').then(fs => fs.mkdir(sub));
    await writeFile(join(sub, 'b.txt'), 'world');
    const records = await outputInventory(dir);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.deepEqual(Object.keys(record), ['path', 'bytes', 'sha256'], 'record key order must match release-build-manifest.mjs exactly, or fingerprint() silently diverges even when every value is identical');
    }
    assert.equal(records[0].path, 'a.txt');
    assert.equal(records[0].bytes, 5);
    assert.equal(records[1].path, 'nested/b.txt');
    // fingerprint() must be a pure function of the exact record shape.
    assert.equal(fingerprint(records), fingerprint(await outputInventory(dir)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('computeAuthorizationResult never reports releaseAuthorized true under any input', () => {
  for (const ownerAuthorized of [true, false]) {
    const result = computeAuthorizationResult({
      manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
      freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized,
    });
    assert.equal(result.releaseAuthorized, false);
  }
});

test('production authorization requires an artifact-bound refresh with six hours remaining', async () => {
  const candidate = await mkdtemp(join(tmpdir(), 'authorize-refresh-'));
  const paths = [
    'functions/api/video-os-lite/workspace.func/config/heygen-space-refresh.json',
    'functions/.well-known/workflow/v1/step.func/runtime-repository/config/heygen-space-refresh.json',
  ];
  try {
    const source = await readFile(join(process.cwd(), 'config/heygen-space-refresh.json'));
    const refresh = JSON.parse(source);
    const now = new Date(Date.parse(refresh.observation.completedAt) + 1000);
    for (const path of paths) {
      await mkdir(join(candidate, path, '..'), { recursive: true });
      await writeFile(join(candidate, path), source);
    }
    const valid = await checkQuarantinedRefreshFiles(process.cwd(), candidate, { now });
    assert.equal(valid.verified, true);
    assert.equal(computeAuthorizationResult({ manifest: { ...baseManifest, target: 'production' },
      currentSource: cleanSource, liveOutputSha256: 'outhash', freshDatabaseCheck: passingDb,
      workflowBoundary: passingBoundary, ciResult: passingCi, refreshCheck: valid, ownerAuthorized: true,
    }).routineDeployAuthorized, true);
    const late = await checkQuarantinedRefreshFiles(process.cwd(), candidate, {
      now: new Date(Date.parse(refresh.observation.expiresAt) - 6 * 60 * 60 * 1000 + 1),
    });
    assert.equal(late.verified, false);
    await writeFile(join(candidate, paths[0]), '{}');
    assert.equal((await checkQuarantinedRefreshFiles(process.cwd(), candidate, { now })).verified, false);
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
});

test('retained marker authorization binds both packaged copies and the private asset ID', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'authorize-marker-source-'));
  const candidate = await mkdtemp(join(tmpdir(), 'authorize-marker-output-'));
  const assetId = 'synthetic-marker-id';
  const origin = {
    fixtureSha256: '1'.repeat(64), credentialKeyFingerprint: '2'.repeat(64),
    credentialScopeFingerprint: '3'.repeat(64), keyIdDigest: '4'.repeat(64),
    keyCreatedAt: '2026-10-01T14:35:48.000Z', usernameDigest: '5'.repeat(64),
    providerSpaceFingerprint: '6'.repeat(64), canonicalScopeKey: '7'.repeat(64),
    identityDigest: '8'.repeat(64), spaceObservedAt: '2026-10-01T15:11:53.953Z',
  };
  const document = { version: 'heygen-space-marker/v1', marker: {
    assetIdDigest: heygenSpaceMarkerAssetIdDigest(assetId), fixtureSha256: origin.fixtureSha256,
    expectedType: 'image', uploadedAt: 1_792_400_000,
    credentialKeyFingerprint: origin.credentialKeyFingerprint,
    credentialScopeFingerprint: origin.credentialScopeFingerprint,
    keyIdDigest: origin.keyIdDigest, keyCreatedAt: origin.keyCreatedAt,
    usernameDigest: origin.usernameDigest, providerSpaceFingerprint: origin.providerSpaceFingerprint,
    canonicalScopeKey: origin.canonicalScopeKey, originIdentityDigest: origin.identityDigest,
    originSpaceObservedAt: origin.spaceObservedAt,
    uploadReceiptSha256: '9'.repeat(64), readReceiptSha256: 'a'.repeat(64),
  } };
  const manifest = reviewHeygenSpaceMarkerForTests(document, origin);
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  const paths = [
    'functions/api/video-os-lite/workspace.func/config/heygen-space-marker.json',
    'functions/.well-known/workflow/v1/step.func/runtime-repository/config/heygen-space-marker.json',
  ];
  try {
    await mkdir(join(sourceRoot, 'config'));
    await writeFile(join(sourceRoot, 'config/heygen-space-marker.json'), bytes);
    for (const path of paths) {
      await mkdir(join(candidate, path, '..'), { recursive: true });
      await writeFile(join(candidate, path), bytes);
    }
    assert.deepEqual(await checkQuarantinedMarkerFiles(sourceRoot, candidate, manifest, { HEYGEN_SPACE_MARKER_ASSET_ID: assetId }),
      { verified: true, mode: 'retained-marker' });
    assert.equal((await checkQuarantinedMarkerFiles(sourceRoot, candidate, manifest, { HEYGEN_SPACE_MARKER_ASSET_ID: 'other-id' })).verified, false);
    await writeFile(join(candidate, paths[0]), '{}');
    assert.equal((await checkQuarantinedMarkerFiles(sourceRoot, candidate, manifest, { HEYGEN_SPACE_MARKER_ASSET_ID: assetId })).verified, false);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(candidate, { recursive: true, force: true });
  }
});

test('active source marker never falls back to packaged static refresh evidence', async () => {
  const candidate = await mkdtemp(join(tmpdir(), 'authorize-marker-no-fallback-'));
  try {
    const refresh = await readFile(join(process.cwd(), 'config/heygen-space-refresh.json'));
    const paths = [
      'functions/api/video-os-lite/workspace.func/config/heygen-space-refresh.json',
      'functions/.well-known/workflow/v1/step.func/runtime-repository/config/heygen-space-refresh.json',
    ];
    for (const path of paths) {
      await mkdir(join(candidate, path, '..'), { recursive: true });
      await writeFile(join(candidate, path), refresh);
    }
    const now = new Date(Date.parse(JSON.parse(refresh).observation.completedAt) + 1000);
    assert.equal((await checkQuarantinedRefreshFiles(process.cwd(), candidate, { now })).verified, true);
    assert.equal((await checkQuarantinedSpaceAuthority(process.cwd(), candidate, { now })).verified, false);
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
});
