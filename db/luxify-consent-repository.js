import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { database } from './client.js';
import {
  authChallenges,
  identityConsents,
  luxStaffGrants,
  luxifyCinematicConsents,
  luxifyConsentChallengeUses,
  luxifyCreativeAssetApprovals,
  luxifyLookCapabilityEvidence,
  luxifyLookCreativeApprovals,
  mediaAssets,
  providerAccountBindingPromotions,
  providerAccountBindings,
  providerResources,
  providerVerifiedAccountScopes,
  userIdentities,
  users,
} from './schema.js';
import {
  LUXIFY_CINEMATIC_CAPABILITY,
  LUXIFY_CINEMATIC_CONSENT_POLICY_VERSION,
  resolveLuxifyLookEligibility,
} from '../lib/luxify-look-eligibility.js';
import {
  LUXIFY_CINEMATIC_CONSENT_PURPOSE,
  LUXIFY_CONSENT_NOTICE_SHA256,
  LUXIFY_CONSENT_NOTICE_VERSION,
  LUX_STAFF_GRANT_SCOPE,
  assertLuxStaffGrantRules,
  luxifyConsentExpiry,
  normalizeStaffEmail,
  sha256Hex,
} from '../lib/luxify-consent-policy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ENGINE = /^[A-Za-z0-9_.:-]{1,80}$/;
const CAPABILITY_EVIDENCE_MAX_MS = 30 * 86_400_000;
const LOOK_APPROVAL_MAX_MS = 30 * 86_400_000;

function failure(code, message, statusCode = 409, failureCategory = 'CONSENT') {
  return Object.assign(new Error(message), { code, statusCode, failureCategory });
}

function exactUuid(value, label = 'identifier') {
  if (typeof value !== 'string' || !UUID.test(value)) throw failure('LUXIFY_CONSENT_INVALID_REQUEST', `The ${label} is invalid.`, 400, 'VALIDATION');
  return value.toLowerCase();
}

function exactAccount(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 160) {
    throw failure('LUXIFY_CONSENT_SIGN_IN_REQUIRED', 'Sign in to continue.', 401, 'OWNERSHIP');
  }
  return value;
}

const iso = value => (value instanceof Date ? value : new Date(value)).toISOString();

async function dbNow(tx) {
  const result = await tx.execute(sql`select now() as now`);
  const row = Array.isArray(result) ? result[0] : result?.rows?.[0];
  const now = row?.now instanceof Date ? row.now : new Date(row?.now);
  if (!Number.isFinite(now.getTime())) throw failure('LUXIFY_CONSENT_UNAVAILABLE', 'Consent storage is unavailable.', 503, 'CONFIG_MISSING');
  return now;
}

async function lockAccount(tx, accountId, purpose) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${accountId}:luxify-consent:${purpose}`}, 0))`);
}

/** Active HeyGen space for the account, resolved from DB rows only. */
export async function loadActiveProviderSpaceTx(tx, accountId) {
  const rows = await tx.select({
    bindingId: providerAccountBindings.id,
    originScopeKey: providerAccountBindings.originScopeKey,
    verifiedAccountScopeId: providerAccountBindingPromotions.verifiedAccountScopeId,
    verifiedAt: providerAccountBindingPromotions.verifiedAt,
    providerSpaceFingerprint: providerVerifiedAccountScopes.providerAccountFingerprint,
  }).from(providerAccountBindings)
    .innerJoin(providerAccountBindingPromotions, and(
      eq(providerAccountBindingPromotions.bindingId, providerAccountBindings.id),
      eq(providerAccountBindingPromotions.state, 'verified'),
    ))
    .innerJoin(providerVerifiedAccountScopes, eq(providerVerifiedAccountScopes.id, providerAccountBindingPromotions.verifiedAccountScopeId))
    .where(and(
      eq(providerAccountBindings.applicationAccountId, accountId),
      eq(providerAccountBindings.provider, 'heygen'),
      eq(providerAccountBindings.lifecycleState, 'active'),
    ))
    .limit(2);
  if (rows.length !== 1 || !SHA256.test(String(rows[0].providerSpaceFingerprint || ''))) {
    throw failure('LUXIFY_PROVIDER_SPACE_UNAVAILABLE', 'A verified HeyGen space is required for LUXIFY consent.', 409, 'ENTITLEMENT');
  }
  return rows[0];
}

async function ownedIdentityTx(tx, accountId, identityId, { lock = false } = {}) {
  let query = tx.select().from(userIdentities).where(and(eq(userIdentities.id, identityId), eq(userIdentities.accountId, accountId))).limit(1);
  if (lock) query = query.for('update');
  const [identity] = await query;
  // Not-found and not-owned are indistinguishable: only the subject account
  // that owns the identity can act on its cinematic consent.
  if (!identity) throw failure('LUXIFY_CONSENT_SUBJECT_REQUIRED', 'Only the subject can manage consent for this identity.', 403, 'OWNERSHIP');
  if (identity.archivedAt !== null || identity.provider !== 'heygen' || identity.avatarStatus !== 'READY'
    || !PROVIDER_ID.test(String(identity.providerRenderableAvatarId || ''))) {
    throw failure('LUXIFY_IDENTITY_NOT_ELIGIBLE', 'This identity has no ready look for LUXIFY.', 409);
  }
  return identity;
}

async function activeSourceConsentTx(tx, accountId, identityId) {
  const rows = await tx.select().from(identityConsents).where(and(
    eq(identityConsents.accountId, accountId),
    eq(identityConsents.identityId, identityId),
    isNull(identityConsents.revokedAt),
  )).orderBy(desc(identityConsents.acceptedAt)).limit(1).for('update');
  const source = rows[0];
  if (!source || source.faceAuthorization !== true || source.providerProcessingAuthorization !== true) {
    throw failure('LUXIFY_SOURCE_CONSENT_REQUIRED', 'An active identity consent is required first.', 409);
  }
  return source;
}

export function luxifyConsentDto(row, now = new Date()) {
  const expired = new Date(row.expiresAt).getTime() <= now.getTime();
  return Object.freeze({
    id: row.id,
    identityId: row.identityId,
    policyVersion: row.policyVersion,
    purpose: row.purpose,
    acceptedAt: iso(row.acceptedAt),
    expiresAt: iso(row.expiresAt),
    status: row.revokedAt ? row.terminalReason || 'revoked' : expired ? 'expired' : 'active',
    ...(row.revokedAt ? { closedAt: iso(row.revokedAt) } : {}),
  });
}

