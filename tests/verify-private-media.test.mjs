import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256, discoverPrivateMedia, verifyPrivateMedia, runPrivateMediaCli, assertSafeRuntime, assertWindowsPrivatePath, EXPECTATIONS_SCHEMA } from '../tools/verify-private-media.mjs';

const token = 'vercel_blob_rw_TestStore_secret-NOT-A-REAL-CREDENTIAL';
const target = { storeId: 'store_TestStore', projectId: 'prj_TestProject', environment: 'production', access: 'private' };
const generatedAt = '2026-10-02T16:00:00.000Z';
const privatePath = 'video-os/uploads/private-person@example.test/a.png';
const body = Buffer.from('actual private bytes');
const bounds = { maxObjects: 100, maxTotalBytes: 10000, maxObjectBytes: 1000 };
function asset(path = privatePath, bytes = body) { return { privatePathname: path, bytes: bytes.length, sha256: sha256(bytes), kind: 'identity-photo-source' }; }
function manifest(assets = [asset()]) { return { schemaVersion: EXPECTATIONS_SCHEMA, target, observedAt: generatedAt, assets }; }
function blob(pathname = privatePath, size = body.length, etag = '"private-version"') { return { pathname, size, etag, uploadedAt: generatedAt, url: `https://teststore.private.blob.vercel-storage.com/${pathname.split('/').map(encodeURIComponent).join('/')}` }; }
function page(objects) { return async () => ({ blobs: objects, hasMore: false }); }
function response(bytes = body, overrides = {}) {
  const actual = new Response(bytes, { status: overrides.status || 200, headers: { 'content-length': String(bytes.length), etag: '"private-version"', ...overrides.headers } });
  if (overrides.url !== undefined) Object.defineProperty(actual, 'url', { value: overrides.url });
  if (overrides.redirected !== undefined) Object.defineProperty(actual, 'redirected', { value: overrides.redirected });
  return actual;
}
async function setup(overrides = {}) {
  const common = { token, target, manifest: manifest(), bounds, listPage: page([blob()]), generatedAt, ...overrides };
  const { snapshot, report } = await discoverPrivateMedia(common);
  return { ...common, snapshot, snapshotSha256: report.snapshotSha256, fetchImpl: async () => response() };
}
async function expectReject(code, overrides) { await assert.rejects(discoverPrivateMedia({ token, target, manifest: manifest(), bounds, listPage: page([blob()]), ...overrides }), { message: code }); }

test('discovery computes current exact count/bytes without guessed totals and does not fetch media', async () => {
  const objects = [blob(), blob('video-os/uploads/unreferenced-root.png', 21), blob('video-os/containment-20260715/quarantine/old.json', 7), blob('video-os/auth/private-id.json', 3)];
  const first = await discoverPrivateMedia({ token, target, manifest: manifest(), bounds, listPage: page(objects), generatedAt });
  const second = await discoverPrivateMedia({ token, target, manifest: manifest(), bounds, listPage: page([...objects].reverse()), generatedAt });
  assert.deepEqual(first, second);
  assert.equal(first.report.inventory.objects, 4); assert.equal(first.report.inventory.bytes, body.length + 31);
  assert.equal(first.report.retention.unreferencedInSuppliedManifest, 3); assert.equal(first.report.retention.quarantinedRetained, 1);
  assert.equal(first.report.byteVerificationPerformed, false); assert.equal(first.report.authority.releaseAuthorized, false);
  assert.equal(first.report.snapshotSha256, sha256(canonicalJson(first.snapshot)));
  assert.doesNotMatch(JSON.stringify(first.report), /private-person|private-id|old.json|root.png|private-version|secret-NOT|blob.vercel-storage/);
});

