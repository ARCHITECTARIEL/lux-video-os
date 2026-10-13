import { createHash } from 'node:crypto';

import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
  canonicalizeLuxifyIntent,
  classifyLuxifyMarker,
  luxifyFormatForAspectRatio,
} from './luxify-contract.js';
import { digestLuxifyLookBindings, safeLuxifyQuoteProof } from './luxify-quote.js';
import { assertJobAuthorizationBinding, stableJson } from './video-os-render-authorization.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const ELIGIBILITY_REVISION = /^[A-Za-z0-9_.:-]{1,160}$/;
const ACCOUNT_ID = /^[^\u0000-\u001f\u007f]{1,160}$/;
const INPUT_KEYS = new Set([
  'contractVersion', 'renderMode', 'providerCapability', 'projectId', 'idempotencyKey',
  'title', 'prompt', 'lookIdentityIds', 'aspectRatio', 'resolution', 'durationSeconds',
  'lookBindings', 'eligibleLookIds', 'eligibilityRevision', 'quoteProof', 'renderAuthorization',
]);
const LOOK_BINDING_KEYS = new Set(['identityId', 'providerLookId']);
const RENDER_AUTHORIZATION_KEYS = new Set([
  'version', 'accountId', 'tier', 'entitlementKey', 'sourceType', 'sourceId', 'jobId',
]);

export class LuxifyJobBindingError extends Error {
  constructor(message = 'Persisted LUXIFY job binding is invalid.') {
    super(message);
    this.name = 'LuxifyJobBindingError';
    this.code = 'LUXIFY_JOB_BINDING_INVALID';
    this.validationCode = 'LUXIFY_JOB_BINDING_INVALID';
    this.statusCode = 422;
    this.failureCategory = 'FINAL_MEDIA_VALIDATION';
  }
}

function fail() {
  throw new LuxifyJobBindingError();
}

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');

export function hasLuxifyJobMarker(job) {
  return classifyLuxifyMarker(job?.input, { provider: job?.provider }) !== null;
}

function exactLookBindings(value, orderedIdentityIds) {
  if (!Array.isArray(value) || value.length !== orderedIdentityIds.length) fail();
  const bindings = value.map((binding, index) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || Object.keys(binding).length !== LOOK_BINDING_KEYS.size
      || Object.keys(binding).some(key => !LOOK_BINDING_KEYS.has(key))
      || !UUID.test(String(binding.identityId || ''))
      || binding.identityId.toLowerCase() !== orderedIdentityIds[index]
      || !PROVIDER_ID.test(String(binding.providerLookId || ''))) fail();
    return Object.freeze({ identityId: binding.identityId.toLowerCase(), providerLookId: binding.providerLookId });
  });
  if (new Set(bindings.map(binding => binding.identityId)).size !== bindings.length
    || new Set(bindings.map(binding => binding.providerLookId)).size !== bindings.length) fail();
  return Object.freeze(bindings);
}

export function assertPersistedLuxifyJob(job) {
  const input = job?.input;
  if (!job || typeof job !== 'object' || Array.isArray(job)
    || typeof job.id !== 'string' || !job.id.trim()
    || typeof job.accountId !== 'string' || job.accountId !== job.accountId.trim() || !ACCOUNT_ID.test(job.accountId)
    || job.provider !== 'heygen'
    || !input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== INPUT_KEYS.size
    || Object.keys(input).some(key => !INPUT_KEYS.has(key))
    || input.contractVersion !== LUXIFY_CONTRACT_VERSION
    || input.renderMode !== LUXIFY_RENDER_MODE
    || input.providerCapability !== LUXIFY_PROVIDER_CAPABILITY) fail();

  let intent;
  try {
    intent = canonicalizeLuxifyIntent({
      contractVersion: input.contractVersion,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
      title: input.title,
      prompt: input.prompt,
      lookIdentityIds: input.lookIdentityIds,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      durationSeconds: input.durationSeconds,
    });
  } catch { fail(); }

  if (job.projectId !== intent.projectId
    || job.idempotencyKey !== intent.idempotencyKey
    || job.title !== intent.title
    || job.format !== luxifyFormatForAspectRatio(intent.aspectRatio)
    || !Number.isSafeInteger(job.costCredits) || job.costCredits <= 0) fail();

  const lookBindings = exactLookBindings(input.lookBindings, intent.lookIdentityIds);
  if (!Array.isArray(input.eligibleLookIds)
    || JSON.stringify(input.eligibleLookIds) !== JSON.stringify(lookBindings.map(binding => binding.providerLookId))
    || !ELIGIBILITY_REVISION.test(String(input.eligibilityRevision || ''))) fail();

  let quoteProof;
  try { quoteProof = safeLuxifyQuoteProof(input.quoteProof); } catch { fail(); }
  if (JSON.stringify(stableJson(input.quoteProof)) !== JSON.stringify(stableJson(quoteProof))
    || quoteProof.accountSha256 !== sha256(job.accountId)
    || quoteProof.projectId !== intent.projectId
    || quoteProof.idempotencyKeySha256 !== sha256(intent.idempotencyKey)
    || quoteProof.titleSha256 !== sha256(intent.title)
    || quoteProof.promptSha256 !== sha256(intent.prompt)
    || quoteProof.lookBindingsSha256 !== digestLuxifyLookBindings(lookBindings)
    || quoteProof.eligibilityRevisionSha256 !== sha256(input.eligibilityRevision)
    || quoteProof.aspectRatio !== intent.aspectRatio
    || quoteProof.resolution !== intent.resolution
    || quoteProof.durationSeconds !== intent.durationSeconds
    || quoteProof.renderMode !== LUXIFY_RENDER_MODE
    || quoteProof.providerCapability !== LUXIFY_PROVIDER_CAPABILITY
    || quoteProof.luxCredits !== job.costCredits) fail();

  if (!input.renderAuthorization || typeof input.renderAuthorization !== 'object' || Array.isArray(input.renderAuthorization)
    || Object.keys(input.renderAuthorization).length !== RENDER_AUTHORIZATION_KEYS.size
    || Object.keys(input.renderAuthorization).some(key => !RENDER_AUTHORIZATION_KEYS.has(key))) fail();
  try { assertJobAuthorizationBinding(job, 'premium'); } catch { fail(); }

  return Object.freeze({
    intent,
    lookBindings,
    eligibilityRevision: input.eligibilityRevision,
    quoteProof,
  });
}
