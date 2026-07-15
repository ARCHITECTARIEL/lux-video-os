import assert from 'node:assert/strict';
import test from 'node:test';

import adminHandler from '../api/video-os-lite/admin.js';
import checkoutHandler from '../api/video-os-lite/checkout-v2.js';
import downloadHandler from '../api/video-os-lite/download-v2.js';
import { resolvePasswordAccess } from '../api/video-os-lite/auth.js';
import { databaseDriver } from '../db/client.js';
import { clearAdminCookie } from '../lib/video-os-account.js';
import { assertAllowedMediaUrl, publicOrigin } from '../lib/video-os-security.js';
import { applyStripeEvent } from '../lib/video-os-credits.js';

function req(method = 'GET', headers = {}, body = {}) {
  return { method, headers, url: '/api/test', body, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
}

function res() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, write() {}, end(body = '') { this.raw = body; try { this.body = JSON.parse(body); } catch {} } };
}

test('checkout authenticates before revealing its disabled state', async () => {
  delete process.env.VIDEO_OS_BILLING_ENABLED;
  const response = res();
  await checkoutHandler(req('POST'), response);
  assert.equal(response.statusCode, 401);
});

test('public origin fails closed instead of trusting the request host', () => {
  delete process.env.VIDEO_OS_PUBLIC_ORIGIN;
  assert.throws(() => publicOrigin(req('GET', { host: 'attacker.example' })), /not configured/);
  process.env.VIDEO_OS_PUBLIC_ORIGIN = 'https://video.example';
  assert.equal(publicOrigin(), 'https://video.example');
  delete process.env.VIDEO_OS_PUBLIC_ORIGIN;
});

test('logout has an explicit privileged-cookie revocation', () => {
  assert.match(clearAdminCookie(), /^vos_admin=;/);
  assert.match(clearAdminCookie(), /Max-Age=0/);
});

test('admin fails closed without configured bearer or admin cookie', async () => {
  delete process.env.VIDEO_OS_ADMIN_TOKEN;
  const response = res();
  await adminHandler(req('GET'), response);
  assert.equal(response.statusCode, 401);
});

test('media policy rejects localhost, HTTP, and unallowlisted hosts', () => {
  process.env.VIDEO_OS_PROVIDER_MEDIA_HOSTS = 'media.heygen.example';
  assert.throws(() => assertAllowedMediaUrl('http://media.heygen.example/a.mp4'));
  assert.throws(() => assertAllowedMediaUrl('https://127.0.0.1/a.mp4'));
  assert.throws(() => assertAllowedMediaUrl('https://evil.example/a.mp4'));
  assert.equal(assertAllowedMediaUrl('https://cdn.media.heygen.example/a.mp4').hostname, 'cdn.media.heygen.example');
});

test('download requires a customer session before selecting a job', async () => {
  const response = res();
  await downloadHandler(req('GET'), response);
  assert.equal(response.statusCode, 401);
});

test('one Stripe event can change credit state only once', () => {
  const initial = { balance: 180, purchased: 0, appliedStripeEvents: {} };
  const first = applyStripeEvent(initial, { eventId: 'evt_once', sessionId: 'cs_once', credits: 500 });
  const second = applyStripeEvent(first.state, { eventId: 'evt_once', sessionId: 'cs_once', credits: 500 });
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.state.balance, 680);
  assert.equal(second.state.purchased, 500);
});

test('workspace login distinguishes demo and owner credentials without leaking secrets', () => {
  process.env.VIDEO_OS_DEMO_USERNAME = 'demo-user';
  process.env.VIDEO_OS_DEMO_PASSWORD = 'demo-secret';
  process.env.VIDEO_OS_ADMIN_USERNAME = 'owner-user';
  process.env.VIDEO_OS_ADMIN_PASSWORD = 'owner-secret';

  assert.equal(resolvePasswordAccess('demo', 'demo-user', 'demo-secret'), 'demo');
  assert.equal(resolvePasswordAccess('owner', 'owner-user', 'owner-secret'), 'owner');
  assert.throws(() => resolvePasswordAccess('owner', 'demo-user', 'demo-secret'), /Invalid owner credentials/);
  assert.throws(() => resolvePasswordAccess('unknown', 'demo-user', 'demo-secret'), /Choose Demo or Owner access/);
});
test('database client uses the transaction-capable Neon serverless driver', () => {
  assert.equal(databaseDriver, 'neon-serverless');
});
