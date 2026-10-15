import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setAccountRole, updateAuthenticatedAccount, ROLE } from '../db/repositories.js';
import { migrationPlan } from '../tools/check-migrations.mjs';

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (/\.[cm]?js$/.test(entry.name)) files.push(path);
  }
  return files;
}

test('account roles are a closed enum and reject admin before database access', async () => {
  assert.deepEqual(Object.values(ROLE), ['customer', 'tester', 'workspace', 'ceo']);
  for (const role of ['admin', 'owner', null, undefined, {}, 'CEO']) {
    if (role === undefined) continue; // omitted role intentionally defaults to customer
    await assert.rejects(updateAuthenticatedAccount({ accountId: 'test', role }), TypeError);
  }
  for (const role of ['ceo', 'workspace']) {
    await assert.rejects(updateAuthenticatedAccount({ accountId: 'test', role }), TypeError);
  }
  await assert.rejects(setAccountRole('test', 'tester', { actor: 'system_grant' }), TypeError);
});

test('routes and API never derive a users.role write from request input', async () => {
  for (const file of [...await filesUnder('routes'), ...await filesUnder('api')]) {
    const source = await readFile(file, 'utf8');
    // Static grep guard: role assignments using direct request sources are forbidden.
    assert.doesNotMatch(source, /\brole\s*:\s*(?:payload|req\.(?:body|query)|url\.searchParams)(?:\b|\[|\.)/i, file);
    assert.doesNotMatch(source, /\b(?:const|let)\s+role\s*=\s*(?:payload|req\.(?:body|query)|url\.searchParams)(?:\b|\[|\.)/i, file);
  }
});

test('0014 journal, SQL, and snapshot represent the role guard without changing prior schema', async () => {
  const plan = await migrationPlan();
  assert.equal(plan.migrations.length, 15);
  assert.equal(plan.migrations.at(-1).tag, '0014_pre_role_guard');
  const sql = await readFile('drizzle/0014_pre_role_guard.sql', 'utf8');
  for (const required of ['users_role_ck', 'users_role_guard()', 'users_role_guard_tg', "current_setting('lux.role_write', true)", 'users.role has unexpected values']) assert.ok(sql.includes(required));
  const previous = JSON.parse(await readFile('drizzle/meta/0013_snapshot.json', 'utf8'));
  const current = JSON.parse(await readFile('drizzle/meta/0014_snapshot.json', 'utf8'));
  assert.equal(current.prevId, previous.id);
  assert.deepEqual(current.tables['public.users'].checkConstraints.users_role_ck, {
    name: 'users_role_ck', value: `"users"."role" in ('customer', 'tester', 'workspace', 'ceo')`,
  });
  delete current.tables['public.users'].checkConstraints.users_role_ck;
  for (const snapshot of [previous, current]) { delete snapshot.id; delete snapshot.prevId; }
  assert.deepEqual(current, previous);
});
