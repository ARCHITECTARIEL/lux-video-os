import crypto from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { database } from './client.js';
import { acquireProviderLifecycleLock } from './provider-lifecycle-lock.js';
import { renderAuthorization, assertJobAuthorizationBinding, stableJson } from '../lib/video-os-render-authorization.js';
import {
  creditAccounts,
  entitlements,
  identityConsents,
  jobEvents,
  mediaAssets,
  projects,
  userIdentities,
  videoJobs,
} from './schema.js';
import { standardNarrationConsents, standardNarrationQuotes } from './standard-narration-schema.js';
import { IDENTITY_CONSENT_POLICY_VERSION } from '../lib/video-os-identity-policy.js';
import { parseSadtalkerStageAInput } from '../lib/video-os-validation.js';
import {
  sanitizeStandardNarrationReason,
  STANDARD_CONTRACT_VERSION,
  STANDARD_NARRATION_CREDITS,
  STANDARD_NARRATION_POLICY_VERSION,
  STANDARD_NARRATION_PRICING_VERSION,
  STANDARD_NARRATION_PROCESSING_SCOPE,
  STANDARD_NARRATION_QUOTE_TTL_MS,
  STANDARD_NARRATION_REASON_CODES,
  standardNarrationActivation,
  standardNarrationSchemaReadiness,
} from '../lib/standard-narration-contract.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FORMATS = new Set(['vertical', 'landscape', 'square']);
const ENTITLEMENTS = new Set(['standardRendering', 'fullAccess', 'ownerAccess']);

function failure(code, statusCode = 409, failureCategory = 'VALIDATION') {
  return Object.assign(new Error('Standard narration request could not be completed.'), {
    code: sanitizeStandardNarrationReason(code),
    statusCode,
    failureCategory,
  });
}

function requireText(value, code = STANDARD_NARRATION_REASON_CODES.VALIDATION, max = 160) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max) throw failure(code, 400);
  return normalized;
}

function requireUuid(value, code = STANDARD_NARRATION_REASON_CODES.VALIDATION) {
  const normalized = requireText(value, code, 80);
  if (!UUID_PATTERN.test(normalized)) throw failure(code, 400);
  return normalized;
}

function requireActor(accountId, actorId) {
  const account = requireText(accountId, STANDARD_NARRATION_REASON_CODES.OWNERSHIP);
  const actor = requireText(actorId, STANDARD_NARRATION_REASON_CODES.OWNERSHIP);
  if (actor !== account) throw failure(STANDARD_NARRATION_REASON_CODES.ACCOUNT_NOT_AUTHORIZED, 403, 'ENTITLEMENT');
  return { accountId: account, actorId: actor };
}

function activationResult(activation, accountId) {
  try {
    const result = activation({ accountId });
    return result && typeof result === 'object' ? result : { ready: false };
  } catch {
    return { ready: false, reasonCode: STANDARD_NARRATION_REASON_CODES.UNAVAILABLE };
  }
}

function requireActivation(activation, accountId) {
  const result = activationResult(activation, accountId);
  if (!result.ready) throw failure(result.reasonCode || result.blockers?.[0] || STANDARD_NARRATION_REASON_CODES.UNAVAILABLE, 503, 'CONFIG_MISSING');
  return result;
}

function readinessResult(ready, reasonCode, blockers = []) {
  return {
    ready,
    contractVersion: STANDARD_CONTRACT_VERSION,
    policyVersion: STANDARD_NARRATION_POLICY_VERSION,
    pricingVersion: STANDARD_NARRATION_PRICING_VERSION,
    credits: ready ? STANDARD_NARRATION_CREDITS : null,
    quoteTtlMs: STANDARD_NARRATION_QUOTE_TTL_MS,
    reasonCode: ready ? null : sanitizeStandardNarrationReason(reasonCode),
    blockers: ready ? [] : [...new Set(blockers.map(sanitizeStandardNarrationReason))],
  };
}

function validPrivateUpload(asset) {
  return typeof asset?.privatePathname === 'string'
    && asset.privatePathname.startsWith('video-os/uploads/')
    && !asset.privatePathname.includes('..') && !asset.privatePathname.includes('\\');
}

