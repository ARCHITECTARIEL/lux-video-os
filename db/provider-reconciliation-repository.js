import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, or } from 'drizzle-orm';

import { database } from './client.js';
import {
  identityVideoEnrollments,
  providerAccountBindingPromotions,
  providerAccountBindings,
  providerConsumerReferences,
  providerLifecycleEvents,
  providerLifecycleOperations,
  providerResources,
  providerVerifiedAccountScopes,
  userIdentities,
  videoJobs,
} from './schema.js';
import { acquireProviderLifecycleLock } from './provider-lifecycle-lock.js';
import { assertFreshHeygenProviderClaimTx, assertHeygenProviderReceiptTx } from './heygen-space-binding-repository.js';
import {
  HEYGEN_RECONCILIATION_SNAPSHOT_VERSION,
  canonicalJsonBytes,
} from '../lib/heygen-reconciliation-contract.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_.:@-]{1,255}$/;
const OPERATION_KINDS = new Set(['asset_upload', 'avatar_create', 'voice_clone', 'video_create', 'resource_read', 'resource_delete', 'url_probe']);
const RESOURCE_KINDS = new Set(['asset', 'avatar_look', 'avatar_group', 'voice', 'video']);
const RESOURCE_STATES = new Set(['unknown', 'processing', 'present', 'ready', 'failed', 'delete_claimed', 'delete_acknowledged', 'api_absent', 'pending_reconciliation']);
const RESOURCE_KINDS_BY_OPERATION = Object.freeze({
  asset_upload: new Set(['asset']),
  avatar_create: new Set(['avatar_group', 'avatar_look']),
  voice_clone: new Set(['voice']),
  video_create: new Set(['video']),
  resource_read: new Set(RESOURCE_KINDS),
  resource_delete: new Set(RESOURCE_KINDS),
  url_probe: new Set(RESOURCE_KINDS),
});

function failure(message, statusCode = 409, code = 'PROVIDER_RECONCILIATION') {
  return Object.assign(new Error(message), { statusCode, failureCategory: code, code });
}

function exactText(value, label, max = 255) {
  const result = String(value || '');
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw failure(`${label} is invalid.`, 400, 'VALIDATION');
  return result;
}

function internalEvidenceRef(value, label) {
  const result = exactText(value, label, 1024);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/.test(result)
    || result.includes('..') || result.includes('\\')) {
    throw failure(`${label} must be an internal evidence reference.`, 400, 'VALIDATION');
  }
  return result;
}

function digest(value, label) {
  const result = String(value || '');
  if (!SHA256.test(result)) throw failure(`${label} must be a lowercase SHA-256 digest.`, 400, 'VALIDATION');
  return result;
}

