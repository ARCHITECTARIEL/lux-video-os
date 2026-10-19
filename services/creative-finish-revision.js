// Held application contract. No route or Workflow imports this module until a
// retained-base repository and isolated finishing worker are qualified.
import {
  creativeFinishActivationStatus,
  CREATIVE_FINISH_REVISION_MODE,
  CreativeFinishContractError,
  isCreativeBasePathname,
  resolveCreativeFinishSelection,
} from '../lib/creative-finish-contract.js';
import { issueCreativeFinishQuote, verifyCreativeFinishQuote } from '../lib/creative-finish-quote.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const SOURCE_JOB_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const REVISION_STATUSES = new Set(['reserved', 'workflow_starting', 'workflow_started', 'finishing', 'ready', 'failed', 'held', 'cancelled']);

function fail(code, message, statusCode = 409) {
  throw new CreativeFinishContractError(code, message, statusCode);
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

function retainedBase(base, accountId, projectId, sourceJobId, projectMode) {
  if (!base || base.accountId !== accountId || base.projectId !== projectId
    || base.sourceJobId !== sourceJobId || base.projectMode !== projectMode || base.acceptance !== 'accepted'
    || base.withdrawnAt || !SHA256.test(String(base.sha256 || ''))
    || !isCreativeBasePathname(base.privatePathname)) {
    fail('CREATIVE_FINISH_BASE_UNAVAILABLE', 'An accepted private base video is unavailable.');
  }
  return base;
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

function revisionDto(job, accountId, projectId, idempotencyKey) {
  if (!job || typeof job.id !== 'string' || !SOURCE_JOB_ID.test(job.id)
    || job.accountId !== accountId || job.projectId !== projectId || job.idempotencyKey !== idempotencyKey
    || job.mode !== CREATIVE_FINISH_REVISION_MODE || !REVISION_STATUSES.has(job.status)) {
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
    }), accountId, input.projectId, input.sourceJobId, project.mode);
    const catalog = await catalogFor({ accountId, projectId: input.projectId });
    const resolved = resolveCreativeFinishSelection(input.selection, {
      accountId, format: project.format, distributionScope: project.distributionScope,
      catalog, now: quoteOptions.now instanceof Date ? quoteOptions.now.getTime() : (quoteOptions.now ?? Date.now()),
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
      const job = await repository.reserveRevisionAtomic({
        accountId,
        projectId: state.input.projectId,
        sourceJobId: state.input.sourceJobId,
        idempotencyKey: state.input.idempotencyKey,
        projectBindingSha256: state.binding.projectBindingSha256,
        projectMode: state.project.mode,
        baseSha256: state.base.sha256,
        basePrivatePathname: state.base.privatePathname,
        catalogRevision: state.resolved.catalogRevision,
        selection: state.resolved.selection,
        assetBinding: state.resolved.assets,
        selectionDigest: state.resolved.digest,
        credits: proof.credits,
        quoteProof: proof,
        mode: CREATIVE_FINISH_REVISION_MODE,
      });
      return revisionDto(job, accountId, state.input.projectId, state.input.idempotencyKey);
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
