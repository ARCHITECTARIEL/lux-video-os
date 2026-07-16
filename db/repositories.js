import { and, desc, eq, sql } from 'drizzle-orm';
import { database } from './client.js';
import { creditAccounts, creditTransactions, jobEvents, mediaAssets, projects, stripeEvents, users, videoJobs } from './schema.js';

export async function ensureAccount({ accountId, email, name, initialCredits = 0 }) {
  return database().transaction(async (tx) => {
    await tx.insert(users).values({ id: accountId, email: email || null, name: name || 'Video OS Account' }).onConflictDoUpdate({ target: users.id, set: { email: email || null, name: name || 'Video OS Account', updatedAt: new Date() } });
    await tx.insert(creditAccounts).values({ accountId, balance: initialCredits }).onConflictDoNothing();
    return getAccount(accountId, tx);
  });
}

export async function getAccount(accountId, executor = database()) {
  const rows = await executor.select({ user: users, credits: creditAccounts }).from(users).innerJoin(creditAccounts, eq(users.id, creditAccounts.accountId)).where(eq(users.id, accountId)).limit(1);
  return rows[0] || null;
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
  reserved: ['workflow_starting', 'failed', 'cancelled'],
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
  const [job] = await database().update(videoJobs).set({ workflowRunId, status: 'workflow_started', updatedAt: new Date() }).where(and(eq(videoJobs.id, jobId), eq(videoJobs.status, 'workflow_starting'))).returning();
  return job || null;
}

export async function claimWorkflowStart(jobId) {
  const [job] = await database().update(videoJobs).set({ status: 'workflow_starting', updatedAt: new Date() }).where(and(eq(videoJobs.id, jobId), eq(videoJobs.status, 'reserved'))).returning();
  return job || null;
}

export async function getJob(jobId) {
  return (await database().select().from(videoJobs).where(eq(videoJobs.id, jobId)).limit(1))[0] || null;
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

export async function addMediaAsset(asset) {
  const [created] = await database().insert(mediaAssets).values(asset).onConflictDoUpdate({ target: mediaAssets.privatePathname, set: { bytes: asset.bytes, sha256: asset.sha256, contentType: asset.contentType } }).returning();
  return created;
}

export async function getOwnedMediaAsset(accountId, assetId) {
  return (await database().select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, assetId))).limit(1))[0] || null;
}

export async function saveProject({ id, accountId, title, script, avatar, voice, settings }) {
  const values = { accountId, title, script, avatar, voice, settings, updatedAt: new Date() };
  if (id) {
    const [updated] = await database().update(projects).set(values).where(and(eq(projects.id, id), eq(projects.accountId, accountId))).returning();
    if (!updated) throw Object.assign(new Error('Project not found.'), { statusCode: 404 });
    return updated;
  }
  return (await database().insert(projects).values(values).returning())[0];
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
    return ready;
  });
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
