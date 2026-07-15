import { parseOrThrow, providerStatusSchema, providerSubmitSchema } from '../lib/video-os-validation.js';

const API_ORIGIN = 'https://api.heygen.com';
const timeoutMs = () => Number(process.env.HEYGEN_TIMEOUT_MS || 20_000);

function key() {
  const value = String(process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN || '').trim();
  if (!value) throw Object.assign(new Error('HEYGEN_API_KEY is not configured.'), { statusCode: 503, failureCategory: 'CONFIG_MISSING' });
  return value;
}

async function responseJson(response, category) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw Object.assign(new Error('HeyGen returned invalid JSON.'), { failureCategory: category }); }
  if (!response.ok) throw Object.assign(new Error(`HeyGen request failed with HTTP ${response.status}.`), { statusCode: 502, failureCategory: category, providerHttpStatus: response.status });
  return data;
}

export async function submitHeygen(job) {
  const input = job.input;
  const response = await fetch(`${API_ORIGIN}/v3/videos`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs()),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': key(), 'Idempotency-Key': job.id },
    body: JSON.stringify({ type: 'avatar', avatar_id: input.avatar.avatarId, script: input.script, voice_id: input.voice.voiceId, title: job.title, resolution: '1080p', aspect_ratio: job.format === 'landscape' ? '16:9' : job.format === 'square' ? '1:1' : '9:16' }),
  });
  const parsed = parseOrThrow(providerSubmitSchema, await responseJson(response, 'PROVIDER_SUBMIT'), 'HeyGen submission response was invalid.');
  return { providerJobId: parsed.data?.video_id || parsed.data?.id || parsed.data?.job_id || parsed.video_id || parsed.id || parsed.job_id };
}

export async function pollHeygen(providerJobId) {
  const response = await fetch(`${API_ORIGIN}/v3/videos/${encodeURIComponent(providerJobId)}`, { signal: AbortSignal.timeout(timeoutMs()), headers: { Accept: 'application/json', 'X-Api-Key': key() } });
  const parsed = parseOrThrow(providerStatusSchema, await responseJson(response, 'PROVIDER_POLL'), 'HeyGen status response was invalid.');
  const data = parsed.data || parsed;
  const status = String(data.status || parsed.status || '').toLowerCase();
  const sourceUrl = [data.video_url, data.videoUrl, data.download_url, data.downloadUrl, data.url].find((value) => typeof value === 'string');
  if (status === 'failed' || status === 'error') throw Object.assign(new Error('HeyGen render failed.'), { failureCategory: 'PROVIDER_REJECTED' });
  return { ready: status === 'completed' && Boolean(sourceUrl), status: status || 'processing', sourceUrl: sourceUrl || null };
}
