import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareReviewedHeygenSpaceRefresh } from '../lib/heygen-space-anchor.js';
import { heygenRefreshDigest } from '../lib/heygen-space-refresh.js';

export async function runRefreshPreparation({ args = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (args.length !== 2 || args[0] !== '--private-evidence-dir' || !isAbsolute(args[1])
      || args[1] !== args[1].trim()) throw Object.assign(new Error(), { code: 'INVALID_REFRESH_ARGUMENTS' });
    if (String(process.env.VERCEL_ENV || '').trim().toLowerCase() === 'production') {
      throw Object.assign(new Error(), { code: 'REFRESH_PREPARATION_OPERATOR_ONLY' });
    }
    const candidate = await prepareReviewedHeygenSpaceRefresh(args[1]);
    stdout.write(`${JSON.stringify({ reviewRequired: true, installed: false, databaseChanged: false,
      candidateCanonicalSha256: heygenRefreshDigest(candidate), candidate }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.code || '') ? error.code : 'HEYGEN_SPACE_REFRESH_PREPARATION_FAILED';
    stderr.write(`[heygen-space-refresh] ${code}: No refresh was installed.\n`);
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runRefreshPreparation();
