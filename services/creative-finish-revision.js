// Held application contract. No route or Workflow imports this module until a
// retained-base repository and isolated finishing worker are qualified.
import { createHash } from 'node:crypto';

import {
  creativeFinishActivationStatus,
  CREATIVE_FINISH_REVISION_MODE,
  CreativeFinishContractError,
  isCreativeBasePathname,
  resolveCreativeFinishSelection,
} from '../lib/creative-finish-contract.js';
import {
  CREATIVE_FINISH_PRICING_VERSION,
  CREATIVE_FINISH_QUOTE_TTL_MS,
  CREATIVE_FINISH_QUOTE_VERSION,
  issueCreativeFinishQuote,
  verifyCreativeFinishQuote,
} from '../lib/creative-finish-quote.js';
import { stableJson } from '../lib/video-os-render-authorization.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const SOURCE_JOB_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_CREATIVE_BASE_BYTES = 100 * 1024 * 1024;
const REVISION_STATUSES = new Set(['reserved', 'workflow_starting', 'workflow_started', 'finishing', 'ready', 'failed', 'held', 'cancelled']);
const QUOTE_PROOF_KEYS = [
  'version', 'mode', 'pricingVersion', 'accountSha256', 'projectId', 'projectBindingSha256',
  'sourceJobIdSha256', 'idempotencyKeySha256', 'projectMode', 'format', 'baseSha256',
  'basePathSha256', 'selectionSha256', 'credits', 'issuedAt', 'expiresAt', 'nonce',
];
const RESERVATION_BINDING_KEYS = [
  'accountId', 'projectId', 'sourceJobId', 'idempotencyKey', 'projectBindingSha256',
  'projectMode', 'format', 'baseSha256', 'basePrivatePathname', 'baseBytes',
  'baseBlobVersion', 'baseAcceptedAt', 'baseRetentionExpiresAt', 'catalogRevision',
  'selection', 'assetBinding', 'selectionDigest', 'credits', 'quoteProof', 'mode',
];

function fail(code, message, statusCode = 409) {
  throw new CreativeFinishContractError(code, message, statusCode);
}

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const canonical = value => JSON.stringify(stableJson(value));

function requestTime(value) {
  const time = value instanceof Date ? value.getTime() : value === undefined ? Date.now() : Number(value);
  if (!Number.isSafeInteger(time) || time <= 0) {
    fail('CREATIVE_FINISH_REQUEST_INVALID', 'Creative Finish request time is invalid.', 400);
  }
  return time;
}

function boundedOpaque(value, maximum = 256) {
  return typeof value === 'string' && value === value.trim()
    && value.length >= 1 && value.length <= maximum && !CONTROL.test(value);
}

function isoTime(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

function exactRequest(value) {
  const keys = ['projectId', 'sourceJobId', 'idempotencyKey', 'selection'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some(key => !keys.includes(key))
    || !UUID.test(String(value.projectId || ''))
    || !SOURCE_JOB_ID.test(String(value.sourceJobId || ''))
    || !UUID.test(String(value.idempotencyKey || ''))) {
    fail('CREATIVE_FINISH_REQUEST_INVALID', 'Creative Finish request is invalid.', 400);
  }
  return value;
}

function projectBinding(project, accountId, projectId) {
  if (!project || project.accountId !== accountId || project.id !== projectId) {
    fail('CREATIVE_FINISH_PROJECT_UNAVAILABLE', 'Owned Creative Finish project is unavailable.', 404);
  }
  if (!SHA256.test(String(project.bindingSha256 || ''))
    || !['premium_presenter', 'luxify'].includes(project.mode)
    || !['landscape', 'vertical', 'square'].includes(project.format)
    || !['internal', 'web', 'social', 'paid_ads'].includes(project.distributionScope)) {
    fail('CREATIVE_FINISH_PROJECT_CHANGED', 'Creative Finish project binding changed.');
  }
  return project.bindingSha256.toLowerCase();
}

function retainedBase(base, accountId, projectId, sourceJobId, projectMode, now) {
  const acceptedAt = isoTime(base?.acceptedAt);
  const retentionExpiresAt = isoTime(base?.retentionExpiresAt);
  if (!base || base.accountId !== accountId || base.projectId !== projectId
    || base.sourceJobId !== sourceJobId || base.projectMode !== projectMode
    || base.captureState !== 'ready' || base.acceptance !== 'accepted'
    || base.withdrawnAt !== null || base.deletedAt !== null
    || !SHA256.test(String(base.sha256 || ''))
    || !isCreativeBasePathname(base.privatePathname)
    || !Number.isSafeInteger(base.bytes) || base.bytes < 1 || base.bytes > MAX_CREATIVE_BASE_BYTES
    || !boundedOpaque(base.blobVersion)
    || acceptedAt === null || acceptedAt > now
    || retentionExpiresAt === null || retentionExpiresAt <= now || retentionExpiresAt <= acceptedAt) {
    fail('CREATIVE_FINISH_BASE_UNAVAILABLE', 'An accepted private base video is unavailable.');
  }
  return Object.freeze({ ...base, sha256: base.sha256.toLowerCase() });
}

function quoteBinding(accountId, request, project, base, resolved) {
  return {
    accountId,
    projectId: request.projectId,
    projectBindingSha256: projectBinding(project, accountId, request.projectId),
    sourceJobId: request.sourceJobId,
    idempotencyKey: request.idempotencyKey,
    projectMode: project.mode,
    format: project.format,
    baseSha256: base.sha256,
    basePrivatePathname: base.privatePathname,
    selectionDigest: resolved.digest,
  };
}

function reservationBinding(value) {
  return Object.fromEntries(RESERVATION_BINDING_KEYS.map(key => [key, value?.[key]]));
}

function reservationDigest(value) {
  return hash(canonical(reservationBinding(value)));
}

function validQuoteProof(proof, binding) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
    || Object.keys(proof).length !== QUOTE_PROOF_KEYS.length
    || Object.keys(proof).some(key => !QUOTE_PROOF_KEYS.includes(key))
    || proof.version !== CREATIVE_FINISH_QUOTE_VERSION
    || proof.mode !== CREATIVE_FINISH_REVISION_MODE
    || proof.pricingVersion !== CREATIVE_FINISH_PRICING_VERSION
    || proof.accountSha256 !== hash(binding.accountId)
    || proof.projectId !== binding.projectId.toLowerCase()
    || proof.projectBindingSha256 !== binding.projectBindingSha256
    || proof.sourceJobIdSha256 !== hash(binding.sourceJobId)
    || proof.idempotencyKeySha256 !== hash(binding.idempotencyKey)
    || proof.projectMode !== binding.projectMode
    || proof.format !== binding.format
    || proof.baseSha256 !== binding.baseSha256
    || proof.basePathSha256 !== hash(binding.basePrivatePathname)
    || proof.selectionSha256 !== binding.selectionDigest
    || proof.credits !== binding.credits
    || !Number.isSafeInteger(proof.issuedAt) || proof.issuedAt <= 0
    || !Number.isSafeInteger(proof.expiresAt)
    || proof.expiresAt - proof.issuedAt !== CREATIVE_FINISH_QUOTE_TTL_MS
    || !/^[A-Za-z0-9_-]{16,128}$/.test(String(proof.nonce || ''))) {
    return false;
  }
  return true;
}

