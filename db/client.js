import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './schema.js';

neonConfig.webSocketConstructor = ws;

let client;
let pool;
let poolUrl;
export const databaseDriver = 'neon-serverless';

// A cached WebSocket connection can go silently stale between warm
// serverless invocations (the Neon proxy can drop it server-side without
// the client ever seeing a close event). Without a query-level timeout,
// the next query on that dead socket awaits forever -- no error, no
// non-2xx response, nothing -- which is exactly what happened to the
// first real standard-narration consent request in production on
// 2026-09-23. query_timeout is enforced client-side (so it fires even if
// the socket never delivers anything); statement_timeout is enforced by
// Postgres itself as defense in depth.
const QUERY_TIMEOUT_MILLIS = 10_000;

function configuredDatabaseUrl() {
  const url = String(process.env.DATABASE_URL || '').trim();
  try {
    const parsed = new URL(url);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === '/') throw new Error('invalid');
  } catch {
    throw Object.assign(new Error('Database configuration is unavailable.'), { statusCode: 503, failureCategory: 'CONFIG_MISSING' });
  }
  return url;
}

export function assertDatabaseConfigured() {
  configuredDatabaseUrl();
  return true;
}

function createPool(url) {
  const created = new Pool({
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: QUERY_TIMEOUT_MILLIS,
    query_timeout: QUERY_TIMEOUT_MILLIS,
  });
  // Evict the cached pool/client on a detected connection error, instead
  // of silently reusing a socket that has already failed once.
  created.on('error', () => {
    if (pool === created) { pool = undefined; client = undefined; poolUrl = undefined; }
  });
  return created;
}

export function database() {
  const url = configuredDatabaseUrl();
  if (pool && poolUrl !== url) {
    const previousPool = pool;
    pool = undefined;
    client = undefined;
    poolUrl = undefined;
    // Existing borrowers finish on their original connection; new calls must
    // never silently query that target after the canonical configuration moves.
    void previousPool.end().catch(() => {});
  }
  if (!pool) {
    pool = createPool(url);
    poolUrl = url;
  }
  client ||= drizzle({ client: pool, schema });
  return client;
}

// Test-only: forces the next database() call to build a fresh pool/client,
// so tests can exercise createPool()'s error-eviction behavior without
// depending on cross-test module state.
export function resetDatabaseForTests() {
  pool = undefined;
  client = undefined;
  poolUrl = undefined;
}

// Test-only: exposes the currently cached pool so tests can assert that a
// detected connection error actually evicts and rebuilds it, rather than
// silently reusing a dead one.
export function currentPoolForTests() {
  return pool;
}
