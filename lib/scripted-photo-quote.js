import crypto from 'node:crypto';

import { sessionSecret } from './video-os-account.js';
import { stableJson } from './video-os-render-authorization.js';
import { SCRIPTED_PHOTO_CONTRACT_VERSION } from './scripted-photo-contract.js';

export const SCRIPTED_PHOTO_PRICING_VERSION = 'scripted-photo-pricing-v1';
export const SCRIPTED_PHOTO_QUOTE_TTL_MS = 5 * 60 * 1000;
const QUOTE_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ScriptedPhotoQuoteError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'ScriptedPhotoQuoteError';
    this.code = code;
    this.statusCode = statusCode;
    this.failureCategory = code === 'SCRIPTED_PHOTO_QUOTE_CONFIG_MISSING' ? 'CONFIG_MISSING' : 'VALIDATION';
  }
}

function quoteError(code, message, statusCode) {
  throw new ScriptedPhotoQuoteError(code, message, statusCode);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(stableJson(value));
}

export function digestScriptedPhotoSourceBinding(sourceBinding) {
  if (!sourceBinding || typeof sourceBinding !== 'object' || Array.isArray(sourceBinding)) {
    quoteError('SCRIPTED_PHOTO_QUOTE_INVALID', 'Scripted-photo source binding is invalid.', 400);
  }
  return sha256(canonicalJson(sourceBinding));
}

function secretFor(options) {
  const secret = Object.hasOwn(options, 'secret') ? String(options.secret || '').trim() : sessionSecret();
  if (secret.length < 32) quoteError('SCRIPTED_PHOTO_QUOTE_CONFIG_MISSING', 'Scripted-photo quote signing is unavailable.', 503);
  return secret;
}

function timeFor(value) {
  const time = value instanceof Date ? value.getTime() : value === undefined ? Date.now() : Number(value);
  if (!Number.isSafeInteger(time) || time <= 0) quoteError('SCRIPTED_PHOTO_QUOTE_INVALID', 'Scripted-photo quote time is invalid.', 400);
  return time;
}

function textDigest(value, field, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    quoteError('SCRIPTED_PHOTO_QUOTE_INVALID', `Scripted-photo quote ${field} is invalid.`, 400);
  }
  return sha256(value);
}

function expectedClaims(binding) {
  if (!binding || typeof binding !== 'object'
    || typeof binding.accountId !== 'string' || !binding.accountId.trim() || binding.accountId.length > 160
    || !UUID.test(binding.projectId || '') || !UUID.test(binding.identityId || '') || !UUID.test(binding.idempotencyKey || '')
    || !['vertical', 'landscape', 'square'].includes(binding.format)
    || !['STANDARD', 'PREMIUM'].includes(binding.tier)
    || !Number.isSafeInteger(binding.credits) || binding.credits <= 0) {
    quoteError('SCRIPTED_PHOTO_QUOTE_INVALID', 'Scripted-photo quote binding is invalid.', 400);
  }
  return {
    accountSha256: sha256(binding.accountId),
    projectId: binding.projectId,
    identityId: binding.identityId,
    idempotencyKeySha256: sha256(binding.idempotencyKey),
    titleSha256: textDigest(binding.title, 'title', 120),
    scriptSha256: textDigest(binding.script, 'script', 900),
    format: binding.format,
    tier: binding.tier,
    sourceBindingSha256: digestScriptedPhotoSourceBinding(binding.sourceBinding),
    credits: binding.credits,
  };
}

function sign(encoded, secret) {
  return crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
}

export function issueScriptedPhotoQuote(binding, options = {}) {
  const secret = secretFor(options);
  const issuedAt = timeFor(options.now);
  const nonce = options.nonce === undefined ? crypto.randomBytes(18).toString('base64url') : String(options.nonce);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) quoteError('SCRIPTED_PHOTO_QUOTE_INVALID', 'Scripted-photo quote nonce is invalid.', 400);
  const expiresAt = issuedAt + SCRIPTED_PHOTO_QUOTE_TTL_MS;
  const payload = {
    version: QUOTE_VERSION,
    contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION,
    pricingVersion: SCRIPTED_PHOTO_PRICING_VERSION,
    ...expectedClaims(binding),
    issuedAt,
    expiresAt,
    nonce,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {
    token: `${encoded}.${sign(encoded, secret)}`,
    credits: payload.credits,
    expiresAt: new Date(expiresAt).toISOString(),
    pricingVersion: SCRIPTED_PHOTO_PRICING_VERSION,
  };
}

