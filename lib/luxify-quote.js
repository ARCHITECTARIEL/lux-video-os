import crypto from 'node:crypto';

import {
  LUXIFY_ASPECT_RATIOS,
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_MAX_DURATION_SECONDS,
  LUXIFY_MIN_DURATION_SECONDS,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
  LUXIFY_RESOLUTIONS,
  canonicalizeLuxifyIntent,
} from './luxify-contract.js';
import { sessionSecret } from './video-os-account.js';
import { stableJson } from './video-os-render-authorization.js';

export const LUXIFY_PRICING_VERSION = 'luxify-cinematic-pricing-v1';
export const LUXIFY_QUOTE_TTL_MS = 5 * 60 * 1_000;
export const LUXIFY_LUX_CREDIT_ENV = Object.freeze({
  '720p': 'VIDEO_OS_LUXIFY_720P_LUX_CREDITS',
  '1080p': 'VIDEO_OS_LUXIFY_1080P_LUX_CREDITS',
});

const QUOTE_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const ELIGIBILITY_REVISION = /^[A-Za-z0-9_.:-]{1,160}$/;
const BINDING_KEYS = new Set([
  'accountId',
  'projectId',
  'idempotencyKey',
  'title',
  'prompt',
  'lookBindings',
  'eligibilityRevision',
  'aspectRatio',
  'resolution',
  'durationSeconds',
]);

export class LuxifyQuoteError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'LuxifyQuoteError';
    this.code = code;
    this.statusCode = statusCode;
    this.failureCategory = code === 'LUXIFY_QUOTE_CONFIG_MISSING' ? 'CONFIG_MISSING' : 'VALIDATION';
  }
}

function quoteError(code, message, statusCode) {
  throw new LuxifyQuoteError(code, message, statusCode);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(stableJson(value));
}

function secretFor(options) {
  const secret = Object.hasOwn(options, 'secret') ? String(options.secret || '').trim() : sessionSecret();
  if (secret.length < 32) quoteError('LUXIFY_QUOTE_CONFIG_MISSING', 'LUXIFY quote signing is unavailable.', 503);
  return secret;
}

function timeFor(value) {
  const time = value instanceof Date ? value.getTime() : value === undefined ? Date.now() : Number(value);
  if (!Number.isSafeInteger(time) || time <= 0) quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY quote time is invalid.', 400);
  return time;
}

export function configuredLuxifyCredits(resolution, env = process.env) {
  if (!LUXIFY_RESOLUTIONS.includes(resolution)) quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY resolution is invalid.', 400);
  const variable = LUXIFY_LUX_CREDIT_ENV[resolution];
  const raw = String(env?.[variable] ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(raw)) {
    quoteError('LUXIFY_QUOTE_CONFIG_MISSING', 'LUXIFY ' + resolution + ' LUX-credit pricing is unavailable.', 503);
  }
  const credits = Number(raw);
  if (!Number.isSafeInteger(credits) || credits <= 0) {
    quoteError('LUXIFY_QUOTE_CONFIG_MISSING', 'LUXIFY ' + resolution + ' LUX-credit pricing is unavailable.', 503);
  }
  return credits;
}

function canonicalLookBindings(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY quote requires one to three look bindings.', 400);
  }
  const bindings = value.map((binding) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || Object.keys(binding).some(key => !['identityId', 'providerLookId'].includes(key))
      || Object.keys(binding).length !== 2
      || !UUID.test(binding.identityId || '')
      || !PROVIDER_ID.test(binding.providerLookId || '')) {
      quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY look binding is invalid.', 400);
    }
    return Object.freeze({
      identityId: binding.identityId.toLowerCase(),
      providerLookId: binding.providerLookId,
    });
  });
  if (new Set(bindings.map(binding => binding.identityId)).size !== bindings.length
    || new Set(bindings.map(binding => binding.providerLookId)).size !== bindings.length) {
    quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY look bindings must be unique.', 400);
  }
  return Object.freeze(bindings);
}