test('verifies real streamed SHA256 with exact safe authenticated request and metadata rechecks', async () => {
  let listCalls = 0; let getCalls = 0;
  const opts = await setup({ listPage: async (...args) => { listCalls++; assert.equal(args[0].token, token); assert.ok(args[0].abortSignal); return { blobs: [blob()], hasMore: false }; } });
  opts.fetchImpl = async (url, options) => {
    getCalls++; assert.equal(new URL(url).host, 'teststore.private.blob.vercel-storage.com'); assert.equal(new URL(url).search, '?cache=0');
    assert.doesNotMatch(url, /secret|Bearer/); assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.headers['accept-encoding'], 'identity');
    assert.equal(options.headers['if-match'], '"private-version"');
    return response();
  };
  const report = await verifyPrivateMedia(opts);
  assert.equal(listCalls, 3); assert.equal(getCalls, 1);
  assert.equal(report.status, 'current-private-bytes-match-supplied-db-hashes'); assert.equal(report.verifiedObjects, 1);
  assert.equal(report.results[0].status, 'sha256-match'); assert.equal(report.results[0].evidenceHmac.length, 64);
  for (const key of ['sourceCopyVerified','migrationVerified','releaseAuthorized','destructiveActionsAuthorized','anonymousDenialVerified','ownerAndWrongAccountAccessVerified']) assert.equal(report.authority[key], false);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${sha256(body)}|${token}|private-person|private-version`));
});

test('quarantine and two unreferenced root PNGs are retained and never downloaded', async () => {
  const objects = [blob(), blob('video-os/uploads/first.png', 5), blob('video-os/uploads/second.png', 5), ...Array.from({ length: 26 }, (_, i) => blob(`video-os/containment-20260715/quarantine/${i}.json`, 5))];
  const opts = await setup({ listPage: page(objects) }); let calls = 0;
  opts.fetchImpl = async (url) => { calls++; assert.ok(decodeURIComponent(url).includes(privatePath)); return response(); };
  const report = await verifyPrivateMedia(opts); assert.equal(calls, 1); assert.equal(report.retention.unreferencedInSuppliedManifest, 28);
  assert.equal(report.retention.quarantinedRetained, 26); assert.equal(report.authority.destructiveActionsAuthorized, false);
});

test('rejects wrong token, store, access, target before list or media I/O', async () => {
  let calls = 0; const listPage = async () => { calls++; throw Error('must not call'); };
  await expectReject('credential_store_mismatch', { token: 'vercel_blob_rw_Other_secret', listPage });
  await expectReject('invalid_target', { target: { ...target, access: 'public' }, listPage });
  await expectReject('manifest_target_mismatch', { manifest: { ...manifest(), target: { ...target, projectId: 'prj_Other' } }, listPage });
  assert.equal(calls, 0);
});

test('rejects unsafe, duplicate, out-of-scope and invalid DB expectations', async () => {
  for (const p of ['../a.png','/a.png','https://evil.test/a','video-os/uploads/../a','video-os/uploads/a%2fb','video-os/uploads/a?token=secret','video-os/containment-20260715/quarantine/a','video-os/auth/a']) {
    await expectReject('manifest_path_out_of_scope', { manifest: manifest([asset(p)]) });
  }
  await expectReject('manifest_duplicate_path', { manifest: manifest([asset(), asset()]) });
  await expectReject('manifest_expectation_invalid', { manifest: manifest([{ ...asset(), sha256: 'etag' }]) });
  await expectReject('manifest_count_invalid', { manifest: manifest([]) });
  await expectReject('manifest_expectation_invalid', { manifest: manifest([{ ...asset(), bytes: 1001 }]) });
});

test('rejects public/foreign/userinfo/query URLs and mismatched paths from authenticated list', async () => {
  for (const url of ['https://other.private.blob.vercel-storage.com/a','https://teststore.public.blob.vercel-storage.com/a',`https://user:pass@teststore.private.blob.vercel-storage.com/${privatePath}`,`https://teststore.private.blob.vercel-storage.com/${privatePath}?secret=abc`]) {
    await expectReject('list_store_or_access_mismatch', { listPage: page([{ ...blob(), url }]) });
  }
  await expectReject('list_path_mismatch', { listPage: page([{ ...blob(), url: 'https://teststore.private.blob.vercel-storage.com/different.png' }]) });
});