function providerId(value, label) {
  const result = String(value || '');
  if (!SAFE_ID.test(result) || result === '.' || result.includes('..') || result.includes('://')) {
    throw failure(`${label} is invalid.`, 400, 'VALIDATION');
  }
  return result;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function providerOperationRequestDigest(value) {
  return sha256(canonicalJsonBytes(value));
}

function originScopeKey(credentialScopeFingerprint) {
  return sha256(Buffer.concat([
    Buffer.from('LUX_VIDEO_OS\0PROVIDER_CREDENTIAL_SCOPE\0V1\0', 'utf8'),
    Buffer.from(credentialScopeFingerprint, 'utf8'),
  ]));
}

function normalizeBinding(accountId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('Provider account binding is required.', 503, 'MISSING_PROVIDER_ACCOUNT_BINDING');
  const credentialScopeFingerprint = digest(value.credentialScopeFingerprint, 'credentialScopeFingerprint');
  return {
    applicationAccountId: exactText(accountId, 'accountId', 512),
    provider: 'heygen',
    environment: exactText(value.environment, 'environment', 80),
    projectId: exactText(value.projectId, 'projectId'),
    databaseBindingSha256: digest(value.databaseBindingSha256, 'databaseBindingSha256'),
    credentialScopeFingerprint,
    originScopeKey: originScopeKey(credentialScopeFingerprint),
    credentialEvidenceDigest: value.credentialEvidenceDigest == null ? null : digest(value.credentialEvidenceDigest, 'credentialEvidenceDigest'),
    credentialEvidenceRef: value.credentialEvidenceRef == null ? null : internalEvidenceRef(value.credentialEvidenceRef, 'credentialEvidenceRef'),
  };
}

export async function ensureProvisionalProviderBindingTx(tx, { accountId, binding }) {
  const normalized = normalizeBinding(accountId, binding);
  const [active] = await tx.select().from(providerAccountBindings).where(and(
    eq(providerAccountBindings.applicationAccountId, normalized.applicationAccountId),
    eq(providerAccountBindings.provider, 'heygen'),
    eq(providerAccountBindings.environment, normalized.environment),
    eq(providerAccountBindings.projectId, normalized.projectId),
    eq(providerAccountBindings.databaseBindingSha256, normalized.databaseBindingSha256),
    eq(providerAccountBindings.lifecycleState, 'active'),
  )).limit(1);
  if (active) {
    if (active.credentialScopeFingerprint !== normalized.credentialScopeFingerprint
      || active.originScopeKey !== normalized.originScopeKey
      || (normalized.credentialEvidenceDigest && active.credentialEvidenceDigest !== normalized.credentialEvidenceDigest)) {
      throw failure('Provider credential binding changed and requires reconciliation.', 409, 'PROVIDER_ACCOUNT_BINDING_CONFLICT');
    }
    return active;
  }
  const [created] = await tx.insert(providerAccountBindings).values(normalized).onConflictDoNothing().returning();
  if (created) return created;
  throw failure('Provider account binding could not be established.', 409, 'PROVIDER_ACCOUNT_BINDING_CONFLICT');
}

export async function registerProvisionalProviderBinding({ accountId, binding }, { executor = database() } = {}) {
  return executor.transaction(async tx => {
    await acquireProviderLifecycleLock(tx, accountId);
    return ensureProvisionalProviderBindingTx(tx, { accountId, binding });
  });
}

function normalizeOperation(input) {
  if (!OPERATION_KINDS.has(input.kind)) throw failure('Provider operation kind is invalid.', 400, 'VALIDATION');
  const sourceSha256 = input.sourceSha256 == null ? null : digest(input.sourceSha256, 'sourceSha256');
  const sourceBytes = input.sourceBytes == null ? null : Number(input.sourceBytes);
  if ((sourceSha256 === null) !== (sourceBytes === null) || (sourceBytes !== null && (!Number.isSafeInteger(sourceBytes) || sourceBytes <= 0))) {
    throw failure('Provider operation source binding is invalid.', 400, 'VALIDATION');
  }
  return {
    kind: input.kind,
    originOperationKey: exactText(input.originOperationKey, 'originOperationKey'),
    attempt: Number(input.attempt || 1),
    correlationId: exactText(input.correlationId, 'correlationId'),
    requestDigest: digest(input.requestDigest, 'requestDigest'),
    sourceSha256,
    sourceBytes,
    enrollmentId: input.enrollmentId || null,
    identityId: input.identityId || null,
    jobId: input.jobId || null,
    approvalClaimId: input.approvalClaimId || null,
  };
}

async function exactProviderBindingForClaimTx(tx, { accountId, providerBinding }) {
  const authority = assertFreshHeygenProviderClaimTx(tx, { accountId, providerBinding });
  const [accountBinding] = await tx.select().from(providerAccountBindings).where(and(
    eq(providerAccountBindings.id, authority.bindingId),
    eq(providerAccountBindings.applicationAccountId, accountId),
    eq(providerAccountBindings.provider, 'heygen'),
    eq(providerAccountBindings.environment, authority.environment),
    eq(providerAccountBindings.projectId, authority.projectId),
    eq(providerAccountBindings.databaseBindingSha256, authority.databaseBindingSha256),
    eq(providerAccountBindings.credentialScopeFingerprint, authority.credentialScopeFingerprint),
    eq(providerAccountBindings.originScopeKey, authority.originScopeKey),
    eq(providerAccountBindings.lifecycleState, 'active'),
  )).for('share').limit(1);
  if (!accountBinding || accountBinding.revokedAt !== null) {
    throw failure('Provider binding was revoked or changed before the operation claim.', 409, 'PROVIDER_ACCOUNT_BINDING_CONFLICT');
  }
  const [promotion] = await tx.select().from(providerAccountBindingPromotions).where(and(
    eq(providerAccountBindingPromotions.id, authority.promotionId),
    eq(providerAccountBindingPromotions.bindingId, accountBinding.id),
    eq(providerAccountBindingPromotions.applicationAccountId, accountId),
    eq(providerAccountBindingPromotions.originScopeKey, accountBinding.originScopeKey),
    eq(providerAccountBindingPromotions.verifiedAccountScopeId, authority.verifiedAccountScopeId),
    eq(providerAccountBindingPromotions.state, 'verified'),
  )).for('share').limit(1);
  if (!promotion || promotion.revokedAt !== null || promotion.evidenceDigest !== authority.identityDigest) {
    throw failure('Provider-space promotion was revoked or changed before the operation claim.', 409, 'PROVIDER_ACCOUNT_BINDING_CONFLICT');
  }
  const [scope] = await tx.select().from(providerVerifiedAccountScopes).where(and(
    eq(providerVerifiedAccountScopes.id, authority.verifiedAccountScopeId),
    eq(providerVerifiedAccountScopes.provider, 'heygen'),
    eq(providerVerifiedAccountScopes.providerAccountFingerprint, authority.providerSpaceFingerprint),
    eq(providerVerifiedAccountScopes.canonicalScopeKey, authority.canonicalScopeKey),
  )).for('share').limit(1);
  if (!scope) {
    throw failure('Provider-space scope changed before the operation claim.', 409, 'PROVIDER_ACCOUNT_BINDING_CONFLICT');
  }
  return { accountBinding, verifiedAccountScopeId: scope.id };
}

export async function reserveProviderOperationTx(tx, { accountId, providerBinding, ...input }) {
  const { accountBinding, verifiedAccountScopeId } = await exactProviderBindingForClaimTx(tx, { accountId, providerBinding });
  const operation = normalizeOperation(input);
  if (!Number.isSafeInteger(operation.attempt) || operation.attempt < 1 || operation.attempt > 100) throw failure('Provider operation attempt is invalid.', 400, 'VALIDATION');
  const [existing] = await tx.select().from(providerLifecycleOperations).where(and(
    eq(providerLifecycleOperations.originScopeKey, accountBinding.originScopeKey),
    eq(providerLifecycleOperations.kind, operation.kind),
    eq(providerLifecycleOperations.originOperationKey, operation.originOperationKey),
    eq(providerLifecycleOperations.attempt, operation.attempt),
  )).limit(1);
  if (existing) {
    const same = existing.applicationAccountId === accountId && existing.bindingId === accountBinding.id
      && existing.correlationId === operation.correlationId && existing.requestDigest === operation.requestDigest
      && existing.sourceSha256 === operation.sourceSha256 && existing.sourceBytes === operation.sourceBytes
      && existing.enrollmentId === operation.enrollmentId && existing.identityId === operation.identityId && existing.jobId === operation.jobId
      && existing.approvalClaimId === operation.approvalClaimId;
    if (!same) throw failure('Provider operation replay conflicts with its immutable origin.', 409, 'PROVIDER_OPERATION_CONFLICT');
    if (existing.state === 'reserved') throw failure('Provider operation reservation did not reach submission.', 409, 'PROVIDER_OPERATION_CONFLICT');
    return { binding: accountBinding, operation: existing, replayed: true };
  }
  if (operation.jobId) {
    const [owned] = await tx.select({ id: videoJobs.id }).from(videoJobs).where(and(
      eq(videoJobs.id, operation.jobId), eq(videoJobs.accountId, accountId),
    )).for('share').limit(1);
    if (!owned) throw failure('Provider operation job is not owned by the account.', 404, 'OWNERSHIP');
  }
  if (operation.enrollmentId) {
    const [owned] = await tx.select({ id: identityVideoEnrollments.id }).from(identityVideoEnrollments).where(and(
      eq(identityVideoEnrollments.id, operation.enrollmentId), eq(identityVideoEnrollments.accountId, accountId),
    )).for('share').limit(1);
    if (!owned) throw failure('Provider operation enrollment is not owned by the account.', 404, 'OWNERSHIP');
  }
  if (operation.identityId) {
    const [owned] = await tx.select({ id: userIdentities.id }).from(userIdentities).where(and(
      eq(userIdentities.id, operation.identityId), eq(userIdentities.accountId, accountId),
    )).for('share').limit(1);
    if (!owned) throw failure('Provider operation identity is not owned by the account.', 404, 'OWNERSHIP');
  }
  const now = new Date();
  const [created] = await tx.insert(providerLifecycleOperations).values({
    applicationAccountId: accountId,
    bindingId: accountBinding.id,
    originScopeKey: accountBinding.originScopeKey,
    ...operation,
    state: 'reserved',
    submittedAt: null,
    createdAt: now,
    updatedAt: now,
  }).returning();
  await tx.insert(providerLifecycleEvents).values({
    applicationAccountId: accountId,
    originScopeKey: accountBinding.originScopeKey,
    operationId: created.id,
    eventType: 'provider.operation_reserved',
    correlationId: operation.correlationId,
    method: operation.kind === 'resource_read' ? 'GET' : operation.kind === 'resource_delete' ? 'DELETE' : 'POST',
    details: { kind: operation.kind, attempt: operation.attempt },
    observedAt: now,
  });
  const [pending] = await tx.update(providerLifecycleOperations).set({ state: 'pending', submittedAt: now, updatedAt: now })
    .where(and(eq(providerLifecycleOperations.id, created.id), eq(providerLifecycleOperations.state, 'reserved'))).returning();
  if (!pending) throw failure('Provider operation submission lost its reservation.', 409, 'PROVIDER_OPERATION_CONFLICT');
  await tx.insert(providerLifecycleEvents).values({
    applicationAccountId: accountId,
    originScopeKey: accountBinding.originScopeKey,
    operationId: pending.id,
    eventType: 'provider.operation_claimed',
    correlationId: operation.correlationId,
    method: operation.kind === 'resource_read' ? 'GET' : operation.kind === 'resource_delete' ? 'DELETE' : 'POST',
    details: { kind: operation.kind, attempt: operation.attempt },
    observedAt: now,
  });
  return { binding: accountBinding, operation: pending, replayed: false };
}

export async function assertProviderReceiptOperationTx(tx, { accountId, providerBinding, operationId }) {
  const authority = assertHeygenProviderReceiptTx(tx, { accountId, providerBinding });
  const [operation] = await tx.select().from(providerLifecycleOperations).where(and(
    eq(providerLifecycleOperations.id, operationId),
    eq(providerLifecycleOperations.applicationAccountId, accountId),
    eq(providerLifecycleOperations.bindingId, authority.bindingId),
    eq(providerLifecycleOperations.originScopeKey, authority.originScopeKey),
  )).for('share').limit(1);
  if (!operation) {
    throw failure('Provider receipt does not match the claimed binding origin.', 409, 'PROVIDER_OPERATION_CONFLICT');
  }
  return operation;
}

export async function recordProviderJobSubmissionUnknownTx(tx, { accountId, jobId, providerBinding, now = new Date() }) {
  const authority = assertHeygenProviderReceiptTx(tx, { accountId, providerBinding });
  const operations = await tx.select().from(providerLifecycleOperations).where(and(
    eq(providerLifecycleOperations.applicationAccountId, accountId),
    eq(providerLifecycleOperations.bindingId, authority.bindingId),
    eq(providerLifecycleOperations.originScopeKey, authority.originScopeKey),
    eq(providerLifecycleOperations.jobId, jobId),
    eq(providerLifecycleOperations.kind, 'video_create'),
  )).orderBy(desc(providerLifecycleOperations.createdAt)).for('update').limit(2);
  if (operations.length !== 1) {
    throw failure('Provider video operation is missing or ambiguous.', 409, 'PROVIDER_OPERATION_CONFLICT');
  }
  return recordProviderOperationFailureTx(tx, {
    accountId,
    operationId: operations[0].id,
    ambiguous: true,
    code: 'PROVIDER_RESULT_UNKNOWN',
    now,
  });
}

async function verifiedScopeForBinding(tx, bindingId) {
  const [promotion] = await tx.select().from(providerAccountBindingPromotions).where(and(
    eq(providerAccountBindingPromotions.bindingId, bindingId),
    eq(providerAccountBindingPromotions.state, 'verified'),
  )).limit(1);
  return promotion?.verifiedAccountScopeId || null;
}

function normalizeResource(value) {
  if (!RESOURCE_KINDS.has(value.kind)) throw failure('Provider resource kind is invalid.', 400, 'VALIDATION');
  if (!RESOURCE_STATES.has(value.state)) throw failure('Provider resource state is invalid.', 400, 'VALIDATION');
  const voiceNamespace = value.kind === 'voice' ? exactText(value.voiceNamespace, 'voiceNamespace', 40) : null;
  if (value.kind === 'voice' && voiceNamespace !== 'instant') throw failure('Only instant voice resources are supported.', 409, 'UNSUPPORTED_VOICE_NAMESPACE');
  return {
    kind: value.kind,
    providerResourceId: providerId(value.providerResourceId, 'providerResourceId'),
    voiceNamespace,
    state: value.state,
    sourceSha256: value.sourceSha256 == null ? null : digest(value.sourceSha256, 'sourceSha256'),
    sourceBytes: value.sourceBytes == null ? null : Number(value.sourceBytes),
    publicUrlDigest: value.publicUrlDigest == null ? null : digest(value.publicUrlDigest, 'publicUrlDigest'),
    privateEvidenceRef: value.privateEvidenceRef == null ? null : internalEvidenceRef(value.privateEvidenceRef, 'privateEvidenceRef'),
    evidenceExpiresAt: value.evidenceExpiresAt || null,
    parentProviderResourceId: value.parentProviderResourceId == null ? null : providerId(value.parentProviderResourceId, 'parentProviderResourceId'),
  };
}

function sameTimestamp(left, right) {
  if (left == null && right == null) return true;
  return new Date(left).getTime() === new Date(right).getTime();
}

function sameResourceOrigin(existing, proposed) {
  return existing.applicationAccountId === proposed.applicationAccountId
    && existing.bindingId === proposed.bindingId
    && existing.originScopeKey === proposed.originScopeKey
    && existing.verifiedAccountScopeId === proposed.verifiedAccountScopeId
    && existing.kind === proposed.kind
    && existing.providerResourceId === proposed.providerResourceId
    && existing.originOperationId === proposed.originOperationId
    && existing.voiceNamespace === proposed.voiceNamespace
    && existing.parentResourceId === proposed.parentResourceId
    && existing.sourceSha256 === proposed.sourceSha256
    && existing.sourceBytes === proposed.sourceBytes
    && existing.publicUrlDigest === proposed.publicUrlDigest
    && existing.privateEvidenceRef === proposed.privateEvidenceRef
    && sameTimestamp(existing.evidenceExpiresAt, proposed.evidenceExpiresAt);
}

export async function recordProviderOperationResourcesTx(tx, { accountId, operationId, resources, now = new Date() }) {
  const [operation] = await tx.select().from(providerLifecycleOperations).where(and(
    eq(providerLifecycleOperations.id, operationId),
    eq(providerLifecycleOperations.applicationAccountId, accountId),
  )).for('update').limit(1);
  if (!operation) throw failure('Provider operation was not found.', 404, 'OWNERSHIP');
  if (!['pending', 'succeeded', 'ambiguous'].includes(operation.state)) throw failure('Provider operation cannot accept resources.', 409, 'PROVIDER_OPERATION_CONFLICT');
  const binding = (await tx.select().from(providerAccountBindings).where(eq(providerAccountBindings.id, operation.bindingId)).limit(1))[0];
  if (!binding) throw failure('Provider binding was not found.', 409, 'PROVIDER_ACCOUNT_BINDING_CONFLICT');
  const verifiedAccountScopeId = await verifiedScopeForBinding(tx, binding.id);
  const normalized = resources.map(normalizeResource);
  const conflicts = [];
  if (normalized.length === 0 && ['asset_upload', 'avatar_create', 'voice_clone', 'video_create'].includes(operation.kind)) {
    conflicts.push({ reason: 'PROVIDER_ID_MISSING' });
    await tx.insert(providerLifecycleEvents).values({
      applicationAccountId: accountId, originScopeKey: binding.originScopeKey, operationId: operation.id,
      eventType: 'provider.operation_missing_resource', correlationId: operation.correlationId, method: 'POST',
      details: { reason: 'PROVIDER_ID_MISSING' }, observedAt: now,
    });
  }
  const ordered = [...normalized].sort((left, right) => (left.kind === 'avatar_group' ? -1 : right.kind === 'avatar_group' ? 1 : 0));
  const createdByProviderId = new Map();
  const accepted = [];
  for (const resource of ordered) {
    if (!RESOURCE_KINDS_BY_OPERATION[operation.kind]?.has(resource.kind)) {
      conflicts.push({ kind: resource.kind, providerResourceId: resource.providerResourceId, reason: 'OPERATION_RESOURCE_KIND_MISMATCH' });
      await tx.insert(providerLifecycleEvents).values({
        applicationAccountId: accountId, originScopeKey: binding.originScopeKey, operationId: operation.id,
        eventType: 'provider.resource_kind_conflict', correlationId: operation.correlationId, method: 'POST',
        observedResourceKind: resource.kind, observedProviderResourceId: resource.providerResourceId,
        details: { reason: 'OPERATION_RESOURCE_KIND_MISMATCH', operationKind: operation.kind }, observedAt: now,
      });
      continue;
    }
    if (resource.sourceSha256 !== operation.sourceSha256 || resource.sourceBytes !== operation.sourceBytes) {
      conflicts.push({ kind: resource.kind, providerResourceId: resource.providerResourceId, reason: 'OPERATION_RESOURCE_SOURCE_MISMATCH' });
      await tx.insert(providerLifecycleEvents).values({
        applicationAccountId: accountId, originScopeKey: binding.originScopeKey, operationId: operation.id,
        eventType: 'provider.resource_source_conflict', correlationId: operation.correlationId, method: 'POST',
        observedResourceKind: resource.kind, observedProviderResourceId: resource.providerResourceId,
        details: { reason: 'OPERATION_RESOURCE_SOURCE_MISMATCH' }, observedAt: now,
      });
      continue;
    }
    let parentResourceId = null;
    if (resource.kind === 'avatar_look') {
      if (!resource.parentProviderResourceId) {
        conflicts.push({ kind: resource.kind, providerResourceId: resource.providerResourceId, reason: 'PARENT_REQUIRED' });
        await tx.insert(providerLifecycleEvents).values({
          applicationAccountId: accountId, originScopeKey: binding.originScopeKey, operationId: operation.id,
          eventType: 'provider.resource_parent_conflict', correlationId: operation.correlationId, method: 'POST',
          observedResourceKind: resource.kind, observedProviderResourceId: resource.providerResourceId,
          details: { reason: 'PARENT_REQUIRED' }, observedAt: now,
        });
        continue;
      }
      const mapped = createdByProviderId.get(`avatar_group:${resource.parentProviderResourceId}`);
      const existingParent = mapped || (await tx.select().from(providerResources).where(and(
        eq(providerResources.applicationAccountId, accountId),
        eq(providerResources.originScopeKey, binding.originScopeKey),
        eq(providerResources.kind, 'avatar_group'),
        eq(providerResources.providerResourceId, resource.parentProviderResourceId),
      )).for('share').limit(1))[0];
      if (!existingParent) {
        conflicts.push({ kind: resource.kind, providerResourceId: resource.providerResourceId, reason: 'PARENT_NOT_FOUND' });
        await tx.insert(providerLifecycleEvents).values({
          applicationAccountId: accountId, originScopeKey: binding.originScopeKey, operationId: operation.id,
          eventType: 'provider.resource_parent_conflict', correlationId: operation.correlationId, method: 'POST',
          observedResourceKind: resource.kind, observedProviderResourceId: resource.providerResourceId,
          details: { reason: 'PARENT_NOT_FOUND' }, observedAt: now,
        });
        continue;
      }
      parentResourceId = existingParent.id;
    }
    const values = {
      applicationAccountId: accountId,
      bindingId: binding.id,
      originScopeKey: binding.originScopeKey,
      verifiedAccountScopeId,
      kind: resource.kind,
      providerResourceId: resource.providerResourceId,
      originOperationId: operation.id,
      voiceNamespace: resource.voiceNamespace,
      parentResourceId,
      state: resource.state,
      sourceSha256: resource.sourceSha256,
      sourceBytes: resource.sourceBytes,
      publicUrlDigest: resource.publicUrlDigest,
      privateEvidenceRef: resource.privateEvidenceRef,
      evidenceExpiresAt: resource.evidenceExpiresAt,
      createdAt: now,
      updatedAt: now,
    };
    if (operation.state === 'succeeded') {
      const [settled] = await tx.select().from(providerResources).where(and(
        eq(providerResources.applicationAccountId, accountId),
        eq(providerResources.originOperationId, operation.id),
        eq(providerResources.kind, resource.kind),
        eq(providerResources.providerResourceId, resource.providerResourceId),
      )).limit(1);
      if (!settled || !sameResourceOrigin(settled, values)) {
        conflicts.push({ kind: resource.kind, providerResourceId: resource.providerResourceId, reason: 'TERMINAL_OPERATION_RESOURCE_CONFLICT' });
        await tx.insert(providerLifecycleEvents).values({
          applicationAccountId: accountId, originScopeKey: binding.originScopeKey, operationId: operation.id,
          eventType: 'provider.resource_after_terminal_operation', correlationId: operation.correlationId, method: 'POST',
          observedResourceKind: resource.kind, observedProviderResourceId: resource.providerResourceId,
          details: { reason: 'TERMINAL_OPERATION_RESOURCE_CONFLICT' }, observedAt: now,
        });
        continue;
      }
    }
    const [created] = await tx.insert(providerResources).values(values).onConflictDoNothing().returning();
    const existing = created || (await tx.select().from(providerResources).where(and(
      eq(providerResources.originScopeKey, binding.originScopeKey),
      eq(providerResources.kind, resource.kind),
      eq(providerResources.providerResourceId, resource.providerResourceId),
    )).limit(1))[0];
    const owned = existing && sameResourceOrigin(existing, values);
    await tx.insert(providerLifecycleEvents).values({
      applicationAccountId: accountId,
      originScopeKey: binding.originScopeKey,
      operationId: operation.id,
      ...(owned ? { resourceId: existing.id } : {}),
      eventType: owned ? 'provider.resource_observed' : 'provider.resource_ownership_conflict',
      correlationId: operation.correlationId,
      method: 'POST',
      observedResourceKind: resource.kind,
      observedProviderResourceId: resource.providerResourceId,
      evidenceDigest: resource.publicUrlDigest,
      privateEvidenceRef: resource.privateEvidenceRef,
      details: { state: resource.state, ownershipConflict: !owned },
      observedAt: now,
    });
    if (owned) {
      accepted.push(existing);
      createdByProviderId.set(`${resource.kind}:${resource.providerResourceId}`, existing);
    } else {
      conflicts.push({ kind: resource.kind, providerResourceId: resource.providerResourceId });
    }
  }
  const state = operation.state === 'ambiguous'
    ? 'ambiguous'
    : operation.state === 'succeeded'
      ? 'succeeded'
      : conflicts.length ? 'ambiguous' : 'succeeded';
  let updated = operation;
  if (operation.state === 'pending') {
    [updated] = await tx.update(providerLifecycleOperations).set({ state, completedAt: now, updatedAt: now })
      .where(eq(providerLifecycleOperations.id, operation.id)).returning();
  }
  return { operation: updated, resources: accepted, conflicts };
}

export async function recordProviderOperationFailureTx(tx, { accountId, operationId, ambiguous = false, code = null, now = new Date() }) {
  const [operation] = await tx.select().from(providerLifecycleOperations).where(and(
    eq(providerLifecycleOperations.id, operationId),
    eq(providerLifecycleOperations.applicationAccountId, accountId),
  )).for('update').limit(1);
  if (!operation) return null;
  if (['succeeded', 'failed', 'ambiguous'].includes(operation.state)) return operation;
  const state = ambiguous ? 'ambiguous' : 'failed';
  const [updated] = await tx.update(providerLifecycleOperations).set({ state, completedAt: now, updatedAt: now })
    .where(eq(providerLifecycleOperations.id, operation.id)).returning();
  await tx.insert(providerLifecycleEvents).values({
    applicationAccountId: accountId,
    originScopeKey: operation.originScopeKey,
    operationId: operation.id,
    eventType: ambiguous ? 'provider.operation_ambiguous' : 'provider.operation_failed',
    correlationId: operation.correlationId,
    providerCode: code ? String(code).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) : null,
    details: {},
    observedAt: now,
  });
  return updated;
}

