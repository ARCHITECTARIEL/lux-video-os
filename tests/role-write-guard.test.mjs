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

const requestSource = String.raw`(?:req\.(?:body|query)|(?:url\.)?searchParams|payload|body|input|data|query|await\s+readJson\s*\(\s*req\s*\))`;
const sourceMember = new RegExp(String.raw`(?:${requestSource}|\(\s*await\s+readJson\s*\(\s*req\s*\)\s*\)|req\.headers)\s*(?:\?\.|\.)?\s*(?:\.?\s*(?:role|actor)\b|\[\s*['"](?:role|actor)['"]\s*\]|\.get\s*\(\s*['"](?:role|actor)['"]\s*\))`, 'i');
const requestValue = new RegExp(String.raw`(?:${requestSource})\b`, 'i');

function callArguments(source, name) {
  const calls = [];
  const start = new RegExp(String.raw`\b${name}\s*\(`, 'g');
  for (const match of source.matchAll(start)) {
    let depth = 1;
    let end = match.index + match[0].length;
    for (; end < source.length && depth; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')') depth--;
    }
    calls.push(source.slice(match.index + match[0].length, end - 1));
  }
  return calls;
}

function roleWriteFindings(source) {
  const findings = [];
  const tainted = new Set();
  if (sourceMember.test(source)) findings.push('request role/actor member');
  if (/\b(?:role|actor)\s*:\s*req\.headers\s*\[\s*['"]x-(?:role|actor)['"]\s*\]/i.test(source)) findings.push('request header role/actor');
  for (const match of source.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*([^;\n]+)/g)) {
    if (requestValue.test(match[2]) && /\b(?:role|actor)\b/.test(match[1])) findings.push('request role/actor destructuring');
    if (requestValue.test(match[2])) for (const part of match[1].split(',')) {
      const field = part.trim().match(/^(?:role|actor)\s*(?::\s*([A-Za-z_$][\w$]*))?/);
      if (field) tainted.add(field[1] || part.trim());
    }
  }
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    if (sourceMember.test(match[2])) tainted.add(match[1]);
  }
  for (const name of ['updateAuthenticatedAccount', 'setAccountRole', 'setAccountRoleTx', 'registerAdminTester']) {
    for (const args of callArguments(source, name)) {
      // Repository role writers may receive only explicit object fields at route boundaries.
      if (/\.\.\./.test(args)) findings.push(`${name} spread`);
      if (new RegExp(String.raw`\b(?:role|actor)\s*:\s*(?!['"]|ROLE\.)\b(?:${[...tainted].join('|') || '(?!)'})\b`).test(args)) findings.push(`${name} tainted alias`);
      if (sourceMember.test(args)) findings.push(`${name} request member`);
      if (name === 'updateAuthenticatedAccount' && !/^\s*\{/.test(args)) findings.push(`${name} nonliteral argument`);
      if (name === 'registerAdminTester' && !/^\s*\{/.test(args)) findings.push(`${name} nonliteral argument`);
      for (const field of args.matchAll(/\b(role|actor)\s*:\s*([^,}\n]+)/g)) {
        const value = field[2].trim();
        if (!/^(?:['"][^'"]*['"]|ROLE\.[A-Z_]+|[A-Za-z_$][\w$]*)$/.test(value) || tainted.has(value)) findings.push(`${name} unsafe ${field[1]} value`);
      }
    }
  }
  if (/Object\.assign\s*\([^,]+,\s*(?:req\.(?:body|query)|payload|body|input|data|query)\s*\)/.test(source)) findings.push('request object assignment');
  return findings;
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
    assert.deepEqual(roleWriteFindings(source), [], file);
  }
});

test('static guard catches QA request-source probes and permits server role selection', () => {
  const bad = [
    'role: payload.role', 'role: payload?.role', "role: url.searchParams.get('role')", 'const role = req.body.role',
    'const { role } = req.body', 'let { role, email } = payload', 'const { actor } = input',
    'updateAuthenticatedAccount({ ...req.body })', 'updateAuthenticatedAccount({ accountId, ...payload })',
    'role: body.role', 'role: input.role', 'role: String(payload.role)', 'role: payload.role || "customer"',
    'const r = req.body.role; updateAuthenticatedAccount({ role: r })', "role: payload['role']",
    'role: data.role /* data = await readJson(req) */', 'role: req.headers["x-role"]',
    'role: (await readJson(req)).role', 'Object.assign(update, payload)',
    'setAccountRole(id, input.role, { actor: "admin" })', 'setAccountRoleTx(tx, id, ROLE.TESTER, req.body.actor)',
    'registerAdminTester({ ...body })', 'updateAuthenticatedAccount({ actor: query.actor })',
    'updateAuthenticatedAccount({ role: deriveRole() })',
  ];
  for (const snippet of bad) assert.notDeepEqual(roleWriteFindings(snippet), [], snippet);
  assert.deepEqual(roleWriteFindings("const role = isTester ? 'tester' : 'customer'; updateAuthenticatedAccount({ accountId, role, actor: 'system_bootstrap' })"), []);
});

test('repository privilege settings are transaction-local and confined to transaction writers', async () => {
  const source = await readFile('db/repositories.js', 'utf8');
  let count = 0;
  for (const file of await filesUnder('db')) {
    const contents = await readFile(file, 'utf8');
    for (const call of contents.matchAll(/set_config\s*\(\s*'lux\.role_write'\s*,[^)]*\)/g)) {
      count++;
      assert.match(call[0], /,\s*true\s*\)$/, `${file}: role-write setting must be transaction-local`);
      assert.equal(file.replaceAll('\\', '/'), 'db/repositories.js', 'new role-write callers require transaction audit');
    }
  }
  assert.equal(count, 3, 'audit every role-write setting');
  assert.match(source, /export async function setAccountRole\([^]*?database\(\)\.transaction\(async \(tx\) => \{[^]*?setAccountRoleTx\(tx,/);
  assert.match(source, /export async function updateAuthenticatedAccount\([^]*?database\(\)\.transaction\(async \(tx\) => \{/);
  assert.match(source, /export async function registerAdminTester\([^]*?database\(\)\.transaction\(async \(tx\) => \{[^]*?if \(existingUser && \[ROLE\.CEO, ROLE\.WORKSPACE\][^]*?await tx\.execute\(sql`select set_config\('lux\.role_write', 'admin', true\)`\)/);
  assert.match(source, /export async function revokeAdminTester\([^]*?database\(\)\.transaction\(async \(tx\) => \{\s*await tx\.execute\(sql`select set_config\('lux\.role_write', 'admin', true\)`\)/);
});

test('0014 journal, SQL, and snapshot represent the role guard without changing prior schema', async () => {
  const plan = await migrationPlan();
  assert.equal(plan.migrations.length, 18);
  assert.equal(plan.migrations[14].tag, '0014_pre_role_guard');
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