export function digestLuxifyLookBindings(value) {
  return sha256(canonicalJson(canonicalLookBindings(value)));
}

function canonicalBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || Object.keys(binding).some(key => !BINDING_KEYS.has(key))
    || Object.keys(binding).length !== BINDING_KEYS.size) {
    quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY quote binding is invalid.', 400);
  }
  const accountId = String(binding.accountId || '').trim();
  const eligibilityRevision = String(binding.eligibilityRevision || '').trim();
  if (!accountId || accountId.length > 160 || !ELIGIBILITY_REVISION.test(eligibilityRevision)) {
    quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY quote binding is invalid.', 400);
  }
  const lookBindings = canonicalLookBindings(binding.lookBindings);
  let intent;
  try {
    intent = canonicalizeLuxifyIntent({
      contractVersion: LUXIFY_CONTRACT_VERSION,
      projectId: binding.projectId,
      idempotencyKey: binding.idempotencyKey,
      title: binding.title,
      prompt: binding.prompt,
      lookIdentityIds: lookBindings.map(item => item.identityId),
      aspectRatio: binding.aspectRatio,
      resolution: binding.resolution,
      durationSeconds: binding.durationSeconds,
    });
  } catch {
    quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY quote binding is invalid.', 400);
  }
  return Object.freeze({ accountId, eligibilityRevision, lookBindings, intent });
}

function expectedClaims(binding, options) {
  const normalized = canonicalBinding(binding);
  const luxCredits = configuredLuxifyCredits(normalized.intent.resolution, options.env ?? process.env);
  return {
    accountSha256: sha256(normalized.accountId),
    projectId: normalized.intent.projectId,
    idempotencyKeySha256: sha256(normalized.intent.idempotencyKey),
    titleSha256: sha256(normalized.intent.title),
    promptSha256: sha256(normalized.intent.prompt),
    lookBindingsSha256: sha256(canonicalJson(normalized.lookBindings)),
    eligibilityRevisionSha256: sha256(normalized.eligibilityRevision),
    aspectRatio: normalized.intent.aspectRatio,
    resolution: normalized.intent.resolution,
    durationSeconds: normalized.intent.durationSeconds,
    renderMode: LUXIFY_RENDER_MODE,
    providerCapability: LUXIFY_PROVIDER_CAPABILITY,
    luxCredits,
  };
}

function sign(encoded, secret) {
  return crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
}

export function issueLuxifyQuote(binding, options = {}) {
  const secret = secretFor(options);
  const issuedAt = timeFor(options.now);
  const nonce = options.nonce === undefined ? crypto.randomBytes(18).toString('base64url') : String(options.nonce);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY quote nonce is invalid.', 400);
  const expiresAt = issuedAt + LUXIFY_QUOTE_TTL_MS;
  const payload = {
    version: QUOTE_VERSION,
    contractVersion: LUXIFY_CONTRACT_VERSION,
    pricingVersion: LUXIFY_PRICING_VERSION,
    ...expectedClaims(binding, options),
    issuedAt,
    expiresAt,
    nonce,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return Object.freeze({
    token: encoded + '.' + sign(encoded, secret),
    credits: payload.luxCredits,
    currency: 'lux_credits',
    expiresAt: new Date(expiresAt).toISOString(),
    pricingVersion: LUXIFY_PRICING_VERSION,
  });
}

function decodeToken(token, secret) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 8_192) {
    quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY quote token is invalid.', 400);
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
    quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY quote token is invalid.', 400);
  }
  const [encoded, signature] = parts;
  const expected = Buffer.from(sign(encoded, secret), 'base64url');
  const actual = Buffer.from(signature, 'base64url');
  if (Buffer.from(encoded, 'base64url').toString('base64url') !== encoded
    || actual.toString('base64url') !== signature
    || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY quote token is invalid.', 400);
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch {
    quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY quote token is invalid.', 400);
  }
  return payload;
}

