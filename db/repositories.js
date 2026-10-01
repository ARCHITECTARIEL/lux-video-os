import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { database } from './client.js';
import { acceptedJobOutput } from '../lib/video-os-output-acceptance.js';
import { acceptStoredFinalOutput } from '../services/accept-stored-final-output.js';
import { configuredPremiumIdentity, renderAuthorization, assertJobAuthorizationBinding, stableJson } from '../lib/video-os-render-authorization.js';
import { IDENTITY_CONSENT_POLICY_VERSION } from '../lib/video-os-identity-policy.js';
import { ENROLLMENT_CONSENT_POLICY_VERSION } from '../lib/enrollment-policy.js';
import { SCRIPTED_PHOTO_CONTRACT_VERSION, assertScriptedPhotoJobActivation, isScriptedPhotoRequest, renderTierForJob, renderTierForReservation, scriptedPhotoActivation } from '../lib/scripted-photo-contract.js';
import { digestScriptedPhotoSourceBinding, safeScriptedPhotoQuoteProof, verifyScriptedPhotoQuote } from '../lib/scripted-photo-quote.js';
import { assertEnrollmentConsentRecord } from './enrollment-repository.js';
import { acquireProviderLifecycleLock } from './provider-lifecycle-lock.js';
import { assertHeygenProviderReceiptTx, withFreshHeygenSpaceBindingTransaction, withHeygenSpaceBindingReceiptTransaction } from './heygen-space-binding-repository.js';
import { assertProviderIdentityReferencesActiveTx, assertProviderJobReferencesActiveTx, attachProviderConsumerReferenceTx, getExactProviderResourceTx, markProviderResourceReadyTx, markProviderVideoReadyTx, providerOperationRequestDigest, recordProviderJobSubmissionUnknownTx, recordProviderVideoResourceTx, releaseProviderVideoConsumerTx, reserveProviderOperationTx } from './provider-reconciliation-repository.js';
import { authSessions, creditAccounts, creditTransactions, entitlements, identityConsents, identityEnrollmentEvents, identityVideoEnrollments, jobEvents, mediaAssets, projects, providerLifecycleEvents, rateLimits, stripeEvents, userIdentities, users, videoJobs } from './schema.js';

export const IDENTITY_COMPONENT_STATUSES = Object.freeze(['DRAFT', 'UPLOADING', 'CREATING', 'PROCESSING', 'READY', 'FAILED']);
export const IDENTITY_OVERALL_STATUSES = Object.freeze(['DRAFT', 'UPLOADING', 'CREATING_AVATAR', 'CLONING_VOICE', 'PROCESSING', 'READY', 'PARTIAL_FAILURE', 'FAILED', 'ARCHIVED']);
const AUTH_ENTITLEMENT_SOURCE = 'validated_auth';

export function reconcileAuthenticatedEntitlements(existingGrants = [], entitlementKeys = []) {
  // Explicit admin revocation wins over every later sign-in, including workspace
  // password login. Only a new admin grant restores a revoked tier.
  const independent = new Set(existingGrants.filter(grant => grant.sourceType === 'admin_tester_grant').map(grant => grant.entitlementKey));
  const desiredKeys = [...new Set(entitlementKeys)].filter(key => !independent.has(key));
  const desired = new Set(desiredKeys);
  const collision = existingGrants.find((grant) => desired.has(grant.entitlementKey) && grant.sourceType !== AUTH_ENTITLEMENT_SOURCE);
  if (collision) throw Object.assign(new Error('Authenticated entitlement conflicts with another authority.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  return {
    desiredKeys,
    disableKeys: existingGrants.filter((grant) => grant.sourceType === AUTH_ENTITLEMENT_SOURCE && grant.enabled && !desired.has(grant.entitlementKey)).map((grant) => grant.entitlementKey),
    preservedKeys: existingGrants.filter((grant) => grant.sourceType !== AUTH_ENTITLEMENT_SOURCE && grant.enabled).map((grant) => grant.entitlementKey),
  };
}

const ACTIVE_COMPONENT_STATUSES = new Set(['UPLOADING', 'CREATING', 'PROCESSING']);

export function deriveIdentityStatus({ avatarStatus = 'DRAFT', voiceStatus = 'DRAFT', archivedAt = null } = {}) {
  if (archivedAt) return 'ARCHIVED';
  if (avatarStatus === 'READY' && voiceStatus === 'READY') return 'READY';
  if (avatarStatus === 'FAILED' && voiceStatus === 'FAILED') return 'FAILED';
  if (avatarStatus === 'FAILED' || voiceStatus === 'FAILED') return 'PARTIAL_FAILURE';
  if (avatarStatus === 'UPLOADING' || voiceStatus === 'UPLOADING') return 'UPLOADING';
  if (avatarStatus === 'CREATING' && voiceStatus === 'DRAFT') return 'CREATING_AVATAR';
  if (voiceStatus === 'CREATING' && avatarStatus === 'DRAFT') return 'CLONING_VOICE';
  if (ACTIVE_COMPONENT_STATUSES.has(avatarStatus) || ACTIVE_COMPONENT_STATUSES.has(voiceStatus)) return 'PROCESSING';
  return 'DRAFT';
}

export async function ensureAccount({ accountId, email, name, initialCredits = 0 }) {
  return database().transaction(async (tx) => {
    await tx.insert(users).values({ id: accountId, email: email || null, name: name || 'Video OS Account' }).onConflictDoNothing();
    await tx.insert(creditAccounts).values({ accountId, balance: initialCredits }).onConflictDoNothing();
    return getAccount(accountId, tx);
  });
}

export async function updateAuthenticatedAccount({ accountId, email, name, role = 'customer', initialCredits = 0, entitlementKeys = [], sourceId = null, registerAsTester = false }) {
  return database().transaction(async (tx) => {
    const now = new Date();
    await tx.insert(users).values({ id: accountId, email: email || null, name: name || 'Video OS Account', role })
      .onConflictDoUpdate({ target: users.id, set: { email: email || null, name: name || 'Video OS Account', role, updatedAt: now } });
    // Credit floor for explicitly configured testers; never an authorization grant.
    if (registerAsTester && initialCredits > 0) {
      await tx.insert(creditAccounts).values({ accountId, balance: initialCredits })
        .onConflictDoUpdate({
          target: creditAccounts.accountId,
          set: {
            balance: sql`greatest(${creditAccounts.balance}, ${initialCredits})`,
            updatedAt: now,
          },
        });
    } else {
      await tx.insert(creditAccounts).values({ accountId, balance: initialCredits }).onConflictDoNothing();
    }
    const existingGrants = await tx.select().from(entitlements).where(eq(entitlements.accountId, accountId));
    if (existingGrants.some(grant => grant.sourceType === 'admin_tester_grant' && grant.entitlementKey === 'tester'
      && grant.enabled && (!grant.expiresAt || new Date(grant.expiresAt) > now))) {
      await tx.update(users).set({ role: 'tester' }).where(eq(users.id, accountId));
    }
    const { desiredKeys } = reconcileAuthenticatedEntitlements(existingGrants, entitlementKeys);
    await tx.update(entitlements).set({ enabled: false, updatedAt: now }).where(and(eq(entitlements.accountId, accountId), eq(entitlements.sourceType, AUTH_ENTITLEMENT_SOURCE), eq(entitlements.enabled, true)));
    for (const entitlementKey of desiredKeys) await tx.insert(entitlements).values({ accountId, entitlementKey, enabled: true, sourceType: AUTH_ENTITLEMENT_SOURCE, sourceId })
      .onConflictDoUpdate({ target: [entitlements.accountId, entitlements.entitlementKey], set: { enabled: true, sourceType: AUTH_ENTITLEMENT_SOURCE, sourceId, updatedAt: now } });
    return getAccountContext(accountId, tx);
  });
}

// The actual session mechanism (lib/video-os-account.js's makeSession) is a
// stateless signed cookie -- no DB row per login, by design, so it scales
// without session-table writes on every authenticated request. That means
// there is nowhere sign-in *frequency* is recorded. This writes one durable
// row per completed sign-in (not per request) purely for admin-visible
// analytics ("how many times has this account signed in, and when") --
// auth_sessions already existed in the schema for exactly this, just never
// written to. sessionHash has no relationship to the actual cookie token
// (nothing looks it up to validate a session); it only exists to satisfy
// the column's not-null/unique constraint.
export async function recordSignIn(accountId, maxAgeSeconds = 60 * 60 * 24 * 30) {
  'use step';
  try {
    const now = new Date();
    // Deliberately never references a statically-imported `node:crypto` binding:
    // this function runs inside a Vercel `workflow` step, whose bundler bans any
    // reference to a Node built-in module at build time regardless of a runtime
    // typeof-guard around it (that guard doesn't help -- the bundler can't see
    // through it). globalThis.crypto is a runtime property read on the Web
    // Crypto global, not a module import, so it isn't subject to that ban.
    const sessionHash = globalThis.crypto?.getRandomValues
      ? Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(24))).toString('hex')
      : (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));
    await database().insert(authSessions).values({
      accountId,
      sessionHash,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + maxAgeSeconds * 1000),
      lastSeenAt: now,
    });
  } catch {
    // best-effort analytics; a failure here must never block sign-in itself
  }
}

export async function getAccount(accountId, executor = database()) {
  const rows = await executor.select({ user: users, credits: creditAccounts }).from(users).innerJoin(creditAccounts, eq(users.id, creditAccounts.accountId)).where(eq(users.id, accountId)).limit(1);
  return rows[0] || null;
}