const maskLook = value => {
  const text = String(value || '');
  return text.length > 4 ? `…${text.slice(-4)}` : '…';
};

export function lookApprovalDto(row, { now = new Date(), staffGrantId = null } = {}) {
  const current = now instanceof Date ? now.getTime() : Number(now);
  const closed = row.revokedAt || row.grantRevokedAt;
  const status = closed ? 'revoked' : new Date(row.expiresAt).getTime() <= current ? 'expired' : 'active';
  return Object.freeze({
    approvalId: row.id,
    identityId: row.identityId,
    lookRef: maskLook(row.providerLookId),
    status,
    approvedAt: iso(row.approvedAt),
    expiresAt: iso(row.expiresAt),
    ...(row.revokedAt ? { closedAt: iso(row.revokedAt) } : {}),
    approvedUnderYourGrant: Boolean(staffGrantId) && row.staffGrantId === staffGrantId,
  });
}

export function createLuxifyConsentRepository({ executor } = {}) {
  const db = () => executor || database();

  async function listConsents({ accountId }) {
    const owner = exactAccount(accountId);
    return db().transaction(async (tx) => {
      const now = await dbNow(tx);
      const rows = await tx.select().from(luxifyCinematicConsents)
        .where(eq(luxifyCinematicConsents.accountId, owner))
        .orderBy(desc(luxifyCinematicConsents.acceptedAt)).limit(50);
      const identities = await tx.select({ id: userIdentities.id, displayName: userIdentities.displayName })
        .from(userIdentities).where(and(
          eq(userIdentities.accountId, owner), isNull(userIdentities.archivedAt),
          eq(userIdentities.provider, 'heygen'), eq(userIdentities.avatarStatus, 'READY'),
        )).orderBy(asc(userIdentities.createdAt)).limit(50);
      return { identities, consents: rows.map(row => luxifyConsentDto(row, now)) };
    });
  }

  /**
   * Subject-only grant. The session account must own the identity; the
   * consent links to that identity's active source consent, uses DB time,
   * and defaults to 12 months (hard cap 365 days, also enforced by the DB).
   */
  async function grantConsent({ accountId, identityId, idempotencyKey, cinematicGenerationAuthorization, providerProcessingAuthorization, expiryDays, noticeSha256, challengeSha256 }) {
    const owner = exactAccount(accountId);
    const identityKey = exactUuid(identityId, 'identity');
    const key = exactUuid(idempotencyKey, 'request key');
    // L-3: the route passes the digest of the verified consent challenge; a
    // grant without one is refused so the single-use check cannot be skipped.
    if (!SHA256.test(String(challengeSha256 || ''))) throw failure('LUXIFY_CONSENT_CHALLENGE_INVALID', 'The consent notice expired or changed. Reload and try again.', 409);
    if (cinematicGenerationAuthorization !== true || providerProcessingAuthorization !== true) {
      throw failure('LUXIFY_CONSENT_AUTHORIZATION_REQUIRED', 'Both authorizations are required.', 400);
    }
    if (noticeSha256 !== LUXIFY_CONSENT_NOTICE_SHA256) throw failure('LUXIFY_CONSENT_CHALLENGE_INVALID', 'The consent notice changed. Reload and try again.', 409);
    return db().transaction(async (tx) => {
      await lockAccount(tx, owner, 'grant');
      const [replay] = await tx.select().from(luxifyCinematicConsents).where(and(
        eq(luxifyCinematicConsents.accountId, owner), eq(luxifyCinematicConsents.idempotencyKey, key),
      )).limit(1);
      const now = await dbNow(tx);
      if (replay) {
        if (replay.identityId !== identityKey) throw failure('LUXIFY_CONSENT_IDEMPOTENCY_CONFLICT', 'This request key was already used.', 409);
        return { consent: luxifyConsentDto(replay, now), replayed: true };
      }
      const identity = await ownedIdentityTx(tx, owner, identityKey, { lock: true });
      const source = await activeSourceConsentTx(tx, owner, identityKey);
      const space = await loadActiveProviderSpaceTx(tx, owner);
      const providerLookId = identity.providerRenderableAvatarId;
      const [active] = await tx.select({ id: luxifyCinematicConsents.id, expiresAt: luxifyCinematicConsents.expiresAt })
        .from(luxifyCinematicConsents).where(and(
          eq(luxifyCinematicConsents.accountId, owner), eq(luxifyCinematicConsents.identityId, identityKey),
          eq(luxifyCinematicConsents.providerLookId, providerLookId),
          eq(luxifyCinematicConsents.providerSpaceFingerprint, space.providerSpaceFingerprint),
          isNull(luxifyCinematicConsents.revokedAt),
        )).limit(1).for('update');
      if (active) {
        if (new Date(active.expiresAt).getTime() > now.getTime()) {
          throw failure('LUXIFY_CONSENT_ALREADY_ACTIVE', 'An active LUXIFY consent already exists for this look. Withdraw it first to renew.', 409);
        }
        // Renewal after expiry: close the expired row (never delete) so the
        // one-active-row index admits the new consent.
        await tx.update(luxifyCinematicConsents).set({ revokedAt: now, terminalReason: 'revoked' })
          .where(and(eq(luxifyCinematicConsents.id, active.id), isNull(luxifyCinematicConsents.revokedAt)));
      }
      const expiresAt = luxifyConsentExpiry(now, { expiryDays });
      // L-3: consume the challenge in the same transaction as the consent
      // insert. A replayed challenge is refused; a failed grant rolls back and
      // leaves the challenge unused. The 10-minute expiry is checked by the route.
      const consumed = await tx.insert(luxifyConsentChallengeUses).values({
        challengeSha256, accountId: owner, identityId: identityKey, usedAt: now,
      }).onConflictDoNothing().returning({ challengeSha256: luxifyConsentChallengeUses.challengeSha256 });
      if (!Array.isArray(consumed) || consumed.length !== 1) {
        throw failure('LUXIFY_CONSENT_CHALLENGE_USED', 'This consent notice was already used. Reload and try again.', 409);
      }
      const approvalEvidenceSha256 = sha256Hex({
        kind: 'luxify-cinematic-consent-evidence/v1',
        noticeVersion: LUXIFY_CONSENT_NOTICE_VERSION,
        noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256,
        accountSha256: sha256Hex(owner),
        identityId: identityKey,
        sourceIdentityConsentId: source.id,
        providerLookIdSha256: sha256Hex(providerLookId),
        providerSpaceFingerprint: space.providerSpaceFingerprint,
        cinematicGenerationAuthorization: true,
        providerProcessingAuthorization: true,
        acceptedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        idempotencyKey: key,
      });
      const [row] = await tx.insert(luxifyCinematicConsents).values({
        id: randomUUID(),
        accountId: owner,
        identityId: identityKey,
        sourceIdentityConsentId: source.id,
        idempotencyKey: key,
        providerLookId,
        providerSpaceFingerprint: space.providerSpaceFingerprint,
        policyVersion: LUXIFY_CINEMATIC_CONSENT_POLICY_VERSION,
        purpose: LUXIFY_CINEMATIC_CONSENT_PURPOSE,
        cinematicGenerationAuthorization: true,
        providerProcessingAuthorization: true,
        approvalEvidenceSha256,
        acceptedAt: now,
        expiresAt,
      }).returning();
      return { consent: luxifyConsentDto(row, now), replayed: false };
    });
  }

  async function closeConsentTx(tx, { consentId, accountId, reason }) {
    const now = await dbNow(tx);
    const [row] = await tx.select().from(luxifyCinematicConsents).where(and(
      eq(luxifyCinematicConsents.id, consentId),
      ...(accountId ? [eq(luxifyCinematicConsents.accountId, accountId)] : []),
    )).limit(1).for('update');
    if (!row) throw failure('LUXIFY_CONSENT_NOT_FOUND', 'Consent not found.', 404, 'OWNERSHIP');
    if (row.revokedAt) return { consent: luxifyConsentDto(row, now), changed: false };
    const [closed] = await tx.update(luxifyCinematicConsents).set({ revokedAt: now, terminalReason: reason })
      .where(and(eq(luxifyCinematicConsents.id, row.id), isNull(luxifyCinematicConsents.revokedAt))).returning();
    return { consent: luxifyConsentDto(closed, now), changed: true };
  }

  /** Subject withdrawal of their own consent. Idempotent; never deletes. */
  async function withdrawConsent({ accountId, consentId }) {
    const owner = exactAccount(accountId);
    const id = exactUuid(consentId, 'consent');
    return db().transaction(async (tx) => {
      await lockAccount(tx, owner, 'grant');
      return closeConsentTx(tx, { consentId: id, accountId: owner, reason: 'withdrawn' });
    });
  }

  /** Lux staff revocation (active staff grant required). Never deletes. */
  async function revokeConsent({ staffAccountId, consentId }) {
    const id = exactUuid(consentId, 'consent');
    return db().transaction(async (tx) => {
      await requireActiveStaffGrantTx(tx, staffAccountId);
      const [target] = await tx.select({ accountId: luxifyCinematicConsents.accountId }).from(luxifyCinematicConsents).where(eq(luxifyCinematicConsents.id, id)).limit(1);
      if (!target) throw failure('LUXIFY_CONSENT_NOT_FOUND', 'Consent not found.', 404, 'OWNERSHIP');
      await lockAccount(tx, target.accountId, 'grant');
      return closeConsentTx(tx, { consentId: id, reason: 'revoked' });
    });
  }

  /**
   * Revoking the source identity consent closes every open cinematic consent
   * linked to it. A DB trigger (migration 0018) enforces the same cascade for
   * any other writer of identity_consents.revoked_at.
   */
  async function revokeSourceIdentityConsent({ accountId, identityConsentId }) {
    const owner = exactAccount(accountId);
    const id = exactUuid(identityConsentId, 'identity consent');
    return db().transaction(async (tx) => {
      await lockAccount(tx, owner, 'grant');
      const now = await dbNow(tx);
      const [source] = await tx.select().from(identityConsents).where(and(eq(identityConsents.id, id), eq(identityConsents.accountId, owner))).limit(1).for('update');
      if (!source) throw failure('LUXIFY_CONSENT_SUBJECT_REQUIRED', 'Only the subject can manage this consent.', 403, 'OWNERSHIP');
      const open = await tx.select({ id: luxifyCinematicConsents.id }).from(luxifyCinematicConsents).where(and(
        eq(luxifyCinematicConsents.sourceIdentityConsentId, id), isNull(luxifyCinematicConsents.revokedAt),
      )).for('update');
      if (!source.revokedAt) await tx.update(identityConsents).set({ revokedAt: now }).where(and(eq(identityConsents.id, id), isNull(identityConsents.revokedAt)));
      // Belt and braces: the 0018 trigger already closed these in the same
      // statement; this update is a no-op unless the trigger is missing.
      await tx.update(luxifyCinematicConsents).set({ revokedAt: now, terminalReason: 'source_revoked' }).where(and(
        eq(luxifyCinematicConsents.sourceIdentityConsentId, id), isNull(luxifyCinematicConsents.revokedAt),
      ));
      return { closedCinematicConsents: open.length };
    });
  }

  // ---- Lux staff grant and creative approval ----------------------------

  async function verifiedStaffEmailTx(tx, account) {
    const email = normalizeStaffEmail(account?.email);
    if (!email) return { email, verifiedAt: null };
    const [challenge] = await tx.select({ usedAt: authChallenges.usedAt }).from(authChallenges).where(and(
      eq(authChallenges.accountId, account.id),
      sql`lower(${authChallenges.email}) = ${email}`,
      isNotNull(authChallenges.usedAt),
    )).orderBy(desc(authChallenges.usedAt)).limit(1);
    return { email, verifiedAt: challenge?.usedAt || null };
  }

  async function requireActiveStaffGrantTx(tx, staffAccountId) {
    const staffId = exactAccount(staffAccountId);
    const [account] = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, staffId)).limit(1);
    const [grant] = await tx.select().from(luxStaffGrants).where(and(
      eq(luxStaffGrants.staffAccountId, staffId), eq(luxStaffGrants.scope, LUX_STAFF_GRANT_SCOPE), isNull(luxStaffGrants.revokedAt),
    )).limit(1).for('share');
    if (!grant) throw failure('LUX_STAFF_GRANT_REQUIRED', 'Only Lux staff with an explicit grant can do this.', 403, 'ENTITLEMENT');
    const verified = await verifiedStaffEmailTx(tx, account);
    assertLuxStaffGrantRules({ email: verified.email, emailVerified: Boolean(verified.verifiedAt), explicitGrant: grant.explicitGrant });
    if (verified.email !== grant.staffEmail) throw failure('LUX_STAFF_GRANT_REQUIRED', 'Only Lux staff with an explicit grant can do this.', 403, 'ENTITLEMENT');
    return grant;
  }

  async function grantStaff({ grantorAccountId, staffAccountId, explicitGrant }) {
    const grantorId = exactAccount(grantorAccountId);
    const staffId = exactAccount(staffAccountId);
    return db().transaction(async (tx) => {
      const [grantor] = await tx.select({ id: users.id, email: users.email, role: users.role }).from(users).where(eq(users.id, grantorId)).limit(1);
      const grantorEmail = await verifiedStaffEmailTx(tx, grantor);
      if (grantor?.role !== 'ceo') throw failure('LUX_STAFF_GRANTOR_REQUIRED', 'Only the Lux owner account can grant staff access.', 403, 'ENTITLEMENT');
      assertLuxStaffGrantRules({ email: grantorEmail.email, emailVerified: Boolean(grantorEmail.verifiedAt), explicitGrant: true });
      const [staff] = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, staffId)).limit(1);
      if (!staff) throw failure('LUX_STAFF_ACCOUNT_NOT_FOUND', 'Staff account not found.', 404, 'OWNERSHIP');
      const verified = await verifiedStaffEmailTx(tx, staff);
      const email = assertLuxStaffGrantRules({ email: verified.email, emailVerified: Boolean(verified.verifiedAt), explicitGrant });
      await lockAccount(tx, staffId, 'staff-grant');
      const [existing] = await tx.select().from(luxStaffGrants).where(and(
        eq(luxStaffGrants.staffAccountId, staffId), eq(luxStaffGrants.scope, LUX_STAFF_GRANT_SCOPE), isNull(luxStaffGrants.revokedAt),
      )).limit(1);
      if (existing) return { grantId: existing.id, replayed: true };
      const now = await dbNow(tx);
      const [row] = await tx.insert(luxStaffGrants).values({
        id: randomUUID(),
        staffAccountId: staffId,
        staffEmail: email,
        scope: LUX_STAFF_GRANT_SCOPE,
        explicitGrant: true,
        emailVerifiedAt: verified.verifiedAt,
        grantedByAccountId: grantorId,
        grantEvidenceSha256: sha256Hex({ kind: 'lux-staff-grant/v1', staff: sha256Hex(staffId), grantor: sha256Hex(grantorId), scope: LUX_STAFF_GRANT_SCOPE, at: now.toISOString() }),
        grantedAt: now,
      }).returning({ id: luxStaffGrants.id });
      return { grantId: row.id, replayed: false };
    });
  }

  /**
   * CEO-only staff grant revocation. Requires the same verified
   * luxmarketingcompany.com email as granting (I-5). Closing a grant closes
   * every open look and creative-asset approval recorded under it in the same
   * transaction (N-1); migration 0019 enforces the same cascade for any other
   * writer of lux_staff_grants.revoked_at. Never deletes.
   */
  async function revokeStaffGrant({ grantorAccountId, staffAccountId }) {
    const grantorId = exactAccount(grantorAccountId);
    const staffId = exactAccount(staffAccountId);
    return db().transaction(async (tx) => {
      const [grantor] = await tx.select({ id: users.id, email: users.email, role: users.role }).from(users).where(eq(users.id, grantorId)).limit(1);
      const grantorEmail = await verifiedStaffEmailTx(tx, grantor);
      if (grantor?.role !== 'ceo') throw failure('LUX_STAFF_GRANTOR_REQUIRED', 'Only the Lux owner account can revoke staff access.', 403, 'ENTITLEMENT');
      assertLuxStaffGrantRules({ email: grantorEmail.email, emailVerified: Boolean(grantorEmail.verifiedAt), explicitGrant: true });
      await lockAccount(tx, staffId, 'staff-grant');
      const now = await dbNow(tx);
      const active = await tx.select({ id: luxStaffGrants.id }).from(luxStaffGrants).where(and(
        eq(luxStaffGrants.staffAccountId, staffId), isNull(luxStaffGrants.revokedAt),
      )).for('update');
      const grantIds = active.map(row => row.id);
      if (!grantIds.length) return { revoked: 0, closedLookApprovals: 0, closedCreativeApprovals: 0 };
      const openLooks = await tx.select({ id: luxifyLookCreativeApprovals.id }).from(luxifyLookCreativeApprovals).where(and(
        inArray(luxifyLookCreativeApprovals.staffGrantId, grantIds), isNull(luxifyLookCreativeApprovals.revokedAt),
      )).for('update');
      const openAssets = await tx.select({ id: luxifyCreativeAssetApprovals.id }).from(luxifyCreativeAssetApprovals).where(and(
        inArray(luxifyCreativeAssetApprovals.staffGrantId, grantIds), isNull(luxifyCreativeAssetApprovals.revokedAt),
      )).for('update');
      await tx.update(luxStaffGrants).set({ revokedAt: now }).where(and(
        inArray(luxStaffGrants.id, grantIds), isNull(luxStaffGrants.revokedAt),
      ));
      // Belt and braces: the 0019 trigger already closed these in the grant
      // UPDATE above; these are no-ops unless the trigger is missing.
      await tx.update(luxifyLookCreativeApprovals).set({ revokedAt: now }).where(and(
        inArray(luxifyLookCreativeApprovals.staffGrantId, grantIds), isNull(luxifyLookCreativeApprovals.revokedAt),
      ));
      await tx.update(luxifyCreativeAssetApprovals).set({ revokedAt: now }).where(and(
        inArray(luxifyCreativeAssetApprovals.staffGrantId, grantIds), isNull(luxifyCreativeAssetApprovals.revokedAt),
      ));
      return { revoked: grantIds.length, closedLookApprovals: openLooks.length, closedCreativeApprovals: openAssets.length };
    });
  }

  async function approveCreativeAsset({ staffAccountId, mediaAssetId }) {
    const assetId = exactUuid(mediaAssetId, 'asset');
    return db().transaction(async (tx) => {
      const grant = await requireActiveStaffGrantTx(tx, staffAccountId);
      const [asset] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1).for('update');
      if (!asset || asset.quarantinedAt) throw failure('LUXIFY_CREATIVE_ASSET_NOT_FOUND', 'Creative asset not found.', 404, 'OWNERSHIP');
      const [existing] = await tx.select().from(luxifyCreativeAssetApprovals).where(and(
        eq(luxifyCreativeAssetApprovals.mediaAssetId, assetId), isNull(luxifyCreativeAssetApprovals.revokedAt),
      )).limit(1);
      if (existing && existing.assetSha256 === asset.sha256) return { approvalId: existing.id, replayed: true };
      const now = await dbNow(tx);
      if (existing) await tx.update(luxifyCreativeAssetApprovals).set({ revokedAt: now }).where(eq(luxifyCreativeAssetApprovals.id, existing.id));
      const [row] = await tx.insert(luxifyCreativeAssetApprovals).values({
        id: randomUUID(), accountId: asset.accountId, mediaAssetId: assetId, assetSha256: asset.sha256,
        staffGrantId: grant.id, approverAccountId: grant.staffAccountId, decision: 'approved', approvedAt: now,
      }).returning({ id: luxifyCreativeAssetApprovals.id });
      return { approvalId: row.id, replayed: false };
    });
  }

  /** Records staff-observed HeyGen cinematic_avatar support for one look. */
  async function recordLookCapabilityEvidence({ staffAccountId, accountId, providerLookId, eligible, avatarType, supportedApiEngines = [], observedAt, expiresAt, evidenceSha256 }) {
    const owner = exactAccount(accountId);
    if (!PROVIDER_ID.test(String(providerLookId || '')) || typeof eligible !== 'boolean' || !SAFE_ENGINE.test(String(avatarType || ''))
      || !Array.isArray(supportedApiEngines) || supportedApiEngines.length > 20 || supportedApiEngines.some(item => !SAFE_ENGINE.test(String(item)))
      || !SHA256.test(String(evidenceSha256 || ''))) {
      throw failure('LUXIFY_CAPABILITY_EVIDENCE_INVALID', 'Capability evidence is invalid.', 400, 'VALIDATION');
    }
    const observed = new Date(observedAt);
    const expires = new Date(expiresAt);
    if (!Number.isFinite(observed.getTime()) || !Number.isFinite(expires.getTime()) || expires <= observed
      || expires.getTime() - observed.getTime() > CAPABILITY_EVIDENCE_MAX_MS) {
      throw failure('LUXIFY_CAPABILITY_EVIDENCE_INVALID', 'Capability evidence window is invalid.', 400, 'VALIDATION');
    }
    return db().transaction(async (tx) => {
      const grant = await requireActiveStaffGrantTx(tx, staffAccountId);
      const space = await loadActiveProviderSpaceTx(tx, owner);
      const now = await dbNow(tx);
      if (observed > now) throw failure('LUXIFY_CAPABILITY_EVIDENCE_INVALID', 'Capability evidence is from the future.', 400, 'VALIDATION');
      await tx.update(luxifyLookCapabilityEvidence).set({ revokedAt: now }).where(and(
        eq(luxifyLookCapabilityEvidence.accountId, owner), eq(luxifyLookCapabilityEvidence.providerLookId, providerLookId),
        eq(luxifyLookCapabilityEvidence.providerSpaceFingerprint, space.providerSpaceFingerprint), isNull(luxifyLookCapabilityEvidence.revokedAt),
      ));
      const [row] = await tx.insert(luxifyLookCapabilityEvidence).values({
        id: randomUUID(), accountId: owner, providerLookId, providerSpaceFingerprint: space.providerSpaceFingerprint,
        capability: LUXIFY_CINEMATIC_CAPABILITY, eligible, avatarType, supportedApiEngines: [...supportedApiEngines],
        evidenceSha256, staffGrantId: grant.id, observedAt: observed, expiresAt: expires,
      }).returning({ id: luxifyLookCapabilityEvidence.id });
      return { evidenceId: row.id };
    });
  }

  /**
   * Lux staff creative approval for one exact look (owner decision Oct 30):
   * mandatory for every LUXIFY render. Bound to the look's current provider
   * look id and the account's active HeyGen space; expires within 30 days.
   */
  async function approveLookCreative({ staffAccountId, accountId, identityId, expiresInDays = 30 }) {
    const owner = exactAccount(accountId);
    const id = exactUuid(identityId, 'look identity');
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays * 86_400_000 > LOOK_APPROVAL_MAX_MS) {
      throw failure('LUXIFY_LOOK_APPROVAL_INVALID', 'Look approval window is invalid.', 400, 'VALIDATION');
    }
    return db().transaction(async (tx) => {
      const grant = await requireActiveStaffGrantTx(tx, staffAccountId);
      const [identity] = await tx.select().from(userIdentities).where(and(eq(userIdentities.id, id), eq(userIdentities.accountId, owner))).limit(1);
      const lookId = String(identity?.providerRenderableAvatarId || '');
      if (!identity || identity.archivedAt || !PROVIDER_ID.test(lookId)) throw failure('LUXIFY_LOOK_NOT_FOUND', 'Look not found.', 404, 'OWNERSHIP');
      // N-4: only a READY HeyGen look can be approved.
      if (identity.provider !== 'heygen' || identity.avatarStatus !== 'READY') throw failure('LUXIFY_LOOK_NOT_READY', 'This look is not ready for LUXIFY approval.', 409);
      const space = await loadActiveProviderSpaceTx(tx, owner);
      await lockAccount(tx, owner, 'look-approval');
      const now = await dbNow(tx);
      await tx.update(luxifyLookCreativeApprovals).set({ revokedAt: now }).where(and(
        eq(luxifyLookCreativeApprovals.accountId, owner), eq(luxifyLookCreativeApprovals.identityId, id),
        eq(luxifyLookCreativeApprovals.providerLookId, lookId),
        eq(luxifyLookCreativeApprovals.providerSpaceFingerprint, space.providerSpaceFingerprint), isNull(luxifyLookCreativeApprovals.revokedAt),
      ));
      const [row] = await tx.insert(luxifyLookCreativeApprovals).values({
        id: randomUUID(), accountId: owner, identityId: id, providerLookId: lookId, providerSpaceFingerprint: space.providerSpaceFingerprint,
        staffGrantId: grant.id, approverAccountId: grant.staffAccountId, decision: 'approved', approvedAt: now,
        expiresAt: new Date(now.getTime() + expiresInDays * 86_400_000),
      }).returning({ id: luxifyLookCreativeApprovals.id, expiresAt: luxifyLookCreativeApprovals.expiresAt });
      return { approvalId: row.id, expiresAt: iso(row.expiresAt) };
    });
  }

  /**
   * Revokes one look creative approval. Scope (N-4): any Lux staff member
   * with an active, verified staff grant may revoke any look approval, not
   * only their own; revocation only ever removes authority. Not-found is 404;
   * an already-closed approval is reported as unchanged.
   */
  async function revokeLookCreativeApproval({ staffAccountId, approvalId }) {
    const id = exactUuid(approvalId, 'approval');
    return db().transaction(async (tx) => {
      await requireActiveStaffGrantTx(tx, staffAccountId);
      const [row] = await tx.select({ id: luxifyLookCreativeApprovals.id, revokedAt: luxifyLookCreativeApprovals.revokedAt })
        .from(luxifyLookCreativeApprovals).where(eq(luxifyLookCreativeApprovals.id, id)).limit(1).for('update');
      if (!row) throw failure('LUXIFY_LOOK_APPROVAL_NOT_FOUND', 'Look approval not found.', 404, 'OWNERSHIP');
      if (row.revokedAt) return { changed: false };
      const now = await dbNow(tx);
      const closed = await tx.update(luxifyLookCreativeApprovals).set({ revokedAt: now })
        .where(and(eq(luxifyLookCreativeApprovals.id, id), isNull(luxifyLookCreativeApprovals.revokedAt)))
        .returning({ id: luxifyLookCreativeApprovals.id });
      return { changed: closed.length === 1 };
    });
  }

  /**
   * Staff-only list of look creative approvals for ONE subject account
   * (optionally one identity), newest first, max 50 (N-2). Returns only the
   * approval id, identity id, status and times plus a masked look reference;
   * never the account id, approver id, staff email or provider space.
   */
  async function listLookCreativeApprovals({ staffAccountId, accountId, identityId }) {
    const owner = exactAccount(accountId);
    const identityKey = identityId === undefined || identityId === null ? null : exactUuid(identityId, 'look identity');
    return db().transaction(async (tx) => {
      const grant = await requireActiveStaffGrantTx(tx, staffAccountId);
      const now = await dbNow(tx);
      const rows = await tx.select({
        id: luxifyLookCreativeApprovals.id,
        identityId: luxifyLookCreativeApprovals.identityId,
        providerLookId: luxifyLookCreativeApprovals.providerLookId,
        staffGrantId: luxifyLookCreativeApprovals.staffGrantId,
        approvedAt: luxifyLookCreativeApprovals.approvedAt,
        expiresAt: luxifyLookCreativeApprovals.expiresAt,
        revokedAt: luxifyLookCreativeApprovals.revokedAt,
        grantRevokedAt: luxStaffGrants.revokedAt,
      }).from(luxifyLookCreativeApprovals)
        .innerJoin(luxStaffGrants, eq(luxStaffGrants.id, luxifyLookCreativeApprovals.staffGrantId))
        .where(and(
          eq(luxifyLookCreativeApprovals.accountId, owner),
          ...(identityKey ? [eq(luxifyLookCreativeApprovals.identityId, identityKey)] : []),
        )).orderBy(desc(luxifyLookCreativeApprovals.approvedAt)).limit(50);
      return { approvals: rows.map(row => lookApprovalDto(row, { now, staffGrantId: grant.id })) };
    });
  }

  return Object.freeze({
    listConsents,
    grantConsent,
    withdrawConsent,
    revokeConsent,
    revokeSourceIdentityConsent,
    grantStaff,
    revokeStaffGrant,
    approveCreativeAsset,
    approveLookCreative,
    revokeLookCreativeApproval,
    listLookCreativeApprovals,
    recordLookCapabilityEvidence,
  });
}

