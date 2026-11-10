import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import {
  LUXIFY_CONSENT_NOTICE,
  LUXIFY_CONSENT_NOTICE_SHA256,
  LUXIFY_OPERATOR_ATTESTATION_VERSION,
  renderLuxifyOperatorAttestation,
} from '../lib/luxify-consent-policy.js';

// Offline DOM stand-in for public/luxify-operator.js. The browser run is
// tests/e2e/luxify-operator.spec.js.
const script = readFileSync(new URL('../public/luxify-operator.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/luxify-operator.html', import.meta.url), 'utf8');

const ACCOUNT = 'user-subject-obo-1110';
const EMAIL = 'subject.obo@example.com';
const CHALLENGE_A = 'challenge-a.not-a-dom-token-aaaaaaaaaaaaaaaa';
const CHALLENGE_B = 'challenge-b.not-a-dom-token-bbbbbbbbbbbbbbbb';
const IDENTITY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IDENTITY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVIDENCE = `video-os/consent-evidence/${'ab'.repeat(32)}/11111111-1111-4111-8111-111111111111.pdf`;
const CONSENT_PENDING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONSENT_ACTIVE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONSENT_SELF = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const IDEMPOTENCY = '00000000-0000-4000-8000-000000000099';
const NAME = 'Quincy Attestor';
const ATTESTED = '2026-11-09T11:00';
const SECRETS = [CHALLENGE_A, CHALLENGE_B, 'vos_session', 'operator-should-not-be-sent'];

const pendingConsent = { id: CONSENT_PENDING, identityId: IDENTITY_B, status: 'pending_confirmation', consentMode: 'operator_on_behalf', acceptedAt: '2026-11-09T12:00:00.000Z', attestedAt: '2026-11-09T16:00:00.000Z', expiresAt: '2027-11-09T16:00:00.000Z' };
const activeConsent = { id: CONSENT_ACTIVE, identityId: IDENTITY_A, status: 'active', consentMode: 'operator_on_behalf', acceptedAt: '2026-11-01T12:00:00.000Z', attestedAt: '2026-11-01T12:00:00.000Z', expiresAt: '2027-11-01T12:00:00.000Z' };
const selfConsent = { id: CONSENT_SELF, identityId: IDENTITY_A, status: 'active', acceptedAt: '2026-10-01T12:00:00.000Z', expiresAt: '2027-10-01T12:00:00.000Z' };

function contextBody(consents = [pendingConsent, activeConsent, selfConsent]) {
  return {
    ok: true,
    notice: LUXIFY_CONSENT_NOTICE,
    noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256,
    attestationVersion: LUXIFY_OPERATOR_ATTESTATION_VERSION,
    identities: [
      { identityId: IDENTITY_A, displayName: 'Look A', challenge: CHALLENGE_A },
      { identityId: IDENTITY_B, displayName: 'Look B', challenge: CHALLENGE_B },
    ],
    consents,
  };
}

function element() {
  const listeners = {};
  const node = {
    hidden: false, disabled: false, checked: false, value: '', textContent: '', type: '', dataset: {}, children: [],
    addEventListener(type, fn) { listeners[type] = fn; },
    replaceChildren(...nodes) { this.children = nodes; },
    append(...nodes) { this.children.push(...nodes); },
    click() { return listeners.click?.(); },
    input() { return listeners.input?.(); },
    change() { return listeners.change?.(); },
    submit() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      const result = listeners.submit?.(event);
      node.defaultPrevented = event.defaultPrevented;
      return result;
    },
  };
  return node;
}

function posts(events) {
  return events.filter(event => event[0] === 'fetch').map(event => event[5]);
}

function assertNoOperator(body) {
  for (const key of ['operatorAccountId', 'operatorId', 'staffAccountId', 'operator']) {
    assert.equal(Object.hasOwn(body, key), false, key);
  }
  assert.equal(JSON.stringify(body).includes('vos_session'), false);
}

function buttons(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (node.type === 'button' && node.textContent === 'Withdraw') acc.push(node);
  for (const child of node.children || []) buttons(child, acc);
  return acc;
}

function treeText(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  acc.push(String(node.textContent || ''), String(node.value || ''));
  for (const child of node.children || []) treeText(child, acc);
  return acc;
}

function assertSecretsOffDom(elements, extra = []) {
  const visible = [];
  for (const node of elements.values()) treeText(node, visible);
  const blob = visible.join('\n');
  for (const secret of [...SECRETS, ...extra]) assert.equal(blob.includes(secret), false, secret);
}

