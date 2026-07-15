import assert from 'node:assert/strict';
import test from 'node:test';

import renderHandler from '../api/video-os-lite/render-v2.js';


function request(body, headers = {}) {
  return {
    method: 'POST',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
}


function response() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
}


test('anonymous render requests are rejected before provider payload validation', async () => {
  const res = response();

  await renderHandler(request({}), res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'Sign in to render videos.');
});
