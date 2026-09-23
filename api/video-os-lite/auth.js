import crypto from 'node:crypto';
import { accountDto } from '../../db/dto.js';
import { getAccountContext, recordSignIn, updateAuthenticatedAccount } from '../../db/repositories.js';
import { accountIdForEmail, clearAdminCookie, clearOauthStateCookie, clearSessionCookie, consumeMagicToken, DEFAULT_TRIAL_CREDITS, handleOptions, makeSession, oauthStateCookie, parseCookies, readJson, saveMagicToken, send, sendMagicEmail, sessionCookie, sessionFromRequest, validateMagicToken } from '../../lib/video-os-account.js';
import { captureRouteError } from '../../lib/video-os-observability.js';
import { exchangeGoogleCode, fetchGoogleProfile, googleAuthorizationUrl, googleOAuthConfigured } from '../../lib/google-oauth.js';
import { containedRenderingEntitlementKeys, publicOrigin } from '../../lib/video-os-security.js';

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


const MAX_CREDENTIAL_BYTES = 1024;

function timingSafeMatch(input, expected) {
  const value = String(input || '').trim();
  const target = String(expected || '').trim();
  if (!target) return false;
  const valueBuffer = Buffer.from(value);
  const targetBuffer = Buffer.from(target);
  const valuePadded = Buffer.alloc(MAX_CREDENTIAL_BYTES);
  const targetPadded = Buffer.alloc(MAX_CREDENTIAL_BYTES);
  valueBuffer.copy(valuePadded, 0, 0, MAX_CREDENTIAL_BYTES);
  targetBuffer.copy(targetPadded, 0, 0, MAX_CREDENTIAL_BYTES);
  const contentsMatch = crypto.timingSafeEqual(valuePadded, targetPadded);
  return contentsMatch
    && valueBuffer.length === targetBuffer.length
    && valueBuffer.length <= MAX_CREDENTIAL_BYTES
    && targetBuffer.length <= MAX_CREDENTIAL_BYTES;
}

