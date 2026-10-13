import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LUXIFY_CONTRACT_VERSION,
  createLuxifyClient,
  luxifyIntentSignature,
} from '../public/luxify-client.js';

const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';
const LOOK_A = '11111111-1111-4111-8111-111111111111';
const LOOK_B = '22222222-2222-4222-8222-222222222222';
const initialTime = Date.parse('2026-10-11T16:00:00.000Z');
const draft = {
  title: 'LUXIFY launch shot',
  prompt: 'A cinematic rooftop scene at blue hour with a slow camera orbit.',
  lookIdentityIds: [LOOK_A, LOOK_B],
  aspectRatio: '16:9',
  resolution: '720p',
  durationSeconds: 8,
};

class MemoryStorage {
  #items = new Map();

  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
}

function deterministicIds(start = 1) {
  let value = start;
  return () => {
    const suffix = String(value++).padStart(12, '0');
    return '00000000-0000-4000-8000-' + suffix;
  };
}

function capabilityResponse(available = true) {
  return {
    ok: true,
    contractVersion: LUXIFY_CONTRACT_VERSION,
    capabilities: {
      available,
      reasons: available ? [] : ['feature_disabled'],
      eligibleLooks: available ? [
        { identityId: LOOK_A, displayName: 'Owner look', providerLookId: 'private-provider-look', renderMode: 'luxify_cinematic_v1' },
        { identityId: LOOK_B, displayName: 'Second look' },
      ] : [],
      providerCapability: 'cinematic_avatar',
    },
  };
}

function createBackend({
  available = true,
  failFirstRender = false,
  recoverJob = null,
  now = () => initialTime,
} = {}) {
  const calls = [];
  let renderAttempts = 0;
  let quoteCount = 0;
  const request = async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body, timeoutMs: options.timeoutMs });
    if (url === '/api/video-os-lite/luxify' && method === 'GET') return capabilityResponse(available);
    if (url.startsWith('/api/video-os-lite/luxify?') && method === 'GET') {
      const query = Object.fromEntries(new URL(url, 'https://video-os.invalid').searchParams);
      return { ok: true, existingJob: typeof recoverJob === 'function' ? recoverJob(query) : recoverJob };
    }
    if (url === '/api/video-os-lite/luxify' && body?.action === 'save-project') {
      return { ok: true, project: { id: body.projectId } };
    }
    if (url === '/api/video-os-lite/luxify' && body?.action === 'quote') {
      quoteCount += 1;
      return {
        ok: true,
        quote: {
          token: ('quote-' + quoteCount + '-').padEnd(48, 'q'),
          credits: body.resolution === '1080p' ? 97 : 41,
          currency: 'lux_credits',
          pricingVersion: 'luxify-cinematic-pricing-v1',
          expiresAt: new Date(now() + 300_000).toISOString(),
        },
        project: { id: body.projectId },
      };
    }
    if (url === '/api/video-os-lite/render' && method === 'POST') {
      renderAttempts += 1;
      if (failFirstRender && renderAttempts === 1) {
        throw Object.assign(new Error('connection interrupted'), { code: 'network_timeout', retryable: true });
      }
      return { ok: true, job: { id: 'job-luxify-' + renderAttempts, status: 'workflow_started', title: body.title } };
    }
    throw new Error('Unexpected request: ' + method + ' ' + url);
  };
  return { calls, request, get renderAttempts() { return renderAttempts; } };
}

function createClient(backend, {
  storage = new MemoryStorage(),
  createId = deterministicIds(),
  now = () => initialTime,
} = {}) {
  return createLuxifyClient({ request: backend.request, storage, createId, now });
}

