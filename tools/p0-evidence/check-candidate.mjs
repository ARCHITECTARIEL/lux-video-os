#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { P0EvidenceError } from './contract.mjs';
import { verifyOfflineP0Candidate } from './verify-offline-candidate.mjs';

export const INCOMPLETE_EXIT_CODE = 2;
export const UNAUTHENTICATED_EXIT_CODE = 3;

export const HELP_TEXT = [
  'P0 evidence candidate checker (offline only).',
  '',
  'This command checks private evidence-file hashes, proof identity correlation,',
  'the nine-observation contract, full MP4 decode, matching stored/downloaded',
  'bytes, denial statuses, and exact provider/debit/final cardinality.',
  '',
  'It never clears P0, writes a receipt, contacts production, submits a render, or',
  'accepts APPROVED/VERIFIED assertions. Structurally complete claims exit 3',
  'as unauthenticated; incomplete evidence exits 2.',
  '',
  'Usage:',
  '  node tools/p0-evidence/check-candidate.mjs --run-dir <private-run-directory>',
  '',
].join('\n');

function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  if (args.length === 2 && args[0] === '--run-dir' && args[1]) return { runDirectory: args[1] };
  return null;
}

export async function runCli(args = [], io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const verify = io.verify ?? verifyOfflineP0Candidate;
  const parsed = parseArgs(args);
  if (parsed?.help) {
    stdout.write(HELP_TEXT);
    return 0;
  }
  if (!parsed) {
    stderr.write('[p0-evidence] INCOMPLETE code=INVALID_ARGUMENTS releaseGateCleared=false\n');
    return INCOMPLETE_EXIT_CODE;
  }
  try {
    const result = await verify(parsed.runDirectory);
    stdout.write(
      '[p0-evidence] ' + result.status
      + ' claimsPresent=' + result.observationClaimsPresent
      + ' authenticated=' + result.observationsAuthenticated
      + ' candidateSha256=' + result.candidateSha256
      + ' releaseGateCleared=false\n',
    );
    return UNAUTHENTICATED_EXIT_CODE;
  } catch (error) {
    const code = error instanceof P0EvidenceError ? error.code : 'OFFLINE_CHECK_FAILED';
    const observation = Number.isInteger(error?.observation) ? ' observation=' + error.observation : '';
    stderr.write('[p0-evidence] INCOMPLETE code=' + code + observation + ' releaseGateCleared=false\n');
    return INCOMPLETE_EXIT_CODE;
  }
}

function isDirectInvocation(entrypoint) {
  if (!entrypoint) return false;
  return path.resolve(entrypoint) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectInvocation(process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}