const FLAG_PROBE = 'luxify-obo-flag-check';

async function boot(onPost, { confirm = () => true, gate = null } = {}) {
  const elements = new Map();
  const events = [];
  const context = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: () => element(),
    },
    window: { confirm },
    console: new Proxy({}, { get: () => (...args) => events.push(['console', args.map(part => String(part)).join(' ')]) }),
    crypto: { randomUUID: () => IDEMPOTENCY },
    fetch: async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      events.push(['fetch', String(url), init?.method, init?.credentials, init?.headers, body]);
      if (gate) await gate;
      const [status, payload] = await onPost(body);
      return { status, ok: status >= 200 && status < 300, json: async () => payload };
    },
  };
  runInNewContext(script, context);
  const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  const el = id => context.document.getElementById(id);
  return { elements, events, settle, el };
}

function fillGrant(el, { attest = true } = {}) {
  el('look').value = IDENTITY_B;
  el('subject-name').value = NAME;
  el('method').value = 'recorded_verbal';
  el('attested-at').value = ATTESTED;
  el('evidence-ref').value = EVIDENCE;
  el('ack-generation').checked = true;
  el('ack-processing').checked = true;
  el('attestation-confirmed').checked = attest;
}

test('forms stay hidden until the flag check, then a 503 shows not enabled', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = [];
  const { events, el, settle } = await boot(body => {
    seen.push(body);
    return [503, { ok: false, code: 'luxify_consent_obo_unavailable', error: 'On-behalf LUXIFY consent is turned off.' }];
  }, { gate });
  assert.equal(el('operator').dataset.state, 'checking');
  assert.equal(el('lookup-panel').hidden, true);
  assert.equal(el('context-panel').hidden, true);
  assert.equal(el('find-subject').disabled, true);
  assert.equal(el('load-context').disabled, true);
  assert.equal(el('grant').disabled, true);
  assert.deepEqual(posts(events), [{ action: 'operator-context', onBehalfOfAccountId: FLAG_PROBE }]);
  release();
  await settle();
  el('subject-account').value = ACCOUNT;
  el('subject-email').value = EMAIL;
  await el('account-form').submit();
  await el('email-form').submit();
  assert.deepEqual(seen, [{ action: 'operator-context', onBehalfOfAccountId: FLAG_PROBE }]);
  assertNoOperator(seen[0]);
  assert.equal(el('operator').dataset.state, 'unavailable');
  assert.equal(el('obo-state').hidden, false);
  assert.match(el('obo-state').textContent, /not enabled/i);
  assert.match(el('status').textContent, /not enabled/i);
  assert.equal(el('status').textContent.includes(ACCOUNT), false);
  assert.equal(el('status').textContent.includes(EMAIL), false);
  assert.equal(el('lookup-panel').hidden, true);
  assert.equal(el('context-panel').hidden, true);
  assert.equal(el('find-subject').disabled, true);
  assert.equal(el('load-context').disabled, true);
  assert.equal(el('grant').disabled, true);
  assert.equal(events.some(event => event[0] === 'console'), false);
});

test('a passing flag check reveals only the lookup form', async () => {
  const seen = [];
  const { el } = await boot(body => {
    seen.push(body);
    return [200, { ok: true, notice: LUXIFY_CONSENT_NOTICE, noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256, attestationVersion: LUXIFY_OPERATOR_ATTESTATION_VERSION, identities: [{ identityId: IDENTITY_A, displayName: 'Probe look', challenge: CHALLENGE_A }], consents: [pendingConsent] }];
  });
  assert.deepEqual(seen, [{ action: 'operator-context', onBehalfOfAccountId: FLAG_PROBE }]);
  assert.equal(el('operator').dataset.state, 'enabled');
  assert.equal(el('lookup-panel').hidden, false);
  assert.equal(el('context-panel').hidden, true);
  assert.equal(el('find-subject').disabled, false);
  assert.equal(el('load-context').disabled, false);
  assert.equal(el('grant').disabled, true);
  assert.equal(el('consents').textContent.includes('waiting for the subject'), false);
  assert.equal(el('status').textContent.includes(FLAG_PROBE), false);
  assert.equal(el('status').textContent.includes(CHALLENGE_A), false);
});

