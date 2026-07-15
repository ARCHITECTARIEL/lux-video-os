import { get, list, put } from '@vercel/blob';
import crypto from 'node:crypto';
import { debitCredits, loadCreditState } from './video-os-credits.js';

export const PROVIDERS = [
  { id: 'heygen', name: 'HeyGen', label: 'Best first render', cost: 90 },
  { id: 'argil', name: 'Argil', label: 'Clone-style videos', cost: 80 },
  { id: 'tavus', name: 'Tavus', label: 'Personalized video clone', cost: 120 },
  { id: 'did', name: 'D-ID', label: 'Fast talking-head render', cost: 45 },
];

const ACCOUNT_PREFIX = 'video-os/accounts/';
const RATE_PREFIX = 'video-os/rate/';
const JOB_PREFIX = 'video-os/jobs/';
const AUTH_PREFIX = 'video-os/auth/';
const DEFAULT_TRIAL_CREDITS = Number(process.env.VIDEO_OS_TRIAL_CREDITS || 180);
const DEFAULT_DAILY_LIMIT = Number(process.env.VIDEO_OS_DAILY_RENDER_LIMIT || 2);
const DEFAULT_HOURLY_LIMIT = Number(process.env.VIDEO_OS_HOURLY_RENDER_LIMIT || 1);

export function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature, Authorization');
  res.end(JSON.stringify(payload));
}

export function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return true;
  }
  return false;
}

export function safeId(value) {
  const cleaned = String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return cleaned || `acct-${crypto.randomUUID()}`;
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.socket?.remoteAddress || 'unknown');
}

export function ipHash(req) {
  return crypto.createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 24);
}

