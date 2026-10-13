import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertPremiumCompositionRequest } from '../api/video-os-lite/render-v2.js';
import { providerList } from '../lib/video-os-account.js';
import { finishMediaWithHyperframes } from '../services/hyperframes-client.js';

const workflowUrl = new URL('../workflows/video-render.js', import.meta.url);
const clientUrl = new URL('../services/hyperframes-client.js', import.meta.url);
const contractUrl = new URL('../services/hyperframes-contract.js', import.meta.url);

test('the Workflow HyperFrames import boundary excludes the Sandbox runtime', async () => {
  const [workflow, client, contract] = await Promise.all([
    readFile(workflowUrl, 'utf8'),
    readFile(clientUrl, 'utf8'),
    readFile(contractUrl, 'utf8'),
  ]);

  assert.match(workflow, /from [']\.\.\/services\/hyperframes-client\.js[']/);
  assert.doesNotMatch(workflow, /hyperframes-finisher\.js/);
  assert.doesNotMatch(String(client) + String(contract), /@vercel\/sandbox|hyperframes-finisher\.js|node:fs|node:child_process/);
});

test('the default-off client ignores flags and rejects before injected effects', async () => {
  let effects = 0;
  await assert.rejects(
    finishMediaWithHyperframes(
      { provider: 'heygen', format: 'landscape' },
      'https://provider.example/final.mp4',
      {
        env: {
          VIDEO_OS_COMPOSITION_ENGINE: 'hyperframes',
          VIDEO_OS_HYPERFRAMES_ENABLED: 'true',
          VIDEO_OS_HYPERFRAMES_SNAPSHOT_ID: 'snap-proof',
        },
        createSandbox: async () => { effects += 1; },
        downloadProviderMedia: async () => { effects += 1; },
        putPrivateBlob: async () => { effects += 1; },
      },
    ),
    error => error?.code === 'HYPERFRAMES_MVP_UNSUPPORTED'
      && error?.failureCategory === 'CONFIG_MISSING'
      && /initial MVP release/.test(error.message),
  );
  assert.equal(effects, 0);
});

test('capability and request admission remain closed even when all runtime flags are set', () => {
  const env = {
    HEYGEN_API_KEY: 'test-key',
    VIDEO_OS_HOSTED_FINISHING_ENABLED: 'true',
    VIDEO_OS_COMPOSITION_ENGINE: 'hyperframes',
    VIDEO_OS_HYPERFRAMES_ENABLED: 'true',
    VIDEO_OS_HYPERFRAMES_SNAPSHOT_ID: 'snap-proof',
  };
  const composition = {
    contractVersion: 'premium-composition-v1',
    backgroundId: 'ember-halo',
    layoutId: 'cinematic-overlay',
  };
  assert.equal(providerList(env).find(provider => provider.id === 'heygen').compositionAvailable, false);
  assert.throws(
    () => assertPremiumCompositionRequest(
      { format: 'landscape', productionKit: { composition } },
      { settings: { composition } },
      env,
    ),
    error => error?.code === 'HYPERFRAMES_MVP_UNSUPPORTED'
      && error?.failureCategory === 'CONFIG_MISSING'
      && error?.statusCode === 503,
  );
});

test('a saved Premium composition cannot be omitted from the render request', async () => {
  const composition = {
    contractVersion: 'premium-composition-v1',
    backgroundId: 'ember-halo',
    layoutId: 'cinematic-overlay',
  };
  assert.throws(
    () => assertPremiumCompositionRequest(
      { format: 'landscape' },
      { settings: { composition } },
      {},
    ),
    error => error?.failureCategory === 'VALIDATION' && error?.statusCode === 409,
  );

  const render = await readFile(new URL('../api/video-os-lite/render-v2.js', import.meta.url), 'utf8');
  const premiumBody = render.slice(
    render.indexOf('async function handlePremiumRender'),
    render.indexOf('export function shouldReleaseWorkflowReservation'),
  );
  const admissionIndex = premiumBody.indexOf('assertPremiumCompositionRequest(payload, project)');
  const reservationIndex = premiumBody.indexOf('await reserveRender(');
  assert.ok(admissionIndex >= 0, 'Premium composition admission is missing');
  assert.ok(reservationIndex >= 0, 'Premium reservation is missing');
  assert.ok(admissionIndex < reservationIndex, 'Premium composition admission follows reservation');
});

test('new submissions check HyperFrames readiness before provider submission', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const submitBody = workflow.slice(
    workflow.indexOf('async function submitProvider'),
    workflow.indexOf('async function pollProvider'),
  );
  const readinessIndex = submitBody.indexOf('requireReadyFinishingEngineForJob(job)');
  const submitIndex = submitBody.indexOf('await submitHeygen(claimedJob)');
  assert.ok(readinessIndex >= 0, 'submission readiness check is missing');
  assert.ok(submitIndex >= 0, 'provider submission call is missing');
  assert.ok(readinessIndex < submitIndex, 'provider submission precedes HyperFrames readiness');
});
