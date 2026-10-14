#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { P0EvidenceError } from './contract.mjs';
import { verifyOfflineP0Candidate } from './verify-offline-candidate.mjs';

export const INCOMPLETE_EXIT_CODE = 2;
export const UNAUTHENTICATED_EXIT_CODE = 3;

export const HELP_TEXT = [
  'P0 evidence candidate checker and optional hosted route smoke.',
  '',
  'This command checks private evidence-file hashes, proof identity correlation,',
  'the nine-observation contract, full MP4 decode, matching stored/downloaded',
  'bytes, denial statuses, and exact provider/debit/final cardinality.',
  '',
  'The offline candidate mode never clears P0, writes a receipt, contacts',
  'production, submits a render, or accepts APPROVED/VERIFIED assertions.',
  'Structurally complete claims exit 3 as unauthenticated; incomplete evidence exits 2.',
  'The separate hosted route smoke makes unauthenticated GET requests only.',
  '',
  'Usage:',
  '  node tools/p0-evidence/check-candidate.mjs --run-dir <private-run-directory>',
  '  node tools/p0-evidence/check-candidate.mjs --base-url <hosted-origin>',
  '',
].join('\n');

function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  if (args.length === 2 && args[0] === '--run-dir' && args[1]) return { runDirectory: args[1] };
  if (args.length === 2 && args[0] === '--base-url' && args[1]) return { baseUrl: args[1] };
  return null;
}

export async function checkOwnerCaptionVtt(base, fetcher = fetch) {
  const response = await fetcher(`${base.replace(/\/$/, '')}/assets/showcase/owner-kristian.vtt`);
  const body = (await response.text()).replace(/^\uFEFF/, '');
  if (response.status !== 200 || !/^text\/vtt(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !body.startsWith('WEBVTT')) {
    throw new Error('OWNER_CAPTION_VTT_FAILED');
  }
}

export async function checkWorkspaceUnauthJson(base, fetcher = fetch) {
  const response = await fetcher(`${base.replace(/\/$/, '')}/api/video-os-lite/workspace`);
  const body = await response.text();
  if (response.status !== 401 || !/application\/json/i.test(response.headers.get('content-type') || '') || body.startsWith('<')) {
    throw new Error('WORKSPACE_UNAUTH_JSON_FAILED');
  }
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
  if (parsed.baseUrl) {
    try {
      const base = new URL(parsed.baseUrl);
      if (!['http:', 'https:'].includes(base.protocol) || base.pathname !== '/' || base.search || base.hash || base.username || base.password) {
        throw new Error('INVALID_BASE_URL');
      }
      const fetcher = io.fetch ?? fetch;
      await checkOwnerCaptionVtt(base.origin, fetcher);
      await checkWorkspaceUnauthJson(base.origin, fetcher);
      stdout.write('[p0-evidence] HOSTED_ROUTE_SMOKE_OK releaseGateCleared=false\n');
      return 0;
    } catch (error) {
      stderr.write('[p0-evidence] HOSTED_ROUTE_SMOKE_FAILED code=' + (error.message || 'REQUEST_FAILED') + ' releaseGateCleared=false\n');
      return INCOMPLETE_EXIT_CODE;
    }
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
