#!/usr/bin/env node
// Read-only operator tool. Never loads dotenv, writes credentials/media, mutates
// storage/DB, or clears a migration/release gate. See --help for the two phases.
// Private GET protocol: https://vercel.com/docs/vercel-blob/private-storage
// Installed SDK get() follows redirects without a policy option; use fetch with
// redirect:error instead. SDK list() is used only for bounded metadata discovery.
import { createHash, createHmac } from 'node:crypto';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTATIONS_SCHEMA = 'video-os-private-media-expectations/v1';
export const SNAPSHOT_SCHEMA = 'video-os-private-media-snapshot/v1';
export const REPORT_SCHEMA = 'video-os-private-media-verification/v1';
const QUARANTINE = 'video-os/containment-20260715/quarantine/';
const MEDIA_PREFIXES = ['video-os/uploads/', 'video-os/finals/'];
const MAX_JSON_BYTES = 4 * 1024 * 1024;
export const DEFAULT_BOUNDS = Object.freeze({ maxObjects: 1000, maxTotalBytes: 256 * 1024 * 1024,
  maxObjectBytes: 128 * 1024 * 1024, maxPages: 20, requestTimeoutMs: 30000, runTimeoutMs: 900000 });

class VerificationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireThat(condition, code) { if (!condition) throw new VerificationError(code); }
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function integer(value, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function pathnameOkay(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
    !/[\x00-\x20\x7f\\?#%]/u.test(value) && !value.startsWith('/') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..');
}
function validateTarget(target) {
  requireThat(target && /^store_[A-Za-z0-9]+$/.test(target.storeId) &&
    /^prj_[A-Za-z0-9]+$/.test(target.projectId) && /^(production|preview|development)$/.test(target.environment) &&
    target.access === 'private', 'invalid_target');
  return { storeId: target.storeId, projectId: target.projectId, environment: target.environment, access: 'private' };
}
function sameTarget(left, right) { return canonicalJson(validateTarget(left)) === canonicalJson(validateTarget(right)); }
function validateBounds(input = {}) {
  const bounds = { ...DEFAULT_BOUNDS, ...input };
  for (const key of Object.keys(DEFAULT_BOUNDS)) requireThat(integer(bounds[key], DEFAULT_BOUNDS[key]) && bounds[key] > 0, 'invalid_bounds');
  requireThat(bounds.maxObjectBytes <= bounds.maxTotalBytes && bounds.requestTimeoutMs <= bounds.runTimeoutMs, 'invalid_bounds');
  return bounds;
}
function expectedHost(target) { return `${target.storeId.slice(6).toLowerCase()}.private.blob.vercel-storage.com`; }
function validateCredential(token, target) {
  requireThat(typeof token === 'string' && token.length <= 4096 &&
    new RegExp(`^vercel_blob_rw_${target.storeId.slice(6)}_[A-Za-z0-9_-]+$`, 'i').test(token), 'credential_store_mismatch');
}
function objectId(token, pathname) { return createHmac('sha256', token).update(`video-os-storage-object/v1\0${pathname}`).digest('hex'); }
function manifestIdentity(manifest) { return sha256(canonicalJson(manifest)); }
function validateManifest(manifest, target, bounds) {
  requireThat(manifest?.schemaVersion === EXPECTATIONS_SCHEMA && sameTarget(manifest.target, target), 'manifest_target_mismatch');
  requireThat(typeof manifest.observedAt === 'string' && Number.isFinite(Date.parse(manifest.observedAt)), 'manifest_timestamp_missing');
  requireThat(Array.isArray(manifest.assets) && manifest.assets.length > 0 && manifest.assets.length <= bounds.maxObjects, 'manifest_count_invalid');
  const seen = new Set(); let total = 0;
  for (const asset of manifest.assets) {
    requireThat(pathnameOkay(asset.privatePathname) && MEDIA_PREFIXES.some((p) => asset.privatePathname.startsWith(p)), 'manifest_path_out_of_scope');
    requireThat(!seen.has(asset.privatePathname), 'manifest_duplicate_path'); seen.add(asset.privatePathname);
    requireThat(integer(asset.bytes, bounds.maxObjectBytes) && /^[a-f0-9]{64}$/.test(asset.sha256), 'manifest_expectation_invalid');
    total += asset.bytes; requireThat(integer(total, bounds.maxTotalBytes), 'manifest_byte_bound_exceeded');
  }
  return total;
}
function validateObject(blob, target, bounds) {
  requireThat(blob && pathnameOkay(blob.pathname) && integer(blob.size, bounds.maxObjectBytes), 'invalid_list_object');
  let url; try { url = new URL(blob.url); } catch { throw new VerificationError('invalid_list_url'); }
  requireThat(url.protocol === 'https:' && url.hostname === expectedHost(target) && !url.port && !url.username && !url.password && !url.search && !url.hash, 'list_store_or_access_mismatch');
  let decoded; try { decoded = decodeURIComponent(url.pathname.slice(1)); } catch { throw new VerificationError('invalid_list_path'); }
  requireThat(decoded === blob.pathname, 'list_path_mismatch');
  const uploadedAt = new Date(blob.uploadedAt).toISOString();
  requireThat(typeof blob.etag === 'string' && blob.etag.length > 0 && blob.etag.length <= 512 && !/[\r\n]/.test(blob.etag), 'list_version_missing');
  return { pathname: blob.pathname, size: blob.size, uploadedAt, etag: blob.etag };
}
function budget(bounds) { return { deadline: Date.now() + bounds.runTimeoutMs, bounds }; }
async function timed(operation, state) {
  const remaining = state.deadline - Date.now(); requireThat(remaining > 0, 'run_timeout');
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new VerificationError('request_timeout')); }, Math.min(remaining, state.bounds.requestTimeoutMs)); }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}
async function sdkListPage(options) {
  assertSafeRuntime(process.env);
  const { list } = await import('@vercel/blob'); return list(options);
}
// No alternate credential API/proxy endpoints, even when inherited from a shell.
export function assertSafeRuntime(env = process.env) {
  requireThat(env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'tls_verification_disabled');
  for (const key of Object.keys(env)) {
    requireThat(!/^(NEXT_PUBLIC_)?VERCEL_BLOB_(API_URL|API_VERSION_OVERRIDE|PROXY_THROUGH_ALTERNATIVE_API)$/.test(key) || !env[key], 'blob_api_override_rejected');
  }
  requireThat(!env.DEBUG && !env.NEXT_PUBLIC_DEBUG &&
    !/http|undici|net/i.test(String(env.NODE_DEBUG || '')), 'transport_debug_logging_rejected');
}
async function listInventory({ token, target, bounds, listPage }, state) {
  const objects = []; const paths = new Set(); const cursors = new Set(); let cursor; let total = 0;
  for (let pageNo = 0; ; pageNo += 1) {
    requireThat(pageNo < bounds.maxPages, 'list_page_bound_exceeded');
    let page;
    try { page = await timed((abortSignal) => listPage({ token, cursor, limit: Math.min(1000, bounds.maxObjects + 1), abortSignal }), state); }
    catch (error) { throw error instanceof VerificationError ? error : new VerificationError('authenticated_list_failed'); }
    requireThat(page && Array.isArray(page.blobs) && typeof page.hasMore === 'boolean', 'invalid_list_page');
    requireThat(objects.length + page.blobs.length <= bounds.maxObjects, 'list_count_bound_exceeded');
    for (const blob of page.blobs) {
      const entry = validateObject(blob, target, bounds);
      requireThat(!paths.has(entry.pathname), 'list_duplicate_path'); paths.add(entry.pathname);
      total += entry.size; requireThat(integer(total, bounds.maxTotalBytes), 'list_byte_bound_exceeded'); objects.push(entry);
    }
    if (!page.hasMore) break;
    requireThat(typeof page.cursor === 'string' && page.cursor.length > 0 && page.cursor.length <= 8192 && !cursors.has(page.cursor), 'list_cursor_invalid');
    cursors.add(page.cursor); cursor = page.cursor;
  }
  return objects.sort((a, b) => a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0);
}
function baseReport({ token, target, manifest, objects, mode, generatedAt }) {
  const referenced = new Set(manifest.assets.map((a) => a.privatePathname));
  const unreferenced = objects.filter((o) => !referenced.has(o.pathname));
  const quarantine = objects.filter((o) => o.pathname.startsWith(QUARANTINE));
  return {
    schemaVersion: REPORT_SCHEMA, mode, generatedAt, target,
    expectations: { sha256: manifestIdentity(manifest), objects: manifest.assets.length, bytes: manifest.assets.reduce((n, a) => n + a.bytes, 0), observedAt: manifest.observedAt },
    inventory: { objects: objects.length, bytes: objects.reduce((n, o) => n + o.size, 0), allPagesListed: true },
    retention: { unreferencedInSuppliedManifest: unreferenced.length, quarantinedRetained: quarantine.length,
      unreferencedObjectIds: unreferenced.map((o) => objectId(token, o.pathname)),
      quarantineObjectIds: quarantine.map((o) => objectId(token, o.pathname)), disposition: 'retain-without-mutation-pending-provenance-and-retention-review' },
    authority: { credentialBoundToExpectedStore: true, projectEnvironmentAndDatabaseProvenance: 'operator-supplied-not-independently-attested',
      dbManifestCompletenessVerified: false, sourceCopyVerified: false, migrationVerified: false,
      anonymousDenialVerified: false, ownerAndWrongAccountAccessVerified: false, releaseAuthorized: false, destructiveActionsAuthorized: false },
    limitations: ['Listing is bounded metadata discovery, not a transactional store freeze.', 'Matches validate current bytes against supplied DB hashes only; they are not source-copy or migration proof.',
      'Unreferenced means absent from this manifest only; all such objects and quarantine remain retained.'],
  };
}
export async function discoverPrivateMedia({ token, target, manifest, bounds: inputBounds, listPage = sdkListPage, generatedAt = new Date().toISOString() } = {}) {
  assertSafeRuntime(process.env);
  target = validateTarget(target); const bounds = validateBounds(inputBounds); validateCredential(token, target); validateManifest(manifest, target, bounds);
  const objects = await listInventory({ token, target, bounds, listPage }, budget(bounds));
  const snapshot = { schemaVersion: SNAPSHOT_SCHEMA, target, generatedAt, manifestSha256: manifestIdentity(manifest), bounds, objects };
  return { snapshot, report: { ...baseReport({ token, target, manifest, objects, mode: 'discover', generatedAt }), status: 'metadata-only', byteVerificationPerformed: false, snapshotSha256: sha256(canonicalJson(snapshot)) } };
}
function validateSnapshot(snapshot, target, manifest, pinnedSha256) {
  requireThat(/^[a-f0-9]{64}$/.test(pinnedSha256 || '') && sha256(canonicalJson(snapshot)) === pinnedSha256, 'snapshot_digest_mismatch');
  requireThat(snapshot?.schemaVersion === SNAPSHOT_SCHEMA && sameTarget(snapshot.target, target) && snapshot.manifestSha256 === manifestIdentity(manifest), 'snapshot_target_or_manifest_mismatch');
  const bounds = validateBounds(snapshot.bounds);
  requireThat(Array.isArray(snapshot.objects) && snapshot.objects.length <= bounds.maxObjects, 'snapshot_count_invalid');
  const paths = new Set(); let total = 0;
  for (const object of snapshot.objects) {
    requireThat(pathnameOkay(object.pathname) && integer(object.size, bounds.maxObjectBytes) && typeof object.etag === 'string' && object.etag && !/[\r\n]/.test(object.etag), 'snapshot_object_invalid');
    requireThat(!paths.has(object.pathname), 'snapshot_duplicate_path'); paths.add(object.pathname);
    total += object.size; requireThat(integer(total, bounds.maxTotalBytes), 'snapshot_byte_bound_exceeded');
  }
  return bounds;
}
async function hashPrivateObject({ asset, listed, token, target, fetchImpl, state }) {
  const url = new URL(`https://${expectedHost(target)}/${asset.privatePathname.split('/').map(encodeURIComponent).join('/')}`);
  url.searchParams.set('cache', '0'); // documented consistent private origin read; no auth in URLs
  return timed(async (signal) => {
    let response; let reader;
    try {
      response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', credentials: 'omit', signal,
        headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'identity', 'if-match': listed.etag } });
      requireThat(!response.redirected && (!response.url || response.url === url.href), 'redirect_or_response_url_rejected');
      requireThat(response.status === 200, 'private_read_status_rejected');
      requireThat(!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity', 'content_encoding_rejected');
      requireThat(!response.headers.get('content-range'), 'partial_content_rejected');
      const length = response.headers.get('content-length');
      requireThat(/^(0|[1-9][0-9]*)$/.test(length || '') && Number(length) === asset.bytes && Number(length) === listed.size, 'content_length_mismatch');
      requireThat(response.headers.get('etag') === listed.etag, 'read_version_mismatch');
      requireThat(response.body && typeof response.body.getReader === 'function', 'read_body_missing');
      reader = response.body.getReader(); const hash = createHash('sha256'); let bytes = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        requireThat(value instanceof Uint8Array, 'read_chunk_invalid'); bytes += value.byteLength;
        requireThat(bytes <= asset.bytes && bytes <= state.bounds.maxObjectBytes, 'stream_byte_bound_exceeded'); hash.update(value);
      }
      requireThat(bytes === asset.bytes, 'stream_length_mismatch');
      const actualSha256 = hash.digest('hex');
      return { bytes, matched: actualSha256 === asset.sha256,
        evidenceHmac: createHmac('sha256', token).update(`video-os-private-media-byte-proof/v1\0${asset.privatePathname}\0${bytes}\0${actualSha256}\0${listed.etag}`).digest('hex') };
    } finally {
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else if (response?.body) await response.body.cancel().catch(() => {});
    }
  }, state);
}
export async function verifyPrivateMedia({ token, target, manifest, snapshot, snapshotSha256, listPage = sdkListPage, fetchImpl = globalThis.fetch, generatedAt = new Date().toISOString() } = {}) {
  assertSafeRuntime(process.env);
  target = validateTarget(target); validateCredential(token, target);
  const bounds = validateSnapshot(snapshot, target, manifest, snapshotSha256); validateManifest(manifest, target, bounds);
  const state = budget(bounds); const objects = await listInventory({ token, target, bounds, listPage }, state);
  requireThat(canonicalJson(objects) === canonicalJson(snapshot.objects), 'inventory_drift_before_reads');
  const byPath = new Map(objects.map((o) => [o.pathname, o]));
  // Reconcile every expected object before any media transfer.
  const results = manifest.assets.map((a) => ({ objectId: objectId(token, a.privatePathname), expectedBytes: a.bytes,
    status: !byPath.has(a.privatePathname) ? 'missing-retained' : byPath.get(a.privatePathname).size !== a.bytes ? 'metadata-length-mismatch-retained' : 'not-read-retained' }));
  let failure = results.some((r) => r.status !== 'not-read-retained');
  if (!failure) {
    for (let i = 0; i < manifest.assets.length; i += 1) {
      const asset = manifest.assets[i];
      try {
        const checked = await hashPrivateObject({ asset, listed: byPath.get(asset.privatePathname), token, target, fetchImpl, state });
        results[i] = { ...results[i], observedBytes: checked.bytes, status: checked.matched ? 'sha256-match' : 'sha256-mismatch-retained', evidenceHmac: checked.evidenceHmac };
        if (!checked.matched) { failure = true; break; }
      } catch (error) {
        results[i].status = 'read-failed-retained';
        results[i].reason = error instanceof VerificationError ? error.code : 'authenticated_read_failed'; failure = true; break;
      }
    }
  }
  let stable = false;
  try { stable = canonicalJson(objects) === canonicalJson(await listInventory({ token, target, bounds, listPage }, state)); }
  catch { /* Report incomplete recheck without leaking SDK/network errors. */ }
  return { ...baseReport({ token, target, manifest, objects, mode: 'verify', generatedAt }),
    status: failure || !stable ? 'failed-retained' : 'current-private-bytes-match-supplied-db-hashes',
    snapshotSha256, byteVerificationPerformed: results.some((r) => r.status !== 'not-read-retained' && !r.status.startsWith('missing') && !r.status.startsWith('metadata')),
    inventoryStableAcrossReads: stable, verifiedObjects: results.filter((r) => r.status === 'sha256-match').length, results };
}