test('capabilities are account-safe, sanitized, and keep LUXIFY inactive when unavailable', async () => {
  const activeBackend = createBackend();
  const active = createClient(activeBackend);
  active.setScope(ACCOUNT_A);
  const capability = await active.loadCapabilities();
  assert.deepEqual(capability, {
    available: true,
    reasons: [],
    eligibleLooks: [
      { identityId: LOOK_A, displayName: 'Owner look' },
      { identityId: LOOK_B, displayName: 'Second look' },
    ],
  });
  assert.equal(JSON.stringify(capability).includes('private-provider-look'), false);
  assert.equal(JSON.stringify(capability).includes('cinematic_avatar'), false);
  assert.equal(JSON.stringify(capability).includes('luxify_cinematic_v1'), false);

  const inactiveBackend = createBackend({ available: false });
  const inactive = createClient(inactiveBackend);
  inactive.setScope(ACCOUNT_A);
  await inactive.loadCapabilities();
  await assert.rejects(inactive.prepareQuote(draft), { code: 'luxify_unavailable' });
  assert.equal(inactiveBackend.calls.filter(call => call.method === 'POST').length, 0);
});

test('save, quote, and render requests contain only the canonical LUXIFY browser contract', async () => {
  const backend = createBackend();
  const client = createClient(backend);
  client.setScope(ACCOUNT_A);
  await client.loadCapabilities();
  const prepared = await client.prepareQuote(draft);
  const publicQuote = client.publicState().quote;
  assert.equal(publicQuote.credits, 41);
  assert.equal(publicQuote.currency, 'lux_credits');
  assert.equal(Object.hasOwn(publicQuote, 'token'), false);
  const result = await client.submit(draft);
  assert.equal(result.recovered, false);

  const save = backend.calls.find(call => call.body?.action === 'save-project').body;
  assert.deepEqual(save, {
    action: 'save-project',
    contractVersion: LUXIFY_CONTRACT_VERSION,
    projectId: prepared.project.id,
    ...draft,
  });
  const quote = backend.calls.find(call => call.body?.action === 'quote').body;
  assert.deepEqual(quote, {
    action: 'quote',
    contractVersion: LUXIFY_CONTRACT_VERSION,
    projectId: prepared.project.id,
    idempotencyKey: prepared.idempotencyKey,
  });
  const render = backend.calls.find(call => call.url === '/api/video-os-lite/render').body;
  assert.deepEqual(render, {
    contractVersion: LUXIFY_CONTRACT_VERSION,
    projectId: prepared.project.id,
    idempotencyKey: prepared.idempotencyKey,
    ...draft,
    quoteToken: ('quote-1-').padEnd(48, 'q'),
  });
  for (const forbidden of ['provider', 'providerLookId', 'renderMode', 'providerCapability', 'model', 'script', 'voice']) {
    assert.equal(Object.hasOwn(render, forbidden), false);
  }
});

test('every canonical intent field participates in the signature and changed intent gets a new request key', async () => {
  const signature = luxifyIntentSignature(draft);
  const variants = [
    { ...draft, title: draft.title + ' changed' },
    { ...draft, prompt: draft.prompt + ' changed' },
    { ...draft, lookIdentityIds: [...draft.lookIdentityIds].reverse() },
    { ...draft, lookIdentityIds: [LOOK_A] },
    { ...draft, aspectRatio: '9:16' },
    { ...draft, resolution: '1080p' },
    { ...draft, durationSeconds: 9 },
  ];
  for (const changed of variants) assert.notEqual(luxifyIntentSignature(changed), signature);

  const backend = createBackend();
  const client = createClient(backend);
  client.setScope(ACCOUNT_A);
  await client.loadCapabilities();
  const first = await client.prepareQuote(draft);
  assert.equal(client.bindIntent(variants[1]), true);
  assert.equal(client.publicState().idempotencyKey, null);
  assert.equal(client.publicState().quote, null);
  const second = await client.prepareQuote(variants[1]);
  assert.notEqual(second.idempotencyKey, first.idempotencyKey);
});

test('expired quotes cannot submit or create a render request', async () => {
  let clock = initialTime;
  const now = () => clock;
  const backend = createBackend({ now });
  const client = createClient(backend, { now });
  client.setScope(ACCOUNT_A);
  await client.loadCapabilities();
  await client.prepareQuote(draft);
  clock += 300_000;
  assert.deepEqual(client.quoteStatus(draft), { valid: false, code: 'quote_expired' });
  await assert.rejects(client.submit(draft), { code: 'quote_expired' });
  assert.equal(backend.calls.some(call => call.url === '/api/video-os-lite/render'), false);
});

