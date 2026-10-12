import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { database } from './client.js';
import { acceptedJobOutput } from '../lib/video-os-output-acceptance.js';
import { accountHash } from '../lib/video-os-security.js';
import { assertPersistedLuxifyJob } from '../lib/luxify-job-binding.js';
import { assertPersistedPremiumPresenterJob, providerVideoOperationRequestDigest } from './repositories.js';
import {
  creditTransactions,
  jobEvents,
  mediaAssets,
  providerConsumerReferences,
  providerLifecycleEvents,
  providerLifecycleOperations,
  providerResources,
  videoJobs,
} from './schema.js';

const HASH = /^[a-f0-9]{64}$/u;
const ACCOUNT_HASH = /^[a-f0-9]{24}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{5,254}$/u;
const RENDER_MODES = Object.freeze({
  premium_presenter_v1: 'avatar',
  luxify_cinematic_v1: 'cinematic_avatar',
});
const BINDING_KEYS = Object.freeze([
  'proofId', 'jobId', 'correlationId', 'accountHash', 'deploymentIdHash',
  'sourceCommitHash', 'deploymentMode', 'renderMode',
]);

export class P0JobAttestationError extends Error {
  constructor(code, statusCode = 409) {
    super('P0 job attestation is unavailable.');
    this.name = 'P0JobAttestationError';
    this.code = code;
    this.statusCode = statusCode;
    this.failureCategory = 'P0_ATTESTATION';
  }
}

const sha256 = value => createHash('sha256').update(String(value || '')).digest('hex');
const fail = (code, statusCode) => { throw new P0JobAttestationError(code, statusCode); };

function exactBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== BINDING_KEYS.length
    || BINDING_KEYS.some(key => !Object.hasOwn(value, key))) {
    fail('binding_required', 400);
  }
  if (!UUID_V4.test(String(value.proofId || ''))
    || !SAFE_ID.test(String(value.jobId || ''))
    || !SAFE_ID.test(String(value.correlationId || ''))
    || !ACCOUNT_HASH.test(String(value.accountHash || ''))
    || !HASH.test(String(value.deploymentIdHash || ''))
    || !HASH.test(String(value.sourceCommitHash || ''))
    || value.deploymentMode !== 'production'
    || !Object.hasOwn(RENDER_MODES, value.renderMode)) {
    fail('binding_invalid', 400);
  }
  return value;
}

function exactOne(rows, code) {
  if (!Array.isArray(rows) || rows.length !== 1) fail(code);
  return rows[0];
}

function count(rows, type) {
  return rows.filter(row => row.eventType === type).length;
}

function assertDeployment(binding, env) {
  if (env.VERCEL_ENV !== binding.deploymentMode
    || !env.VERCEL_DEPLOYMENT_ID
    || !env.VERCEL_GIT_COMMIT_SHA
    || sha256(env.VERCEL_DEPLOYMENT_ID) !== binding.deploymentIdHash
    || sha256(env.VERCEL_GIT_COMMIT_SHA) !== binding.sourceCommitHash) {
    fail('deployment_binding_mismatch');
  }
}

function assertJob(binding, job) {
  if (job.id !== binding.jobId
    || job.correlationId !== binding.correlationId
    || accountHash(job.accountId) !== binding.accountHash
    || job.input?.renderMode !== binding.renderMode
    || job.provider !== 'heygen'
    || job.status !== 'ready'
    || job.videoDeletedAt
    || !job.providerJobId
    || !acceptedJobOutput(job)) {
    fail('job_binding_mismatch');
  }
  try {
    if (binding.renderMode === 'premium_presenter_v1') assertPersistedPremiumPresenterJob(job);
    else assertPersistedLuxifyJob(job);
    return providerVideoOperationRequestDigest(job);
  } catch {
    fail('job_binding_mismatch');
  }
}

function assertTimeline(binding, job, rows) {
  const reserved = exactOne(rows.filter(row => row.eventType === 'render.reserved'), 'reservation_event_cardinality');
  if (reserved.id !== binding.proofId || reserved.jobId !== job.id || reserved.correlationId !== job.correlationId) fail('proof_binding_mismatch');
  for (const type of ['provider.submit_started', 'provider.submitted', 'finish.completed']) {
    if (count(rows, type) !== 1) fail('job_event_cardinality');
  }
  for (const type of ['provider.submit_unknown', 'workflow.recovery_reserved', 'workflow.failed']) {
    if (count(rows, type) !== 0) fail('job_event_conflict');
  }
  if (rows.some(row => row.jobId !== job.id || row.correlationId !== job.correlationId)) fail('job_event_binding_mismatch');
  const finish = rows.find(row => row.eventType === 'finish.completed');
  if (finish.details?.sha256 !== job.output.sha256 || finish.details?.bytes !== job.output.bytes) fail('finish_event_mismatch');
}

