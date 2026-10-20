import assert from 'node:assert/strict';
import test from 'node:test';
import { pollHeygen } from '../services/heygen.js';

function response(data) {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const poll = (data) => pollHeygen('provider-job-fixture', {
  env: { HEYGEN_API_KEY: 'fixture-key' },
  fetchImpl: async () => response(data),
});

test('HeyGen poll holds malformed state instead of counting it as confirmed processing', async () => {
  for (const data of [{}, { status: '' }, { status: 'unexpected_state' }, { status: 'completed' }, { status: 'completed', video_url: '' }]) {
    await assert.rejects(poll(data), (error) => error.failureCategory === 'PROVIDER_RESPONSE');
  }
});

test('HeyGen poll accepts an explicit processing state without media', async () => {
  assert.deepEqual(await poll({ status: 'processing' }), { ready: false, status: 'processing', sourceUrl: null });
});