test('uncertain submission survives reload, locks intent changes, recovers read-only, and retries the same key', async () => {
  const storage = new MemoryStorage();
  const createId = deterministicIds();
  const backend = createBackend({ failFirstRender: true });
  const firstClient = createClient(backend, { storage, createId });
  firstClient.setScope(ACCOUNT_A);
  await firstClient.loadCapabilities();
  const prepared = await firstClient.prepareQuote(draft);
  await assert.rejects(firstClient.submit(draft), { code: 'submission_uncertain' });
  const uncertain = firstClient.publicState();
  assert.equal(uncertain.uncertain, true);
  assert.equal(uncertain.idempotencyKey, prepared.idempotencyKey);
  assert.throws(() => firstClient.bindIntent({ ...draft, prompt: 'A different paid intent.' }), { code: 'intent_locked' });

  const reloaded = createClient(backend, { storage, createId });
  const restored = reloaded.setScope(ACCOUNT_A);
  assert.equal(restored.uncertain, true);
  assert.equal(restored.idempotencyKey, prepared.idempotencyKey);
  assert.deepEqual(restored.draft, draft);
  assert.equal(restored.quote, null);
  assert.equal(await reloaded.recover(), null);
  const recoveryCall = backend.calls.filter(call => call.url.startsWith('/api/video-os-lite/luxify?')).at(-1);
  assert.deepEqual(Object.fromEntries(new URL(recoveryCall.url, 'https://video-os.invalid').searchParams), {
    contractVersion: LUXIFY_CONTRACT_VERSION,
    projectId: prepared.project.id,
    idempotencyKey: prepared.idempotencyKey,
  });
  await reloaded.loadCapabilities();
  const requoted = await reloaded.prepareQuote(draft);
  assert.equal(requoted.idempotencyKey, prepared.idempotencyKey);
  const result = await reloaded.submit(draft, { recoveryFirst: true });
  assert.equal(result.recovered, false);
  assert.equal(backend.renderAttempts, 2);
  const renderKeys = backend.calls
    .filter(call => call.url === '/api/video-os-lite/render')
    .map(call => call.body.idempotencyKey);
  assert.deepEqual(renderKeys, [prepared.idempotencyKey, prepared.idempotencyKey]);
});

test('read-only recovery returns an existing job without a second render submission', async () => {
  let acceptedKey;
  const backend = createBackend({
    failFirstRender: true,
    recoverJob: query => query.idempotencyKey === acceptedKey
      ? { id: 'job-existing', status: 'workflow_started', title: draft.title }
      : null,
  });
  const client = createClient(backend);
  client.setScope(ACCOUNT_A);
  await client.loadCapabilities();
  const prepared = await client.prepareQuote(draft);
  acceptedKey = prepared.idempotencyKey;
  await assert.rejects(client.submit(draft), { code: 'submission_uncertain' });
  const recovered = await client.submit(draft, { recoveryFirst: true });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.job.id, 'job-existing');
  assert.equal(backend.renderAttempts, 1);
});

test('session persistence is scoped to the authenticated account', async () => {
  const storage = new MemoryStorage();
  const createId = deterministicIds(100);
  const backend = createBackend();
  const client = createClient(backend, { storage, createId });
  client.setScope(ACCOUNT_A);
  await client.loadCapabilities();
  const accountA = await client.prepareQuote(draft);

  const accountB = client.setScope(ACCOUNT_B);
  assert.equal(accountB.idempotencyKey, null);
  assert.equal(accountB.draft, null);
  assert.notEqual(accountB.projectId, accountA.project.id);
  client.bindIntent({ ...draft, title: 'Account B draft' });

  const restoredA = client.setScope(ACCOUNT_A);
  assert.equal(restoredA.idempotencyKey, accountA.idempotencyKey);
  assert.deepEqual(restoredA.draft, draft);
  assert.equal(restoredA.quote, null);
});
