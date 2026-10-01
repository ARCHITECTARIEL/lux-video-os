import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const adapterPath = resolve(root, 'services/heygen-reconciliation.js');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ALLOWED_COMMANDS = new Set(['plan', 'status']);
const DISABLED_COMMANDS = new Set(['execute', 'resume']);
const ALLOWED_VERBS = new Set(['read', 'delete', 'readback']);
const SNAPSHOT_VERSION = 'heygen-reconciliation-snapshot/v1';

function failure(code, safeMessage, exitCode = 1) {
  return Object.assign(new Error(safeMessage), { code, safeMessage, exitCode });
}

function exactText(value, label, maxLength = 255) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength
    || value !== value.trim() || /[\0-\x1f\x7f]/.test(value)) {
    throw failure('INVALID_ARGUMENT', `${label} is missing or invalid.`);
  }
  return value;
}

function exactUuid(value, label) {
  const normalized = exactText(value, label, 36);
  if (!UUID.test(normalized)) throw failure('INVALID_ARGUMENT', `${label} must be a canonical UUID.`);
  return normalized;
}

function exactSha256(value, label) {
  if (value === undefined) return undefined;
  const normalized = exactText(value, label, 64);
  if (!SHA256.test(normalized)) throw failure('INVALID_ARGUMENT', `${label} must be a lowercase SHA-256 digest.`);
  return normalized;
}

function commandFrom(argv) {
  const command = argv[0];
  if (DISABLED_COMMANDS.has(command)) {
    throw failure('EXECUTION_DISABLED', 'Provider reconciliation execution is not implemented.', 2);
  }
  if (!ALLOWED_COMMANDS.has(command)) {
    throw failure('COMMAND_REQUIRED', 'Use the read-only plan or status command.', 2);
  }
  return command;
}

function resourceAction(value) {
  const normalized = exactText(value, '--resource-action', 160);
  const separator = normalized.indexOf(':');
  if (separator < 0 || normalized.indexOf(':', separator + 1) >= 0) {
    throw failure('INVALID_RESOURCE_ACTION', 'Resource actions must use <resource-uuid>:<verb[,verb]> syntax.');
  }
  const resourceKey = exactUuid(normalized.slice(0, separator), 'resource key');
  const verbs = normalized.slice(separator + 1).split(',');
  if (verbs.length === 0 || verbs.some((verb) => !ALLOWED_VERBS.has(verb)) || new Set(verbs).size !== verbs.length) {
    throw failure('INVALID_RESOURCE_ACTION', 'Resource actions may contain unique read, delete, and readback verbs only.');
  }
  return { resourceKey, verbs };
}

export function parseCliArguments(argv) {
  const command = commandFrom(argv);
  const allowed = new Set([
    '--account-id',
    '--enrollment-id',
    '--target-manifest',
    '--environment',
    '--expected-target-sha256',
    ...(command === 'plan' ? ['--expires-at', '--cohort-id', '--resource-action', '--private-plan-output'] : []),
  ]);
  const repeatable = new Set(['--resource-action']);
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith('--')) {
      throw failure('INVALID_ARGUMENT', 'The reconciliation command contains an unknown or incomplete option.', 2);
    }
    if (!repeatable.has(flag) && values.has(flag)) {
      throw failure('INVALID_ARGUMENT', 'The reconciliation command contains a duplicate option.', 2);
    }
    values.set(flag, repeatable.has(flag) ? [...(values.get(flag) || []), value] : value);
  }

  const environment = exactText(values.get('--environment'), '--environment', 80);
  if (!['production', 'verification'].includes(environment)) {
    throw failure('INVALID_ARGUMENT', '--environment must be production or verification.');
  }
  const parsed = {
    command,
    accountId: exactText(values.get('--account-id'), '--account-id'),
    enrollmentId: exactUuid(values.get('--enrollment-id'), '--enrollment-id'),
    targetManifest: exactText(values.get('--target-manifest'), '--target-manifest', 2048),
    environment,
    expectedTargetSha256: exactSha256(values.get('--expected-target-sha256'), '--expected-target-sha256'),
  };

  if (command === 'plan') {
    const expiresAt = exactText(values.get('--expires-at'), '--expires-at', 64);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt))) {
      throw failure('INVALID_ARGUMENT', '--expires-at must be an exact UTC timestamp with milliseconds.');
    }
    const cohortId = exactText(values.get('--cohort-id'), '--cohort-id', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cohortId)) {
      throw failure('INVALID_ARGUMENT', '--cohort-id contains unsupported characters.');
    }
    const requestedActions = (values.get('--resource-action') || []).map(resourceAction);
    if (requestedActions.length === 0 || new Set(requestedActions.map(({ resourceKey }) => resourceKey)).size !== requestedActions.length) {
      throw failure('INVALID_RESOURCE_ACTION', 'At least one unique normalized resource action is required.');
    }
    const privatePlanOutput = values.has('--private-plan-output')
      ? exactText(values.get('--private-plan-output'), '--private-plan-output', 2048)
      : undefined;
    if (privatePlanOutput !== undefined && !isAbsolute(privatePlanOutput)) {
      throw failure('PRIVATE_PLAN_PATH_FORBIDDEN', 'Private plan output must be an absolute path outside the repository.');
    }
    Object.assign(parsed, { expiresAt, cohortId, requestedActions, privatePlanOutput });
  }
  return Object.freeze(parsed);
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export async function writePrivatePlanFile(plan, outputPath, dependencies) {
  const resolvedOutput = resolve(outputPath);
  let handle;
  let created = false;
  let createdPath;
  try {
    const [canonicalRoot, canonicalParent] = await Promise.all([
      dependencies.realpath(root),
      dependencies.realpath(dirname(resolvedOutput)),
    ]);
    const canonicalOutput = join(canonicalParent, basename(resolvedOutput));
    if (isInside(canonicalRoot, canonicalOutput)) {
      throw failure('PRIVATE_PLAN_PATH_FORBIDDEN', 'Private plan output must be outside the repository.');
    }
    // `wx` guarantees create-only behavior. 0600 is applied on POSIX; Windows
    // keeps the containing directory's ACL, so operators must choose a private
    // directory there rather than treating POSIX mode bits as an ACL claim.
    handle = await dependencies.open(canonicalOutput, 'wx', 0o600);
    created = true;
    createdPath = canonicalOutput;
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    return true;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await dependencies.unlink(createdPath).catch(() => {});
    if (error?.safeMessage) throw error;
    throw failure('PRIVATE_PLAN_WRITE_FAILED', 'Private plan output could not be created securely.');
  }
}

