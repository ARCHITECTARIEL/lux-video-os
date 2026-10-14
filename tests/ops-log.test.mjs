import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logOpsEvent, logOpsEventAwaited, prepareOpsEvent, redactOpsValue, shouldPersistOpsEvent, writeOpsEvent } from '../lib/ops-log.js';

test('literal emitted events and codes survive preparation in entry and row', () => {
  const root = resolve(import.meta.dirname, '..');
  const files = [];
  for (const directory of ['lib', 'routes', 'api', 'server', 'worker', 'workflows']) {
    const walk = path => {
      for (const item of readdirSync(path, { withFileTypes: true })) {
        const name = join(path, item.name);
        if (item.isDirectory()) walk(name);
        else if (/\.[cm]?js$/.test(item.name)) files.push(name);
      }
    };
    walk(join(root, directory));
  }
  let calls = 0;
  const events = new Set();
  const codes = new Set();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\blogOpsEvent(?:Awaited)?\s*\(\s*\{([\s\S]*?)\}\s*(?:,\s*\{|\))/g)) {
      calls++;
      const event = /\bevent:\s*'([^']+)'/.exec(match[1])?.[1];
      const code = /\bcode:\s*'([^']+)'/.exec(match[1])?.[1];
      if (event) events.add(event);
      if (code) codes.add(code);
    }
  }
  assert.ok(calls >= 30, `found only ${calls} calls`);
  assert.ok(events.size >= 30, `found only ${events.size} literal events`);
  for (const event of events) {
    const { entry, row } = prepareOpsEvent({ event, details: { component: 'provider' } });
    assert.equal(entry.event, event);
    assert.equal(row.event, event);
  }
  for (const code of codes) {
    const { entry, row } = prepareOpsEvent({ event: 'test.event', code });
    assert.equal(entry.code, code);
    assert.equal(row.code, code);
  }
  for (const code of ['hosted_finishing_disabled', 'subject_invitation_authority_unconfigured']) {
    const { entry, row } = prepareOpsEvent({ event: 'test.event', code });
    assert.equal(entry.code, code);
    assert.equal(row.code, code);
  }
  assert.deepEqual(prepareOpsEvent({ event: 'identity.provider_creation.contained_failure', details: { component: 'provider' } }).row.details, { component: 'provider' });
  for (const [event, code] of [['bad event', 'bad code'], ['x'.repeat(97), 'x'.repeat(97)], ['abc@example.com', 'abc@example.com']]) {
    const { entry, row } = prepareOpsEvent({ event, code });
    assert.equal(entry.event, 'invalid_event');
    assert.equal(row.event, 'invalid_event');
    assert.equal(entry.code, 'invalid_code');
    assert.equal(row.code, 'invalid_code');
  }
});

test('ops redaction removes sensitive keys and inline credentials', () => {
  const value = redactOpsValue({ token: 'secret', nested: { email: 'x@example.com', reason: 'see https://example.com/signed?a=b' }, count: 3 });
  assert.deepEqual(value, { token: '[redacted]', nested: { email: '[redacted]', reason: 'see [redacted]' }, count: 3 });
});

test('ops event uses a stable account pseudonym and bounded redacted fields', () => {
  const { entry, row } = prepareOpsEvent({
    level: 'warn', event: 'identity.submit.blocked', accountId: 'account_123', identityId: 'identity_123',
    status: 403, code: 'CONSENT_REQUIRED', message: 'Contact x@example.com at https://example.com/signed',
    details: { bearerToken: 'abc', reason: 'blocked', rawProviderPayload: { private: true } },
  });
  assert.equal(entry.accountId.length, 16);
  assert.notEqual(entry.accountId, 'account_123');
  assert.equal(row.accountId, 'account_123');
  assert.equal(row.entityId, 'identity_123');
  assert.equal(row.httpStatus, 403);
  assert.equal(JSON.stringify({ entry, row }).includes('x@example.com'), false);
  assert.equal(JSON.stringify({ entry, row }).includes('https://'), false);
  assert.deepEqual(row.details, {});
});