function isInside(parent, candidate) { const rel = relative(parent, candidate); return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel)); }
// Native Windows does not enforce POSIX mode 0600. Verify the effective NTFS
// ACL instead; never weaken/inherit/repair an existing ACL on the user's behalf.
// Commands are fixed and paths are data-only base64. No storage token or other
// application environment is inherited by PowerShell. Actual Windows execution
// must still be qualified on a Windows host; tests here mock this boundary.
export async function assertWindowsPrivatePath(path, { directory = false, execute = promisify(execFile), systemRoot = process.env.SystemRoot } = {}) {
  requireThat(typeof systemRoot === 'string' && /^[A-Za-z]:[\\/]/.test(systemRoot), 'windows_acl_verification_unavailable');
  const encodedPath = Buffer.from(path, 'utf16le').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
$target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))
$isDirectory = $${directory ? 'true' : 'false'}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$entry = Get-Item -LiteralPath $target -Force
if ($entry.PSIsContainer -ne $isDirectory) { throw 'type' }
$ancestor = $entry
while ($null -ne $ancestor) {
  if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
  if ($ancestor.PSIsContainer) { $ancestor = $ancestor.Parent } else { $ancestor = $ancestor.Directory }
}
function Assert-PrivateDirectory($item) {
  $acl = Get-Acl -LiteralPath $item.FullName
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1) { throw 'directory-acl' }
  $rule = $rules[0]
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'directory-rule' }
}
if ($isDirectory) { Assert-PrivateDirectory $entry } else {
  Assert-PrivateDirectory $entry.Directory
  $acl = Get-Acl -LiteralPath $entry.FullName
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1) { throw 'file-acl' }
  $rule = $rules[0]
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or (-not $rule.IsInherited -and -not $acl.AreAccessRulesProtected)) { throw 'file-rule' }
}
[Console]::Out.Write('private-acl-ok')`;
  try {
    const result = await execute(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10000, maxBuffer: 4096, env: { SystemRoot: systemRoot, WINDIR: systemRoot } });
    requireThat(result.stdout === 'private-acl-ok' && !result.stderr, 'windows_private_acl_unverified');
  } catch { throw new VerificationError('windows_private_acl_unverified'); }
}
async function privatePath(path, repositoryRoot, existing) {
  requireThat(typeof path === 'string' && isAbsolute(path), 'private_path_must_be_absolute');
  if (process.platform === 'win32') await assertWindowsPrivatePath(existing ? path : dirname(path), { directory: !existing });
  const root = await realpath(repositoryRoot);
  const actual = existing ? await realpath(path) : resolve(await realpath(dirname(path)), path.split(/[\\/]/).at(-1));
  requireThat(!isInside(root, actual), 'private_file_inside_repository'); return actual;
}
async function readPrivateJson(path, repositoryRoot) {
  path = await privatePath(path, repositoryRoot, true); const handle = await open(path, 'r');
  try { const stat = await handle.stat(); requireThat(stat.isFile() && stat.size <= MAX_JSON_BYTES && (process.platform === 'win32' || (stat.mode & 0o077) === 0), 'private_file_permissions_or_size'); return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
}
async function createJson(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await handle.close(); }
}
async function preflightOutput(path) {
  const parent = await realpath(dirname(path));
  const destination = resolve(parent, path.split(/[\\/]/).at(-1));
  await access(parent, constants.W_OK);
  try { await lstat(destination); }
  catch (error) { if (error?.code === 'ENOENT') return destination; throw error; }
  const error = new Error('output_already_exists'); error.code = 'EEXIST'; throw error;
}
const HELP = `Read-only private media discovery and SHA-256 verification. No live DB access or writes.
Use an already configured terminal with BLOB_READ_WRITE_TOKEN injected. Never put a token in arguments/files.
Discovery (no guessed expected count/bytes):
  node tools/verify-private-media.mjs --mode discover --manifest /private/db-assets.json --store-id store_ID --project-id prj_ID --environment production --private-snapshot /private/new-snapshot.json --report /private/discovery-safe.json