function validatePortrait(identity, identityConsent, portrait, accountId) {
  if (!identity || identity.accountId !== accountId || identity.archivedAt || identity.overallStatus === 'ARCHIVED'
    || !portrait || portrait.id !== identity.sourcePhotoAssetId || portrait.accountId !== accountId || portrait.quarantinedAt
    || portrait.kind !== 'identity-photo-source' || !validPrivateUpload(portrait) || !['image/png', 'image/jpeg'].includes(portrait.contentType)
    || !(portrait.bytes > 0 && portrait.bytes <= 20 * 1024 * 1024)
    || !(portrait.widthPx >= 256 && portrait.widthPx <= 4096) || !(portrait.heightPx >= 256 && portrait.heightPx <= 4096)
    || !SHA256_PATTERN.test(String(portrait.sha256 || ''))
    || !identityConsent || identityConsent.accountId !== accountId || identityConsent.identityId !== identity.id
    || identityConsent.revokedAt || identityConsent.policyVersion !== IDENTITY_CONSENT_POLICY_VERSION
    || !identityConsent.faceAuthorization || !identityConsent.voiceAuthorization
    || !identityConsent.providerProcessingAuthorization || !identityConsent.archiveDeleteAcknowledgment
    || identityConsent.photoSha256 !== portrait.sha256) {
    throw failure(STANDARD_NARRATION_REASON_CODES.IDENTITY_CONSENT, 403, 'CONSENT');
  }
}

function validateNarrationAudio(audio, accountId) {
  if (!audio || audio.accountId !== accountId || audio.quarantinedAt || audio.kind !== 'identity-voice-source' || !validPrivateUpload(audio)
    || !['audio/wav', 'audio/x-wav'].includes(audio.contentType)
    || !(audio.bytes > 0 && audio.bytes <= 50 * 1024 * 1024)
    || !(audio.durationMs >= 1000 && audio.durationMs <= 120_000)
    || !SHA256_PATTERN.test(String(audio.sha256 || ''))) {
    throw failure(STANDARD_NARRATION_REASON_CODES.SOURCE_POLICY, 400, 'SOURCE_POLICY');
  }
}

async function databaseNow(tx, clock) {
  if (clock) {
    const value = new Date(clock());
    if (!Number.isFinite(value.getTime())) throw failure(STANDARD_NARRATION_REASON_CODES.RECONCILIATION, 500, 'PERSISTENCE');
    return value;
  }
  const result = await tx.execute(sql`select clock_timestamp() as now`);
  const value = new Date((result.rows || result)[0]?.now);
  if (!Number.isFinite(value.getTime())) throw failure(STANDARD_NARRATION_REASON_CODES.RECONCILIATION, 500, 'PERSISTENCE');
  return value;
}

async function requireCurrentEntitlement(tx, accountId, now) {
  const grants = await tx.select().from(entitlements)
    .where(and(eq(entitlements.accountId, accountId), eq(entitlements.enabled, true))).for('share');
  if (!grants.some(grant => ENTITLEMENTS.has(grant.entitlementKey) && (!grant.expiresAt || new Date(grant.expiresAt) > now))) {
    throw failure(STANDARD_NARRATION_REASON_CODES.ACCOUNT_NOT_AUTHORIZED, 403, 'ENTITLEMENT');
  }
  return renderAuthorization(accountId, 'standard', grants, now);
}

async function loadBaseSources(tx, accountId, { projectId, identityId, audioAssetId }) {
  const [project] = await tx.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.accountId, accountId))).for('share').limit(1);
  if (!project || project.identityId !== identityId
    || project.settings?.tier !== 'STANDARD'
    || project.settings?.contractVersion !== STANDARD_CONTRACT_VERSION
    || project.settings?.narrationAudioAssetId !== audioAssetId) {
    throw failure(STANDARD_NARRATION_REASON_CODES.OWNERSHIP, 403, 'OWNERSHIP');
  }
  const [identity] = await tx.select().from(userIdentities)
    .where(and(eq(userIdentities.id, identityId), eq(userIdentities.accountId, accountId))).for('share').limit(1);
  const [portrait] = await tx.select().from(mediaAssets)
    .where(and(eq(mediaAssets.id, identity?.sourcePhotoAssetId), eq(mediaAssets.accountId, accountId))).for('share').limit(1);
  const [identityConsent] = await tx.select().from(identityConsents)
    .where(and(
      eq(identityConsents.identityId, identityId),
      eq(identityConsents.accountId, accountId),
      eq(identityConsents.policyVersion, IDENTITY_CONSENT_POLICY_VERSION),
      isNull(identityConsents.revokedAt),
    )).orderBy(desc(identityConsents.acceptedAt)).for('share').limit(1);
  const [audio] = await tx.select().from(mediaAssets)
    .where(and(eq(mediaAssets.id, audioAssetId), eq(mediaAssets.accountId, accountId))).for('share').limit(1);
  validatePortrait(identity, identityConsent, portrait, accountId);
  validateNarrationAudio(audio, accountId);
  return { project, identity, portrait, identityConsent, audio };
}

