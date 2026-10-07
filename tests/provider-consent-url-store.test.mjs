import assert from 'node:assert/strict';
import test from 'node:test';
import { saveProviderConsentUrl, consumeProviderConsentUrl, readProviderConsentUrl } from '../lib/provider-consent-url-store.js';

test('hosted consent URL is private, digest-bound, and absent from the saved DTO', async () => {
  let written;
  const url = 'https://app.heygen.com/avatars/api-video/record?token=private';
  const result = await saveProviderConsentUrl({
    operationId: 'operation-1', url, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { put: async (...args) => { written = args; return { pathname: args[1], etag: 'etag-1' }; } });
  assert.equal(written[0], 'authentication-state');
  assert.match(written[1], /^video-os\/auth\/provider-consent\/[a-f0-9]{64}\.json$/);
  assert.equal(written[3].allowOverwrite, false);
  assert.equal(JSON.parse(written[2]).url, url);
  assert.equal(JSON.stringify(result).includes(url), false);
  assert.match(result.urlDigest, /^[a-f0-9]{64}$/);
});

test('launch consumes exact private URL once and rejects missing version or expired evidence', async () => {
  const url = 'https://app.heygen.com/avatars/api-video/record?token=private';
  const record = { version: 1, operationId: 'operation-1', url, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const path = 'video-os/auth/provider-consent/' + 'a'.repeat(64) + '.json';
  const calls = [];
  const deps = {
    get: async () => ({ stream: new Blob([JSON.stringify(record)]).stream(), blob: { etag: 'etag-1' } }),
    del: async (...args) => { calls.push(args); return { deleted: true }; },
  };
  assert.equal(await consumeProviderConsentUrl({ path, operationId: 'operation-1' }, deps), url);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][2], { ifMatch: 'etag-1' });
  await assert.rejects(consumeProviderConsentUrl({ path, operationId: 'other' }, deps), /unavailable/);
  await assert.rejects(consumeProviderConsentUrl({ path, operationId: 'operation-1' }, {
    ...deps, get: async () => ({ stream: new Blob([JSON.stringify({ ...record, expiresAt: new Date(0).toISOString() })]).stream(), blob: { etag: 'etag-1' } }),
  }), /unavailable/);
});

test('private store rejects a provider URL outside HeyGen', async () => {
  await assert.rejects(saveProviderConsentUrl({
    operationId: 'operation-1', url: 'https://other.example/consent?token=private', expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, { put: async () => { throw new Error('must not write'); } }), /unavailable/);
});

test('a new local launch challenge can read the same private session without deleting it', async () => {
  const url = 'https://app.heygen.com/avatars/api-video/record?token=private';
  const record = { version: 1, operationId: 'operation-1', url, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  let reads = 0;
  const deps = { get: async () => { reads += 1; return { stream: new Blob([JSON.stringify(record)]).stream() }; } };
  const path = 'video-os/auth/provider-consent/' + 'a'.repeat(64) + '.json';
  assert.equal(await readProviderConsentUrl({ path, operationId: 'operation-1' }, deps), url);
  assert.equal(await readProviderConsentUrl({ path, operationId: 'operation-1' }, deps), url);
  assert.equal(reads, 2);
  await assert.rejects(readProviderConsentUrl({ path, operationId: 'wrong' }, deps), /unavailable/);
});