async function defaultDependencies() {
  const [filesystem, migrations, manifest, repository, contract, target] = await Promise.all([
    import('node:fs/promises'),
    import('./check-migrations.mjs'),
    import('./release-build-manifest.mjs'),
    import('../db/provider-reconciliation-repository.js'),
    import('../lib/heygen-reconciliation-contract.js'),
    import('../lib/provider-reconciliation-target.js'),
  ]);
  return {
    ...filesystem,
    ...migrations,
    ...manifest,
    ...contract,
    databaseBindingSha256: target.databaseBindingSha256,
    getProviderReconciliationSnapshot: repository.getProviderReconciliationSnapshot,
    getProviderReconciliationStatus: repository.getProviderReconciliationStatus,
    async hashFile(path) {
      return createHash('sha256').update(await filesystem.readFile(path)).digest('hex');
    },
  };
}

async function captureCandidate(dependencies) {
  const [source, adapterSha256] = await Promise.all([
    dependencies.captureSourceIdentity(root),
    dependencies.hashFile(adapterPath),
  ]);
  if (!SHA256.test(source?.sha256 || '') || !SHA256.test(adapterSha256)
    || typeof source?.project?.id !== 'string' || source.project.id.length === 0) {
    throw failure('SOURCE_IDENTITY_UNAVAILABLE', 'Candidate source identity is unavailable.');
  }
  return { source, adapterSha256 };
}

async function assertCandidateUnchanged(before, dependencies) {
  const after = await captureCandidate(dependencies);
  try {
    dependencies.assertUnchangedBuildSource(before.source, after.source);
  } catch {
    throw failure('SOURCE_DRIFT', 'Candidate source changed during reconciliation planning.');
  }
  if (before.adapterSha256 !== after.adapterSha256) {
    throw failure('SOURCE_DRIFT', 'Provider adapter changed during reconciliation planning.');
  }
}