export async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function readRaw(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBlobJson(path) {
  const result = await get(path, { access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN, useCache: false });
  if (!result?.stream) return null;
  return new Response(result.stream).json();
}

async function writeBlobJson(path, data) {
  const result = await put(path, JSON.stringify(data, null, 2), {
    access: 'private',
    contentType: 'application/json; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return result;
}

export async function loadAccount(accountId) {
  const id = safeId(accountId);
  const path = `${ACCOUNT_PREFIX}${id}.json`;
  const existing = await readBlobJson(path);
  if (existing?.accountId) {
    const creditState = await loadCreditState(existing.accountId, existing.credits?.balance || 0);
    return { ...existing, credits: { accountId: existing.accountId, balance: creditState.balance, currency: 'credits' } };
  }
  const now = new Date().toISOString();
  const created = {
    accountId: id,
    name: 'Video OS Lite Account',
    subscription: { plan: 'Video OS Lite', status: 'trial', renewal: 'Add credits to keep rendering' },
    credits: { accountId: id, balance: DEFAULT_TRIAL_CREDITS, currency: 'credits' },
    usage: { renders: 0, creditsSpent: 0, purchases: 0, creditsPurchased: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await writeBlobJson(path, created);
  await loadCreditState(id, DEFAULT_TRIAL_CREDITS);
  return created;
}

export async function saveAccount(account) {
  const now = new Date().toISOString();
  const next = { ...account, updatedAt: now };
  const { credits, ...metadata } = next;
  await writeBlobJson(`${ACCOUNT_PREFIX}${safeId(next.accountId)}.json`, metadata);
  return next;
}

export function accountPayload(account, extra = {}) {
  return {
    accountId: account.accountId,
    account: {
      accountId: account.accountId,
      name: account.name || 'Video OS Lite Account',
      subscription: account.subscription || { plan: 'Video OS Lite', status: 'trial' },
    },
    credits: account.credits || { accountId: account.accountId, balance: 0, currency: 'credits' },
    security: {
      status: 'guarded',
      dailyRenderLimit: DEFAULT_DAILY_LIMIT,
      hourlyRenderLimit: DEFAULT_HOURLY_LIMIT,
      message: 'Live renders require credits and are rate-limited server-side.',
    },
    ...extra,
  };
}

export async function assertRenderAllowed(req, account, provider) {
  const cost = Number(provider?.cost || 0);
  const balance = Number(account.credits?.balance || 0);
  if (!cost || balance < cost) {
    throw Object.assign(new Error(`Add credits before rendering. ${provider.name} needs ${cost} credits and this account has ${balance}.`), { statusCode: 402 });
  }
  const today = new Date().toISOString().slice(0, 10);
  const hour = new Date().toISOString().slice(0, 13);
  const key = `${today}-${safeId(account.accountId)}-${ipHash(req)}`;
  const path = `${RATE_PREFIX}${key}.json`;
  const current = await readBlobJson(path) || { key, accountId: account.accountId, ipHash: ipHash(req), day: today, hours: {}, count: 0 };
  current.count = Number(current.count || 0);
  current.hours = current.hours || {};
  current.hours[hour] = Number(current.hours[hour] || 0);
  if (current.count >= DEFAULT_DAILY_LIMIT) {
    throw Object.assign(new Error(`Daily render limit reached. Add credits or try again tomorrow.`), { statusCode: 429 });
  }
  if (current.hours[hour] >= DEFAULT_HOURLY_LIMIT) {
    throw Object.assign(new Error(`Hourly render limit reached. Try again shortly.`), { statusCode: 429 });
  }
  current.count += 1;
  current.hours[hour] += 1;
  current.updatedAt = new Date().toISOString();
  await writeBlobJson(path, current);
  return current;
}

export async function debitRender(account, provider) {
  const cost = Number(provider.cost || 0);
  const state = await debitCredits(account.accountId, account.credits?.balance || 0, cost);
  account.credits = { accountId: account.accountId, balance: state.balance, currency: 'credits' };
  account.usage = account.usage || {};
  account.usage.renders = Number(account.usage.renders || 0) + 1;
  account.usage.creditsSpent = Number(account.usage.creditsSpent || 0) + cost;
  return saveAccount(account);
}

export async function addCredits(accountId, credits, source = 'stripe') {
  const account = await loadAccount(accountId);
  const amount = Math.max(0, Number(credits || 0));
  account.credits = { accountId: account.accountId, balance: Number(account.credits?.balance || 0) + amount, currency: 'credits' };
  account.usage = account.usage || {};
  account.usage.purchases = Number(account.usage.purchases || 0) + 1;
  account.usage.creditsPurchased = Number(account.usage.creditsPurchased || 0) + amount;
  account.lastCreditSource = source;
  account.subscription = { plan: 'Video OS Lite', status: 'active', renewal: 'Credits available' };
  return saveAccount(account);
}

export function providerById(id) {
  return PROVIDERS.find((provider) => provider.id === String(id || 'heygen').toLowerCase()) || PROVIDERS[0];
}

export function providerList() {
  const heygenReady = Boolean(process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN);
  return PROVIDERS.map((provider) => {
    if (provider.id === 'heygen') return { ...provider, configured: heygenReady, missing: heygenReady ? [] : ['HEYGEN_API_KEY'] };
    const missing = provider.id === 'argil'
      ? ['ARGIL_API_KEY', 'ARGIL_RENDER_URL']
      : provider.id === 'tavus'
        ? ['TAVUS_API_KEY', 'TAVUS_REPLICA_ID']
        : ['DID_API_KEY', 'DID_SOURCE_URL'];
    return { ...provider, configured: false, missing };
  });
}
export function sessionSecret() {
  return String(process.env.VIDEO_OS_SESSION_SECRET || '').trim();
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function unbase64url(input) {
  return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

function sign(value) {
  const secret = sessionSecret();
  if (!secret) throw Object.assign(new Error('VIDEO_OS_SESSION_SECRET is not configured.'), { statusCode: 501 });
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

export function makeSession(accountId, email, maxAgeSeconds = 60 * 60 * 24 * 30) {
  const payload = { accountId: safeId(accountId), email: String(email || '').toLowerCase(), exp: Math.floor(Date.now() / 1000) + maxAgeSeconds };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

export function verifySessionToken(token) {
  const [encoded, signature] = String(token || '').split('.');
  const expected = sign(encoded || '');
  const actualBuffer = Buffer.from(signature || '');
  const expectedBuffer = Buffer.from(expected);
  if (!encoded || !signature || actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) throw Object.assign(new Error('Sign in to render videos.'), { statusCode: 401 });
  const payload = JSON.parse(unbase64url(encoded));
  if (!payload.accountId || Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) throw Object.assign(new Error('Your session expired. Sign in again.'), { statusCode: 401 });
  return payload;
}

export function sessionFromRequest(req) {
  const cookie = parseCookies(req).vos_session;
  if (!cookie) throw Object.assign(new Error('Sign in to render videos.'), { statusCode: 401 });
  return verifySessionToken(cookie);
}

export function sessionCookie(token) {
  return `vos_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${60 * 60 * 24 * 30}`;
}

export function clearSessionCookie() {
  return 'vos_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';
}

export function clearAdminCookie() {
  return 'vos_admin=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';
}

export function accountIdForEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const digest = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return `user-${digest}`;
}

export function normalizeEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('Enter a valid email address.');
  return normalized;
}

export async function saveMagicToken(email) {
  const normalized = normalizeEmail(email);
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const record = {
    tokenHash,
    email: normalized,
    accountId: accountIdForEmail(normalized),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    usedAt: null,
    createdAt: new Date().toISOString(),
  };
  await writeBlobJson(`${AUTH_PREFIX}${tokenHash}.json`, record);
  return { token, record };
}

export async function consumeMagicToken(token) {
  const tokenHash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const path = `${AUTH_PREFIX}${tokenHash}.json`;
  const record = await readBlobJson(path);
  if (!record?.email) throw Object.assign(new Error('This sign-in link is invalid.'), { statusCode: 401 });
  if (record.usedAt) throw Object.assign(new Error('This sign-in link was already used.'), { statusCode: 401 });
  if (new Date(record.expiresAt).getTime() < Date.now()) throw Object.assign(new Error('This sign-in link expired.'), { statusCode: 401 });
  record.usedAt = new Date().toISOString();
  await writeBlobJson(path, record);
  const account = await loadAccount(record.accountId);
  account.email = record.email;
  account.name = record.email;
  account.subscription = account.subscription || { plan: 'Video OS Lite', status: 'trial', renewal: 'Add credits to keep rendering' };
  await saveAccount(account);
  return { account, email: record.email };
}

export async function sendMagicEmail(email, magicUrl) {
  const key = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.AUTH_FROM_EMAIL || '').trim();
  if (!key || !from) throw Object.assign(new Error('Email sign-in is not configured. Add RESEND_API_KEY and AUTH_FROM_EMAIL in Vercel.'), { statusCode: 501 });
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Your Video OS Lite sign-in link',
      html: `<p>Use this secure link to sign in to Video OS Lite:</p><p><a href="${magicUrl}">Sign in to Video OS Lite</a></p><p>This link expires in 15 minutes.</p>`,
      text: `Sign in to Video OS Lite: ${magicUrl}\n\nThis link expires in 15 minutes.`,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    let providerCode = 'resend_rejected';
    try { providerCode = JSON.parse(text)?.name || JSON.parse(text)?.code || providerCode; } catch {}
    throw Object.assign(new Error('The email provider rejected the sign-in message.'), {
      statusCode: 502,
      providerStatus: response.status,
      providerCode: String(providerCode).slice(0, 80),
    });
  }
  return text ? JSON.parse(text) : { ok: true };
}

export const RESULT_HISTORY_LIMIT = 30;

export function limitRecentJobs(jobs, limit = RESULT_HISTORY_LIMIT) {
  const boundedLimit = Math.max(0, Math.min(Number(limit) || RESULT_HISTORY_LIMIT, RESULT_HISTORY_LIMIT));
  return (Array.isArray(jobs) ? [...jobs] : [])
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, boundedLimit);
}

export async function loadJobs(accountId) {
  const account = await loadAccount(accountId);
  return limitRecentJobs(account.jobs);
}

export async function loadOwnedJob(accountId, jobId) {
  const id = safeId(jobId);
  return (await loadJobs(accountId)).find((job) => job.id === id || job.providerJobId === jobId) || null;
}

export function jobForClient(job) {
  const { sourceUrl, finalBlobPathname, raw, ...safe } = job || {};
  return { ...safe, url: safe.status === 'ready' ? `/api/video-os-lite/download?jobId=${encodeURIComponent(safe.id)}` : null };
}

export async function upsertJob(accountId, job) {
  const account = await loadAccount(accountId);
  const jobs = Array.isArray(account.jobs) ? account.jobs : [];
  const id = safeId(job.id || job.providerJobId || `job-${Date.now()}`);
  const now = new Date().toISOString();
  const nextJob = { ...job, id, accountId: account.accountId, updatedAt: now, createdAt: job.createdAt || now };
  const index = jobs.findIndex((item) => item.id === id || (nextJob.providerJobId && item.providerJobId === nextJob.providerJobId));
  if (index >= 0) jobs[index] = { ...jobs[index], ...nextJob };
  else jobs.unshift(nextJob);
  account.jobs = jobs.slice(0, 50);
  await writeBlobJson(`${JOB_PREFIX}${account.accountId}-${id}.json`, nextJob);
  await saveAccount(account);
  return nextJob;
}

export async function listAllJobBlobs(limit = 100) {
  const found = await list({ prefix: JOB_PREFIX, limit });
  const jobs = [];
  for (const blob of found.blobs || []) {
    try {
      const job = await readBlobJson(blob.pathname);
      if (job) jobs.push(job);
    } catch {}
  }
  return jobs.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}
