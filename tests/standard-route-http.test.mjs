// HTTP-handler-level test for routes/video-os-lite/standard.js: proves the
// actual request/response wire contract (auth cookie, origin/content-type
// checks, JSON body shape, status codes) on top of the repository logic
// tests/standard-narration-repository.test.mjs already proves. Skips cleanly
// without DATABASE_URL/BLOB_READ_WRITE_TOKEN, same as that file.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { assertDatabaseConfigured } from '../db/client.js';
import { makeSession } from '../lib/video-os-account.js';
import standardHandler from '../routes/video-os-lite/standard.js';
import { STANDARD_CONTRACT_VERSION, STANDARD_NARRATION_POLICY_VERSION } from '../lib/standard-narration-contract.js';
import { activateStandardNarrationEnv, createStandardAccountFixture } from './helpers/standard-fixtures.mjs';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('no blob token');
} catch {
  dbAvailable = false;
}

const ORIGIN = 'https://video-os-http-test.invalid';

function request({ method = 'GET', url, body, cookie, headers = {} }) {
  const bodyBuffer = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return {
    method,
    url,
    headers: {
      cookie: cookie ? `vos_session=${encodeURIComponent(cookie)}` : undefined,
      origin: ORIGIN,
      'content-type': 'application/json',
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      if (bodyBuffer.length) yield bodyBuffer;
    },
  };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body ? JSON.parse(body) : undefined; },
  };
}

test(
  'Standard route HTTP contract: auth, readiness, consent, quote, revoke',
  { skip: !dbAvailable && 'DATABASE_URL / BLOB_READ_WRITE_TOKEN not configured; skipping live integration test' },
  async (t) => {
    activateStandardNarrationEnv();
    process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
    const fixture = await createStandardAccountFixture();
    t.after(fixture.cleanup);
    const cookie = makeSession(fixture.accountId, null);

    await t.test('an unauthenticated GET is rejected', async () => {
      const res = response();
      await standardHandler(request({ url: '/api/video-os-lite/standard?operation=readiness' }), res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, 'sign_in_required');
    });

    await t.test('readiness reports consent-required for an authenticated owner', async () => {
      const res = response();
      const query = new URLSearchParams({ operation: 'readiness', projectId: fixture.project.id, identityId: fixture.identity.id, audioAssetId: fixture.narrationAssetId });
      await standardHandler(request({ url: `/api/video-os-lite/standard?${query}`, cookie }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.readiness.ready, false);
      assert.equal(res.body.readiness.reasonCode, 'standard_narration_consent_required');
    });

    await t.test('a cross-origin POST is rejected before touching the repository', async () => {
      const res = response();
      await standardHandler(request({
        method: 'POST', url: '/api/video-os-lite/standard', cookie,
        headers: { origin: 'https://not-the-app.invalid' },
        body: { operation: 'consent', contractVersion: STANDARD_CONTRACT_VERSION, projectId: fixture.project.id, identityId: fixture.identity.id, audioAssetId: fixture.narrationAssetId, idempotencyKey: crypto.randomUUID(), policyVersion: STANDARD_NARRATION_POLICY_VERSION, consent: true },
      }), res);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.code, 'origin_not_allowed');
    });

    let consentId;
    await t.test('granting consent over HTTP returns the public consent DTO', async () => {
      const res = response();
      await standardHandler(request({
        method: 'POST', url: '/api/video-os-lite/standard', cookie,
        body: { operation: 'consent', contractVersion: STANDARD_CONTRACT_VERSION, projectId: fixture.project.id, identityId: fixture.identity.id, audioAssetId: fixture.narrationAssetId, idempotencyKey: crypto.randomUUID(), policyVersion: STANDARD_NARRATION_POLICY_VERSION, consent: true },
      }), res);
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.ok, true);
      assert.ok(res.body.consent.id);
      assert.equal(res.body.consent.projectId, fixture.project.id);
      consentId = res.body.consent.id;
    });

    await t.test('readiness now reports ready', async () => {
      const res = response();
      const query = new URLSearchParams({ operation: 'readiness', projectId: fixture.project.id, identityId: fixture.identity.id, audioAssetId: fixture.narrationAssetId, narrationConsentId: consentId });
      await standardHandler(request({ url: `/api/video-os-lite/standard?${query}`, cookie }), res);
      assert.equal(res.body.readiness.ready, true);
    });

    await t.test('requesting a quote over HTTP returns the public quote DTO with an expiry', async () => {
      const res = response();
      await standardHandler(request({
        method: 'POST', url: '/api/video-os-lite/standard', cookie,
        body: { operation: 'quote', contractVersion: STANDARD_CONTRACT_VERSION, projectId: fixture.project.id, identityId: fixture.identity.id, audioAssetId: fixture.narrationAssetId, narrationConsentId: consentId, format: 'vertical' },
      }), res);
      assert.equal(res.statusCode, 201);
      assert.ok(res.body.quote.id);
      assert.equal(res.body.quote.credits, 90);
      assert.ok(new Date(res.body.quote.expiresAt).getTime() > Date.now());
    });

    await t.test('revoking consent over HTTP is idempotent', async () => {
      const res1 = response();
      await standardHandler(request({ method: 'POST', url: '/api/video-os-lite/standard', cookie, body: { operation: 'revoke', contractVersion: STANDARD_CONTRACT_VERSION, consentId } }), res1);
      assert.equal(res1.statusCode, 200);
      assert.ok(res1.body.consent.revokedAt);
      const res2 = response();
      await standardHandler(request({ method: 'POST', url: '/api/video-os-lite/standard', cookie, body: { operation: 'revoke', contractVersion: STANDARD_CONTRACT_VERSION, consentId } }), res2);
      assert.equal(res2.statusCode, 200);
      assert.equal(res2.body.consent.revokedAt, res1.body.consent.revokedAt);
    });

    await t.test('a consumed-but-now-revoked narration consent can no longer back a quote', async () => {
      const res = response();
      await standardHandler(request({
        method: 'POST', url: '/api/video-os-lite/standard', cookie,
        body: { operation: 'quote', contractVersion: STANDARD_CONTRACT_VERSION, projectId: fixture.project.id, identityId: fixture.identity.id, audioAssetId: fixture.narrationAssetId, narrationConsentId: consentId, format: 'vertical' },
      }), res);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, 'standard_narration_consent_invalid');
    });
  },
);