export async function attachProviderConsumerReferenceTx(tx, { accountId, resourceId, consumerKind, consumerId, originOperationId, now = new Date() }) {
  const normalizedConsumerId = exactText(consumerId, 'consumerId');
  let consumerResource = null;
  if (consumerKind === 'enrollment') {
    const [owned] = await tx.select({ id: identityVideoEnrollments.id }).from(identityVideoEnrollments).where(and(
      eq(identityVideoEnrollments.id, normalizedConsumerId), eq(identityVideoEnrollments.accountId, accountId),
    )).for('share').limit(1);
    if (!owned) throw failure('Provider enrollment consumer is not owned.', 404, 'OWNERSHIP');
  } else if (consumerKind === 'identity') {
    const [owned] = await tx.select({ id: userIdentities.id }).from(userIdentities).where(and(
      eq(userIdentities.id, normalizedConsumerId), eq(userIdentities.accountId, accountId),
    )).for('share').limit(1);
    if (!owned) throw failure('Provider identity consumer is not owned.', 404, 'OWNERSHIP');
  } else if (consumerKind === 'job') {
    const [owned] = await tx.select({ id: videoJobs.id }).from(videoJobs).where(and(
      eq(videoJobs.id, normalizedConsumerId), eq(videoJobs.accountId, accountId),
    )).for('share').limit(1);
    if (!owned) throw failure('Provider job consumer is not owned.', 404, 'OWNERSHIP');
  } else if (consumerKind === 'provider_resource') {
    [consumerResource] = await tx.select().from(providerResources).where(and(
      eq(providerResources.id, normalizedConsumerId), eq(providerResources.applicationAccountId, accountId),
    )).limit(1);
    if (!consumerResource) throw failure('Provider resource dependency is missing.', 409, 'PROVIDER_REFERENCE_CONFLICT');
  } else {
    throw failure('Provider consumer kind is not attachable without qualified inventory.', 409, 'PROVIDER_REFERENCE_UNVERIFIED');
  }
  const resourceIds = [resourceId, ...(consumerResource ? [consumerResource.id] : [])].sort();
  const lockedResources = [];
  for (const id of resourceIds) {
    const [locked] = await tx.select().from(providerResources).where(and(
      eq(providerResources.id, id), eq(providerResources.applicationAccountId, accountId),
    )).for('update').limit(1);
    if (locked) lockedResources.push(locked);
  }
  const resource = lockedResources.find(item => item.id === resourceId);
  consumerResource = consumerResource ? lockedResources.find(item => item.id === consumerResource.id) : null;
  if (!resource) throw failure('Provider resource was not found.', 404, 'OWNERSHIP');
  if (['delete_claimed', 'delete_acknowledged', 'api_absent', 'pending_reconciliation'].includes(resource.state) || resource.tombstonedAt) {
    throw failure('Provider resource cannot accept another consumer.', 409, 'PROVIDER_RESOURCE_TOMBSTONED');
  }
  if (!resource.verifiedAccountScopeId) throw failure('Provider resource account binding is not verified.', 503, 'MISSING_PROVIDER_ACCOUNT_BINDING');
  if (consumerKind === 'provider_resource' && (!consumerResource || consumerResource.originScopeKey !== resource.originScopeKey
    || consumerResource.verifiedAccountScopeId !== resource.verifiedAccountScopeId)) {
    throw failure('Provider resource dependency is cross-scope or missing.', 409, 'PROVIDER_REFERENCE_CONFLICT');
  }
  const [created] = await tx.insert(providerConsumerReferences).values({
    applicationAccountId: accountId,
    originScopeKey: resource.originScopeKey,
    resourceId: resource.id,
    consumerKind: exactText(consumerKind, 'consumerKind', 80),
    consumerId: normalizedConsumerId,
    originOperationId,
    state: 'active',
    attachedAt: now,
  }).onConflictDoNothing().returning();
  if (created) return created;
  const [existing] = await tx.select().from(providerConsumerReferences).where(and(
    eq(providerConsumerReferences.resourceId, resource.id),
    eq(providerConsumerReferences.consumerKind, consumerKind),
    eq(providerConsumerReferences.consumerId, consumerId),
  )).limit(1);
  if (!existing || existing.state !== 'active' || existing.originOperationId !== originOperationId) {
    throw failure('Provider consumer reference conflicts with its origin.', 409, 'PROVIDER_REFERENCE_CONFLICT');
  }
  return existing;
}

