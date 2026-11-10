import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

// CON-24: offline DOM-free check of public/luxify-consent.js (the full browser
// run is tests/e2e/luxify-consent-confirm.spec.js under Playwright).
const script = readFileSync(new URL('../public/luxify-consent.js', import.meta.url), 'utf8');
const TOKEN = 'Tok_en-0123456789abcdefghijklmnopqrstuvwxyz';
const NOTICE = { title: 't', paragraphs: ['p'], acknowledgments: { cinematicGenerationAuthorization: 'a', providerProcessingAuthorization: 'b' } };

function element() {
  const listeners = {};
  return {
    hidden: false, disabled: false, checked: false, value: '', textContent: '', dataset: {}, children: [],
    addEventListener(type, fn) { listeners[type] = fn; },
    click() { return listeners.click?.(); },
    replaceChildren(...nodes) { this.children = nodes; },
    append(...nodes) { this.children.push(...nodes); },
  };
}

async function boot(href, confirmReply) {
  const elements = new Map();
  const events = [];
  const location = new URL(href);
  const consoleSpy = new Proxy({}, { get: () => (...args) => events.push(['console', args.join(' ')]) });
  const context = {
    location,
    history: { replaceState: (_state, _title, url) => { events.push(['replaceState', url]); location.hash = ''; } },
    document: { getElementById: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: () => element() },
    window: { confirm: () => true },
    console: consoleSpy,
    crypto: { randomUUID: () => 'uuid' },
    URLSearchParams,
    fetch: async (_url, init) => {
      events.push(['fetch', init.method, init.body ?? null, String(location)]);
      if (init.method === 'GET') return { status: 200, ok: true, json: async () => ({ ok: true, notice: NOTICE, identities: [], consents: [] }) };
      const [status, body] = confirmReply;
      return { status, ok: status === 200, json: async () => body };
    },
  };
  runInNewContext(script, context);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  return { elements, events, location, settle };
}

test('CON-24: the #confirm= token is removed from history before any request and is never logged', async () => {
  const { elements, events, settle } = await boot(`https://video.example/luxify-consent?x=1#confirm=${TOKEN}`, [200, { ok: true, consent: {} }]);
  assert.deepEqual(events[0], ['replaceState', '/luxify-consent?x=1']);
  assert.ok(events.filter(event => event[0] === 'fetch').every(event => !event[3].includes(TOKEN)), 'no request sees the token in the URL');
  assert.equal(elements.get('confirm-panel').dataset.state, 'ready');
  await elements.get('confirm').click();
  await settle();
  const post = events.find(event => event[0] === 'fetch' && event[1] === 'POST');
  assert.deepEqual(JSON.parse(post[2]), { action: 'confirm-on-behalf', token: TOKEN });
  assert.equal(elements.get('confirm-panel').dataset.state, 'success');
  assert.equal(events.some(event => event[0] === 'console'), false);
  for (const node of elements.values()) assert.ok(!String(node.textContent).includes(TOKEN));
});

for (const [status, code, state] of [
  [409, 'LUXIFY_CONFIRMATION_EXPIRED', 'expired'], [409, 'LUXIFY_CONFIRMATION_USED', 'used'],
  [404, 'LUXIFY_CONFIRMATION_INVALID', 'wrong_account'], [409, 'LUXIFY_CONFIRMATION_EMAIL_MISMATCH', 'wrong_account'],
  [401, 'sign_in_required', 'signed_out'], [503, 'luxify_consent_obo_unavailable', 'flag_off'], [500, 'whatever', 'error'],
]) {
  test(`CON-24: ${code} maps to the ${state} state`, async () => {
    const { elements, settle } = await boot(`https://video.example/luxify-consent#confirm=${TOKEN}`, [status, { ok: false, code }]);
    await elements.get('confirm').click();
    await settle();
    assert.equal(elements.get('confirm-panel').dataset.state, state);
    assert.equal(elements.get('confirm').hidden, state !== 'error');
  });
}

test('CON-24: no #confirm= fragment leaves history alone and hides the confirm panel', async () => {
  const { elements, events } = await boot('https://video.example/luxify-consent#other=1', [200, {}]);
  assert.equal(events.some(event => event[0] === 'replaceState'), false);
  assert.notEqual(elements.get('confirm-panel')?.dataset.state, 'ready');
});
