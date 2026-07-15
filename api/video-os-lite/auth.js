import crypto from 'node:crypto';
import { accountIdForEmail, accountPayload, clearAdminCookie, clearSessionCookie, consumeMagicToken, handleOptions, loadAccount, makeSession, readJson, saveAccount, saveMagicToken, send, sendMagicEmail, sessionCookie, sessionFromRequest } from '../../lib/video-os-account.js';
import { publicOrigin } from '../../lib/video-os-security.js';

function route(req) {
  const url = new URL(req.url, `https://${req.headers.host || 'lux-video-os.vercel.app'}`);
  return url.pathname.split('/').pop();
}
function assertCeoToken(value) {
  const expected = String(process.env.VIDEO_OS_CEO_ACCESS_TOKEN || '').trim();
  const token = String(value || '').trim();
  if (!expected) throw Object.assign(new Error('CEO access is not configured.'), { statusCode: 501 });
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);
  if (expectedBuffer.length !== tokenBuffer.length || !crypto.timingSafeEqual(expectedBuffer, tokenBuffer)) {
    throw Object.assign(new Error('This access link is invalid.'), { statusCode: 401 });
  }
}


function timingSafeMatch(input, expected) {
  const value = String(input || '').trim();
  const target = String(expected || '').trim();
  if (!target) return false;
  const valueBuffer = Buffer.from(value);
  const targetBuffer = Buffer.from(target);
  return valueBuffer.length === targetBuffer.length && crypto.timingSafeEqual(valueBuffer, targetBuffer);
}

export function resolvePasswordAccess(accessType, username, password) {
  const type = String(accessType || '').trim().toLowerCase();
  if (!['demo', 'owner'].includes(type)) {
    throw Object.assign(new Error('Choose Demo or Owner access.'), { statusCode: 400 });
  }
  const owner = type === 'owner';
  const expectedUser = process.env[owner ? 'VIDEO_OS_ADMIN_USERNAME' : 'VIDEO_OS_DEMO_USERNAME'];
  const expectedPassword = process.env[owner ? 'VIDEO_OS_ADMIN_PASSWORD' : 'VIDEO_OS_DEMO_PASSWORD'];
  if (!expectedUser || !expectedPassword) {
    throw Object.assign(new Error((owner ? 'Owner' : 'Demo') + ' access is not configured.'), { statusCode: 503 });
  }
  if (!timingSafeMatch(username, expectedUser) || !timingSafeMatch(password, expectedPassword)) {
    throw Object.assign(new Error('Invalid ' + (owner ? 'owner' : 'demo') + ' credentials.'), { statusCode: 401 });
  }
  return type;
}

function assertAdminLogin(username, password) {
  const expectedUser = process.env.VIDEO_OS_ADMIN_USERNAME;
  const expectedPassword = process.env.VIDEO_OS_ADMIN_PASSWORD;
  if (!expectedUser || !expectedPassword) throw Object.assign(new Error('Admin login is not configured. Add VIDEO_OS_ADMIN_USERNAME and VIDEO_OS_ADMIN_PASSWORD in Vercel.'), { statusCode: 501 });
  if (!timingSafeMatch(username, expectedUser) || !timingSafeMatch(password, expectedPassword)) {
    throw Object.assign(new Error('Invalid admin username or password.'), { statusCode: 401 });
  }
}

function adminCookie(token) {
  return `vos_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${60 * 60 * 12}`;
}

async function loadPasswordAccount(username) {
  const email = String(process.env.VIDEO_OS_DEMO_EMAIL || 'demo@luxvideoos.local').trim().toLowerCase();
  const credits = Math.max(500, Number(process.env.VIDEO_OS_DEMO_CREDITS || 5000));
  const account = await loadAccount(accountIdForEmail(email));
  account.email = email;
  account.name = process.env.VIDEO_OS_DEMO_NAME || String(username || 'LUX Demo').trim() || 'LUX Demo';
  account.role = 'demo';
  account.subscription = {
    plan: 'Video OS Lite Demo Access',
    status: 'active',
    renewal: 'Password access enabled',
  };
  account.credits = {
    accountId: account.accountId,
    balance: Math.max(Number(account.credits?.balance || 0), credits),
    currency: 'credits',
  };
  account.entitlements = {
    ...(account.entitlements || {}),
    passwordAccess: true,
    liveRendering: true,
  };
  return saveAccount(account);
}

async function loadOwnerAccount(username) {
  const email = String(process.env.VIDEO_OS_ADMIN_EMAIL || process.env.VIDEO_OS_CEO_EMAIL || 'owner@luxvideoos.local').trim().toLowerCase();
  const credits = Math.max(1000, Number(process.env.VIDEO_OS_CEO_CREDITS || 10000));
  const account = await loadAccount(accountIdForEmail(email));
  account.email = email;
  account.name = process.env.VIDEO_OS_CEO_NAME || String(username || 'LUX Owner').trim() || 'LUX Owner';
  account.role = 'owner';
  account.subscription = { plan: 'Video OS Owner Access', status: 'active', renewal: 'Owner-managed workspace' };
  account.credits = {
    accountId: account.accountId,
    balance: Math.max(Number(account.credits?.balance || 0), credits),
    currency: 'credits',
  };
  account.entitlements = {
    ...(account.entitlements || {}),
    ownerAccess: true,
    fullAccess: true,
    liveRendering: true,
  };
  return saveAccount(account);
}

