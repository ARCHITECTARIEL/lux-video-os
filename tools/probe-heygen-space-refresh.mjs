import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHeygenSpaceReprobeOrigin, validateHeygenSpaceReprobeQualification } from '../lib/heygen-space-anchor.js';
import { qualifyHeygenCredential } from '../services/heygen-account-qualification.js';

// Operator-only, one-shot collector. Importing this module never performs I/O.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = new URL('../docs/execution-notes/binding-readiness-20261001/provider-space-probe.png', import.meta.url);
const API = 'https://api.heygen.com';
const FILES = ['qualification.json', 'upload.json', 'read.json', 'delete.json', 'readback.json'];
const TIMEOUT_MS = 8000;
const MAX_BODY = 120 * 1024; // Receipt envelope must still fit the 128 KiB consumer limit.
const ID = /^[A-Za-z0-9_:-][A-Za-z0-9_.:-]{0,254}$/;
const COST_POLICY = 'explicitly-approved-without-enforceable-provider-price-cap';
const BUDGET = Object.freeze({ qualificationGets: 2, assetUploads: 1, assetMetadataGets: 1,
  assetDeletes: 1, assetReadbacks: 1, mutationRetries: 0, generationCalls: 0 });
const LIVE_FETCH = globalThis.fetch?.bind(globalThis);
const TEST_CONTEXT = String(process.env.NODE_TEST_CONTEXT || '').startsWith('child');
const OWN_ERRORS = new WeakSet();
function fail(code) { const e = Object.assign(new Error('HeyGen reprobe stopped; inspect protected local evidence.'), {code}); OWN_ERRORS.add(e); throw e; }
function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
function exact(v, keys) { if (!object(v) || Object.keys(v).sort().join('\0') !== [...keys].sort().join('\0')) fail('REPROBE_INVALID_INPUT'); }
const digest = value => createHash('sha256').update(value).digest('hex');
function iso(v) { if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail('REPROBE_INVALID_INPUT'); return Date.parse(v); }
function clock(now) { const d = new Date(now()); if (!Number.isFinite(d.getTime())) fail('REPROBE_INVALID_CLOCK'); return d; }
function safePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path) || /[\u0000-\u001f\u007f]/.test(path)) fail('REPROBE_UNSAFE_PATH');
  const rel = relative(ROOT, path);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) fail('REPROBE_PRIVATE_PATH_REQUIRED');
}
function mode(stat, directory) {
  if (process.platform === 'win32' || !Number.isInteger(process.getuid?.()) || stat.uid !== process.getuid()
    || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || (!directory && stat.nlink !== 1)) fail('REPROBE_PRIVATE_MODE_REQUIRED');
}
async function privateDirectory(path) { safePath(path); if (await realpath(path) !== path) fail('REPROBE_UNSAFE_PATH'); mode(await lstat(path), true); }
async function readPrivate(path) {
  safePath(path); await privateDirectory(dirname(path));
  const pre = await lstat(path); mode(pre, false);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(); mode(stat, false);
    if (stat.ino !== pre.ino || stat.dev !== pre.dev || stat.size < 1 || stat.size > 16384) fail('REPROBE_INVALID_APPROVAL');
    const bytes = await file.readFile(); if (bytes.length !== stat.size) fail('REPROBE_INVALID_APPROVAL');
    try { return JSON.parse(bytes.toString('utf8')); } catch { fail('REPROBE_INVALID_APPROVAL'); }
  } finally { await file.close(); }
}
async function syncDirectory(path) { const f = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await f.sync(); } finally { await f.close(); } }
async function writeOnce(path, value, key) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > 131072) fail('REPROBE_RECEIPT_TOO_LARGE');
  if (key && bytes.includes(Buffer.from(key))) fail('REPROBE_SECRET_IN_RESPONSE');
  const f = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
  await syncDirectory(dirname(path));
}
function credential(env) {
  const key = env.HEYGEN_API_KEY;
  if (typeof key !== 'string' || key !== key.trim() || !key.length || key.length > 1024 || /[\r\n\u0000]/.test(key)) fail('REPROBE_CREDENTIAL_UNAVAILABLE');
  return key;
}
function approvalTemplate(origin, runDirectory) {
  return { version: 'heygen-space-reprobe-approval/v1', approvalId: null, approvedAt: null, expiresAt: null,
    runDirectory, originIdentityDigest: origin.identityDigest, fixtureSha256: origin.fixtureSha256,
    operations: BUDGET, costPolicy: COST_POLICY, ownerApproved: false,
    irreversibleDeletionOfNewProbeOnlyApproved: false, noRetryAndPossibleRetainedAssetAccepted: false };
}
function validateApproval(a, origin, directory, now) {
  exact(a, Object.keys(approvalTemplate(origin, directory)));
  if (a.version !== 'heygen-space-reprobe-approval/v1' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a.approvalId)
    || a.runDirectory !== directory || a.originIdentityDigest !== origin.identityDigest || a.fixtureSha256 !== origin.fixtureSha256
    || a.ownerApproved !== true || a.irreversibleDeletionOfNewProbeOnlyApproved !== true || a.noRetryAndPossibleRetainedAssetAccepted !== true
    || a.costPolicy !== COST_POLICY) fail('REPROBE_APPROVAL_REQUIRED');
  exact(a.operations, Object.keys(BUDGET));
  if (Object.keys(BUDGET).some(k => a.operations[k] !== BUDGET[k])) fail('REPROBE_APPROVAL_REQUIRED');
  const start = iso(a.approvedAt), end = iso(a.expiresAt), current = now.getTime();
  if (end <= start || end - start > 3600000 || current < start || current >= end) fail('REPROBE_APPROVAL_EXPIRED');
}
function parseArgs(args) {
  if (!Array.isArray(args) || args.some(x => typeof x !== 'string') || args.length % 2 !== 1) fail('REPROBE_ARGUMENTS');
  const command = args[0]; if (!['--execute', '--approval-template'].includes(command)) fail('REPROBE_ARGUMENTS');
  const opts = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!['--private-run-dir', '--approval-file'].includes(args[i]) || Object.hasOwn(opts, args[i])) fail('REPROBE_ARGUMENTS');
    opts[args[i]] = args[i + 1];
  }
  if (!opts['--private-run-dir'] || (command === '--execute' ? !opts['--approval-file'] : opts['--approval-file'])) fail('REPROBE_ARGUMENTS');
  safePath(opts['--private-run-dir']); if (opts['--approval-file']) safePath(opts['--approval-file']);
  return { command, directory: opts['--private-run-dir'], approvalFile: opts['--approval-file'] };
}
function abortable(promise, signal) {
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(v => {signal.removeEventListener('abort', abort); resolvePromise(v);}, e => {signal.removeEventListener('abort', abort); reject(e);});
  });
}
async function request(fetchImpl, apiKey, method, path, body) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    const url = `${API}${path}`;
    response = await abortable(Promise.resolve().then(() => fetchImpl(url, { method,
      headers: { Accept: 'application/json', 'X-Api-Key': apiKey }, redirect: 'error', signal: controller.signal,
      ...(body ? {body} : {}) })), controller.signal);
    if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599
      || response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) fail('REPROBE_UNSAFE_RESPONSE');
    if (!response.body || typeof response.body.getReader !== 'function') fail('REPROBE_UNSAFE_RESPONSE');
    const declared = response.headers?.get?.('content-length');
    if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) fail('REPROBE_RESPONSE_TOO_LARGE');
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try {
      while (true) {
        const {done, value} = await abortable(reader.read(), controller.signal); if (done) break;
        const chunk = Buffer.from(value); length += chunk.length;
        if (length > MAX_BODY) fail('REPROBE_RESPONSE_TOO_LARGE');
        chunks.push(chunk);
      }
    } catch (e) { void reader.cancel().catch(() => {}); throw e; }
    finally { try {reader.releaseLock();} catch { /* Cancelled reader. */ } }
    const bytes = Buffer.concat(chunks);
    if (bytes.includes(Buffer.from(apiKey))) fail('REPROBE_SECRET_IN_RESPONSE');
    let payload; try {payload = JSON.parse(bytes.toString('utf8'));} catch {fail('REPROBE_MALFORMED_RESPONSE');}
    if (!object(payload)) fail('REPROBE_MALFORMED_RESPONSE');
    return {status: response.status, payload};
  } catch (e) { if (OWN_ERRORS.has(e)) throw e; fail(controller.signal.aborted ? 'REPROBE_TIMEOUT_UNCERTAIN' : 'REPROBE_NETWORK_UNCERTAIN'); }
  finally {
    controller.abort(); clearTimeout(timer);
    if (response?.body && !response.body.locked) { try {void response.body.cancel().catch(() => {});} catch { /* best effort cancellation */ } }
  }
}
function successful(result) { if (result.status !== 200 || (result.payload.error !== null && result.payload.error !== undefined) || !object(result.payload.data)) fail('REPROBE_PROVIDER_REJECTED'); return result.payload.data; }

