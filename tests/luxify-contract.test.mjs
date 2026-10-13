import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
  canonicalizeLuxifyIntent,
  canonicalizeLuxifyRenderRequest,
  classifyLuxifyMarker,
  isLuxifyRequest,
  luxifyFormatForAspectRatio,
} from '../lib/luxify-contract.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const idempotencyKey = '22222222-2222-4222-8222-222222222222';
const identities = [
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];
const intent = {
  contractVersion: LUXIFY_CONTRACT_VERSION,
  projectId,
  idempotencyKey,
  title: 'LUXIFY launch shot',
  prompt: 'A cinematic rooftop scene at blue hour with a slow camera orbit.',
  lookIdentityIds: identities.slice(0, 2),
  aspectRatio: '16:9',
  resolution: '720p',
  durationSeconds: 8,
};

test('LUXIFY constants keep product mode separate from its provider capability', () => {
  assert.equal(LUXIFY_RENDER_MODE, 'luxify_cinematic_v1');
  assert.equal(LUXIFY_PROVIDER_CAPABILITY, 'cinematic_avatar');
  assert.equal(isLuxifyRequest(intent), true);
  assert.equal(isLuxifyRequest({ contractVersion: 'scripted-photo-v1' }), false);
});

test('one canonical marker classifier separates exact HeyGen LUXIFY from malformed lookalikes', () => {
  const markers = {
    contractVersion: LUXIFY_CONTRACT_VERSION,
    renderMode: LUXIFY_RENDER_MODE,
    providerCapability: LUXIFY_PROVIDER_CAPABILITY,
  };
  assert.equal(classifyLuxifyMarker(markers), 'luxify');
  assert.equal(classifyLuxifyMarker(markers, { provider: 'heygen' }), 'luxify');
  assert.equal(classifyLuxifyMarker(markers, { provider: undefined }), 'unavailable');
  assert.equal(classifyLuxifyMarker(markers, { provider: 'sadtalker' }), 'unavailable');
  for (const value of [
    { providerCapability: 'cinematic_avatar_v2' },
    { contractVersion: ' LUXIFY-CINEMATIC-V2 ' },
    { renderMode: ' LUXIFY_CINEMATIC_V2 ' },
  ]) assert.equal(classifyLuxifyMarker(value, { provider: 'heygen' }), 'unavailable');
  assert.equal(classifyLuxifyMarker({ contractVersion: 'scripted-photo-v1' }, { provider: 'heygen' }), null);
});

test('canonicalization trims text, normalizes UUID case, preserves look order, and freezes the result', () => {
  const value = canonicalizeLuxifyIntent({
    ...intent,
    projectId: projectId.toUpperCase(),
    idempotencyKey: idempotencyKey.toUpperCase(),
    title: '  LUXIFY launch shot  ',
    prompt: '  A bounded cinematic prompt.  ',
    lookIdentityIds: [identities[1].toUpperCase(), identities[0].toUpperCase()],
  });
  assert.equal(value.projectId, projectId);
  assert.equal(value.idempotencyKey, idempotencyKey);
  assert.equal(value.title, 'LUXIFY launch shot');
  assert.equal(value.prompt, 'A bounded cinematic prompt.');
  assert.deepEqual(value.lookIdentityIds, [identities[1], identities[0]]);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.lookIdentityIds), true);
});

test('prompt, title, look-count, and duration boundaries are exact', () => {
  for (const value of [
    { ...intent, title: 'x', prompt: 'x', lookIdentityIds: identities.slice(0, 1), durationSeconds: 4 },
    { ...intent, title: 'x'.repeat(120), prompt: 'x'.repeat(1_500), lookIdentityIds: identities, durationSeconds: 15 },
  ]) assert.doesNotThrow(() => canonicalizeLuxifyIntent(value));

  for (const value of [
    { ...intent, title: ' ' },
    { ...intent, title: 'x'.repeat(121) },
    { ...intent, prompt: ' ' },
    { ...intent, prompt: 'x'.repeat(1_501) },
    { ...intent, lookIdentityIds: [] },
    { ...intent, lookIdentityIds: [...identities, '66666666-6666-4666-8666-666666666666'] },
    { ...intent, durationSeconds: 3 },
    { ...intent, durationSeconds: 16 },
    { ...intent, durationSeconds: 4.5 },
  ]) assert.throws(() => canonicalizeLuxifyIntent(value));
});

test('look identities must be valid, unique application UUIDs', () => {
  for (const lookIdentityIds of [
    [identities[0], identities[0]],
    ['provider-look-id'],
    [identities[0], ''],
  ]) assert.throws(() => canonicalizeLuxifyIntent({ ...intent, lookIdentityIds }));
});

test('only supported aspect ratios and resolutions are accepted and map to existing formats', () => {
  assert.equal(luxifyFormatForAspectRatio('16:9'), 'landscape');
  assert.equal(luxifyFormatForAspectRatio('9:16'), 'vertical');
  assert.equal(luxifyFormatForAspectRatio('1:1'), 'square');
  assert.throws(() => luxifyFormatForAspectRatio('4:3'), TypeError);
  for (const aspectRatio of ['16:9', '9:16', '1:1']) assert.doesNotThrow(() => canonicalizeLuxifyIntent({ ...intent, aspectRatio }));
  for (const resolution of ['720p', '1080p']) assert.doesNotThrow(() => canonicalizeLuxifyIntent({ ...intent, resolution }));
  for (const value of [
    { ...intent, aspectRatio: '4:3' },
    { ...intent, resolution: '4k' },
  ]) assert.throws(() => canonicalizeLuxifyIntent(value));
});

test('server-owned, Premium Presenter, callback, and unknown fields fail closed', () => {
  for (const [key, value] of Object.entries({
    script: 'Do not reinterpret this as Premium Presenter.',
    voice: { voiceId: 'voice-1' },
    voiceId: 'voice-1',
    provider: 'heygen',
    renderMode: LUXIFY_RENDER_MODE,
    providerCapability: LUXIFY_PROVIDER_CAPABILITY,
    model: 'seedance-claimed-version',
    callbackUrl: 'https://example.com/callback',
    callback_id: 'callback-1',
    costCredits: 60,
    unknown: true,
  })) assert.throws(() => canonicalizeLuxifyIntent({ ...intent, [key]: value }));
});

test('render request adds only an opaque bounded quote token', () => {
  const quoteToken = 'a'.repeat(40);
  const request = canonicalizeLuxifyRenderRequest({ ...intent, quoteToken });
  assert.equal(request.quoteToken, quoteToken);
  assert.deepEqual(request.lookIdentityIds, intent.lookIdentityIds);
  assert.equal(Object.isFrozen(request), true);
  assert.throws(() => canonicalizeLuxifyRenderRequest(intent));
  assert.throws(() => canonicalizeLuxifyRenderRequest({ ...intent, quoteToken: 'short' }));
  assert.throws(() => canonicalizeLuxifyRenderRequest({ ...intent, quoteToken, provider: 'heygen' }));
});