// ---- Eligibility and authority (fail closed) ------------------------------

/** Creative assets are blocked from LUXIFY until a Lux staff approval exists. */
export async function assertLuxifyCreativeAssetsApprovedTx(tx, { accountId, mediaAssetIds = [] }) {
  if (!Array.isArray(mediaAssetIds)) throw failure('LUXIFY_CREATIVE_APPROVAL_REQUIRED', 'Creative assets need Lux staff approval.', 409);
  if (!mediaAssetIds.length) return true;
  const ids = mediaAssetIds.map(id => exactUuid(id, 'asset'));
  const rows = await tx.select({
    mediaAssetId: luxifyCreativeAssetApprovals.mediaAssetId,
    assetSha256: luxifyCreativeAssetApprovals.assetSha256,
    currentSha256: mediaAssets.sha256,
    quarantinedAt: mediaAssets.quarantinedAt,
    grantRevokedAt: luxStaffGrants.revokedAt,
  }).from(luxifyCreativeAssetApprovals)
    .innerJoin(mediaAssets, eq(mediaAssets.id, luxifyCreativeAssetApprovals.mediaAssetId))
    .innerJoin(luxStaffGrants, eq(luxStaffGrants.id, luxifyCreativeAssetApprovals.staffGrantId))
    .where(and(
      inArray(luxifyCreativeAssetApprovals.mediaAssetId, ids),
      eq(luxifyCreativeAssetApprovals.accountId, accountId),
      isNull(luxifyCreativeAssetApprovals.revokedAt),
    ));
  const approved = new Set(rows.filter(row => row.assetSha256 === row.currentSha256 && !row.quarantinedAt && !row.grantRevokedAt).map(row => row.mediaAssetId));
  if (ids.some(id => !approved.has(id))) throw failure('LUXIFY_CREATIVE_APPROVAL_REQUIRED', 'Creative assets need Lux staff approval.', 409);
  return true;
}

