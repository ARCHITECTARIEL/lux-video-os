import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareOpsEvent } from '../lib/ops-log.js';
import { heygenSubmissionIdentity } from '../lib/heygen-provider-safety.js';
import { reconcileUnknownHeygenJobs } from '../services/heygen-reconciliation.js';
const id = heygenSubmissionIdentity('job-qa-leak');
const API_KEY = 'qa-synthetic-heygen-api-key-123456';
const SECRET_TOKEN = 'cursor-SECRET-TOKEN-xyz';
const forbidden = [API_KEY, id.idempotencyKey, SECRET_TOKEN, 'victim@example.com', 'https://', 'http://', 'files.heygen', 'Hostile Title', 'SCRIPT-TEXT'];
function scan(rows) { const s = JSON.stringify(rows); for (const f of forbidden) assert.equal(s.includes(f), false, `leaked ${f}`); return s; }
test('hostile fixtures through the real reconciler -> stored rows leak nothing', async () => {
  const rows = []; const entries = [];
  const opsLogger = async input => { const { entry, row } = prepareOpsEvent(input); rows.push(row); entries.push(entry); };
  const base = { accountId: 'acct', provider: 'heygen', status: 'provider_submit_unknown', correlationId: 'victim@example.com' };
  const jobs = [
    { ...base, id: 'j1', output: { heygenSubmission: { ...id, claimedAt: '2026-10-15T10:00:00Z', script: 'SCRIPT-TEXT' } } },
    { ...base, id: 'j2', output: { heygenSubmission: { ...id, claimedAt: '2026-10-15T11:59:00Z' } } },
    { ...base, id: 'j3', output: { heygenSubmission: { ...id, idempotencyKey: id.idempotencyKey, marker: `${id.marker} victim@example.com`, claimedAt: '2026-10-15T10:00:00Z' } } },
    { ...base, id: 'j4', output: { heygenSubmission: { ...id, claimedAt: '2026-10-15T10:00:00Z' } } },
  ];
  const pagesByJob = {
    j1: [{ data: [{ title: `Hostile Title victim@example.com [${id.marker}]`, id: id.idempotencyKey, status: 'https://evil', video_url: 'https://files.heygen/x.mp4' }], has_more: false }],
    j2: [{ data: [{ title: `Hostile Title [${id.marker}]`, id: 'v_ok', status: 'victim@example.com' }], has_more: true, next_token: SECRET_TOKEN }, { data: [], has_more: false }],
    j4: [{ data: [], has_more: true, next_token: SECRET_TOKEN }, new Error(`boom ${API_KEY} https://api.heygen.com/v3/videos?token=${SECRET_TOKEN}`)],
  };
  // Drive each job with its own synthetic provider response.
  for (const job of jobs) {
    const pages = structuredClone((pagesByJob[job.id] ?? []).map(p => p instanceof Error ? { __err: p.message } : p));
    await reconcileUnknownHeygenJobs({ mode: 'shadow', env: { HEYGEN_API_KEY: API_KEY }, now: () => new Date('2026-10-15T12:00:00Z'),
      listJobs: async () => [job], opsLogger,
      fetchImpl: async () => { const p = pages.shift(); if (!p || p.__err) throw new Error(p?.__err ?? 'none'); return Response.json(p); } });
  }
  // also act mode, with throwing bind to hit the batch catch path
  await reconcileUnknownHeygenJobs({ mode: 'act', env: { HEYGEN_API_KEY: API_KEY }, now: () => new Date('2026-10-15T12:00:00Z'),
    listJobs: async () => [jobs[0]], opsLogger, resolveBinding: async () => { throw new Error(`bind ${API_KEY}`); },
    fetchImpl: async () => Response.json({ data: [{ title: `[${id.marker}]`, id: 'v_ok' }], has_more: false }) });
  assert.ok(rows.length >= 8, `rows ${rows.length}`);
  scan(rows); scan(entries);
  for (const r of rows) {
    if (r.details.marker !== undefined) assert.ok(r.details.marker === null || /^vos-[a-f0-9]{24}$/.test(r.details.marker));
    assert.equal(r.correlationId, null);
  }
});
test('direct hostile details to prepareOpsEvent are coerced or dropped', () => {
  const evil = { mode: API_KEY, ourState: 'victim@example.com', marker: id.idempotencyKey, matchedBy: 'https://x', matchCount: 'x', heygenVideoId: id.idempotencyKey,
    heygenStatus: SECRET_TOKEN, proposedAction: 'https://x', classification: API_KEY, reason: 'victim@example.com', pages: -1, complete: 'true', truncated: 1,
    ageSeconds: 1.5, firstAgeSeconds: 'x', retryCount: Infinity, graceSeconds: -5, apiKey: API_KEY, nextToken: SECRET_TOKEN, url: 'https://x', title: 'Hostile Title', email: 'victim@example.com', idempotencyKey: id.idempotencyKey };
  for (const event of ['heygen.reconciler.shadow_decision', 'heygen.reconciler.act_decision', 'heygen.reconciler.shadow_run']) {
    const { row, entry } = prepareOpsEvent({ event, details: { ...evil, jobsScanned: API_KEY, byProposedAction: { attention: 'x', [API_KEY]: 5 }, durationMs: -1 }, code: `X_${API_KEY}`, message: `m ${API_KEY}` });
    scan([row.details]);
    if (event !== 'heygen.reconciler.shadow_run') assert.deepEqual(Object.keys(row.details).sort(), ['ageSeconds','classification','complete','firstAgeSeconds','graceSeconds','heygenStatus','heygenVideoId','marker','matchCount','matchedBy','mode','ourState','pages','proposedAction','reason','retryCount','truncated'].sort());
    else assert.deepEqual(Object.keys(row.details.byProposedAction).sort(), ['attention','bind_found','hold','release_same_key_retry']);
  }
});
