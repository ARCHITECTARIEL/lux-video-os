import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from '../server/index.js';

const aliases = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  .routes.filter(({ dest }) => new Set([
    '/api/video-os-lite/auth.js', '/api/video-os-lite/checkout-v2.js',
    '/api/video-os-lite/download-v2.js', '/api/video-os-lite/finalize-v2.js',
    '/api/video-os-lite/render-v2.js', '/api/video-os-lite/stripe-webhook-v2.js',
    '/api/video-os-lite/uploads.js', '/api/video-os-lite/workspace.js',
    '/api/video-os/talent.js',
  ]).has(dest)).map(({ src }) => src);

test('the shared route table denies mapped APIs while its fallback stays 404', async () => {
  const prior = process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE;
  process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE = 'true';
  const server = createServer();
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal(aliases.length, 31);
    for (const alias of aliases) {
      for (const method of ['GET', 'POST']) {
        const response = await fetch(`${origin}${alias}`, {
          method,
          ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}),
        });
        const fallback = alias === '/api/(.*)';
        assert.equal(response.status, fallback ? 404 : 503, `${method} ${alias}`);
        assert.equal((await response.json()).code, fallback ? 'not_found' : 'diagnostic_maintenance_active');
      }
    }
    const diagnostic = await fetch(`${origin}/api/video-os-lite/admin?operation=db-binding`);
    assert.equal(diagnostic.status, 404);
    const staticPage = await fetch(`${origin}/privacy`);
    assert.equal(staticPage.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (prior === undefined) delete process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE;
    else process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE = prior;
  }
});
