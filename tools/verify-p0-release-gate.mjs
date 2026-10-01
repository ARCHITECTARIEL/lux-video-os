#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DISABLED_EXIT_CODE = 2;

export const HELP_TEXT = `P0 release verification is DISABLED in this repository.

This command cannot authenticate or collect the production observations required
by docs/P0-RELEASE-GATE.md. It cannot clear the gate or create a release receipt.

Canonical proof must come from a future owner-authorized production run that
captures evidence directly from the deployed candidate and trusted systems. That
evidence must bind the server-generated proof/correlation IDs, deployment and
provider identities, authenticated account hash, job, private accepted artifact,
download-denial checks, and the single submission/debit/final-event records.

Keep raw evidence private. Do not pass account IDs, tokens, credentials, or
receipt contents to this command; verification arguments are intentionally not
read, echoed, or persisted.

Usage:
  node tools/verify-p0-release-gate.mjs --help

Every verification attempt exits nonzero and writes no artifact.
`;

export const DISABLED_MESSAGE = `[p0-gate] DISABLED: this repository has no authenticated P0 evidence collector.\nSee docs/P0-RELEASE-GATE.md and use a future owner-authorized production proof run.\nNo evidence was read, accepted, or written.\n`;

export function runCli(args = [], io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    stdout.write(HELP_TEXT);
    return 0;
  }

  stderr.write(DISABLED_MESSAGE);
  return DISABLED_EXIT_CODE;
}

function isDirectInvocation(entrypoint) {
  if (!entrypoint) return false;
  return path.resolve(entrypoint) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectInvocation(process.argv[1])) {
  process.exitCode = runCli(process.argv.slice(2));
}