function assertDebit(job, rows) {
  const debit = exactOne(rows, 'credit_debit_cardinality');
  if (debit.accountId !== job.accountId || debit.sourceType !== 'render'
    || debit.sourceId !== 'render:' + job.id || debit.amount !== -job.costCredits
    || debit.metadata?.jobId !== job.id) fail('credit_debit_mismatch');
  return debit;
}

function assertFinal(job, rows) {
  const final = exactOne(rows, 'final_asset_cardinality');
  const media = job.output.acceptance.media;
  if (final.accountId !== job.accountId || final.jobId !== job.id || final.kind !== 'final'
    || final.privatePathname !== job.output.privatePathname
    || final.sha256 !== job.output.sha256 || final.bytes !== job.output.bytes
    || final.contentType !== 'video/mp4' || final.quarantinedAt
    || final.widthPx !== media.width || final.heightPx !== media.height
    || final.durationMs !== Math.round(media.durationMs)) fail('final_asset_mismatch');
}

function assertProviderGraph(job, operations, resources, references, events, expectedRequestDigest) {
  const operation = exactOne(operations, 'provider_operation_cardinality');
  if (operation.applicationAccountId !== job.accountId || operation.jobId !== job.id
    || operation.correlationId !== job.correlationId || operation.kind !== 'video_create'
    || operation.originOperationKey !== job.id
    || operation.attempt !== 1 || operation.state !== 'succeeded'
    || !operation.submittedAt || !operation.completedAt
    || operation.requestDigest !== expectedRequestDigest
    || operation.enrollmentId !== null
    || (job.input.renderMode === 'premium_presenter_v1' && operation.identityId !== job.input.identityId)
    || (job.input.renderMode === 'luxify_cinematic_v1' && operation.identityId !== null)) {
    fail('provider_operation_mismatch');
  }
  const resource = exactOne(resources, 'provider_resource_cardinality');
  if (resource.applicationAccountId !== job.accountId || resource.bindingId !== operation.bindingId
    || resource.originScopeKey !== operation.originScopeKey || resource.originOperationId !== operation.id
    || resource.kind !== 'video' || resource.providerResourceId !== job.providerJobId
    || resource.state !== 'ready' || !resource.verifiedAccountScopeId) fail('provider_resource_mismatch');
  const reference = exactOne(references, 'provider_reference_cardinality');
  if (reference.applicationAccountId !== job.accountId || reference.originScopeKey !== operation.originScopeKey
    || reference.resourceId !== resource.id || reference.originOperationId !== operation.id
    || reference.consumerKind !== 'job' || reference.consumerId !== job.id
    || reference.state !== 'released') fail('provider_reference_mismatch');
  const required = [
    'provider.operation_reserved', 'provider.operation_claimed', 'provider.resource_observed',
    'provider.resource_ready', 'provider.consumer_released_after_private_acceptance',
  ];
  if (events.length !== required.length
    || required.some(type => count(events, type) !== 1)
    || events.some(event => event.applicationAccountId !== job.accountId
      || event.originScopeKey !== operation.originScopeKey || event.operationId !== operation.id
      || event.correlationId !== job.correlationId
      || /(?:conflict|ambiguous|failed|missing)/iu.test(event.eventType))) fail('provider_event_mismatch');
  const observed = events.find(event => event.eventType === 'provider.resource_observed');
  const ready = events.find(event => event.eventType === 'provider.resource_ready');
  const released = events.find(event => event.eventType === 'provider.consumer_released_after_private_acceptance');
  if (observed.resourceId !== resource.id || observed.observedResourceKind !== 'video'
    || observed.observedProviderResourceId !== job.providerJobId
    || ready.resourceId !== resource.id || ready.observedResourceKind !== 'video'
    || ready.observedProviderResourceId !== job.providerJobId
    || !HASH.test(String(ready.details?.sourceUrlDigest || ''))
    || released.resourceId !== resource.id || released.referenceId !== reference.id
    || released.details?.consumerKind !== 'job' || released.details?.consumerId !== job.id) {
    fail('provider_event_binding_mismatch');
  }
  return { operation, resource, reference };
}

