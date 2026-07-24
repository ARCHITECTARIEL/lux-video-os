import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './schema.js';

neonConfig.webSocketConstructor = ws;

let client;
let pool;
export const databaseDriver = 'neon-serverless';

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

export function database() {
  const url = configuredDatabaseUrl();
  pool ||= new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000 });
  client ||= drizzle({ client: pool, schema });
  return client;
}