function persistedReservationBinding(job) {
  const binding = reservationBinding(job);
  const acceptedAt = isoTime(binding.baseAcceptedAt);
  const retentionExpiresAt = isoTime(binding.baseRetentionExpiresAt);
  if (!boundedOpaque(binding.accountId, 160)
    || !UUID.test(String(binding.projectId || ''))
    || !SOURCE_JOB_ID.test(String(binding.sourceJobId || ''))
    || !UUID.test(String(binding.idempotencyKey || ''))
    || !SHA256.test(String(binding.projectBindingSha256 || ''))
    || !['premium_presenter', 'luxify'].includes(binding.projectMode)
    || !['landscape', 'vertical', 'square'].includes(binding.format)
    || !SHA256.test(String(binding.baseSha256 || ''))
    || !isCreativeBasePathname(binding.basePrivatePathname)
    || !Number.isSafeInteger(binding.baseBytes) || binding.baseBytes < 1
    || binding.baseBytes > MAX_CREATIVE_BASE_BYTES
    || !boundedOpaque(binding.baseBlobVersion)
    || acceptedAt === null || retentionExpiresAt === null || retentionExpiresAt <= acceptedAt
    || !boundedOpaque(binding.catalogRevision, 160)
    || !binding.selection || typeof binding.selection !== 'object' || Array.isArray(binding.selection)
    || !binding.assetBinding || typeof binding.assetBinding !== 'object' || Array.isArray(binding.assetBinding)
    || !SHA256.test(String(binding.selectionDigest || ''))
    || !Number.isSafeInteger(binding.credits) || binding.credits < 1
    || binding.mode !== CREATIVE_FINISH_REVISION_MODE
    || !validQuoteProof(binding.quoteProof, binding)
    || !SHA256.test(String(job.requestDigest || ''))
    || job.requestDigest !== reservationDigest(binding)) {
    fail('CREATIVE_FINISH_REVISION_INVALID', 'Creative Finish revision state is unavailable.', 503);
  }
  return binding;
}

function revisionDto(job, accountId, projectId, idempotencyKey, expectedReservation = null) {
  if (!job || typeof job.id !== 'string' || !SOURCE_JOB_ID.test(job.id)
    || job.accountId !== accountId || job.projectId !== projectId || job.idempotencyKey !== idempotencyKey
    || job.mode !== CREATIVE_FINISH_REVISION_MODE || !REVISION_STATUSES.has(job.status)) {
    fail('CREATIVE_FINISH_REVISION_INVALID', 'Creative Finish revision state is unavailable.', 503);
  }
  const persisted = persistedReservationBinding(job);
  if (expectedReservation
    && (job.requestDigest !== expectedReservation.requestDigest
      || canonical(persisted) !== canonical(reservationBinding(expectedReservation)))) {
    fail('CREATIVE_FINISH_REVISION_INVALID', 'Creative Finish revision state is unavailable.', 503);
  }
  return Object.freeze({ id: job.id, status: job.status, projectId, mode: job.mode });
}