test('bounds pagination, object counts, object lengths, total bytes and advancing cursors', async () => {
  await expectReject('list_duplicate_path', { listPage: page([blob(), blob()]) });
  await expectReject('list_count_bound_exceeded', { bounds: { ...bounds, maxObjects: 1 }, listPage: page([blob(), blob('video-os/uploads/b', 1)]) });
  await expectReject('invalid_list_object', { listPage: page([blob(privatePath, 1001)]) });
  await expectReject('list_byte_bound_exceeded', { bounds: { ...bounds, maxTotalBytes: 1000 }, listPage: page([blob(privatePath, 999), blob('video-os/uploads/b', 2)]) });
  await expectReject('list_cursor_invalid', { listPage: async () => ({ blobs: [], hasMore: true, cursor: 'same' }) });
  await expectReject('list_page_bound_exceeded', { bounds: { ...bounds, maxPages: 1 }, listPage: async () => ({ blobs: [], hasMore: true, cursor: 'next' }) });
  let calls = 0; const pages = [{ blobs: [blob()], hasMore: true, cursor: 'next' }, { blobs: [blob('video-os/uploads/b', 1)], hasMore: false }];
  const result = await discoverPrivateMedia({ token, target, manifest: manifest(), bounds, listPage: async () => pages[calls++] });
  assert.equal(result.report.inventory.objects, 2);
});

test('requires pinned immutable snapshot and exact manifest', async () => {
  const opts = await setup();
  await assert.rejects(verifyPrivateMedia({ ...opts, snapshotSha256: undefined }), /snapshot_digest_mismatch/);
  await assert.rejects(verifyPrivateMedia({ ...opts, snapshot: { ...opts.snapshot, objects: [] } }), /snapshot_digest_mismatch/);
  await assert.rejects(verifyPrivateMedia({ ...opts, manifest: { ...manifest(), observedAt: '2026-10-02T17:00:00Z' } }), /snapshot_target_or_manifest_mismatch/);
});

test('rejects unexpected path/count/size/version drift before any byte reads', async () => {
  const opts = await setup(); let gets = 0; const fetchImpl = async () => { gets++; return response(); };
  for (const objects of [[], [blob(), blob('video-os/uploads/extra', 1)], [blob(privatePath, 2)], [blob(privatePath, body.length, 'changed')]]) {
    await assert.rejects(verifyPrivateMedia({ ...opts, listPage: page(objects), fetchImpl }), /inventory_drift_before_reads/);
  }
  assert.equal(gets, 0);
});

test('missing and DB size mismatches are retained, and no byte reads occur', async () => {
  for (const objects of [[], [blob(privatePath, 2)]]) {
    const opts = await setup({ listPage: page(objects) }); opts.fetchImpl = async () => { throw Error('must not fetch'); };
    const report = await verifyPrivateMedia(opts); assert.equal(report.status, 'failed-retained'); assert.equal(report.verifiedObjects, 0);
    assert.match(report.results[0].status, /^(missing|metadata-length-mismatch)-retained$/);
  }
});

test('same-length SHA mismatch fails and stops the batch while retaining every object', async () => {
  const b = asset('video-os/uploads/second.png'); const opts = await setup({ manifest: manifest([asset(), b]), listPage: page([blob(), blob(b.privatePathname)]) });
  let gets = 0; opts.fetchImpl = async () => { gets++; return response(Buffer.alloc(body.length, 120)); };
  const report = await verifyPrivateMedia(opts); assert.equal(gets, 1); assert.equal(report.status, 'failed-retained');
  assert.equal(report.results[0].status, 'sha256-mismatch-retained'); assert.equal(report.results[1].status, 'not-read-retained');
});

test('rejects redirects, different final URLs, partial, compressed and stale response versions', async () => {
  const cases = [
    [{ status: 302 }, 'private_read_status_rejected'],
    [{ redirected: true }, 'redirect_or_response_url_rejected'],
    [{ url: 'https://evil.test/file' }, 'redirect_or_response_url_rejected'],
    [{ status: 206 }, 'private_read_status_rejected'],
    [{ headers: { 'content-range': 'bytes 0-1/20' } }, 'partial_content_rejected'],
    [{ headers: { 'content-encoding': 'gzip' } }, 'content_encoding_rejected'],
    [{ headers: { etag: 'other-version' } }, 'read_version_mismatch'],
  ];
  for (const [overrides, reason] of cases) {
    const opts = await setup(); opts.fetchImpl = async () => response(body, overrides);
    const report = await verifyPrivateMedia(opts); assert.equal(report.status, 'failed-retained'); assert.equal(report.results[0].reason, reason);
  }
});

