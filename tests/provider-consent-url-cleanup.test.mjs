import assert from 'node:assert/strict';
import test from 'node:test';
import { sweepExpiredHostedConsentUrls } from '../lib/provider-consent-url-cleanup.js';

const now = Date.parse('2026-10-07T18:00:00.000Z');
const candidate = {
  issuedEventId: 'event-1', accountId: 'account-1', operationId: 'operation-1',
  path: 'video-os/auth/provider-consent/' + 'a'.repeat(64) + '.json',
  expiresAt: new Date(now - 1).toISOString(),
};

test('expired hosted links are dry-run by default and deleted only with execution', async () => {
  const actions = [];
  const deps = {
    listCandidates: async () => [candidate],
    purgeUrl: async (input) => { actions.push(['delete', input.operationId]); return true; },
    recordCleanup: async (input) => { actions.push(['record', input.issuedEventId]); },
  };
  const dry = await sweepExpiredHostedConsentUrls({ now }, deps);
  assert.deepEqual(dry, { examined: 1, eligible: 1, deleted: 0, absent: 0, failed: 0, dryRun: true });
  assert.deepEqual(actions, []);
  const executed = await sweepExpiredHostedConsentUrls({ now, execute: true }, deps);
  assert.equal(executed.deleted, 1);
  assert.deepEqual(actions, [['delete', 'operation-1'], ['record', 'event-1']]);
});

test('cleanup rejects active sessions, records verified absence, and leaves failures retriable', async () => {
  const active = { ...candidate, issuedEventId: 'event-active', expiresAt: new Date(now + 1).toISOString() };
  const absent = { ...candidate, issuedEventId: 'event-absent', operationId: 'operation-absent' };
  const failed = { ...candidate, issuedEventId: 'event-failed', operationId: 'operation-failed' };
  const actions = [];
  const result = await sweepExpiredHostedConsentUrls({ now, execute: true }, {
    listCandidates: async () => [active, absent, failed],
    purgeUrl: async (input) => {
      actions.push(['delete', input.operationId]);
      if (input.operationId === 'operation-failed') throw new Error('storage unavailable');
      return false;
    },
    recordCleanup: async (input) => { actions.push(['record', input.issuedEventId]); },
  });
  assert.deepEqual(result, { examined: 3, eligible: 2, deleted: 0, absent: 1, failed: 1, dryRun: false });
  assert.deepEqual(actions, [['delete', 'operation-absent'], ['record', 'event-absent'], ['delete', 'operation-failed']]);
});