function decodeToken(token, secret) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 8192) {
    quoteError('SCRIPTED_PHOTO_QUOTE_INVALID', 'Scripted-photo quote token is invalid.', 400);
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
    quoteError('SCRIPTED_PHOTO_QUOTE_INVALID', 'Scripted-photo quote token is invalid.', 400);
  }
  const [encoded, signature] = parts;
  const expected = Buffer.from(sign(encoded, secret), 'base64url');
  const actual = Buffer.from(signature, 'base64url');
  if (Buffer.from(encoded, 'base64url').toString('base64url') !== encoded
    || actual.toString('base64url') !== signature
    || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    quoteError('SCRIPTED_PHOTO_QUOTE_INVALID', 'Scripted-photo quote token is invalid.', 400);
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch {
    quoteError('SCRIPTED_PHOTO_QUOTE_INVALID', 'Scripted-photo quote token is invalid.', 400);
  }
  return payload;
}

export function verifyScriptedPhotoQuote(token, binding, options = {}) {
  const secret = secretFor(options);
  const now = timeFor(options.now);
  const payload = decodeToken(token, secret);
  if (!payload || payload.version !== QUOTE_VERSION
    || payload.contractVersion !== SCRIPTED_PHOTO_CONTRACT_VERSION
    || payload.pricingVersion !== SCRIPTED_PHOTO_PRICING_VERSION
    || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt - payload.issuedAt !== SCRIPTED_PHOTO_QUOTE_TTL_MS
    || payload.issuedAt > now + 5_000
    || !/^[A-Za-z0-9_-]{16,128}$/.test(payload.nonce || '')) {
    quoteError('SCRIPTED_PHOTO_QUOTE_INVALID', 'Scripted-photo quote token is invalid.', 400);
  }
  if (now >= payload.expiresAt) quoteError('SCRIPTED_PHOTO_QUOTE_EXPIRED', 'Scripted-photo quote expired. Request a new quote before starting a new render.', 410);
  const expected = expectedClaims(binding);
  for (const [key, value] of Object.entries(expected)) {
    if (payload[key] !== value) quoteError('SCRIPTED_PHOTO_QUOTE_MISMATCH', 'Scripted-photo quote no longer matches the saved project.', 409);
  }
  return payload;
}

export function safeScriptedPhotoQuoteProof(claims) {
  const required = [
    'accountSha256', 'projectId', 'identityId', 'idempotencyKeySha256', 'titleSha256', 'scriptSha256',
    'format', 'tier', 'sourceBindingSha256', 'credits', 'issuedAt', 'expiresAt',
  ];
  const hashFields = ['accountSha256', 'idempotencyKeySha256', 'titleSha256', 'scriptSha256', 'sourceBindingSha256'];
  if (!claims || claims.version !== QUOTE_VERSION
    || claims.contractVersion !== SCRIPTED_PHOTO_CONTRACT_VERSION
    || claims.pricingVersion !== SCRIPTED_PHOTO_PRICING_VERSION
    || required.some(key => claims[key] === undefined)
    || hashFields.some(key => !/^[a-f0-9]{64}$/.test(claims[key] || ''))
    || !UUID.test(claims.projectId || '') || !UUID.test(claims.identityId || '')
    || !['vertical', 'landscape', 'square'].includes(claims.format)
    || !['STANDARD', 'PREMIUM'].includes(claims.tier)
    || !Number.isSafeInteger(claims.credits) || claims.credits <= 0
    || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt - claims.issuedAt !== SCRIPTED_PHOTO_QUOTE_TTL_MS
    || (claims.nonce === undefined && !/^[a-f0-9]{64}$/.test(claims.nonceSha256 || ''))) {
    quoteError('SCRIPTED_PHOTO_QUOTE_INVALID', 'Scripted-photo quote proof is invalid.', 400);
  }
  return {
    version: claims.version,
    contractVersion: claims.contractVersion,
    pricingVersion: claims.pricingVersion,
    accountSha256: claims.accountSha256,
    projectId: claims.projectId,
    identityId: claims.identityId,
    idempotencyKeySha256: claims.idempotencyKeySha256,
    titleSha256: claims.titleSha256,
    scriptSha256: claims.scriptSha256,
    format: claims.format,
    tier: claims.tier,
    sourceBindingSha256: claims.sourceBindingSha256,
    credits: claims.credits,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    nonceSha256: claims.nonce === undefined ? claims.nonceSha256 : sha256(claims.nonce),
  };
}