test('requires exact content length and cancels an overlong/truncated stream', async () => {
  for (const length of ['', '1', String(body.length + 1), '020', '20xyz']) {
    const opts = await setup(); opts.fetchImpl = async () => response(body, { headers: { 'content-length': length } });
    const report = await verifyPrivateMedia(opts); assert.equal(report.results[0].reason, 'content_length_mismatch');
  }
  let cancelled = false;
  const opts = await setup(); opts.fetchImpl = async () => new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(body.length + 1)); }, cancel() { cancelled = true; } }), { headers: { 'content-length': String(body.length), etag: '"private-version"' } });
  let report = await verifyPrivateMedia(opts); assert.equal(report.results[0].reason, 'stream_byte_bound_exceeded'); assert.equal(cancelled, true);
  opts.fetchImpl = async () => response(body.subarray(0, body.length - 1), { headers: { 'content-length': String(body.length) } });
  report = await verifyPrivateMedia(opts); assert.equal(report.results[0].reason, 'stream_length_mismatch');
});

test('post-read metadata drift invalidates a matching hash', async () => {
  const opts = await setup(); let calls = 0;
  opts.listPage = async () => ({ blobs: calls++ === 0 ? [blob()] : [blob(privatePath, body.length, 'new-version')], hasMore: false });
  const report = await verifyPrivateMedia(opts); assert.equal(report.verifiedObjects, 1); assert.equal(report.inventoryStableAcrossReads, false); assert.equal(report.status, 'failed-retained');
});

test('network errors are sanitized and deadlines bound authenticated operations', async () => {
  const opts = await setup(); opts.fetchImpl = async () => { throw new Error(`secret ${token} https://private.test/person`); };
  let report = await verifyPrivateMedia(opts); assert.equal(report.results[0].reason, 'authenticated_read_failed'); assert.doesNotMatch(JSON.stringify(report), /secret-NOT|private.test/);
  await expectReject('authenticated_list_failed', { listPage: async () => { throw new Error(token); } });
  await expectReject('request_timeout', { bounds: { ...bounds, requestTimeoutMs: 10 }, listPage: async () => new Promise(() => {}) });
  const timed = await setup({ bounds: { ...bounds, requestTimeoutMs: 10 } }); timed.fetchImpl = async () => new Promise(() => {});
  report = await verifyPrivateMedia(timed); assert.equal(report.results[0].reason, 'request_timeout');
});