Optional discovery bounds (may only reduce hard limits): --max-objects 100 --max-total-bytes 100000000 --max-object-bytes 60000000
After reviewing the discovery report, pin its snapshotSha256 for verification:
  node tools/verify-private-media.mjs --mode verify --manifest /private/db-assets.json --store-id store_ID --project-id prj_ID --environment production --snapshot /private/new-snapshot.json --snapshot-sha256 DIGEST --report /private/verification-safe.json
Manifest schema: video-os-private-media-expectations/v1; observedAt; target {storeId,projectId,environment,access:private}; assets [{privatePathname,bytes,sha256,kind}].
Manifest/snapshot must already be private and outside the checkout. POSIX requires 0600; Windows requires a current-SID-owned protected parent DACL with only current-SID FullControl and file/container inheritance, plus matching file ownership/effective ACLs. Windows ACL checks are read-only, reject reparse points, and fail closed if unavailable; this implementation has mocked coverage but has not been run on a native Windows host. The tool does not create or change ACLs. Outputs are create-only (0600 on POSIX). Only DB-manifest upload/final paths are downloaded; all other objects stay retained. Stored-hash matches cannot clear migration, source-copy, access-denial, P0 or release gates.\n`;
export async function runPrivateMediaCli(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const stdout = dependencies.stdout || ((s) => process.stdout.write(s));
  if (argv.length === 1 && argv[0] === '--help') { stdout(HELP); return { exitCode: 0 }; }
  const allowed = new Set(['mode','manifest','store-id','project-id','environment','private-snapshot','snapshot','snapshot-sha256','report','max-objects','max-total-bytes','max-object-bytes']);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2); requireThat(argv[i]?.startsWith('--') && allowed.has(key) && !Object.hasOwn(args, key) && argv[i + 1] && !argv[i + 1].startsWith('--'), 'invalid_arguments'); args[key] = argv[i + 1];
  }
  requireThat(['discover','verify'].includes(args.mode) && args.report, 'invalid_arguments'); assertSafeRuntime(env); assertSafeRuntime(process.env);
  const reportDestination = await preflightOutput(resolve(args.report));
  const repositoryRoot = dependencies.repositoryRoot || resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = await readPrivateJson(args.manifest, repositoryRoot);
  const target = { storeId: args['store-id'], projectId: args['project-id'], environment: args.environment, access: 'private' };
  const common = { token: env.BLOB_READ_WRITE_TOKEN, target, manifest, listPage: dependencies.listPage, fetchImpl: dependencies.fetchImpl };
  let report;
  if (args.mode === 'discover') {
    requireThat(!args.snapshot && !args['snapshot-sha256'], 'invalid_arguments');
    const destination = await preflightOutput(await privatePath(args['private-snapshot'], repositoryRoot, false));
    requireThat(destination !== reportDestination, 'output_paths_must_differ');
    const bounds = {};
    for (const [flag, key] of [['max-objects','maxObjects'],['max-total-bytes','maxTotalBytes'],['max-object-bytes','maxObjectBytes']]) if (args[flag]) { requireThat(/^[1-9][0-9]*$/.test(args[flag]), 'invalid_bounds'); bounds[key] = Number(args[flag]); }
    const result = await discoverPrivateMedia({ ...common, bounds });
    await createJson(destination, result.snapshot); report = result.report;
  } else {
    requireThat(!args['private-snapshot'] && !args['max-objects'] && !args['max-total-bytes'] && !args['max-object-bytes'], 'invalid_arguments');
    const snapshot = await readPrivateJson(args.snapshot, repositoryRoot);
    report = await verifyPrivateMedia({ ...common, snapshot, snapshotSha256: args['snapshot-sha256'] });
  }
  await createJson(reportDestination, report); stdout(`${JSON.stringify(report)}\n`);
  return { report, exitCode: report.status === 'failed-retained' ? 2 : 0 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPrivateMediaCli().then(({ exitCode }) => { process.exitCode = exitCode; }).catch((error) => {
    const code = error instanceof VerificationError ? error.code : error?.code === 'EEXIST' ? 'output_already_exists' : 'verification_failed';
    process.stderr.write(`Private media verification failed closed: ${code}.\n`); process.exitCode = 2;
  });
}