export async function getExactProviderResourceTx(tx, { accountId, kind, providerResourceId, lock = false }) {
  let query = tx.select().from(providerResources).where(and(
    eq(providerResources.applicationAccountId, accountId),
    eq(providerResources.kind, kind),
    eq(providerResources.providerResourceId, providerResourceId),
  ));
  if (lock) query = query.for('share');
  const rows = await query.limit(2);
  if (rows.length !== 1 || !rows[0].verifiedAccountScopeId) {
    throw failure('Provider resource ownership is missing, ambiguous, or unverified.', 409, 'PROVIDER_RESOURCE_UNVERIFIED');
  }
  return rows[0];
}

async function providerConsumerResourcesForBindingTx(tx, { accountId, providerBinding, consumerKind, consumerId, expectedResources }) {
  const authority = assertFreshHeygenProviderClaimTx(tx, { accountId, providerBinding });
  const expected = [...expectedResources].sort((left, right) => `${left.kind}:${left.providerResourceId}`.localeCompare(`${right.kind}:${right.providerResourceId}`));
  const resources = [];
  for (const item of expected) {
    const resource = await getExactProviderResourceTx(tx, { accountId, kind: item.kind, providerResourceId: item.providerResourceId, lock: true });
    if (resource.bindingId !== authority.bindingId || resource.originScopeKey !== authority.originScopeKey
      || resource.verifiedAccountScopeId !== authority.verifiedAccountScopeId) {
      throw failure('Provider job resource belongs to a different provider space.', 409, 'PROVIDER_RESOURCE_SCOPE_CONFLICT');
    }
    if (['delete_claimed', 'delete_acknowledged', 'api_absent', 'pending_reconciliation'].includes(resource.state) || resource.tombstonedAt) {
      throw failure('Provider job resource requires reconciliation.', 409, 'PROVIDER_RESOURCE_TOMBSTONED');
    }
    const [reference] = await tx.select().from(providerConsumerReferences).where(and(
      eq(providerConsumerReferences.resourceId, resource.id),
      eq(providerConsumerReferences.consumerKind, consumerKind),
      eq(providerConsumerReferences.consumerId, consumerId),
      eq(providerConsumerReferences.state, 'active'),
    )).limit(1);
    if (!reference) throw failure('Provider consumer reference is missing.', 409, 'PROVIDER_REFERENCE_CONFLICT');
    resources.push(resource);
  }
  return Object.freeze(resources.map(resource => Object.freeze({ ...resource })));
}

