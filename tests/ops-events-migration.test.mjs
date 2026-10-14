import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { migrationPlan } from '../tools/check-migrations.mjs';

const migrationUrl = new URL('../drizzle/0012_legal_magneto.sql', import.meta.url);
const snapshotUrl = new URL('../drizzle/meta/0012_snapshot.json', import.meta.url);
const NORMALIZED_MIGRATION_SHA256 = '2f67174db6480484b239dbe8746fcdaac43b261c6843216c3d311d7b84d8d004';

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('0012 is an additive ops_events-only migration with documented retention', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).replace(/\r\n/g, '\n');

  assert.equal(sha256(sql), NORMALIZED_MIGRATION_SHA256);
  assert.match(sql, /^CREATE TABLE "ops_events"/);
  assert.doesNotMatch(sql, /\b(?:ALTER|DROP|DELETE|UPDATE|TRUNCATE)\b/);
  assert.match(sql, /"id" uuid PRIMARY KEY DEFAULT gen_random_uuid\(\) NOT NULL/);
  assert.match(sql, /"created_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
  assert.match(sql, /"level" text NOT NULL/);
  assert.match(sql, /"event" text NOT NULL/);
  assert.match(sql, /"http_status" integer/);
  assert.match(sql, /"details" jsonb DEFAULT '\{\}'::jsonb NOT NULL/);
  for (const index of ['created_at', 'account_id', 'entity_id', 'code']) {
    assert.match(sql, new RegExp(`CREATE INDEX "ops_events_${index}_idx"`));
  }
  assert.match(sql, /retained for 30 days/);
  assert.match(sql, /does not schedule deletion/);
  assert.match(sql, /Redacted structured metadata only/);
});

test('0012 snapshot and journal describe the same ops_events table', async () => {
  const snapshot = JSON.parse(await readFile(snapshotUrl, 'utf8'));
  const table = snapshot.tables['public.ops_events'];

  assert.ok(table);
  assert.deepEqual(Object.keys(table.columns), [
    'id', 'created_at', 'level', 'event', 'account_id', 'entity_type',
    'entity_id', 'correlation_id', 'code', 'http_status', 'message', 'details',
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(table.columns).map(([name, column]) => [name, {
      type: column.type,
      notNull: column.notNull,
      primaryKey: column.primaryKey,
      default: column.default,
    }])),
    {
      id: { type: 'uuid', notNull: true, primaryKey: true, default: 'gen_random_uuid()' },
      created_at: { type: 'timestamp with time zone', notNull: true, primaryKey: false, default: 'now()' },
      level: { type: 'text', notNull: true, primaryKey: false, default: undefined },
      event: { type: 'text', notNull: true, primaryKey: false, default: undefined },
      account_id: { type: 'text', notNull: false, primaryKey: false, default: undefined },
      entity_type: { type: 'text', notNull: false, primaryKey: false, default: undefined },
      entity_id: { type: 'text', notNull: false, primaryKey: false, default: undefined },
      correlation_id: { type: 'text', notNull: false, primaryKey: false, default: undefined },
      code: { type: 'text', notNull: false, primaryKey: false, default: undefined },
      http_status: { type: 'integer', notNull: false, primaryKey: false, default: undefined },
      message: { type: 'text', notNull: false, primaryKey: false, default: undefined },
      details: { type: 'jsonb', notNull: true, primaryKey: false, default: "'{}'::jsonb" },
    },
  );
  assert.deepEqual(Object.keys(table.indexes), [
    'ops_events_created_at_idx', 'ops_events_account_id_idx',
    'ops_events_entity_id_idx', 'ops_events_code_idx',
  ]);
  assert.deepEqual(table.foreignKeys, {});
  assert.equal(snapshot.tables['public.identity_consents'].checkConstraints.identity_consents_hosted_v3_purpose_ck, undefined);

  const plan = await migrationPlan();
  const migration = plan.migrations.at(-1);
  assert.equal(migration.tag, '0012_legal_magneto');
  assert.equal(migration.hashes[0], NORMALIZED_MIGRATION_SHA256);
  assert.equal(migration.hashes.length, 2);
});
