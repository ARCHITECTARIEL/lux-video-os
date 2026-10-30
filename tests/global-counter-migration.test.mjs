import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('0017 creates only the account-independent global counter and extends the snapshot chain', async () => {
  const [sql, previousText, currentText, journalText] = await Promise.all([
    read('../drizzle/0017_global_counters.sql'),
    read('../drizzle/meta/0016_snapshot.json'),
    read('../drizzle/meta/0017_snapshot.json'),
    read('../drizzle/meta/_journal.json'),
  ]);
  assert.match(sql, /^CREATE TABLE "global_counters" \(/);
  assert.match(sql, /"key" text PRIMARY KEY NOT NULL/);
  assert.match(sql, /"window_start" timestamp with time zone NOT NULL/);
  assert.match(sql, /"count" integer DEFAULT 0 NOT NULL/);
  assert.match(sql, /"expires_at" timestamp with time zone NOT NULL/);
  assert.doesNotMatch(sql, /account_id|REFERENCES|ON DELETE/i);

  const previous = JSON.parse(previousText);
  const current = JSON.parse(currentText);
  const journal = JSON.parse(journalText);
  assert.equal(current.prevId, previous.id);
  assert.deepEqual(Object.keys(current.tables).filter(name => !previous.tables[name]), ['public.global_counters']);
  for (const [name, table] of Object.entries(previous.tables)) assert.deepEqual(current.tables[name], table, `${name} changed unexpectedly`);
  const table = current.tables['public.global_counters'];
  assert.deepEqual(Object.keys(table.columns), ['key', 'window_start', 'count', 'expires_at']);
  assert.equal(table.columns.key.primaryKey, true);
  assert.equal(table.columns.count.default, 0);
  assert.deepEqual(table.foreignKeys, {});
  const entry = journal.entries.find(item => item.idx === 17);
  assert.deepEqual(entry, {
    idx: 17, version: '7', when: entry.when,
    tag: '0017_global_counters', breakpoints: true,
  });
  assert.ok(entry.when > journal.entries.find(item => item.idx === 16).when);
});