export async function assertProviderJobReferencesActiveTx(tx, { accountId, jobId, providerBinding, expectedResources }) {
  await providerConsumerResourcesForBindingTx(tx, {
    accountId, providerBinding, consumerKind: 'job', consumerId: jobId, expectedResources,
  });
  return true;
}

export async function assertProviderIdentityReferencesActiveTx(tx, { accountId, identityId, providerBinding, expectedResources }) {
  return providerConsumerResourcesForBindingTx(tx, {
    accountId, providerBinding, consumerKind: 'identity', consumerId: identityId, expectedResources,
  });
}

export async function markProviderResourceReadyTx(tx, { accountId, resourceId, now = new Date(), evidenceDetails = {} }) {
  const [resource] = await tx.select().from(providerResources).where(and(
    eq(providerResources.id, resourceId), eq(providerResources.applicationAccountId, accountId),
  )).for('update').limit(1);
  if (!resource) throw failure('Provider resource was not found.', 404, 'OWNERSHIP');
  if (resource.state === 'ready') return resource;
  if (!['unknown', 'processing', 'present'].includes(resource.state) || resource.tombstonedAt) {
    throw failure('Provider resource cannot become ready from its current state.', 409, 'PROVIDER_RESOURCE_TOMBSTONED');
  }
  const [updated] = await tx.update(providerResources).set({ state: 'ready', updatedAt: now }).where(eq(providerResources.id, resource.id)).returning();
  const [operation] = await tx.select().from(providerLifecycleOperations).where(eq(providerLifecycleOperations.id, resource.originOperationId)).limit(1);
  await tx.insert(providerLifecycleEvents).values({
    applicationAccountId: accountId,
    originScopeKey: resource.originScopeKey,
    operationId: resource.originOperationId,
    resourceId: resource.id,
    eventType: 'provider.resource_ready',
    correlationId: operation?.correlationId || `resource:${resource.id}`,
    outcome: 'PRESENT',
    observedResourceKind: resource.kind,
    observedProviderResourceId: resource.providerResourceId,
    details: evidenceDetails,
    observedAt: now,
  });
  return updated;
}

