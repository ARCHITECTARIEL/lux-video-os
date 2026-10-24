import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { consumeGlobalCounter } from '../db/repositories.js';
import { globalCounters } from '../db/schema.js';

const raceUrl = process.env.VIDEO_OS_PG_RACE_TEST_URL;

test('100 concurrent global consumes admit exactly 25 and an expired window resets', {
  skip: !raceUrl && 'VIDEO_OS_PG_RACE_TEST_URL is unset',
  timeout: 120_000,
}, async () => {
  const parsed = new URL(raceUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'race target must be loopback');
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /^(?:race|throwaway|vos_race)[a-z0-9_]*$/, 'race target must be disposable');
  const proxy = process.env.VIDEO_OS_PG_RACE_TEST_WSPROXY;
  assert.match(proxy || '', /^(?:localhost|127\.0\.0\.1):(?:[1-9]\d{0,4})$/, 'local WebSocket proxy required');
  const { Pool, neonConfig } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-serverless');
  const ws = (await import('ws')).default;
  neonConfig.webSocketConstructor = ws;
  neonConfig.wsProxy = () => `${proxy}/v1`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
  const pool = new Pool({ connectionString: raceUrl, max: 20, connectionTimeoutMillis: 15_000, query_timeout: 30_000 });
  pool.on('error', () => {});
  const executor = drizzle({ client: pool });
  const key = `test:global-counter:${randomUUID()}`;
  try {
    const consume = () => consumeGlobalCounter({ key, limit: 25, windowMs: 86_400_000, executor });
    const results = await Promise.all(Array.from({ length: 100 }, consume));
    assert.equal(results.filter(Boolean).length, 25);
    const [exhausted] = await executor.select().from(globalCounters).where(eq(globalCounters.key, key));
    assert.equal(exhausted.count, 100);
    await executor.update(globalCounters).set({ expiresAt: new Date(0) }).where(eq(globalCounters.key, key));
    assert.equal(await consume(), true);
    const [reset] = await executor.select().from(globalCounters).where(eq(globalCounters.key, key));
    assert.equal(reset.count, 1);
    assert.ok(reset.windowStart > exhausted.windowStart);
  } finally {
    await executor.delete(globalCounters).where(eq(globalCounters.key, key)).catch(() => {});
    await pool.end();
  }
});