test('rejects API credential exfiltration overrides and accepts only named CLI flags', async () => {
  for (const key of ['VERCEL_BLOB_API_URL','NEXT_PUBLIC_VERCEL_BLOB_API_URL','VERCEL_BLOB_API_VERSION_OVERRIDE','VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API']) assert.throws(() => assertSafeRuntime({ [key]: 'https://evil.test' }), /blob_api_override_rejected/);
  await assert.rejects(runPrivateMediaCli(['--token', token], {}), /invalid_arguments/);
  await assert.rejects(runPrivateMediaCli(['--mode','discover','--mode','verify'], {}), /invalid_arguments/);
  assert.throws(() => assertSafeRuntime({ DEBUG: 'blob' }), /transport_debug_logging_rejected/);
  assert.throws(() => assertSafeRuntime({ DEBUG: '*' }), /transport_debug_logging_rejected/);
  assert.throws(() => assertSafeRuntime({ NEXT_PUBLIC_DEBUG: 'something' }), /transport_debug_logging_rejected/);
  assert.throws(() => assertSafeRuntime({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /tls_verification_disabled/);
});

test('native Windows boundary checks protected SID-only ACLs without credential environment, path injection or ACL mutation', async () => {
  let calls = 0;
  const dangerousPath = "C:\\Private\\x'; Write-Output anything; 'file.json";
  await assertWindowsPrivatePath(dangerousPath, { systemRoot: 'C:\\Windows', execute: async (file, args, options) => {
    calls++; assert.match(file, /powershell.exe$/); assert.ok(args.includes('-NoProfile')); assert.ok(args.includes('-NonInteractive'));
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.doesNotMatch(script, /Write-Output anything|Set-Acl|SetAccessRuleProtection|AddAccessRule/);
    assert.match(script, /AreAccessRulesProtected/); assert.match(script, /GetOwner/); assert.match(script, /GetAccessRules/);
    assert.match(script, /ReparsePoint/); assert.match(script, /ContainerInherit, ObjectInherit/); assert.match(script, /FullControl/);
    assert.deepEqual(options.env, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' }); assert.equal(options.timeout, 10000);
    const encoded = script.match(/FromBase64String\('([^']+)'\)/)[1]; assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), dangerousPath);
    return { stdout: 'private-acl-ok', stderr: '' };
  } });
  assert.equal(calls, 1);
  for (const execute of [async () => { throw Error(token); }, async () => ({ stdout: 'unverified', stderr: '' }), async () => ({ stdout: 'private-acl-ok', stderr: 'ACL warning' })]) {
    await assert.rejects(assertWindowsPrivatePath('C:\\Private', { directory: true, systemRoot: 'C:\\Windows', execute }), /windows_private_acl_unverified/);
  }
  await assert.rejects(assertWindowsPrivatePath('C:\\Private', { systemRoot: '' }), /windows_acl_verification_unavailable/);
});

test('exported default SDK path rejects ambient API overrides before SDK import or network', async () => {
  const previous = process.env.VERCEL_BLOB_API_URL;
  try {
    process.env.VERCEL_BLOB_API_URL = 'https://evil.test';
    await assert.rejects(discoverPrivateMedia({ token, target, manifest: manifest(), bounds }), /blob_api_override_rejected/);
  } finally {
    if (previous === undefined) delete process.env.VERCEL_BLOB_API_URL; else process.env.VERCEL_BLOB_API_URL = previous;
  }
});

test('exported verification rejects wildcard debug env even with an injected list transport', async () => {
  const opts = await setup(); const previous = process.env.DEBUG;
  try {
    process.env.DEBUG = '*';
    await assert.rejects(verifyPrivateMedia(opts), /transport_debug_logging_rejected/);
  } finally { if (previous === undefined) delete process.env.DEBUG; else process.env.DEBUG = previous; }
});

test('CLI preflights every output before network reads and rejects shared output destinations', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'private-media-output-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); await mkdir(repo); const input = join(dir, 'db.json'); await writeFile(input, JSON.stringify(manifest()), { mode: 0o600 });
  let calls = 0; const deps = { repositoryRoot: repo, listPage: async () => { calls++; return { blobs: [blob()], hasMore: false }; } };
  const args = ['--mode','discover','--manifest',input,'--store-id',target.storeId,'--project-id',target.projectId,'--environment','production','--private-snapshot',join(dir,'snapshot.json'),'--report',join(dir,'absent','report.json')];
  await assert.rejects(runPrivateMediaCli(args, { BLOB_READ_WRITE_TOKEN: token }, deps), { code: 'ENOENT' });
  args[args.length - 1] = join(dir, 'snapshot.json');
  await assert.rejects(runPrivateMediaCli(args, { BLOB_READ_WRITE_TOKEN: token }, deps), /output_paths_must_differ/);
  const existing = join(dir, 'existing.json'); await writeFile(existing, 'keep'); args[args.length - 1] = existing;
  await assert.rejects(runPrivateMediaCli(args, { BLOB_READ_WRITE_TOKEN: token }, deps), { code: 'EEXIST' });
  assert.equal(calls, 0); assert.equal(await readFile(existing, 'utf8'), 'keep');
});

test('CLI creates private snapshot and sanitized reports, verifies with pinned digest and never overwrites', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'private-media-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); await mkdir(repo); const input = join(dir, 'db.json'); await writeFile(input, JSON.stringify(manifest()), { mode: 0o600 });
  const snapshot = join(dir, 'snapshot.json'); const discoverReport = join(dir, 'discover.json'); let output = '';
  const common = ['--manifest',input,'--store-id',target.storeId,'--project-id',target.projectId,'--environment','production'];
  const deps = { repositoryRoot: repo, stdout: (s) => { output += s; }, listPage: page([blob()]), fetchImpl: async () => response() };
  const discoverArgs = ['--mode','discover',...common,'--private-snapshot',snapshot,'--report',discoverReport];
  const discovered = await runPrivateMediaCli(discoverArgs, { BLOB_READ_WRITE_TOKEN: token }, deps);
  assert.equal(discovered.exitCode, 0); assert.doesNotMatch(output, /private-person|secret-NOT|blob.vercel-storage/);
  const verified = await runPrivateMediaCli(['--mode','verify',...common,'--snapshot',snapshot,'--snapshot-sha256',discovered.report.snapshotSha256,'--report',join(dir,'verified.json')], { BLOB_READ_WRITE_TOKEN: token }, deps);
  assert.equal(verified.exitCode, 0); assert.equal(verified.report.verifiedObjects, 1);
  assert.match(await readFile(snapshot, 'utf8'), /private-person/);
  await assert.rejects(runPrivateMediaCli(discoverArgs, { BLOB_READ_WRITE_TOKEN: token }, deps), { code: 'EEXIST' });
});

test('CLI rejects repository/private-file symlink escapes and loose input permissions before networking', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'private-media-paths-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); await mkdir(repo); const inRepo = join(repo, 'db.json'); await writeFile(inRepo, JSON.stringify(manifest()), { mode: 0o600 });
  const link = join(dir, 'input-link.json'); await symlink(inRepo, link);
  const deps = { repositoryRoot: repo, listPage: async () => { throw Error('must not call'); } };
  const args = (input) => ['--mode','discover','--manifest',input,'--store-id',target.storeId,'--project-id',target.projectId,'--environment','production','--private-snapshot',join(dir,'out.json'),'--report',join(dir,'safe.json')];
  await assert.rejects(runPrivateMediaCli(args(link), { BLOB_READ_WRITE_TOKEN: token }, deps), /private_file_inside_repository/);
  const external = join(dir, 'db.json'); await writeFile(external, JSON.stringify(manifest()), { mode: 0o644 });
  if (process.platform !== 'win32') await assert.rejects(runPrivateMediaCli(args(external), { BLOB_READ_WRITE_TOKEN: token }, deps), /private_file_permissions_or_size/);
  await chmod(external, 0o600); const parentLink = join(dir, 'repo-link'); await symlink(repo, parentLink);
  const badOutput = args(external); badOutput[badOutput.indexOf('--private-snapshot') + 1] = join(parentLink,'raw.json');
  await assert.rejects(runPrivateMediaCli(badOutput, { BLOB_READ_WRITE_TOKEN: token }, deps), /private_file_inside_repository/);
});