export async function recordProviderVideoResourceTx(tx, { accountId, jobId, providerJobId, providerBinding, now = new Date() }) {
  const authority = assertHeygenProviderReceiptTx(tx, { accountId, providerBinding });
  const [operation] = await tx.select().from(providerLifecycleOperations).where(and(
    eq(providerLifecycleOperations.applicationAccountId, accountId),
    eq(providerLifecycleOperations.bindingId, authority.bindingId),
    eq(providerLifecycleOperations.originScopeKey, authority.originScopeKey),
    eq(providerLifecycleOperations.jobId, jobId),
    eq(providerLifecycleOperations.kind, 'video_create'),
  )).orderBy(desc(providerLifecycleOperations.createdAt)).for('update').limit(1);
  if (!operation) throw failure('Provider video operation is not registered.', 409, 'PROVIDER_OPERATION_CONFLICT');
  const result = await recordProviderOperationResourcesTx(tx, {
    accountId,
    operationId: operation.id,
    resources: [{ kind: 'video', providerResourceId: providerId(providerJobId, 'providerJobId'), state: 'processing' }],
    now,
  });
  if (result.conflicts.length || result.resources.length !== 1) return result;
  await attachProviderConsumerReferenceTx(tx, {
    accountId,
    resourceId: result.resources[0].id,
    consumerKind: 'job',
    consumerId: jobId,
    originOperationId: operation.id,
    now,
  });
  return result;
}

export async function markProviderVideoReadyTx(tx, { accountId, jobId, providerJobId, providerBinding, sourceUrlDigest, now = new Date() }) {
  const authority = assertHeygenProviderReceiptTx(tx, { accountId, providerBinding });
  if (!/^[a-f0-9]{64}$/.test(String(sourceUrlDigest || ''))) {
    throw failure('Provider video source URL digest is invalid.', 400, 'VALIDATION');
  }
  const resource = await getExactProviderResourceTx(tx, { accountId, kind: 'video', providerResourceId: providerJobId, lock: true });
  if (resource.bindingId !== authority.bindingId || resource.originScopeKey !== authority.originScopeKey
    || resource.verifiedAccountScopeId !== authority.verifiedAccountScopeId) {
    throw failure('Provider video belongs to a different provider space.', 409, 'PROVIDER_RESOURCE_SCOPE_CONFLICT');
  }
  const [reference] = await tx.select().from(providerConsumerReferences).where(and(
    eq(providerConsumerReferences.resourceId, resource.id),
    eq(providerConsumerReferences.consumerKind, 'job'),
    eq(providerConsumerReferences.consumerId, jobId),
    eq(providerConsumerReferences.state, 'active'),
  )).limit(1);
  if (!reference) throw failure('Provider video consumer reference is missing.', 409, 'PROVIDER_REFERENCE_CONFLICT');
  if (resource.state === 'ready') {
    const evidence = await tx.select().from(providerLifecycleEvents).where(and(
      eq(providerLifecycleEvents.resourceId, resource.id),
      eq(providerLifecycleEvents.eventType, 'provider.resource_ready'),
    )).orderBy(desc(providerLifecycleEvents.observedAt)).limit(2);
    if (evidence.length !== 1 || evidence[0]?.details?.sourceUrlDigest !== sourceUrlDigest) {
      throw failure('Provider video ready replay conflicts with its accepted source URL.', 409, 'PROVIDER_RESOURCE_CONFLICT');
    }
    return resource;
  }
  return markProviderResourceReadyTx(tx, {
    accountId, resourceId: resource.id, now, evidenceDetails: { sourceUrlDigest },
  });
}

export async function releaseProviderVideoConsumerTx(tx, { accountId, jobId, providerJobId, providerBinding = null, now = new Date() }) {
  const authority = providerBinding ? assertHeygenProviderReceiptTx(tx, { accountId, providerBinding }) : null;
  const resources = await tx.select().from(providerResources).where(and(
    eq(providerResources.applicationAccountId, accountId), eq(providerResources.kind, 'video'),
    eq(providerResources.providerResourceId, providerJobId),
  )).for('update').limit(2);
  if (resources.length === 0) return null;
  if (resources.length !== 1 || !resources[0].verifiedAccountScopeId) throw failure('Provider video resource is ambiguous or unverified.', 409, 'PROVIDER_RESOURCE_UNVERIFIED');
  const resource = resources[0];
  if (authority && (resource.bindingId !== authority.bindingId || resource.originScopeKey !== authority.originScopeKey
    || resource.verifiedAccountScopeId !== authority.verifiedAccountScopeId)) {
    throw failure('Provider video release belongs to a different provider space.', 409, 'PROVIDER_RESOURCE_SCOPE_CONFLICT');
  }
  const [reference] = await tx.select().from(providerConsumerReferences).where(and(
    eq(providerConsumerReferences.resourceId, resource.id),
    eq(providerConsumerReferences.consumerKind, 'job'),
    eq(providerConsumerReferences.consumerId, jobId),
  )).for('update').limit(1);
  if (!reference) throw failure('Provider video consumer reference is missing.', 409, 'PROVIDER_REFERENCE_CONFLICT');
  if (reference.state === 'released') return reference;
  if (reference.state !== 'active') throw failure('Provider video consumer reference requires reconciliation.', 409, 'PROVIDER_REFERENCE_CONFLICT');
  const [pending] = await tx.update(providerConsumerReferences).set({ state: 'pending', releaseClaimedAt: now })
    .where(and(eq(providerConsumerReferences.id, reference.id), eq(providerConsumerReferences.state, 'active'))).returning();
  if (!pending) throw failure('Provider video consumer release lost its claim.', 409, 'PROVIDER_REFERENCE_CONFLICT');
  const [released] = await tx.update(providerConsumerReferences).set({ state: 'released', releasedAt: now })
    .where(and(eq(providerConsumerReferences.id, reference.id), eq(providerConsumerReferences.state, 'pending'))).returning();
  if (!released) throw failure('Provider video consumer release did not complete.', 409, 'PROVIDER_REFERENCE_CONFLICT');
  const [operation] = await tx.select().from(providerLifecycleOperations).where(eq(providerLifecycleOperations.id, resource.originOperationId)).limit(1);
  await tx.insert(providerLifecycleEvents).values({
    applicationAccountId: accountId,
    originScopeKey: resource.originScopeKey,
    operationId: resource.originOperationId,
    resourceId: resource.id,
    referenceId: reference.id,
    eventType: 'provider.consumer_released_after_private_acceptance',
    correlationId: operation?.correlationId || `resource:${resource.id}`,
    details: { consumerKind: 'job', consumerId: jobId },
    observedAt: now,
  });
  return released;
}

