import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { load as parseYaml } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watchdogScript = resolve(root, 'scripts/watchdog-check.sh');
const heartbeatScript = resolve(root, 'scripts/heartbeat-check.sh');
const bash = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const bashAvailable = spawnSync(bash, ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
const posixPath = (value) => value.replaceAll('\\', '/');

const mainSha = 'a'.repeat(40);
const deployedSha = 'b'.repeat(40);
const nowEpoch = Date.parse('2026-10-15T12:00:00.000Z') / 1000;
const productionHealth = (value) => JSON.stringify({
  ...value,
  env: 'production',
  checks: { releaseIdentity: { ok: true }, ...value.checks },
});

const mockCurlSource = `#!/usr/bin/env bash
set -u

output=''
headers=''
method='GET'
url=''

while (( $# )); do
  case "$1" in
    --output|-o) output="$2"; shift 2 ;;
    --dump-header|-D) headers="$2"; shift 2 ;;
    --request|-X) method="$2"; shift 2 ;;
    --write-out|-w|--connect-timeout|--max-time|--header|-H|--data|-d) shift 2 ;;
    --silent|--show-error) shift ;;
    http://*|https://*) url="$1"; shift ;;
    *) printf 'unexpected curl argument: %s\\n' "$1" >&2; exit 90 ;;
  esac
done

if [[ -n "\${MOCK_CALL_LOG:-}" ]]; then
  printf '%s %s\\n' "$method" "$url" >> "$MOCK_CALL_LOG"
fi

case "$url" in
  */api/health)
    status="\${MOCK_HEALTH_STATUS:-200}"
    type="\${MOCK_HEALTH_TYPE:-application/json}"
    body="\${MOCK_HEALTH_BODY:-}"
    [[ -n "$body" ]] || body='{}'
    ;;
  *operation=watchdog-sweep)
    status="\${MOCK_SWEEP_STATUS:-200}"
    type="\${MOCK_SWEEP_TYPE:-application/json}"
    body="\${MOCK_SWEEP_BODY:-}"
    [[ -n "$body" ]] || body='{\"ok\":true,\"sweep\":{}}'
    ;;
  */assets/showcase/owner-kristian.vtt)
    status="\${MOCK_CAPTION_STATUS:-200}"
    type="\${MOCK_CAPTION_TYPE:-text/vtt; charset=utf-8}"
    body="\${MOCK_CAPTION_BODY:-WEBVTT}"
    ;;
  */api/video-os-lite/workspace)
    status="\${MOCK_WORKSPACE_STATUS:-401}"
    type="\${MOCK_WORKSPACE_TYPE:-application/json}"
    body="\${MOCK_WORKSPACE_BODY:-}"
    [[ -n "$body" ]] || body='{\"ok\":false,\"code\":\"sign_in_required\",\"error\":\"Sign in required.\"}'
    ;;
  */api/zz-unknown)
    status="\${MOCK_UNKNOWN_STATUS:-404}"
    type="\${MOCK_UNKNOWN_TYPE:-application/json}"
    body="\${MOCK_UNKNOWN_BODY:-}"
    [[ -n "$body" ]] || body='{\"ok\":false,\"code\":\"not_found\",\"path\":\"/api/zz-unknown\"}'
    ;;
  *) printf 'unmocked URL: %s\\n' "$url" >&2; exit 91 ;;
esac

printf 'HTTP/2 %s\\r\\ncontent-type: %s\\r\\n\\r\\n' "$status" "$type" > "$headers"
if [[ "$url" == */api/health && -n "\${MOCK_HEALTH_FILE:-}" ]]; then
  cat "$MOCK_HEALTH_FILE" > "$output"
else
  printf '%s' "$body" > "$output"
fi
printf '%s' "$status"
`;

async function runScript(t, script, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'video-os-watchdog-workflow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mockCurl = join(directory, 'mock-curl.sh');
  const callLog = join(directory, 'calls.log');
  await writeFile(mockCurl, mockCurlSource, 'utf8');
  await chmod(mockCurl, 0o755);

  const healthBody = JSON.stringify({
    status: 'ok',
    gitSha: mainSha,
    env: 'production',
    checks: { releaseIdentity: { ok: true }, watchdog: { lastSweepAt: new Date((nowEpoch - 600) * 1000).toISOString() } },
  });
  const env = {
    ...process.env,
    VIDEO_OS_BASE_URL: 'https://video.example',
    VIDEO_OS_CRON_SECRET: 'test-cron-secret',
    EXPECTED_GIT_SHA: mainSha,
    MAIN_HEAD_EPOCH: String(nowEpoch - 3600),
    NOW_EPOCH: String(nowEpoch),
    CURL_BIN: posixPath(mockCurl),
    MOCK_CALL_LOG: posixPath(callLog),
    MOCK_HEALTH_BODY: healthBody,
    ...overrides,
  };
  const result = spawnSync(bash, [posixPath(script)], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  const calls = existsSync(callLog) ? await readFile(callLog, 'utf8') : '';
  return { ...result, calls };
}

async function legacyShellVariant(t, from, to) {
  const directory = await mkdtemp(join(tmpdir(), 'video-os-legacy-shell-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'index.html');
  const current = await readFile(resolve(root, 'public/index.html'), 'utf8');
  const variant = from
    ? current.replace(from, to)
    : current.includes('\r\n') ? current.replaceAll('\r\n', '\n') : current.replaceAll('\n', '\r\n');
  assert.notEqual(variant, current);
  await writeFile(file, variant, 'utf8');
  return posixPath(file);
}

test('watchdog fails closed when the production URL or cron secret is missing', { skip: !bashAvailable }, async (t) => {
  const missingUrl = await runScript(t, watchdogScript, { VIDEO_OS_BASE_URL: '' });
  assert.equal(missingUrl.status, 1);
  assert.match(missingUrl.stderr, /::error::.*VIDEO_OS_BASE_URL.*VIDEO_OS_CRON_SECRET/i);
  assert.equal(missingUrl.calls, '');

  const missingSecret = await runScript(t, watchdogScript, { VIDEO_OS_CRON_SECRET: '' });
  assert.equal(missingSecret.status, 1);
  assert.match(missingSecret.stderr, /::error::.*VIDEO_OS_BASE_URL.*VIDEO_OS_CRON_SECRET/i);
  assert.equal(missingSecret.calls, '');
});

test('watchdog rejects a same-SHA Preview or an unsealed production health before POST', { skip: !bashAvailable }, async (t) => {
  for (const health of [
    { status: 'ok', gitSha: mainSha, env: 'preview', checks: { releaseIdentity: { ok: true } } },
    { status: 'ok', gitSha: mainSha, env: 'production', checks: { releaseIdentity: { ok: false } } },
  ]) {
    const result = await runScript(t, watchdogScript, { MOCK_HEALTH_BODY: JSON.stringify(health) });
    assert.equal(result.status, 1);
    assert.equal(result.calls, 'GET https://video.example/api/health\n');
  }
});

test('watchdog rejects HTML and degraded health responses before the sweep', { skip: !bashAvailable }, async (t) => {
  const html = await runScript(t, watchdogScript, {
    MOCK_HEALTH_TYPE: 'text/html',
    MOCK_HEALTH_BODY: '<!doctype html><title>fallback</title>',
  });
  assert.equal(html.status, 1);
  assert.match(html.stderr, /::error::.*application\/json/i);
  assert.equal(html.calls.trim().split(/\r?\n/).length, 1);

  const degraded = await runScript(t, watchdogScript, {
    MOCK_HEALTH_BODY: productionHealth({ status: 'degraded', gitSha: mainSha }),
  });
  assert.equal(degraded.status, 1);
  assert.match(degraded.stderr, /::error::.*status 'degraded'/i);
  assert.equal(degraded.calls.trim().split(/\r?\n/).length, 1);
});

test('watchdog rejects a stale deployed SHA after the main push grace period', { skip: !bashAvailable }, async (t) => {
  const result = await runScript(t, watchdogScript, {
    MOCK_HEALTH_BODY: productionHealth({ status: 'ok', gitSha: deployedSha }),
    MAIN_HEAD_EPOCH: String(nowEpoch - 1201),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::.*does not match main.*20-minute/i);
  assert.equal(result.calls.trim().split(/\r?\n/).length, 1);

  const missingPushTime = await runScript(t, watchdogScript, {
    MOCK_HEALTH_BODY: productionHealth({ status: 'ok', gitSha: deployedSha }),
    MAIN_HEAD_EPOCH: '',
  });
  assert.equal(missingPushTime.status, 1);
  assert.match(missingPushTime.stderr, /::error::.*MAIN_HEAD_EPOCH is missing or invalid/i);
  assert.equal(missingPushTime.calls.trim().split(/\r?\n/).length, 1);
});

test('watchdog allows deployment grace for a fresh main push and does not sweep the old deployment', { skip: !bashAvailable }, async (t) => {
  const result = await runScript(t, watchdogScript, {
    MOCK_HEALTH_BODY: productionHealth({ status: 'ok', gitSha: deployedSha }),
    MAIN_HEAD_EPOCH: String(nowEpoch - 1200),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /::warning::.*grace period/i);
  assert.equal(result.calls, 'GET https://video.example/api/health\n');
});

test('watchdog allows only the known legacy HTML health fallback during deployment grace', { skip: !bashAvailable }, async (t) => {
  const legacy = { MOCK_HEALTH_TYPE: 'text/html', MOCK_HEALTH_FILE: posixPath(resolve(root, 'public/index.html')) };
  const fresh = await runScript(t, watchdogScript, { ...legacy, MAIN_HEAD_EPOCH: String(nowEpoch - 1200) });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stderr, /::warning::.*grace period/i);
  assert.equal(fresh.calls, 'GET https://video.example/api/health\n');

  const alternateLineEndings = await runScript(t, watchdogScript, {
    MOCK_HEALTH_TYPE: 'text/html', MOCK_HEALTH_FILE: await legacyShellVariant(t),
    MAIN_HEAD_EPOCH: String(nowEpoch - 600),
  });
  assert.equal(alternateLineEndings.status, 0, alternateLineEndings.stderr);
  assert.match(alternateLineEndings.stderr, /::warning::.*grace period/i);
  assert.equal(alternateLineEndings.calls, 'GET https://video.example/api/health\n');

  const degraded = await runScript(t, watchdogScript, {
    MOCK_HEALTH_BODY: productionHealth({ status: 'degraded', gitSha: mainSha }),
    MAIN_HEAD_EPOCH: String(nowEpoch - 600),
  });
  assert.equal(degraded.status, 1);
  assert.equal(degraded.calls, 'GET https://video.example/api/health\n');

  const arbitraryHtml = await runScript(t, watchdogScript, {
    MOCK_HEALTH_TYPE: 'text/html', MOCK_HEALTH_BODY: '<html><title>Sign in</title></html>',
    MAIN_HEAD_EPOCH: String(nowEpoch - 600),
  });
  assert.equal(arbitraryHtml.status, 1);

  const missingAppScript = await runScript(t, watchdogScript, {
    MOCK_HEALTH_TYPE: 'text/html',
    MOCK_HEALTH_FILE: await legacyShellVariant(t, '/studio.js', '/unrelated.js'),
    MAIN_HEAD_EPOCH: String(nowEpoch - 600),
  });
  assert.equal(missingAppScript.status, 1);
  assert.match(missingAppScript.stderr, /Unrecognized HTML health response \(sha256=[0-9a-f]{64}, bytes=\d+\); grace denied/);
  assert.equal(missingAppScript.calls, 'GET https://video.example/api/health\n');

  const futureEpoch = await runScript(t, watchdogScript, { ...legacy, MAIN_HEAD_EPOCH: String(nowEpoch + 1) });
  assert.equal(futureEpoch.status, 1);
  const missingEpoch = await runScript(t, watchdogScript, { ...legacy, MAIN_HEAD_EPOCH: '' });
  assert.equal(missingEpoch.status, 1);
  const stale = await runScript(t, watchdogScript, { ...legacy, MAIN_HEAD_EPOCH: String(nowEpoch - 1201) });
  assert.equal(stale.status, 1);
  assert.equal(stale.calls, 'GET https://video.example/api/health\n');
});

test('watchdog passes only after health, sweep, and all strict route probes pass', { skip: !bashAvailable }, async (t) => {
  const result = await runScript(t, watchdogScript);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Watchdog check passed/);
  assert.deepEqual(result.calls.trim().split(/\r?\n/), [
    'GET https://video.example/api/health',
    'POST https://video.example/api/video-os-lite/admin?operation=watchdog-sweep',
    'GET https://video.example/assets/showcase/owner-kristian.vtt',
    'GET https://video.example/api/video-os-lite/workspace',
    'GET https://video.example/api/zz-unknown',
  ]);
});

test('scheduled GitHub fallback skips a fresh native sweep and runs for a stale-only degraded health state', { skip: !bashAvailable }, async (t) => {
  const healthy = await runScript(t, watchdogScript, {
    WATCHDOG_FALLBACK_ONLY: 'true',
    MOCK_HEALTH_BODY: productionHealth({ status: 'ok', gitSha: mainSha,
      checks: { db: { ok: true }, blob: { ok: true }, provider: { ok: true },
        watchdog: { ok: true, lastSweepAt: new Date((nowEpoch - 600) * 1000).toISOString() } } }),
  });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.match(healthy.stdout, /GitHub fallback skipped/);
  assert.equal(healthy.calls, 'GET https://video.example/api/health\n');

  const aging = await runScript(t, watchdogScript, {
    WATCHDOG_FALLBACK_ONLY: 'true',
    MOCK_HEALTH_BODY: productionHealth({ status: 'ok', gitSha: mainSha,
      checks: { db: { ok: true }, blob: { ok: true }, provider: { ok: true },
        watchdog: { ok: true, lastSweepAt: new Date((nowEpoch - 26 * 60) * 1000).toISOString() } } }),
  });
  assert.equal(aging.status, 0, aging.stderr);
  assert.match(aging.calls, /POST https:\/\/video\.example\/api\/video-os-lite\/admin\?operation=watchdog-sweep/);

  const stale = await runScript(t, watchdogScript, {
    WATCHDOG_FALLBACK_ONLY: 'true',
    MOCK_HEALTH_BODY: productionHealth({ status: 'degraded', gitSha: mainSha,
      checks: { db: { ok: true }, blob: { ok: true }, provider: { ok: true }, watchdog: { ok: false } } }),
  });
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.calls, /POST https:\/\/video\.example\/api\/video-os-lite\/admin\?operation=watchdog-sweep/);
});

test('watchdog fails on a non-200 sweep and does not run route smoke', { skip: !bashAvailable }, async (t) => {
  const result = await runScript(t, watchdogScript, { MOCK_SWEEP_STATUS: '503' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::.*sweep request failed with HTTP 503/i);
  assert.equal(result.calls.trim().split(/\r?\n/).length, 2);
});

test('watchdog rejects HTML workspace responses and non-JSON unknown API fallbacks', { skip: !bashAvailable }, async (t) => {
  const workspaceHtml = await runScript(t, watchdogScript, {
    MOCK_WORKSPACE_TYPE: 'text/html',
    MOCK_WORKSPACE_BODY: '<html>login</html>',
  });
  assert.equal(workspaceHtml.status, 1);
  assert.match(workspaceHtml.stderr, /::error::.*workspace.*application\/json/i);

  const unknownHtml = await runScript(t, watchdogScript, {
    MOCK_UNKNOWN_TYPE: 'text/html',
    MOCK_UNKNOWN_BODY: '<html>spa fallback</html>',
  });
  assert.equal(unknownHtml.status, 1);
  assert.match(unknownHtml.stderr, /::error::.*unknown API.*application\/json/i);
});

test('heartbeat passes at 10 minutes and fails red at 60 minutes', { skip: !bashAvailable }, async (t) => {
  const recent = await runScript(t, heartbeatScript, {
    MOCK_HEALTH_BODY: JSON.stringify({ checks: { watchdog: { lastSweepAt: new Date((nowEpoch - 600) * 1000).toISOString() } } }),
  });
  assert.equal(recent.status, 0, recent.stderr);
  assert.match(recent.stdout, /10 minutes old/);

  const stale = await runScript(t, heartbeatScript, {
    MOCK_HEALTH_BODY: JSON.stringify({ checks: { watchdog: { lastSweepAt: new Date((nowEpoch - 3600) * 1000).toISOString() } } }),
  });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /::error::.*60 minutes old.*45 minutes/i);
});

test('heartbeat passes at 45 minutes and fails at 45 minutes plus one second', { skip: !bashAvailable }, async (t) => {
  for (const [ageSeconds, expected] of [[2700, 0], [2701, 1], [2760, 1]]) {
    const result = await runScript(t, heartbeatScript, {
      MOCK_HEALTH_BODY: JSON.stringify({ checks: { watchdog: { lastSweepAt: new Date((nowEpoch - ageSeconds) * 1000).toISOString() } } }),
    });
    assert.equal(result.status, expected, `age=${ageSeconds}: ${result.stderr}`);
  }
});

test('heartbeat fails closed when the URL or persisted heartbeat is unconfigured', { skip: !bashAvailable }, async (t) => {
  const missingUrl = await runScript(t, heartbeatScript, { VIDEO_OS_BASE_URL: '' });
  assert.equal(missingUrl.status, 1);
  assert.match(missingUrl.stderr, /::error::.*VIDEO_OS_BASE_URL/i);
  assert.equal(missingUrl.calls, '');

  const missingHeartbeat = await runScript(t, heartbeatScript, {
    MOCK_HEALTH_BODY: JSON.stringify({ checks: { watchdog: { lastSweepAt: null } } }),
  });
  assert.equal(missingHeartbeat.status, 1);
  assert.match(missingHeartbeat.stderr, /::error::.*unconfigured or missing/i);
});

test('heartbeat allows only the legacy HTML health fallback during deployment grace', { skip: !bashAvailable }, async (t) => {
  const legacy = { MOCK_HEALTH_TYPE: 'text/html', MOCK_HEALTH_FILE: posixPath(resolve(root, 'public/index.html')) };
  const fresh = await runScript(t, heartbeatScript, { ...legacy, MAIN_HEAD_EPOCH: String(nowEpoch - 1200) });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stderr, /::warning::.*grace period/i);
  assert.equal(fresh.calls, 'GET https://video.example/api/health\n');

  const alternateLineEndings = await runScript(t, heartbeatScript, {
    MOCK_HEALTH_TYPE: 'text/html', MOCK_HEALTH_FILE: await legacyShellVariant(t),
    MAIN_HEAD_EPOCH: String(nowEpoch - 600),
  });
  assert.equal(alternateLineEndings.status, 0, alternateLineEndings.stderr);
  assert.match(alternateLineEndings.stderr, /::warning::.*grace period/i);
  assert.equal(alternateLineEndings.calls, 'GET https://video.example/api/health\n');

  const nonLegacy = await runScript(t, heartbeatScript, {
    MOCK_HEALTH_TYPE: 'text/plain',
    MAIN_HEAD_EPOCH: String(nowEpoch - 600),
  });
  assert.equal(nonLegacy.status, 1);

  const arbitraryHtml = await runScript(t, heartbeatScript, {
    MOCK_HEALTH_TYPE: 'text/html', MOCK_HEALTH_BODY: '<html><title>Sign in</title></html>',
    MAIN_HEAD_EPOCH: String(nowEpoch - 600),
  });
  assert.equal(arbitraryHtml.status, 1);

  const futureEpoch = await runScript(t, heartbeatScript, { ...legacy, MAIN_HEAD_EPOCH: String(nowEpoch + 1) });
  assert.equal(futureEpoch.status, 1);
  const missingEpoch = await runScript(t, heartbeatScript, { ...legacy, MAIN_HEAD_EPOCH: '' });
  assert.equal(missingEpoch.status, 1);
  const stale = await runScript(t, heartbeatScript, { ...legacy, MAIN_HEAD_EPOCH: String(nowEpoch - 1201) });
  assert.equal(stale.status, 1);
  assert.equal(stale.calls, 'GET https://video.example/api/health\n');
});

test('watchdog and heartbeat workflows parse and invoke the extracted scripts on schedule', async () => {
  const watchdogRaw = await readFile(resolve(root, '.github/workflows/watchdog-sweep.yml'), 'utf8');
  const heartbeatRaw = await readFile(resolve(root, '.github/workflows/heartbeat-check.yml'), 'utf8');
  const watchdog = parseYaml(watchdogRaw);
  const heartbeat = parseYaml(heartbeatRaw);

  assert.deepEqual(watchdog.on.schedule, [{ cron: '*/15 * * * *' }]);
  assert.ok(watchdog.on.workflow_dispatch !== undefined);
  assert.equal(watchdog.jobs.sweep.steps.at(-1).run.includes('bash scripts/watchdog-check.sh'), true);
  assert.equal(watchdog.jobs.sweep.steps.at(-1).env.VIDEO_OS_BASE_URL, '${{ vars.VIDEO_OS_BASE_URL }}');
  assert.equal(watchdog.jobs.sweep.steps.at(-1).env.VIDEO_OS_CRON_SECRET, '${{ secrets.VIDEO_OS_CRON_SECRET }}');
  assert.equal(watchdog.jobs.sweep.steps.at(-1).env.WATCHDOG_FALLBACK_ONLY, "${{ github.event_name == 'schedule' }}");
  assert.match(await readFile(watchdogScript, 'utf8'), /Authorization: Bearer \$cron_secret/);
  const stripeRaw = await readFile(resolve(root, '.github/workflows/stripe-reconciliation.yml'), 'utf8');
  assert.match(stripeRaw, /Authorization: Bearer \$CRON_SECRET/);
  assert.match(watchdog.jobs.sweep.steps.at(-1).run, /MAIN_HEAD_EPOCH="\$\(git log -1 --format=%ct HEAD\)"/);
  assert.doesNotMatch(watchdogRaw, /repository\.pushed_at/);
  assert.match(watchdogRaw, /configured since September 21, 2026/);
  assert.doesNotMatch(watchdogRaw, /skipping this run|neither .* exists yet/i);

  assert.deepEqual(heartbeat.on.schedule, [{ cron: '0 * * * *' }]);
  assert.ok(heartbeat.on.workflow_dispatch !== undefined);
  assert.equal(heartbeat.jobs.heartbeat.steps[0].with.ref, 'main');
  assert.match(heartbeat.jobs.heartbeat.steps.at(-1).run, /MAIN_HEAD_EPOCH="\$\(git log -1 --format=%ct HEAD\)"/);
  assert.match(heartbeat.jobs.heartbeat.steps.at(-1).run, /bash scripts\/heartbeat-check\.sh/);
  assert.equal(heartbeat.jobs.heartbeat.steps.at(-1).env.VIDEO_OS_BASE_URL, '${{ vars.VIDEO_OS_BASE_URL }}');
});

test('Neon preview cleanup workflow parses with the exact closed-PR safety contract', async () => {
  const raw = await readFile(resolve(root, '.github/workflows/neon-preview-cleanup.yml'), 'utf8');
  const workflow = parseYaml(raw);
  const job = workflow.jobs['delete-branch'];
  const step = job.steps[0];

  assert.equal(workflow.name, 'Cleanup Neon preview branch');
  assert.deepEqual(workflow.on, { pull_request: { types: ['closed'] } });
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency, 'neon-cleanup-${{ github.head_ref }}');
  assert.equal(job.if, 'github.event.pull_request.head.repo.full_name == github.repository');
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(step.uses, 'neondatabase/delete-branch-action@4468d825d5a88ef4012f1705a82f02ec3072f776');
  assert.equal(step['continue-on-error'], true);
  assert.deepEqual(step.with, {
    project_id: '${{ vars.NEON_PROJECT_ID }}',
    branch: 'preview/${{ github.head_ref }}',
    api_key: '${{ secrets.NEON_API_KEY }}',
  });
});
