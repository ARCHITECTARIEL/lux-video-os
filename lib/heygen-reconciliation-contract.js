import {
  createHash,
  createPublicKey,
  KeyObject,
  verify as verifySignature,
} from 'node:crypto';

export const HEYGEN_RECONCILIATION_SNAPSHOT_VERSION = 'heygen-reconciliation-snapshot/v1';
export const HEYGEN_RECONCILIATION_PLAN_VERSION = 'heygen-reconciliation-plan/v1';
export const HEYGEN_RECONCILIATION_APPROVAL_VERSION = 'heygen-reconciliation-approval/v1';
export const HEYGEN_RECONCILIATION_ENVELOPE_VERSION = 'heygen-reconciliation-approval-envelope/v1';

export const HEYGEN_RECONCILIATION_RESOURCE_KINDS = Object.freeze([
  'asset',
  'avatar_look',
  'avatar_group',
  'voice',
  'video',
]);

export const HEYGEN_RECONCILIATION_OPERATION_KINDS = Object.freeze([
  'asset_upload',
  'avatar_create',
  'voice_clone',
  'video_create',
  'resource_read',
  'resource_delete',
  'url_probe',
]);

export const HEYGEN_RECONCILIATION_OPERATION_STATES = Object.freeze([
  'reserved',
  'pending',
  'succeeded',
  'failed',
  'ambiguous',
]);

export const HEYGEN_RECONCILIATION_VERBS = Object.freeze(['read', 'delete', 'readback']);

const RESOURCE_KINDS = new Set(HEYGEN_RECONCILIATION_RESOURCE_KINDS);
const OPERATION_KINDS = new Set(HEYGEN_RECONCILIATION_OPERATION_KINDS);
const OPERATION_STATES = new Set(HEYGEN_RECONCILIATION_OPERATION_STATES);
const VERBS = new Set(HEYGEN_RECONCILIATION_VERBS);
const RESOURCE_STATES = new Set([
  'unknown',
  'processing',
  'present',
  'ready',
  'failed',
  'delete_claimed',
  'delete_acknowledged',
  'api_absent',
  'pending_reconciliation',
]);
const REFERENCE_STATES = new Set(['active', 'pending', 'ambiguous', 'released']);
const PROVIDER_BINDING_STATES = new Set(['provisional', 'verified', 'conflict', 'revoked']);
const MEMBERSHIP_STATES = new Set(['complete', 'incomplete', 'unknown']);
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_APPROVAL_BYTES = 64 * 1024;
const MAX_APPROVAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const VERIFIED_APPROVALS = new WeakSet();
const PLAN_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_RECONCILIATION_PLAN\0V1\0', 'utf8');
export const HEYGEN_RECONCILIATION_SIGNING_DOMAIN = 'LUX_VIDEO_OS\0HEYGEN_RECONCILIATION_APPROVAL\0V1\0';
const APPROVAL_DOMAIN = Buffer.from(HEYGEN_RECONCILIATION_SIGNING_DOMAIN, 'utf8');

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const ORIGIN_OPERATION_BY_KIND = Object.freeze({
  asset: 'asset_upload',
  avatar_look: 'avatar_create',
  avatar_group: 'avatar_create',
  voice: 'voice_clone',
  video: 'video_create',
});

function fail(code, message, statusCode = 400) {
  throw Object.assign(new Error(message), { code, failureCategory: code, statusCode });
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value, label) {
  if (!isRecord(value)) fail('INVALID_CONTRACT', `${label} must be an object.`);
  return value;
}

function onlyKeys(value, allowed, required, label) {
  record(value, label);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('UNKNOWN_CONTRACT_FIELD', `${label}.${key} is not supported.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('MISSING_CONTRACT_FIELD', `${label}.${key} is required.`);
  }
}

function text(value, label, { nullable = false, max = 255, pattern = SAFE_IDENTIFIER } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max || (pattern && !pattern.test(value))) {
    fail('INVALID_CONTRACT', `${label} is invalid.`);
  }
  return value;
}

function sha256(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !SHA256.test(value)) fail('INVALID_CONTRACT', `${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string') fail('INVALID_CONTRACT', `${label} must be a canonical timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail('INVALID_CONTRACT', `${label} must be a canonical timestamp.`);
  return value;
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_CONTRACT', `${label} must be a safe integer between ${min} and ${max}.`);
  return value;
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function canonicalize(value, stack = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) fail('NON_CANONICAL_JSON', 'Canonical JSON cannot contain lone surrogate code points.');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail('NON_CANONICAL_JSON', 'Canonical JSON supports safe integers only.');
    return String(value);
  }
  if (typeof value !== 'object') fail('NON_CANONICAL_JSON', 'Canonical JSON contains an unsupported value.');
  if (stack.has(value)) fail('NON_CANONICAL_JSON', 'Canonical JSON cannot contain cycles.');
  stack.add(value);
  let encoded;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail('NON_CANONICAL_JSON', 'Canonical JSON cannot contain sparse arrays.');
    }
    encoded = `[${value.map((item) => canonicalize(item, stack)).join(',')}]`;
  } else {
    record(value, 'canonical value');
    const keys = Object.keys(value).sort();
    encoded = `{${keys.map((key) => {
      if (hasLoneSurrogate(key)) fail('NON_CANONICAL_JSON', 'Canonical JSON keys cannot contain lone surrogate code points.');
      return `${JSON.stringify(key)}:${canonicalize(value[key], stack)}`;
    }).join(',')}}`;
  }
  stack.delete(value);
  return encoded;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}

