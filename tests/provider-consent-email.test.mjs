import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProviderConsentInvitationEmailConfigured, sendProviderConsentInvitationEmail } from '../lib/video-os-notifications.js';

const env = { RESEND_API_KEY: 'test-only', AUTH_FROM_EMAIL: 'Video OS <noreply@example.test>' };
const invitation = {
  email: 'presenter@example.test',
  url: 'https://video.example/provider-consent?invite=opaque-token',
  expiresAt: '2026-10-07T18:15:00.000Z',
};

test('invitation email fails before any send when sender configuration is absent', async () => {
  assert.throws(() => assertProviderConsentInvitationEmailConfigured({}), /not configured/);
  await assert.rejects(sendProviderConsentInvitationEmail(invitation, { env: {}, fetchImpl: async () => { throw new Error('must not send'); } }), /not configured/);
});

test('invitation email sends only the local subject link with a short expiry', async () => {
  let request;
  const sent = await sendProviderConsentInvitationEmail(invitation, {
    env,
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, text: async () => '{"id":"test-message"}' }; },
  });
  assert.deepEqual(sent, { sent: true });
  assert.equal(request.url, 'https://api.resend.com/emails');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.to, ['presenter@example.test']);
  assert.match(body.text, /https:\/\/video\.example\/provider-consent\?invite=opaque-token/);
  assert.match(body.text, /15 minutes/);
  assert.equal(JSON.stringify(body).includes('heygen.com'), false);
  assert.equal(JSON.stringify(body).includes('providerGroupId'), false);
});

test('invitation email exposes no provider response on rejection', async () => {
  await assert.rejects(sendProviderConsentInvitationEmail(invitation, {
    env,
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => '{"message":"private provider detail"}' }),
  }), error => error.statusCode === 502 && !error.message.includes('private provider detail'));
});
