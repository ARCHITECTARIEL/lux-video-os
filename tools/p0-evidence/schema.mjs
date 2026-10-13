import { createHash } from 'node:crypto';

export const CANDIDATE_VERSION = 'video-os-p0-evidence-candidate/v2';
export const OBSERVATION_VERSION = 'video-os-p0-observation/v2';
export const STRUCTURALLY_COMPLETE_UNAUTHENTICATED = 'STRUCTURALLY_COMPLETE_UNAUTHENTICATED';

export const OBSERVATION_CONTRACTS = Object.freeze([
  Object.freeze({ id: 1, key: 'signed_in_customer_session', sources: Object.freeze(['customer-api-primary']) }),
  Object.freeze({ id: 2, key: 'provider_submission_and_completion', sources: Object.freeze(['app-admin-api', 'provider-api']) }),
  Object.freeze({ id: 3, key: 'private_final_mp4', sources: Object.freeze(['artifact-bytes', 'private-storage-api']) }),
  Object.freeze({ id: 4, key: 'original_session_history', sources: Object.freeze(['customer-api-primary']) }),
  Object.freeze({ id: 5, key: 'fresh_context_new_session', sources: Object.freeze(['customer-api-fresh']) }),
  Object.freeze({ id: 6, key: 'fresh_session_gallery_recovery', sources: Object.freeze(['customer-api-fresh']) }),
  Object.freeze({ id: 7, key: 'authorized_download_hash', sources: Object.freeze(['customer-download-primary']) }),
  Object.freeze({ id: 8, key: 'download_and_blob_denials', sources: Object.freeze([
    'customer-download-anonymous',
    'customer-download-wrong-account',
    'private-blob-direct',
  ]) }),
  Object.freeze({ id: 9, key: 'single_submission_debit_and_final', sources: Object.freeze([
    'app-admin-api',
    'private-storage-api',
    'provider-api',
  ]) }),
]);

export const HASH_256 = /^[a-f0-9]{64}$/u;
export const ACCOUNT_HASH = /^[a-f0-9]{24}$/u;
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{5,254}$/u;
const TITLE = /^P0-PROOF-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z-[A-Za-z0-9]{6,32}$/u;
const FORBIDDEN_KEYS = new Set([
  'accountid', 'authorization', 'cookie', 'cookies', 'email', 'password',
  'privatepathname', 'providerbody', 'rawproviderbody', 'script', 'secret',
  'sessionid', 'sourceurl', 'token', 'url',
]);
const SAFE_DERIVED_KEYS = new Set(['sessionIdDigest']);
const SENSITIVE_KEY_FRAGMENTS = ['accountid', 'authorization', 'cookie', 'email', 'password', 'privatepathname', 'providerbody', 'script', 'secret', 'sessionid', 'sourceurl', 'token', 'url'];
const PROOF_KEYS = ['proofId', 'correlationId', 'jobId', 'providerJobId', 'accountHash', 'deploymentIdHash', 'sourceCommitHash', 'finalPathDigest', 'directBlobTargetDigest', 'preflightProviderJobIdsDigest', 'title', 'startedAt', 'completedAt'];
const BINDING_KEYS = ['proofId', 'correlationId', 'jobId', 'providerJobId', 'accountHash', 'deploymentIdHash', 'sourceCommitHash'];

export class P0EvidenceError extends Error {
  constructor(code, message, observation = null) {
    super(message);
    this.name = 'P0EvidenceError';
    this.code = code;
    this.observation = observation;
  }
}

export function fail(code, message, observation = null) {
  throw new P0EvidenceError(code, message, observation);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function object(value, code = 'INVALID_EVIDENCE', message = 'Evidence object is required.', observation = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message, observation);
  return value;
}

export function digest(value, label, observation = null) {
  if (!HASH_256.test(String(value || ''))) fail('INVALID_DIGEST', label, observation);
  return value;
}

export function timestamp(value, label, observation = null) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) fail('INVALID_TIMESTAMP', label, observation);
  return parsed;
}

export function integer(value, label, observation = null, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail('INVALID_COUNT', label, observation);
  return value;
}

export function equal(actual, expected, code, message, observation = null) {
  if (actual !== expected) fail(code, message, observation);
}

export function exactKeys(value, allowed, label, observation = null) {
  object(value, 'INVALID_EVIDENCE', label + ' must be an object.', observation);
  const expected = new Set(allowed);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expected.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) fail('UNKNOWN_KEY', label + ' keys do not match the contract.', observation);
  return value;
}

export function assertNoSensitiveMaterial(value, path = 'evidence') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveMaterial(item, path + '[' + index + ']'));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase();
      const normalized = lower.replace(/[^a-z0-9]/gu, '');
      if (FORBIDDEN_KEYS.has(lower)
        || (!SAFE_DERIVED_KEYS.has(key) && SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment)))) {
        fail('SENSITIVE_FIELD', path + ' contains a prohibited field.');
      }
      assertNoSensitiveMaterial(child, path + '.' + key);
    }
    return;
  }
  if (typeof value === 'string' && /^(?:APPROVED|VERIFIED)$/iu.test(value)) {
    fail('SELF_ASSERTED_STATUS', path + ' contains a self-asserted approval.');
  }
  if (typeof value === 'string'
    && (/(?:https?:\/\/|\bBearer\s+|\?|vos_(?:session|admin)=|video-os\/(?:finals|uploads|enrollment-sources)\/)/iu.test(value))) {
    fail('SENSITIVE_VALUE', path + ' contains a prohibited raw URL, path, query, or credential.');
  }
}