export function resolvePasswordAccess(accessType, username, password) {
  const type = String(accessType || '').trim().toLowerCase();
  if (!['workspace', 'owner'].includes(type)) {
    throw Object.assign(new Error('Choose Workspace or Owner access.'), { statusCode: 400 });
  }
  const owner = type === 'owner';
  const expectedUser = process.env[owner ? 'VIDEO_OS_ADMIN_USERNAME' : 'VIDEO_OS_WORKSPACE_USERNAME'];
  const expectedPassword = process.env[owner ? 'VIDEO_OS_ADMIN_PASSWORD' : 'VIDEO_OS_WORKSPACE_PASSWORD'];
  if (!expectedUser || !expectedPassword) {
    throw Object.assign(new Error((owner ? 'Owner' : 'Workspace') + ' access is not configured.'), { statusCode: 503 });
  }
  if (!timingSafeMatch(username, expectedUser) || !timingSafeMatch(password, expectedPassword)) {
    throw Object.assign(new Error('Invalid ' + (owner ? 'owner' : 'workspace') + ' credentials.'), { statusCode: 401 });
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

async function loadWorkspaceAccount() {
  const email = String(process.env.VIDEO_OS_WORKSPACE_EMAIL || 'workspace@luxvideoos.local').trim().toLowerCase();
  const credits = Math.max(500, Number(process.env.VIDEO_OS_WORKSPACE_CREDITS || 5000));
  const accountId = accountIdForEmail(email);
  return updateAuthenticatedAccount({
    accountId, email,
    name: process.env.VIDEO_OS_WORKSPACE_NAME || 'LUX Workspace',
    role: 'workspace', initialCredits: credits,
    // liveRendering/standardRendering are unconditional here (not gated by
    // containedRenderingEntitlementKeys) -- the workspace credential is
    // itself the trust boundary, same as it's always been; this just keeps
    // it explicit rather than accidentally relying on the shared helper
    // ever returning something for this account.
    entitlementKeys: ['passwordAccess', 'liveRendering', 'standardRendering'], sourceId: 'workspace_password',
  });
}

export function issueAccountSession(account, maxAgeSeconds = 60 * 60 * 24 * 30) {
  return makeSession(account?.accountId || account?.user?.id, account?.email || account?.user?.email, maxAgeSeconds);
}

function publicAuthError(error) {
  const raw = String(error?.message || 'Auth failed.');
  if (/invalid (workspace|owner) credentials/i.test(raw)) {
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
  return updateAuthenticatedAccount({
    accountId: accountIdForEmail(email), email, name: process.env.VIDEO_OS_CEO_NAME || 'CEO Preview',
    role: 'ceo', initialCredits: credits,
    entitlementKeys: ['ceoPreview', 'fullAccess'], sourceId: 'ceo_access_token',
  });
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
      const session = makeSession(account.user.id, account.user.email, 60 * 60 * 24 * 30);
      await recordSignIn(account.user.id, 60 * 60 * 24 * 30);
      res.setHeader('Set-Cookie', sessionCookie(session));
      res.statusCode = 302;
      res.setHeader('Location', '/?ceo_access=1');
      return res.end('CEO access granted');
    }
    if (action === 'password-login') {
      // Workspace-only: this is the customer-facing sign-in flow, and must
      // never be able to mint the admin cookie -- that's what
      // action=admin-login (below), reachable only from /admin-console, is
      // for. The request body's own claimed access type is deliberately
      // never read.
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST to sign in with password.' });
      const payload = await readJson(req, 50_000);
      resolvePasswordAccess('workspace', payload.username, payload.password);
      const account = await loadWorkspaceAccount();
      const session = issueAccountSession(account, 60 * 60 * 24 * 30);
      await recordSignIn(account.user.id, 60 * 60 * 24 * 30);
      res.setHeader('Set-Cookie', sessionCookie(session));
      return send(res, 200, {
        ok: true,
        signedIn: true,
        accessType: 'workspace',
        email: account.user.email,
        message: 'Workspace unlocked.',
        ...accountDto(account),
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
      const token = url.searchParams.get('token');
      const { accountId, email } = await validateMagicToken(token);
      const entitlementKeys = ['magicLinkAccess', ...containedRenderingEntitlementKeys(accountId, email)];
      await updateAuthenticatedAccount({ accountId, email, name: email, role: 'customer', initialCredits: DEFAULT_TRIAL_CREDITS, entitlementKeys, sourceId: 'magic_link' });
      await consumeMagicToken(token);
      const session = makeSession(accountId, email);
      await recordSignIn(accountId);
      res.setHeader('Set-Cookie', sessionCookie(session));
      res.statusCode = 302;
      res.setHeader('Location', '/?signed_in=1');
      return res.end('Signed in');
    }
    if (action === 'google-login') {
      if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET to sign in with Google.' });
      if (!googleOAuthConfigured()) throw Object.assign(new Error('Google sign-in is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'), { statusCode: 501 });
      const state = crypto.randomBytes(24).toString('base64url');
      const redirectUri = `${publicOrigin(req)}/api/video-os-lite/google-callback`;
      res.setHeader('Set-Cookie', oauthStateCookie(state));
      res.statusCode = 302;
      res.setHeader('Location', googleAuthorizationUrl({ redirectUri, state }));
      return res.end('Redirecting to Google');
    }
    if (action === 'google-callback') {
      if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Invalid Google callback method.' });
      const url = new URL(req.url, `https://${req.headers.host || 'lux-video-os.vercel.app'}`);
      if (url.searchParams.get('error')) throw Object.assign(new Error('Google sign-in was cancelled.'), { statusCode: 401 });
      const returnedState = url.searchParams.get('state');
      const expectedState = parseCookies(req).vos_oauth_state;
      if (!returnedState || !expectedState || !timingSafeMatch(returnedState, expectedState)) {
        throw Object.assign(new Error('Google sign-in could not be verified. Please try again.'), { statusCode: 401 });
      }
      const code = url.searchParams.get('code');
      if (!code) throw Object.assign(new Error('Google sign-in did not return an authorization code.'), { statusCode: 400 });
      const redirectUri = `${publicOrigin(req)}/api/video-os-lite/google-callback`;
      const tokens = await exchangeGoogleCode({ code, redirectUri });
      const profile = await fetchGoogleProfile(tokens.access_token);
      const accountId = accountIdForEmail(profile.email);
      // containedRenderingEntitlementKeys() re-derives liveRendering/
      // standardRendering fresh from the ID allowlist and the email-domain
      // rule on every sign-in -- see its own comment in video-os-security.js
      // for why this must be recomputed here rather than trusted to persist
      // from an earlier sign-in via a different method.
      const entitlementKeys = ['googleAccess', ...containedRenderingEntitlementKeys(accountId, profile.email)];
      await updateAuthenticatedAccount({
        accountId, email: profile.email, name: profile.name, role: 'customer',
        initialCredits: DEFAULT_TRIAL_CREDITS,
        entitlementKeys, sourceId: 'google_oauth',
      });
      const session = makeSession(accountId, profile.email);
      await recordSignIn(accountId);
      res.setHeader('Set-Cookie', [sessionCookie(session), clearOauthStateCookie()]);
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
        const account = await getAccountContext(session.accountId);
        if (!account) throw Object.assign(new Error('Account not found.'), { statusCode: 401 });
        return send(res, 200, { ok: true, signedIn: true, email: session.email, ...accountDto(account) });
      } catch (error) {
        return send(res, 200, { ok: true, signedIn: false, error: error.message || 'Signed out.' });
      }
    }
    return send(res, 404, { ok: false, error: 'Auth route not found.' });
  } catch (error) {
    captureRouteError(error, { route: `auth:${action}`, failureCategory: error?.failureCategory || 'AUTH' });
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