function validateNarrationConsent(consent, sources, accountId, actorId) {
  if (!consent || consent.accountId !== accountId || consent.actorId !== actorId || consent.revokedAt
    || consent.projectId !== sources.project.id || consent.identityId !== sources.identity.id
    || consent.audioAssetId !== sources.audio.id || consent.audioSha256 !== sources.audio.sha256
    || consent.policyVersion !== STANDARD_NARRATION_POLICY_VERSION
    || consent.processingScope !== STANDARD_NARRATION_PROCESSING_SCOPE) {
    throw failure(STANDARD_NARRATION_REASON_CODES.NARRATION_CONSENT, 403, 'CONSENT');
  }
}

function requestedBinding(accountId, actorId, input = {}) {
  requireActor(accountId, actorId);
  if (input.contractVersion !== STANDARD_CONTRACT_VERSION) throw failure(STANDARD_NARRATION_REASON_CODES.VALIDATION, 400);
  for (const field of ['costCredits', 'credits', 'price', 'pricingVersion', 'audioSha256', 'photoSha256']) {
    if (Object.hasOwn(input, field)) throw failure(STANDARD_NARRATION_REASON_CODES.VALIDATION, 400);
  }
  return {
    contractVersion: STANDARD_CONTRACT_VERSION,
    quoteId: requireUuid(input.quoteId),
    narrationConsentId: requireUuid(input.narrationConsentId),
    projectId: requireUuid(input.projectId),
    identityId: requireUuid(input.identityId),
    audioAssetId: requireUuid(input.audioReference?.assetId),
    initiatingUser: requireText(input.initiatingUser, STANDARD_NARRATION_REASON_CODES.ACCOUNT_NOT_AUTHORIZED),
  };
}

function quoteMatches(quote, binding, sources, narrationConsent, accountId, actorId, format) {
  const createdAt = new Date(quote?.createdAt);
  const expiresAt = new Date(quote?.expiresAt);
  const valid = quote
    && quote.accountId === accountId && quote.actorId === actorId
    && quote.contractVersion === STANDARD_CONTRACT_VERSION
    && quote.projectId === binding.projectId && quote.identityId === binding.identityId
    && quote.photoAssetId === sources.portrait.id && quote.photoSha256 === sources.portrait.sha256
    && quote.identityConsentId === sources.identityConsent.id
    && quote.narrationConsentId === narrationConsent.id
    && quote.audioAssetId === binding.audioAssetId && quote.audioSha256 === sources.audio.sha256
    && quote.policyVersion === STANDARD_NARRATION_POLICY_VERSION
    && quote.pricingVersion === STANDARD_NARRATION_PRICING_VERSION
    && quote.credits === STANDARD_NARRATION_CREDITS
    && Number.isFinite(createdAt.getTime()) && Number.isFinite(expiresAt.getTime())
    && expiresAt.getTime() - createdAt.getTime() === STANDARD_NARRATION_QUOTE_TTL_MS
    && (!format || quote.format === format);
  if (!valid) throw failure(STANDARD_NARRATION_REASON_CODES.QUOTE_MISMATCH, 409, 'RECONCILIATION');
}

function canonicalJobInput(binding, sources) {
  return {
    tier: 'STANDARD',
    provider: 'sadtalker',
    adapter: 'standard-sadtalker-local',
    contractVersion: STANDARD_CONTRACT_VERSION,
    quoteId: binding.quoteId,
    narrationConsentId: binding.narrationConsentId,
    projectId: binding.projectId,
    identityId: binding.identityId,
    audioReference: { assetId: binding.audioAssetId, kind: 'uploaded_audio' },
    initiatingUser: binding.initiatingUser,
    sourceConsentId: sources.identityConsent.id,
    consentPolicyVersion: IDENTITY_CONSENT_POLICY_VERSION,
    consentReference: {
      identityId: sources.identity.id,
      consentId: sources.identityConsent.id,
      policyVersion: IDENTITY_CONSENT_POLICY_VERSION,
    },
  };
}