test('detail allowlist retains only known event fields', () => {
  const credit = prepareOpsEvent({ event: 'admin.credit.granted', details: {
    adminActor: 'admin', amount: 12, duplicate: false, note: 'private', apiKey: 'bad',
  } });
  assert.deepEqual(credit.row.details, { adminActor: 'admin', amount: 12, duplicate: false });
  assert.deepEqual(credit.entry.details, credit.row.details);
  assert.deepEqual(prepareOpsEvent({ event: 'unknown', details: { component: 'provider' } }).row.details, {});
});

test('admin audit records retain actor, target, amount, replay flag, and tester domain', () => {
  const credit = prepareOpsEvent({
    level: 'info', event: 'admin.credit.granted', accountId: 'target-1',
    details: { adminActor: 'admin', amount: -42, duplicate: true, note: 'never logged' },
  });
  assert.equal(credit.row.accountId, 'target-1');
  assert.equal(credit.entry.accountId.length, 16);
  assert.deepEqual(credit.row.details, { adminActor: 'admin', amount: -42, duplicate: true });
  assert.equal(shouldPersistOpsEvent({ persist: true }, credit.entry), true);

  const quarantine = prepareOpsEvent({
    level: 'info', event: 'admin.asset.quarantined', accountId: 'target-1',
    details: { adminActor: 'admin', reason: 'private note' },
  });
  assert.deepEqual(quarantine.row.details, { adminActor: 'admin' });
  const tester = prepareOpsEvent({
    level: 'info', event: 'admin.tester.registered', accountId: 'target-2',
    details: { adminActor: 'admin', testerDomain: 'example.com', email: 'person@example.com' },
  });
  assert.deepEqual(tester.row.details, { adminActor: 'admin', testerDomain: 'example.com' });
  assert.equal(JSON.stringify(tester).includes('person@example.com'), false);
});

test('admin audit waits for its persistence attempt before returning', async () => {
  const original = console.log;
  console.log = () => {};
  let finish;
  let complete = false;
  try {
    const pending = logOpsEventAwaited({
      level: 'info', persist: true, event: 'admin.credit.granted', accountId: 'target-1',
      details: { adminActor: 'admin', amount: 10, duplicate: false },
    }, { writer: () => new Promise(resolve => { finish = resolve; }) }).then(() => { complete = true; });
    assert.equal(complete, false);
    finish();
    await pending;
    assert.equal(complete, true);
  } finally { console.log = original; }
});

test('all sensitive key forms are redacted, including separated names', () => {
  for (const key of [
    'apiKey', 'api_key', 'accessKey', 'privateKey', 'secret', 'token', 'password',
    'pwd', 'passwd', 'passphrase', 'credential', 'credentials', 'auth',
    'authorization', 'jwt', 'cookie', 'session', 'email', 'e-mail', 'mail',
    'phone', 'ssn', 'address', 'name', 'Bearer_Token', 'rawProviderPayload', 'signedUrl',
  ]) {
    assert.equal(redactOpsValue({ [key]: 'unsafe' })[key], '[redacted]', key);
  }
  assert.deepEqual(Object.values(redactOpsValue({ [`x${'a'.repeat(60)}token`]: 'unsafe' })), ['[redacted]']);
});