test('grant-on-behalf sends the API shape with no operator id, and the attestation matches the server template', async () => {
  const seen = [];
  const { elements, events, el } = await boot(body => {
    seen.push(body);
    if (body.action === 'staff-lookup') {
      return [200, { ok: true, accountId: ACCOUNT, accountRef: '…1110', emailVerified: true, identities: [] }];
    }
    if (body.action === 'operator-context') return [200, contextBody()];
    if (body.action === 'grant-on-behalf') {
      return [201, { ok: true, replayed: false, confirmationEmail: 'sent', confirmationExpiresAt: '2026-11-16T16:00:00.000Z', consent: { id: CONSENT_PENDING, status: 'pending_confirmation' } }];
    }
    throw new Error(`unexpected ${body.action}`);
  });
  el('subject-email').value = EMAIL;
  await el('email-form').submit();
  assert.equal(el('operator').dataset.state, 'ready');
  assert.match(el('attestation-version').textContent, new RegExp(LUXIFY_OPERATOR_ATTESTATION_VERSION));
  assert.match(el('context-summary').textContent, /1 waiting for the subject/);
  assert.match(el('context-summary').textContent, /1 confirmed by the subject/);
  assert.equal(el('subject-summary').textContent.includes(ACCOUNT), false);
  assert.equal(el('subject-summary').textContent.includes(EMAIL), false);
  assert.deepEqual(el('look').children.map(option => option.textContent), ['Look A', 'Look B']);
  assert.equal(events.some(event => event[0] === 'console'), false);

  el('look').value = IDENTITY_B;
  await el('look').change();
  el('subject-name').value = NAME;
  el('method').value = 'recorded_verbal';
  el('attested-at').value = ATTESTED;
  el('evidence-ref').value = EVIDENCE;
  await el('subject-name').input();
  assert.equal(el('grant').disabled, true, 'acknowledgments are still required');
  el('ack-generation').checked = true;
  el('ack-processing').checked = true;
  el('attestation-confirmed').checked = true;
  await el('attestation-confirmed').change();
  const expectedText = renderLuxifyOperatorAttestation({ subjectName: NAME, method: 'recorded_verbal', attestedAt: ATTESTED, identityId: IDENTITY_B }).text;
  assert.equal(el('attestation-text').textContent, expectedText);
  assert.equal(el('grant').disabled, false);
  assertSecretsOffDom(elements, [ACCOUNT]);

  await el('grant-form').submit();
  assert.equal(el('grant-form').defaultPrevented, true);
  const grant = seen.find(body => body.action === 'grant-on-behalf');
  assert.deepEqual(grant, {
    action: 'grant-on-behalf',
    onBehalfOfAccountId: ACCOUNT,
    identityId: IDENTITY_B,
    idempotencyKey: IDEMPOTENCY,
    challenge: CHALLENGE_B,
    noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256,
    cinematicGenerationAuthorization: true,
    providerProcessingAuthorization: true,
    subjectName: NAME,
    attestationMethod: 'recorded_verbal',
    attestedAt: new Date(ATTESTED).toISOString(),
    attestationEvidenceRef: EVIDENCE,
    attestationConfirmed: true,
  });
  assert.equal(grant.challenge === CHALLENGE_A, false);
  assert.equal(grant.cinematicGenerationAuthorization, true);
  assert.equal(grant.attestationConfirmed, true);
  assert.deepEqual(seen[0], { action: 'operator-context', onBehalfOfAccountId: FLAG_PROBE });
  assert.deepEqual(seen[1], { action: 'staff-lookup', email: EMAIL });
  for (const body of seen) assertNoOperator(body);
  assert.deepEqual(seen.map(body => body.action), ['operator-context', 'staff-lookup', 'operator-context', 'grant-on-behalf', 'operator-context']);
  assert.equal(events.filter(event => event[0] === 'fetch').every(event => event[1] === '/api/video-os-lite/luxify-consent' && event[2] === 'POST' && event[3] === 'same-origin' && event[4]['content-type'] === 'application/json'), true);
  assert.match(el('status').textContent, /Confirmation email sent/);
  assert.equal(el('evidence-ref').value, '');
  assert.equal(el('subject-name').value, '');
  assert.equal(el('status').textContent.includes(EVIDENCE), false);
  assert.equal(el('status').textContent.includes(NAME), false);
  assert.equal(el('status').textContent.includes(CHALLENGE_B), false);
  assert.equal(events.some(event => event[0] === 'console'), false);
  assertSecretsOffDom(elements, [ACCOUNT, EVIDENCE, NAME]);
});

