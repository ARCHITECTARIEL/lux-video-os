import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { database } from './client.js';
import { registerTesterAccountId, revokeTesterAccountId } from '../lib/video-os-testers.js';
import { IDENTITY_CONSENT_POLICY_VERSION } from '../lib/video-os-identity-policy.js';
import { authSessions, creditAccounts, creditTransactions, entitlements, identityConsents, jobEvents, mediaAssets, projects, rateLimits, stripeEvents, userIdentities, users, videoJobs } from './schema.js';

export const IDENTITY_COMPONENT_STATUSES = Object.freeze(['DRAFT', 'UPLOADING', 'CREATING', 'PROCESSING', 'READY', 'FAILED']);
export const IDENTITY_OVERALL_STATUSES = Object.freeze(['DRAFT', 'UPLOADING', 'CREATING_AVATAR', 'CLONING_VOICE', 'PROCESSING', 'READY', 'PARTIAL_FAILURE', 'FAILED', 'ARCHIVED']);
const AUTH_ENTITLEMENT_SOURCE = 'validated_auth';

export function reconcileAuthenticatedEntitlements(existingGrants = [], entitlementKeys = []) {
  const desiredKeys = [...new Set(entitlementKeys)];
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
    // Deliberately decoupled from `role`: role is also set to 'tester' for a
    // pure domain match (extra starting credits + admin-console visibility,
    // both intentionally broad -- see lib/video-os-testers.js), but
    // registerTesterAccountId() feeds REGISTERED_TESTER_ACCOUNTS, which
    // isTesterAccountId() then treats as equivalent to an exact,
    // individually-designated tester -- full liveRendering, not just
    // Standard. Gating this on `role === 'tester'` used to mean EVERY
    // domain-matched sign-in (magic-link or Google) silently registered
    // itself into that bypass set, reopening the exact liveRendering leak
    // fixed in containedRenderingEntitlementKeys() through yet another path
    // (the third instance found so far was the admin console merely
    // listing testers; this is a fourth, and fires on ordinary sign-in
    // itself). Callers must now pass registerAsTester explicitly, computed
    // from the same narrow isTesterEmailExact()/isTesterAccountId() check
    // used everywhere else this distinction already matters.
    if (registerAsTester && initialCredits > 0) {
      registerTesterAccountId(accountId);
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

export async function getAccountContext(accountId, executor = database()) {
  const account = await getAccount(accountId, executor);
  if (!account) return null;
  const grants = await executor.select().from(entitlements).where(and(eq(entitlements.accountId, accountId), eq(entitlements.enabled, true)));
  return { ...account, entitlements: Object.fromEntries(grants.map((grant) => [grant.entitlementKey, true])) };
}

export async function reserveRender({ jobId, accountId, idempotencyKey, correlationId, provider, title, format, costCredits, input }) {
  return database().transaction(async (tx) => {
    const accounts = await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId)).for('update').limit(1);
    const account = accounts[0];
    if (!account) throw Object.assign(new Error('Credit account not found.'), { statusCode: 404 });
    const existing = await tx.select().from(videoJobs).where(and(eq(videoJobs.accountId, accountId), eq(videoJobs.idempotencyKey, idempotencyKey))).limit(1);
    if (existing[0]) return { job: existing[0], replayed: true };
    if (account.balance - account.reserved < costCredits) throw Object.assign(new Error('Insufficient credits.'), { statusCode: 402, failureCategory: 'ENTITLEMENT' });
    await tx.update(creditAccounts).set({ reserved: account.reserved + costCredits, updatedAt: new Date() }).where(eq(creditAccounts.accountId, accountId));
    const [job] = await tx.insert(videoJobs).values({ id: jobId, accountId, projectId: input.projectId, idempotencyKey, correlationId, provider, status: 'reserved', title, format, costCredits, input }).returning();
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
  return database().transaction(async (tx) => {
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

export async function transitionJob({ jobId, stageTo, eventType, providerJobId, output, failureCategory, details = {} }) {
  return database().transaction(async (tx) => {
    const current = (await tx.select().from(videoJobs).where(eq(videoJobs.id, jobId)).for('update').limit(1))[0];
    if (!current) throw Object.assign(new Error('Video job not found.'), { statusCode: 404 });
    assertJobTransition(current.status, stageTo);
    const terminal = ['ready', 'failed', 'cancelled'];
    const [job] = await tx.update(videoJobs).set({ status: stageTo, providerJobId: providerJobId || current.providerJobId, output: output || current.output, failureCategory: failureCategory || null, updatedAt: new Date(), completedAt: terminal.includes(stageTo) ? new Date() : null }).where(eq(videoJobs.id, jobId)).returning();
    await tx.insert(jobEvents).values({ jobId, correlationId: current.correlationId, eventType, stageFrom: current.status, stageTo, failureCategory, details });
    return job;
  });
}

export async function finalizeRenderCredit(jobId) {
  return database().transaction(async (tx) => {
    const job = (await tx.select().from(videoJobs).where(eq(videoJobs.id, jobId)).for('update').limit(1))[0];
    if (!job) throw Object.assign(new Error('Video job not found.'), { statusCode: 404 });
    const sourceId = `render:${job.id}`;
    const existing = await tx.select().from(creditTransactions).where(and(eq(creditTransactions.sourceType, 'render'), eq(creditTransactions.sourceId, sourceId))).limit(1);
    if (existing[0]) return { transaction: existing[0], replayed: true };
    const account = (await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, job.accountId)).for('update').limit(1))[0];
    if (!account || account.reserved < job.costCredits || account.balance < job.costCredits) throw Object.assign(new Error('Credit reservation mismatch.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    const balanceAfter = account.balance - job.costCredits;
    await tx.update(creditAccounts).set({ balance: balanceAfter, reserved: account.reserved - job.costCredits, spent: account.spent + job.costCredits, updatedAt: new Date() }).where(eq(creditAccounts.accountId, job.accountId));
    const [transaction] = await tx.insert(creditTransactions).values({ accountId: job.accountId, sourceType: 'render', sourceId, amount: -job.costCredits, balanceAfter, metadata: { jobId } }).returning();
    return { transaction, replayed: false };
  });
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

export async function attachProviderMediaAsset({ accountId, assetId, provider, providerAssetId }) {
  const [updated] = await database().update(mediaAssets).set({ provider, providerAssetId, providerUploadedAt: new Date() })
    .where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, assetId), isNull(mediaAssets.providerAssetId))).returning();
  if (updated) return { asset: updated, replayed: false };
  const existing = await getOwnedMediaAsset(accountId, assetId);
  if (!existing) throw Object.assign(new Error('Asset not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
  if (existing.provider === provider && existing.providerAssetId === providerAssetId) return { asset: existing, replayed: true };
  throw Object.assign(new Error('Asset provider identity is already reserved.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
}

async function ownedIdentityForUpdate(tx, accountId, identityId) {
  return (await tx.select().from(userIdentities).where(and(eq(userIdentities.accountId, accountId), eq(userIdentities.id, identityId))).for('update').limit(1))[0] || null;
}

export function assertIdentitySourceAssets(photo, voice) {
  if (!photo || !voice) throw Object.assign(new Error('Identity source asset not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
  if (photo.kind !== 'identity-photo-source' || !photo.contentType.startsWith('image/')) {
    throw Object.assign(new Error('Identity photo source is invalid.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  }
  if (voice.kind !== 'identity-voice-source' || !voice.contentType.startsWith('audio/')) {
    throw Object.assign(new Error('Identity voice source is invalid.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  }
  return true;
}

export async function createIdentityDraft({ accountId, displayName, sourcePhotoAssetId, sourceVoiceAssetId, provider = 'heygen' }) {
  return database().transaction(async (tx) => {
    const photo = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, sourcePhotoAssetId))).limit(1))[0];
    const voice = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, sourceVoiceAssetId))).limit(1))[0];
    assertIdentitySourceAssets(photo, voice);
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

export async function getRenderAuthorizedIdentity(accountId, identityId, policyVersion = IDENTITY_CONSENT_POLICY_VERSION) {
  return database().transaction(async (tx) => {
    const identity = (await tx.select().from(userIdentities).where(and(eq(userIdentities.accountId, accountId), eq(userIdentities.id, identityId))).limit(1))[0] || null;
    if (!identity) return null;
    await assertActiveIdentityConsent(tx, identity, policyVersion);
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
    const identity = await ownedIdentityForUpdate(tx, accountId, identityId);
    if (!identity || identity.archivedAt) throw Object.assign(new Error('Identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    const photo = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, identity.sourcePhotoAssetId))).limit(1))[0];
    const voice = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, identity.sourceVoiceAssetId))).limit(1))[0];
    if (!photo || !voice) throw Object.assign(new Error('Identity source asset not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
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

async function assertActiveIdentityConsent(tx, identity, policyVersion = IDENTITY_CONSENT_POLICY_VERSION) {
  const consent = (await tx.select().from(identityConsents).where(and(
    eq(identityConsents.accountId, identity.accountId),
    eq(identityConsents.identityId, identity.id),
    eq(identityConsents.policyVersion, policyVersion),
    isNull(identityConsents.revokedAt),
  )).orderBy(desc(identityConsents.acceptedAt)).limit(1))[0];
  if (!consent) throw Object.assign(new Error('Identity consent is required.'), { statusCode: 409, failureCategory: 'CONSENT' });
  const photo = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, identity.accountId), eq(mediaAssets.id, identity.sourcePhotoAssetId))).limit(1))[0];
  const voice = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, identity.accountId), eq(mediaAssets.id, identity.sourceVoiceAssetId))).limit(1))[0];
  if (!photo || !voice || photo.sha256 !== consent.photoSha256 || voice.sha256 !== consent.voiceSha256) {
    throw Object.assign(new Error('Identity consent no longer matches its source assets.'), { statusCode: 409, failureCategory: 'CONSENT' });
  }
  return consent;
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

export async function reserveIdentityComponentCreation({ accountId, identityId, component, operationKey }) {
  const fields = componentFields(component);
  return database().transaction(async (tx) => {
    const identity = await ownedIdentityForUpdate(tx, accountId, identityId);
    if (!identity || identity.archivedAt) throw Object.assign(new Error('Identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    if (identity[fields.operation] === operationKey) return { identity, replayed: true };
    if (ACTIVE_COMPONENT_STATUSES.has(identity[fields.status])) throw Object.assign(new Error('Identity component creation is already in progress.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (identity[fields.status] === 'READY') throw Object.assign(new Error('Identity component is already ready.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (!['DRAFT', 'FAILED'].includes(identity[fields.status])) throw Object.assign(new Error('Identity component cannot be submitted from its current state.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    await assertActiveIdentityConsent(tx, identity);
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

export async function recordIdentityProviderSubmission({ accountId, identityId, component, operationKey, providerRequestId, providerAvatarGroupId, providerRenderableAvatarId, providerVoiceId }) {
  const fields = componentFields(component);
  return database().transaction(async (tx) => {
    const identity = await ownedIdentityForUpdate(tx, accountId, identityId);
    if (!identity || identity.archivedAt) throw Object.assign(new Error('Identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    if (identity[fields.operation] !== operationKey) throw Object.assign(new Error('Identity operation does not match the reserved submission.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (!['CREATING', 'PROCESSING'].includes(identity[fields.status])) throw Object.assign(new Error('Identity component is not awaiting a provider submission.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (component === 'avatar' && !providerRequestId && !identity.providerAvatarRequestId) throw Object.assign(new Error('Provider avatar request identity is required.'), { statusCode: 400, failureCategory: 'VALIDATION' });
    if (component === 'voice' && !providerVoiceId && !identity.providerVoiceId) throw Object.assign(new Error('Provider voice identity is required.'), { statusCode: 400, failureCategory: 'VALIDATION' });
    assertProviderResourceConsistency(identity, { providerAvatarRequestId: providerRequestId, providerAvatarGroupId, providerRenderableAvatarId, providerVoiceId });
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
    return updated;
  });
}

export async function markIdentityComponentReady({ accountId, identityId, component, operationKey, providerAvatarGroupId, providerRenderableAvatarId, providerVoiceId }) {
  const fields = componentFields(component);
  return database().transaction(async (tx) => {
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

export async function markIdentityComponentFailed({ accountId, identityId, component, operationKey, failureCode, failureMessage }) {
  const fields = componentFields(component);
  const failure = redactIdentityFailure(failureCode, failureMessage);
  return database().transaction(async (tx) => {
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
    const identity = await ownedIdentityForUpdate(tx, accountId, identityId);
    if (!identity) throw Object.assign(new Error('Identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    if (identity.archivedAt) return identity;
    const archivedAt = new Date();
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

export async function finalizeReadyJob(jobId, artifact) {
  return database().transaction(async (tx) => {
    const job = (await tx.select().from(videoJobs).where(eq(videoJobs.id, jobId)).for('update').limit(1))[0];
    if (!job) throw Object.assign(new Error('Video job not found.'), { statusCode: 404 });
    if (job.status === 'ready') return job;
    const account = (await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, job.accountId)).for('update').limit(1))[0];
    if (!account) throw Object.assign(new Error('Credit account not found.'), { statusCode: 404 });
    const sourceId = `render:${job.id}`;
    const charged = (await tx.select().from(creditTransactions).where(and(eq(creditTransactions.sourceType, 'render'), eq(creditTransactions.sourceId, sourceId))).limit(1))[0];
    if (!charged) {
      if (account.reserved < job.costCredits || account.balance < job.costCredits) throw Object.assign(new Error('Credit reservation mismatch.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      const balanceAfter = account.balance - job.costCredits;
      await tx.update(creditAccounts).set({ balance: balanceAfter, reserved: account.reserved - job.costCredits, spent: account.spent + job.costCredits, updatedAt: new Date() }).where(eq(creditAccounts.accountId, job.accountId));
      await tx.insert(creditTransactions).values({ accountId: job.accountId, sourceType: 'render', sourceId, amount: -job.costCredits, balanceAfter, metadata: { jobId } });
    }
    await tx.insert(mediaAssets).values({ accountId: job.accountId, jobId, kind: 'final', privatePathname: artifact.privatePathname, contentType: 'video/mp4', bytes: artifact.bytes, sha256: artifact.sha256 }).onConflictDoUpdate({ target: mediaAssets.privatePathname, set: { bytes: artifact.bytes, sha256: artifact.sha256, contentType: 'video/mp4' } });
    const [ready] = await tx.update(videoJobs).set({ status: 'ready', output: artifact, failureCategory: null, updatedAt: new Date(), completedAt: new Date() }).where(eq(videoJobs.id, jobId)).returning();
    await tx.insert(jobEvents).values({ jobId, correlationId: job.correlationId, eventType: 'finish.completed', stageFrom: job.status, stageTo: 'ready', details: { bytes: artifact.bytes, sha256: artifact.sha256, ffmpegMs: artifact.ffmpegMs } });
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

export async function markJobFailedAndRelease(jobId, failureCategory, message) {
  return database().transaction(async (tx) => {
    const job = (await tx.select().from(videoJobs).where(eq(videoJobs.id, jobId)).for('update').limit(1))[0];
    if (!job) return null;
    if (['ready', 'failed', 'cancelled'].includes(job.status)) return job;
    const charged = await tx.select().from(creditTransactions).where(and(eq(creditTransactions.sourceType, 'render'), eq(creditTransactions.sourceId, `render:${job.id}`))).limit(1);
    if (!charged[0]) {
      const account = (await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, job.accountId)).for('update').limit(1))[0];
      if (account) await tx.update(creditAccounts).set({ reserved: Math.max(0, account.reserved - job.costCredits), updatedAt: new Date() }).where(eq(creditAccounts.accountId, job.accountId));
    }
    const [failed] = await tx.update(videoJobs).set({ status: 'failed', failureCategory, output: { message }, updatedAt: new Date(), completedAt: new Date() }).where(eq(videoJobs.id, jobId)).returning();
    await tx.insert(jobEvents).values({ jobId, correlationId: job.correlationId, eventType: 'workflow.failed', stageFrom: job.status, stageTo: 'failed', failureCategory, details: { message } });
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
  const accountId = 'acct-' + createHash('sha256').update(normalizedEmail).digest('hex').slice(0, 16);
  const initialCredits = Math.max(100, Number(credits) || 5000);
  registerTesterAccountId(accountId);

  return database().transaction(async (tx) => {
    const now = new Date();
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

  for (const r of rows) {
    registerTesterAccountId(r.accountId);
  }
  return rows;
}

export async function revokeAdminTester(accountId) {
  if (!accountId) throw Object.assign(new Error('accountId is required.'), { statusCode: 400 });
  revokeTesterAccountId(accountId);
  return database().transaction(async (tx) => {
    const now = new Date();
    await tx.update(users).set({ role: 'customer', updatedAt: now }).where(eq(users.id, accountId));
    await tx.update(entitlements).set({ enabled: false, updatedAt: now }).where(and(
      eq(entitlements.accountId, accountId),
      inArray(entitlements.entitlementKey, ['standardRendering', 'liveRendering', 'tester'])
    ));
    return getAccountContext(accountId, tx);
  });
}

