import assert from 'node:assert/strict';
import { mock } from 'node:test';

const account = await import('../../lib/video-os-account.js');
const repositories = await import('../../db/repositories.js');
const privateBlob = await import('../../lib/video-os-private-blob.js');
let reads = 0;
mock.module('../../lib/video-os-account.js', { namedExports: { ...account, sessionFromRequest: () => ({ accountId: 'owner' }) } });
mock.module('../../db/repositories.js', { namedExports: { ...repositories, getOwnedMediaAsset: async () => ({
  id: 'asset', accountId: 'owner', kind: 'identity-voice-source', contentType: 'audio/wav', bytes: 10,
  sha256: 'a'.repeat(64), privatePathname: 'video-os/enrollment-sources/source.wav', quarantinedAt: new Date(),
}) } });
mock.module('../../lib/video-os-private-blob.js', { namedExports: { ...privateBlob, getPrivateBlob: async () => { reads++; throw new Error('must not read'); } } });
const { default: asset } = await import('../../routes/video-os-lite/asset.js');
const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(raw) { this.body = JSON.parse(raw); } };
await asset({ method: 'GET', url: '/api/video-os-lite/asset?assetId=asset', headers: {} }, res);
assert.equal(res.statusCode, 404);
assert.equal(reads, 0);