async function collect(input, deps) {
  exact(input, ['args', 'stdout', 'stderr']);
  const {command, directory, approvalFile} = parseArgs(input.args);
  if (['production', 'preview'].includes(String(deps.env.VERCEL_ENV || '').trim().toLowerCase()) || deps.env.VERCEL === '1') fail('REPROBE_OPERATOR_ONLY');
  const origin = await deps.loadOrigin();
  if (command === '--approval-template') { input.stdout.write(`${JSON.stringify(approvalTemplate(origin, directory), null, 2)}\n`); return; }
  await privateDirectory(dirname(directory));
  if (dirname(approvalFile) !== dirname(directory)) fail('REPROBE_APPROVAL_DIRECTORY_MISMATCH');
  const approval = await readPrivate(approvalFile);
  validateApproval(approval, origin, directory, clock(deps.now));
  if (clock(deps.now).getTime() <= iso(origin.spaceObservedAt)) fail('REPROBE_ORIGIN_NOT_HISTORICAL');
  const apiKey = credential(deps.env);
  // Refuse a different credential before sending even the read-only qualification.
  if (digest(Buffer.concat([Buffer.from('LUX_VIDEO_OS\0HEYGEN_CREDENTIAL_KEY\0V1\0'), Buffer.from(apiKey)])) !== origin.credentialKeyFingerprint) fail('REPROBE_CREDENTIAL_IDENTITY_MISMATCH');
  const fixtureFile = await open(FIXTURE, constants.O_RDONLY | constants.O_NOFOLLOW);
  let fixture;
  try {const stat = await fixtureFile.stat(); if (!stat.isFile() || stat.size !== 95) fail('REPROBE_FIXTURE_MISMATCH'); fixture = await fixtureFile.readFile();} finally {await fixtureFile.close();}
  if (fixture.length !== 95 || origin.fixtureBytes !== 95 || digest(fixture) !== origin.fixtureSha256
    || fixture.readUInt32BE(16) !== 32 || fixture.readUInt32BE(20) !== 32) fail('REPROBE_FIXTURE_MISMATCH');
  // mkdir and O_EXCL claims make replay fail closed, even after a crash.
  try {await mkdir(directory, {mode: 0o700});} catch {fail('REPROBE_RUN_ALREADY_EXISTS');}
  await privateDirectory(directory); await syncDirectory(dirname(directory));
  await writeOnce(resolve(dirname(directory), `.heygen-reprobe-${approval.approvalId}.consumed.json`), {
    version: 'heygen-space-reprobe-consumed/v1', approval, consumedAt: clock(deps.now).toISOString(),
  }, apiKey);
  await mkdir(resolve(directory, 'partial'), {mode: 0o700}); await syncDirectory(directory);
  const journal = await open(resolve(directory, 'journal.jsonl'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const log = async value => {await journal.write(`${JSON.stringify(value)}\n`); await journal.sync();};
  const claims = new Set(); let qualification, lastTime = -Infinity;
  function observedAt() { const current = clock(deps.now); if (current.getTime() < lastTime) fail('REPROBE_CLOCK_REGRESSED'); lastTime = current.getTime(); return current.toISOString(); }
  const checkWindow = () => {
    const current = clock(deps.now); validateApproval(approval, origin, directory, current);
    if (qualification && (current.getTime() < Date.parse(qualification.observedAt) || current.getTime() - Date.parse(qualification.observedAt) >= 60000)) fail('REPROBE_QUALIFICATION_STALE');
  };
  const claim = async (name, method, pathTemplate) => {
    checkWindow(); if (claims.has(name)) fail('REPROBE_REPLAY_DENIED'); claims.add(name);
    const item = {operation: name, method, pathTemplate, state: 'intent-consumed-before-network', observedAt: observedAt()};
    await writeOnce(resolve(directory, `${name}.claim.json`), item, apiKey); await log(item);
  };
  async function receipt(name, method, path, body, assetId) {
    const template = name === 'upload' ? '/v3/assets' : '/v3/assets/{probe_asset_id}';
    await claim(name, method, template);
    checkWindow(); // fsync may take time: recheck immediately before dispatch.
    const result = await request(deps.fetchImpl, apiKey, method, path, body);
    // Keep an acknowledged asset response even if the clock has regressed.
    // This unpromoted private record supports separately authorized recovery.
    await writeOnce(resolve(directory, `${name}.response.json`), {method, pathTemplate: template, status: result.status, payload: result.payload}, apiKey);
    const timestamp = observedAt();
    // Preserve a bounded response even when later identity/cleanup validation fails.
    const responseAssetId = name === 'upload' ? result.payload.data?.asset_id : assetId;
    const evidence = {method, pathTemplate: template, observedAt: timestamp, status: result.status,
      errorCode: result.payload.error?.code ?? null, data: result.payload.data ?? null,
      assetIdSha256: typeof responseAssetId === 'string' ? digest(responseAssetId) : null, fixtureSha256: origin.fixtureSha256};
    await writeOnce(resolve(directory, 'partial', `${name}.json`), evidence, apiKey);
    await log({operation: name, state: 'response-observed', status: result.status, observedAt: timestamp});
    checkWindow(); return result;
  }
  try {
    await log({state: 'started', observedAt: observedAt(), operations: BUDGET, costCapEnforced: false});
    // The stop-only hook consumes each GET immediately before the qualifier's
    // fixed transport. It cannot replace that transport or manufacture a result.
    qualification = await qualifyHeygenCredential({apiKey, now: clock(deps.now), timeoutMs: TIMEOUT_MS,
      beforeRequest: async ({method, pathTemplate}) => {
        const name = pathTemplate === '/v3/api_keys/self' ? 'qualification-self'
          : pathTemplate === '/v3/users/me' ? 'qualification-profile' : null;
        if (!name || method !== 'GET') fail('REPROBE_UNEXPECTED_QUALIFICATION_REQUEST');
        await claim(name, method, pathTemplate); checkWindow();
      },
      ...(deps.testTransport ? {fetchImpl: deps.fetchImpl} : {})});
    await writeOnce(resolve(directory, 'partial', FILES[0]), qualification, apiKey);
    await deps.validateQualification(origin, qualification, {now: clock(deps.now)});
    checkWindow(); lastTime = Math.max(lastTime, Date.parse(qualification.observedAt));
    await log({operation: 'qualification', state: 'identity-verified', observedAt: observedAt()});
    const form = new FormData(); form.append('file', new Blob([fixture], {type: 'image/png'}), 'provider-space-probe.png');
    const upload = successful(await receipt('upload', 'POST', '/v3/assets', form));
    const id = upload.asset_id;
    if (typeof id !== 'string' || !ID.test(id) || upload.mime_type !== 'image/png' || upload.size_bytes !== 95) fail('REPROBE_UPLOAD_MISMATCH');
    const path = `/v3/assets/${encodeURIComponent(id)}`;
    const read = successful(await receipt('read', 'GET', path, undefined, id));
    if (read.id !== id || read.type !== 'image' || read.owner !== qualification.privateEvidence.profile.username
      || typeof read.space_id !== 'string' || !ID.test(read.space_id)
      || digest(JSON.stringify({provider: 'heygen', scopeType: 'space', spaceId: read.space_id})) !== origin.providerSpaceFingerprint) fail('REPROBE_ASSET_IDENTITY_MISMATCH');
    await deps.validateQualification(origin, qualification, {now: clock(deps.now)});
    const deleted = successful(await receipt('delete', 'DELETE', path, undefined, id));
    if (deleted.id !== id) fail('REPROBE_DELETE_UNCERTAIN');
    const absent = await receipt('readback', 'GET', path, undefined, id);
    if (absent.status !== 404 || !object(absent.payload.error) || absent.payload.error.code !== 'asset_not_found'
      || (absent.payload.data !== undefined && absent.payload.data !== null)) fail('REPROBE_ABSENCE_UNCONFIRMED');
    await log({state: 'safe-api-cleanup-observed', observedAt: observedAt(), cdnDenialVerified: false, backupPurgeVerified: false, chargeMeasured: false});
    await rename(resolve(directory, 'partial'), resolve(directory, 'receipts')); await syncDirectory(directory);
    input.stdout.write('HeyGen reprobe completed: five private receipts are ready for independent review; no refresh installed.\n');
  } catch (error) {
    try {await log({state: 'stopped-no-retry', cleanupConfirmed: false, observedAt: clock(deps.now).toISOString()});} catch { /* Earlier durable intent still forbids replay. */ }
    throw error;
  } finally {await journal.close();}
}

const defaults = () => ({env: process.env, now: () => new Date(), fetchImpl: LIVE_FETCH,
  loadOrigin: loadHeygenSpaceReprobeOrigin, validateQualification: validateHeygenSpaceReprobeQualification, testTransport: false});
async function invoke(input, deps) {
  try {await collect(input, deps); return 0;}
  catch (error) {
    const code = OWN_ERRORS.has(error) ? error.code : 'REPROBE_STOPPED';
    input.stderr.write(`[heygen-space-reprobe] ${code}: No retry performed. Keep the private journal; cleanup may require separately authorized review.\n`); return 1;
  }
}
export async function runHeygenSpaceReprobe({args = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr} = {}) {
  return invoke({args, stdout, stderr}, defaults());
}
export async function runHeygenSpaceReprobeForTests(input, overrides) {
  if (!TEST_CONTEXT) fail('REPROBE_TEST_ONLY');
  if (!object(overrides) || Object.keys(overrides).some(k => !['env', 'now', 'fetchImpl', 'loadOrigin', 'validateQualification'].includes(k))) fail('REPROBE_TEST_ONLY');
  return invoke(input, {...defaults(), ...overrides, testTransport: true});
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runHeygenSpaceReprobe();