function strictJsonParse(input, label) {
  const source = typeof input === 'string'
    ? input
    : Buffer.isBuffer(input) || input instanceof Uint8Array
      ? Buffer.from(input).toString('utf8')
      : fail('INVALID_APPROVAL_ENVELOPE', `${label} must be raw UTF-8 JSON bytes.`);
  if (Buffer.byteLength(source, 'utf8') > MAX_APPROVAL_BYTES) fail('INVALID_APPROVAL_ENVELOPE', `${label} is too large.`);
  let cursor = 0;
  let depth = 0;

  function whitespace() {
    while (cursor < source.length && /[\u0009\u000a\u000d\u0020]/.test(source[cursor])) cursor += 1;
  }

  function stringValue() {
    if (source[cursor] !== '"') fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`);
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      const code = source.charCodeAt(cursor);
      if (code === 0x22) {
        cursor += 1;
        let parsed;
        try { parsed = JSON.parse(source.slice(start, cursor)); } catch { fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`); }
        if (hasLoneSurrogate(parsed)) fail('NON_CANONICAL_JSON', `${label} contains invalid Unicode.`);
        return parsed;
      }
      if (code === 0x5c) {
        cursor += 1;
        if (cursor >= source.length) fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`);
        if (source[cursor] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(cursor + 1, cursor + 5))) fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`);
          cursor += 5;
        } else {
          if (!'"\\/bfnrt'.includes(source[cursor])) fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`);
          cursor += 1;
        }
      } else {
        if (code < 0x20) fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`);
        cursor += 1;
      }
    }
    fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`);
  }

  function numberValue() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(cursor));
    if (!match) fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`);
    cursor += match[0].length;
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail('NON_CANONICAL_JSON', `${label} contains a non-canonical number.`);
    return value;
  }

  function value() {
    whitespace();
    depth += 1;
    if (depth > 64) fail('INVALID_APPROVAL_ENVELOPE', `${label} is too deeply nested.`);
    let parsed;
    const char = source[cursor];
    if (char === '"') parsed = stringValue();
    else if (char === '{') parsed = objectValue();
    else if (char === '[') parsed = arrayValue();
    else if (source.startsWith('true', cursor)) { cursor += 4; parsed = true; }
    else if (source.startsWith('false', cursor)) { cursor += 5; parsed = false; }
    else if (source.startsWith('null', cursor)) { cursor += 4; parsed = null; }
    else parsed = numberValue();
    depth -= 1;
    return parsed;
  }

  function objectValue() {
    cursor += 1;
    whitespace();
    const parsed = Object.create(null);
    const keys = new Set();
    if (source[cursor] === '}') { cursor += 1; return parsed; }
    while (cursor < source.length) {
      whitespace();
      const key = stringValue();
      if (keys.has(key)) fail('DUPLICATE_JSON_FIELD', `${label} contains duplicate field ${key}.`);
      keys.add(key);
      whitespace();
      if (source[cursor] !== ':') fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`);
      cursor += 1;
      parsed[key] = value();
      whitespace();
      if (source[cursor] === '}') { cursor += 1; return parsed; }
      if (source[cursor] !== ',') fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`);
      cursor += 1;
    }
    fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`);
  }

  function arrayValue() {
    cursor += 1;
    whitespace();
    const parsed = [];
    if (source[cursor] === ']') { cursor += 1; return parsed; }
    while (cursor < source.length) {
      parsed.push(value());
      whitespace();
      if (source[cursor] === ']') { cursor += 1; return parsed; }
      if (source[cursor] !== ',') fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`);
      cursor += 1;
    }
    fail('INVALID_APPROVAL_ENVELOPE', `${label} contains invalid JSON.`);
  }

  const parsed = value();
  whitespace();
  if (cursor !== source.length) fail('INVALID_APPROVAL_ENVELOPE', `${label} contains trailing data.`);
  return parsed;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freeze(item);
  return Object.freeze(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function normalizedStringArray(value, label, allowed = null) {
  if (!Array.isArray(value)) fail('INVALID_CONTRACT', `${label} must be an array.`);
  const seen = new Set();
  return value.map((item, index) => {
    const normalized = text(item, `${label}[${index}]`);
    if (allowed && !allowed.has(normalized)) fail('INVALID_CONTRACT', `${label}[${index}] is unsupported.`);
    if (seen.has(normalized)) fail('DUPLICATE_CONTRACT_VALUE', `${label} contains duplicate value ${normalized}.`);
    seen.add(normalized);
    return normalized;
  }).sort(compareText);
}

function normalizeCandidate(candidate) {
  onlyKeys(candidate, ['candidateId', 'sourceSha256', 'adapterSha256'], ['candidateId', 'sourceSha256', 'adapterSha256'], 'snapshot.candidate');
  const sourceSha256 = sha256(candidate.sourceSha256, 'snapshot.candidate.sourceSha256');
  const candidateId = text(candidate.candidateId, 'snapshot.candidate.candidateId');
  if (candidateId !== `source:${sourceSha256}`) fail('INVALID_CANDIDATE_BINDING', 'snapshot.candidate.candidateId must be derived from the source digest.');
  return { candidateId, sourceSha256, adapterSha256: sha256(candidate.adapterSha256, 'snapshot.candidate.adapterSha256') };
}

function normalizeTarget(target) {
  onlyKeys(
    target,
    ['environment', 'projectId', 'applicationAccountId', 'databaseBindingSha256', 'provider', 'providerAccountFingerprint', 'providerAccountBindingState', 'credentialScopeFingerprint', 'apiVersion'],
    ['environment', 'projectId', 'applicationAccountId', 'databaseBindingSha256', 'provider', 'providerAccountFingerprint', 'providerAccountBindingState', 'credentialScopeFingerprint', 'apiVersion'],
    'snapshot.target',
  );
  if (target.provider !== 'heygen' || target.apiVersion !== 'v3') fail('INVALID_PROVIDER_TARGET', 'Only the HeyGen v3 target is supported.');
  if (!PROVIDER_BINDING_STATES.has(target.providerAccountBindingState)) fail('INVALID_PROVIDER_TARGET', 'snapshot.target.providerAccountBindingState is invalid.');
  return {
    environment: text(target.environment, 'snapshot.target.environment'),
    projectId: text(target.projectId, 'snapshot.target.projectId'),
    applicationAccountId: text(target.applicationAccountId, 'snapshot.target.applicationAccountId'),
    databaseBindingSha256: sha256(target.databaseBindingSha256, 'snapshot.target.databaseBindingSha256'),
    provider: 'heygen',
    providerAccountFingerprint: text(target.providerAccountFingerprint, 'snapshot.target.providerAccountFingerprint', { nullable: true }),
    providerAccountBindingState: target.providerAccountBindingState,
    credentialScopeFingerprint: sha256(target.credentialScopeFingerprint, 'snapshot.target.credentialScopeFingerprint', { nullable: true }),
    apiVersion: 'v3',
  };
}

function normalizeMembership(value, label) {
  if (value === undefined || value === null) return null;
  onlyKeys(value, ['state', 'memberResourceKeys'], ['state', 'memberResourceKeys'], label);
  if (!MEMBERSHIP_STATES.has(value.state)) fail('INVALID_CONTRACT', `${label}.state is invalid.`);
  return { state: value.state, memberResourceKeys: normalizedStringArray(value.memberResourceKeys, `${label}.memberResourceKeys`) };
}

function normalizeResource(value, index) {
  const label = `snapshot.resources[${index}]`;
  onlyKeys(
    value,
    ['resourceKey', 'accountId', 'kind', 'providerResourceId', 'originOperationId', 'state', 'sourceSha256', 'sourceBytes', 'voiceNamespace', 'dependencies', 'parentResourceKey', 'membership'],
    ['resourceKey', 'accountId', 'kind', 'providerResourceId', 'originOperationId', 'state'],
    label,
  );
  if (!RESOURCE_KINDS.has(value.kind)) fail('INVALID_RESOURCE_KIND', `${label}.kind is unsupported.`);
  if (!RESOURCE_STATES.has(value.state)) fail('INVALID_CONTRACT', `${label}.state is invalid.`);
  const voiceNamespace = value.voiceNamespace === undefined || value.voiceNamespace === null
    ? null
    : text(value.voiceNamespace, `${label}.voiceNamespace`);
  if (value.kind !== 'voice' && voiceNamespace !== null) fail('INVALID_CONTRACT', `${label}.voiceNamespace is only valid for voices.`);
  const membership = normalizeMembership(value.membership, `${label}.membership`);
  if (value.kind !== 'avatar_group' && membership !== null) fail('INVALID_CONTRACT', `${label}.membership is only valid for avatar groups.`);
  const hasSourceSha256 = value.sourceSha256 !== undefined && value.sourceSha256 !== null;
  const hasSourceBytes = value.sourceBytes !== undefined && value.sourceBytes !== null;
  if (hasSourceSha256 !== hasSourceBytes) fail('INVALID_RESOURCE_SOURCE_BINDING', `${label} source SHA-256 and byte count must both be present or both be null.`);
  return {
    resourceKey: text(value.resourceKey, `${label}.resourceKey`),
    accountId: text(value.accountId, `${label}.accountId`),
    kind: value.kind,
    providerResourceId: text(value.providerResourceId, `${label}.providerResourceId`),
    originOperationId: text(value.originOperationId, `${label}.originOperationId`),
    state: value.state,
    sourceSha256: hasSourceSha256 ? sha256(value.sourceSha256, `${label}.sourceSha256`) : null,
    sourceBytes: hasSourceBytes ? safeInteger(value.sourceBytes, `${label}.sourceBytes`, { min: 1 }) : null,
    voiceNamespace,
    dependencies: normalizedStringArray(value.dependencies === undefined ? [] : value.dependencies, `${label}.dependencies`),
    parentResourceKey: value.parentResourceKey == null ? null : text(value.parentResourceKey, `${label}.parentResourceKey`),
    membership,
  };
}

function normalizeReference(value, index) {
  const label = `snapshot.references[${index}]`;
  onlyKeys(value, ['referenceId', 'accountId', 'resourceKey', 'consumerKind', 'consumerId', 'state'], ['referenceId', 'accountId', 'resourceKey', 'consumerKind', 'consumerId', 'state'], label);
  if (!REFERENCE_STATES.has(value.state)) fail('INVALID_CONTRACT', `${label}.state is invalid.`);
  return {
    referenceId: text(value.referenceId, `${label}.referenceId`),
    accountId: text(value.accountId, `${label}.accountId`),
    resourceKey: text(value.resourceKey, `${label}.resourceKey`),
    consumerKind: text(value.consumerKind, `${label}.consumerKind`),
    consumerId: text(value.consumerId, `${label}.consumerId`),
    state: value.state,
  };
}

function normalizeOperation(value, index) {
  const label = `snapshot.operations[${index}]`;
  onlyKeys(value, ['operationId', 'accountId', 'kind', 'state', 'resourceKeys'], ['operationId', 'accountId', 'kind', 'state', 'resourceKeys'], label);
  if (!OPERATION_KINDS.has(value.kind)) fail('INVALID_OPERATION_KIND', `${label}.kind is unsupported.`);
  if (!OPERATION_STATES.has(value.state)) fail('INVALID_CONTRACT', `${label}.state is invalid.`);
  return {
    operationId: text(value.operationId, `${label}.operationId`),
    accountId: text(value.accountId, `${label}.accountId`),
    kind: value.kind,
    state: value.state,
    resourceKeys: normalizedStringArray(value.resourceKeys, `${label}.resourceKeys`),
  };
}

function uniqueBy(items, selector, label) {
  const seen = new Set();
  for (const item of items) {
    const key = selector(item);
    if (seen.has(key)) fail('DUPLICATE_CONTRACT_VALUE', `${label} contains duplicate ${key}.`);
    seen.add(key);
  }
}

function normalizeSnapshot(snapshot) {
  onlyKeys(snapshot, ['version', 'capturedAt', 'candidate', 'target', 'resources', 'references', 'operations'], ['version', 'capturedAt', 'candidate', 'target', 'resources', 'references', 'operations'], 'snapshot');
  if (snapshot.version !== HEYGEN_RECONCILIATION_SNAPSHOT_VERSION) fail('UNSUPPORTED_SNAPSHOT_VERSION', 'The reconciliation snapshot version is unsupported.');
  if (!Array.isArray(snapshot.resources) || !Array.isArray(snapshot.references) || !Array.isArray(snapshot.operations)) fail('INVALID_CONTRACT', 'Snapshot collections must be arrays.');
  const normalized = {
    version: snapshot.version,
    capturedAt: timestamp(snapshot.capturedAt, 'snapshot.capturedAt'),
    candidate: normalizeCandidate(snapshot.candidate),
    target: normalizeTarget(snapshot.target),
    resources: snapshot.resources.map(normalizeResource),
    references: snapshot.references.map(normalizeReference),
    operations: snapshot.operations.map(normalizeOperation),
  };
  uniqueBy(normalized.resources, (item) => item.resourceKey, 'snapshot.resources');
  uniqueBy(normalized.resources, (item) => `${item.kind}:${item.providerResourceId}`, 'snapshot.resources');
  uniqueBy(normalized.references, (item) => item.referenceId, 'snapshot.references');
  uniqueBy(normalized.operations, (item) => item.operationId, 'snapshot.operations');
  return normalized;
}

function blockerFactory() {
  const blockers = new Map();
  return {
    add(code, context = {}) {
      const blocker = { code, ...context };
      blockers.set(canonicalize(blocker), blocker);
    },
    values() {
      return [...blockers.entries()].sort(([left], [right]) => compareText(left, right)).map(([, value]) => value);
    },
  };
}

function normalizeRequestedActions(value) {
  if (!Array.isArray(value) || value.length === 0) fail('INVALID_PLAN_REQUEST', 'options.requestedActions must contain at least one resource selection.');
  const actions = value.map((item, index) => {
    const label = `options.requestedActions[${index}]`;
    onlyKeys(item, ['resourceKey', 'verbs'], ['resourceKey', 'verbs'], label);
    const verbs = normalizedStringArray(item.verbs, `${label}.verbs`, VERBS);
    if (verbs.length === 0) fail('INVALID_PLAN_REQUEST', `${label}.verbs cannot be empty.`);
    return { resourceKey: text(item.resourceKey, `${label}.resourceKey`), verbs };
  });
  uniqueBy(actions, (item) => item.resourceKey, 'options.requestedActions');
  return actions.sort((left, right) => compareText(left.resourceKey, right.resourceKey));
}

function planDigest(planBody) {
  return createHash('sha256').update(PLAN_DOMAIN).update(canonicalJsonBytes(planBody)).digest('hex');
}

function addTargetBlockers(target, blockers) {
  if (target.providerAccountBindingState !== 'verified') {
    blockers.add('PROVIDER_ACCOUNT_BINDING_NOT_VERIFIED', { bindingState: target.providerAccountBindingState });
  }
  if (!target.providerAccountFingerprint) blockers.add('MISSING_PROVIDER_ACCOUNT_BINDING');
  if (!target.credentialScopeFingerprint) blockers.add('MISSING_CREDENTIAL_SCOPE_BINDING');
}

function addSnapshotBlockers(snapshot, blockers) {
  const resources = new Map(snapshot.resources.map((item) => [item.resourceKey, item]));
  const resourceKeys = new Set(resources.keys());
  for (const resource of snapshot.resources) {
    if (resource.accountId !== snapshot.target.applicationAccountId) blockers.add('CROSS_ACCOUNT_RESOURCE', { resourceKey: resource.resourceKey });
    if (resource.kind !== 'video' && resource.sourceSha256 === null) blockers.add('MISSING_RESOURCE_SOURCE_BINDING', { resourceKey: resource.resourceKey });
    for (const dependency of resource.dependencies) {
      if (!resourceKeys.has(dependency)) blockers.add('MISSING_DEPENDENCY_RESOURCE', { resourceKey: resource.resourceKey, dependencyResourceKey: dependency });
    }
    if (resource.parentResourceKey && !resourceKeys.has(resource.parentResourceKey)) blockers.add('MISSING_PARENT_RESOURCE', { resourceKey: resource.resourceKey, parentResourceKey: resource.parentResourceKey });
    if (resource.kind === 'avatar_group' && resource.membership) {
      for (const memberResourceKey of resource.membership.memberResourceKeys) {
        const member = resources.get(memberResourceKey);
        if (!member) blockers.add('AVATAR_GROUP_MEMBER_UNKNOWN', { resourceKey: resource.resourceKey, memberResourceKey });
        else if (member.kind !== 'avatar_look' || member.accountId !== resource.accountId || member.parentResourceKey !== resource.resourceKey) {
          blockers.add('AVATAR_GROUP_MEMBER_GRAPH_INVALID', { resourceKey: resource.resourceKey, memberResourceKey });
        }
      }
      if (resource.membership.state === 'complete') {
        for (const look of snapshot.resources.filter((item) => item.kind === 'avatar_look' && item.parentResourceKey === resource.resourceKey)) {
          if (!resource.membership.memberResourceKeys.includes(look.resourceKey)) blockers.add('AVATAR_GROUP_MEMBERSHIP_OMITS_LOOK', { resourceKey: resource.resourceKey, memberResourceKey: look.resourceKey });
        }
      }
    }
  }
  for (const reference of snapshot.references) {
    if (!resourceKeys.has(reference.resourceKey)) blockers.add('REFERENCE_TO_UNKNOWN_RESOURCE', { referenceId: reference.referenceId, resourceKey: reference.resourceKey });
    if (reference.accountId !== snapshot.target.applicationAccountId) blockers.add('CROSS_ACCOUNT_REFERENCE', { referenceId: reference.referenceId, resourceKey: reference.resourceKey });
  }
  for (const operation of snapshot.operations) {
    if (operation.accountId !== snapshot.target.applicationAccountId) blockers.add('CROSS_ACCOUNT_OPERATION', { operationId: operation.operationId });
    for (const resourceKey of operation.resourceKeys) {
      if (!resourceKeys.has(resourceKey)) blockers.add('OPERATION_TO_UNKNOWN_RESOURCE', { operationId: operation.operationId, resourceKey });
    }
    if (['reserved', 'pending', 'ambiguous'].includes(operation.state) && operation.resourceKeys.length === 0) blockers.add('UNRESOLVED_OPERATION_WITHOUT_RESOURCE', { operationId: operation.operationId });
  }
}

function addResourceBlockers(resource, action, indexes, blockers) {
  const { resources, references, operations, selected } = indexes;
  const operation = operations.get(resource.originOperationId);
  if (!operation) blockers.add('MISSING_ORIGIN_OPERATION', { resourceKey: resource.resourceKey, operationId: resource.originOperationId });
  else {
    if (operation.kind !== ORIGIN_OPERATION_BY_KIND[resource.kind]) blockers.add('ORIGIN_OPERATION_KIND_MISMATCH', { resourceKey: resource.resourceKey, operationId: operation.operationId });
    if (operation.state !== 'succeeded') blockers.add('ORIGIN_OPERATION_NOT_SETTLED', { resourceKey: resource.resourceKey, operationId: operation.operationId, operationState: operation.state });
    if (!operation.resourceKeys.includes(resource.resourceKey)) blockers.add('ORIGIN_OPERATION_RESOURCE_MISMATCH', { resourceKey: resource.resourceKey, operationId: operation.operationId });
  }

  if (resource.kind === 'voice' && resource.voiceNamespace !== 'instant') blockers.add('UNSUPPORTED_PROFESSIONAL_VOICE', { resourceKey: resource.resourceKey });

  if (action.verbs.includes('delete')) {
    if (!action.verbs.includes('read') || !action.verbs.includes('readback')) blockers.add('DELETE_REQUIRES_READ_AND_READBACK', { resourceKey: resource.resourceKey });
    if (['unknown', 'processing', 'delete_claimed', 'delete_acknowledged', 'api_absent', 'pending_reconciliation'].includes(resource.state)) blockers.add('RESOURCE_STATE_UNSAFE_FOR_DELETE', { resourceKey: resource.resourceKey, resourceState: resource.state });
    for (const reference of references.get(resource.resourceKey) || []) {
      if (reference.state !== 'released') blockers.add('ACTIVE_CONSUMER_REFERENCE', { resourceKey: resource.resourceKey, referenceId: reference.referenceId, referenceState: reference.state });
    }
    for (const dependencyKey of resource.dependencies) {
      const dependency = resources.get(dependencyKey);
      if (!dependency || dependency.accountId !== resource.accountId || dependency.state !== 'ready') blockers.add('DEPENDENCY_NOT_READY', { resourceKey: resource.resourceKey, dependencyResourceKey: dependencyKey });
    }
    if (resource.kind === 'avatar_group') {
      if (resource.membership?.state !== 'complete') blockers.add('AVATAR_GROUP_MEMBERSHIP_NOT_COMPLETE', { resourceKey: resource.resourceKey });
      for (const memberKey of resource.membership?.memberResourceKeys || []) {
        const memberAction = selected.get(memberKey);
        if (!memberAction || !['read', 'delete', 'readback'].every((verb) => memberAction.verbs.includes(verb))) {
          blockers.add('AVATAR_GROUP_MEMBER_DELETE_SCOPE_INCOMPLETE', { resourceKey: resource.resourceKey, memberResourceKey: memberKey });
        }
      }
    }
    if (resource.kind === 'avatar_look') {
      const parent = resource.parentResourceKey ? resources.get(resource.parentResourceKey) : null;
      const parentAction = resource.parentResourceKey ? selected.get(resource.parentResourceKey) : null;
      if (!parent || parent.kind !== 'avatar_group') blockers.add('AVATAR_LOOK_PARENT_UNKNOWN', { resourceKey: resource.resourceKey });
      else if (parent.membership?.state !== 'complete' || !parent.membership.memberResourceKeys.includes(resource.resourceKey)) blockers.add('AVATAR_LOOK_PARENT_MEMBERSHIP_NOT_COMPLETE', { resourceKey: resource.resourceKey, parentResourceKey: parent.resourceKey });
      if (!parentAction || !parentAction.verbs.includes('readback')) blockers.add('AVATAR_LOOK_PARENT_READBACK_OUTSIDE_SCOPE', { resourceKey: resource.resourceKey, parentResourceKey: resource.parentResourceKey });
      if (parent?.membership?.state === 'complete' && parent.membership.memberResourceKeys.length === 1
        && (!parentAction || !['read', 'delete', 'readback'].every((verb) => parentAction.verbs.includes(verb)))) {
        blockers.add('AVATAR_LOOK_LAST_MEMBER_CASCADE_SCOPE_INCOMPLETE', { resourceKey: resource.resourceKey, parentResourceKey: resource.parentResourceKey });
      }
    }
  }
}

export function createReconciliationPlan(snapshotInput, optionsInput) {
  const snapshot = normalizeSnapshot(snapshotInput);
  onlyKeys(optionsInput, ['requestedActions', 'createdAt', 'expiresAt', 'cohortId'], ['requestedActions', 'expiresAt', 'cohortId'], 'options');
  const createdAt = timestamp(optionsInput.createdAt || snapshot.capturedAt, 'options.createdAt');
  const expiresAt = timestamp(optionsInput.expiresAt, 'options.expiresAt');
  const createdMs = new Date(createdAt).getTime();
  const expiresMs = new Date(expiresAt).getTime();
  if (expiresMs <= createdMs || expiresMs - createdMs > MAX_APPROVAL_LIFETIME_MS) fail('INVALID_PLAN_EXPIRY', 'Plan expiry must be after creation and no more than seven days later.');
  const actions = normalizeRequestedActions(optionsInput.requestedActions);
  const resources = new Map(snapshot.resources.map((item) => [item.resourceKey, item]));
  const operations = new Map(snapshot.operations.map((item) => [item.operationId, item]));
  const references = new Map();
  for (const item of snapshot.references) references.set(item.resourceKey, [...(references.get(item.resourceKey) || []), item]);
  const selected = new Map(actions.map((item) => [item.resourceKey, item]));
  const blockers = blockerFactory();
  addTargetBlockers(snapshot.target, blockers);
  addSnapshotBlockers(snapshot, blockers);

  const plannedResources = actions.map((action) => {
    const resource = resources.get(action.resourceKey);
    if (!resource) fail('UNKNOWN_RESOURCE_KEY', `Requested resource ${action.resourceKey} was not present in the repository snapshot.`);
    addResourceBlockers(resource, action, { resources, references, operations, selected }, blockers);
    return {
      resourceKey: resource.resourceKey,
      kind: resource.kind,
      providerResourceId: resource.providerResourceId,
      originOperationId: resource.originOperationId,
      sourceSha256: resource.sourceSha256,
      sourceBytes: resource.sourceBytes,
      verbs: action.verbs,
    };
  });

  const body = {
    version: HEYGEN_RECONCILIATION_PLAN_VERSION,
    createdAt,
    expiresAt,
    candidate: snapshot.candidate,
    target: snapshot.target,
    cohortId: text(optionsInput.cohortId, 'options.cohortId'),
    resources: plannedResources,
    blockers: blockers.values(),
  };
  return freeze({ ...body, digest: planDigest(body) });
}

function assertPlanIntegrity(plan) {
  onlyKeys(plan, ['version', 'createdAt', 'expiresAt', 'candidate', 'target', 'cohortId', 'resources', 'blockers', 'digest'], ['version', 'createdAt', 'expiresAt', 'candidate', 'target', 'cohortId', 'resources', 'blockers', 'digest'], 'plan');
  if (plan.version !== HEYGEN_RECONCILIATION_PLAN_VERSION) fail('UNSUPPORTED_PLAN_VERSION', 'The reconciliation plan version is unsupported.');
  const { digest, ...body } = clone(plan);
  if (sha256(digest, 'plan.digest') !== planDigest(body)) fail('PLAN_DIGEST_MISMATCH', 'The reconciliation plan digest does not match its canonical body.');
  return body;
}

function redactionDigest(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

export function redactPlan(plan) {
  const body = assertPlanIntegrity(plan);
  return freeze({
    version: body.version,
    digest: plan.digest,
    createdAt: body.createdAt,
    expiresAt: body.expiresAt,
    candidate: {
      candidateIdDigest: redactionDigest(body.candidate.candidateId),
      sourceDigest: redactionDigest(body.candidate.sourceSha256),
      adapterDigest: redactionDigest(body.candidate.adapterSha256),
    },
    target: {
      environment: body.target.environment,
      provider: body.target.provider,
      apiVersion: body.target.apiVersion,
      providerAccountBindingState: body.target.providerAccountBindingState,
      projectIdDigest: redactionDigest(body.target.projectId),
      applicationAccountDigest: redactionDigest(body.target.applicationAccountId),
      databaseBindingDigest: redactionDigest(body.target.databaseBindingSha256),
      providerAccountDigest: body.target.providerAccountFingerprint ? redactionDigest(body.target.providerAccountFingerprint) : null,
      credentialScopeDigest: body.target.credentialScopeFingerprint ? redactionDigest(body.target.credentialScopeFingerprint) : null,
    },
    cohortDigest: redactionDigest(body.cohortId),
    resources: body.resources.map((resource) => ({
      resourceKeyDigest: redactionDigest(resource.resourceKey),
      providerResourceDigest: redactionDigest(resource.providerResourceId),
      originOperationDigest: redactionDigest(resource.originOperationId),
      sourceBound: resource.sourceSha256 !== null,
      kind: resource.kind,
      verbs: [...resource.verbs],
    })),
    blockers: body.blockers.map((blocker) => Object.fromEntries(Object.entries(blocker).map(([key, value]) => [
      key,
      key === 'code' || key.endsWith('State') ? value : redactionDigest(value),
    ]))),
    summary: { resourceCount: body.resources.length, blockerCount: body.blockers.length },
  });
}

function base64urlDecode(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !BASE64URL.test(value)) fail('INVALID_APPROVAL_ENVELOPE', `${label} must be unpadded base64url.`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail('INVALID_APPROVAL_ENVELOPE', `${label} is not canonical base64url.`);
  return bytes;
}

function normalizeApprovalResource(value, index) {
  const label = `approval.resources[${index}]`;
  onlyKeys(value, ['resourceKey', 'kind', 'providerResourceId', 'verbs'], ['resourceKey', 'kind', 'providerResourceId', 'verbs'], label);
  if (!RESOURCE_KINDS.has(value.kind)) fail('INVALID_APPROVAL_CLAIMS', `${label}.kind is unsupported.`);
  const verbs = normalizedStringArray(value.verbs, `${label}.verbs`, VERBS);
  if (verbs.length === 0) fail('INVALID_APPROVAL_CLAIMS', `${label}.verbs cannot be empty.`);
  return {
    resourceKey: text(value.resourceKey, `${label}.resourceKey`),
    kind: value.kind,
    providerResourceId: text(value.providerResourceId, `${label}.providerResourceId`),
    verbs,
  };
}

function normalizeApprovalClaims(claims) {
  onlyKeys(claims, ['version', 'planDigest', 'candidate', 'target', 'resources', 'budget', 'issuedAt', 'expiresAt', 'nonce', 'cohortId'], ['version', 'planDigest', 'candidate', 'target', 'resources', 'budget', 'issuedAt', 'expiresAt', 'nonce', 'cohortId'], 'approval');
  if (claims.version !== HEYGEN_RECONCILIATION_APPROVAL_VERSION) fail('UNSUPPORTED_APPROVAL_VERSION', 'The approval claims version is unsupported.');
  if (!Array.isArray(claims.resources) || claims.resources.length === 0) fail('INVALID_APPROVAL_CLAIMS', 'approval.resources must be a non-empty array.');
  onlyKeys(claims.budget, ['maxProviderCalls', 'maxSpendMicrousd'], ['maxProviderCalls', 'maxSpendMicrousd'], 'approval.budget');
  const resources = claims.resources.map(normalizeApprovalResource);
  uniqueBy(resources, (item) => item.resourceKey, 'approval.resources');
  const sorted = [...resources].sort((left, right) => compareText(left.resourceKey, right.resourceKey));
  if (canonicalize(resources) !== canonicalize(sorted)) fail('NON_CANONICAL_APPROVAL_SCOPE', 'approval.resources must be sorted by resourceKey.');
  return {
    version: claims.version,
    planDigest: sha256(claims.planDigest, 'approval.planDigest'),
    candidate: normalizeCandidate(claims.candidate),
    target: normalizeTarget(claims.target),
    resources,
    budget: {
      maxProviderCalls: safeInteger(claims.budget.maxProviderCalls, 'approval.budget.maxProviderCalls', { min: 1, max: 10_000 }),
      maxSpendMicrousd: safeInteger(claims.budget.maxSpendMicrousd, 'approval.budget.maxSpendMicrousd', { min: 0 }),
    },
    issuedAt: timestamp(claims.issuedAt, 'approval.issuedAt'),
    expiresAt: timestamp(claims.expiresAt, 'approval.expiresAt'),
    nonce: text(claims.nonce, 'approval.nonce'),
    cohortId: text(claims.cohortId, 'approval.cohortId'),
  };
}

function approvalBytes(kid, payloadBytes) {
  return Buffer.concat([APPROVAL_DOMAIN, Buffer.from(kid, 'utf8'), Buffer.from([0]), payloadBytes]);
}

export function canonicalApprovalPayloadBytes(claims) {
  return canonicalJsonBytes(normalizeApprovalClaims(claims));
}

export function canonicalApprovalSigningBytes(kidInput, claims) {
  const kid = text(kidInput, 'approval key ID');
  return approvalBytes(kid, canonicalApprovalPayloadBytes(claims));
}

function normalizeTrustedContext(context) {
  onlyKeys(context, ['plan', 'pinnedKeys', 'expectedBudget', 'now', 'nonceState', 'approvalStatus'], ['plan', 'pinnedKeys', 'expectedBudget', 'now', 'nonceState', 'approvalStatus'], 'trustedContext');
  if (!isRecord(context.pinnedKeys)) fail('INVALID_TRUST_CONTEXT', 'trustedContext.pinnedKeys must be an object.');
  onlyKeys(context.expectedBudget, ['maxProviderCalls', 'maxSpendMicrousd'], ['maxProviderCalls', 'maxSpendMicrousd'], 'trustedContext.expectedBudget');
  onlyKeys(context.nonceState, ['nonce', 'status'], ['nonce', 'status'], 'trustedContext.nonceState');
  return {
    plan: context.plan,
    pinnedKeys: context.pinnedKeys,
    expectedBudget: {
      maxProviderCalls: safeInteger(context.expectedBudget.maxProviderCalls, 'trustedContext.expectedBudget.maxProviderCalls', { min: 1, max: 10_000 }),
      maxSpendMicrousd: safeInteger(context.expectedBudget.maxSpendMicrousd, 'trustedContext.expectedBudget.maxSpendMicrousd', { min: 0 }),
    },
    now: timestamp(context.now, 'trustedContext.now'),
    nonceState: {
      nonce: text(context.nonceState.nonce, 'trustedContext.nonceState.nonce'),
      status: text(context.nonceState.status, 'trustedContext.nonceState.status'),
    },
    approvalStatus: text(context.approvalStatus, 'trustedContext.approvalStatus'),
  };
}

function expectedApprovalResources(plan) {
  return plan.resources.map(({ resourceKey, kind, providerResourceId, verbs }) => ({ resourceKey, kind, providerResourceId, verbs: [...verbs] }));
}

function approvalMatchesPlan(claims, plan, expectedBudget) {
  return claims.planDigest === plan.digest
    && canonicalize(claims.candidate) === canonicalize(plan.candidate)
    && canonicalize(claims.target) === canonicalize(plan.target)
    && canonicalize(claims.resources) === canonicalize(expectedApprovalResources(plan))
    && canonicalize(claims.budget) === canonicalize(expectedBudget)
    && claims.expiresAt === plan.expiresAt
    && claims.cohortId === plan.cohortId;
}

export function verifyApproval(envelopeBytes, trustedContextInput) {
  const envelope = strictJsonParse(envelopeBytes, 'approval envelope');
  onlyKeys(envelope, ['version', 'kid', 'payload', 'signature'], ['version', 'kid', 'payload', 'signature'], 'approval envelope');
  if (envelope.version !== HEYGEN_RECONCILIATION_ENVELOPE_VERSION) fail('UNSUPPORTED_APPROVAL_ENVELOPE_VERSION', 'The approval envelope version is unsupported.');
  const kid = text(envelope.kid, 'approval envelope.kid');
  const payloadBytes = base64urlDecode(envelope.payload, 'approval envelope.payload');
  const signature = base64urlDecode(envelope.signature, 'approval envelope.signature');
  const parsedClaims = strictJsonParse(payloadBytes, 'approval payload');
  const claims = normalizeApprovalClaims(parsedClaims);
  if (!canonicalApprovalPayloadBytes(claims).equals(payloadBytes)) fail('NON_CANONICAL_APPROVAL_PAYLOAD', 'The signed approval payload is not canonical.');

  const trusted = normalizeTrustedContext(trustedContextInput);
  const planBody = assertPlanIntegrity(trusted.plan);
  if (planBody.blockers.length !== 0) fail('PLAN_BLOCKED', 'A blocked plan cannot be approved.');
  const pinnedKey = Object.hasOwn(trusted.pinnedKeys, kid) ? trusted.pinnedKeys[kid] : null;
  if (!pinnedKey) fail('UNTRUSTED_APPROVAL_KEY', 'The approval key ID is not pinned.');
  let publicKey;
  try { publicKey = pinnedKey instanceof KeyObject ? pinnedKey : createPublicKey(pinnedKey); } catch { fail('INVALID_APPROVAL_KEY', 'The pinned approval key is invalid.'); }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') fail('INVALID_APPROVAL_KEY', 'The pinned approval key must be an Ed25519 public key.');
  if (!verifySignature(null, approvalBytes(kid, payloadBytes), publicKey, signature)) fail('INVALID_APPROVAL_SIGNATURE', 'The approval signature is invalid.', 403);

  if (!approvalMatchesPlan(claims, trusted.plan, trusted.expectedBudget)) {
    fail('APPROVAL_SCOPE_MISMATCH', 'The approval claims do not match the exact reconciliation plan.', 403);
  }
  const issuedMs = new Date(claims.issuedAt).getTime();
  const expiresMs = new Date(claims.expiresAt).getTime();
  const nowMs = new Date(trusted.now).getTime();
  if (issuedMs < new Date(planBody.createdAt).getTime() || issuedMs > nowMs) fail('INVALID_APPROVAL_TIME', 'The approval issue time is outside the plan window.', 403);
  if (expiresMs <= nowMs) fail('APPROVAL_EXPIRED', 'The approval has expired.', 403);
  if (claims.nonce !== trusted.nonceState.nonce || trusted.nonceState.status !== 'fresh') fail('APPROVAL_NONCE_UNAVAILABLE', 'The approval nonce is missing, consumed, or does not match.', 403);
  if (trusted.approvalStatus !== 'active') fail('APPROVAL_REVOKED', 'The approval is not active.', 403);

  const approvalDigest = createHash('sha256').update(canonicalJsonBytes(envelope)).digest('hex');
  const verified = freeze({ ...claims, kid, approvalDigest, verifiedAt: trusted.now });
  VERIFIED_APPROVALS.add(verified);
  return verified;
}

export function assertVerifiedApproval(approval, lockContext) {
  if (!approval || typeof approval !== 'object' || !VERIFIED_APPROVALS.has(approval)) {
    fail('UNVERIFIED_APPROVAL', 'Only an approval verified in this process can authorize a local claim.', 403);
  }
  onlyKeys(lockContext, ['plan', 'expectedBudget', 'now', 'nonce', 'approvalStatus'], ['plan', 'expectedBudget', 'now', 'nonce', 'approvalStatus'], 'lockContext');
  onlyKeys(lockContext.expectedBudget, ['maxProviderCalls', 'maxSpendMicrousd'], ['maxProviderCalls', 'maxSpendMicrousd'], 'lockContext.expectedBudget');
  const expectedBudget = {
    maxProviderCalls: safeInteger(lockContext.expectedBudget.maxProviderCalls, 'lockContext.expectedBudget.maxProviderCalls', { min: 1, max: 10_000 }),
    maxSpendMicrousd: safeInteger(lockContext.expectedBudget.maxSpendMicrousd, 'lockContext.expectedBudget.maxSpendMicrousd', { min: 0 }),
  };
  const now = timestamp(lockContext.now, 'lockContext.now');
  const nonce = text(lockContext.nonce, 'lockContext.nonce');
  const approvalStatus = text(lockContext.approvalStatus, 'lockContext.approvalStatus');
  const planBody = assertPlanIntegrity(lockContext.plan);
  if (planBody.blockers.length !== 0) fail('PLAN_BLOCKED', 'A blocked plan cannot authorize a local claim.', 403);
  if (!approvalMatchesPlan(approval, lockContext.plan, expectedBudget)) fail('APPROVAL_SCOPE_MISMATCH', 'The verified approval no longer matches the locked reconciliation plan.', 403);
  if (approval.nonce !== nonce) fail('APPROVAL_NONCE_UNAVAILABLE', 'The verified approval nonce does not match the locked nonce.', 403);
  if (approvalStatus !== 'active') fail('APPROVAL_REVOKED', 'The approval is not active.', 403);
  if (new Date(approval.expiresAt).getTime() <= new Date(now).getTime()) fail('APPROVAL_EXPIRED', 'The approval expired before the local claim committed.', 403);
  return approval;
}
