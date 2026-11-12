import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { handleAuthRequest } from '../api/video-os-lite/auth.js';
import { prefersHtmlResponse, signInFailureReason, signInLinkRedirect } from '../lib/sign-in-link.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const TOKEN = 'magic-token-should-not-leak';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
}

function request({ url, accept, method = 'GET' }) {
  return {
    method,
    url,
    headers: { host: 'video.example', ...(accept ? { accept } : {}) },
    async *[Symbol.asyncIterator]() {},
  };
}

function magicDeps(message) {
  return {
    env: {},
    magicLink: {
      validate: async () => { throw Object.assign(new Error(message), { statusCode: 401 }); },
    },
  };
}

test('browser Accept prefers HTML only when text/html is at least as wanted as JSON', () => {
  assert.equal(prefersHtmlResponse(HTML), true);
  assert.equal(prefersHtmlResponse('application/json'), false);
  assert.equal(prefersHtmlResponse('*/*'), false);
  assert.equal(prefersHtmlResponse(''), false);
  assert.equal(prefersHtmlResponse('text/html;q=0.8, application/json'), false);
  assert.equal(prefersHtmlResponse('application/json, text/html;q=0.9'), false);
  assert.equal(signInFailureReason(new Error('This sign-in link expired.'), 'auth-verify'), 'expired');
  assert.equal(signInFailureReason(new Error('This sign-in link was already used.'), 'auth-verify'), 'used');
  assert.equal(signInFailureReason(new Error('This sign-in link is invalid.'), 'auth-verify'), 'invalid');
  assert.equal(signInFailureReason(new Error('Google sign-in was cancelled.'), 'google-callback'), 'google');
  assert.equal(signInFailureReason(Object.assign(new Error('Sign-in storage is temporarily unavailable. Please try again shortly.'), { statusCode: 503 }), 'auth-verify'), 'unavailable');
  assert.equal(signInFailureReason(Object.assign(new Error('The sign-in token could not be consumed safely.'), { statusCode: 503 }), 'auth-verify'), 'unavailable');
  assert.equal(signInFailureReason(Object.assign(new Error('Google sign-in was cancelled.'), { statusCode: 503 }), 'google-callback'), 'unavailable');
  assert.equal(signInLinkRedirect('google'), '/sign-in-link?reason=google');
  assert.equal(signInLinkRedirect('unavailable'), '/sign-in-link?reason=unavailable');
  assert.equal(signInLinkRedirect('nope'), '/sign-in-link?reason=invalid');
});

test('browser sign-in failures redirect to a token-free page and API clients keep JSON', async () => {
  const cases = [
    ['This sign-in link expired.', 'expired', 'This sign-in link expired.'],
    ['This sign-in link was already used.', 'used', 'This sign-in link was already used.'],
    ['This sign-in link is invalid.', 'invalid', 'This sign-in link isn\'t valid.'],
  ];
  for (const [message, reason] of cases) {
    const html = response();
    await handleAuthRequest(request({
      url: `/api/video-os-lite/auth-verify?token=${TOKEN}`,
      accept: HTML,
    }), html, magicDeps(message));
    assert.equal(html.statusCode, 303);
    assert.equal(html.headers.Location, `/sign-in-link?reason=${reason}`);
    assert.equal(html.headers['Cache-Control'], 'no-store');
    assert.equal(html.headers['Referrer-Policy'], 'no-referrer');
    assert.equal(String(html.body || '').includes(TOKEN), false);
    assert.equal(html.headers.Location.includes(TOKEN), false);
    assert.equal(html.headers.Location.includes('@'), false);

    const json = response();
    await handleAuthRequest(request({
      url: `/api/video-os-lite/auth-verify?token=${TOKEN}`,
      accept: 'application/json',
    }), json, magicDeps(message));
    assert.equal(json.statusCode, 401);
    assert.match(json.headers['Content-Type'], /application\/json/);
    const payload = JSON.parse(json.body);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, message);
    assert.equal(json.body.includes(TOKEN), false);
  }
});

test('a browser storage failure gets its own try-again page', async () => {
  const html = response();
  await handleAuthRequest(request({
    url: `/api/video-os-lite/auth-verify?token=${TOKEN}`,
    accept: HTML,
  }), html, {
    env: {},
    magicLink: {
      validate: async () => {
        throw Object.assign(new Error('Sign-in storage is temporarily unavailable. Please try again shortly.'), { statusCode: 503 });
      },
    },
  });
  assert.equal(html.statusCode, 303);
  assert.equal(html.headers.Location, '/sign-in-link?reason=unavailable');
  assert.equal(html.headers.Location.includes(TOKEN), false);

  const json = response();
  await handleAuthRequest(request({
    url: `/api/video-os-lite/auth-verify?token=${TOKEN}`,
    accept: 'application/json',
  }), json, {
    env: {},
    magicLink: {
      validate: async () => {
        throw Object.assign(new Error('Sign-in storage is temporarily unavailable. Please try again shortly.'), { statusCode: 503 });
      },
    },
  });
  assert.equal(json.statusCode, 503);
  assert.match(JSON.parse(json.body).error, /storage is temporarily unavailable/);
});

test('a browser Google callback failure explains that sign-in was cancelled or is unavailable', async () => {
  const html = response();
  await handleAuthRequest(request({
    url: '/api/video-os-lite/google-callback?error=access_denied&state=state-secret',
    accept: HTML,
  }), html, { env: {} });
  assert.equal(html.statusCode, 303);
  assert.equal(html.headers.Location, '/sign-in-link?reason=google');
  assert.equal(html.headers.Location.includes('state-secret'), false);
  assert.equal(String(html.body || '').includes('state-secret'), false);

  const json = response();
  await handleAuthRequest(request({
    url: '/api/video-os-lite/google-callback?error=access_denied',
    accept: 'application/json',
  }), json, { env: {} });
  assert.equal(json.statusCode, 401);
  assert.equal(JSON.parse(json.body).error, 'Google sign-in was cancelled.');

  const unavailable = response();
  await handleAuthRequest(request({
    url: '/api/video-os-lite/google-callback?code=abc',
    accept: HTML,
  }), unavailable, { env: {} });
  assert.equal(unavailable.headers.Location, '/sign-in-link?reason=google');
});

test('the sign-in page names each reason and posts a new link to the existing endpoint', async () => {
  const [html, client] = await Promise.all([
    readFile(new URL('../public/sign-in-link.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/sign-in-link.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /This sign-in link expired\./);
  assert.match(html, /This sign-in link was already used\./);
  assert.match(html, /This sign-in link isn't valid\./);
  assert.match(html, /Google sign-in was cancelled or isn't available\./);
  assert.match(html, /Something went wrong, try again\./);
  assert.match(html, /Send me a new link/);
  assert.match(html, /id="resend-email"/);
  assert.match(client, /\/api\/video-os-lite\/auth-request/);
  assert.match(client, /Accept: 'application\/json'/);
  assert.match(client, /JSON\.stringify\(\{ email \}\)/);
  assert.doesNotMatch(client, /console\.(log|info|debug|error)/);
  const routes = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8')).routes;
  assert.ok(routes.some(route => route.src === '/sign-in-link' && route.dest === '/sign-in-link.html'));
});
