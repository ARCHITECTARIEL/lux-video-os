import assert from 'node:assert/strict';
import test from 'node:test';
import { exchangeGoogleCode, fetchGoogleProfile, googleAuthorizationUrl, googleOAuthConfigured } from '../lib/google-oauth.js';

const originalFetch = globalThis.fetch;
const originalEnvironment = { GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET };

function restoreEnvironment() {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test.afterEach(restoreEnvironment);

test('googleOAuthConfigured requires both the client id and secret', () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.equal(googleOAuthConfigured(), false);
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  assert.equal(googleOAuthConfigured(), false);
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  assert.equal(googleOAuthConfigured(), true);
});

test('googleAuthorizationUrl builds the exact Google endpoint with a locked-down scope', () => {
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  const url = new URL(googleAuthorizationUrl({ redirectUri: 'https://video-os.example/api/video-os-lite/google-callback', state: 'proof-state' }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://video-os.example/api/video-os-lite/google-callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('state'), 'proof-state');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
});

test('googleAuthorizationUrl refuses to build a URL when unconfigured', () => {
  delete process.env.GOOGLE_CLIENT_ID;
  assert.throws(() => googleAuthorizationUrl({ redirectUri: 'https://video-os.example/cb', state: 's' }), { statusCode: 501 });
});

test('exchangeGoogleCode posts the exact token-exchange parameters and returns the parsed tokens', async () => {
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, body: options.body.toString() };
    return new Response(JSON.stringify({ access_token: 'access-token-proof', id_token: 'id-token-proof' }), { status: 200 });
  };
  const tokens = await exchangeGoogleCode({ code: 'auth-code-proof', redirectUri: 'https://video-os.example/api/video-os-lite/google-callback' });
  assert.equal(captured.url, 'https://oauth2.googleapis.com/token');
  const params = new URLSearchParams(captured.body);
  assert.equal(params.get('code'), 'auth-code-proof');
  assert.equal(params.get('client_id'), 'client-id');
  assert.equal(params.get('client_secret'), 'client-secret');
  assert.equal(params.get('redirect_uri'), 'https://video-os.example/api/video-os-lite/google-callback');
  assert.equal(params.get('grant_type'), 'authorization_code');
  assert.equal(tokens.access_token, 'access-token-proof');
});

test('exchangeGoogleCode fails closed on a non-200 response without leaking the response body', async () => {
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'sensitive detail' }), { status: 400 });
  await assert.rejects(
    exchangeGoogleCode({ code: 'bad-code', redirectUri: 'https://video-os.example/cb' }),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.doesNotMatch(error.message, /sensitive detail/);
      return true;
    },
  );
});

test('fetchGoogleProfile normalizes the email and rejects an unverified one', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://openidconnect.googleapis.com/v1/userinfo');
    assert.equal(options.headers.Authorization, 'Bearer access-token-proof');
    return new Response(JSON.stringify({ email: 'Proof@Example.COM', email_verified: true, name: 'Proof User', sub: 'google-sub-1' }), { status: 200 });
  };
  const profile = await fetchGoogleProfile('access-token-proof');
  assert.equal(profile.email, 'proof@example.com');
  assert.equal(profile.name, 'Proof User');
  assert.equal(profile.sub, 'google-sub-1');
});

test('fetchGoogleProfile rejects an unverified email even with a 200 response', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ email: 'unverified@example.com', email_verified: false }), { status: 200 });
  await assert.rejects(fetchGoogleProfile('token'), { statusCode: 401 });
});
