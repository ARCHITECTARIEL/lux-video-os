import * as fs from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { writePrivatePlanFile } from './reconcile-heygen-enrollment.mjs';

function fail(code) { throw Object.assign(new Error('HeyGen qualification could not complete.'), { code }); }

export function parseQualificationArguments(args) {
  const allowed = new Set(['--credential-env', '--expected-suffix', '--expected-created-date', '--expected-email', '--private-receipt']);
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.has(key) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(values, key)) fail('INVALID_ARGUMENT');
    values[key] = args[i + 1];
  }
  if (!/^[A-Za-z0-9_-]{4}$/.test(values['--expected-suffix'] || '')) fail('EXPECTED_KEY_SUFFIX_REQUIRED');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values['--expected-email'] || '')) fail('EXPECTED_PROFILE_EMAIL_REQUIRED');
  if (values['--expected-created-date'] && !/^\d{4}-\d{2}-\d{2}$/.test(values['--expected-created-date'])) fail('INVALID_CREATED_DATE');
  for (const key of ['--credential-env', '--private-receipt']) {
    if (values[key] && !isAbsolute(values[key])) fail('ABSOLUTE_PRIVATE_PATH_REQUIRED');
  }
  return values;
}

export async function runQualificationCli({ args = process.argv.slice(2), env = process.env, dependencies = {}, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseQualificationArguments(args);
    const readFile = dependencies.readFile || fs.readFile;
    let supplied = env;
    if (options['--credential-env']) {
      const file = await (dependencies.lstat || fs.lstat)(options['--credential-env']);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 64 * 1024) fail('CREDENTIAL_FILE_INVALID');
      supplied = parseEnv(await readFile(options['--credential-env'], 'utf8'));
    }
    // Read only the requested credential. Never import unrelated DB/provider
    // variables from an external file or auto-load the checkout's .env.local.
    const primary = String(supplied.HEYGEN_API_KEY || '').trim();
    const alias = String(supplied.HEYGEN_TOKEN || '').trim();
    if (primary && alias && primary !== alias) fail('AMBIGUOUS_HEYGEN_CREDENTIAL');
    const key = primary || alias;
    if (!key) fail('HEYGEN_CREDENTIAL_MISSING');
    if (!key.endsWith(options['--expected-suffix'])) fail('HEYGEN_KEY_SUFFIX_MISMATCH');
    const qualify = dependencies.qualify || (await import('../services/heygen-account-qualification.js')).qualifyHeygenCredential;
    const result = await qualify({ apiKey: key });
    const evidence = result.privateEvidence;
    const emailMatches = typeof evidence?.profile?.email === 'string'
      && evidence.profile.email.toLowerCase() === options['--expected-email'].toLowerCase();
    const createdDateMatches = options['--expected-created-date']
      ? typeof evidence?.createdAt === 'string' && evidence.createdAt.slice(0, 10) === options['--expected-created-date']
      : null;
    const holds = [...(result.publicSummary?.holds || [])];
    if (!emailMatches) holds.push({ code: 'EXPECTED_PROFILE_NOT_CONFIRMED' });
    if (createdDateMatches === false) holds.push({ code: 'EXPECTED_KEY_CREATION_DATE_MISMATCH' });
    const publicResult = {
      version: result.version,
      observedAt: result.observedAt,
      credentialKeyFingerprint: result.credentialKeyFingerprint,
      credentialScopeFingerprint: result.credentialScopeFingerprint,
      ...result.publicSummary,
      holds,
      matchChecks: { keySuffix: true, profileEmail: emailMatches, createdDate: createdDateMatches },
      accountScopeVerified: false,
      bindingEligible: false,
      databaseBindingWritten: false,
      providerMutationsEnabled: false,
    };
    if (options['--private-receipt']) {
      await (dependencies.writePrivateReceipt || writePrivatePlanFile)(
        { ...result, publicSummary: publicResult }, options['--private-receipt'], fs,
      );
    }
    stdout.write(`${JSON.stringify(publicResult)}\n`);
    // Inspection success is not account promotion or activation authority.
    return { exitCode: 0, result: publicResult };
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.code || '') ? error.code : 'HEYGEN_QUALIFICATION_FAILED';
    stderr.write(`[heygen-qualification] ${code}: Qualification failed closed; no binding or provider mutation was performed.\n`);
    return { exitCode: 1, error: { code } };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await runQualificationCli()).exitCode;
}
