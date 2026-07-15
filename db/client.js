import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './schema.js';

neonConfig.webSocketConstructor = ws;

let client;
let pool;
export const databaseDriver = 'neon-serverless';

export function database() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) throw Object.assign(new Error('DATABASE_URL is not configured.'), { statusCode: 503, failureCategory: 'CONFIG_MISSING' });
  pool ||= new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000 });
  client ||= drizzle({ client: pool, schema });
  return client;
}