function legacyReceiptOperations(enrollment, normalizedResources) {
  const receiptFields = [
    ['avatar:asset', 'providerAssetId', 'asset_upload', 'asset'],
    ['voice:asset', 'providerAssetId', 'asset_upload', 'asset'],
    ['avatar:create', 'providerRenderableAvatarId', 'avatar_create', 'avatar_look'],
    ['avatar:create', 'providerAvatarGroupId', 'avatar_create', 'avatar_group'],
    ['voice:create', 'providerVoiceId', 'voice_clone', 'voice'],
  ];
  const known = new Set(normalizedResources.map(resource => `${resource.kind}:${resource.providerResourceId}`));
  const unresolved = [];
  for (const [receiptKey, field, kind, resourceKind] of receiptFields) {
    const receipt = enrollment.providerReceipts?.[receiptKey];
    const providerId = receipt?.providerIds?.[field];
    const receiptCanHaveResource = receipt && ['SUBMITTING', 'PENDING', 'ACCEPTED', 'COMPLETE'].includes(receipt.status);
    if (receipt && ['SUBMITTING', 'PENDING', 'FAILED'].includes(receipt.status)) {
      unresolved.push({
        operationId: `legacy:${enrollment.id}:${receiptKey}:${field}:pending`,
        accountId: enrollment.accountId,
        kind,
        state: 'ambiguous',
        resourceKeys: [],
      });
      continue;
    }
    if (!providerId) {
      if (receiptCanHaveResource) unresolved.push({
        operationId: `legacy:${enrollment.id}:${receiptKey}:${field}:missing`,
        accountId: enrollment.accountId,
        kind,
        state: 'ambiguous',
        resourceKeys: [],
      });
      continue;
    }
    if (known.has(`${resourceKind}:${providerId}`)) continue;
    unresolved.push({
      operationId: `legacy:${enrollment.id}:${receiptKey}:${field}`,
      accountId: enrollment.accountId,
      kind,
      state: 'ambiguous',
      resourceKeys: [],
    });
  }
  for (const [receiptKey, receipt] of Object.entries(enrollment.providerReceipts || {})) {
    if (!['avatar:asset', 'voice:asset', 'avatar:create', 'voice:create'].includes(receiptKey)
      || !receipt || typeof receipt !== 'object' || !['SUBMITTING', 'ACCEPTED', 'COMPLETE', 'PENDING', 'FAILED'].includes(receipt.status)) {
      unresolved.push({ operationId: `legacy:${enrollment.id}:unknown:${sha256(String(receiptKey)).slice(0, 16)}`, accountId: enrollment.accountId, kind: 'resource_read', state: 'ambiguous', resourceKeys: [] });
    }
  }
  return unresolved;
}

