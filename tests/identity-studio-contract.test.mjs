import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Identity Studio is a separate five-step authenticated experience', async () => {
  const [html, client, routes] = await Promise.all([
    read('public/identity.html'),
    read('public/identity.js'),
    read('vercel.json'),
  ]);
  assert.match(routes, /"src"\s*:\s*"\/identity"[\s\S]*?identity\.html/);
  for (const label of ['Your Photo', 'Your Voice', 'Consent', 'Creating', 'Ready']) assert.match(html, new RegExp(label));
  assert.match(html, /Digital Twin/);
  assert.match(html, /disabled>Not available in this phase/);
  assert.match(client, /\/api\/video-os-lite\/session/);
  assert.match(client, /\/api\/video-os-lite\/identities/);
  assert.match(client, /pollCount >= 45/);
  assert.match(html, /ready-use-link/);
  assert.doesNotMatch(html, /useIdentity/);
  assert.match(client, /readyUseLink\.href[\s\S]*encodeURIComponent\(identity\.id\)/);
});

test('Digital Twin is explicitly unavailable and has no legacy submit path', async () => {
  const [studio, root, client] = await Promise.all([read('public/identity.html'), read('public/index.html'), read('public/lite.js')]);
  assert.match(studio, /Digital Twin/);
  assert.match(studio, /COMING NEXT/);
  assert.match(root, /Digital Twin/);
  assert.match(root, /Coming later/);
  assert.doesNotMatch(root, /Build digital twin|digital-twin-(?:name|file|url|consent)|create-digital-twin/);
  assert.doesNotMatch(client, /digital_twin|digital-twin|create-digital-twin/);
});

test('consent UI contains every versioned authorization represented by the server', async () => {
  const [html, route] = await Promise.all([read('public/identity.html'), read('routes/video-os-lite/identities.js')]);
  assert.match(html, /This photo is of me, or I have documented authorization from this person\./);
  assert.match(html, /This is my voice, or I have documented authorization to clone it\./);
  assert.match(html, /I authorize Video OS and HeyGen to process these files/);
  assert.match(html, /I understand I can request that this identity be archived or deleted\./);
  assert.match(route, /IDENTITY_CONSENT_POLICY_VERSION/);
  for (const field of ['faceAuthorization', 'voiceAuthorization', 'providerProcessingAuthorization', 'archiveDeleteAcknowledgment']) assert.match(route, new RegExp(`${field}: body\\.${field} === true`));
});

test('identity provider submission is doubly gated and private DTOs hide provider IDs', async () => {
  const [route, service] = await Promise.all([
    read('routes/video-os-lite/identities.js'),
    read('services/heygen.js'),
  ]);
  assert.match(route, /assertIdentityProviderMutationEnabled\(\)/);
  assert.match(route, /assertIdentityProviderAccountAuthorized\(accountId\)/);
  assert.match(route, /assertHeygenConfigured\(\)/);
  assert.match(service, /VIDEO_OS_IDENTITY_PROVIDER_ENABLED/);
  assert.match(service, /HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED/);
  const dtoBody = route.slice(route.indexOf('function identityForClient'), route.indexOf('function validateName'));
  assert.doesNotMatch(dtoBody, /providerAvatar|providerVoice|providerAsset|privatePathname/);
  assert.match(route, /getOwnedIdentity\(accountId, identityId\)/);
  assert.match(route, /getOwnedMediaAsset\(accountId, assetId\)/);
});

test('composer handoff selects only an authenticated ready private identity', async () => {
  const client = await read('public/lite.js');
  const handoff = client.slice(client.indexOf('function consumeIdentitySelection'), client.indexOf('function firstCaption'));
  assert.match(handoff, /if \(!appState\.signedIn\) return/);
  assert.match(handoff, /appState\.identities\.find\(\(item\) => item\.id === identityId\)/);
  assert.match(handoff, /That private identity is unavailable for this account/);
  assert.match(handoff, /chooseIdentity\(identity, \{ forcePairedVoice: true \}\)/);
  assert.doesNotMatch(handoff, /getJson|fetch\(/);
  assert.equal((client.match(/consumeIdentitySelection\(\);/g) || []).length, 2);
});