/**
 * Mandatory staff creative approval for one look (owner decision Oct 30).
 * Every LUXIFY render, prompt-only or not, needs an active, unexpired
 * approval for each selected look, recorded under a staff grant that is
 * still active. Returns the approval expiry; anything else denies.
 */
export async function assertLuxifyLookCreativeApprovalTx(tx, { accountId, identityId, providerLookId, providerSpaceFingerprint, now }) {
  const [approval] = await tx.select({
    expiresAt: luxifyLookCreativeApprovals.expiresAt,
    revokedAt: luxifyLookCreativeApprovals.revokedAt,
    grantRevokedAt: luxStaffGrants.revokedAt,
  }).from(luxifyLookCreativeApprovals)
    .innerJoin(luxStaffGrants, eq(luxStaffGrants.id, luxifyLookCreativeApprovals.staffGrantId))
    .where(and(
      eq(luxifyLookCreativeApprovals.accountId, accountId), eq(luxifyLookCreativeApprovals.identityId, identityId),
      eq(luxifyLookCreativeApprovals.providerLookId, String(providerLookId || '')),
      eq(luxifyLookCreativeApprovals.providerSpaceFingerprint, String(providerSpaceFingerprint || '')),
      isNull(luxifyLookCreativeApprovals.revokedAt),
    )).orderBy(desc(luxifyLookCreativeApprovals.approvedAt)).limit(1).for('share');
  const expiresAt = approval ? new Date(approval.expiresAt).getTime() : NaN;
  const current = now instanceof Date ? now.getTime() : Number(now);
  if (!approval || approval.revokedAt || approval.grantRevokedAt || !Number.isFinite(expiresAt) || !Number.isFinite(current) || expiresAt <= current) {
    throw failure('LUXIFY_CREATIVE_APPROVAL_REQUIRED', 'This look needs an active Lux staff creative approval.', 409);
  }
  return expiresAt;
}