test('free text scrub covers each credential and personal-data pattern', () => {
  for (const secret of [
    'postgres://user:pass@127.0.0.1:5432/db',
    'https://user:pass@[::1]/private',
    'Authorization: Basic dXNlcjpwYXNz',
    'Authorization: Bearer abcdefgh12345',
    'sk_' + 'live_abcdefgh123', 'sk_' + 'test_abcdefgh123', 'rk_abcdefgh123',
    'vercel_blob_rw_abcdefgh123', 'AK' + 'IAABCDEFGHIJKLMNOP', 'AS' + 'IAABCDEFGHIJKLMNOP',
    'key=short', 'token=short', 'secret=short',
    'password=short', 'cookie: short', 'data:image/png;base64,aGVsbG8=',
    'abcdefgh.ijklmnop.qrstuvwx', 'person@example.com',
    '+1 (212) 555-0101', '192.168.1.1', '2001:db8::1', '::1',
    'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  ]) {
    assert.equal(redactOpsValue(secret).includes(secret), false, secret);
  }
  assert.equal(redactOpsValue('2001:db8::1'), '[redacted]');
  assert.equal(redactOpsValue('::1'), '[redacted]');
});

test('additional redaction preserves dates and identifiers', () => {
  for (const secret of ['password is hunter2', 'secret is short', 'token is tok_9f8e', 'person%40example.com', 'h.com/p?sig=abc', 'user:pass@host.com/p']) {
    assert.equal(redactOpsValue(secret).includes(secret), false, secret);
  }
  for (const key of ['dob', 'birthdate', 'ip', 'card', 'pan', 'cvv', 'iban', 'otp', 'pin', 'nonce', 'salt', 'userPin', 'card_number']) {
    assert.equal(redactOpsValue({ [key]: 'value' })[key], '[redacted]', key);
  }
  for (const key of ['pipeline', 'spinner', 'opinion']) assert.equal(redactOpsValue({ [key]: 'value' })[key], 'value', key);
  for (const value of ['2026-10-14', '2026-10-14T12:13:30Z', '2026-10-14 12', '550e8400-e29b-41d4-a716-446655440000']) {
    assert.equal(redactOpsValue(value), value, value);
  }
});

test('only labelled digest hex survives free-text redaction', () => {
  const hex = 'a'.repeat(64);
  for (const value of [`HEYGEN_API_KEY=${hex}`, `hmac secret: ${hex}`, `key ${hex}`, hex]) {
    assert.equal(redactOpsValue(value).includes(hex), false, value.slice(0, 24));
  }
  for (const value of [`sha256 ${hex}`, `sha-256: ${hex}`, `schemaSha256=${hex}`, `digest: ${hex}`, `checksum=${hex}`, `migrationSetSha256: ${hex}`, `sourceSha256=${hex}`, `outputSha256=${hex}`, `manifestSha256=${hex}`, `contentSha256=${hex}`]) {
    assert.equal(redactOpsValue(value), value);
  }
  for (const label of ['api_key_hash=', 'secret_hash:', 'token_hash=', 'session_hash=', 'HEYGEN_API_KEY_HASH=', 'the hash ', 'rehash ', 'source_hash=', 'prefixschemaSha256=']) {
    assert.equal(redactOpsValue(`${label}${hex}`).includes(hex), false, label);
  }
});

test('credential labels, code names and marker input are handled safely', () => {
  for (const value of ['FOO_API_KEY=short', 'X_SECRET: short', 'Y_TOKEN=short', 'secret: short', 'key: short', 'password was short', 'passwd is short', 'pwd is short', 'token is short', 'hmac secret: short']) {
    assert.equal(redactOpsValue(value).includes('short'), false, value);
  }
  for (const value of ['Token refresh failed', 'key not found in cache', 'Provider key rotation required', 'ID42 retry failed after the timeout', 'AB12 job queued', '1760443200000', '1234567890123']) {
    assert.equal(redactOpsValue(value), value);
  }
  assert.equal(redactOpsValue('PROVIDER_SUBMIT_UNKNOWN'), 'PROVIDER_SUBMIT_UNKNOWN');
  assert.equal(redactOpsValue('PROVIDER_12345_UNKNOWN').includes('12345'), false);
  assert.equal(redactOpsValue('A'.repeat(32)), '[redacted]');
  for (const marker of ['\uE00099\uE001', '\uE0000\uE001']) {
    const result = redactOpsValue(`literal ${marker}`);
    assert.equal(result.includes('undefined'), false);
    assert.equal(result.includes('\uE000'), false);
    assert.equal(result.includes('\uE001'), false);
  }
  assert.equal(redactOpsValue(`sha256 ${'b'.repeat(64)} \uE0000\uE001`).includes('undefined'), false);
});

test('IBAN checksum and card Luhn checks distinguish credentials from ordinary numbers', () => {
  const iban = ['DE89', '3704', '0044', '0532', '0130', '00'].join(' ');
  assert.equal(redactOpsValue(iban), '[redacted]');
  assert.equal(redactOpsValue('DE88 3704 0044 0532 0130 00'), 'DE88 3704 0044 0532 0130 00');
  const card = ['4111', '1111', '1111', '1111'].join('-');
  assert.equal(redactOpsValue(card).includes(card), false);
  assert.equal(redactOpsValue('4111-1111-1111-1112'), '4111-1111-1111-1112');
});

test('phone shapes redact without changing timestamps, identifiers or long numeric builds', () => {
  for (const value of ['(555) 123-4567', '555-123-4567', '555.123.4567', '5551234567', '+1 555 123 4567']) {
    assert.equal(redactOpsValue(value), '[redacted]', value);
  }
  for (const value of [
    '1760443200000', '1234567890123', '2026-10-14 12',
    '550e8400-e29b-41d4-a716-446655440000', '2026-10-14T12:13:30Z',
    '4111-1111-1111-1112', 'build_5551234567', 'build5551234567',
  ]) {
    assert.equal(redactOpsValue(value), value);
  }
});

test('userpass endpoints and personal numbers are redacted without changing identifiers', () => {
  for (const value of [
    'admin:pw@localhost:5432/db', 'admin:pw@127.0.0.1:5432/db', 'admin:pw@[2001:db8::1]:5432/db',
    '4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111', '123-45-6789',
    'GB82 WEST 1234 5698 7654 32', 'DE89370400440532013000',
  ]) {
    assert.equal(redactOpsValue(value).includes(value), false, value);
  }
  assert.equal(redactOpsValue('admin:pw@localhost:5432/db').includes('pw'), false);
  for (const value of ['550e8400-e29b-41d4-a716-446655440000', '2026-10-14', '2026-10-14T12:13:30Z', `sha256 ${'c'.repeat(64)}`]) {
    assert.equal(redactOpsValue(value), value);
  }
});

test('limited error events resist repeated, cycled, and varied keys while audits bypass the cap', () => {
  const now = 8_000_000;
  const base = { level: 'error', event: 'anonymous.failure', status: 500 };
  let accepted = 0;
  for (let i = 0; i < 10; i++) accepted += Number(shouldPersistOpsEvent(base, { ...base, code: 'SAME', accountId: 'same' }, now));
  assert.equal(accepted, 5);
  for (let i = 0; i < 300; i++) accepted += Number(shouldPersistOpsEvent({ ...base, accountId: `account-${i}` }, { ...base, code: `CODE_${i}`, accountId: `account-${i}` }, now));
  assert.equal(accepted, 60);
  for (let i = 0; i < 20; i++) assert.equal(shouldPersistOpsEvent(base, { ...base, code: `VARIANT_${i}` }, now), false);
  assert.equal(shouldPersistOpsEvent({ ...base, persist: true }, base, now), true);
});

test('anonymous 5xx logging persists at most five rows per event and code per minute', () => {
  const original = console.log;
  const rows = [];
  console.log = () => {};
  try {
    for (let i = 0; i < 20; i++) {
      logOpsEvent({ level: 'error', event: 'anonymous.route.failed', code: 'HTTP_500', status: 500 },
        { writer: row => rows.push(row), now: 9_000_000 });
    }
  } finally { console.log = original; }
  assert.equal(rows.length, 5);
});

test('failed audit persistence emits a distinct alert without leaking the writer error', async () => {
  const errors = [];
  const original = console.error;
  console.error = line => errors.push(JSON.parse(line));
  try {
    assert.equal(await writeOpsEvent({ event: 'admin.credit.granted' }, async () => { throw new Error('private value'); }, { audit: true }), false);
  } finally { console.error = original; }
  assert.deepEqual(errors.map(({ event, code, auditEvent }) => ({ event, code, auditEvent })), [{ event: 'ops.audit.persist.failed', code: 'OPS_AUDIT_PERSIST_FAILED', auditEvent: 'admin.credit.granted' }]);
  assert.equal(JSON.stringify(errors).includes('private value'), false);
});

test('scrubbing bounds input before regex evaluation', () => {
  for (const input of [
    'a.'.repeat(50_000), 'A'.repeat(100_000), '@'.repeat(100_000), '1234567890'.repeat(10_000),
  ]) {
    const start = performance.now();
    const output = redactOpsValue(input);
    assert.ok(performance.now() - start < 100, '100 KB input must scrub in under 100 ms');
    assert.ok(output.length <= 256);
  }
});

test('depth and details size limits survive nested and wide input', () => {
  assert.deepEqual(redactOpsValue({ a: { b: { c: { d: 'private' } } } }), { a: { b: { c: { d: '[redacted]' } } } });
  const component = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`part${i}`, 'safe '.repeat(50)]));
  assert.deepEqual(prepareOpsEvent({ event: 'identity.provider_creation.failed', details: { component } }).row.details, { truncated: true });
});

