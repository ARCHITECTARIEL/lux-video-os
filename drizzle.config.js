import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './db/schema.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL || 'postgresql://missing:missing@localhost:5432/missing' },
  strict: true,
  verbose: true,
});