async function strictTargetPreflight(options, candidate, env, dependencies) {
  const databaseUrl = env.DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0 || databaseUrl !== databaseUrl.trim()) {
    throw failure('CANONICAL_DATABASE_URL_REQUIRED', 'The canonical application DATABASE_URL is required.');
  }
  const targetEvidence = await dependencies.loadTargetManifest(options.targetManifest, {
    requiredEnvironment: options.environment,
    expectedSha256: options.expectedTargetSha256,
  });
  const { target } = targetEvidence;
  const schemaEvidence = await dependencies.loadSchemaLock(options.targetManifest, target);
  const validatedCanonicalTarget = dependencies.validateTarget(databaseUrl, target, options.environment);
  const unpooled = env.DATABASE_URL_UNPOOLED;
  if (unpooled && unpooled !== unpooled.trim()) {
    throw failure('DATABASE_URL_INVALID', 'The optional unpooled database URL is invalid.');
  }
  const validatedUnpooledTarget = unpooled
    ? dependencies.validateTarget(unpooled, target, options.environment)
    : null;
  const databaseEvidence = await dependencies.checkDatabaseMigrations(databaseUrl, {
    ...targetEvidence,
    ...schemaEvidence,
    target,
    requiredEnvironment: options.environment,
    validatedCanonicalTarget,
    validatedUnpooledTarget,
  });
  if (databaseEvidence?.verified !== true || databaseEvidence.scope !== 'live-database'
    || databaseEvidence.journalVerified !== true || databaseEvidence.environment !== options.environment) {
    throw failure('DATABASE_PREFLIGHT_FAILED', 'The exact database target did not pass strict live verification.');
  }
  const applicationProjectId = candidate.source.project.id;
  return {
    environment: options.environment,
    projectId: applicationProjectId,
    databaseBindingSha256: dependencies.databaseBindingSha256({
      environment: options.environment,
      providerProjectId: target.projectId,
      providerBranchId: target.branchId,
      databaseName: target.database,
      applicationProjectId,
    }),
  };
}

function publicFailure(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(error.code)
    ? error.code
    : 'RECONCILIATION_FAILED';
  return {
    code,
    message: error?.safeMessage || 'The reconciliation command failed closed.',
    exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : 1,
  };
}

function safeStatus(status) {
  const nonnegative = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 0) throw failure('INVALID_STATUS', `${label} is invalid.`);
    return value;
  };
  if (!status || typeof status !== 'object' || Array.isArray(status)
    || status.version !== SNAPSHOT_VERSION || !Number.isFinite(Date.parse(status.capturedAt))
    || new Date(status.capturedAt).toISOString() !== status.capturedAt
    || !['provisional', 'verified', 'conflict', 'revoked'].includes(status.providerAccountBindingState)
    || status.execution?.enabled !== false || status.execution?.reason !== 'execution_not_implemented') {
    throw failure('INVALID_STATUS', 'The reconciliation status response is invalid.');
  }
  const counts = Object.freeze({
    resources: nonnegative(status.counts?.resources, 'Resource count'),
    references: nonnegative(status.counts?.references, 'Reference count'),
    operations: nonnegative(status.counts?.operations, 'Operation count'),
    ambiguousOperations: nonnegative(status.counts?.ambiguousOperations, 'Ambiguous operation count'),
    activeReferences: nonnegative(status.counts?.activeReferences, 'Active reference count'),
  });
  if (counts.ambiguousOperations > counts.operations || counts.activeReferences > counts.references) {
    throw failure('INVALID_STATUS', 'The reconciliation status counts are inconsistent.');
  }
  return Object.freeze({
    version: status.version,
    capturedAt: new Date(status.capturedAt).toISOString(),
    providerAccountBindingState: status.providerAccountBindingState,
    counts,
    execution: Object.freeze({ enabled: false, reason: 'execution_not_implemented' }),
  });
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  loadDependencies = defaultDependencies,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    // Command parsing intentionally precedes dependency loading so disabled
    // execution verbs cannot touch files, a database, or a provider.
    const options = parseCliArguments(argv);
    const dependencies = await loadDependencies();
    const candidate = await captureCandidate(dependencies);
    const target = await strictTargetPreflight(options, candidate, env, dependencies);
    const repositoryInput = {
      accountId: options.accountId,
      enrollmentId: options.enrollmentId,
      candidate: {
        sourceSha256: candidate.source.sha256,
        adapterSha256: candidate.adapterSha256,
      },
      target,
    };

    let result;
    if (options.command === 'status') {
      const status = safeStatus(await dependencies.getProviderReconciliationStatus(repositoryInput));
      await assertCandidateUnchanged(candidate, dependencies);
      result = { command: 'status', status };
    } else {
      const snapshot = await dependencies.getProviderReconciliationSnapshot(repositoryInput);
      const privatePlan = dependencies.createReconciliationPlan(snapshot, {
        requestedActions: options.requestedActions,
        expiresAt: options.expiresAt,
        cohortId: options.cohortId,
      });
      await assertCandidateUnchanged(candidate, dependencies);
      if (options.privatePlanOutput) {
        await writePrivatePlanFile(privatePlan, options.privatePlanOutput, dependencies);
      }
      result = {
        command: 'plan',
        plan: dependencies.redactPlan(privatePlan),
        privatePlanWritten: Boolean(options.privatePlanOutput),
      };
    }
    stdout.write(`${JSON.stringify(result)}\n`);
    return { exitCode: 0, result };
  } catch (error) {
    const safe = publicFailure(error);
    stderr.write(`[heygen-reconciliation] ${safe.code}: ${safe.message}\n`);
    return { exitCode: safe.exitCode, error: safe };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = await runCli();
  process.exitCode = outcome.exitCode;
}
