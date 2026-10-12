import { createHash } from 'node:crypto';

import { timingSafeMatch } from '../../lib/video-os-security.js';
import { qualifyHeygenCredential } from '../../services/heygen-account-qualification.js';

const PROJECT_ID = 'prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW';
const MAX_WINDOW_MS = 2 * 60 * 60_000;
const USERNAME_DIGEST_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_PROFILE_USERNAME\0V1\0', 'utf8');

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const exactHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function exactTime(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

export function heygenAttestationWindow(env = process.env, now = Date.now()) {
  const startedAt = exactTime(env.VIDEO_OS_HEYGEN_ATTESTATION_STARTED_AT);
  const expiresAt = exactTime(env.VIDEO_OS_HEYGEN_ATTESTATION_EXPIRES_AT);
  return env.VIDEO_OS_HEYGEN_ATTESTATION_ENABLED === 'true'
    && startedAt !== null && expiresAt !== null
    && startedAt <= now && now < expiresAt
    && startedAt < expiresAt && expiresAt - startedAt <= MAX_WINDOW_MS;
}

function exactDeploymentRequest(req, env) {
  const host = String(req.headers.host || '').toLowerCase();
  const uniqueProjectHost = /^[a-z0-9-]+-lux-3035s-projects\.vercel\.app$/.test(host)
    && host !== 'lux-video-os-lux-3035s-projects.vercel.app';
  const systemHost = String(env.VERCEL_URL || '').toLowerCase();
  return env.VERCEL_ENV === 'production'
    && env.VERCEL_PROJECT_ID === PROJECT_ID
    && /^dpl_[A-Za-z0-9]+$/.test(String(env.VERCEL_DEPLOYMENT_ID || ''))
    && uniqueProjectHost
    && (!systemHost || host === systemHost);
}

function operatorAuthorized(req, env) {
  const token = String(env.VIDEO_OS_ADMIN_TOKEN || '').trim();
  const match = /^Bearer ([^\s]+)$/i.exec(String(req.headers.authorization || ''));
  return Boolean(token && match) && timingSafeMatch(match[1], token);
}

function respond(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Vary', 'Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function sanitizedCredential(qualification) {
  if (!exactHash(qualification?.credentialKeyFingerprint)
    || !exactHash(qualification?.credentialScopeFingerprint)) {
    throw new Error('Invalid credential qualification.');
  }
  const profile = qualification.privateEvidence?.profile;
  const username = typeof profile?.username === 'string' ? profile.username : '';
  return {
    keyFingerprint: qualification.credentialKeyFingerprint,
    scopeFingerprint: qualification.credentialScopeFingerprint,
    status: qualification.publicSummary?.credentialStatus === 'active' ? 'active' : 'unavailable',
    accountRead: qualification.publicSummary?.profileProbeOutcome === 'OBSERVED',
    usernameDigest: username
      ? createHash('sha256').update(USERNAME_DIGEST_DOMAIN).update(username, 'utf8').digest('hex')
      : null,
  };
}

export async function handleHeygenRuntimeAttestation(req, res, {
  env = process.env,
  now = Date.now(),
  clock = Date.now,
  qualify = qualifyHeygenCredential,
} = {}) {
  if (!heygenAttestationWindow(env, now) || !exactDeploymentRequest(req, env)) {
    return respond(res, 404, { ok: false, code: 'attestation_unavailable' });
  }
  if (req.method !== 'GET') return respond(res, 405, { ok: false, code: 'method_not_allowed' });
  if (!operatorAuthorized(req, env)) return respond(res, 401, { ok: false, code: 'operator_required' });

  const deploymentIdHash = sha256(env.VERCEL_DEPLOYMENT_ID);
  if (String(req.headers['x-expected-deployment-id-hash'] || '').toLowerCase() !== deploymentIdHash) {
    return respond(res, 409, { ok: false, code: 'deployment_mismatch' });
  }
  const apiKey = String(env.HEYGEN_API_KEY || '').trim();
  if (!apiKey || apiKey === '[SENSITIVE]') {
    return respond(res, 503, { ok: false, code: 'credential_unavailable' });
  }

  let qualification;
  try {
    qualification = await qualify({ apiKey });
  } catch (error) {
    const code = error?.code === 'HEYGEN_QUALIFICATION_AUTHORIZATION_FAILURE'
      ? 'credential_rejected'
      : 'credential_unavailable';
    return respond(res, 503, { ok: false, code });
  }
  let credential;
  try {
    credential = sanitizedCredential(qualification);
  } catch {
    return respond(res, 503, { ok: false, code: 'credential_unavailable' });
  }
  const finishedAt = clock();
  if (!heygenAttestationWindow(env, finishedAt)) {
    return respond(res, 404, { ok: false, code: 'attestation_unavailable' });
  }

  return respond(res, 200, {
    version: 'heygen-runtime-attestation/v1',
    ok: true,
    observedAt: new Date(finishedAt).toISOString(),
    target: { projectId: PROJECT_ID, deploymentIdHash, environment: 'production', observedHost: String(req.headers.host).toLowerCase() },
    credential,
    space: { verified: false, status: 'not_attested' },
    canaryAuthorized: false,
  });
}
