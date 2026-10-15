import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const url = process.env.VIDEO_OS_ROLE_GUARD_PG_URL;
const enabled = process.env.VIDEO_OS_ROLE_GUARD_PG_OPT_IN === 'i-understand-this-uses-a-throwaway-db' && Boolean(url);

function assertThrowawayTarget() {
  assert.equal(process.env.VIDEO_OS_ROLE_GUARD_PG_OPT_IN, 'i-understand-this-uses-a-throwaway-db');
  const parsed = new URL(url);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'loopback only');
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /^(?:throwaway|vos_role_guard)[a-z0-9_]*$/, 'throwaway DB name required');
}

function psql(script) {
  const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: script, encoding: 'utf8', env: { ...process.env, PGDATABASE: url }, maxBuffer: 1 << 20,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

test('0014 role CHECK, trigger, privilege setting, and legacy precheck on loopback throwaway PG', {
  skip: enabled ? false : 'explicit opt-in and loopback throwaway URL required',
}, async () => {
  assertThrowawayTarget();
  const migration = await readFile('drizzle/0014_pre_role_guard.sql', 'utf8');
  const sql = migration.replaceAll('--> statement-breakpoint', '');
  const setup = "BEGIN; CREATE TEMP TABLE users (id text PRIMARY KEY, role text NOT NULL DEFAULT 'customer');";
  const fixture = `${setup}\n${sql}\nINSERT INTO users(id,role) VALUES ('one','customer');`;
  assert.equal(psql(`${fixture}\nROLLBACK;`).status, 0, 'guard migration must apply to a clean throwaway table');

  for (const statement of [
    "UPDATE users SET role='ceo' WHERE id='one';",
    "INSERT INTO users(id,role) VALUES ('two','workspace');",
    "INSERT INTO users(id,role) VALUES ('two','admin');",
  ]) {
    assert.notEqual(psql(`${fixture}\n${statement}\nROLLBACK;`).status, 0, statement);
  }
  assert.equal(psql(`${fixture}\nSELECT set_config('lux.role_write','admin',true); UPDATE users SET role='ceo' WHERE id='one'; ROLLBACK;`).status, 0);
  assert.notEqual(psql(`${setup}\nINSERT INTO users(id,role) VALUES ('legacy','unknown');\n${sql}\nROLLBACK;`).status, 0, 'legacy precheck must abort');
});
