#!/usr/bin/env node
// Local Luxify renderer. Default is a dry run (plan + estimated Runway cost).
//   node tools/luxify-local.mjs --brief video_productions/<slug>/brief.json [--dry-run]
//   node tools/luxify-local.mjs --brief ... --live [--assets <dir>] [--ffmpeg <path>] [--out <dir>]
// Live mode needs --live AND RUNWAYML_API_SECRET in the process env (read at
// runtime, never printed). Caps: $1 per clip, $10 per video, checked before
// any submit; a cap error aborts with no retries. No HeyGen calls are made:
// the voice must already be a local HeyGen audio file.
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { parseBrief } from '../lib/luxify-local-brief.js';
import { defaultAssetsRoot, loadBriefFile, missingAssets, planBrief, resolveAssets, resolveFfmpeg, runPipeline } from '../services/luxify-local-pipeline.js';

export async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, runwayDeps = {} } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    brief: { type: 'string' }, 'dry-run': { type: 'boolean' }, live: { type: 'boolean' },
    assets: { type: 'string' }, ffmpeg: { type: 'string' }, out: { type: 'string' },
  }, strict: true });
  if (!values.brief) throw Object.assign(new Error('--brief <path> is required.'), { code: 'USAGE' });
  if (values.live && values['dry-run']) throw Object.assign(new Error('Choose --live or --dry-run, not both.'), { code: 'USAGE' });
  const brief = parseBrief(await loadBriefFile(values.brief));
  const plan = planBrief(brief); // throws CAP_EXCEEDED_* before anything else
  const assets = resolveAssets(brief, values.assets || defaultAssetsRoot(env));
  const missing = await missingAssets(assets);
  const view = { mode: values.live ? 'live' : 'dry-run', ...plan, shots: plan.shots.map(({ input: _input, ...s }) => s), assets: Object.fromEntries(Object.entries(assets).filter(([k]) => k !== 'root')), missingAssets: missing };
  stdout.write(`${JSON.stringify(view, null, 2)}\n`);
  if (!values.live) return { mode: 'dry-run', plan };

  if (missing.length) throw Object.assign(new Error(`Missing assets: ${missing.map(m => m.key).join(', ')}`), { code: 'ASSETS_MISSING' });
  const secret = env.RUNWAYML_API_SECRET;
  if (!secret) throw Object.assign(new Error('RUNWAYML_API_SECRET is not set; live mode refused.'), { code: 'SECRET_MISSING' });
  const ffmpeg = resolveFfmpeg(values.ffmpeg, env);
  const outDir = resolve(values.out || join(dirname(resolve(values.brief)), 'render'));
  await mkdir(outDir, { recursive: true });
  // The local --live switch is this tool's own gate; the app-level flag below
  // is passed only to the in-process adapter call, never written anywhere.
  const receipt = await runPipeline({ brief, briefDir: dirname(resolve(values.brief)), plan, outDir, assets, ffmpeg, runwayEnv: { VIDEO_OS_RUNWAY_ENABLED: 'true', RUNWAYML_API_SECRET: secret }, runwayDeps });
  stdout.write(`final: ${join(outDir, 'final.mp4')}\nreceipt: ${join(outDir, 'receipt.json')}\nsha256: ${receipt.final.sha256}\n`);
  return { mode: 'live', receipt };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('luxify-local.mjs')) {
  main().catch(error => {
    process.stderr.write(`luxify-local: ${error.code || 'ERROR'}: ${String(error.message).replaceAll(process.env.RUNWAYML_API_SECRET || '\u0000', '…')}\n`);
    process.exitCode = 1;
  });
}
