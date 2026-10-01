import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(code) { throw Object.assign(new Error('Provider-space binding failed closed.'), { code }); }

export function parseSpaceBindingArguments(args) {
  const command = args[0];
  if (!['bootstrap', 'status'].includes(command)) fail('BINDING_COMMAND_UNSUPPORTED');
  // --owner-authorized is a standalone boolean flag (no value pair), so it is
  // filtered out before the strict key/value pairing below, and remembered
  // separately. It is only meaningful, and only required, for production.
  const ownerAuthorized = args.includes('--owner-authorized');
  const positional = args.slice(1).filter(arg => arg !== '--owner-authorized');
  const allowed = new Set(['--account-id', '--environment', ...(command === 'bootstrap' ? ['--private-evidence-dir'] : [])]);
  const values = {};
  for (let i = 0; i < positional.length; i += 2) {
    if (!allowed.has(positional[i]) || !positional[i + 1] || positional[i + 1].startsWith('--') || Object.hasOwn(values, positional[i])) fail('INVALID_BINDING_ARGUMENT');
    values[positional[i]] = positional[i + 1];
  }
  const environment = values['--environment'];
  if (environment !== 'verification' && environment !== 'production') fail('HEYGEN_BINDING_ENVIRONMENT_UNSUPPORTED');
  // Requesting --environment production alone is deliberately not enough --
  // see PRODUCTION_BINDING_NOT_EXPLICITLY_CONFIRMED in the repository, which
  // this flag feeds via VIDEO_OS_PRODUCTION_BINDING_CONFIRMED below.
  if (environment === 'production' && !ownerAuthorized) fail('PRODUCTION_BINDING_NOT_EXPLICITLY_CONFIRMED');
  const accountId = values['--account-id'];
  const controlCharacters = new RegExp('[\\u0000-\\u001f\\u007f]');
  if (typeof accountId !== 'string' || !accountId || accountId !== accountId.trim()
    || Buffer.byteLength(accountId, 'utf8') > 512 || controlCharacters.test(accountId)) fail('INVALID_BINDING_ACCOUNT');
  const privateEvidenceDir = values['--private-evidence-dir'];
  if (command === 'bootstrap' && (!privateEvidenceDir || !isAbsolute(privateEvidenceDir))) fail('PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');
  return { command, accountId, environment, ownerAuthorized, ...(privateEvidenceDir ? { privateEvidenceDir } : {}) };
}

export async function runSpaceBindingCli({ args = process.argv.slice(2), loadRepository = () => import('../db/heygen-space-binding-repository.js'), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const parsed = parseSpaceBindingArguments(args);
    // This administrative tool must never execute inside the deployed
    // production runtime, regardless of which target it is binding to.
    if (process.env.VERCEL_ENV === 'production') fail('CANONICAL_TARGET_UNVERIFIED');
    const repository = await loadRepository();
    process.env.VIDEO_OS_SPACE_BINDING_ENVIRONMENT = parsed.environment;
    if (parsed.environment === 'production') {
      process.env.VIDEO_OS_PRODUCTION_BINDING_CONFIRMED = repository.PRODUCTION_BINDING_CONFIRMATION_PHRASE;
    } else {
      delete process.env.VIDEO_OS_PRODUCTION_BINDING_CONFIRMED;
    }
    const binding = parsed.command === 'bootstrap'
      ? await repository.bootstrapVerifiedHeygenSpaceBinding({ accountId: parsed.accountId, privateEvidenceDir: parsed.privateEvidenceDir })
      : await repository.resolveFreshHeygenSpaceBinding({ accountId: parsed.accountId });
    const status = repository.safeHeygenSpaceBindingStatus(binding);
    if (status?.scopeType !== 'space' || status?.environment !== parsed.environment || status?.runtimeActivation !== false) fail('UNSAFE_BINDING_STATUS');
    const allowed = ['version', 'provider', 'scopeType', 'environment', 'verified', 'runtimeActivation', 'providerSpaceFingerprint', 'credentialScopeFingerprint', 'databaseBindingSha256', 'identityDigest', 'freshUntil', 'globalAccountIdVerified'];
    const publicStatus = Object.fromEntries(allowed.filter(name => Object.hasOwn(status, name)).map(name => [name, status[name]]));
    stdout.write(`${JSON.stringify({ command: parsed.command, ...publicStatus })}\n`);
    return { exitCode: 0, status: publicStatus };
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.code || '') ? error.code : 'SPACE_BINDING_FAILED';
    stderr.write(`[heygen-space-binding] ${code}: No provider mutation or production activation was performed.\n`);
    return { exitCode: 1, error: { code } };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await runSpaceBindingCli()).exitCode;
}