test('anonymous rejections are console-only; warns are deduped and persistence overrides work', () => {
  const lines = [];
  const writes = [];
  const original = console.log;
  console.log = line => lines.push(JSON.parse(line));
  try {
    for (const status of [401, 403, 405]) {
      logOpsEvent({ level: 'warn', event: 'anonymous.reject', status, code: 'DENIED' }, { writer: row => writes.push(row), now: 100 });
    }
    assert.equal(writes.length, 0);
    for (let i = 0; i < 8; i++) {
      logOpsEvent({ level: 'warn', event: 'warn.dedupe.test', accountId: 'acct-test', code: 'RETRY' }, { writer: row => writes.push(row), now: 100 });
    }
    assert.equal(writes.length, 5);
    logOpsEvent({ level: 'warn', event: 'warn.dedupe.test', accountId: 'acct-test', code: 'RETRY' }, { writer: row => writes.push(row), now: 60_101 });
    assert.equal(writes.length, 6);
    logOpsEvent({ level: 'error', persist: false, event: 'persist.none' }, { writer: row => writes.push(row) });
    assert.equal(writes.length, 6);
    logOpsEvent({ level: 'info', persist: true, event: 'persist.all' }, { writer: row => writes.push(row) });
    assert.equal(writes.length, 7);
    assert.equal(lines.length, 14);
    assert.equal(shouldPersistOpsEvent({ persist: false }, { level: 'error' }), false);
  } finally { console.log = original; }
});

test('ops writer failure is swallowed and emits only a static diagnostic', async () => {
  const original = console.error;
  const lines = [];
  console.error = line => lines.push(line);
  try {
    assert.equal(await writeOpsEvent({ message: 'safe' }, async () => { throw new Error('secret token'); }), false);
  } finally { console.error = original; }
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes('secret token'), false);
  assert.equal(JSON.parse(lines[0]).code, 'OPS_PERSIST_FAILED');
});

test('info event emits exactly one parseable JSON line', () => {
  const original = console.log;
  const lines = [];
  console.log = line => lines.push(line);
  try { logOpsEvent({ level: 'info', event: 'enrollment.upload.started', accountId: 'account_123' }); }
  finally { console.log = original; }
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, 'enrollment.upload.started');
  assert.equal(lines[0].includes('account_123'), false);
});
