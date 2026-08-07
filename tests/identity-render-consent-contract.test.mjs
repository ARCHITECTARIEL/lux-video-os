import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('identity render revalidates current active consent and frozen source fingerprints', async () => {
  const [render, repositories, route, policy] = await Promise.all([
    read('api/video-os-lite/render-v2.js'),
    read('db/repositories.js'),
    read('routes/video-os-lite/identities.js'),
    read('lib/video-os-identity-policy.js'),
  ]);
  assert.match(policy, /IDENTITY_CONSENT_POLICY_VERSION/);
  assert.match(render, /getRenderAuthorizedIdentity/);
  assert.match(render, /IDENTITY_CONSENT_POLICY_VERSION/);
  assert.match(repositories, /eq\(identityConsents\.policyVersion, policyVersion\)/);
  assert.match(repositories, /photo\.sha256 !== consent\.photoSha256/);
  assert.match(repositories, /voice\.sha256 !== consent\.voiceSha256/);
  assert.match(route, /from '..\/..\/lib\/video-os-identity-policy\.js'/);
});