function providerSpaceFrom({ accountId, space, window }) {
  return {
    provider: 'heygen',
    scopeType: 'space',
    applicationAccountId: accountId,
    bindingId: space.bindingId,
    originScopeKey: space.originScopeKey,
    verifiedAccountScopeId: space.verifiedAccountScopeId,
    providerSpaceFingerprint: space.providerSpaceFingerprint,
    bindingState: 'active',
    promotionState: 'verified',
    observedAt: iso(window.observedAt),
    expiresAt: iso(window.expiresAt),
  };
}

/**
 * Loads every piece of server-side evidence for the selected looks and runs
 * the pure eligibility contract. Any missing, expired, revoked or mismatched
 * row denies. `binding` is a fresh HeyGen space binding when the caller has
 * one (route and claim); otherwise the DB-verified promotion window bounded by
 * the capability evidence expiry is used (reservation, inside its lock).
 */
export async function resolveLuxifyEligibilityTx(tx, { accountId, lookIdentityIds, binding = null, now }) {
  const owner = exactAccount(accountId);
  const ids = lookIdentityIds.map(id => exactUuid(id, 'look identity'));
  if (!ids.length || ids.length > 3) throw failure('LUXIFY_LOOK_NOT_ELIGIBLE', 'LUXIFY look eligibility could not be established.', 409);
  const space = await loadActiveProviderSpaceTx(tx, owner);
  if (binding && (binding.applicationAccountId !== owner || binding.providerSpaceFingerprint !== space.providerSpaceFingerprint
    || binding.bindingId !== space.bindingId)) {
    throw failure('LUXIFY_PROVIDER_SPACE_UNAVAILABLE', 'The HeyGen space binding changed.', 409, 'ENTITLEMENT');
  }
  const current = now ?? await dbNow(tx);
  const identities = await tx.select().from(userIdentities).where(and(eq(userIdentities.accountId, owner), inArray(userIdentities.id, ids)));
  const byId = new Map(identities.map(row => [row.id, row]));
  const looks = [];
  const capabilities = [];
  let evidenceExpiry = Infinity;
  for (const identityId of ids) {
    const identity = byId.get(identityId);
    if (!identity) throw failure('LUXIFY_LOOK_NOT_ELIGIBLE', 'LUXIFY look eligibility could not be established.', 409);
    const lookId = identity.providerRenderableAvatarId;
    const [consent] = await tx.select().from(luxifyCinematicConsents).where(and(
      eq(luxifyCinematicConsents.accountId, owner), eq(luxifyCinematicConsents.identityId, identityId),
      eq(luxifyCinematicConsents.providerLookId, String(lookId || '')),
      eq(luxifyCinematicConsents.providerSpaceFingerprint, space.providerSpaceFingerprint),
      isNull(luxifyCinematicConsents.revokedAt),
    )).orderBy(desc(luxifyCinematicConsents.acceptedAt)).limit(1).for('share');
    if (!consent) throw failure('LUXIFY_CONSENT_MISSING', 'LUXIFY cinematic consent is missing.', 409);
    const [source] = await tx.select({ revokedAt: identityConsents.revokedAt }).from(identityConsents)
      .where(eq(identityConsents.id, consent.sourceIdentityConsentId)).limit(1).for('share');
    if (!source || source.revokedAt) throw failure('LUXIFY_SOURCE_CONSENT_REQUIRED', 'The identity consent is no longer active.', 409);
    const [resource] = await tx.select().from(providerResources).where(and(
      eq(providerResources.applicationAccountId, owner), eq(providerResources.kind, 'avatar_look'),
      eq(providerResources.providerResourceId, String(lookId || '')), eq(providerResources.bindingId, space.bindingId),
    )).limit(1);
    const [evidence] = await tx.select().from(luxifyLookCapabilityEvidence).where(and(
      eq(luxifyLookCapabilityEvidence.accountId, owner), eq(luxifyLookCapabilityEvidence.providerLookId, String(lookId || '')),
      eq(luxifyLookCapabilityEvidence.providerSpaceFingerprint, space.providerSpaceFingerprint),
      isNull(luxifyLookCapabilityEvidence.revokedAt),
    )).orderBy(desc(luxifyLookCapabilityEvidence.observedAt)).limit(1);
    if (!resource || !evidence) throw failure('LUXIFY_LOOK_NOT_ELIGIBLE', 'LUXIFY look eligibility could not be established.', 409);
    const approvalExpiry = await assertLuxifyLookCreativeApprovalTx(tx, {
      accountId: owner, identityId, providerLookId: lookId, providerSpaceFingerprint: space.providerSpaceFingerprint, now: current,
    });
    evidenceExpiry = Math.min(evidenceExpiry, new Date(evidence.expiresAt).getTime(), approvalExpiry);
    capabilities.push({ providerLookId: lookId, capability: evidence.capability, eligible: evidence.eligible, evidenceDigest: evidence.evidenceSha256, id: evidence.id });
    looks.push({
      identity: {
        id: identity.id, accountId: identity.accountId, archivedAt: identity.archivedAt ? iso(identity.archivedAt) : null,
        provider: identity.provider, providerRenderableAvatarId: lookId, avatarStatus: identity.avatarStatus,
      },
      consent: {
        accountId: consent.accountId, identityId: consent.identityId, providerLookId: consent.providerLookId,
        policyVersion: consent.policyVersion, purpose: consent.purpose,
        cinematicGenerationAuthorization: consent.cinematicGenerationAuthorization,
        providerProcessingAuthorization: consent.providerProcessingAuthorization,
        acceptedAt: iso(consent.acceptedAt), expiresAt: iso(consent.expiresAt), revokedAt: null,
      },
      resource: {
        id: resource.id, applicationAccountId: resource.applicationAccountId, bindingId: resource.bindingId,
        originScopeKey: resource.originScopeKey, verifiedAccountScopeId: resource.verifiedAccountScopeId,
        kind: resource.kind, providerResourceId: resource.providerResourceId, state: resource.state,
        tombstonedAt: resource.tombstonedAt ? iso(resource.tombstonedAt) : null,
      },
      providerReadback: {
        provider: 'heygen', providerLookId: lookId, providerSpaceFingerprint: evidence.providerSpaceFingerprint,
        present: true, status: 'completed', avatarType: evidence.avatarType,
        supportedApiEngines: Array.isArray(evidence.supportedApiEngines) ? [...evidence.supportedApiEngines] : null,
        observedAt: iso(evidence.observedAt), expiresAt: iso(evidence.expiresAt),
      },
    });
  }
  const window = binding
    ? { observedAt: binding.spaceObservedAt, expiresAt: binding.expiresAt }
    : { observedAt: space.verifiedAt, expiresAt: new Date(evidenceExpiry) };
  if (!window.observedAt || !Number.isFinite(new Date(window.expiresAt).getTime())) {
    throw failure('LUXIFY_PROVIDER_SPACE_UNAVAILABLE', 'A verified HeyGen space is required for LUXIFY.', 409, 'ENTITLEMENT');
  }
  const revision = `db-${sha256Hex(capabilities.map(item => item.id).sort().join(',')).slice(0, 32)}`;
  return resolveLuxifyLookEligibility({
    accountId: owner,
    providerSpace: providerSpaceFrom({ accountId: owner, space, window }),
    looks,
    eligibilityAuthority: {
      kind: 'approved_capability_evidence',
      revision,
      providerSpaceFingerprint: space.providerSpaceFingerprint,
      approvalState: 'approved',
      lookCapabilities: capabilities.map(({ id, ...rest }) => rest),
    },
  }, { now: current.getTime() });
}

