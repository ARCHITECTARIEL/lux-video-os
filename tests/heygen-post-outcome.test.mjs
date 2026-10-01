import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadHeygenIdentityAsset, createHeygenPhotoAvatar, cloneHeygenVoice } from '../services/heygen.js';

const names = ['HEYGEN_API_KEY', 'HEYGEN_TOKEN', 'VIDEO_OS_IDENTITY_PROVIDER_ENABLED', 'HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED', 'VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID'];
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
test.beforeEach(() => {
  process.env.HEYGEN_API_KEY = 'synthetic-outcome-test';
  delete process.env.HEYGEN_TOKEN;
  process.env.VIDEO_OS_IDENTITY_PROVIDER_ENABLED = 'true';
  process.env.HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED = 'true';
  process.env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID = 'outcome-fixture';
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

const operations = {
  upload: () => uploadHeygenIdentityAsset({ accountId: 'outcome-fixture', buffer: new Uint8Array([1]), contentType: 'image/png', filename: 'fixture.png' }),
  avatar: () => createHeygenPhotoAvatar({ accountId: 'outcome-fixture', assetId: 'fixture-asset', name: 'Fixture', idempotencyKey: 'fixture-operation' }),
  voice: () => cloneHeygenVoice({ accountId: 'outcome-fixture', assetId: 'fixture-asset', name: 'Fixture' }),
};
const outcomes = {
  network: () => { throw new TypeError('private network diagnostic'); },
  timeout: () => { throw new DOMException('private timeout diagnostic', 'TimeoutError'); },
  body_failure: () => ({ ok: true, status: 200, text: async () => { throw new Error('private body diagnostic'); } }),
  server_error: () => new Response(JSON.stringify({ error: { code: 'upstream_failed', message: 'private diagnostic' } }), { status: 503 }),
  invalid_json: () => new Response('private invalid response', { status: 200 }),
  missing_ids: () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
  rejection_requires_reconciliation: () => new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'private diagnostic' } }), { status: 400 }),
};
for (const [operationName, operation] of Object.entries(operations)) {
  for (const [outcomeName, response] of Object.entries(outcomes)) {
    test(`${operationName}: ${outcomeName} is uncertain after one POST and never retried`, async () => {
      let requests = 0;
      globalThis.fetch = async (_url, options) => {
        requests += 1;
        assert.equal(options.method, 'POST');
        return response();
      };
      await assert.rejects(operation(), error => {
        assert.equal(error.failureCategory, 'PROVIDER_SUBMIT_UNKNOWN');
        assert.equal(error.providerSubmissionPossible, true);
        assert.equal(error.message.includes('private'), false);
        return true;
      });
      assert.equal(requests, 1);
    });
  }
}

test('invalid source is rejected before sending any POST', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('must not send'); };
  await assert.rejects(uploadHeygenIdentityAsset({ accountId: 'outcome-fixture', buffer: new Uint8Array(), contentType: 'image/png' }), { failureCategory: 'INVALID_IDENTITY_ASSET_SIZE' });
  assert.equal(requests, 0);
});

for (const groupId of [undefined, 'another-group']) {
  test(`avatar receipt requires exact look-to-group association (${groupId || 'missing'})`, async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return new Response(JSON.stringify({ data: {
        avatar_group: { id: 'group-1' },
        avatar_item: { id: 'look-1', group_id: groupId },
      } }), { status: 200 });
    };
    await assert.rejects(operations.avatar(), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
    assert.equal(requests, 1);
  });
}