function sameCanonicalBinding(job, expected, quote) {
  assertJobAuthorizationBinding(job, 'standard');
  const { renderAuthorization: authorization, ...sourceInput } = job.input || {};
  return job?.provider === 'sadtalker'
    && job?.projectId === expected.projectId
    && job?.format === quote.format
    && job?.costCredits === STANDARD_NARRATION_CREDITS
    && JSON.stringify(stableJson(sourceInput)) === JSON.stringify(stableJson(expected));
}

function stageInput(accountId, binding, sources, jobId, correlationId, narrationConsent) {
  return parseSadtalkerStageAInput({
    jobId: requireText(jobId, STANDARD_NARRATION_REASON_CODES.RECONCILIATION),
    accountId,
    correlationId: requireText(correlationId, STANDARD_NARRATION_REASON_CODES.RECONCILIATION),
    portrait: {
      assetId: sources.portrait.id,
      accountId,
      consentId: sources.identityConsent.id,
      signatureVerified: true,
      privateSource: true,
      mimeType: sources.portrait.contentType,
      width: sources.portrait.widthPx,
      height: sources.portrait.heightPx,
      bytes: sources.portrait.bytes,
    },
    drivenAudio: {
      assetId: sources.audio.id,
      accountId,
      consentId: narrationConsent.id,
      signatureVerified: true,
      privateSource: true,
      mimeType: sources.audio.contentType,
      durationMs: sources.audio.durationMs,
      bytes: sources.audio.bytes,
    },
  });
}

