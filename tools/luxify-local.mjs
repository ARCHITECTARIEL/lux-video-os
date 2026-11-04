#!/usr/bin/env node
// Local Luxify renderer. Default is a dry run (plan + estimated Runway cost).
//   node tools/luxify-local.mjs --brief video_productions/<slug>/brief.json [--dry-run]
//   node tools/luxify-local.mjs --brief ... --live [--resume] [--assets <dir>] [--ffmpeg <path>] [--out <dir>]
// Live mode needs --live, VIDEO_OS_RUNWAY_ENABLED=true AND RUNWAYML_API_SECRET in the process env (read at
// runtime, never printed). Caps: $1 per clip, $10 per video, checked before
// any submit; a cap error aborts with no retries. No HeyGen calls are made:
// the voice must already be a local HeyGen audio file.
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { parseBrief } from '../lib/luxify-local-brief.js';
import { runwayEnabled } from '../services/runway-models.js';
import { REPO_ASSETS_ROOT, defaultAssetsRoot, loadAvatarConsent, loadBriefFile, validateLogo, receiptStatus, missingAssets, missingClips, optionalAssetWarnings, planBrief, resolveAssets, resolveFfmpeg, runPipeline } from '../services/luxify-local-pipeline.js';

export async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, runwayDeps = {} } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    brief: { type: 'string' }, 'dry-run': { type: 'boolean' }, live: { type: 'boolean' },
    assets: { type: 'string' }, ffmpeg: { type: 'string' }, out: { type: 'string' }, resume: { type: 'boolean' }, 'break-lock': { type: 'boolean' },
  }, strict: true });
  if (!values.brief) throw Object.assign(new Error('--brief <path> is required.'), { code: 'USAGE' });
  if (values.live && values['dry-run']) throw Object.assign(new Error('Choose --live or --dry-run, not both.'), { code: 'USAGE' });
  const brief = parseBrief(await loadBriefFile(values.brief));
  const plan = planBrief(brief); // throws CAP_EXCEEDED_* before anything else
  const briefDir = dirname(resolve(values.brief));
  // No --assets: the repo's brand-assets/ first, then LUX_ASSETS_DIR or
  // %USERPROFILE%\lux-assets (~/lux-assets) for anything not tracked in git.
  // With --assets: that folder first, then the repo pack (e.g. for the logo).
  const assets = values.assets
    ? resolveAssets(brief, values.assets, briefDir, { fallbackRoots: [REPO_ASSETS_ROOT] })
    : resolveAssets(brief, REPO_ASSETS_ROOT, briefDir, { fallbackRoots: [defaultAssetsRoot(env)] });
  const missing = [...await missingAssets(assets), ...await missingClips(brief, briefDir)];
  const warnings = [...plan.warnings, ...await optionalAssetWarnings(assets)];
  // QA M4 / M1: consent and logo problems are shown in the dry run and stop a live run.
  const blockers = [];
  let consent = null;
  try { consent = await loadAvatarConsent(brief, { briefDir, assetsRoot: assets.root }); } catch (error) { blockers.push(error); }
  try { await validateLogo(assets.logo, assets.roots); await validateLogo(assets.logoDark, assets.roots); } catch (error) { blockers.push(error); }
  const outDir = resolve(values.out || join(briefDir, 'render'));
  const prior = await receiptStatus(outDir, plan);
  const view = { mode: values.live ? 'live' : 'dry-run', ...plan, shots: plan.shots.map(({ input: _input, ...s }) => s), assets: Object.fromEntries(Object.entries(assets).filter(([k]) => k !== 'root' && k !== 'roots')), missingAssets: missing, warnings, avatarConsent: consent ? { file: consent.file, method: consent.method, consentedAt: consent.consentedAt, expiresAt: consent.expiresAt } : null, blockers: blockers.map(e => ({ code: e.code || 'ERROR', message: e.message })), receipt: prior, orphanedPendingShots: prior?.orphanedPending?.map(a => a.shotId) || [] };
  stdout.write(`${JSON.stringify(view, null, 2)}\n`);
  if (!values.live) return { mode: 'dry-run', plan };

  if (missing.length) throw Object.assign(new Error(`Missing assets: ${missing.map(m => m.key).join(', ')}`), { code: 'ASSETS_MISSING' });
  if (blockers.length) throw blockers[0];
  // Runway gates apply whenever a Runway shot exists. A brief made only of
  // local clips (heygen_avatar / local_clip) cannot reach Runway, so it needs
  // just --live and gets no secret.
  const ffmpegOnly = plan.shots.every(s => s.credits === 0);
  if (ffmpegOnly) {
    const ffmpegPath = resolveFfmpeg(values.ffmpeg, env);
    await mkdir(outDir, { recursive: true });
    const receipt = await runPipeline({ brief, briefDir, plan, outDir, assets, ffmpeg: ffmpegPath, resume: Boolean(values.resume), breakLock: Boolean(values['break-lock']), runwayEnv: {}, runwayDeps: {} });
    stdout.write(`final: ${join(outDir, receipt.final.file)}\nreceipt: ${join(outDir, 'receipt.json')}\nsha256: ${receipt.final.sha256}\n`);
    return { mode: 'live', receipt };
  }
  // Two explicit opt-ins: --live and VIDEO_OS_RUNWAY_ENABLED=true (exact string) in the env.
  if (!runwayEnabled(env)) throw Object.assign(new Error('VIDEO_OS_RUNWAY_ENABLED is not exactly "true"; live mode refused.'), { code: 'RUNWAY_FLAG_OFF' });
  const secret = env.RUNWAYML_API_SECRET;
  if (!secret) throw Object.assign(new Error('RUNWAYML_API_SECRET is not set; live mode refused.'), { code: 'SECRET_MISSING' });
  const ffmpeg = resolveFfmpeg(values.ffmpeg, env);
  await mkdir(outDir, { recursive: true });
  const receipt = await runPipeline({ brief, briefDir, plan, outDir, assets, ffmpeg, resume: Boolean(values.resume), breakLock: Boolean(values['break-lock']), runwayEnv: { VIDEO_OS_RUNWAY_ENABLED: env.VIDEO_OS_RUNWAY_ENABLED, RUNWAYML_API_SECRET: secret }, runwayDeps });
  stdout.write(`final: ${join(outDir, receipt.final.file)}\nreceipt: ${join(outDir, 'receipt.json')}\nsha256: ${receipt.final.sha256}\n`);
  return { mode: 'live', receipt };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('luxify-local.mjs')) {
  main().catch(error => {
    process.stderr.write(`luxify-local: ${error.code || 'ERROR'}: ${String(error.message).replaceAll(process.env.RUNWAYML_API_SECRET || '\u0000', '…')}\n`);
    process.exitCode = 1;
  });
}