function safeTimestamp(value) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) fail('snapshot_timestamp_invalid');
  return timestamp.toISOString();
}

export async function getP0JobAttestation(bindingInput, { databaseFactory = database, env = process.env } = {}) {
  const binding = exactBinding(bindingInput);
  assertDeployment(binding, env);
  return databaseFactory().transaction(async tx => {
    const job = exactOne(await tx.select().from(videoJobs).where(eq(videoJobs.id, binding.jobId)).limit(2), 'job_cardinality');
    const expectedRequestDigest = assertJob(binding, job);
    const events = await tx.select().from(jobEvents).where(eq(jobEvents.jobId, job.id));
    assertTimeline(binding, job, events);
    const debits = await tx.select().from(creditTransactions).where(and(
      eq(creditTransactions.sourceType, 'render'), eq(creditTransactions.sourceId, 'render:' + job.id),
    ));
    const debit = assertDebit(job, debits);
    const finals = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.jobId, job.id), eq(mediaAssets.kind, 'final')));
    assertFinal(job, finals);
    const operations = await tx.select().from(providerLifecycleOperations).where(and(
      eq(providerLifecycleOperations.jobId, job.id), eq(providerLifecycleOperations.kind, 'video_create'),
    ));
    const operationIds = operations.map(operation => operation.id);
    if (!operationIds.length) fail('provider_operation_cardinality');
    const resources = await tx.select().from(providerResources).where(and(
      inArray(providerResources.originOperationId, operationIds), eq(providerResources.kind, 'video'),
    ));
    const resourceIds = resources.map(resource => resource.id);
    if (!resourceIds.length) fail('provider_resource_cardinality');
    const references = await tx.select().from(providerConsumerReferences).where(and(
      inArray(providerConsumerReferences.resourceId, resourceIds),
      eq(providerConsumerReferences.consumerKind, 'job'), eq(providerConsumerReferences.consumerId, job.id),
    ));
    const providerEvents = await tx.select().from(providerLifecycleEvents).where(inArray(providerLifecycleEvents.operationId, operationIds));
    const graph = assertProviderGraph(job, operations, resources, references, providerEvents, expectedRequestDigest);
    const snapshot = await tx.execute(sql.raw('select transaction_timestamp() as observed_at'));
    const observedAtUtc = safeTimestamp(snapshot.rows?.[0]?.observed_at);
    return Object.freeze({
      version: 'video-os-p0-job-attestation/v1',
      ok: true,
      applicationSnapshotComplete: true,
      providerNativeVerified: false,
      sourceByteAttested: false,
      artifactBytesAttested: false,
      observedAtUtc,
      binding: {
        proofId: binding.proofId, jobId: job.id, correlationId: job.correlationId,
        providerJobId: job.providerJobId, accountHash: binding.accountHash,
        renderMode: binding.renderMode, providerCapability: RENDER_MODES[binding.renderMode],
      },
      // These identify the environment reading the snapshot. They do not
      // attest which deployment or source bytes originally created the job.
      readerDeployment: {
        deploymentIdHash: binding.deploymentIdHash,
        deploymentMode: binding.deploymentMode,
      },
      readerEnvironmentGitCommit: {
        commitHash: binding.sourceCommitHash,
      },
      counts: {
        reservationEvents: 1, providerSubmissionEvents: 1, providerOperations: 1,
        providerVideoResources: 1, providerConsumerReferences: 1, creditDebits: 1,
        finalAssets: 1, finalEvents: 1, recoveryEvents: 0,
      },
      provider: {
        operationState: graph.operation.state, operationAttempt: graph.operation.attempt,
        requestDigest: graph.operation.requestDigest, resourceState: graph.resource.state,
        referenceState: graph.reference.state,
      },
      credit: { amount: debit.amount, costCredits: job.costCredits },
      finalMediaRecord: {
        sha256: job.output.sha256, bytes: job.output.bytes,
        privatePathDigest: sha256(job.output.privatePathname), titleDigest: sha256(job.title),
        bytesReadbackAttested: false,
        media: {
          fullDecode: job.output.acceptance.media.fullDecode,
          videoStreams: job.output.acceptance.media.videoStreams,
          audioStreams: job.output.acceptance.media.audioStreams,
          width: job.output.acceptance.media.width, height: job.output.acceptance.media.height,
          durationMs: job.output.acceptance.media.durationMs,
        },
      },
    });
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