function assertSafeId(value, label) {
  if (!SAFE_ID.test(String(value || ''))) fail('INVALID_BINDING', label);
}

function validateProof(proof) {
  exactKeys(proof, PROOF_KEYS, 'proof');
  if (!UUID_V4.test(String(proof.proofId || ''))) fail('INVALID_BINDING', 'proofId must be a UUIDv4.');
  const identityKeys = ['correlationId', 'jobId', 'providerJobId'];
  for (const key of identityKeys) assertSafeId(proof[key], key);
  const allIdentityKeys = ['proofId', ...identityKeys];
  if (new Set(allIdentityKeys.map((key) => proof[key])).size !== allIdentityKeys.length) {
    fail('BINDING_COLLISION', 'Proof, correlation, job, and provider job IDs must be distinct.');
  }
  if (!ACCOUNT_HASH.test(String(proof.accountHash || ''))) fail('INVALID_BINDING', 'accountHash');
  for (const key of ['deploymentIdHash', 'sourceCommitHash', 'finalPathDigest', 'directBlobTargetDigest', 'preflightProviderJobIdsDigest']) {
    digest(proof[key], key);
  }
  if (!TITLE.test(String(proof.title || ''))) fail('INVALID_TITLE', 'Proof title is invalid.');
  const started = timestamp(proof.startedAt, 'startedAt');
  const completed = timestamp(proof.completedAt, 'completedAt');
  if (completed <= started) fail('INVALID_WINDOW', 'Proof window is not increasing.');
  return { started, completed };
}

function validateBinding(binding, proof, observation) {
  exactKeys(binding, BINDING_KEYS, 'observation binding', observation);
  for (const key of BINDING_KEYS) {
    equal(binding[key], proof[key], 'BINDING_MISMATCH', 'Observation binding mismatch.', observation);
  }
}

function validateProbes(probes, contract, window) {
  if (!Array.isArray(probes) || probes.length !== contract.sources.length) {
    fail('SOURCE_CLAIM_SET_MISMATCH', 'Exact claimed source set is required.', contract.id);
  }
  const actual = probes.map((probe) => probe?.source).sort();
  const expected = [...contract.sources].sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('SOURCE_CLAIM_SET_MISMATCH', 'Exact claimed source set is required.', contract.id);
  }
  for (const probe of probes) {
    exactKeys(probe, ['source', 'method', 'observedAt', 'evidenceSha256'], 'observation probe', contract.id);
    equal(probe.method, 'direct', 'CLAIM_METHOD_MISMATCH', 'Probe claim does not declare direct collection.', contract.id);
    digest(probe.evidenceSha256, 'probe evidence digest', contract.id);
    const observed = timestamp(probe.observedAt, 'probe observedAt', contract.id);
    if (observed < window.started || observed > window.completed) {
      fail('OUTSIDE_PROOF_WINDOW', 'Probe is outside the proof window.', contract.id);
    }
  }
}

export function validateEvidenceEnvelope(bundle) {
  exactKeys(bundle, ['version', 'proof', 'observations'], 'evidence bundle');
  equal(bundle.version, CANDIDATE_VERSION, 'VERSION_MISMATCH', 'Candidate version is unsupported.');
  assertNoSensitiveMaterial(bundle);
  const proof = object(bundle.proof, 'INVALID_MANIFEST', 'proof is required.');
  const window = validateProof(proof);
  if (!Array.isArray(bundle.observations) || bundle.observations.length !== OBSERVATION_CONTRACTS.length) {
    fail('OBSERVATION_SET_MISMATCH', 'Exactly nine observations are required.');
  }
  const observations = new Map();
  for (const observation of bundle.observations) {
    exactKeys(observation, ['version', 'observation', 'key', 'capturedAt', 'binding', 'probes', 'facts'], 'observation');
    if (!Number.isInteger(observation.observation) || observations.has(observation.observation)) {
      fail('OBSERVATION_SET_MISMATCH', 'Observation IDs must be unique integers 1 through 9.');
    }
    observations.set(observation.observation, observation);
  }
  for (const contract of OBSERVATION_CONTRACTS) {
    const observation = observations.get(contract.id);
    if (!observation) fail('OBSERVATION_SET_MISMATCH', 'Observation is missing.', contract.id);
    equal(observation.version, OBSERVATION_VERSION, 'VERSION_MISMATCH', 'Observation version is unsupported.', contract.id);
    equal(observation.key, contract.key, 'OBSERVATION_KEY_MISMATCH', 'Observation key is incorrect.', contract.id);
    validateBinding(observation.binding, proof, contract.id);
    const captured = timestamp(observation.capturedAt, 'capturedAt', contract.id);
    if (captured < window.started || captured > window.completed) {
      fail('OUTSIDE_PROOF_WINDOW', 'Observation is outside the proof window.', contract.id);
    }
    validateProbes(observation.probes, contract, window);
  }
  return { proof, window, observations };
}
