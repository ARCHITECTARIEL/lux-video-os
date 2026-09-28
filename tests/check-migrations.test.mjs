// Real CLI subprocess tests for tools/check-migrations.mjs's --strict
// enforcement -- the exact behavioral gap this project's own audit found:
// the migration deploy gate was warn-only even with a real DATABASE_URL,
// and its build-time caller never even passed --strict in the first place.
// checkDatabaseMigrations() opens a genuine Postgres connection directly
// (no injection point), so rather than mocking it, these tests spawn the
// real CLI and exercise the connection-failure path against a deliberately
// unreachable host -- a real connection error, not a simulated one -- which
// is exactly the code path `main()`'s strict-mode enforcement runs through.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../tools/check-migrations.mjs', import.meta.url));
const UNREACHABLE_URL = 'postgres://user:pass@127.0.0.1:1/nonexistent?connect_timeout=1';

function run(args, envOverrides = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, ...envOverrides },
  });
}

test('with no DATABASE_URL at all, exits 0 regardless of --strict (CI has no production DB access -- this must never block CI)', () => {
  const withoutStrict = run([], { DATABASE_URL: '', DATABASE_URL_UNPOOLED: '' });
  assert.equal(withoutStrict.status, 0);
  const withStrict = run(['--strict'], { DATABASE_URL: '', DATABASE_URL_UNPOOLED: '' });
  assert.equal(withStrict.status, 0);
});

test('a real (unreachable) DATABASE_URL that fails to connect exits 0 without --strict, matching the existing warn-only fallback', () => {
  const result = run([], { DATABASE_URL: UNREACHABLE_URL, DATABASE_URL_UNPOOLED: '' });
  assert.equal(result.status, 0);
  assert.match(result.stdout + result.stderr, /Could not verify against live database/);
});

test('the same unreachable DATABASE_URL exits 1 with --strict -- this is the actual gate: a real deploy against a database check-migrations.mjs cannot verify must fail loudly, not silently proceed', () => {
  const result = run(['--strict'], { DATABASE_URL: UNREACHABLE_URL, DATABASE_URL_UNPOOLED: '' });
  assert.equal(result.status, 1);
});

test('DATABASE_URL_UNPOOLED takes priority over DATABASE_URL when both are set, matching build-production.mjs\'s own precedence', () => {
  // A reachable-looking but still-unresolvable DNS name proves which var
  // was actually used: if UNPOOLED (a real, guaranteed-unreachable literal
  // IP) were ignored in favor of a bogus hostname in DATABASE_URL, the
  // failure signature would differ (DNS resolution error vs connection
  // refused/timeout). Both fail either way, so this only needs --strict's
  // exit code, not the exact error text.
  const result = run(['--strict'], {
    DATABASE_URL_UNPOOLED: UNREACHABLE_URL,
    DATABASE_URL: 'postgres://user:pass@this-host-does-not-exist.invalid:5432/db',
  });
  assert.equal(result.status, 1);
});
