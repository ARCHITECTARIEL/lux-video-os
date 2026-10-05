#!/usr/bin/env node
// This command collects private observations; it never clears the release gate.
import { constants } from 'node:fs';
import { open, mkdir, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { collectEvidence, requireEvidence, canonical } from './p0-evidence/core.mjs';

export const HELP = `Authenticated P0 observation collector (release gate remains BLOCKED)

Usage:
  node tools/collect-p0-evidence.mjs --collect --owner-authorized \\
    --origin https://lux-video-os.vercel.app --deployment dpl_... \\
    --project prj_... --git-sha <40-hex> --max-credits <integer> \\
    --output-dir <new-private-directory-outside-repository>

Requires separately reviewed storage migration, production configuration and
bounded provider-spend approval before use. --max-credits bounds application
credits, NOT HeyGen dollar spend. No activation, configuration, migration, grant,
provider creation other than the single approved render, or deployment is done.

Existing DATABASE_URL, HEYGEN_API_KEY, BLOB_READ_WRITE_TOKEN and VERCEL_TOKEN
must be supplied through approved environment channels; optional VERCEL_TEAM_ID.
Requires installed Playwright Chromium, a display, and the bundled FFmpeg.
The operator signs in normally in three new browser contexts and reviews one
existing-identity Premium quote. Cookies, credentials and scripts are not saved.
No --receipt input, custom adapters, storageState or arbitrary module loading.

Exit 2 means observations were collected but release remains blocked; exit 1
means incomplete/failed collection. Never resubmit after an uncertain outcome.
`;
export function parseArgs(args) {
  const flags = new Set(['--collect', '--owner-authorized']);
  const valued = new Set(['--origin', '--deployment', '--project', '--git-sha', '--max-credits', '--output-dir']);
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    requireEvidence((flags.has(key) || valued.has(key)) && !(key in parsed), 'ARGUMENTS_INVALID');
    if (flags.has(key)) parsed[key] = true;
    else { requireEvidence(typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--'), 'ARGUMENTS_INVALID'); parsed[key] = args[++i]; }
  }
  requireEvidence(parsed['--collect'] && parsed['--owner-authorized'], 'BOUNDED_AUTHORIZATION_REQUIRED');
  let origin;
  try { origin = new URL(parsed['--origin']); } catch { requireEvidence(false, 'ORIGIN_INVALID'); }
  requireEvidence(origin.protocol === 'https:' && origin.origin === parsed['--origin'] && !origin.username && !origin.password
    && /^[a-z0-9.-]+$/.test(origin.hostname) && origin.hostname !== 'localhost', 'ORIGIN_INVALID');
  requireEvidence(/^dpl_[A-Za-z0-9]+$/.test(parsed['--deployment']) && /^prj_[A-Za-z0-9]+$/.test(parsed['--project'])
    && /^[a-f0-9]{40}$/.test(parsed['--git-sha'] || '') && /^\d+$/.test(parsed['--max-credits'] || '')
    && Number.isSafeInteger(Number(parsed['--max-credits'])) && Number(parsed['--max-credits']) > 0
    && parsed['--output-dir'], 'ARGUMENTS_INVALID');
  return { ownerAuthorized: true, origin: origin.origin, deploymentId: parsed['--deployment'], projectId: parsed['--project'],
    gitSha: parsed['--git-sha'], maxCredits: Number(parsed['--max-credits']), outputDir: resolve(parsed['--output-dir']) };
}
export async function privateWriter(directory, repository = fileURLToPath(new URL('../', import.meta.url))) {
  requireEvidence(process.platform !== 'win32', 'POSIX_PRIVATE_OUTPUT_REQUIRED');
  const output = resolve(directory), repo = resolve(repository);
  requireEvidence(output !== repo && !output.startsWith(`${repo}/`), 'PRIVATE_OUTPUT_OUTSIDE_REPOSITORY_REQUIRED');
  // Require a new directory. Refuse symlink ancestors and preexisting receipts.
  let ancestor = dirname(output);
  while (true) {
    const info = await lstat(ancestor);
    requireEvidence(info.isDirectory() && !info.isSymbolicLink(), 'PRIVATE_OUTPUT_PARENT_INVALID');
    const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  await mkdir(output, { mode: 0o700 });
  let sequence = 0;
  return async value => {
    const bytes = `${JSON.stringify(canonical(value), null, 2)}\n`;
    // Retain each checkpoint with exclusive/no-follow creation, including the
    // pre-spend identity. No failure can overwrite or erase earlier evidence.
    const filename = join(output, `observation-${String(++sequence).padStart(3, '0')}.json`);
    const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const digest = await open(`${filename}.sha256`, 'wx', 0o600);
    // This is the exact file-byte hash, distinct from the canonical data digest.
    const { sha256 } = await import('./p0-evidence/core.mjs');
    try { await digest.writeFile(`${sha256(bytes)}\n`); await digest.sync(); } finally { await digest.close(); }
  };
}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(HELP); return 0; }
  let sources, browser, readline;
  try {
    const intent = parseArgs(args);
    requireEvidence(process.stdin.isTTY && process.stdout.isTTY, 'INTERACTIVE_OPERATOR_REQUIRED');
    const writeEvidence = await privateWriter(intent.outputDir);
    readline = createInterface({ input: process.stdin, output: process.stdout });
    const prompt = async (message, expected = '') => { const response = await readline.question(`${message}\n> `); requireEvidence(response === expected, 'OPERATOR_CANCELLED'); };
    await prompt('Proceed only after separately approved storage/configuration prerequisites and exact provider-spend authorization. Type PREREQUISITES REVIEWED to begin.', 'PREREQUISITES REVIEWED');
    const { createLiveSources } = await import('./p0-evidence/live-sources.mjs');
    sources = await createLiveSources({ intent });
    const { chromium } = await import('@playwright/test');
    const { createBrowserCollector } = await import('./p0-evidence/browser.mjs');
    browser = await createBrowserCollector({ origin: intent.origin, chromium, prompt });
    const result = await collectEvidence({ browser, sources, writeEvidence, intent });
    process.stdout.write(`P0 observations collected privately. Canonical data SHA-256: ${result.evidenceSha256}\nRelease and P0 remain BLOCKED; independent review is required.\n`);
    return 2;
  } catch (error) {
    const code = /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'COLLECTION_FAILED';
    process.stderr.write(`P0 collection incomplete: ${code}. Release remains BLOCKED. Inspect private checkpoints; never automatically resubmit.\n`);
    return 1;
  } finally { readline?.close(); await browser?.close().catch(() => {}); await sources?.close().catch(() => {}); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