test('CLI rejects loose POSIX private parents and in-checkout or symlinked reports before I/O', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'private-media-parent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); await mkdir(repo, {mode: 0o700});
  const input = join(dir, 'db.json'); await writeFile(input, JSON.stringify(manifest()), {mode: 0o600});
  const common = ['--mode','discover','--manifest',input,'--store-id',target.storeId,'--project-id',target.projectId,
    '--environment','production','--private-snapshot',join(dir,'snapshot.json')];
  let calls = 0;
  const deps = {repositoryRoot: repo, listPage: async () => { calls++; throw Error('must not run'); }};
  await assert.rejects(runPrivateMediaCli([...common,'--report',join(repo,'report.json')], {BLOB_READ_WRITE_TOKEN: token}, deps), /private_file_inside_repository/);
  await assert.rejects(runPrivateMediaCli([...common,'--report','relative-report.json'], {BLOB_READ_WRITE_TOKEN: token}, deps), /private_path_must_be_absolute/);
  const loose = join(dir, 'loose'); await mkdir(loose, {mode: 0o755});
  await assert.rejects(runPrivateMediaCli([...common,'--report',join(loose,'report.json')], {BLOB_READ_WRITE_TOKEN: token}, deps), /private_parent_permissions/);
  const looseInput = join(loose, 'db.json'); await writeFile(looseInput, JSON.stringify(manifest()), {mode: 0o600});
  const inputArgs = [...common]; inputArgs[inputArgs.indexOf('--manifest') + 1] = looseInput;
  await assert.rejects(runPrivateMediaCli([...inputArgs,'--report',join(dir,'report.json')], {BLOB_READ_WRITE_TOKEN: token}, deps), /private_parent_permissions/);
  const privateDir = join(dir, 'private'); await mkdir(privateDir, {mode: 0o700});
  const linked = join(dir, 'linked'); await symlink(privateDir, linked);
  await assert.rejects(runPrivateMediaCli([...common,'--report',join(linked,'report.json')], {BLOB_READ_WRITE_TOKEN: token}, deps), /private_path_symlink_rejected/);
  assert.equal(calls, 0);
});
