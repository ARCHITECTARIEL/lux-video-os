import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const HEX64 = /^[a-f0-9]{64}$/;

export function buildCanaryRequest({ url, pin, deploymentId, gitCommit, projectId,
  targetManifestSha256, deploymentUrlSha256, operatorToken,
  now = new Date(), nonce = randomBytes(32) }) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.port
    || !/^[a-z0-9-]+\.vercel\.app$/.test(target.hostname)) {
    throw new Error('An HTTPS Vercel deployment URL without credentials or a custom port is required');
  }
  target.searchParams.set('operation', 'canary-scope');
  if (!Buffer.isBuffer(nonce) || nonce.length !== 32) throw new Error('32-byte nonce required');
  if (!deploymentId || !gitCommit || !projectId || !HEX64.test(targetManifestSha256 || '')) {
    throw new Error('Expected deployment, commit, project and target manifest are required');
  }
  const issuedAt = now.toISOString();
  const nonceHex = nonce.toString('hex');
  const message = `vos-canary-pin/v1|${sha256(deploymentId)}|${issuedAt}|${String(pin).trim()}`;
  const mac = createHmac('sha256', nonce).update(message).digest('hex');
  const headers = {
    'x-expected-deployment-sha256': sha256(deploymentId),
    'x-expected-git-commit-sha256': sha256(gitCommit),
    'x-expected-project-sha256': sha256(projectId),
    'x-expected-target-manifest-sha256': targetManifestSha256,
    'x-canary-nonce': nonceHex,
    'x-canary-issued-at': issuedAt,
    'x-expected-canary-pin-mac': mac,
  };
  if (deploymentUrlSha256) {
    if (!HEX64.test(deploymentUrlSha256)) throw new Error('Invalid deployment URL digest');
    headers['x-expected-deployment-url-sha256'] = deploymentUrlSha256;
  }
  return { url: target.toString(), headers: { ...headers, Authorization: `Bearer ${operatorToken || ''}` }, publicHeaders: headers };
}

export async function runCanaryScopeCheck(args, { fetchImpl = fetch, log = console.log,
  readPin = readFileSync, env = process.env, now = new Date(), nonce = randomBytes(32) } = {}) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--send' || arg === '--dry-run') { options.send = arg === '--send'; continue; }
    if (!arg.startsWith('--') || i + 1 >= args.length) throw new Error('Invalid arguments');
    options[arg.slice(2)] = args[++i];
  }
  if (!options.url || !options['pin-file']) throw new Error('--url and --pin-file are required');
  if (basename(options['pin-file']).toLowerCase().startsWith('.env')) throw new Error('Use a dedicated pin file');
  const pin = String(readPin(options['pin-file'], 'utf8')).trim();
  const request = buildCanaryRequest({ url: options.url, pin, deploymentId: options['deployment-id'],
    gitCommit: options['git-commit'], projectId: options['project-id'],
    targetManifestSha256: options['target-manifest-sha256'],
    deploymentUrlSha256: options['deployment-url-sha256'],
    operatorToken: env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_OPERATOR_TOKEN, now, nonce });
  if (!options.send) {
    log(JSON.stringify({ method: 'GET', url: request.url, headers: {
      ...request.publicHeaders, 'x-canary-nonce': '[redacted]',
      'x-expected-canary-pin-mac': '[redacted]',
    } }));
    return;
  }
  if (!env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_OPERATOR_TOKEN) throw new Error('Operator token is required');
  const response = await fetchImpl(request.url, { method: 'GET', headers: request.headers });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = {}; }
  const booleans = Object.fromEntries(Object.entries(body).filter(([, value]) => typeof value === 'boolean'));
  log(JSON.stringify({ ...booleans, responseBodySha256: sha256(raw) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCanaryScopeCheck(process.argv.slice(2)).catch(() => {
    console.error('Canary check failed; inspect arguments, access and endpoint status.');
    process.exitCode = 1;
  });
}
