import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { getPrivateBlob, privateBlobClassificationForPath, putPrivateBlob } from './video-os-private-blob.js';
import { hyperframesMvpReadiness } from '../services/hyperframes-contract.js';

export const PROVIDERS = [
  { id: 'heygen', name: 'The Render', label: 'The Render', cost: 90 },
];

const AUTH_PREFIX = 'video-os/auth/';
// Regular new accounts receive no complimentary render credits. Keep this
// shared constant while the existing account-creation call sites use its name;
// internal tester grants remain an explicit, separate path.
export const DEFAULT_TRIAL_CREDITS = 0;

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

function normalizedClientIp(req) {
  let value = clientIp(req).trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1];
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value);
  if (ipv4WithPort) value = ipv4WithPort[1];
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mappedIpv4 && isIP(mappedIpv4[1]) === 4) value = mappedIpv4[1];
  return value;
}

function ipv6Hextets(value) {
  const halves = value.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half) => half ? half.split(':') : [];
  const head = parseHalf(halves[0]);
  const tail = parseHalf(halves[1]);
  const expandIpv4 = (parts) => {
    const last = parts.at(-1);
    if (isIP(last) !== 4) return parts;
    const octets = last.split('.').map(Number);
    return [...parts.slice(0, -1), ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
  };
  const expandedHead = expandIpv4(head);
  const expandedTail = expandIpv4(tail);
  const missing = 8 - expandedHead.length - expandedTail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  return [...expandedHead, ...Array(missing).fill('0'), ...expandedTail]
    .map((part) => Number.parseInt(part || '0', 16).toString(16));
}

// Store only a coarse network prefix alongside the request's pseudonymous
// hash. This is sufficient to spot broad source changes without retaining a
// complete address in ops_events.
export function ipPrefix(req) {
  const value = normalizedClientIp(req);
  if (isIP(value) === 4) return `${value.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(value) === 6) {
    const hextets = ipv6Hextets(value);
    if (hextets) return `${hextets.slice(0, 4).join(':')}::/64`;
  }
  return 'unknown';
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
  const result = await getPrivateBlob(path);
  if (!result?.stream) return null;
  return {
    value: await new Response(result.stream).json(),
    etag: result.blob?.etag || null,
  };
}

async function writeBlobJson(path, data, options = {}) {
  const classification = privateBlobClassificationForPath(path);
  const result = await putPrivateBlob(classification, path, JSON.stringify(data, null, 2), {
    contentType: 'application/json; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: true,
    ...options,
  });
  return result;
}

export function providerById(id) {
  return PROVIDERS.find((provider) => provider.id === String(id || 'heygen').toLowerCase()) || PROVIDERS[0];
}

export function providerList(env = process.env) {
  const heygenReady = Boolean(env.HEYGEN_API_KEY || env.HEYGEN_TOKEN);
  const compositionAvailable = hyperframesMvpReadiness().ready === true
    && heygenReady
    && String(env.VIDEO_OS_HOSTED_FINISHING_ENABLED || '').toLowerCase() === 'true'
    && String(env.VIDEO_OS_COMPOSITION_ENGINE || '').toLowerCase() === 'hyperframes'
    && String(env.VIDEO_OS_HYPERFRAMES_ENABLED || '').toLowerCase() === 'true'
    && Boolean(String(env.VIDEO_OS_HYPERFRAMES_SNAPSHOT_ID || '').trim());
  return PROVIDERS.map((provider) => ({
    ...provider,
    configured: heygenReady,
    compositionAvailable,
    missing: heygenReady ? [] : ['setup'],
  }));
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

// Short-lived CSRF token for the Google OAuth redirect round trip: set right
// before redirecting to Google, checked against the `state` query param
// Google echoes back on the callback. 10 minutes covers a slow consent
// screen without leaving a long-lived guessable cookie around.
export function oauthStateCookie(state) {
  return `vos_oauth_state=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`;
}

export function clearOauthStateCookie() {
  return 'vos_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';
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

function magicTokenPath(token) {
  const tokenHash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  return AUTH_PREFIX + tokenHash + '.json';
}

function checkedMagicRecord(found) {
  const record = found?.value;
  if (!record?.email) throw Object.assign(new Error('This sign-in link is invalid.'), { statusCode: 401 });
  if (record.usedAt) throw Object.assign(new Error('This sign-in link was already used.'), { statusCode: 401 });
  if (new Date(record.expiresAt).getTime() < Date.now()) throw Object.assign(new Error('This sign-in link expired.'), { statusCode: 401 });
  return record;
}

export async function validateMagicToken(token) {
  const record = checkedMagicRecord(await readBlobJson(magicTokenPath(token)));
  return { accountId: record.accountId, email: record.email };
}

export async function consumeMagicToken(token) {
  const path = magicTokenPath(token);
  const found = await readBlobJson(path);
  const record = checkedMagicRecord(found);
  if (!found.etag) throw Object.assign(new Error('The sign-in token could not be consumed safely.'), { statusCode: 503, failureCategory: 'PERSISTENCE' });
  record.usedAt = new Date().toISOString();
  try {
    await writeBlobJson(path, record, { ifMatch: found.etag });
  } catch (error) {
    if (error?.statusCode === 412 || error?.name === 'BlobPreconditionFailedError') {
      throw Object.assign(new Error('This sign-in link was already used.'), { statusCode: 401 });
    }
    throw error;
  }
  return { accountId: record.accountId, email: record.email };
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