function unavailable(error) {
  if (error?.failureCategory && [400, 403, 409].includes(error.statusCode)) return error;
  return failure('LUXIFY_CINEMATIC_AUTHORITY_UNAVAILABLE', 'LUXIFY consent and capability evidence could not be verified.', 503, 'CONSENT');
}

/** Production reserve/claim authority for db/repositories.js. Fails closed. */
export async function resolvePersistedLuxifyAuthority({ tx, accountId, lookIdentityIds, providerBinding = null, intent }) {
  try {
    await assertLuxifyCreativeAssetsApprovedTx(tx, { accountId, mediaAssetIds: intent?.creativeAssetIds ?? [] });
    const result = await resolveLuxifyEligibilityTx(tx, { accountId, lookIdentityIds, binding: null });
    return { lookBindings: result.lookBindings.map(item => ({ ...item })), eligibilityRevision: result.eligibilityRevision };
  } catch (error) {
    throw unavailable(error);
  }
}

/**
 * Production route resolver for routes/video-os-lite/luxify.js and
 * render-v2. Only reached after the feature flag, account pin, pricing,
 * runtime preflight and Premium checks pass, so it is inert while LUXIFY is off.
 */
export function createDatabaseLuxifyEligibilityResolver({ executor, resolveBinding } = {}) {
  return async function resolveEligibility({ accountId, lookIdentityIds } = {}) {
    const owner = exactAccount(accountId);
    const resolver = resolveBinding || (await import('./heygen-space-binding-repository.js')).resolveFreshHeygenSpaceBinding;
    const binding = await resolver({ accountId: owner });
    const db = executor || database();
    return db.transaction(async (tx) => {
      if (Array.isArray(lookIdentityIds)) {
        const result = await resolveLuxifyEligibilityTx(tx, { accountId: owner, lookIdentityIds, binding });
        return { lookBindings: result.lookBindings.map(item => ({ ...item })), eligibilityRevision: result.eligibilityRevision };
      }
      const candidates = await tx.select({ id: userIdentities.id, displayName: userIdentities.displayName }).from(userIdentities).where(and(
        eq(userIdentities.accountId, owner), isNull(userIdentities.archivedAt),
        eq(userIdentities.provider, 'heygen'), eq(userIdentities.avatarStatus, 'READY'),
      )).orderBy(asc(userIdentities.createdAt)).limit(50);
      const eligibleLooks = [];
      for (const candidate of candidates) {
        try {
          await resolveLuxifyEligibilityTx(tx, { accountId: owner, lookIdentityIds: [candidate.id], binding });
          eligibleLooks.push({ identityId: candidate.id, displayName: String(candidate.displayName || 'Look').slice(0, 120) || 'Look' });
        } catch {
          // Ineligible looks are omitted; the route reports no_eligible_looks.
        }
      }
      return { eligibleLooks };
    }, { isolationLevel: 'repeatable read' });
  };
}

export const luxifyConsentRepository = createLuxifyConsentRepository();
export const resolveDatabaseLuxifyEligibility = createDatabaseLuxifyEligibilityResolver();