export function createStandardNarrationRepository({
  getDatabase = database,
  clock,
  uuid = () => crypto.randomUUID(),
  activation = standardNarrationActivation,
  schemaReadiness = standardNarrationSchemaReadiness,
} = {}) {
  async function activeConsent(tx, accountId, actorId, consentId) {
    const [consent] = await tx.select().from(standardNarrationConsents)
      .where(and(
        eq(standardNarrationConsents.id, consentId),
        eq(standardNarrationConsents.accountId, accountId),
        eq(standardNarrationConsents.actorId, actorId),
        isNull(standardNarrationConsents.revokedAt),
      )).for('share').limit(1);
    return consent;
  }

  async function verifyReplay(db, accountId, actorId, binding, idempotencyKey, requestedFormat) {
    return db.transaction(async tx => {
      const [job] = await tx.select().from(videoJobs)
        .where(and(eq(videoJobs.accountId, accountId), eq(videoJobs.idempotencyKey, idempotencyKey))).limit(1);
      if (!job) return null;
      const [quote] = await tx.select().from(standardNarrationQuotes)
        .where(and(eq(standardNarrationQuotes.id, binding.quoteId), eq(standardNarrationQuotes.accountId, accountId))).for('share').limit(1);
      if (!quote || quote.consumedJobId !== job.id) throw failure(STANDARD_NARRATION_REASON_CODES.IDEMPOTENCY_MISMATCH, 409, 'RECONCILIATION');
      if (job.format !== requestedFormat || quote.format !== requestedFormat) throw failure(STANDARD_NARRATION_REASON_CODES.IDEMPOTENCY_MISMATCH, 409, 'RECONCILIATION');
      await requireCurrentEntitlement(tx, accountId, await databaseNow(tx, clock));
      const sources = await loadBaseSources(tx, accountId, binding);
      const narrationConsent = await activeConsent(tx, accountId, actorId, binding.narrationConsentId);
      validateNarrationConsent(narrationConsent, sources, accountId, actorId);
      quoteMatches(quote, binding, sources, narrationConsent, accountId, actorId, requestedFormat);
      const canonical = canonicalJobInput(binding, sources);
      if (!sameCanonicalBinding(job, canonical, quote)) throw failure(STANDARD_NARRATION_REASON_CODES.IDEMPOTENCY_MISMATCH, 409, 'RECONCILIATION');
      return { job, replayed: true };
    });
  }

  const repository = {
    async consentStatus(accountId, actorId, { projectId, identityId, audioAssetId } = {}) {
      ({ accountId, actorId } = requireActor(accountId, actorId));
      projectId = requireUuid(projectId); identityId = requireUuid(identityId); audioAssetId = requireUuid(audioAssetId);
      const schema = activationResult(schemaReadiness, accountId);
      if (!schema.ready) return { status: 'unavailable', reasonCode: schema.reasonCode || STANDARD_NARRATION_REASON_CODES.MIGRATION_UNAPPROVED };
      const db = getDatabase();
      return db.transaction(async tx => {
        const [consent] = await tx.select().from(standardNarrationConsents).where(and(eq(standardNarrationConsents.accountId, accountId), eq(standardNarrationConsents.actorId, actorId), eq(standardNarrationConsents.projectId, projectId), eq(standardNarrationConsents.identityId, identityId), eq(standardNarrationConsents.audioAssetId, audioAssetId))).orderBy(desc(standardNarrationConsents.grantedAt)).limit(1);
        if (!consent) return { status: 'missing' };
        return consent.revokedAt ? { status: 'revoked', revokedAt: consent.revokedAt } : { status: 'active', consentId: consent.id, grantedAt: consent.grantedAt };
      });
    },
    async readiness(accountId, actorId, payload = {}) {
      const gate = activationResult(activation, accountId);
      if (!gate.ready) return readinessResult(false, gate.reasonCode || gate.blockers?.[0], gate.blockers || []);
      try {
        requireActor(accountId, actorId);
        const projectId = payload.projectId && requireUuid(payload.projectId);
        const identityId = payload.identityId && requireUuid(payload.identityId);
        const audioAssetId = (payload.audioAssetId || payload.narrationAudioAssetId) && requireUuid(payload.audioAssetId || payload.narrationAudioAssetId);
        const narrationConsentId = payload.narrationConsentId && requireUuid(payload.narrationConsentId);
        if (!projectId || !identityId || !audioAssetId) return readinessResult(false, STANDARD_NARRATION_REASON_CODES.BINDING_REQUIRED, [STANDARD_NARRATION_REASON_CODES.BINDING_REQUIRED]);
        if (!narrationConsentId) return readinessResult(false, STANDARD_NARRATION_REASON_CODES.NARRATION_CONSENT_REQUIRED, [STANDARD_NARRATION_REASON_CODES.NARRATION_CONSENT_REQUIRED]);
        const db = getDatabase();
        return await db.transaction(async tx => {
          const now = await databaseNow(tx, clock);
          const [credits] = await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId)).for('share').limit(1);
          if (!credits || credits.balance - credits.reserved < STANDARD_NARRATION_CREDITS) return readinessResult(false, STANDARD_NARRATION_REASON_CODES.INSUFFICIENT_CREDITS, [STANDARD_NARRATION_REASON_CODES.INSUFFICIENT_CREDITS]);
          try {
            await requireCurrentEntitlement(tx, accountId, now);
          } catch (error) {
            return readinessResult(false, error.code, [error.code]);
          }
          const sources = await loadBaseSources(tx, accountId, { projectId, identityId, audioAssetId });
          const narrationConsent = await activeConsent(tx, accountId, actorId, narrationConsentId);
          validateNarrationConsent(narrationConsent, sources, accountId, actorId);
          return readinessResult(true);
        });
      } catch (error) {
        return readinessResult(false, error?.code, [error?.code]);
      }
    },

    async grantConsent(accountId, actorId, {
      idempotencyKey,
      projectId,
      identityId,
      audioAssetId,
      policyVersion,
      consent,
    } = {}) {
      requireActivation(activation, accountId);
      ({ accountId, actorId } = requireActor(accountId, actorId));
      idempotencyKey = requireUuid(idempotencyKey);
      projectId = requireUuid(projectId);
      identityId = requireUuid(identityId);
      audioAssetId = requireUuid(audioAssetId);
      if (consent !== true || policyVersion !== STANDARD_NARRATION_POLICY_VERSION) throw failure(STANDARD_NARRATION_REASON_CODES.NARRATION_CONSENT, 400, 'CONSENT');
      const db = getDatabase();
      return db.transaction(async tx => {
        await acquireProviderLifecycleLock(tx, accountId);
        // Grant-only serialization avoids taking account/project row locks in the
        // reverse order of render completion (sources -> credit account).
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${accountId}:standard-narration-consent`}, 0))`);
        const [existing] = await tx.select().from(standardNarrationConsents)
          .where(and(eq(standardNarrationConsents.accountId, accountId), eq(standardNarrationConsents.idempotencyKey, idempotencyKey))).for('update').limit(1);
        if (existing) {
          if (existing.revokedAt || existing.actorId !== actorId || existing.projectId !== projectId || existing.identityId !== identityId
            || existing.audioAssetId !== audioAssetId || existing.policyVersion !== policyVersion
            || existing.processingScope !== STANDARD_NARRATION_PROCESSING_SCOPE) throw failure(STANDARD_NARRATION_REASON_CODES.IDEMPOTENCY_MISMATCH, 409, 'RECONCILIATION');
          const sources = await loadBaseSources(tx, accountId, { projectId, identityId, audioAssetId });
          if (existing.audioSha256 !== sources.audio.sha256) throw failure(STANDARD_NARRATION_REASON_CODES.IDEMPOTENCY_MISMATCH, 409, 'RECONCILIATION');
          return existing;
        }
        const sources = await loadBaseSources(tx, accountId, { projectId, identityId, audioAssetId });
        const grantedAt = await databaseNow(tx, clock);
        const [created] = await tx.insert(standardNarrationConsents).values({
          id: uuid(), accountId, actorId, idempotencyKey, projectId, identityId, audioAssetId,
          audioSha256: sources.audio.sha256,
          policyVersion,
          processingScope: STANDARD_NARRATION_PROCESSING_SCOPE,
          grantedAt,
        }).returning();
        return created;
      });
    },

    async revokeConsent(accountId, actorId, { consentId } = {}) {
      ({ accountId, actorId } = requireActor(accountId, actorId));
      consentId = requireUuid(consentId);
      if (activationResult(schemaReadiness, accountId).ready !== true) throw failure(STANDARD_NARRATION_REASON_CODES.MIGRATION_UNAPPROVED, 503, 'CONFIG_MISSING');
      const db = getDatabase();
      return db.transaction(async tx => {
        await acquireProviderLifecycleLock(tx, accountId);
        const [existing] = await tx.select().from(standardNarrationConsents)
          .where(and(eq(standardNarrationConsents.id, consentId), eq(standardNarrationConsents.accountId, accountId), eq(standardNarrationConsents.actorId, actorId))).for('update').limit(1);
        if (!existing) throw failure(STANDARD_NARRATION_REASON_CODES.OWNERSHIP, 404, 'OWNERSHIP');
        if (existing.revokedAt) return existing;
        const revokedAt = await databaseNow(tx, clock);
        const [revoked] = await tx.update(standardNarrationConsents).set({ revokedAt, revokedBy: actorId })
          .where(and(eq(standardNarrationConsents.id, consentId), isNull(standardNarrationConsents.revokedAt))).returning();
        if (!revoked) throw failure(STANDARD_NARRATION_REASON_CODES.RECONCILIATION, 409, 'RECONCILIATION');
        return revoked;
      });
    },

    async createQuote(accountId, actorId, { projectId, identityId, audioAssetId, narrationConsentId, format } = {}) {
      requireActivation(activation, accountId);
      ({ accountId, actorId } = requireActor(accountId, actorId));
      projectId = requireUuid(projectId);
      identityId = requireUuid(identityId);
      audioAssetId = requireUuid(audioAssetId);
      narrationConsentId = requireUuid(narrationConsentId);
      if (!FORMATS.has(format)) throw failure(STANDARD_NARRATION_REASON_CODES.VALIDATION, 400);
      const db = getDatabase();
      return db.transaction(async tx => {
        const createdAt = await databaseNow(tx, clock);
        await requireCurrentEntitlement(tx, accountId, createdAt);
        const sources = await loadBaseSources(tx, accountId, { projectId, identityId, audioAssetId });
        const narrationConsent = await activeConsent(tx, accountId, actorId, narrationConsentId);
        validateNarrationConsent(narrationConsent, sources, accountId, actorId);
        const [quote] = await tx.insert(standardNarrationQuotes).values({
          id: uuid(), accountId, actorId, contractVersion: STANDARD_CONTRACT_VERSION,
          projectId, identityId,
          photoAssetId: sources.portrait.id, photoSha256: sources.portrait.sha256,
          identityConsentId: sources.identityConsent.id,
          narrationConsentId, audioAssetId, audioSha256: sources.audio.sha256,
          policyVersion: STANDARD_NARRATION_POLICY_VERSION,
          pricingVersion: STANDARD_NARRATION_PRICING_VERSION,
          format, credits: STANDARD_NARRATION_CREDITS,
          createdAt, expiresAt: new Date(createdAt.getTime() + STANDARD_NARRATION_QUOTE_TTL_MS),
        }).returning();
        return quote;
      });
    },

    async resolveSources(tx, accountId, submission = {}) {
      requireActivation(activation, accountId);
      if (!tx?.select) throw failure(STANDARD_NARRATION_REASON_CODES.RECONCILIATION, 500, 'PERSISTENCE');
      const actorId = submission.initiatingUser;
      const binding = requestedBinding(accountId, actorId, submission);
      if (!FORMATS.has(submission.format)) throw failure(STANDARD_NARRATION_REASON_CODES.QUOTE_MISMATCH, 409, 'RECONCILIATION');
      const [job] = await tx.select().from(videoJobs)
        .where(and(eq(videoJobs.id, submission.jobId), eq(videoJobs.accountId, accountId))).limit(1);
      if (!job) throw failure(STANDARD_NARRATION_REASON_CODES.OWNERSHIP, 404, 'OWNERSHIP');
      assertJobAuthorizationBinding(job, 'standard');
      await requireCurrentEntitlement(tx, accountId, await databaseNow(tx, clock));
      const [quote] = await tx.select().from(standardNarrationQuotes)
        .where(and(eq(standardNarrationQuotes.id, binding.quoteId), eq(standardNarrationQuotes.accountId, accountId))).for('share').limit(1);
      const sources = await loadBaseSources(tx, accountId, binding);
      const narrationConsent = await activeConsent(tx, accountId, actorId, binding.narrationConsentId);
      validateNarrationConsent(narrationConsent, sources, accountId, actorId);
      quoteMatches(quote, binding, sources, narrationConsent, accountId, actorId, submission.format);
      if (!quote.consumedJobId || quote.consumedJobId !== submission.jobId) throw failure(STANDARD_NARRATION_REASON_CODES.QUOTE_MISMATCH, 409, 'RECONCILIATION');
      const canonical = canonicalJobInput(binding, sources);
      if (job.format !== submission.format
        || job.input?.sourceConsentId !== sources.identityConsent.id
        || job.input?.consentPolicyVersion !== IDENTITY_CONSENT_POLICY_VERSION
        || !sameCanonicalBinding(job, canonical, quote)) {
        throw failure(STANDARD_NARRATION_REASON_CODES.QUOTE_MISMATCH, 409, 'RECONCILIATION');
      }
      return {
        input: stageInput(accountId, binding, sources, submission.jobId, submission.correlationId, narrationConsent),
        assets: { portrait: sources.portrait, drivenAudio: sources.audio },
        consent: sources.identityConsent,
        identity: sources.identity,
        narrationConsent,
        quote,
      };
    },

    async reserveRender({ jobId, accountId, idempotencyKey, correlationId, title, format, input } = {}) {
      requireActivation(activation, accountId);
      const binding = requestedBinding(accountId, input?.initiatingUser, input);
      jobId = requireText(jobId);
      idempotencyKey = requireUuid(idempotencyKey);
      correlationId = requireText(correlationId);
      title = requireText(title, STANDARD_NARRATION_REASON_CODES.VALIDATION, 120);
      if (!FORMATS.has(format)) throw failure(STANDARD_NARRATION_REASON_CODES.VALIDATION, 400);
      const actorId = binding.initiatingUser;
      const db = getDatabase();

      const replay = await verifyReplay(db, accountId, actorId, binding, idempotencyKey, format);
      if (replay) return replay;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await db.transaction(async tx => {
          await acquireProviderLifecycleLock(tx, accountId);
          const [account] = await tx.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId)).for('update').limit(1);
          if (!account) throw failure(STANDARD_NARRATION_REASON_CODES.ACCOUNT_NOT_AUTHORIZED, 404, 'OWNERSHIP');
          const [racedJob] = await tx.select().from(videoJobs)
            .where(and(eq(videoJobs.accountId, accountId), eq(videoJobs.idempotencyKey, idempotencyKey))).limit(1);
          if (racedJob) return { retryReplay: true };
          const [quote] = await tx.select().from(standardNarrationQuotes)
            .where(and(
              eq(standardNarrationQuotes.id, binding.quoteId),
              eq(standardNarrationQuotes.accountId, accountId),
              isNull(standardNarrationQuotes.consumedJobId),
            )).for('update').limit(1);
          if (!quote) {
            const [knownQuote] = await tx.select().from(standardNarrationQuotes)
              .where(and(eq(standardNarrationQuotes.id, binding.quoteId), eq(standardNarrationQuotes.accountId, accountId))).limit(1);
            throw failure(knownQuote?.consumedJobId ? STANDARD_NARRATION_REASON_CODES.QUOTE_CONSUMED : STANDARD_NARRATION_REASON_CODES.QUOTE_MISMATCH, 409, 'RECONCILIATION');
          }
          const now = await databaseNow(tx, clock);
          const authorization = await requireCurrentEntitlement(tx, accountId, now);
          const quoteCreatedAt = new Date(quote.createdAt);
          const quoteExpiresAt = new Date(quote.expiresAt);
          if (!Number.isFinite(quoteCreatedAt.getTime()) || !Number.isFinite(quoteExpiresAt.getTime())
            || quoteExpiresAt.getTime() - quoteCreatedAt.getTime() !== STANDARD_NARRATION_QUOTE_TTL_MS) {
            throw failure(STANDARD_NARRATION_REASON_CODES.QUOTE_MISMATCH, 409, 'RECONCILIATION');
          }
          if (new Date(quote.expiresAt) <= now) throw failure(STANDARD_NARRATION_REASON_CODES.QUOTE_EXPIRED, 409, 'ENTITLEMENT');
          const sources = await loadBaseSources(tx, accountId, binding);
          const narrationConsent = await activeConsent(tx, accountId, actorId, binding.narrationConsentId);
          validateNarrationConsent(narrationConsent, sources, accountId, actorId);
          quoteMatches(quote, binding, sources, narrationConsent, accountId, actorId, format);
          // Source/consent row locks may have waited beyond the initial quote
          // check. Expiry must still hold at the final reservation boundary.
          if (new Date(quote.expiresAt) <= await databaseNow(tx, clock)) throw failure(STANDARD_NARRATION_REASON_CODES.QUOTE_EXPIRED, 409, 'ENTITLEMENT');
          if (account.balance - account.reserved < STANDARD_NARRATION_CREDITS) throw failure(STANDARD_NARRATION_REASON_CODES.INSUFFICIENT_CREDITS, 402, 'ENTITLEMENT');
          const canonical = canonicalJobInput(binding, sources);
          await tx.update(creditAccounts).set({ reserved: account.reserved + STANDARD_NARRATION_CREDITS, updatedAt: now }).where(eq(creditAccounts.accountId, accountId));
          const [job] = await tx.insert(videoJobs).values({
            id: jobId, accountId, projectId: binding.projectId, idempotencyKey, correlationId,
            provider: 'sadtalker', status: 'reserved', title, format,
            costCredits: STANDARD_NARRATION_CREDITS, input: { ...canonical, renderAuthorization: { ...authorization, jobId } },
            createdAt: now, updatedAt: now,
          }).returning();
          const consumed = await tx.update(standardNarrationQuotes).set({ consumedJobId: jobId })
            .where(and(eq(standardNarrationQuotes.id, quote.id), isNull(standardNarrationQuotes.consumedJobId))).returning();
          if (consumed.length !== 1) throw failure(STANDARD_NARRATION_REASON_CODES.QUOTE_CONSUMED, 409, 'RECONCILIATION');
          await tx.insert(jobEvents).values({
            jobId, correlationId, eventType: 'render.reserved', stageTo: 'reserved',
            details: { costCredits: STANDARD_NARRATION_CREDITS, contractVersion: STANDARD_CONTRACT_VERSION, quoteId: quote.id },
            createdAt: now,
          });
          return { job, replayed: false };
        });
        if (!result.retryReplay) return result;
        const racedReplay = await verifyReplay(db, accountId, actorId, binding, idempotencyKey, format);
        if (racedReplay) return racedReplay;
      }
      throw failure(STANDARD_NARRATION_REASON_CODES.RECONCILIATION, 409, 'RECONCILIATION');
    },
  };
  return repository;
}

export const standardNarrationRepository = createStandardNarrationRepository();
