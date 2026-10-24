import crypto from 'node:crypto';

import { sessionSecret } from './video-os-account.js';
import { stableJson } from './video-os-render-authorization.js';
import { configuredCreativeFinishRevisionCredits, CREATIVE_FINISH_REVISION_MODE, isCreativeBasePathname } from './creative-finish-contract.js';

export const CREATIVE_FINISH_QUOTE_VERSION = 'creative-finish-quote/v1';
export const CREATIVE_FINISH_PRICING_VERSION = 'creative-finish-revision-pricing/v1';
export const CREATIVE_FINISH_QUOTE_TTL_MS = 5 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const CLAIM_KEYS = [
  'version', 'mode', 'pricingVersion', 'accountSha256', 'projectId', 'projectBindingSha256',
  'sourceJobIdSha256', 'idempotencyKeySha256', 'projectMode', 'format', 'baseSha256', 'basePathSha256', 'selectionSha256',
  'credits', 'issuedAt', 'expiresAt', 'nonce',
];

export class CreativeFinishQuoteError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'CreativeFinishQuoteError';
    this.code = code;
    this.statusCode = statusCode;
    this.failureCategory = statusCode === 503 ? 'CONFIG_MISSING' : 'VALIDATION';
  }
}

function fail(code, message, statusCode) {
  throw new CreativeFinishQuoteError(code, message, statusCode);
}

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function secretFor(options) {
  const secret = Object.hasOwn(options, 'secret') ? String(options.secret || '').trim() : sessionSecret();
  if (secret.length < 32) fail('CREATIVE_FINISH_QUOTE_CONFIG_MISSING', 'Creative Finish quote signing is unavailable.', 503);
  return secret;
}

function timeFor(value) {
  const time = value instanceof Date ? value.getTime() : value === undefined ? Date.now() : Number(value);
  if (!Number.isSafeInteger(time) || time <= 0) fail('CREATIVE_FINISH_QUOTE_INVALID', 'Creative Finish quote time is invalid.');
  return time;
}

function expectedClaims(binding, env) {
  const keys = [
    'accountId', 'projectId', 'projectBindingSha256', 'sourceJobId', 'idempotencyKey',
    'projectMode', 'format', 'baseSha256', 'basePrivatePathname', 'selectionDigest',
  ];
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || Object.keys(binding).length !== keys.length || Object.keys(binding).some(key => !keys.includes(key))
    || !SAFE_ID.test(String(binding.accountId || ''))
    || !UUID.test(String(binding.projectId || ''))
    || !SAFE_ID.test(String(binding.sourceJobId || ''))
    || !UUID.test(String(binding.idempotencyKey || ''))
    || !SHA256.test(String(binding.projectBindingSha256 || ''))
    || !['premium_presenter', 'luxify'].includes(binding.projectMode)
    || !['landscape', 'vertical', 'square'].includes(binding.format)
    || !SHA256.test(String(binding.baseSha256 || ''))
    || !SHA256.test(String(binding.selectionDigest || ''))
    || !isCreativeBasePathname(binding.basePrivatePathname)) {
    fail('CREATIVE_FINISH_QUOTE_INVALID', 'Creative Finish quote binding is invalid.');
  }
  return {
    accountSha256: hash(binding.accountId),
    projectId: binding.projectId.toLowerCase(),
    projectBindingSha256: binding.projectBindingSha256.toLowerCase(),
    sourceJobIdSha256: hash(binding.sourceJobId),
    idempotencyKeySha256: hash(binding.idempotencyKey),
    projectMode: binding.projectMode,
    format: binding.format,
    baseSha256: binding.baseSha256.toLowerCase(),
    basePathSha256: hash(binding.basePrivatePathname),
    selectionSha256: binding.selectionDigest.toLowerCase(),
    credits: configuredCreativeFinishRevisionCredits(env),
  };
}

function signature(encoded, secret) {
  return crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
}

export function issueCreativeFinishQuote(binding, options = {}) {
  const secret = secretFor(options);
  const issuedAt = timeFor(options.now);
  const nonce = options.nonce === undefined ? crypto.randomBytes(18).toString('base64url') : String(options.nonce);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) fail('CREATIVE_FINISH_QUOTE_INVALID', 'Creative Finish quote nonce is invalid.');
  const expiresAt = issuedAt + CREATIVE_FINISH_QUOTE_TTL_MS;
  const claims = {
    version: CREATIVE_FINISH_QUOTE_VERSION,
    mode: CREATIVE_FINISH_REVISION_MODE,
    pricingVersion: CREATIVE_FINISH_PRICING_VERSION,
    ...expectedClaims(binding, options.env ?? process.env),
    issuedAt,
    expiresAt,
    nonce,
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return Object.freeze({
    token: `${encoded}.${signature(encoded, secret)}`,
    credits: claims.credits,
    expiresAt: new Date(expiresAt).toISOString(),
    pricingVersion: CREATIVE_FINISH_PRICING_VERSION,
  });
}

export function verifyCreativeFinishQuote(token, binding, options = {}) {
  const secret = secretFor(options);
  const now = timeFor(options.now);
  if (typeof token !== 'string' || token.length < 40 || token.length > 8192) {
    fail('CREATIVE_FINISH_QUOTE_INVALID', 'Creative Finish quote token is invalid.');
  }
  const parts = token.split('.');
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) {
    fail('CREATIVE_FINISH_QUOTE_INVALID', 'Creative Finish quote token is invalid.');
  }
  const [encoded, signed] = parts;
  const expectedSignature = Buffer.from(signature(encoded, secret), 'base64url');
  const actualSignature = Buffer.from(signed, 'base64url');
  if (Buffer.from(encoded, 'base64url').toString('base64url') !== encoded
    || actualSignature.toString('base64url') !== signed
    || actualSignature.length !== expectedSignature.length
    || !crypto.timingSafeEqual(actualSignature, expectedSignature)) {
    fail('CREATIVE_FINISH_QUOTE_INVALID', 'Creative Finish quote token is invalid.');
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch {
    fail('CREATIVE_FINISH_QUOTE_INVALID', 'Creative Finish quote token is invalid.');
  }
  const expected = expectedClaims(binding, options.env ?? process.env);
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)
    || Object.keys(claims).length !== CLAIM_KEYS.length
    || Object.keys(claims).some(key => !CLAIM_KEYS.includes(key))
    || claims.version !== CREATIVE_FINISH_QUOTE_VERSION
    || claims.mode !== CREATIVE_FINISH_REVISION_MODE
    || claims.pricingVersion !== CREATIVE_FINISH_PRICING_VERSION
    || !/^[A-Za-z0-9_-]{16,128}$/.test(String(claims.nonce || ''))
    || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
    || claims.expiresAt - claims.issuedAt !== CREATIVE_FINISH_QUOTE_TTL_MS
    || now < claims.issuedAt - 5_000 || now >= claims.expiresAt
    || JSON.stringify(stableJson(Object.fromEntries(Object.keys(expected).map(key => [key, claims[key]]))))
      !== JSON.stringify(stableJson(expected))) {
    fail('CREATIVE_FINISH_QUOTE_INVALID', 'Creative Finish quote no longer matches the saved request.');
  }
  return Object.freeze({ ...claims });
}