test('server errors are shown and the form stays available', async () => {
  const { elements, events, el } = await boot(body => {
    if (body.action === 'operator-context') return [200, contextBody([])];
    if (body.action === 'grant-on-behalf') {
      assertNoOperator(body);
      return [409, { ok: false, code: 'LUXIFY_LOOK_OWNERSHIP_UNPROVEN', error: 'This look is not recorded in the subject account\'s own space.' }];
    }
    throw new Error(`unexpected ${body.action}`);
  });
  el('subject-account').value = ACCOUNT;
  await el('account-form').submit();
  el('subject-name').value = NAME;
  el('method').value = 'written';
  el('attested-at').value = ATTESTED;
  el('evidence-ref').value = EVIDENCE;
  el('ack-generation').checked = true;
  el('ack-processing').checked = true;
  el('attestation-confirmed').checked = true;
  await el('subject-name').input();
  await el('grant-form').submit();
  assert.match(el('status').textContent, /not recorded in the subject account's own space/);
  assert.match(el('status').textContent, /LUXIFY_LOOK_OWNERSHIP_UNPROVEN/);
  assert.equal(el('operator').dataset.state, 'ready');
  assert.equal(el('context-panel').hidden, false);
  assert.equal(el('evidence-ref').value, EVIDENCE);
  assert.equal(posts(events).filter(body => body.action === 'grant-on-behalf').length, 1);
  assert.equal(events.some(event => event[0] === 'console'), false);
});

test('withdraw posts operator-withdraw only, and cancelling does not', async () => {
  let allow = false;
  const seen = [];
  const { elements, events, el } = await boot(body => {
    seen.push(body);
    if (body.action === 'operator-context') return [200, contextBody(allow ? [{ ...pendingConsent, status: 'withdrawn' }] : undefined)];
    if (body.action === 'operator-withdraw') {
      allow = true;
      return [200, { ok: true, consent: { id: body.consentId, status: 'withdrawn' } }];
    }
    throw new Error(`unexpected ${body.action}`);
  }, { confirm: () => allow });
  el('subject-account').value = ACCOUNT;
  await el('account-form').submit();
  const controls = buttons(el('consents'));
  assert.equal(controls.length, 2, 'self consents have no withdraw control');
  await controls[0].click();
  assert.equal(seen.some(body => body.action === 'operator-withdraw'), false);
  allow = true;
  await controls[0].click();
  const withdrawal = seen.find(body => body.action === 'operator-withdraw');
  assert.deepEqual(withdrawal, { action: 'operator-withdraw', consentId: CONSENT_PENDING });
  assertNoOperator(withdrawal);
  assert.match(el('status').textContent, /Consent withdrawn/);
  assert.match(el('consents').children[0].textContent, /withdrawn/);
  assert.equal(el('status').textContent.includes(ACCOUNT), false);
  assert.equal(el('status').textContent.includes(CONSENT_PENDING), false);
  assert.equal(treeText(el('consents')).join('\n').includes(CONSENT_PENDING), false);
  assert.equal(events.some(event => event[0] === 'console'), false);
  assertSecretsOffDom(elements, [CHALLENGE_A]);
});

test('staff lookup refusal does not load a subject or echo the email', async () => {
  const seen = [];
  const { events, el } = await boot(body => {
    seen.push(body);
    if (body.action === 'operator-context' && body.onBehalfOfAccountId === FLAG_PROBE) return [403, { ok: false, code: 'LUX_CONSENT_OPERATOR_REQUIRED', error: 'Only a Lux consent operator can record consent on behalf of a subject.' }];
    return [403, { ok: false, code: 'LUX_STAFF_PAGE_FORBIDDEN', error: 'This page is only for the Lux owner account and Lux staff.' }];
  });
  el('subject-email').value = EMAIL;
  await el('email-form').submit();
  assert.deepEqual(seen.map(body => body.action), ['operator-context', 'staff-lookup']);
  assert.deepEqual(seen[1], { action: 'staff-lookup', email: EMAIL });
  assert.equal(seen.some(body => body.onBehalfOfAccountId === ACCOUNT), false);
  assertNoOperator(seen[1]);
  assert.match(el('status').textContent, /Lux owner account and Lux staff/);
  assert.match(el('status').textContent, /account id/i);
  assert.equal(el('status').textContent.includes(EMAIL), false);
  assert.equal(el('operator').dataset.state === 'unavailable', false);
  assert.equal(events.some(event => event[0] === 'console'), false);
});

test('M10: Grant stays disabled until the attestation is confirmed', async () => {
  const seen = [];
  const { el } = await boot(body => {
    seen.push(body);
    if (body.action === 'operator-context' && body.onBehalfOfAccountId === FLAG_PROBE) {
      return [200, { ok: true, identities: [], consents: [] }];
    }
    if (body.action === 'operator-context') return [200, contextBody()];
    throw new Error(`unexpected ${body.action}`);
  });
  el('subject-account').value = ACCOUNT;
  await el('account-form').submit();
  fillGrant(el, { attest: false });
  await el('ack-generation').change();
  assert.equal(el('grant').disabled, true);
  await el('grant-form').submit();
  assert.equal(seen.some(body => body.action === 'grant-on-behalf'), false);
  el('attestation-confirmed').checked = true;
  await el('attestation-confirmed').change();
  assert.equal(el('grant').disabled, false);
});

test('M20: Grant stays disabled after the feature is turned off', async () => {
  const { el } = await boot(body => {
    if (body.action === 'grant-on-behalf') return [503, { ok: false, code: 'luxify_consent_obo_unavailable', error: 'On-behalf LUXIFY consent is turned off.' }];
    if (body.action === 'operator-context') return [200, contextBody()];
    throw new Error(`unexpected ${body.action}`);
  });
  el('subject-account').value = ACCOUNT;
  await el('account-form').submit();
  fillGrant(el, { attest: true });
  await el('attestation-confirmed').change();
  assert.equal(el('grant').disabled, false);
  await el('grant-form').submit();
  assert.equal(el('operator').dataset.state, 'unavailable');
  assert.equal(el('lookup-panel').hidden, true);
  assert.equal(el('context-panel').hidden, true);
  assert.equal(el('grant').disabled, true);
  await el('subject-name').input();
  await el('attestation-confirmed').change();
  assert.equal(el('grant').disabled, true);
  assert.equal(el('attestation-text').textContent, '');
  assert.match(el('status').textContent, /not enabled/i);
});

test('/luxify-operator is a no-store page and the script never logs or sends an operator id', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const routes = vercel.routes;
  const index = routes.findIndex(entry => entry.src === '/luxify-operator');
  const fallback = routes.findIndex(entry => entry.src === '/(.*)');
  assert.ok(index > routes.findIndex(entry => entry.src === '/luxify-staff'));
  assert.ok(index < fallback);
  assert.deepEqual(routes[index], {
    src: '/luxify-operator',
    dest: '/luxify-operator.html',
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
  for (const earlier of routes.slice(0, index)) assert.equal(new RegExp(`^${earlier.src}$`).test('/luxify-operator'), false);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  const controls = [...html.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)].map(match => match[0]);
  assert.ok(controls.some(tag => tag.includes('id="subject-email"')));
  assert.ok(controls.some(tag => tag.includes('id="subject-account"')));
  for (const tag of controls) assert.doesNotMatch(tag, /\bname\s*=/, tag);
  for (const id of ['find-subject', 'load-context', 'grant']) {
    const tag = html.match(new RegExp(`<button id="${id}"[^>]*>`));
    assert.ok(tag, id);
    assert.match(tag[0], /\sdisabled(?:\s|>|=)/);
  }
  assert.match(html.match(/<section id="lookup-panel"[^>]*>/)[0], /\shidden(?:\s|>)/);
  assert.match(html.match(/<section id="context-panel"[^>]*>/)[0], /\shidden(?:\s|>)/);
  assert.match(html, /<form id="grant-form"/);
  assert.match(html, /<option value="written">/);
  assert.match(html, /<option value="recorded_verbal">/);
  assert.match(html, /<script type="module" src="\/luxify-operator\.js"><\/script>/);
  assert.doesNotMatch(html, /operatorAccountId|operatorId|vos_session/);
  assert.match(readFileSync(new URL('../public/luxify-staff.html', import.meta.url), 'utf8'), /href="\/luxify-operator"/);
  assert.match(script, /const endpoint = '\/api\/video-os-lite\/luxify-consent';/);
  assert.match(script, /credentials: 'same-origin'/);
  assert.doesNotMatch(script, /console\.(?:log|info|warn|error|debug|trace)/);
  assert.doesNotMatch(script, /innerHTML|operatorAccountId|document\.cookie|['"]vos_session['"]/);
});
