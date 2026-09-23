import crypto from 'node:crypto';

const DEFAULT_API_ORIGIN = 'https://api.runpod.ai/v2';

// 1x1 transparent PNG as lightweight image test fixture
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Minimal 44-byte silent WAV header as audio test fixture
const SILENT_WAV_BASE64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

function createWavFixture(durationSeconds = 1, sampleRate = 16000) {
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.floor(Math.sin(2 * Math.PI * 440 * t) * 8000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}

async function main() {
  const apiKey = String(process.env.RUNPOD_API_KEY || '').trim();
  const endpointId = String(process.env.VIDEO_OS_RUNPOD_ENDPOINT_ID || '').trim();
  const apiOrigin = String(process.env.VIDEO_OS_RUNPOD_API_ORIGIN || DEFAULT_API_ORIGIN).trim().replace(/\/+$/, '');
  const allowSimulated = String(process.env.VIDEO_OS_RUNPOD_ALLOW_SIMULATED_OUTPUT || '').trim().toLowerCase() === 'true';

  console.log('================================================================');
  console.log('              RUNPOD SERVERLESS ENDPOINT DIAGNOSTIC             ');
  console.log('================================================================');

  if (!apiKey || !endpointId) {
    console.error('ERROR: Missing required RunPod credentials.');
    console.error('Please configure:');
    console.error('  $env:RUNPOD_API_KEY = "your-runpod-api-key"');
    console.error('  $env:VIDEO_OS_RUNPOD_ENDPOINT_ID = "your-endpoint-id"');
    console.error('  node tools/test-runpod-endpoint.mjs\n');
    process.exit(1);
  }

  console.log(`Endpoint ID : ${endpointId}`);
  console.log(`API Origin  : ${apiOrigin}`);
  console.log(`Allow Sim   : ${allowSimulated}`);
  console.log('----------------------------------------------------------------');

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // 1. Check Endpoint Health
  console.log('\n[1/3] Pinging RunPod endpoint health...');
  try {
    const healthUrl = `${apiOrigin}/${endpointId}/health`;
    const healthRes = await fetch(healthUrl, { headers });
    const healthData = await healthRes.json().catch(() => ({}));
    console.log(`  Health Status: ${healthRes.status} ${healthRes.statusText}`);
    console.log('  Health Response:', JSON.stringify(healthData));
    if (!healthRes.ok) {
      console.warn('  ⚠️ Warning: Health check returned non-200. Endpoint may be initializing or stopped.');
    }
  } catch (err) {
    console.warn(`  ⚠️ Health check request failed: ${err.message}`);
  }

  // 2. Submit test execution
  console.log('\n[2/3] Submitting synthetic test execution...');
  const portraitBytes = Buffer.from(TINY_PNG_BASE64, 'base64');
  const audioBytes = createWavFixture(1, 16000);
  const portraitSha256 = crypto.createHash('sha256').update(portraitBytes).digest('hex');
  const audioSha256 = crypto.createHash('sha256').update(audioBytes).digest('hex');

  const runPayload = {
    input: {
      schemaVersion: 1,
      jobId: `test-${Date.now()}`,
      correlationId: `corr-${Date.now()}`,
      format: 'mp4',
      title: 'runpod-diagnostic',
      portrait: {
        mimeType: 'image/png',
        sha256: portraitSha256,
        base64: portraitBytes.toString('base64'),
      },
      drivenAudio: {
        mimeType: 'audio/wav',
        sha256: audioSha256,
        durationMs: 1000,
        base64: audioBytes.toString('base64'),
      },
    },
  };

  const runUrl = `${apiOrigin}/${endpointId}/run`;
  const runStart = Date.now();
  const runRes = await fetch(runUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(runPayload),
  });

  const runData = await runRes.json().catch(() => null);
  if (!runRes.ok || !runData?.id) {
    console.error(`  ❌ Run submission failed (${runRes.status}):`, runData);
    process.exit(1);
  }

  const jobId = runData.id;
  console.log(`  ✅ Job successfully queued with ID: ${jobId}`);
  console.log(`  Initial Status: ${runData.status || 'IN_QUEUE'}`);

  // 3. Poll for completion
  console.log('\n[3/3] Polling job status...');
  const statusUrl = `${apiOrigin}/${endpointId}/status/${jobId}`;
  let completed = false;
  let attempts = 0;
  const maxAttempts = 60; // 2 minutes

  while (!completed && attempts < maxAttempts) {
    attempts++;
    await new Promise((r) => setTimeout(r, 2000));

    const pollRes = await fetch(statusUrl, { headers });
    const pollData = await pollRes.json().catch(() => null);

    if (!pollRes.ok || !pollData) {
      console.warn(`  [Poll #${attempts}] Request error (${pollRes.status})`);
      continue;
    }

    const status = pollData.status;
    const elapsedSec = ((Date.now() - runStart) / 1000).toFixed(1);
    console.log(`  [Poll #${attempts} - ${elapsedSec}s] Status: ${status}`);

    if (status === 'COMPLETED') {
      completed = true;
      const output = pollData.output || {};
      const videoB64 = output.videoBase64 || output.mp4_base64;
      const mp4Bytes = videoB64 ? Buffer.from(videoB64, 'base64') : null;
      console.log('\n================================================================');
      console.log('                     TEST RESULT: SUCCESS                       ');
      console.log('================================================================');
      console.log(`Total Latency     : ${elapsedSec}s`);
      console.log(`Simulation Mode   : ${Boolean(output.simulation)}`);
      console.log(`Output Bytes      : ${mp4Bytes?.length || 0} bytes`);
      console.log(`Reported SHA256   : ${output.sha256 || 'none'}`);
      if (mp4Bytes) {
        const computedSha = crypto.createHash('sha256').update(mp4Bytes).digest('hex');
        console.log(`Verified SHA256   : ${computedSha}`);
        console.log(`Checksum Match    : ${computedSha === output.sha256 ? 'MATCH ✅' : 'MISMATCH ❌'}`);
      }
      console.log('================================================================\n');
      return;
    }

    if (['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(status)) {
      console.error(`\n❌ Job terminated with status: ${status}`);
      console.error('Error details:', pollData.error || pollData);
      process.exit(1);
    }
  }

  console.error(`\n❌ Polling timed out after ${attempts} attempts.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('[runpod-test] Error:', err);
  process.exit(1);
});