function publicAuthError(error) {
  const raw = String(error?.message || 'Auth failed.');
  if (/invalid (demo|owner) credentials/i.test(raw)) {
    return { status: 401, payload: { ok: false, code: 'invalid_credentials', error: raw } };
  }
  if (/blob|store|private access|access level/i.test(raw)) {
    return { status: 503, payload: { ok: false, code: 'auth_storage_unavailable', error: 'Sign-in storage is temporarily unavailable. Please try again shortly.' } };
  }
  if (error?.statusCode === 502) {
    return { status: 502, payload: { ok: false, code: 'email_delivery_failed', error: 'We could not send the sign-in email. Check the address and try again.' } };
  }
  return { status: error?.statusCode || 400, payload: { ok: false, error: raw } };
}

async function loadCeoAccount() {
  const email = String(process.env.VIDEO_OS_CEO_EMAIL || 'ariel@luxmarketingcompany.com').trim().toLowerCase();
  const credits = Math.max(1000, Number(process.env.VIDEO_OS_CEO_CREDITS || 10000));
  const account = await loadAccount(accountIdForEmail(email));
  account.email = email;
  account.name = process.env.VIDEO_OS_CEO_NAME || 'CEO Preview';
  account.role = 'ceo';
  account.subscription = {
    plan: 'Video OS Lite CEO Preview',
    status: 'active',
    renewal: 'Full-access executive preview',
  };
  account.credits = {
    accountId: account.accountId,
    balance: Math.max(Number(account.credits?.balance || 0), credits),
    currency: 'credits',
  };
  account.entitlements = {
    ...(account.entitlements || {}),
    ceoPreview: true,
    fullAccess: true,
  };
  return saveAccount(account);
}
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const action = route(req);
  try {
    if (action === 'ceo-access') {
      if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use the private CEO access link.' });
      const url = new URL(req.url, `https://${req.headers.host || 'lux-video-os.vercel.app'}`);
      assertCeoToken(url.searchParams.get('token'));
      const account = await loadCeoAccount();
      const session = makeSession(account.accountId, account.email, 60 * 60 * 24 * 30);
      res.setHeader('Set-Cookie', sessionCookie(session));
      res.statusCode = 302;
      res.setHeader('Location', '/?ceo_access=1');
      return res.end('CEO access granted');
    }
    if (action === 'password-login') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST to sign in with password.' });
      const payload = await readJson(req, 50_000);
      const accessType = resolvePasswordAccess(payload.accessType || 'demo', payload.username, payload.password);
      const account = accessType === 'owner' ? await loadOwnerAccount(payload.username) : await loadPasswordAccount(payload.username);
      const session = makeSession(account.accountId, account.email, 60 * 60 * 24 * 30);
      const cookies = [sessionCookie(session)];
      if (accessType === 'owner') cookies.push(adminCookie(makeSession('admin', account.email, 60 * 60 * 12)));
      res.setHeader('Set-Cookie', cookies);
      return send(res, 200, {
        ok: true,
        signedIn: true,
        accessType,
        email: account.email,
        message: accessType === 'owner' ? 'Owner workspace unlocked.' : 'Demo workspace unlocked.',
        ...accountPayload(account),
      });
    }
    if (action === 'admin-login') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST for admin login.' });
      const payload = await readJson(req, 50_000);
      assertAdminLogin(payload.username, payload.password);
      const adminUser = String(process.env.VIDEO_OS_ADMIN_USERNAME || payload.username || 'admin').trim().toLowerCase();
      const session = makeSession('admin', adminUser, 60 * 60 * 12);
      res.setHeader('Set-Cookie', adminCookie(session));
      return send(res, 200, { ok: true, admin: true, message: 'Admin access granted.' });
    }
    if (action === 'auth-request') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST to request a sign-in link.' });
      const payload = await readJson(req);
      if (!process.env.RESEND_API_KEY || !process.env.AUTH_FROM_EMAIL) throw Object.assign(new Error('Email sign-in is not configured. Add RESEND_API_KEY and AUTH_FROM_EMAIL in Vercel.'), { statusCode: 501 });
      const { token, record } = await saveMagicToken(payload.email);
      const origin = publicOrigin(req);
      const magicUrl = `${origin}/api/video-os-lite/auth-verify?token=${encodeURIComponent(token)}`;
      await sendMagicEmail(record.email, magicUrl);
      return send(res, 200, { ok: true, email: record.email, message: 'Check your email for a secure sign-in link.' });
    }
    if (action === 'auth-verify') {
      const url = new URL(req.url, `https://${req.headers.host || 'lux-video-os.vercel.app'}`);
      const { account, email } = await consumeMagicToken(url.searchParams.get('token'));
      const session = makeSession(account.accountId, email);
      res.setHeader('Set-Cookie', sessionCookie(session));
      res.statusCode = 302;
      res.setHeader('Location', '/?signed_in=1');
      return res.end('Signed in');
    }
    if (action === 'session') {
      if (req.method === 'POST') {
        res.setHeader('Set-Cookie', [clearSessionCookie(), clearAdminCookie()]);
        return send(res, 200, { ok: true, signedIn: false });
      }
      if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET for session status.' });
      try {
        const session = sessionFromRequest(req);
        const account = await loadAccount(session.accountId);
        return send(res, 200, { ok: true, signedIn: true, email: session.email, ...accountPayload(account) });
      } catch (error) {
        return send(res, 200, { ok: true, signedIn: false, error: error.message || 'Signed out.' });
      }
    }
    return send(res, 404, { ok: false, error: 'Auth route not found.' });
  } catch (error) {
    console.error('video_os_auth_error', {
      action,
      statusCode: error?.statusCode || 400,
      providerStatus: error?.providerStatus || null,
      providerCode: error?.providerCode || null,
    });
    const failure = publicAuthError(error);
    return send(res, failure.status, failure.payload);
  }
}