// Identity lookup alone grants no access. Session issuance still requires verified
// credentials. Preserve legacy admin IDs across link requests and verified sign-in.
export async function authenticatedAccountId(preferredId, email) {
  const matches = await database().select().from(users).where(sql`lower(${users.email}) = ${String(email).trim().toLowerCase()}`).limit(2);
  if (matches.length > 1) throw Object.assign(new Error('Account identity requires reconciliation.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  const [existing] = matches;
  return existing?.id || preferredId;
}

export async function getAccountContext(accountId, executor = database()) {
  const account = await getAccount(accountId, executor);
  if (!account) return null;
  const grants = await executor.select().from(entitlements).where(and(eq(entitlements.accountId, accountId), eq(entitlements.enabled, true)));
  return { ...account, entitlements: Object.fromEntries(usableAccountGrants(accountId, account.user.email, grants).map((grant) => [grant.entitlementKey, true])) };
}

function usableAccountGrants(accountId, email, grants, now = new Date()) {
  return grants.filter(grant => grant.enabled === true && (!grant.expiresAt || new Date(grant.expiresAt) > now)
    && (!['liveRendering', 'fullAccess', 'ownerAccess'].includes(grant.entitlementKey)
      || grant.sourceType !== AUTH_ENTITLEMENT_SOURCE || grant.sourceId === 'workspace_password'
      || configuredPremiumIdentity(accountId, email)));
}

export async function requirePersistedRenderAuthorization(accountId, tier, executor = database()) {
  const grants = await executor.select().from(entitlements).where(eq(entitlements.accountId, accountId)).for('share');
  const [user] = await executor.select().from(users).where(eq(users.id, accountId)).limit(1);
  // Reject historical auth-derived Premium overgrants from the domain/registry leak.
  const eligible = user ? usableAccountGrants(accountId, user.email, grants) : [];
  return renderAuthorization(accountId, tier, eligible);
}

export async function requireJobRenderAuthorization(job, tier) {
  assertJobAuthorizationBinding(job, tier);
  return requirePersistedRenderAuthorization(job.accountId, tier);
}

const sha256Text = value => createHash('sha256').update(String(value || '')).digest('hex');

function withoutServerRenderProof(input = {}) {
  const { renderAuthorization: _authorization, quoteProof: _quoteProof, ...intent } = input;
  return intent;
}

function scriptedClientIntent(input = {}) {
  return Object.fromEntries(['contractVersion', 'tier', 'projectId', 'identityId', 'script'].map(key => [key, input[key]]));
}

function assertPersistedScriptedQuoteProof(job, intent) {
  const proof = safeScriptedPhotoQuoteProof(job.input?.quoteProof);
  if (proof.accountSha256 !== sha256Text(job.accountId) || proof.projectId !== intent.projectId || proof.identityId !== intent.identityId
    || proof.idempotencyKeySha256 !== sha256Text(job.idempotencyKey) || proof.titleSha256 !== sha256Text(job.title)
    || proof.scriptSha256 !== sha256Text(intent.script) || proof.format !== job.format || proof.tier !== intent.tier
    || proof.sourceBindingSha256 !== digestScriptedPhotoSourceBinding(intent.sourceBinding) || proof.credits !== job.costCredits) {
    throw Object.assign(new Error('Persisted scripted-photo quote proof does not match the reserved job.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  }
  return proof;
}

export async function reserveRender({ jobId, accountId, idempotencyKey, correlationId, provider, tier, title, format, costCredits, input, quoteToken }) {
  const authorizationTier = renderTierForReservation({ provider, tier, input });
  const scripted = isScriptedPhotoRequest(input);
  return database().transaction(async (tx) => {
    await acquireProviderLifecycleLock(tx, accountId);
    if (scripted) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${accountId}:${idempotencyKey}:scripted-photo-reserve`}, 0))`);
    let account;
    if (!scripted) {
      account = (await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId)).for('update').limit(1))[0];
      if (!account) throw Object.assign(new Error('Credit account not found.'), { statusCode: 404 });
    }
    let existingQuery = tx.select().from(videoJobs).where(and(eq(videoJobs.accountId, accountId), eq(videoJobs.idempotencyKey, idempotencyKey)));
    if (scripted) existingQuery = existingQuery.for('update');
    const existing = await existingQuery.limit(1);
    if (existing[0]) {
      const job = existing[0];
      const savedInput = withoutServerRenderProof(job.input);
      const requestedInput = withoutServerRenderProof(input);
      if (job.provider !== provider || job.title !== title || job.format !== format || job.costCredits !== costCredits
        || JSON.stringify(stableJson(scripted ? scriptedClientIntent(savedInput) : savedInput)) !== JSON.stringify(stableJson(scripted ? scriptedClientIntent(requestedInput) : requestedInput))) {
        throw Object.assign(new Error('Idempotency key belongs to a different render request.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      }
      if (renderTierForJob(job) !== authorizationTier) throw Object.assign(new Error('Idempotency key belongs to a different render tier.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      assertJobAuthorizationBinding(job, authorizationTier);
      if (scripted) assertPersistedScriptedQuoteProof(job, savedInput);
      return { job, replayed: true };
    }
    let reservedInput = input;
    let quoteProof;
    if (scripted) {
      const activation = scriptedPhotoActivation(input.tier);
      if (activation.tier !== authorizationTier || activation.provider !== provider || activation.costCredits !== costCredits) {
        throw Object.assign(new Error('Scripted-photo reservation does not match configured provider or cost.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      }
      account = (await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId)).for('update').limit(1))[0];
      if (!account) throw Object.assign(new Error('Credit account not found.'), { statusCode: 404 });
      const resolved = await resolveScriptedPhotoContext(tx, {
        accountId, projectId: input.projectId, identityId: input.identityId, title, script: input.script, tier: input.tier,
      }, { lock: true });
      if (resolved.project.settings?.format !== format) throw Object.assign(new Error('Scripted-photo format no longer matches its saved project.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      reservedInput = resolved.input;
    }
    const authorization = await requirePersistedRenderAuthorization(accountId, authorizationTier, tx);
    if (scripted) {
      const activation = scriptedPhotoActivation(reservedInput.tier);
      if (activation.tier !== authorizationTier || activation.provider !== provider || activation.costCredits !== costCredits) {
        throw Object.assign(new Error('Scripted-photo reservation configuration changed while acquiring its locks.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      }
      const claims = verifyScriptedPhotoQuote(quoteToken, {
        accountId, projectId: reservedInput.projectId, identityId: reservedInput.identityId, idempotencyKey,
        title, script: reservedInput.script, format, tier: reservedInput.tier, sourceBinding: reservedInput.sourceBinding, credits: costCredits,
      });
      quoteProof = safeScriptedPhotoQuoteProof(claims);
    }
    let providerResourcesForJob = [];
    if (provider === 'heygen' && reservedInput?.identityId) {
      const lookId = reservedInput?.sourceBinding?.providerRenderableAvatarId || reservedInput?.avatar?.avatarId;
      const voiceId = reservedInput?.sourceBinding?.providerVoiceId || reservedInput?.voice?.voiceId;
      if (!lookId || !voiceId) throw Object.assign(new Error('Identity provider resources are missing.'), { statusCode: 409, failureCategory: 'PROVIDER_RESOURCE_UNVERIFIED' });
      providerResourcesForJob = [
        await getExactProviderResourceTx(tx, { accountId, kind: 'avatar_look', providerResourceId: lookId, lock: true }),
        await getExactProviderResourceTx(tx, { accountId, kind: 'voice', providerResourceId: voiceId, lock: true }),
      ];
      if (providerResourcesForJob[0].verifiedAccountScopeId !== providerResourcesForJob[1].verifiedAccountScopeId) {
        throw Object.assign(new Error('Identity provider resources are bound to different provider accounts.'), { statusCode: 409, failureCategory: 'PROVIDER_RESOURCE_UNVERIFIED' });
      }
    }
    if (account.balance - account.reserved < costCredits) throw Object.assign(new Error('Insufficient credits.'), { statusCode: 402, failureCategory: 'ENTITLEMENT' });
    await tx.update(creditAccounts).set({ reserved: account.reserved + costCredits, updatedAt: new Date() }).where(eq(creditAccounts.accountId, accountId));
    const [job] = await tx.insert(videoJobs).values({ id: jobId, accountId, projectId: reservedInput.projectId, idempotencyKey, correlationId, provider, status: 'reserved', title, format, costCredits, input: { ...reservedInput, ...(quoteProof ? { quoteProof } : {}), renderAuthorization: { ...authorization, jobId } } }).returning();
    for (const resource of providerResourcesForJob) await attachProviderConsumerReferenceTx(tx, {
      accountId, resourceId: resource.id, consumerKind: 'job', consumerId: job.id, originOperationId: resource.originOperationId,
    });
    await tx.insert(jobEvents).values({ jobId, correlationId, eventType: 'render.reserved', stageTo: 'reserved', details: { costCredits } });
    return { job, replayed: false };
  });
}

const ALLOWED_JOB_TRANSITIONS = Object.freeze({
  reserved: ['workflow_starting', 'workflow_started', 'failed', 'cancelled'],
  workflow_starting: ['workflow_started', 'failed'],
  workflow_started: ['provider_submitting', 'failed'],
  provider_submitting: ['provider_submitted', 'provider_submit_unknown', 'failed'],
  provider_submit_unknown: [],
  provider_submitted: ['provider_rendering', 'provider_ready', 'failed'],
  provider_rendering: ['provider_rendering', 'provider_ready', 'failed'],
  provider_ready: ['finish_contained', 'finishing', 'failed'],
  finish_contained: ['finishing', 'failed'],
  finishing: ['ready', 'failed'],
  ready: [], failed: [], cancelled: [],
});
const PROVIDER_SUBMISSION_CLAIMED_STATUSES = new Set(['provider_submitting', 'provider_submit_unknown', 'provider_submitted', 'provider_rendering', 'provider_ready', 'finish_contained', 'finishing', 'ready']);

export function assertJobTransition(stageFrom, stageTo) {
  if (!(ALLOWED_JOB_TRANSITIONS[stageFrom] || []).includes(stageTo)) throw Object.assign(new Error(`Invalid job transition: ${stageFrom} -> ${stageTo}.`), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  return true;
}

export async function setWorkflowRun(jobId, workflowRunId) {
  return database().transaction(async (tx) => {
    const current = (await tx.select().from(videoJobs).where(eq(videoJobs.id, jobId)).for('update').limit(1))[0];
    if (!current) return null;
    if (current.workflowRunId && current.workflowRunId !== workflowRunId) throw Object.assign(new Error('Workflow run identity conflict.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (current.workflowRunId) return current;
    const [job] = await tx.update(videoJobs).set({ workflowRunId, updatedAt: new Date() }).where(eq(videoJobs.id, jobId)).returning();
    await tx.insert(jobEvents).values({ jobId, correlationId: current.correlationId, eventType: 'workflow.run_recorded', stageFrom: current.status, stageTo: current.status, details: { workflowRunId } });
    return job;
  });
}

export async function claimWorkflowStart(jobId) {
  return database().transaction(async (tx) => {
    const current = (await tx.select().from(videoJobs).where(eq(videoJobs.id, jobId)).for('update').limit(1))[0];
    if (!current || current.status !== 'reserved') return null;
    const [job] = await tx.update(videoJobs).set({ status: 'workflow_started', updatedAt: new Date() }).where(and(eq(videoJobs.id, jobId), eq(videoJobs.status, 'reserved'))).returning();
    if (!job) return null;
    await tx.insert(jobEvents).values({ jobId, correlationId: current.correlationId, eventType: 'workflow.prepared', stageFrom: 'reserved', stageTo: 'workflow_started' });
    return job;
  });
}

export async function getJob(jobId) {
  return (await database().select().from(videoJobs).where(eq(videoJobs.id, jobId)).limit(1))[0] || null;
}

function deepFreezeProviderProof(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreezeProviderProof(nested);
  return Object.freeze(value);
}

export async function prepareProviderVideoRead({ jobId, providerJobId = null, providerBinding }) {
  const accountId = providerBinding?.applicationAccountId;
  return withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding }, async tx => {
    const [job] = await tx.select().from(videoJobs).where(and(
      eq(videoJobs.id, jobId), eq(videoJobs.accountId, accountId),
    )).for('share').limit(1);
    if (!job || job.provider !== 'heygen' || !['provider_submitted', 'provider_rendering', 'provider_ready', 'finishing'].includes(job.status)
      || !job.providerJobId || (providerJobId && providerJobId !== job.providerJobId)) {
      throw Object.assign(new Error('Provider video read does not match the canonical claimed job.'), { statusCode: 409, failureCategory: 'PROVIDER_OPERATION_CONFLICT' });
    }
    await assertProviderJobReferencesActiveTx(tx, {
      accountId,
      jobId: job.id,
      providerBinding,
      expectedResources: [{ kind: 'video', providerResourceId: job.providerJobId }],
    });
    const resource = await getExactProviderResourceTx(tx, {
      accountId, kind: 'video', providerResourceId: job.providerJobId, lock: true,
    });
    let sourceUrlDigest = null;
    if (['provider_ready', 'finishing'].includes(job.status)) {
      const evidence = await tx.select().from(providerLifecycleEvents).where(and(
        eq(providerLifecycleEvents.resourceId, resource.id),
        eq(providerLifecycleEvents.eventType, 'provider.resource_ready'),
      )).orderBy(desc(providerLifecycleEvents.observedAt)).limit(2);
      sourceUrlDigest = evidence.length === 1 ? evidence[0]?.details?.sourceUrlDigest : null;
      if (!/^[a-f0-9]{64}$/.test(String(sourceUrlDigest || ''))) {
        throw Object.assign(new Error('Provider video ready evidence is missing or ambiguous.'), { statusCode: 409, failureCategory: 'PROVIDER_RESOURCE_CONFLICT' });
      }
    }
    return deepFreezeProviderProof({
      version: 'heygen-video-read-claim/v1',
      job: structuredClone(job),
      providerJobId: job.providerJobId,
      operationId: resource.originOperationId,
      resourceId: resource.id,
      sourceUrlDigest,
    });
  });
}

export async function prepareProviderVideoFinish({ jobId, providerBinding }) {
  const prepared = await prepareProviderVideoRead({ jobId, providerBinding });
  if (!['provider_ready', 'finishing'].includes(prepared.job.status)
    || !/^[a-f0-9]{64}$/.test(String(prepared.sourceUrlDigest || ''))) {
    throw Object.assign(new Error('Provider video is not ready for canonical finishing.'), { statusCode: 409, failureCategory: 'PROVIDER_RESOURCE_CONFLICT' });
  }
  return prepared;
}

export function assertFailedRenderRecoveryEligibility(job, { charged = false } = {}) {
  if (!job) throw Object.assign(new Error('Video job not found.'), { statusCode: 404 });
  if (job.status !== 'failed' || !job.providerJobId) throw Object.assign(new Error('Only a failed job with an existing provider result can be recovered.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  const message = String(job.output?.message || '');
  const recoverable = ['Provider media hostname is not allowlisted.', 'Invalid IP address: undefined', 'spawn /var/task/ffmpeg ENOENT'].some((evidence) => message.includes(evidence));
  if (!recoverable) throw Object.assign(new Error('The job did not fail at a verified existing-media recovery boundary.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  if (charged) throw Object.assign(new Error('The render has already been settled.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  return true;
}

export async function reserveFailedRenderRecovery(jobId) {
  const snapshot = await getJob(jobId);
  if (!snapshot) throw Object.assign(new Error('Video job not found.'), { statusCode: 404 });
  return database().transaction(async (tx) => {
    await acquireProviderLifecycleLock(tx, snapshot.accountId);
    const job = (await tx.select().from(videoJobs).where(eq(videoJobs.id, jobId)).for('update').limit(1))[0];
    const sourceId = `render:${jobId}`;
    const charged = await tx.select().from(creditTransactions).where(and(eq(creditTransactions.sourceType, 'render'), eq(creditTransactions.sourceId, sourceId))).limit(1);
    assertFailedRenderRecoveryEligibility(job, { charged: Boolean(charged[0]) });
    const account = (await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, job.accountId)).for('update').limit(1))[0];
    if (!account) throw Object.assign(new Error('Credit account not found.'), { statusCode: 404 });
    if (account.balance - account.reserved < job.costCredits) throw Object.assign(new Error('Insufficient credits for recovery.'), { statusCode: 402, failureCategory: 'ENTITLEMENT' });
    await tx.update(creditAccounts).set({ reserved: account.reserved + job.costCredits, updatedAt: new Date() }).where(eq(creditAccounts.accountId, job.accountId));
    const [recovered] = await tx.update(videoJobs).set({ status: 'provider_submitted', workflowRunId: null, output: {}, failureCategory: null, updatedAt: new Date(), completedAt: null }).where(and(eq(videoJobs.id, jobId), eq(videoJobs.status, 'failed'))).returning();
    if (!recovered) throw Object.assign(new Error('Recovery claim lost.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    await tx.insert(jobEvents).values({ jobId, correlationId: job.correlationId, eventType: 'workflow.recovery_reserved', stageFrom: 'failed', stageTo: 'provider_submitted', details: { costCredits: job.costCredits, existingProviderJob: true } });
    return { job: recovered, reservedCredits: job.costCredits };
  });
}

export async function transitionJob({ jobId, stageTo, eventType, providerJobId, providerBinding, providerSourceUrlDigest, output, failureCategory, details = {} }) {
  if (stageTo === 'ready') throw Object.assign(new Error('Ready requires accepted finalization.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  const bindingClaim = stageTo === 'provider_submitting' && providerBinding != null;
  const bindingReceipt = ['provider_submitted', 'provider_submit_unknown', 'provider_rendering', 'provider_ready', 'finishing', 'finish_contained'].includes(stageTo) && providerBinding != null;
  const bindingTransaction = bindingClaim || bindingReceipt;
  const snapshot = bindingTransaction ? null : await getJob(jobId);
  if (!bindingTransaction && !snapshot) throw Object.assign(new Error('Video job not found.'), { statusCode: 404 });
  const runTransaction = bindingClaim
    ? callback => withFreshHeygenSpaceBindingTransaction({ accountId: providerBinding.applicationAccountId, providerBinding }, callback)
    : bindingReceipt
    ? callback => withHeygenSpaceBindingReceiptTransaction({ accountId: providerBinding.applicationAccountId, providerBinding }, callback)
    : callback => database().transaction(async tx => {
      await acquireProviderLifecycleLock(tx, snapshot.accountId);
      return callback(tx);
    });
  const result = await runTransaction(async (tx) => {
    let providerClaimProof = null;
    const current = (await tx.select().from(videoJobs).where(eq(videoJobs.id, jobId)).for('update').limit(1))[0];
    if (!current) throw Object.assign(new Error('Video job not found.'), { statusCode: 404 });
    const expectedAccountId = bindingTransaction ? providerBinding.applicationAccountId : snapshot.accountId;
    if (current.accountId !== expectedAccountId) throw Object.assign(new Error('Video job ownership changed.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (bindingTransaction && current.provider !== 'heygen') throw Object.assign(new Error('HeyGen binding cannot authorize a different provider.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (current.provider === 'heygen' && ['provider_submitting', 'provider_submitted', 'provider_submit_unknown', 'provider_rendering', 'provider_ready', 'finishing', 'finish_contained'].includes(stageTo)
      && providerBinding == null) {
      throw Object.assign(new Error('Verified HeyGen binding is required for provider state persistence.'), { statusCode: 503, failureCategory: 'MISSING_PROVIDER_ACCOUNT_BINDING' });
    }
    if (stageTo === 'provider_submitting' && PROVIDER_SUBMISSION_CLAIMED_STATUSES.has(current.status)) {
      throw Object.assign(new Error('Provider submission is already claimed and requires reconciliation.'), { statusCode: 409, failureCategory: 'PROVIDER_SUBMIT_UNKNOWN', providerSubmissionPossible: true });
    }
    // Finishing retries may overlap; each uses its own temporary files and the
    // final transaction arbitrates one artifact/debit. Do not fail the live job.
    if (['finishing', 'finish_contained'].includes(stageTo) && current.status === stageTo) return { job: current };
    // A slower poll must not regress or fail a job advanced by another poller.
    if (stageTo === 'provider_ready' && current.provider === 'heygen'
      && ['provider_ready', 'finish_contained', 'finishing', 'ready'].includes(current.status)) {
      await markProviderVideoReadyTx(tx, {
        accountId: current.accountId,
        jobId: current.id,
        providerJobId: providerJobId || current.providerJobId,
        providerBinding,
        sourceUrlDigest: providerSourceUrlDigest,
      });
      return { job: current, ledgerConflict: false, providerClaimProof: null };
    }
    if (['provider_rendering', 'provider_ready'].includes(stageTo)
      && ['provider_ready', 'finish_contained', 'finishing', 'ready'].includes(current.status)) return { job: current };
    assertJobTransition(current.status, stageTo);
    if (stageTo === 'provider_submitting') {
      const tier = renderTierForJob(current);
      assertScriptedPhotoJobActivation(current);
      assertJobAuthorizationBinding(current, tier);
      if (current.provider === 'heygen' && !current.input?.identityId) {
        throw Object.assign(new Error('HeyGen stock talent is not bound to the verified provider-space ledger.'), {
          statusCode: 409,
          failureCategory: 'PROVIDER_RESOURCE_UNVERIFIED',
        });
      }
      // This transaction is the submission authorization boundary. The share
      // lock serializes the claim with grant revocation; already claimed work
      // may finish, but a revocation committed first blocks a new claim.
      await requirePersistedRenderAuthorization(current.accountId, tier, tx);
      if (isScriptedPhotoRequest(current.input)) await assertScriptedPhotoClaimBinding(tx, current);
      else if (current.input?.identityId) {
        const linked = await activeLinkedEnrollment(tx, current.accountId, current.input.identityId, { lock: true });
        const [identity] = await tx.select().from(userIdentities).where(and(
          eq(userIdentities.accountId, current.accountId), eq(userIdentities.id, current.input.identityId), isNull(userIdentities.archivedAt),
        )).for('share').limit(1);
        if (!identity || identity.provider !== 'heygen') throw Object.assign(new Error('Identity is unavailable at provider claim.'), { statusCode: 409, failureCategory: 'CONSENT' });
        const { consent } = await assertActiveIdentityConsent(tx, identity, linked?.consentPolicyVersion || IDENTITY_CONSENT_POLICY_VERSION, { lock: true });
        if (current.input.avatar?.avatarId !== identity.providerRenderableAvatarId
          || current.input.voice?.voiceId !== identity.providerVoiceId
          || consent.photoSha256 !== linked?.photoSha256 || consent.voiceSha256 !== linked?.derivedAudioSha256) {
          throw Object.assign(new Error('Identity provider binding changed before submission.'), { statusCode: 409, failureCategory: 'CONSENT' });
        }
      }
      if (current.input?.identityId) await assertProviderJobReferencesActiveTx(tx, {
        accountId: current.accountId,
        jobId: current.id,
        providerBinding,
        expectedResources: [
          { kind: 'avatar_look', providerResourceId: current.input.avatar?.avatarId },
          { kind: 'voice', providerResourceId: current.input.voice?.voiceId },
        ],
      });
      if (current.provider === 'heygen') {
        const requestDigest = providerOperationRequestDigest({
          version: 'provider-video-request/v1', jobId: current.id, accountId: current.accountId,
          projectId: current.projectId, title: current.title, format: current.format,
          identityId: current.input?.identityId || null, script: current.input?.script || null,
          avatarId: current.input?.avatar?.avatarId || null, voiceId: current.input?.voice?.voiceId || null,
        });
        const ledger = await reserveProviderOperationTx(tx, {
          accountId: current.accountId,
          providerBinding,
          kind: 'video_create',
          originOperationKey: current.id,
          correlationId: current.correlationId,
          enrollmentId: null,
          identityId: current.input?.identityId || null,
          jobId: current.id,
          requestDigest,
        });
        details = { ...details, providerLifecycleOperationId: ledger.operation.id };
        providerClaimProof = Object.freeze({
          version: 'heygen-render-provider-claim/v1',
          operationId: ledger.operation.id,
          operationState: ledger.operation.state,
          requestDigest,
          bindingId: ledger.binding.id,
          originScopeKey: ledger.binding.originScopeKey,
          accountId: current.accountId,
          jobId: current.id,
        });
      }
    }
    let ledgerConflict = false;
    if (stageTo === 'provider_submitted' && current.provider === 'heygen') {
      const receipt = await recordProviderVideoResourceTx(tx, {
        accountId: current.accountId, jobId: current.id, providerJobId, providerBinding,
      });
      ledgerConflict = receipt.conflicts.length > 0;
    }
    if (stageTo === 'provider_submit_unknown' && current.provider === 'heygen') {
      await recordProviderJobSubmissionUnknownTx(tx, {
        accountId: current.accountId, jobId: current.id, providerBinding,
      });
    }
    if (stageTo === 'provider_ready' && current.provider === 'heygen') {
      await markProviderVideoReadyTx(tx, {
        accountId: current.accountId,
        jobId: current.id,
        providerJobId: providerJobId || current.providerJobId,
        providerBinding,
        sourceUrlDigest: providerSourceUrlDigest,
      });
    }
    const terminal = ['ready', 'failed', 'cancelled'];
    const actualStage = ledgerConflict ? 'provider_submit_unknown' : stageTo;
    const actualFailure = ledgerConflict ? 'PROVIDER_SUBMIT_UNKNOWN' : failureCategory || null;
    const [job] = await tx.update(videoJobs).set({ status: actualStage, providerJobId: providerJobId || current.providerJobId, output: output || current.output, failureCategory: actualFailure, updatedAt: new Date(), completedAt: terminal.includes(actualStage) ? new Date() : null }).where(eq(videoJobs.id, jobId)).returning();
    await tx.insert(jobEvents).values({ jobId, correlationId: current.correlationId, eventType: ledgerConflict ? 'provider.receipt_conflict' : eventType, stageFrom: current.status, stageTo: actualStage, failureCategory: actualFailure, details });
    return { job, ledgerConflict, providerClaimProof };
  });
  if (result.ledgerConflict) throw Object.assign(new Error('Provider result requires lifecycle reconciliation.'), { statusCode: 409, failureCategory: 'PROVIDER_SUBMIT_UNKNOWN', providerSubmissionPossible: true });
  return result.providerClaimProof
    ? Object.freeze({ ...result.job, providerClaimProof: result.providerClaimProof })
    : result.job;
}

// Compatibility readback only. New debits belong exclusively to finalizeReadyJob.
export async function finalizeRenderCredit(jobId) {
  const job = await getJob(jobId);
  if (!acceptedJobOutput(job)) throw Object.assign(new Error('Accepted final output is required for settlement.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  const [transaction] = await database().select().from(creditTransactions).where(and(eq(creditTransactions.sourceType, 'render'), eq(creditTransactions.sourceId, `render:${jobId}`))).limit(1);
  if (!transaction) throw Object.assign(new Error('Render settlement is missing.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  if (transaction.accountId !== job.accountId || transaction.amount !== -job.costCredits || transaction.metadata?.jobId !== jobId) {
    throw Object.assign(new Error('Render settlement identity conflicts with the job.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  }
  return { transaction, replayed: true };
}

export async function issueStripeCredit({ stripeEventId, eventType, livemode, payloadSha256, accountId, sessionId, credits }) {
  return database().transaction(async (tx) => {
    const [event] = await tx.insert(stripeEvents).values({ stripeEventId, eventType, livemode, payloadSha256, accountId, sessionId }).onConflictDoNothing().returning();
    if (!event) {
      const existing = (await tx.select().from(stripeEvents).where(eq(stripeEvents.stripeEventId, stripeEventId)).limit(1))[0];
      if (!existing || existing.payloadSha256 !== payloadSha256 || existing.accountId !== accountId || existing.sessionId !== sessionId || existing.livemode !== livemode) throw Object.assign(new Error('Conflicting Stripe event replay.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      return { applied: false, duplicate: true };
    }
    const account = (await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId)).for('update').limit(1))[0];
    if (!account) throw Object.assign(new Error('Credit account not found.'), { statusCode: 404 });
    const balanceAfter = account.balance + credits;
    await tx.update(creditAccounts).set({ balance: balanceAfter, purchased: account.purchased + credits, updatedAt: new Date() }).where(eq(creditAccounts.accountId, accountId));
    await tx.insert(creditTransactions).values({ accountId, sourceType: 'stripe', sourceId: sessionId, amount: credits, balanceAfter, metadata: { sessionId, stripeEventId } });
    await tx.update(stripeEvents).set({ status: 'processed', processedAt: new Date() }).where(eq(stripeEvents.stripeEventId, stripeEventId));
    return { applied: true, duplicate: false, balanceAfter };
  });
}

// Manual admin credit adjustment -- e.g. topping up an account created before
// a trial-credits fix shipped, or a support/goodwill grant. Deliberately
// separate from issueStripeCredit(): this never touches `purchased`, which
// specifically represents money actually paid. idempotencyKey follows the
// same replay-safe pattern as every other credit-affecting write in this
// file (unique on sourceType+sourceId), so a double-submitted admin request
// can never double-grant.
export async function grantAdminCredit({ accountId, amount, note, idempotencyKey }) {
  return database().transaction(async (tx) => {
    // Lock the account row FIRST, before any duplicate check -- this
    // serializes concurrent grants for the same account through this one
    // transaction at a time, closing the race the previous check-then-write
    // order had (two concurrent requests with the same idempotencyKey could
    // both pass an early SELECT, then the second would hit the
    // credit_transactions_source_uq unique constraint on INSERT as a raw,
    // uncaught error instead of a clean duplicate response). The insert
    // below is the actual atomic claim -- onConflictDoNothing() means only
    // one concurrent transaction ever wins it, and because the account
    // stays locked until this transaction commits or rolls back, the loser
    // sees the conflict *before* ever touching creditAccounts.balance, so
    // there's no window where a duplicate could double-apply the amount.
    const account = (await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId)).for('update').limit(1))[0];
    if (!account) throw Object.assign(new Error('Credit account not found.'), { statusCode: 404 });
    const balanceAfter = account.balance + amount;
    if (balanceAfter < 0) throw Object.assign(new Error('Grant would take the account balance below zero.'), { statusCode: 400, failureCategory: 'VALIDATION' });
    const [created] = await tx.insert(creditTransactions)
      .values({ accountId, sourceType: 'admin_grant', sourceId: idempotencyKey, amount, balanceAfter, metadata: { note: String(note || '').slice(0, 300) || null } })
      .onConflictDoNothing().returning();
    if (!created) {
      const existing = (await tx.select().from(creditTransactions)
        .where(and(eq(creditTransactions.sourceType, 'admin_grant'), eq(creditTransactions.sourceId, idempotencyKey))).limit(1))[0];
      return { applied: false, duplicate: true, balanceAfter: existing?.balanceAfter ?? account.balance };
    }
    await tx.update(creditAccounts).set({ balance: balanceAfter, updatedAt: new Date() }).where(eq(creditAccounts.accountId, accountId));
    return { applied: true, duplicate: false, balanceAfter };
  });
}

export async function addMediaAsset(asset) {
  const [created] = await database().insert(mediaAssets).values(asset).onConflictDoUpdate({ target: mediaAssets.privatePathname, set: { bytes: asset.bytes, sha256: asset.sha256, contentType: asset.contentType } }).returning();
  return created;
}

export async function getOwnedMediaAsset(accountId, assetId) {
  return (await database().select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, assetId))).limit(1))[0] || null;
}

export function classifyDatabaseCommitOutcome(error) {
  const code = String(error?.code || '');
  return /^(22|23|40|42)/.test(code) ? 'not_committed' : 'unknown';
}

function uploadPersistenceError(commitOutcome) {
  return Object.assign(new Error('Media persistence is unavailable.'), {
    statusCode: 503,
    failureCategory: 'PERSISTENCE',
    commitOutcome,
  });
}

export async function addUploadMediaAsset(asset) {
  try {
    const [created] = await database().insert(mediaAssets).values(asset).onConflictDoNothing().returning();
    if (created) return created;
    const existing = await getOwnedMediaAsset(asset.accountId, asset.id);
    if (existing) return existing;
    throw uploadPersistenceError('not_committed');
  } catch (error) {
    if (error?.commitOutcome) throw error;
    throw uploadPersistenceError(classifyDatabaseCommitOutcome(error));
  }
}

export async function attachProviderMediaAsset({ accountId, assetId, provider, providerAssetId, consumerIdentityId, providerBinding }) {
  return withHeygenSpaceBindingReceiptTransaction({ accountId, providerBinding }, async tx => {
    const bindingAuthority = assertHeygenProviderReceiptTx(tx, { accountId, providerBinding });
    if (provider !== 'heygen' || !consumerIdentityId) throw Object.assign(new Error('Provider media attachment requires an exact identity ledger binding.'), { statusCode: 409, failureCategory: 'PROVIDER_RESOURCE_UNVERIFIED' });
    const [identity] = await tx.select().from(userIdentities).where(and(
      eq(userIdentities.accountId, accountId), eq(userIdentities.id, consumerIdentityId), isNull(userIdentities.archivedAt),
    )).for('share').limit(1);
    if (!identity || ![identity.sourcePhotoAssetId, identity.sourceVoiceAssetId].includes(assetId)) {
      throw Object.assign(new Error('Provider media identity source binding is invalid.'), { statusCode: 409, failureCategory: 'CONSENT' });
    }
    const [asset] = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, assetId))).for('update').limit(1);
    if (!asset) throw Object.assign(new Error('Asset not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    const resource = await getExactProviderResourceTx(tx, { accountId, kind: 'asset', providerResourceId: providerAssetId, lock: true });
    if (resource.bindingId !== bindingAuthority.bindingId || resource.originScopeKey !== bindingAuthority.originScopeKey
      || resource.verifiedAccountScopeId !== bindingAuthority.verifiedAccountScopeId) {
      throw Object.assign(new Error('Provider media asset belongs to a different provider space.'), { statusCode: 409, failureCategory: 'PROVIDER_RESOURCE_SCOPE_CONFLICT' });
    }
    const photoSource = identity.sourcePhotoAssetId === asset.id;
    const sourceValid = !asset.quarantinedAt
      && asset.kind === (photoSource ? 'identity-photo-source' : 'identity-voice-source')
      && String(asset.privatePathname || '').startsWith(photoSource ? 'video-os/uploads/' : 'video-os/enrollment-sources/')
      && String(asset.contentType || '').startsWith(photoSource ? 'image/' : 'audio/')
      && resource.sourceSha256 === asset.sha256 && resource.sourceBytes === asset.bytes;
    if (!sourceValid) throw Object.assign(new Error('Provider asset no longer matches its consented private source.'), { statusCode: 409, failureCategory: 'CONSENT' });
    let updated = asset;
    let replayed = true;
    if (!asset.providerAssetId) {
      [updated] = await tx.update(mediaAssets).set({ provider, providerAssetId, providerUploadedAt: new Date() })
        .where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, assetId), isNull(mediaAssets.providerAssetId))).returning();
      replayed = false;
    } else if (asset.provider !== provider || asset.providerAssetId !== providerAssetId) {
      throw Object.assign(new Error('Asset provider identity is already reserved.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    }
    await attachProviderConsumerReferenceTx(tx, {
      accountId, resourceId: resource.id, consumerKind: 'identity', consumerId: consumerIdentityId, originOperationId: resource.originOperationId,
    });
    return { asset: updated, replayed };
  });
}

async function ownedIdentityForUpdate(tx, accountId, identityId) {
  return (await tx.select().from(userIdentities).where(and(eq(userIdentities.accountId, accountId), eq(userIdentities.id, identityId))).for('update').limit(1))[0] || null;
}

export function assertIdentitySourceAssets(photo, voice) {
  if (!photo || !voice) throw Object.assign(new Error('Identity source asset not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
  if (photo.quarantinedAt || photo.kind !== 'identity-photo-source' || !photo.contentType.startsWith('image/')) {
    throw Object.assign(new Error('Identity photo source is invalid.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  }
  if (voice.quarantinedAt || voice.kind !== 'identity-voice-source' || !voice.contentType.startsWith('audio/')) {
    throw Object.assign(new Error('Identity voice source is invalid.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  }
  return true;
}

async function assertIdentityVoiceEnrollmentProvenance(tx, identity, voice, { lock = false, creating = false } = {}) {
  let query = tx.select().from(identityVideoEnrollments).where(eq(identityVideoEnrollments.derivedVoiceAssetId, voice.id));
  if (lock) query = query.for('share');
  const enrollment = (await query.limit(1))[0];
  if (!enrollment) return null;
  if (creating || enrollment.identityId !== identity.id || enrollment.accountId !== identity.accountId || enrollment.status !== 'IDENTITY_READY') {
    throw Object.assign(new Error('Enrollment-derived voice media cannot be rebound to another identity.'), { statusCode: 409, failureCategory: 'CONSENT' });
  }
  assertEnrollmentConsentRecord(enrollment);
  return enrollment;
}

export async function createIdentityDraft({ accountId, displayName, sourcePhotoAssetId, sourceVoiceAssetId, provider = 'heygen' }) {
  return database().transaction(async (tx) => {
    await acquireProviderLifecycleLock(tx, accountId);
    const photo = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, sourcePhotoAssetId))).limit(1))[0];
    const voice = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, sourceVoiceAssetId))).limit(1))[0];
    assertIdentitySourceAssets(photo, voice);
    await assertIdentityVoiceEnrollmentProvenance(tx, { id: null, accountId }, voice, { lock: true, creating: true });
    const name = String(displayName || '').trim();
    if (!name) throw Object.assign(new Error('Identity name is required.'), { statusCode: 400, failureCategory: 'VALIDATION' });
    const [identity] = await tx.insert(userIdentities).values({
      accountId,
      displayName: name,
      provider,
      sourcePhotoAssetId,
      sourceVoiceAssetId,
    }).returning();
    return identity;
  });
}

export async function getOwnedIdentity(accountId, identityId) {
  return (await database().select().from(userIdentities).where(and(eq(userIdentities.accountId, accountId), eq(userIdentities.id, identityId))).limit(1))[0] || null;
}

export async function getOwnedScriptedPhotoJobByIdempotency({ accountId, idempotencyKey, projectId, tier, identityId, title, script, format }) {
  const job = (await database().select().from(videoJobs).where(and(eq(videoJobs.accountId, accountId), eq(videoJobs.idempotencyKey, idempotencyKey))).limit(1))[0] || null;
  if (!job) return null;
  if (job.provider !== 'heygen' || !isScriptedPhotoRequest(job.input) || job.input.projectId !== projectId || job.input.tier !== tier
    || (identityId !== undefined && job.input.identityId !== identityId)
    || (title !== undefined && job.title !== title)
    || (script !== undefined && job.input.script !== script)
    || (format !== undefined && job.format !== format)) {
    throw Object.assign(new Error('Idempotency key belongs to a different scripted-photo request.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  }
  assertPersistedScriptedQuoteProof(job, withoutServerRenderProof(job.input));
  return job;
}

async function activeLinkedEnrollment(tx, accountId, identityId, { lock = true } = {}) {
  let query = tx.select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.accountId, accountId), eq(identityVideoEnrollments.identityId, identityId)));
  if (lock) query = query.for('share');
  const linked = (await query.limit(1))[0];
  if (!linked) return null;
  if (linked.status !== 'IDENTITY_READY' || linked.revokedAt || !linked.consentedAt || linked.consentedSourceSha256 !== linked.sourceSha256) {
    throw Object.assign(new Error('Linked enrollment consent is not active.'), { statusCode: 409, failureCategory: 'CONSENT' });
  }
  assertEnrollmentConsentRecord(linked, { requireProviderExposure: true });
  const [source] = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, linked.sourceVideoAssetId))).for('share').limit(1);
  const [voice] = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, linked.derivedVoiceAssetId))).for('share').limit(1);
  if (!source || source.quarantinedAt || source.kind !== 'identity-phone-video-source' || source.sha256 !== linked.sourceSha256
    || !voice || voice.quarantinedAt || voice.kind !== 'identity-voice-source' || voice.sha256 !== linked.derivedAudioSha256) {
    throw Object.assign(new Error('Linked enrollment media is unavailable.'), { statusCode: 409, failureCategory: 'CONSENT' });
  }
  return linked;
}

export async function getRenderAuthorizedIdentity(accountId, identityId, policyVersion = IDENTITY_CONSENT_POLICY_VERSION) {
  return database().transaction(async (tx) => {
    const linkedEnrollment = await activeLinkedEnrollment(tx, accountId, identityId);
    const identity = (await tx.select().from(userIdentities).where(and(eq(userIdentities.accountId, accountId), eq(userIdentities.id, identityId))).limit(1))[0] || null;
    if (!identity) return null;
    await assertActiveIdentityConsent(tx, identity, linkedEnrollment?.consentPolicyVersion || policyVersion);
    return identity;
  });
}
export async function getReadyOwnedIdentity(accountId, identityId) {
  return (await database().select().from(userIdentities).where(and(
    eq(userIdentities.accountId, accountId),
    eq(userIdentities.id, identityId),
    eq(userIdentities.overallStatus, 'READY'),
    isNull(userIdentities.archivedAt),
  )).limit(1))[0] || null;
}

export async function listOwnedIdentities(accountId, { includeArchived = false } = {}) {
  const ownership = eq(userIdentities.accountId, accountId);
  const predicate = includeArchived ? ownership : and(ownership, isNull(userIdentities.archivedAt));
  return database().select().from(userIdentities).where(predicate).orderBy(desc(userIdentities.updatedAt)).limit(50);
}

export async function recordIdentityConsent({ accountId, identityId, policyVersion, faceAuthorization, voiceAuthorization, providerProcessingAuthorization, archiveDeleteAcknowledgment }) {
  if (![faceAuthorization, voiceAuthorization, providerProcessingAuthorization, archiveDeleteAcknowledgment].every((value) => value === true)) {
    throw Object.assign(new Error('All identity authorizations are required.'), { statusCode: 400, failureCategory: 'CONSENT' });
  }
  return database().transaction(async (tx) => {
    await acquireProviderLifecycleLock(tx, accountId);
    await activeLinkedEnrollment(tx, accountId, identityId);
    const identity = await ownedIdentityForUpdate(tx, accountId, identityId);
    if (!identity || identity.archivedAt) throw Object.assign(new Error('Identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    const photo = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, identity.sourcePhotoAssetId))).limit(1))[0];
    const voice = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, identity.sourceVoiceAssetId))).limit(1))[0];
    assertIdentitySourceAssets(photo, voice);
    await assertIdentityVoiceEnrollmentProvenance(tx, identity, voice, { lock: true });
    const existing = (await tx.select().from(identityConsents).where(and(
      eq(identityConsents.accountId, accountId),
      eq(identityConsents.identityId, identityId),
      eq(identityConsents.policyVersion, policyVersion),
      isNull(identityConsents.revokedAt),
    )).limit(1))[0];
    if (existing) {
      if (existing.photoSha256 === photo.sha256 && existing.voiceSha256 === voice.sha256) return { consent: existing, replayed: true };
      throw Object.assign(new Error('Identity consent source fingerprint conflict.'), { statusCode: 409, failureCategory: 'CONSENT' });
    }
    const [consent] = await tx.insert(identityConsents).values({
      accountId,
      identityId,
      faceAuthorization,
      voiceAuthorization,
      providerProcessingAuthorization,
      archiveDeleteAcknowledgment,
      policyVersion,
      photoSha256: photo.sha256,
      voiceSha256: voice.sha256,
    }).returning();
    return { consent, replayed: false };
  });
}

function withShareLock(query, lock) {
  return lock ? query.for('share') : query;
}

export async function prepareIdentityProviderRead({ accountId, identityId, component, providerBinding }) {
  const fields = componentFields(component);
  return withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding }, async tx => {
    const identity = await ownedIdentityForUpdate(tx, accountId, identityId);
    if (!identity || identity.archivedAt || !['CREATING', 'PROCESSING', 'READY'].includes(identity[fields.status])) {
      throw Object.assign(new Error('Identity provider read is unavailable.'), { statusCode: 409, failureCategory: 'PROVIDER_OPERATION_CONFLICT' });
    }
    const expectedResources = component === 'avatar'
      ? [
        { kind: 'avatar_group', providerResourceId: identity.providerAvatarGroupId },
        { kind: 'avatar_look', providerResourceId: identity.providerRenderableAvatarId },
      ]
      : [{ kind: 'voice', providerResourceId: identity.providerVoiceId }];
    if (expectedResources.some(resource => !resource.providerResourceId)) {
      throw Object.assign(new Error('Identity provider resource is unavailable.'), { statusCode: 409, failureCategory: 'PROVIDER_RESOURCE_UNVERIFIED' });
    }
    const resources = await assertProviderIdentityReferencesActiveTx(tx, {
      accountId, identityId, providerBinding, expectedResources,
    });
    return deepFreezeProviderProof({
      version: 'heygen-identity-read-claim/v1',
      accountId,
      identityId,
      component,
      operationKey: identity[fields.operation],
      providerAvatarGroupId: component === 'avatar' ? identity.providerAvatarGroupId : null,
      providerRenderableAvatarId: component === 'avatar' ? identity.providerRenderableAvatarId : null,
      providerVoiceId: component === 'voice' ? identity.providerVoiceId : null,
      resourceIds: resources.map(resource => resource.id),
    });
  });
}

export async function requireAnyPersistedRenderAuthorization(accountId) {
  try { return await requirePersistedRenderAuthorization(accountId, 'standard'); } catch (standardError) {
    try { return await requirePersistedRenderAuthorization(accountId, 'premium'); } catch {
      throw standardError;
    }
  }
}

async function assertActiveIdentityConsent(tx, identity, policyVersion = IDENTITY_CONSENT_POLICY_VERSION, { lock = false } = {}) {
  const consent = (await withShareLock(tx.select().from(identityConsents).where(and(
    eq(identityConsents.accountId, identity.accountId),
    eq(identityConsents.identityId, identity.id),
    eq(identityConsents.policyVersion, policyVersion),
    isNull(identityConsents.revokedAt),
  )).orderBy(desc(identityConsents.acceptedAt)), lock).limit(1))[0];
  if (!consent) throw Object.assign(new Error('Identity consent is required.'), { statusCode: 409, failureCategory: 'CONSENT' });
  if (policyVersion === ENROLLMENT_CONSENT_POLICY_VERSION
    && (consent.audioExtractionAuthorization !== true || consent.temporaryPublicProviderExposureAuthorization !== true
      || !/^[a-f0-9]{64}$/.test(consent.sourceVideoSha256 || '') || consent.consentPurpose !== 'identity-voice-enrollment')) {
    throw Object.assign(new Error('Provider bridge exposure consent is required.'), { statusCode: 409, failureCategory: 'CONSENT' });
  }
  const photo = (await withShareLock(tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, identity.accountId), eq(mediaAssets.id, identity.sourcePhotoAssetId))), lock).limit(1))[0];
  const voice = (await withShareLock(tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, identity.accountId), eq(mediaAssets.id, identity.sourceVoiceAssetId))), lock).limit(1))[0];
  assertIdentitySourceAssets(photo, voice);
  const linkedEnrollment = await assertIdentityVoiceEnrollmentProvenance(tx, identity, voice, { lock });
  if (policyVersion === ENROLLMENT_CONSENT_POLICY_VERSION && consent.sourceVideoSha256 !== linkedEnrollment?.sourceSha256) {
    throw Object.assign(new Error('Provider bridge consent no longer matches its enrollment video source.'), { statusCode: 409, failureCategory: 'CONSENT' });
  }
  if (!photo || !voice || photo.sha256 !== consent.photoSha256 || voice.sha256 !== consent.voiceSha256) {
    throw Object.assign(new Error('Identity consent no longer matches its source assets.'), { statusCode: 409, failureCategory: 'CONSENT' });
  }
  return { consent, photo, voice };
}

function componentFields(component) {
  if (component === 'avatar') return { status: 'avatarStatus', operation: 'avatarOperationKey', code: 'avatarFailureCode', message: 'avatarFailureMessage' };
  if (component === 'voice') return { status: 'voiceStatus', operation: 'voiceOperationKey', code: 'voiceFailureCode', message: 'voiceFailureMessage' };
  throw Object.assign(new Error('Identity component is invalid.'), { statusCode: 400, failureCategory: 'VALIDATION' });
}

function assertProviderResourceConsistency(identity, proposed) {
  for (const [field, value] of Object.entries(proposed)) {
    if (value && identity[field] && value !== identity[field]) {
      throw Object.assign(new Error('Provider identity resource conflict.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    }
  }
}

export function redactIdentityFailure(code, message) {
  const safeCode = String(code || 'PROVIDER_FAILED').toUpperCase().replace(/[^A-Z0-9_-]+/g, '_').slice(0, 64) || 'PROVIDER_FAILED';
  const safeMessage = String(message || 'Identity creation failed.')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b(?:api[_-]?key|authorization|token|cookie|signature)\s*[:=]\s*\S+/gi, '[redacted-secret]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 240) || 'Identity creation failed.';
  return { code: safeCode, message: safeMessage };
}

export async function reserveIdentityComponentCreation({ accountId, identityId, component, operationKey, providerBinding }) {
  if (!providerBinding) throw Object.assign(new Error('Verified provider-space binding is required.'), { statusCode: 503, failureCategory: 'MISSING_PROVIDER_ACCOUNT_BINDING', code: 'MISSING_PROVIDER_ACCOUNT_BINDING' });
  const fields = componentFields(component);
  return withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding }, async tx => {
    const linkedEnrollment = await activeLinkedEnrollment(tx, accountId, identityId);
    const identity = await ownedIdentityForUpdate(tx, accountId, identityId);
    if (!identity || identity.archivedAt) throw Object.assign(new Error('Identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    if (identity[fields.operation] === operationKey) return { identity, replayed: true };
    if (ACTIVE_COMPONENT_STATUSES.has(identity[fields.status])) throw Object.assign(new Error('Identity component creation is already in progress.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (identity[fields.status] === 'READY') throw Object.assign(new Error('Identity component is already ready.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (!['DRAFT', 'FAILED'].includes(identity[fields.status])) throw Object.assign(new Error('Identity component cannot be submitted from its current state.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    await assertActiveIdentityConsent(tx, identity, linkedEnrollment?.consentPolicyVersion || IDENTITY_CONSENT_POLICY_VERSION);
    const retryReset = identity[fields.status] !== 'FAILED'
      ? {}
      : component === 'avatar'
        ? { providerAvatarRequestId: null, providerAvatarGroupId: null, providerRenderableAvatarId: null }
        : { providerVoiceId: null };
    const avatarStatus = component === 'avatar' ? 'CREATING' : identity.avatarStatus;
    const voiceStatus = component === 'voice' ? 'CREATING' : identity.voiceStatus;
    const [updated] = await tx.update(userIdentities).set({
      [fields.status]: 'CREATING',
      [fields.operation]: operationKey,
      [fields.code]: null,
      [fields.message]: null,
      ...retryReset,
      overallStatus: deriveIdentityStatus({ avatarStatus, voiceStatus }),
      updatedAt: new Date(),
    }).where(and(eq(userIdentities.accountId, accountId), eq(userIdentities.id, identityId))).returning();
    return { identity: updated, replayed: false };
  });
}

export async function recordIdentityProviderSubmission({ accountId, identityId, component, operationKey, providerRequestId, providerAvatarGroupId, providerRenderableAvatarId, providerVoiceId, providerBinding }) {
  const fields = componentFields(component);
  return withHeygenSpaceBindingReceiptTransaction({ accountId, providerBinding }, async tx => {
    const bindingAuthority = assertHeygenProviderReceiptTx(tx, { accountId, providerBinding });
    const identity = await ownedIdentityForUpdate(tx, accountId, identityId);
    if (!identity || identity.archivedAt) throw Object.assign(new Error('Identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    if (identity[fields.operation] !== operationKey) throw Object.assign(new Error('Identity operation does not match the reserved submission.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (!['CREATING', 'PROCESSING'].includes(identity[fields.status])) throw Object.assign(new Error('Identity component is not awaiting a provider submission.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (component === 'avatar' && !providerRequestId && !identity.providerAvatarRequestId) throw Object.assign(new Error('Provider avatar request identity is required.'), { statusCode: 400, failureCategory: 'VALIDATION' });
    if (component === 'voice' && !providerVoiceId && !identity.providerVoiceId) throw Object.assign(new Error('Provider voice identity is required.'), { statusCode: 400, failureCategory: 'VALIDATION' });
    assertProviderResourceConsistency(identity, { providerAvatarRequestId: providerRequestId, providerAvatarGroupId, providerRenderableAvatarId, providerVoiceId });
    const groupId = providerAvatarGroupId || identity.providerAvatarGroupId;
    const lookId = providerRenderableAvatarId || identity.providerRenderableAvatarId;
    const voiceResourceId = providerVoiceId || identity.providerVoiceId;
    if (component === 'avatar' && (!groupId || !lookId)) throw Object.assign(new Error('Provider avatar resource identities are required.'), { statusCode: 409, failureCategory: 'PROVIDER_RESPONSE' });
    const lifecycleResources = component === 'avatar'
      ? [
        await getExactProviderResourceTx(tx, { accountId, kind: 'avatar_group', providerResourceId: groupId, lock: true }),
        await getExactProviderResourceTx(tx, { accountId, kind: 'avatar_look', providerResourceId: lookId, lock: true }),
      ]
      : [await getExactProviderResourceTx(tx, { accountId, kind: 'voice', providerResourceId: voiceResourceId, lock: true })];
    if (new Set(lifecycleResources.map(resource => resource.verifiedAccountScopeId)).size !== 1
      || lifecycleResources.some(resource => resource.bindingId !== bindingAuthority.bindingId
        || resource.originScopeKey !== bindingAuthority.originScopeKey
        || resource.verifiedAccountScopeId !== bindingAuthority.verifiedAccountScopeId)) {
      throw Object.assign(new Error('Provider identity resources do not share one verified provider account.'), { statusCode: 409, failureCategory: 'PROVIDER_RESOURCE_UNVERIFIED' });
    }
    const avatarStatus = component === 'avatar' ? 'PROCESSING' : identity.avatarStatus;
    const voiceStatus = component === 'voice' ? 'PROCESSING' : identity.voiceStatus;
    const [updated] = await tx.update(userIdentities).set({
      [fields.status]: 'PROCESSING',
      providerAvatarRequestId: providerRequestId || identity.providerAvatarRequestId,
      providerAvatarGroupId: providerAvatarGroupId || identity.providerAvatarGroupId,
      providerRenderableAvatarId: providerRenderableAvatarId || identity.providerRenderableAvatarId,
      providerVoiceId: providerVoiceId || identity.providerVoiceId,
      overallStatus: deriveIdentityStatus({ avatarStatus, voiceStatus }),
      updatedAt: new Date(),
    }).where(and(eq(userIdentities.accountId, accountId), eq(userIdentities.id, identityId))).returning();
    for (const resource of lifecycleResources) await attachProviderConsumerReferenceTx(tx, {
      accountId, resourceId: resource.id, consumerKind: 'identity', consumerId: identityId, originOperationId: resource.originOperationId,
    });
    return updated;
  });
}

export async function markIdentityComponentReady({ accountId, identityId, component, operationKey, providerAvatarGroupId, providerRenderableAvatarId, providerVoiceId, providerBinding }) {
  const fields = componentFields(component);
  return withHeygenSpaceBindingReceiptTransaction({ accountId, providerBinding }, async tx => {
    const bindingAuthority = assertHeygenProviderReceiptTx(tx, { accountId, providerBinding });
    const identity = await ownedIdentityForUpdate(tx, accountId, identityId);
    if (!identity || identity.archivedAt) throw Object.assign(new Error('Identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    if (identity[fields.operation] !== operationKey) throw Object.assign(new Error('Identity operation does not match the reserved submission.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (identity[fields.status] === 'READY') return identity;
    if (!['CREATING', 'PROCESSING'].includes(identity[fields.status])) throw Object.assign(new Error('Identity component is not processing.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    assertProviderResourceConsistency(identity, { providerAvatarGroupId, providerRenderableAvatarId, providerVoiceId });
    const avatarGroupId = providerAvatarGroupId || identity.providerAvatarGroupId;
    const renderableAvatarId = providerRenderableAvatarId || identity.providerRenderableAvatarId;
    const voiceId = providerVoiceId || identity.providerVoiceId;
    if (component === 'avatar' && (!avatarGroupId || !renderableAvatarId)) throw Object.assign(new Error('A renderable provider avatar is required.'), { statusCode: 409, failureCategory: 'PROVIDER_RESPONSE' });
    if (component === 'voice' && !voiceId) throw Object.assign(new Error('A completed provider voice is required.'), { statusCode: 409, failureCategory: 'PROVIDER_RESPONSE' });
    const readyResources = component === 'avatar'
      ? [
        await getExactProviderResourceTx(tx, { accountId, kind: 'avatar_group', providerResourceId: avatarGroupId, lock: true }),
        await getExactProviderResourceTx(tx, { accountId, kind: 'avatar_look', providerResourceId: renderableAvatarId, lock: true }),
      ]
      : [await getExactProviderResourceTx(tx, { accountId, kind: 'voice', providerResourceId: voiceId, lock: true })];
    if (readyResources.some(resource => resource.bindingId !== bindingAuthority.bindingId
      || resource.originScopeKey !== bindingAuthority.originScopeKey
      || resource.verifiedAccountScopeId !== bindingAuthority.verifiedAccountScopeId)) {
      throw Object.assign(new Error('Provider ready resource belongs to a different provider space.'), { statusCode: 409, failureCategory: 'PROVIDER_RESOURCE_SCOPE_CONFLICT' });
    }
    for (const resource of readyResources) await markProviderResourceReadyTx(tx, { accountId, resourceId: resource.id });
    const avatarStatus = component === 'avatar' ? 'READY' : identity.avatarStatus;
    const voiceStatus = component === 'voice' ? 'READY' : identity.voiceStatus;
    const [updated] = await tx.update(userIdentities).set({
      [fields.status]: 'READY',
      providerAvatarGroupId: avatarGroupId,
      providerRenderableAvatarId: renderableAvatarId,
      providerVoiceId: voiceId,
      [fields.code]: null,
      [fields.message]: null,
      overallStatus: deriveIdentityStatus({ avatarStatus, voiceStatus }),
      updatedAt: new Date(),
    }).where(and(eq(userIdentities.accountId, accountId), eq(userIdentities.id, identityId))).returning();
    return updated;
  });
}

export async function markIdentityComponentFailed({ accountId, identityId, component, operationKey, failureCode, failureMessage, providerBinding }) {
  const fields = componentFields(component);
  const failure = redactIdentityFailure(failureCode, failureMessage);
  return withHeygenSpaceBindingReceiptTransaction({ accountId, providerBinding }, async tx => {
    assertHeygenProviderReceiptTx(tx, { accountId, providerBinding });
    const identity = await ownedIdentityForUpdate(tx, accountId, identityId);
    if (!identity || identity.archivedAt) throw Object.assign(new Error('Identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    if (identity[fields.operation] !== operationKey) throw Object.assign(new Error('Identity operation does not match the reserved submission.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (identity[fields.status] === 'READY') throw Object.assign(new Error('A ready identity component cannot be failed.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (identity[fields.status] === 'FAILED') return identity;
    const avatarStatus = component === 'avatar' ? 'FAILED' : identity.avatarStatus;
    const voiceStatus = component === 'voice' ? 'FAILED' : identity.voiceStatus;
    const [updated] = await tx.update(userIdentities).set({
      [fields.status]: 'FAILED',
      [fields.code]: failure.code,
      [fields.message]: failure.message,
      overallStatus: deriveIdentityStatus({ avatarStatus, voiceStatus }),
      updatedAt: new Date(),
    }).where(and(eq(userIdentities.accountId, accountId), eq(userIdentities.id, identityId))).returning();
    return updated;
  });
}

export async function archiveOwnedIdentity(accountId, identityId) {
  return database().transaction(async (tx) => {
    await acquireProviderLifecycleLock(tx, accountId);
    const linked = (await tx.select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.accountId, accountId), eq(identityVideoEnrollments.identityId, identityId))).for('update').limit(1))[0];
    const identity = await ownedIdentityForUpdate(tx, accountId, identityId);
    if (!identity) throw Object.assign(new Error('Identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    if (identity.archivedAt) return identity;
    const archivedAt = new Date();
    if (linked && linked.status !== 'REVOKED') {
      const providerPending = Object.values(linked.providerReceipts || {}).some(receipt => ['SUBMITTING', 'ACCEPTED', 'COMPLETE', 'PENDING'].includes(receipt?.status));
      await tx.update(identityVideoEnrollments).set({ status: 'REVOKED', stateVersion: linked.stateVersion + 1, revokedAt: archivedAt, workflowOperationKey: null, leaseExpiresAt: null, cleanupStatus: 'PENDING', providerReconciliationStatus: providerPending ? 'PENDING' : linked.providerReconciliationStatus, updatedAt: archivedAt })
        .where(and(eq(identityVideoEnrollments.id, linked.id), eq(identityVideoEnrollments.stateVersion, linked.stateVersion)));
      for (const assetId of [linked.sourceVideoAssetId, linked.derivedVoiceAssetId].filter(Boolean)) {
        await tx.update(mediaAssets).set({ quarantinedAt: archivedAt }).where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.accountId, accountId)));
      }
      await tx.insert(identityEnrollmentEvents).values({ enrollmentId: linked.id, correlationId: linked.correlationId, eventType: 'enrollment.revoked_by_identity_archive', stateFrom: linked.status, stateTo: 'REVOKED', details: { linkedIdentity: true } });
    }
    await tx.update(identityConsents).set({ revokedAt: archivedAt }).where(and(
      eq(identityConsents.accountId, accountId),
      eq(identityConsents.identityId, identityId),
      isNull(identityConsents.revokedAt),
    ));
    const [archived] = await tx.update(userIdentities).set({ overallStatus: 'ARCHIVED', archivedAt, updatedAt: archivedAt })
      .where(and(eq(userIdentities.accountId, accountId), eq(userIdentities.id, identityId))).returning();
    return archived;
  });
}

function projectSelectionForStorage(value) {
  const id = String(value?.id || '').trim().slice(0, 160);
  if (!id) return null;
  const name = String(value?.name || '').trim().slice(0, 180);
  const source = String(value?.source || '').trim().slice(0, 80);
  return { id, ...(name ? { name } : {}), ...(source ? { source } : {}) };
}

export async function saveProject({ id, accountId, identityId, title, script, avatar, voice }) {
  const values = {
    accountId,
    identityId,
    title,
    script,
    avatar: projectSelectionForStorage(avatar),
    voice: projectSelectionForStorage(voice),
    settings: {},
    updatedAt: new Date(),
  };
  return database().transaction(async (tx) => {
    await acquireProviderLifecycleLock(tx, accountId);
    if (identityId) {
      const ownedIdentity = (await tx.select({ id: userIdentities.id }).from(userIdentities).where(and(
        eq(userIdentities.accountId, accountId),
        eq(userIdentities.id, identityId),
        isNull(userIdentities.archivedAt),
      )).limit(1))[0];
      if (!ownedIdentity) throw Object.assign(new Error('Identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    }
    if (id) {
      const [updated] = await tx.update(projects).set(values).where(and(eq(projects.id, id), eq(projects.accountId, accountId))).returning();
      if (!updated) throw Object.assign(new Error('Project not found.'), { statusCode: 404 });
      return updated;
    }
    return (await tx.insert(projects).values(values).returning())[0];
  });
}

export async function saveStandardProject({ accountId, title, identityId, narrationAudioAssetId }) {
  return database().transaction(async (tx) => {
    await acquireProviderLifecycleLock(tx, accountId);
    const ownedIdentity = (await tx.select({ id: userIdentities.id }).from(userIdentities).where(and(
      eq(userIdentities.accountId, accountId),
      eq(userIdentities.id, identityId),
      isNull(userIdentities.archivedAt),
    )).limit(1))[0];
    if (!ownedIdentity) throw Object.assign(new Error('Identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    const ownedAudio = (await tx.select({ id: mediaAssets.id }).from(mediaAssets).where(and(
      eq(mediaAssets.accountId, accountId),
      eq(mediaAssets.id, narrationAudioAssetId),
    )).limit(1))[0];
    if (!ownedAudio) throw Object.assign(new Error('Narration audio not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    return (await tx.insert(projects).values({
      accountId,
      identityId,
      title,
      // Legacy Video OS databases still enforce projects.script NOT NULL.
      // Standard carries narration as a bound private audio asset, so the
      // compatible no-script representation is an empty string.
      script: '',
      avatar: {},
      voice: {},
      settings: { tier: 'STANDARD', contractVersion: 'standard-narration-v1', narrationAudioAssetId },
    }).returning())[0];
  });
}

export async function listProjects(accountId) {
  return database().select().from(projects).where(eq(projects.accountId, accountId)).orderBy(desc(projects.updatedAt)).limit(30);
}

export async function getOwnedProject(accountId, projectId) {
  return (await database().select().from(projects).where(and(eq(projects.id, projectId), eq(projects.accountId, accountId))).limit(1))[0] || null;
}

function scriptedPhotoBindingError(message, statusCode = 409, failureCategory = 'RECONCILIATION') {
  return Object.assign(new Error(message), { statusCode, failureCategory });
}

function assertScriptedPhotoSourceAssets(photo, voice, linkedEnrollment) {
  try { assertIdentitySourceAssets(photo, voice); } catch { throw scriptedPhotoBindingError('Scripted-photo identity source classification is invalid.', 409, 'CONSENT'); }
  const photoTypes = new Set(['image/jpeg', 'image/png']);
  const voiceTypes = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav']);
  const enrollmentVoice = linkedEnrollment && voice.id === linkedEnrollment.derivedVoiceAssetId
    && String(voice.privatePathname || '').startsWith('video-os/enrollment-sources/');
  if (photo.quarantinedAt || voice.quarantinedAt || !photoTypes.has(photo.contentType) || !voiceTypes.has(voice.contentType)
    || !String(photo.privatePathname || '').startsWith('video-os/uploads/')
    || (!String(voice.privatePathname || '').startsWith('video-os/uploads/') && !enrollmentVoice)) {
    throw scriptedPhotoBindingError('Scripted-photo identity source is unavailable.', 409, 'CONSENT');
  }
}

async function resolveScriptedPhotoContext(tx, { accountId, projectId, identityId, title, script, tier }, { lock = false } = {}) {
  const project = (await withShareLock(tx.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.accountId, accountId))), lock).limit(1))[0];
  if (!project) throw scriptedPhotoBindingError('Project not found.', 404, 'OWNERSHIP');
  if (project.settings?.contractVersion !== SCRIPTED_PHOTO_CONTRACT_VERSION || project.settings?.tier !== tier
    || project.identityId !== identityId || project.title !== title || project.script !== script) {
    throw scriptedPhotoBindingError('Scripted-photo request no longer matches its saved project.');
  }

  const linkedEnrollment = await activeLinkedEnrollment(tx, accountId, identityId, { lock });

  const identity = (await withShareLock(tx.select().from(userIdentities).where(and(
    eq(userIdentities.accountId, accountId),
    eq(userIdentities.id, identityId),
  )), lock).limit(1))[0];
  if (!identity) throw scriptedPhotoBindingError('Video identity not found.', 404, 'OWNERSHIP');
  if (identity.archivedAt || identity.provider !== 'heygen'
    || ![identity.overallStatus, identity.avatarStatus, identity.voiceStatus].every(status => status === 'READY')
    || !identity.providerRenderableAvatarId || !identity.providerVoiceId) {
    throw scriptedPhotoBindingError('Video identity is not ready for scripted rendering.', 409, 'CONSENT');
  }
  let consentResult;
  try {
    consentResult = await assertActiveIdentityConsent(
      tx,
      identity,
      linkedEnrollment?.consentPolicyVersion || IDENTITY_CONSENT_POLICY_VERSION,
      { lock },
    );
  } catch (error) {
    if (error?.failureCategory === 'OWNERSHIP') throw error;
    throw scriptedPhotoBindingError('Scripted-photo identity consent or source media is unavailable.', 409, 'CONSENT');
  }
  const { consent, photo, voice } = consentResult;
  assertScriptedPhotoSourceAssets(photo, voice, linkedEnrollment);
  const sourceBinding = {
    policyVersion: consent.policyVersion,
    consentId: consent.id,
    sourcePhotoAssetId: identity.sourcePhotoAssetId,
    sourceVoiceAssetId: identity.sourceVoiceAssetId,
    photoSha256: photo.sha256,
    voiceSha256: voice.sha256,
    photoKind: photo.kind,
    voiceKind: voice.kind,
    photoContentType: photo.contentType,
    voiceContentType: voice.contentType,
    photoPrivatePathname: photo.privatePathname,
    voicePrivatePathname: voice.privatePathname,
    provider: 'heygen',
    providerRenderableAvatarId: identity.providerRenderableAvatarId,
    providerVoiceId: identity.providerVoiceId,
  };
  return {
    project,
    identity,
    input: {
      contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION,
      tier,
      projectId,
      identityId,
      script,
      avatar: { avatarId: identity.providerRenderableAvatarId },
      voice: { voiceId: identity.providerVoiceId },
      sourceBinding,
    },
  };
}

export async function getScriptedPhotoReservationContext(request) {
  return database().transaction(tx => resolveScriptedPhotoContext(tx, request));
}

async function assertScriptedPhotoClaimBinding(tx, job) {
  if (job.projectId !== job.input?.projectId) throw scriptedPhotoBindingError('Scripted-photo project binding is invalid.');
  const resolved = await resolveScriptedPhotoContext(tx, {
    accountId: job.accountId,
    projectId: job.input.projectId,
    identityId: job.input.identityId,
    title: job.title,
    script: job.input.script,
    tier: job.input.tier,
  }, { lock: true });
  const storedInput = withoutServerRenderProof(job.input);
  if (JSON.stringify(stableJson(storedInput)) !== JSON.stringify(stableJson(resolved.input))) {
    throw scriptedPhotoBindingError('Scripted-photo source binding changed before provider submission.', 409, 'CONSENT');
  }
  assertPersistedScriptedQuoteProof(job, storedInput);
  return resolved;
}

export async function finalizeReadyJob(jobId, artifact, { providerBinding = null } = {}) {
  const snapshot = providerBinding
    ? await withHeygenSpaceBindingReceiptTransaction({
      accountId: providerBinding.applicationAccountId, providerBinding,
    }, async tx => (await tx.select().from(videoJobs).where(and(
      eq(videoJobs.id, jobId), eq(videoJobs.accountId, providerBinding.applicationAccountId),
    )).for('share').limit(1))[0] || null)
    : await getJob(jobId);
  if (!snapshot) throw Object.assign(new Error('Video job not found.'), { statusCode: 404 });
  if (snapshot.provider === 'heygen' && !providerBinding) throw Object.assign(new Error('Verified HeyGen binding is required for finalization.'), { statusCode: 503, failureCategory: 'MISSING_PROVIDER_ACCOUNT_BINDING' });
  if (providerBinding && snapshot.provider !== 'heygen') throw Object.assign(new Error('HeyGen binding cannot finalize a different provider.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  if (!['finishing', 'ready'].includes(snapshot.status) || snapshot.videoDeletedAt) throw Object.assign(new Error('Job cannot accept final media in its current state.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  if (snapshot.status === 'ready' && !acceptedJobOutput(snapshot)) throw Object.assign(new Error('Legacy output requires separate revalidation.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  let expectedDurationMs = artifact?.sourceDurationMs;
  if (snapshot.provider === 'sadtalker') {
    const audio = await getOwnedMediaAsset(snapshot.accountId, snapshot.input?.audioReference?.assetId);
    expectedDurationMs = audio?.durationMs;
  }
  const validated = await acceptStoredFinalOutput(snapshot, artifact, expectedDurationMs);
  artifact = validated;
  const runTransaction = providerBinding
    ? callback => withHeygenSpaceBindingReceiptTransaction({ accountId: snapshot.accountId, providerBinding }, callback)
    : callback => database().transaction(async tx => {
      await acquireProviderLifecycleLock(tx, snapshot.accountId);
      return callback(tx);
    });
  return runTransaction(async (tx) => {
    const job = (await tx.select().from(videoJobs).where(eq(videoJobs.id, jobId)).for('update').limit(1))[0];
    if (!job) throw Object.assign(new Error('Video job not found.'), { statusCode: 404 });
    if (job.status === 'ready') {
      if (!job.videoDeletedAt && acceptedJobOutput(job) && job.output.privatePathname === artifact.privatePathname && job.output.sha256 === artifact.sha256 && job.output.bytes === artifact.bytes) return job;
      throw Object.assign(new Error('Final artifact conflicts with the completed job.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    }
    assertJobTransition(job.status, 'ready');
    if (job.accountId !== snapshot.accountId || job.provider !== snapshot.provider || job.format !== snapshot.format
      || JSON.stringify(stableJson(job.input)) !== JSON.stringify(stableJson(snapshot.input))
      || !acceptedJobOutput({ ...job, status: 'ready', output: artifact })) {
      throw Object.assign(new Error('Final acceptance does not match the reserved job.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    }
    const priorFinals = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.jobId, jobId), eq(mediaAssets.kind, 'final')));
    if (priorFinals.some(media => media.accountId !== job.accountId || media.privatePathname !== artifact.privatePathname || media.sha256 !== artifact.sha256 || media.bytes !== artifact.bytes)) {
      throw Object.assign(new Error('Job already references a different final artifact.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    }
    const account = (await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, job.accountId)).for('update').limit(1))[0];
    if (!account) throw Object.assign(new Error('Credit account not found.'), { statusCode: 404 });
    const sourceId = `render:${job.id}`;
    const charged = (await tx.select().from(creditTransactions).where(and(eq(creditTransactions.sourceType, 'render'), eq(creditTransactions.sourceId, sourceId))).limit(1))[0];
    if (charged && (charged.accountId !== job.accountId || charged.amount !== -job.costCredits || charged.metadata?.jobId !== jobId)) {
      throw Object.assign(new Error('Render settlement identity conflicts with the job.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    }
    if (!charged) {
      if (account.reserved < job.costCredits || account.balance < job.costCredits) throw Object.assign(new Error('Credit reservation mismatch.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      const balanceAfter = account.balance - job.costCredits;
      await tx.update(creditAccounts).set({ balance: balanceAfter, reserved: account.reserved - job.costCredits, spent: account.spent + job.costCredits, updatedAt: new Date() }).where(eq(creditAccounts.accountId, job.accountId));
      await tx.insert(creditTransactions).values({ accountId: job.accountId, sourceType: 'render', sourceId, amount: -job.costCredits, balanceAfter, metadata: { jobId } });
    }
    await tx.insert(mediaAssets).values({ accountId: job.accountId, jobId, kind: 'final', privatePathname: artifact.privatePathname, contentType: 'video/mp4', bytes: artifact.bytes, sha256: artifact.sha256, widthPx: artifact.width, heightPx: artifact.height, durationMs: Math.round(artifact.durationMs) }).onConflictDoNothing({ target: mediaAssets.privatePathname });
    const [media] = await tx.select().from(mediaAssets).where(eq(mediaAssets.privatePathname, artifact.privatePathname)).limit(1);
    if (!media || media.accountId !== job.accountId || media.jobId !== jobId || media.kind !== 'final' || media.sha256 !== artifact.sha256 || media.bytes !== artifact.bytes) {
      throw Object.assign(new Error('Final media ownership conflicts with acceptance.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    }
    if (job.provider === 'heygen' && job.providerJobId) {
      await releaseProviderVideoConsumerTx(tx, {
        accountId: job.accountId, jobId: job.id, providerJobId: job.providerJobId, providerBinding,
      });
    }
    const [ready] = await tx.update(videoJobs).set({ status: 'ready', output: artifact, failureCategory: null, updatedAt: new Date(), completedAt: new Date() }).where(eq(videoJobs.id, jobId)).returning();
    await tx.insert(jobEvents).values({ jobId, correlationId: job.correlationId, eventType: 'finish.completed', stageFrom: job.status, stageTo: 'ready', details: { bytes: artifact.bytes, sha256: artifact.sha256, ffmpegMs: artifact.ffmpegMs, acceptancePolicy: artifact.acceptance.policy, validatorVersion: artifact.acceptance.validatorVersion, media: artifact.acceptance.media } });
    // Additive, non-enumerable-in-spirit marker: the early return above (job
    // already ready) omits this, so callers can tell "just now finalized"
    // apart from "idempotent replay of an already-ready job" -- e.g. to send
    // a completion notification exactly once instead of on every workflow
    // step retry.
    return { ...ready, justCompleted: true };
  });
}

const IN_FLIGHT_JOB_STATUSES = Object.freeze(['workflow_started', 'provider_submitting', 'provider_submitted', 'provider_rendering', 'provider_ready', 'finish_contained', 'finishing']);

// Used by worker/render-worker.mjs (the VPS-hosted replacement for Vercel
// Workflow's dispatch) to find jobs that need their next step driven.
// 'provider_submit_unknown' is deliberately excluded -- those jobs are held
// pending manual reconciliation, not something a poll loop should keep
// hammering.
export async function listInFlightJobs(limit = 50) {
  return database().select().from(videoJobs).where(inArray(videoJobs.status, IN_FLIGHT_JOB_STATUSES)).orderBy(videoJobs.updatedAt).limit(Math.min(200, limit));
}

export async function listRecentJobs(limit = 100) {
  return database().select().from(videoJobs).orderBy(desc(videoJobs.updatedAt)).limit(Math.min(100, limit));
}

export async function markJobFailedAndRelease(jobId, failureCategory, message, rejectedArtifact, { expectedStatuses, protectedStatuses } = {}) {
  return database().transaction(async (tx) => {
    const job = (await tx.select().from(videoJobs).where(eq(videoJobs.id, jobId)).for('update').limit(1))[0];
    if (!job) return null;
    if (['ready', 'failed', 'cancelled'].includes(job.status)) return job;
    if (protectedStatuses?.includes(job.status)) return job;
    if (expectedStatuses && !expectedStatuses.includes(job.status)) return job;
    const charged = await tx.select().from(creditTransactions).where(and(eq(creditTransactions.sourceType, 'render'), eq(creditTransactions.sourceId, `render:${job.id}`))).limit(1);
    if (!charged[0]) {
      const account = (await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, job.accountId)).for('update').limit(1))[0];
      if (account) await tx.update(creditAccounts).set({ reserved: Math.max(0, account.reserved - job.costCredits), updatedAt: new Date() }).where(eq(creditAccounts.accountId, job.accountId));
    }
    const rejected = /^[a-f0-9]{64}$/.test(rejectedArtifact?.sha256 || '') && Number.isSafeInteger(rejectedArtifact?.bytes)
      ? { rejectedArtifact: { sha256: rejectedArtifact.sha256, bytes: rejectedArtifact.bytes } } : {};
    const [failed] = await tx.update(videoJobs).set({ status: 'failed', failureCategory, output: { message, ...rejected }, updatedAt: new Date(), completedAt: new Date() }).where(eq(videoJobs.id, jobId)).returning();
    await tx.insert(jobEvents).values({ jobId, correlationId: job.correlationId, eventType: 'workflow.failed', stageFrom: job.status, stageTo: 'failed', failureCategory, details: { message, ...rejected } });
    return failed;
  });
}

export async function listAccountJobs(accountId, limit = 30) {
  return database().select().from(videoJobs).where(eq(videoJobs.accountId, accountId)).orderBy(desc(videoJobs.updatedAt)).limit(Math.min(30, limit));
}

export async function getOwnedJob(accountId, jobId) {
  return (await database().select().from(videoJobs).where(and(eq(videoJobs.accountId, accountId), eq(videoJobs.id, jobId))).limit(1))[0] || null;
}

export async function reconciliationSummary() {
  const db = database();
  const [stuck, readyWithoutAsset] = await Promise.all([
    db.execute(sql`select count(*)::int as count from video_jobs where status not in ('ready','failed','cancelled') and updated_at < now() - interval '30 minutes'`),
    db.execute(sql`select count(*)::int as count from video_jobs j left join media_assets a on a.job_id = j.id and a.kind = 'final' where j.status = 'ready' and a.id is null`),
  ]);
  return { stuckJobs: Number(stuck.rows?.[0]?.count || 0), readyWithoutAsset: Number(readyWithoutAsset.rows?.[0]?.count || 0) };
}

// Jobs an operator actually needs to look at: never-completed terminal
// states plus the held-for-manual-reconciliation state (see
// worker/render-worker.mjs's comment on why provider_submit_unknown is
// deliberately excluded from the poll loop -- these are exactly the ones
// nothing will resolve automatically).
const ATTENTION_JOB_STATUSES = Object.freeze(['failed', 'cancelled', 'provider_submit_unknown']);

// Shared with the watchdog (see WATCHDOG_ACTIONABLE_STATUSES /
// WATCHDOG_AMBIGUOUS_STATUSES below) so "what counts as stale" has exactly
// one definition across the admin attention list and the automated sweep.
export const WATCHDOG_STALE_MINUTES_DEFAULT = 30;

// No providerJobId is confirmed to exist yet in any of these -- unlike the
// unconditional ATTENTION_JOB_STATUSES above, a job only belongs here once
// it's been silent long enough that "still working normally" stops being a
// reasonable explanation (dispatch to the workflow runtime never happened,
// a submission attempt never resolved, etc.).
const WATCHDOG_STALE_AMBIGUOUS_STATUSES = Object.freeze(['reserved', 'workflow_starting', 'workflow_started', 'provider_submitting']);

export async function listFailedOrStuckJobs(limit = 50) {
  return database()
    .select()
    .from(videoJobs)
    .where(or(
      inArray(videoJobs.status, ATTENTION_JOB_STATUSES),
      and(
        inArray(videoJobs.status, WATCHDOG_STALE_AMBIGUOUS_STATUSES),
        sql`${videoJobs.updatedAt} < now() - (${WATCHDOG_STALE_MINUTES_DEFAULT} * interval '1 minute')`,
      ),
    ))
    .orderBy(desc(videoJobs.updatedAt))
    .limit(Math.min(200, limit));
}

// Statuses where a providerJobId is guaranteed to exist (set in the same
// transitionJob call as the provider_submitted transition) -- safe for the
// watchdog to give one final poll/finish attempt via
// worker/render-worker.mjs's driveJobSafely and, failing that, safely time
// out via markJobFailedAndRelease. Deliberately excludes finish_contained:
// that status means hosted finishing is disabled by config (see
// api/video-os-lite/finalize-v2.js's 'hosted_finishing_disabled' response),
// not a stuck job -- treating it as stale would false-alarm on jobs working
// exactly as intended.
const WATCHDOG_ACTIONABLE_STATUSES = Object.freeze(['provider_submitted', 'provider_rendering', 'provider_ready', 'finishing']);

// provider_submit_unknown joins the ambiguous set here (unlike the attention
// list above, which always shows it regardless of age) -- the watchdog only
// alerts once a job has been silent past the threshold, not the instant it
// enters a held state. 'reserved' is deliberately excluded -- see
// WATCHDOG_SAFE_TO_RELEASE_STATUSES below for why it gets its own, safer
// treatment instead of joining this alert-only bucket.
const WATCHDOG_STALE_AMBIGUOUS_ALERT_STATUSES = Object.freeze(['workflow_starting', 'workflow_started', 'provider_submitting', 'provider_submit_unknown']);

// A job stuck at exactly 'reserved' (not any later status) proves
// claimWorkflowStart() was never called -- reserveRender() and
// claimWorkflowStart() are the only two transitions in or out of this
// status, and nothing between them ever contacts a provider. Unlike every
// other stale status above, there is no "a provider call might secretly be
// in flight" risk here to guess wrong about (GitHub issue #23's whole
// concern) -- so, unlike those, this is safe to auto-release rather than
// only alert on. claimWorkflowStart()'s own status-guard already handles
// the race where the original request is still genuinely in flight and
// completes after this fires: it re-checks status==='reserved' under a row
// lock and returns null if it's already moved on, and render-v2.js already
// treats a null claim as "report the job's current status," not a crash.
const WATCHDOG_SAFE_TO_RELEASE_STATUSES = Object.freeze(['reserved']);

async function listStaleJobsByStatus(statuses, staleAfterMinutes, limit) {
  return database()
    .select()
    .from(videoJobs)
    .where(and(inArray(videoJobs.status, statuses), sql`${videoJobs.updatedAt} < now() - (${staleAfterMinutes} * interval '1 minute')`))
    .orderBy(videoJobs.updatedAt)
    .limit(Math.min(200, limit));
}

// The two halves of what lib/video-os-watchdog.js's runWatchdogSweep() acts
// on. Never merge these into one list -- the whole point is that the
// watchdog treats them differently (attempt recovery vs. alert only), and a
// combined list would invite a future caller to treat them the same by
// accident.
export async function listStalledActionableJobs(staleAfterMinutes = WATCHDOG_STALE_MINUTES_DEFAULT, limit = 25) {
  return listStaleJobsByStatus(WATCHDOG_ACTIONABLE_STATUSES, staleAfterMinutes, limit);
}

export async function listStalledAmbiguousJobs(staleAfterMinutes = WATCHDOG_STALE_MINUTES_DEFAULT, limit = 25) {
  return listStaleJobsByStatus(WATCHDOG_STALE_AMBIGUOUS_ALERT_STATUSES, staleAfterMinutes, limit);
}

export async function listStalledSafeToReleaseJobs(staleAfterMinutes = WATCHDOG_STALE_MINUTES_DEFAULT, limit = 25) {
  return listStaleJobsByStatus(WATCHDOG_SAFE_TO_RELEASE_STATUSES, staleAfterMinutes, limit);
}

export async function getJobEventTimeline(jobId) {
  return database().select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).orderBy(jobEvents.createdAt);
}

export async function listRecentAccounts(limit = 50) {
  const bounded = Math.min(200, limit);
  return database()
    .select({
      accountId: users.id, email: users.email, name: users.name, role: users.role,
      createdAt: users.createdAt, updatedAt: users.updatedAt,
      balance: creditAccounts.balance, reserved: creditAccounts.reserved, purchased: creditAccounts.purchased, spent: creditAccounts.spent,
    })
    .from(users)
    .leftJoin(creditAccounts, eq(creditAccounts.accountId, users.id))
    .orderBy(desc(users.createdAt))
    .limit(bounded);
}

export async function getAdminOverview() {
  const db = database();
  const now = Date.now();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const countOf = (table, condition) => db.select({ count: sql`count(*)::int` }).from(table).where(condition).then((rows) => rows[0].count);

  const [totalUsers, newUsers7d, newUsers30d, signIns7d, signIns30d, jobStatusRows, creditTotalsRows, reconciliation] = await Promise.all([
    db.select({ count: sql`count(*)::int` }).from(users).then((rows) => rows[0].count),
    countOf(users, gte(users.createdAt, since7d)),
    countOf(users, gte(users.createdAt, since30d)),
    countOf(authSessions, gte(authSessions.issuedAt, since7d)),
    countOf(authSessions, gte(authSessions.issuedAt, since30d)),
    db.select({ status: videoJobs.status, count: sql`count(*)::int` }).from(videoJobs).groupBy(videoJobs.status),
    db.select({
      balance: sql`coalesce(sum(${creditAccounts.balance}), 0)::int`,
      reserved: sql`coalesce(sum(${creditAccounts.reserved}), 0)::int`,
      purchased: sql`coalesce(sum(${creditAccounts.purchased}), 0)::int`,
      spent: sql`coalesce(sum(${creditAccounts.spent}), 0)::int`,
    }).from(creditAccounts),
    reconciliationSummary(),
  ]);

  return {
    users: { total: totalUsers, new7d: newUsers7d, new30d: newUsers30d },
    // Only counts sign-ins recorded since recordSignIn() started being
    // called -- there is no historical backfill, since no prior sign-in
    // ever wrote a row (see recordSignIn()'s own comment).
    signIns: { last7d: signIns7d, last30d: signIns30d },
    jobsByStatus: Object.fromEntries(jobStatusRows.map((row) => [row.status, row.count])),
    credits: creditTotalsRows[0],
    reconciliation,
  };
}

// Admin Phase 2: manual resolution for a job stuck in provider_submit_unknown
// (or any other non-terminal state an operator has decided to close out by
// hand). This is markJobFailedAndRelease under a distinct failure category
// so its jobEvents entry -- and therefore the job's own timeline -- is
// visibly distinguishable from an automatic failure, not a new code path:
// same idempotent guard (already-terminal jobs are a safe no-op), same
// credit-release logic.
export async function adminResolveJob(jobId, note) {
  return markJobFailedAndRelease(jobId, 'ADMIN_MANUAL_RESOLUTION', String(note || 'Resolved by an administrator.').slice(0, 300));
}

export async function listMediaAssetsForJob(jobId) {
  return database().select().from(mediaAssets).where(eq(mediaAssets.jobId, jobId)).orderBy(desc(mediaAssets.createdAt));
}

// Wires up mediaAssets.quarantinedAt, which already existed in the schema
// and is already *checked* (db/standard-narration-repository.js refuses to
// resolve a quarantined portrait/audio source) but was never settable by
// anything until now. There is no dedicated reason column on media_assets;
// the reason is not persisted here, only logged by the caller (see
// routes/video-os-lite/admin.js) -- adding a real audit column is a
// follow-up if this sees real use, not a blocker for the mechanism itself.
export async function quarantineMediaAsset(mediaAssetId) {
  const [updated] = await database().update(mediaAssets).set({ quarantinedAt: new Date() }).where(eq(mediaAssets.id, mediaAssetId)).returning();
  return updated || null;
}

export async function listRecentCreditTransactions(limit = 50) {
  return database().select().from(creditTransactions).orderBy(desc(creditTransactions.createdAt)).limit(Math.min(200, limit));
}

export async function listRecentStripeEvents(limit = 50) {
  return database().select().from(stripeEvents).orderBy(desc(stripeEvents.receivedAt)).limit(Math.min(200, limit));
}

// Both scoped by time, not by an incoming ID list, so lib/video-os-stripe-
// reconciliation.js can build its own in-memory sessionId -> row maps from
// one bounded query each, then check every real Stripe session it fetched
// against them (and vice versa) without N+1 lookups.
export async function listStripeEventsSince(since, limit = 500) {
  return database().select().from(stripeEvents).where(gte(stripeEvents.receivedAt, since)).orderBy(desc(stripeEvents.receivedAt)).limit(Math.min(1000, limit));
}

export async function listStripeCreditTransactionsSince(since, limit = 500) {
  return database().select().from(creditTransactions)
    .where(and(eq(creditTransactions.sourceType, 'stripe'), gte(creditTransactions.createdAt, since)))
    .orderBy(desc(creditTransactions.createdAt)).limit(Math.min(1000, limit));
}

// Admin-only tracking flag, deliberately with no effect on customer-facing
// behavior or the job status state machine -- see the schema column's own
// comment in db/schema.js.
export async function markJobReviewed(jobId) {
  const [updated] = await database().update(videoJobs).set({ reviewedAt: new Date() }).where(eq(videoJobs.id, jobId)).returning();
  return updated || null;
}

// DB-only half of "delete this video": records that the private final file
// was removed while keeping the job row and its event history. The actual
// Blob deletion is orchestrated by the caller (routes/video-os-lite/admin.js)
// alongside this, matching how Blob + DB writes are already coordinated at
// the route/service layer elsewhere in this codebase rather than inside
// repositories.js itself.
export async function markJobVideoDeleted(jobId) {
  const [updated] = await database().update(videoJobs).set({ videoDeletedAt: new Date() }).where(eq(videoJobs.id, jobId)).returning();
  return updated || null;
}

// Atomic fixed-window counter, safe under concurrent requests for the same
// key: a single upsert either starts a fresh window (row absent, or the
// existing window already expired) or increments the live one. Used by the
// AI Copywriter route to cap requests per account without a second
// read-then-write round trip that could race.
export async function consumeRateLimit({ accountId, key, limit, windowMs }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + windowMs);
  const [row] = await database().insert(rateLimits)
    .values({ key, accountId, windowStart: now, count: 1, expiresAt })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${rateLimits.expiresAt} > now() then ${rateLimits.count} + 1 else 1 end`,
        windowStart: sql`case when ${rateLimits.expiresAt} > now() then ${rateLimits.windowStart} else now() end`,
        expiresAt: sql`case when ${rateLimits.expiresAt} > now() then ${rateLimits.expiresAt} else ${expiresAt}::timestamptz end`,
      },
    })
    .returning();
  return row.count <= limit;
}

export async function registerAdminTester({ email, name, credits = 5000, note = 'Registered via Admin Console' }) {
  if (!email || !String(email).includes('@')) throw Object.assign(new Error('Valid email address is required.'), { statusCode: 400 });
  const normalizedEmail = String(email).trim().toLowerCase();
  const { createHash } = await import('node:crypto');
  const initialCredits = Math.max(100, Number(credits) || 5000);

  return database().transaction(async (tx) => {
    const now = new Date();
    const matches = await tx.select().from(users).where(sql`lower(${users.email}) = ${normalizedEmail}`).for('update').limit(2);
    if (matches.length > 1) throw Object.assign(new Error('Account identity requires reconciliation.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    const [existingUser] = matches;
    // Same canonical identity as accountIdForEmail; avoid importing the HTTP/session
    // module into the workflow bundle. Regression coverage binds both algorithms.
    const accountId = existingUser?.id || 'user-' + createHash('sha256').update(normalizedEmail).digest('hex').slice(0, 24);
    await tx.insert(users).values({
      id: accountId,
      email: normalizedEmail,
      name: name || normalizedEmail,
      role: 'tester',
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: users.id,
      set: {
        role: 'tester',
        email: normalizedEmail,
        name: name || normalizedEmail,
        updatedAt: now,
      },
    });

    await tx.insert(creditAccounts).values({
      accountId,
      balance: initialCredits,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: creditAccounts.accountId,
      set: {
        balance: sql`greatest(${creditAccounts.balance}, ${initialCredits})`,
        updatedAt: now,
      },
    });

    const testerEntitlements = ['standardRendering', 'liveRendering', 'tester'];
    for (const key of testerEntitlements) {
      await tx.insert(entitlements).values({
        accountId,
        entitlementKey: key,
        enabled: true,
        sourceType: 'admin_tester_grant',
        sourceId: 'admin_console',
        metadata: { note: String(note || '').slice(0, 200) },
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [entitlements.accountId, entitlements.entitlementKey],
        set: {
          enabled: true,
          sourceType: 'admin_tester_grant',
          sourceId: 'admin_console',
          metadata: { note: String(note || '').slice(0, 200) },
          updatedAt: now,
        },
      });
    }

    return getAccountContext(accountId, tx);
  });
}

export async function listAdminTesters() {
  const rows = await database().select({
    accountId: users.id,
    email: users.email,
    name: users.name,
    role: users.role,
    createdAt: users.createdAt,
    balance: creditAccounts.balance,
    spent: creditAccounts.spent,
  })
  .from(users)
  .leftJoin(creditAccounts, eq(users.id, creditAccounts.accountId))
  .where(or(
    eq(users.role, 'tester'),
    sql`${users.email} like '%@luxmarketingcompany.com'`
  ))
  .orderBy(desc(users.createdAt));

  // Listing is read-only, including legacy domain accounts with role 'tester'.
  return rows;
}

export async function revokeAdminTester(accountId) {
  if (!accountId) throw Object.assign(new Error('accountId is required.'), { statusCode: 400 });
  return database().transaction(async (tx) => {
    const now = new Date();
    await tx.update(users).set({ role: 'customer', updatedAt: now }).where(eq(users.id, accountId));
    await tx.update(entitlements).set({ enabled: false, sourceType: 'admin_tester_grant', sourceId: 'admin_console', updatedAt: now }).where(and(
      eq(entitlements.accountId, accountId),
      inArray(entitlements.entitlementKey, ['standardRendering', 'liveRendering', 'tester'])
    ));
    return getAccountContext(accountId, tx);
  });
}

