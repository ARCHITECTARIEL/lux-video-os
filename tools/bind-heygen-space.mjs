import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(code) { throw Object.assign(new Error('Provider-space binding failed closed.'), { code }); }

export function parseSpaceBindingArguments(args) {
  const command = args[0];
  if (!['bootstrap', 'status'].includes(command)) fail('BINDING_COMMAND_UNSUPPORTED');
  const allowed = new Set(['--account-id', '--environment', ...(command === 'bootstrap' ? ['--private-evidence-dir'] : [])]);
  const values = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(values, args[i])) fail('INVALID_BINDING_ARGUMENT');
    values[args[i]] = args[i + 1];
  }
  // There is deliberately no production override or general approval flag.
  if (values['--environment'] !== 'verification') fail('CANONICAL_TARGET_UNVERIFIED');
  const accountId = values['--account-id'];
  if (typeof accountId !== 'string' || !accountId || accountId !== accountId.trim()
    || Buffer.byteLength(accountId, 'utf8') > 512 || /[\u0000-\u001f\u007f]/.test(accountId)) fail('INVALID_BINDING_ACCOUNT');
  const privateEvidenceDir = values['--private-evidence-dir'];
  if (command === 'bootstrap' && (!privateEvidenceDir || !isAbsolute(privateEvidenceDir))) fail('PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');
  return { command, accountId, environment: 'verification', ...(privateEvidenceDir ? { privateEvidenceDir } : {}) };
}

export async function runSpaceBindingCli({ args = process.argv.slice(2), loadRepository = () => import('../db/heygen-space-binding-repository.js'), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const parsed = parseSpaceBindingArguments(args);
    if (process.env.VERCEL_ENV === 'production') fail('CANONICAL_TARGET_UNVERIFIED');
    process.env.VIDEO_OS_SPACE_BINDING_ENVIRONMENT = 'verification';
    const repository = await loadRepository();
    const binding = parsed.command === 'bootstrap'
      ? await repository.bootstrapVerifiedHeygenSpaceBinding({ accountId: parsed.accountId, privateEvidenceDir: parsed.privateEvidenceDir })
      : await repository.resolveFreshHeygenSpaceBinding({ accountId: parsed.accountId });
    const status = repository.safeHeygenSpaceBindingStatus(binding);
    if (status?.scopeType !== 'space' || status?.environment !== 'verification' || status?.runtimeActivation !== false) fail('UNSAFE_BINDING_STATUS');
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