export function createCreativeFinishRevisionService({
  repository,
  catalogFor,
  authorizePremium,
  environment = process.env,
  quoteOptions = {},
} = {}) {
  if (!repository || ['getProject', 'getRetainedBase', 'reserveRevisionAtomic', 'findRevision'].some(key => typeof repository[key] !== 'function')
    || typeof catalogFor !== 'function' || typeof authorizePremium !== 'function') {
    throw new TypeError('Creative Finish requires repository, approved catalog and Premium authorization adapters.');
  }

  async function load(accountId, request) {
    const input = exactRequest(request);
    const now = requestTime(quoteOptions.now);
    const project = await repository.getProject({ accountId, projectId: input.projectId });
    projectBinding(project, accountId, input.projectId);
    const authorization = await authorizePremium(accountId, 'premium');
    if (!authorization || authorization.version !== 1 || authorization.accountId !== accountId
      || authorization.tier !== 'premium'
      || !['liveRendering', 'fullAccess', 'ownerAccess'].includes(authorization.entitlementKey)) {
      fail('CREATIVE_FINISH_PREMIUM_REQUIRED', 'Current Premium authorization is required.', 403);
    }
    const base = retainedBase(await repository.getRetainedBase({
      accountId, projectId: input.projectId, sourceJobId: input.sourceJobId,
    }), accountId, input.projectId, input.sourceJobId, project.mode, now);
    const catalog = await catalogFor({ accountId, projectId: input.projectId });
    const resolved = resolveCreativeFinishSelection(input.selection, {
      accountId, format: project.format, distributionScope: project.distributionScope,
      catalog, now,
    });
    if (!resolved.selection.music && !resolved.selection.graphic && !resolved.selection.color
      && resolved.selection.captions === 'none') {
      fail('CREATIVE_FINISH_NO_CHANGES', 'Select at least one Creative Finish change.', 400);
    }
    return { input, project, base, resolved, binding: quoteBinding(accountId, input, project, base, resolved) };
  }

  function requireActivation(accountId) {
    if (!creativeFinishActivationStatus(accountId, environment).enabled) {
      fail('CREATIVE_FINISH_DISABLED', 'Creative Finish is unavailable.', 503);
    }
  }

  return Object.freeze({
    async quoteRevision(accountId, request) {
      requireActivation(accountId);
      const state = await load(accountId, request);
      const quote = issueCreativeFinishQuote(state.binding, { ...quoteOptions, env: quoteOptions.env ?? environment });
      return Object.freeze({
        mode: CREATIVE_FINISH_REVISION_MODE,
        projectId: state.input.projectId,
        sourceJobId: state.input.sourceJobId,
        selectionDigest: state.resolved.digest,
        quote,
      });
    },

    async reserveRevision(accountId, request, token) {
      requireActivation(accountId);
      const state = await load(accountId, request);
      const proof = verifyCreativeFinishQuote(token, state.binding, { ...quoteOptions, env: quoteOptions.env ?? environment });
      // The adapter must recheck project binding, accepted base, approvals,
      // ownership, price and idempotency inside one transaction before debit.
      const binding = {
        accountId,
        projectId: state.input.projectId,
        sourceJobId: state.input.sourceJobId,
        idempotencyKey: state.input.idempotencyKey,
        projectBindingSha256: state.binding.projectBindingSha256,
        projectMode: state.project.mode,
        format: state.project.format,
        baseSha256: state.base.sha256,
        basePrivatePathname: state.base.privatePathname,
        baseBytes: state.base.bytes,
        baseBlobVersion: state.base.blobVersion,
        baseAcceptedAt: state.base.acceptedAt,
        baseRetentionExpiresAt: state.base.retentionExpiresAt,
        catalogRevision: state.resolved.catalogRevision,
        selection: state.resolved.selection,
        assetBinding: state.resolved.assets,
        selectionDigest: state.resolved.digest,
        credits: proof.credits,
        quoteProof: proof,
        mode: CREATIVE_FINISH_REVISION_MODE,
      };
      const reservation = Object.freeze({ ...binding, requestDigest: reservationDigest(binding) });
      const job = await repository.reserveRevisionAtomic(reservation);
      return revisionDto(job, accountId, state.input.projectId, state.input.idempotencyKey, reservation);
    },

    async recoverRevision(accountId, { projectId, idempotencyKey }) {
      if (!UUID.test(String(projectId || '')) || !UUID.test(String(idempotencyKey || ''))) {
        fail('CREATIVE_FINISH_REQUEST_INVALID', 'Creative Finish recovery request is invalid.', 400);
      }
      // Recovery reads only an already-owned request; it remains available if
      // the creation flag was closed after a prior reservation.
      const existing = await repository.findRevision({ accountId, projectId, idempotencyKey });
      if (!existing) return null;
      return revisionDto(existing, accountId, projectId, idempotencyKey);
    },
  });
}