async function snapshotTx(tx, { accountId, enrollmentId, candidate, target, now }) {
  const [enrollment] = await tx.select().from(identityVideoEnrollments).where(and(
    eq(identityVideoEnrollments.id, enrollmentId),
    eq(identityVideoEnrollments.accountId, accountId),
  )).limit(1);
  if (!enrollment) throw failure('Enrollment not found.', 404, 'OWNERSHIP');
  const sourceSha256 = digest(candidate?.sourceSha256, 'candidate.sourceSha256');
  const adapterSha256 = digest(candidate?.adapterSha256, 'candidate.adapterSha256');
  const environment = exactText(target?.environment, 'target.environment', 80);
  const projectId = exactText(target?.projectId, 'target.projectId');
  const databaseBindingSha256 = digest(target?.databaseBindingSha256, 'target.databaseBindingSha256');

  const bindings = await tx.select().from(providerAccountBindings).where(and(
    eq(providerAccountBindings.applicationAccountId, accountId),
    eq(providerAccountBindings.provider, 'heygen'),
    eq(providerAccountBindings.environment, environment),
    eq(providerAccountBindings.projectId, projectId),
  )).orderBy(desc(providerAccountBindings.createdAt));
  const binding = bindings.find(item => item.lifecycleState === 'active') || bindings[0] || null;
  let bindingState = 'provisional';
  let providerAccountFingerprint = null;
  let verifiedScopeId = null;
  if (binding?.lifecycleState === 'revoked') bindingState = 'revoked';
  else if (binding) {
    const promotions = await tx.select().from(providerAccountBindingPromotions).where(eq(providerAccountBindingPromotions.bindingId, binding.id)).orderBy(desc(providerAccountBindingPromotions.observedAt));
    const verified = promotions.find(item => item.state === 'verified');
    if (verified) {
      const [scope] = await tx.select().from(providerVerifiedAccountScopes).where(eq(providerVerifiedAccountScopes.id, verified.verifiedAccountScopeId)).limit(1);
      if (scope) {
        bindingState = 'verified';
        verifiedScopeId = scope.id;
        providerAccountFingerprint = scope.providerAccountFingerprint;
      }
    } else if (promotions.some(item => item.state === 'conflict')) bindingState = 'conflict';
  }
  if (binding && binding.databaseBindingSha256 !== databaseBindingSha256) bindingState = 'conflict';

  const targetPredicates = [eq(providerLifecycleOperations.enrollmentId, enrollment.id)];
  if (enrollment.identityId) targetPredicates.push(eq(providerLifecycleOperations.identityId, enrollment.identityId));
  const operationTarget = targetPredicates.length === 1 ? targetPredicates[0] : or(...targetPredicates);
  const operationRows = await tx.select().from(providerLifecycleOperations).where(and(
    eq(providerLifecycleOperations.applicationAccountId, accountId),
    operationTarget,
  ));
  const operationIds = operationRows.map(item => item.id);
  const resourceRows = operationIds.length
    ? await tx.select().from(providerResources).where(inArray(providerResources.originOperationId, operationIds))
    : [];
  const resourceIds = resourceRows.map(item => item.id);
  const referenceRows = resourceIds.length
    ? await tx.select().from(providerConsumerReferences).where(inArray(providerConsumerReferences.resourceId, resourceIds))
    : [];
  const eventRows = operationIds.length
    ? await tx.select().from(providerLifecycleEvents).where(inArray(providerLifecycleEvents.operationId, operationIds)).orderBy(desc(providerLifecycleEvents.observedAt))
    : [];

  const children = new Map();
  for (const resource of resourceRows) {
    if (resource.parentResourceId) children.set(resource.parentResourceId, [...(children.get(resource.parentResourceId) || []), resource.id]);
  }
  const refsByResource = new Map();
  for (const reference of referenceRows) refsByResource.set(reference.resourceId, [...(refsByResource.get(reference.resourceId) || []), reference]);
  const operationById = new Map(operationRows.map(operation => [operation.id, operation]));
  const resources = resourceRows.map(resource => {
    const resourceEvents = eventRows.filter(item => item.resourceId === resource.id);
    const memberResourceKeys = (children.get(resource.id) || []).sort();
    const latestMembershipEvent = resource.kind === 'avatar_group'
      ? resourceEvents.find(item => item.eventType === 'provider.avatar_group_membership')
      : null;
    const membershipOperation = latestMembershipEvent ? operationById.get(latestMembershipEvent.operationId) : null;
    const observedMembers = Array.isArray(latestMembershipEvent?.details?.memberResourceKeys)
      ? [...latestMembershipEvent.details.memberResourceKeys].filter(value => typeof value === 'string').sort()
      : [];
    const validUntil = new Date(latestMembershipEvent?.details?.validUntil || 0);
    const observedAt = new Date(latestMembershipEvent?.observedAt || 0);
    const membershipComplete = latestMembershipEvent?.details?.membershipComplete === true
      && latestMembershipEvent.outcome === 'PRESENT'
      && membershipOperation?.kind === 'resource_read'
      && membershipOperation.state === 'succeeded'
      && membershipOperation.bindingId === resource.bindingId
      && membershipOperation.originScopeKey === resource.originScopeKey
      && binding?.id === resource.bindingId
      && Number.isFinite(observedAt.getTime()) && observedAt <= now
      && Number.isFinite(validUntil.getTime()) && validUntil > now
      && validUntil.getTime() <= observedAt.getTime() + 7 * 24 * 60 * 60 * 1000
      && JSON.stringify(observedMembers) === JSON.stringify(memberResourceKeys);
    const membershipState = membershipComplete
      ? 'complete'
      : latestMembershipEvent?.details?.membershipComplete === false ? 'incomplete' : 'unknown';
    return {
      resourceKey: resource.id,
      accountId: resource.applicationAccountId,
      kind: resource.kind,
      providerResourceId: resource.providerResourceId,
      originOperationId: resource.originOperationId,
      state: resource.state,
      sourceSha256: resource.sourceSha256,
      sourceBytes: resource.sourceBytes,
      voiceNamespace: resource.voiceNamespace,
      dependencies: (refsByResource.get(resource.id) || [])
        .filter(item => item.consumerKind === 'provider_resource' && item.state !== 'released' && resourceIds.includes(item.consumerId))
        .map(item => item.consumerId).sort(),
      parentResourceKey: resource.parentResourceId,
      membership: resource.kind === 'avatar_group'
        ? { state: membershipState, memberResourceKeys }
        : null,
    };
  });
  const resourceKeysByOperation = new Map();
  for (const resource of resources) resourceKeysByOperation.set(resource.originOperationId, [...(resourceKeysByOperation.get(resource.originOperationId) || []), resource.resourceKey]);
  const operations = operationRows.map(operation => ({
    operationId: operation.id,
    accountId: operation.applicationAccountId,
    kind: operation.kind,
    state: operation.state,
    resourceKeys: (resourceKeysByOperation.get(operation.id) || []).sort(),
  }));
  for (const operation of operationRows) {
    const sourceMatches = operation.kind === 'avatar_create'
      ? operation.sourceSha256 === enrollment.photoSha256
      : operation.kind === 'voice_clone'
        ? operation.sourceSha256 === enrollment.derivedAudioSha256
        : operation.kind === 'asset_upload'
          ? [enrollment.photoSha256, enrollment.derivedAudioSha256].includes(operation.sourceSha256)
          : operation.kind === 'video_create' ? operation.sourceSha256 === null && operation.sourceBytes === null : true;
    if (!sourceMatches) operations.push({
      operationId: `source-conflict:${operation.id}`,
      accountId,
      kind: 'resource_read',
      state: 'ambiguous',
      resourceKeys: [],
    });
  }
  for (const resource of resourceRows) {
    if (!verifiedScopeId || resource.verifiedAccountScopeId !== verifiedScopeId
      || resource.bindingId !== binding?.id || resource.originScopeKey !== binding?.originScopeKey) {
      operations.push({
        operationId: `scope-conflict:${resource.id}`,
        accountId,
        kind: 'resource_read',
        state: 'ambiguous',
        resourceKeys: [],
      });
    }
  }
  operations.push(...legacyReceiptOperations(enrollment, resourceRows));
  const conflictEventTypes = new Set([
    'provider.operation_ambiguous', 'provider.resource_after_terminal_operation',
    'provider.resource_ownership_conflict', 'provider.resource_parent_conflict',
    'provider.resource_kind_conflict', 'provider.resource_source_conflict',
    'provider.operation_missing_resource',
  ]);
  for (const lifecycleEvent of eventRows) {
    const unresolvedObservedId = !lifecycleEvent.resourceId && Boolean(lifecycleEvent.observedProviderResourceId);
    if (conflictEventTypes.has(lifecycleEvent.eventType) || lifecycleEvent.eventType === 'remote_id.conflict' || unresolvedObservedId) operations.push({
      operationId: `event-conflict:${lifecycleEvent.id}`,
      accountId,
      kind: 'resource_read',
      state: 'ambiguous',
      resourceKeys: [],
    });
  }
  if (['PENDING', 'FAILED'].includes(enrollment.providerReconciliationStatus)) operations.push({
    operationId: `enrollment-hold:${enrollment.id}:${enrollment.providerReconciliationStatus.toLowerCase()}`,
    accountId,
    kind: 'resource_read',
    state: 'ambiguous',
    resourceKeys: [],
  });
  const references = referenceRows.map(reference => ({
    referenceId: reference.id,
    accountId: reference.applicationAccountId,
    resourceKey: reference.resourceId,
    consumerKind: reference.consumerKind,
    consumerId: reference.consumerId,
    state: reference.state,
  }));

  return {
    version: HEYGEN_RECONCILIATION_SNAPSHOT_VERSION,
    capturedAt: now.toISOString(),
    candidate: { candidateId: `source:${sourceSha256}`, sourceSha256, adapterSha256 },
    target: {
      environment,
      projectId,
      applicationAccountId: accountId,
      databaseBindingSha256,
      provider: 'heygen',
      providerAccountFingerprint,
      providerAccountBindingState: bindingState,
      credentialScopeFingerprint: binding?.credentialScopeFingerprint || null,
      apiVersion: 'v3',
    },
    resources,
    references,
    operations,
  };
}

export async function getProviderReconciliationSnapshot(input, { executor = database() } = {}) {
  const now = input?.now instanceof Date ? input.now : new Date(input?.now || Date.now());
  if (!Number.isFinite(now.getTime())) throw failure('Snapshot time is invalid.', 400, 'VALIDATION');
  return executor.transaction(tx => snapshotTx(tx, { ...input, now }), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

export async function getProviderReconciliationStatus(input, options) {
  const snapshot = await getProviderReconciliationSnapshot(input, options);
  return {
    version: snapshot.version,
    capturedAt: snapshot.capturedAt,
    providerAccountBindingState: snapshot.target.providerAccountBindingState,
    counts: {
      resources: snapshot.resources.length,
      references: snapshot.references.length,
      operations: snapshot.operations.length,
      ambiguousOperations: snapshot.operations.filter(item => item.state === 'ambiguous').length,
      activeReferences: snapshot.references.filter(item => item.state !== 'released').length,
    },
    execution: providerReconciliationExecutionStatus(),
  };
}

export function providerReconciliationExecutionStatus() {
  return Object.freeze({ enabled: false, reason: 'execution_not_implemented' });
}

// Default-disabled, contained by VIDEO_OS_PROVIDER_CREATION_ENABLED so it can
// be turned on/off instantly without a redeploy. Real blast radius is still
// bounded separately: only accounts already holding a standardRendering/
// liveRendering entitlement (testers/allowlisted accounts, never granted to
// an ordinary new sign-up -- see lib/video-os-security.js's
// containedRenderingEntitlementKeys) can actually reach a HeyGen submission
// even while this reports enabled.
export function providerCreationActivationStatus(env = process.env) {
  const enabled = String(env.VIDEO_OS_PROVIDER_CREATION_ENABLED || '').trim().toLowerCase() === 'true';
  return Object.freeze({
    enabled,
    reason: enabled ? 'owner_authorized_contained_activation' : 'verified_provider_account_binding_not_wired',
  });
}

export async function withProviderLifecycleLock(accountId, callback, { executor = database() } = {}) {
  return executor.transaction(async tx => {
    await acquireProviderLifecycleLock(tx, accountId);
    return callback(tx);
  });
}