export function verifyLuxifyQuote(token, binding, options = {}) {
  const secret = secretFor(options);
  const now = timeFor(options.now);
  const payload = decodeToken(token, secret);
  if (!payload || payload.version !== QUOTE_VERSION
    || payload.contractVersion !== LUXIFY_CONTRACT_VERSION
    || payload.pricingVersion !== LUXIFY_PRICING_VERSION
    || payload.renderMode !== LUXIFY_RENDER_MODE
    || payload.providerCapability !== LUXIFY_PROVIDER_CAPABILITY
    || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt - payload.issuedAt !== LUXIFY_QUOTE_TTL_MS
    || payload.issuedAt > now + 5_000
    || !/^[A-Za-z0-9_-]{16,128}$/.test(payload.nonce || '')) {
    quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY quote token is invalid.', 400);
  }
  if (now >= payload.expiresAt) quoteError('LUXIFY_QUOTE_EXPIRED', 'LUXIFY quote expired. Request a new quote before rendering.', 410);
  const expected = expectedClaims(binding, options);
  for (const [key, value] of Object.entries(expected)) {
    if (payload[key] !== value) quoteError('LUXIFY_QUOTE_MISMATCH', 'LUXIFY quote no longer matches the saved project.', 409);
  }
  return Object.freeze({ ...payload });
}

export function safeLuxifyQuoteProof(claims) {
  const hashFields = [
    'accountSha256',
    'idempotencyKeySha256',
    'titleSha256',
    'promptSha256',
    'lookBindingsSha256',
    'eligibilityRevisionSha256',
  ];
  const required = [
    ...hashFields,
    'projectId',
    'aspectRatio',
    'resolution',
    'durationSeconds',
    'renderMode',
    'providerCapability',
    'luxCredits',
    'issuedAt',
    'expiresAt',
  ];
  if (!claims || claims.version !== QUOTE_VERSION
    || claims.contractVersion !== LUXIFY_CONTRACT_VERSION
    || claims.pricingVersion !== LUXIFY_PRICING_VERSION
    || required.some(key => claims[key] === undefined)
    || hashFields.some(key => !/^[a-f0-9]{64}$/.test(claims[key] || ''))
    || !UUID.test(claims.projectId || '')
    || !LUXIFY_ASPECT_RATIOS.includes(claims.aspectRatio)
    || !LUXIFY_RESOLUTIONS.includes(claims.resolution)
    || !Number.isInteger(claims.durationSeconds)
    || claims.durationSeconds < LUXIFY_MIN_DURATION_SECONDS
    || claims.durationSeconds > LUXIFY_MAX_DURATION_SECONDS
    || claims.renderMode !== LUXIFY_RENDER_MODE
    || claims.providerCapability !== LUXIFY_PROVIDER_CAPABILITY
    || !Number.isSafeInteger(claims.luxCredits) || claims.luxCredits <= 0
    || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt - claims.issuedAt !== LUXIFY_QUOTE_TTL_MS
    || (claims.nonce === undefined && !/^[a-f0-9]{64}$/.test(claims.nonceSha256 || ''))) {
    quoteError('LUXIFY_QUOTE_INVALID', 'LUXIFY quote proof is invalid.', 400);
  }
  return Object.freeze({
    version: claims.version,
    contractVersion: claims.contractVersion,
    pricingVersion: claims.pricingVersion,
    accountSha256: claims.accountSha256,
    projectId: claims.projectId.toLowerCase(),
    idempotencyKeySha256: claims.idempotencyKeySha256,
    titleSha256: claims.titleSha256,
    promptSha256: claims.promptSha256,
    lookBindingsSha256: claims.lookBindingsSha256,
    eligibilityRevisionSha256: claims.eligibilityRevisionSha256,
    aspectRatio: claims.aspectRatio,
    resolution: claims.resolution,
    durationSeconds: claims.durationSeconds,
    renderMode: claims.renderMode,
    providerCapability: claims.providerCapability,
    luxCredits: claims.luxCredits,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    nonceSha256: claims.nonce === undefined ? claims.nonceSha256 : sha256(claims.nonce),
  });
}
