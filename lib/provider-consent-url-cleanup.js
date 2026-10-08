import { sql, and, eq } from 'drizzle-orm';
import { database } from '../db/client.js';
import { providerLifecycleEvents } from '../db/schema.js';
import { deleteExpiredProviderConsentUrl } from './provider-consent-url-store.js';

function checkedLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Hosted consent cleanup limit must be 1 to 100.');
  return limit;
}

async function listCandidates({ now, limit }) {
  const result = await database().execute(sql`
    select e.id as issued_event_id, e.application_account_id as account_id,
      e.origin_scope_key, e.operation_id, e.correlation_id,
      e.private_evidence_ref as path,
      e.details->>'providerUrlExpiresAt' as expires_at
    from provider_lifecycle_events e
    where e.event_type = 'provider.avatar_consent_session_issued'
      and e.private_evidence_ref like 'video-os/auth/provider-consent/%.json'
      and e.details ? 'providerUrlExpiresAt'
      and (e.details->>'providerUrlExpiresAt')::timestamptz <= ${new Date(now)}
      and not exists (
        select 1 from provider_lifecycle_events cleaned
        where cleaned.operation_id = e.operation_id
          and cleaned.event_type = 'provider.avatar_consent_url_deleted'
          and cleaned.details->>'issuedEventId' = e.id::text
      )
    order by e.observed_at asc
    limit ${limit}
  `);
  return (result.rows || []).map(row => ({
    issuedEventId: row.issued_event_id,
    accountId: row.account_id,
    originScopeKey: row.origin_scope_key,
    operationId: row.operation_id,
    correlationId: row.correlation_id,
    path: row.path,
    expiresAt: row.expires_at,
  }));
}

async function recordCleanup(input) {
  await database().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.issuedEventId}, 0))`);
    const [issued] = await tx.select().from(providerLifecycleEvents).where(and(
      eq(providerLifecycleEvents.id, input.issuedEventId),
      eq(providerLifecycleEvents.operationId, input.operationId),
      eq(providerLifecycleEvents.applicationAccountId, input.accountId),
      eq(providerLifecycleEvents.eventType, 'provider.avatar_consent_session_issued'),
    )).limit(1);
    const expiresAt = Date.parse(issued?.details?.providerUrlExpiresAt);
    if (!issued || issued.originScopeKey !== input.originScopeKey || issued.privateEvidenceRef !== input.path
      || !Number.isFinite(expiresAt) || expiresAt > input.now) {
      throw new Error('Hosted consent cleanup evidence changed.');
    }
    const existing = await tx.select({ id: providerLifecycleEvents.id }).from(providerLifecycleEvents).where(and(
      eq(providerLifecycleEvents.operationId, input.operationId),
      eq(providerLifecycleEvents.eventType, 'provider.avatar_consent_url_deleted'),
    )).limit(100);
    // The advisory lock serializes this operation's cleanup writers. A
    // single issued session belongs to each consent attempt.
    if (existing.length) return;
    await tx.insert(providerLifecycleEvents).values({
      applicationAccountId: issued.applicationAccountId,
      originScopeKey: issued.originScopeKey,
      operationId: issued.operationId,
      correlationId: issued.correlationId,
      eventType: 'provider.avatar_consent_url_deleted',
      privateEvidenceRef: issued.privateEvidenceRef,
      evidenceDigest: issued.evidenceDigest,
      details: { issuedEventId: issued.id, storageState: input.deleted ? 'deleted' : 'already_absent' },
      observedAt: new Date(input.now),
    });
  });
}

export async function sweepExpiredHostedConsentUrls({ now = Date.now(), limit = 25, execute = false } = {}, {
  listCandidates: list = listCandidates,
  purgeUrl = deleteExpiredProviderConsentUrl,
  recordCleanup: record = recordCleanup,
} = {}) {
  const checkedNow = Number(now);
  if (!Number.isFinite(checkedNow)) throw new TypeError('Hosted consent cleanup time is invalid.');
  const candidates = await list({ now: checkedNow, limit: checkedLimit(limit) });
  const result = { examined: candidates.length, eligible: 0, deleted: 0, absent: 0, failed: 0, dryRun: !execute };
  for (const candidate of candidates) {
    const expiry = Date.parse(candidate.expiresAt);
    if (!Number.isFinite(expiry) || expiry > checkedNow) continue;
    result.eligible += 1;
    if (!execute) continue;
    try {
      const deleted = await purgeUrl({ path: candidate.path, operationId: candidate.operationId }, { now: checkedNow });
      await record({ ...candidate, deleted, now: checkedNow });
      if (deleted) result.deleted += 1;
      else result.absent += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
