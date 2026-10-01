import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, eq } from 'drizzle-orm';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';

import { acquireProviderLifecycleLock } from './provider-lifecycle-lock.js';
import * as databaseSchema from './schema.js';
import {
  providerAccountBindingPromotions,
  providerAccountBindings,
  providerVerifiedAccountScopes,
  users,
} from './schema.js';
import {
  assertFreshHeygenBootstrapProof,
  assertFreshHeygenSpaceProof,
  loadPinnedHeygenSpaceAnchorProjection,
  loadVerifiedHeygenSpaceAnchor,
  validateFreshHeygenQualification,
} from '../lib/heygen-space-anchor.js';
import { canonicalJsonBytes } from '../lib/heygen-reconciliation-contract.js';
import { databaseBindingSha256 } from '../lib/provider-reconciliation-target.js';
import { qualifyHeygenCredential } from '../services/heygen-account-qualification.js';
import {
  checkDatabaseMigrations,
  loadSchemaLock,
  loadTargetManifest,
  validateTarget,
} from '../tools/check-migrations.mjs';

export const HEYGEN_SPACE_BINDING_VERSION = 'heygen-space-binding/v1';

const VERIFICATION_TARGET_PATH = fileURLToPath(new URL(import.meta.url).pathname.endsWith('/index.js')
  ? new URL('./runtime-repository/config/database-target.verification.json', import.meta.url)
  : new URL('../config/database-target.verification.json', import.meta.url));
const PINNED_VERIFICATION_TARGET_CANONICAL_SHA256 = '2bb9ea3cfafa560248ba9caf02e0f6bd4d2c85b03b5a6a75450b2934c49f0d8e';
const PINNED_APPLICATION_PROJECT_ID = 'prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW';
const SHA256 = /^[a-f0-9]{64}$/;
const SPACE_PROOF_VERSION = 'heygen-space-qualification-proof/v1';
const SPACE_EVIDENCE_REF_VERSION = 'heygen-space-anchor-evidence/v1';
const CREDENTIAL_KEY_FINGERPRINT_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_CREDENTIAL_KEY\0V1\0', 'utf8');
const PROVIDER_CREDENTIAL_SCOPE_DOMAIN = Buffer.from('LUX_VIDEO_OS\0PROVIDER_CREDENTIAL_SCOPE\0V1\0', 'utf8');
const ALLOW_TEST_DEPENDENCIES = String(process.env.NODE_TEST_CONTEXT || '').startsWith('child');
const BINDING_BRANDS = new WeakSet();
const BINDING_CONTEXTS = new WeakMap();
const ACTIVE_CLAIM_TRANSACTIONS = new WeakMap();
const ACTIVE_RECEIPT_TRANSACTIONS = new WeakMap();

function failure(code, message, statusCode = 503) {
  return Object.assign(new Error(message), { code, failureCategory: code, statusCode });
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEnvironment(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactInput(input, allowed) {
  if (!isRecord(input)) throw failure('INVALID_HEYGEN_SPACE_BINDING_INPUT', 'HeyGen space binding input is invalid.', 400);
  const keys = Object.keys(input);
  if (keys.some(key => !allowed.has(key)) || keys.length !== allowed.size
    || [...allowed].some(key => !Object.hasOwn(input, key))) {
    throw failure('INVALID_HEYGEN_SPACE_BINDING_INPUT', 'HeyGen space binding input is invalid.', 400);
  }
  return input;
}

function exactText(value, label, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure('INVALID_HEYGEN_SPACE_BINDING_INPUT', `${label} is invalid.`, 400);
  }
  return value;
}

function exactDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw failure('HEYGEN_SPACE_PROOF_INVALID', `${label} is invalid.`);
  }
  return value;
}

function exactIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw failure('HEYGEN_SPACE_PROOF_INVALID', `${label} is invalid.`);
  }
  return value;
}

function exactDate(value) {
  const resolved = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(resolved.getTime())) throw failure('HEYGEN_SPACE_BINDING_CLOCK_INVALID', 'HeyGen space binding clock is invalid.', 500);
  return resolved;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function assertProofShape(proof) {
  if (!isRecord(proof) || proof.version !== SPACE_PROOF_VERSION || proof.provider !== 'heygen'
    || proof.providerNativeScopeType !== 'space' || proof.globalAccountIdVerified !== false
    || proof.evidenceRefVersion !== SPACE_EVIDENCE_REF_VERSION) {
    throw failure('HEYGEN_SPACE_PROOF_INVALID', 'HeyGen space proof is invalid.');
  }
  for (const [key, label] of [
    ['credentialKeyFingerprint', 'credential key fingerprint'],
    ['credentialScopeFingerprint', 'credential scope fingerprint'],
    ['keyIdDigest', 'credential key ID digest'],
    ['usernameDigest', 'profile username digest'],
    ['providerSpaceFingerprint', 'provider space fingerprint'],
    ['canonicalScopeKey', 'canonical provider scope key'],
    ['preflightEvidenceSha256', 'preflight evidence digest'],
    ['spaceProofSha256', 'space proof evidence digest'],
    ['identityDigest', 'identity evidence digest'],
    ['probeResultSha256', 'probe result digest'],
  ]) exactDigest(proof[key], label);
  exactIso(proof.keyCreatedAt, 'credential creation time');
  const qualifiedAt = exactIso(proof.qualifiedAt, 'qualification time');
  const expiresAt = exactIso(proof.expiresAt, 'qualification expiry time');
  exactIso(proof.spaceObservedAt, 'provider space observation time');
  exactIso(proof.anchorExpiresAt, 'anchor expiry time');
  const lifetime = Date.parse(expiresAt) - Date.parse(qualifiedAt);
  if (lifetime <= 0 || lifetime > 60_000) {
    throw failure('HEYGEN_SPACE_PROOF_INVALID', 'HeyGen space proof freshness window is invalid.');
  }
  return proof;
}

function evidenceRefs(proof) {
  if (proof.evidenceRefVersion !== SPACE_EVIDENCE_REF_VERSION) {
    throw failure('HEYGEN_SPACE_PROOF_INVALID', 'HeyGen space evidence version is invalid.');
  }
  const anchorRef = `${SPACE_EVIDENCE_REF_VERSION}/${proof.probeResultSha256}`;
  return Object.freeze({
    credential: `${anchorRef}/preflight.json`,
    scope: `${anchorRef}/space-proof.json`,
    promotion: `${anchorRef}/identity-proof.json`,
  });
}

function selectCredential(env) {
  const primary = typeof env.HEYGEN_API_KEY === 'string' ? env.HEYGEN_API_KEY.trim() : '';
  const alias = typeof env.HEYGEN_TOKEN === 'string' ? env.HEYGEN_TOKEN.trim() : '';
  if (primary && alias && primary !== alias) {
    throw failure('AMBIGUOUS_HEYGEN_CREDENTIAL', 'HeyGen credential configuration is ambiguous.');
  }
  const credential = primary || alias;
  if (!credential || credential.length > 1_024 || /[\r\n\u0000]/.test(credential)) {
    throw failure('HEYGEN_CREDENTIAL_MISSING', 'HeyGen credential configuration is unavailable.');
  }
  return credential;
}

function credentialKeyFingerprint(credential) {
  return createHash('sha256').update(CREDENTIAL_KEY_FINGERPRINT_DOMAIN).update(credential, 'utf8').digest('hex');
}

function providerOriginScopeKey(credentialScopeFingerprint) {
  return createHash('sha256').update(PROVIDER_CREDENTIAL_SCOPE_DOMAIN).update(credentialScopeFingerprint, 'utf8').digest('hex');
}

function assertVerificationEnvironment(env) {
  const requested = typeof env.VIDEO_OS_SPACE_BINDING_ENVIRONMENT === 'string'
    ? env.VIDEO_OS_SPACE_BINDING_ENVIRONMENT.trim()
    : '';
  const vercelEnvironment = typeof env.VERCEL_ENV === 'string' ? env.VERCEL_ENV.trim().toLowerCase() : '';
  if (vercelEnvironment === 'production' || requested === 'production') {
    throw failure('CANONICAL_TARGET_UNVERIFIED', 'Canonical production binding target is not verified.');
  }
  if (requested !== 'verification') {
    throw failure('HEYGEN_BINDING_ENVIRONMENT_UNSUPPORTED', 'Only the pinned verification target is supported.');
  }
  const observedProject = String(env.VERCEL_PROJECT_ID || '').trim();
  if (observedProject && observedProject !== PINNED_APPLICATION_PROJECT_ID) {
    throw failure('APPLICATION_PROJECT_MISMATCH', 'Application project identity does not match the pinned target.');
  }
}

function canonicalDatabaseUrl(env) {
  const value = env.DATABASE_URL;
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw failure('CANONICAL_DATABASE_URL_REQUIRED', 'The canonical verification DATABASE_URL is required.');
  }
  return value;
}

async function defaultTargetPreflight(env, dependencies) {
  assertVerificationEnvironment(env);
  const databaseUrl = canonicalDatabaseUrl(env);
  const targetMetadata = await dependencies.lstat(VERIFICATION_TARGET_PATH);
  if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
    throw failure('TARGET_MANIFEST_UNBOUND', 'Pinned verification target manifest is not a regular repository file.');
  }
  const targetEvidence = await dependencies.loadTargetManifest(VERIFICATION_TARGET_PATH, {
    requiredEnvironment: 'verification',
  });
  const targetCanonicalSha256 = createHash('sha256').update(canonicalJsonBytes(targetEvidence.target)).digest('hex');
  if (targetCanonicalSha256 !== PINNED_VERIFICATION_TARGET_CANONICAL_SHA256
    || targetEvidence.targetManifestBinding !== 'verification-manifest') {
    throw failure('TARGET_MANIFEST_UNBOUND', 'Pinned verification target manifest changed.');
  }
  const { target } = targetEvidence;
  const canonical = dependencies.validateTarget(databaseUrl, target, 'verification');
  const unpooledUrl = env.DATABASE_URL_UNPOOLED;
  if (unpooledUrl !== undefined && (typeof unpooledUrl !== 'string' || unpooledUrl !== unpooledUrl.trim())) {
    throw failure('DATABASE_URL_INVALID', 'The optional unpooled database URL is invalid.');
  }
  const unpooled = unpooledUrl ? dependencies.validateTarget(unpooledUrl, target, 'verification') : null;
  const schemaEvidence = await dependencies.loadSchemaLock(VERIFICATION_TARGET_PATH, target);
  const databaseEvidence = await dependencies.checkDatabaseMigrations(databaseUrl, {
    ...targetEvidence,
    ...schemaEvidence,
    target,
    requiredEnvironment: 'verification',
    validatedCanonicalTarget: canonical,
    validatedUnpooledTarget: unpooled,
  });
  if (databaseEvidence?.verified !== true || databaseEvidence.scope !== 'live-database'
    || databaseEvidence.journalVerified !== true || databaseEvidence.environment !== 'verification'
    || databaseEvidence.targetManifestSha256 !== targetEvidence.targetManifestSha256) {
    throw failure('DATABASE_PREFLIGHT_FAILED', 'Pinned verification database did not pass strict migration and schema checks.');
  }
  return deepFreeze({
    environment: 'verification',
    projectId: PINNED_APPLICATION_PROJECT_ID,
    databaseBindingSha256: dependencies.databaseBindingSha256({
      environment: 'verification',
      providerProjectId: target.projectId,
      providerBranchId: target.branchId,
      databaseName: target.database,
      applicationProjectId: PINNED_APPLICATION_PROJECT_ID,
    }),
    databaseUrl,
    unpooledUrl: unpooledUrl || null,
  });
}

function assertRuntimeInputsStable(env, preflight, credential) {
  assertVerificationEnvironment(env);
  if (canonicalDatabaseUrl(env) !== preflight.databaseUrl
    || String(env.DATABASE_URL_UNPOOLED || '') !== String(preflight.unpooledUrl || '')
    || selectCredential(env) !== credential) {
    throw failure('HEYGEN_BINDING_INPUT_DRIFT', 'Binding inputs changed during qualification.');
  }
}

function exactExistingScope(row, proof, refs) {
  if (!row || row.provider !== 'heygen'
    || row.providerAccountFingerprint !== proof.providerSpaceFingerprint
    || row.canonicalScopeKey !== proof.canonicalScopeKey
    || row.evidenceDigest !== proof.spaceProofSha256
    || row.evidenceRef !== refs.scope) {
    throw failure('HEYGEN_SPACE_SCOPE_CONFLICT', 'Existing HeyGen space scope conflicts with pinned evidence.', 409);
  }
  return row;
}

async function ensureVerifiedScopeTx(tx, proof, refs) {
  const [existing] = await tx.select().from(providerVerifiedAccountScopes).where(and(
    eq(providerVerifiedAccountScopes.provider, 'heygen'),
    eq(providerVerifiedAccountScopes.providerAccountFingerprint, proof.providerSpaceFingerprint),
  )).limit(1);
  if (existing) return exactExistingScope(existing, proof, refs);
  const [created] = await tx.insert(providerVerifiedAccountScopes).values({
    provider: 'heygen',
    // The historical column name predates provider-native space evidence. The
    // value is the explicitly namespaced HeyGen space hash, never a claimed
    // global account, organization, billing, workspace, email, or username ID.
    providerAccountFingerprint: proof.providerSpaceFingerprint,
    canonicalScopeKey: proof.canonicalScopeKey,
    evidenceDigest: proof.spaceProofSha256,
    evidenceRef: refs.scope,
  }).onConflictDoNothing().returning();
  if (created) return exactExistingScope(created, proof, refs);
  const [raced] = await tx.select().from(providerVerifiedAccountScopes).where(and(
    eq(providerVerifiedAccountScopes.provider, 'heygen'),
    eq(providerVerifiedAccountScopes.providerAccountFingerprint, proof.providerSpaceFingerprint),
  )).limit(1);
  return exactExistingScope(raced, proof, refs);
}

function exactExistingBinding(binding, accountId, preflight, proof, refs) {
  if (!binding || binding.applicationAccountId !== accountId || binding.provider !== 'heygen'
    || binding.environment !== preflight.environment || binding.projectId !== preflight.projectId
    || binding.databaseBindingSha256 !== preflight.databaseBindingSha256
    || binding.credentialScopeFingerprint !== proof.credentialScopeFingerprint
    || binding.credentialEvidenceDigest !== proof.preflightEvidenceSha256
    || binding.credentialEvidenceRef !== refs.credential || binding.lifecycleState !== 'active'
    || binding.revokedAt !== null) {
    throw failure('HEYGEN_SPACE_BINDING_CONFLICT', 'Existing HeyGen space binding conflicts with pinned evidence.', 409);
  }
  return binding;
}

async function ensureBootstrapBindingTx(tx, { accountId, preflight, proof, refs }) {
  const originScopeKey = providerOriginScopeKey(proof.credentialScopeFingerprint);
  const [active] = await tx.select().from(providerAccountBindings).where(and(
    eq(providerAccountBindings.applicationAccountId, accountId),
    eq(providerAccountBindings.provider, 'heygen'),
    eq(providerAccountBindings.environment, preflight.environment),
    eq(providerAccountBindings.projectId, preflight.projectId),
    eq(providerAccountBindings.databaseBindingSha256, preflight.databaseBindingSha256),
    eq(providerAccountBindings.lifecycleState, 'active'),
  )).limit(1);
  if (active) return exactExistingBinding(active, accountId, preflight, proof, refs);
  const [created] = await tx.insert(providerAccountBindings).values({
    applicationAccountId: accountId,
    provider: 'heygen',
    environment: preflight.environment,
    projectId: preflight.projectId,
    databaseBindingSha256: preflight.databaseBindingSha256,
    credentialScopeFingerprint: proof.credentialScopeFingerprint,
    originScopeKey,
    credentialEvidenceDigest: proof.preflightEvidenceSha256,
    credentialEvidenceRef: refs.credential,
  }).onConflictDoNothing().returning();
  if (created) return exactExistingBinding(created, accountId, preflight, proof, refs);
  throw failure('HEYGEN_SPACE_BINDING_CONFLICT', 'HeyGen space binding could not be established atomically.', 409);
}

function exactExistingPromotion(promotion, binding, scope, proof, refs) {
  const observedAt = promotion?.observedAt instanceof Date
    ? promotion.observedAt.toISOString()
    : Number.isFinite(Date.parse(promotion?.observedAt)) ? new Date(promotion.observedAt).toISOString() : null;
  const verifiedAt = promotion?.verifiedAt instanceof Date
    ? promotion.verifiedAt.toISOString()
    : Number.isFinite(Date.parse(promotion?.verifiedAt)) ? new Date(promotion.verifiedAt).toISOString() : null;
  if (!promotion || promotion.bindingId !== binding.id
    || promotion.applicationAccountId !== binding.applicationAccountId
    || promotion.originScopeKey !== binding.originScopeKey
    || promotion.verifiedAccountScopeId !== scope.id || promotion.state !== 'verified'
    || promotion.evidenceDigest !== proof.identityDigest || promotion.evidenceRef !== refs.promotion
    || observedAt !== proof.spaceObservedAt || verifiedAt == null
    || Date.parse(verifiedAt) < Date.parse(observedAt) || promotion.revokedAt !== null) {
    throw failure('HEYGEN_SPACE_PROMOTION_CONFLICT', 'Existing HeyGen space promotion conflicts with pinned evidence.', 409);
  }
  return promotion;
}

async function requireAccountTx(tx, accountId) {
  const [account] = await tx.select({ id: users.id }).from(users).where(eq(users.id, accountId)).limit(1);
  if (!account || account.id !== accountId) {
    throw failure('APPLICATION_ACCOUNT_NOT_FOUND', 'The application account does not exist.', 404);
  }
}

async function ensurePromotionTx(tx, { accountId, binding, scope, proof, refs, now }) {
  const existing = await tx.select().from(providerAccountBindingPromotions).where(
    eq(providerAccountBindingPromotions.bindingId, binding.id),
  );
  if (existing.length > 0) {
    if (existing.length !== 1) {
      throw failure('HEYGEN_SPACE_PROMOTION_CONFLICT', 'Provider binding has an ambiguous promotion history.', 409);
    }
    return exactExistingPromotion(existing[0], binding, scope, proof, refs);
  }
  const [created] = await tx.insert(providerAccountBindingPromotions).values({
    bindingId: binding.id,
    applicationAccountId: accountId,
    originScopeKey: binding.originScopeKey,
    verifiedAccountScopeId: scope.id,
    state: 'verified',
    evidenceDigest: proof.identityDigest,
    evidenceRef: refs.promotion,
    observedAt: new Date(proof.spaceObservedAt),
    verifiedAt: now,
  }).returning();
  return exactExistingPromotion(created, binding, scope, proof, refs);
}

function makeBinding({ accountId, preflight, proof, binding, scope, promotion }) {
  const effectiveExpiresAt = new Date(Math.min(Date.parse(proof.expiresAt), Date.parse(proof.anchorExpiresAt))).toISOString();
  const value = deepFreeze({
    version: HEYGEN_SPACE_BINDING_VERSION,
    provider: 'heygen',
    scopeType: 'space',
    environment: preflight.environment,
    projectId: preflight.projectId,
    applicationAccountId: accountId,
    bindingId: binding.id,
    verifiedAccountScopeId: scope.id,
    promotionId: promotion.id,
    databaseBindingSha256: preflight.databaseBindingSha256,
    credentialScopeFingerprint: proof.credentialScopeFingerprint,
    originScopeKey: binding.originScopeKey,
    providerSpaceFingerprint: proof.providerSpaceFingerprint,
    canonicalScopeKey: proof.canonicalScopeKey,
    identityDigest: proof.identityDigest,
    spaceObservedAt: proof.spaceObservedAt,
    qualifiedAt: proof.qualifiedAt,
    expiresAt: effectiveExpiresAt,
    anchorExpiresAt: proof.anchorExpiresAt,
  });
  BINDING_BRANDS.add(value);
  return value;
}

function assertBindingIdentity(binding) {
  if (!BINDING_BRANDS.has(binding) || !Object.isFrozen(binding)
    || binding.version !== HEYGEN_SPACE_BINDING_VERSION || binding.provider !== 'heygen'
    || binding.scopeType !== 'space' || binding.environment !== 'verification') {
    throw failure('HEYGEN_SPACE_BINDING_UNVERIFIED', 'HeyGen space binding is not verified.');
  }
  exactText(binding.projectId, 'binding projectId', 255);
  exactDigest(binding.databaseBindingSha256, 'database binding digest');
  exactDigest(binding.credentialScopeFingerprint, 'credential scope fingerprint');
  exactDigest(binding.originScopeKey, 'origin scope key');
  exactDigest(binding.providerSpaceFingerprint, 'provider space fingerprint');
  exactDigest(binding.canonicalScopeKey, 'canonical provider scope key');
  exactDigest(binding.identityDigest, 'identity evidence digest');
  const qualifiedAt = Date.parse(exactIso(binding.qualifiedAt, 'binding qualification time'));
  const spaceObservedAt = Date.parse(exactIso(binding.spaceObservedAt, 'binding provider space observation time'));
  const expiresAt = Date.parse(exactIso(binding.expiresAt, 'binding expiry time'));
  const anchorExpiresAt = Date.parse(exactIso(binding.anchorExpiresAt, 'binding anchor expiry time'));
  if (spaceObservedAt > qualifiedAt || qualifiedAt >= expiresAt || expiresAt > anchorExpiresAt) {
    throw failure('HEYGEN_SPACE_BINDING_UNVERIFIED', 'HeyGen space binding identity is invalid.');
  }
  return { binding, qualifiedAt, expiresAt, anchorExpiresAt };
}

function assertBindingShape(binding, now) {
  const identity = assertBindingIdentity(binding);
  const current = exactDate(now);
  if (current.getTime() < identity.qualifiedAt || current.getTime() >= identity.expiresAt
    || current.getTime() >= identity.anchorExpiresAt) {
    throw failure('HEYGEN_SPACE_BINDING_STALE', 'HeyGen space binding qualification is stale.');
  }
  return binding;
}

function bindingContext(binding) {
  const context = BINDING_CONTEXTS.get(binding);
  if (!context) throw failure('HEYGEN_SPACE_BINDING_UNVERIFIED', 'HeyGen space binding has no verified execution context.');
  return context;
}

function assertBindingExecutionContext(binding) {
  const context = bindingContext(binding);
  context.assertCurrent();
  return binding;
}

export async function withFreshHeygenSpaceBindingTransaction(input, callback) {
  const value = exactInput(input, new Set(['accountId', 'providerBinding']));
  const accountId = exactText(value.accountId, 'accountId');
  if (typeof callback !== 'function') {
    throw failure('INVALID_HEYGEN_SPACE_BINDING_INPUT', 'HeyGen space binding transaction callback is invalid.', 400);
  }
  const context = bindingContext(value.providerBinding);
  if (value.providerBinding.applicationAccountId !== accountId || context.accountId !== accountId) {
    throw failure('HEYGEN_SPACE_BINDING_ACCOUNT_MISMATCH', 'HeyGen space binding belongs to a different application account.', 403);
  }
  context.assertCurrent();
  return context.withExecutor(async tx => {
    await context.acquireProviderLifecycleLock(tx, accountId);
    context.assertCurrent();
    ACTIVE_CLAIM_TRANSACTIONS.set(tx, Object.freeze({ accountId, providerBinding: value.providerBinding }));
    try {
      return await callback(tx);
    } finally {
      ACTIVE_CLAIM_TRANSACTIONS.delete(tx);
    }
  });
}

export function assertFreshHeygenProviderClaimTx(tx, input) {
  const value = exactInput(input, new Set(['accountId', 'providerBinding']));
  const accountId = exactText(value.accountId, 'accountId');
  const active = ACTIVE_CLAIM_TRANSACTIONS.get(tx);
  if (!active || active.accountId !== accountId || active.providerBinding !== value.providerBinding) {
    throw failure('HEYGEN_PROVIDER_CLAIM_TRANSACTION_UNVERIFIED', 'Provider claim is not using the verified binding transaction.', 403);
  }
  const context = bindingContext(value.providerBinding);
  if (value.providerBinding.applicationAccountId !== accountId || context.accountId !== accountId) {
    throw failure('HEYGEN_SPACE_BINDING_ACCOUNT_MISMATCH', 'HeyGen space binding belongs to a different application account.', 403);
  }
  context.assertCurrent();
  return value.providerBinding;
}

export async function withHeygenSpaceBindingReceiptTransaction(input, callback) {
  const value = exactInput(input, new Set(['accountId', 'providerBinding']));
  const accountId = exactText(value.accountId, 'accountId');
  if (typeof callback !== 'function') {
    throw failure('INVALID_HEYGEN_SPACE_BINDING_INPUT', 'HeyGen provider receipt callback is invalid.', 400);
  }
  const context = bindingContext(value.providerBinding);
  assertBindingIdentity(value.providerBinding);
  if (value.providerBinding.applicationAccountId !== accountId || context.accountId !== accountId) {
    throw failure('HEYGEN_SPACE_BINDING_ACCOUNT_MISMATCH', 'HeyGen space binding belongs to a different application account.', 403);
  }
  return context.withReceiptExecutor(async tx => {
    await context.acquireProviderLifecycleLock(tx, accountId);
    assertBindingIdentity(value.providerBinding);
    ACTIVE_RECEIPT_TRANSACTIONS.set(tx, Object.freeze({ accountId, providerBinding: value.providerBinding }));
    try {
      return await callback(tx);
    } finally {
      ACTIVE_RECEIPT_TRANSACTIONS.delete(tx);
    }
  });
}

export function assertHeygenProviderReceiptTx(tx, input) {
  const value = exactInput(input, new Set(['accountId', 'providerBinding']));
  const accountId = exactText(value.accountId, 'accountId');
  const active = ACTIVE_RECEIPT_TRANSACTIONS.get(tx);
  if (!active || active.accountId !== accountId || active.providerBinding !== value.providerBinding) {
    throw failure('HEYGEN_PROVIDER_RECEIPT_TRANSACTION_UNVERIFIED', 'Provider receipt is not using the verified binding transaction.', 403);
  }
  const context = bindingContext(value.providerBinding);
  if (value.providerBinding.applicationAccountId !== accountId || context.accountId !== accountId) {
    throw failure('HEYGEN_SPACE_BINDING_ACCOUNT_MISMATCH', 'HeyGen space binding belongs to a different application account.', 403);
  }
  assertBindingIdentity(value.providerBinding);
  return value.providerBinding;
}

function dependenciesFor(trusted = {}) {
  const allowed = new Set([
    'env', 'now', 'executor', 'targetPreflight', 'lstat', 'loadTargetManifest', 'loadSchemaLock',
    'validateTarget', 'checkDatabaseMigrations', 'databaseBindingSha256', 'qualifyHeygenCredential',
    'loadVerifiedHeygenSpaceAnchor', 'loadPinnedHeygenSpaceAnchorProjection',
    'validateFreshHeygenQualification', 'assertFreshHeygenSpaceProof', 'assertFreshHeygenBootstrapProof',
    'acquireProviderLifecycleLock',
  ]);
  if (!isRecord(trusted) || Object.keys(trusted).some(key => !allowed.has(key))) {
    throw failure('INVALID_HEYGEN_SPACE_BINDING_DEPENDENCIES', 'HeyGen space binding dependencies are invalid.', 500);
  }
  if (Object.keys(trusted).length > 0 && !ALLOW_TEST_DEPENDENCIES) {
    throw failure('HEYGEN_SPACE_BINDING_TEST_ONLY', 'HeyGen space binding dependency injection is test-only.', 403);
  }
  return {
    env: trusted.env || (() => process.env),
    now: trusted.now || (() => new Date()),
    executor: trusted.executor || null,
    targetPreflight: trusted.targetPreflight || defaultTargetPreflight,
    lstat: trusted.lstat || lstat,
    loadTargetManifest: trusted.loadTargetManifest || loadTargetManifest,
    loadSchemaLock: trusted.loadSchemaLock || loadSchemaLock,
    validateTarget: trusted.validateTarget || validateTarget,
    checkDatabaseMigrations: trusted.checkDatabaseMigrations || checkDatabaseMigrations,
    databaseBindingSha256: trusted.databaseBindingSha256 || databaseBindingSha256,
    qualifyHeygenCredential: trusted.qualifyHeygenCredential || qualifyHeygenCredential,
    loadVerifiedHeygenSpaceAnchor: trusted.loadVerifiedHeygenSpaceAnchor || loadVerifiedHeygenSpaceAnchor,
    loadPinnedHeygenSpaceAnchorProjection: trusted.loadPinnedHeygenSpaceAnchorProjection || loadPinnedHeygenSpaceAnchorProjection,
    validateFreshHeygenQualification: trusted.validateFreshHeygenQualification || validateFreshHeygenQualification,
    assertFreshHeygenSpaceProof: trusted.assertFreshHeygenSpaceProof || assertFreshHeygenSpaceProof,
    assertFreshHeygenBootstrapProof: trusted.assertFreshHeygenBootstrapProof || assertFreshHeygenBootstrapProof,
    acquireProviderLifecycleLock: trusted.acquireProviderLifecycleLock || acquireProviderLifecycleLock,
  };
}

export function createHeygenSpaceBindingRepository(trustedDependencies = {}) {
  const dependencies = dependenciesFor(trustedDependencies);
  if (trustedDependencies.env && !trustedDependencies.executor) {
    throw failure('EXECUTOR_DATABASE_URL_UNBOUND', 'An injected environment requires an executor bound to the same database.', 500);
  }

  async function prepare({ privateEvidenceDir = null } = {}) {
    const env = dependencies.env();
    if (!isEnvironment(env)) throw failure('HEYGEN_BINDING_ENVIRONMENT_INVALID', 'Binding environment is unavailable.');
    const preflight = await dependencies.targetPreflight(env, dependencies);
    const anchorNow = exactDate(dependencies.now());
    const bootstrap = privateEvidenceDir !== null;
    const anchor = bootstrap
      ? await dependencies.loadVerifiedHeygenSpaceAnchor({ privateEvidenceDirectory: privateEvidenceDir, now: anchorNow })
      : await dependencies.loadPinnedHeygenSpaceAnchorProjection({ now: anchorNow });
    const credential = selectCredential(env);
    if (typeof anchor?.credentialKeyFingerprint !== 'string'
      || credentialKeyFingerprint(credential) !== anchor.credentialKeyFingerprint) {
      throw failure('HEYGEN_CREDENTIAL_ANCHOR_MISMATCH', 'Configured HeyGen credential does not match the pinned space anchor.', 409);
    }
    const observedAt = exactDate(dependencies.now());
    const qualification = await dependencies.qualifyHeygenCredential({ apiKey: credential, now: observedAt });
    const proofNow = exactDate(dependencies.now());
    const proof = assertProofShape(dependencies.validateFreshHeygenQualification(anchor, qualification, { now: proofNow }));
    const assertFreshProof = bootstrap ? dependencies.assertFreshHeygenBootstrapProof : dependencies.assertFreshHeygenSpaceProof;
    assertFreshProof(proof, { now: proofNow });
    assertRuntimeInputsStable(env, preflight, credential);
    return { env, preflight, credential, proof, assertFreshProof, refs: evidenceRefs(proof) };
  }

  async function withExecutor(prepared, callback, { requireCurrentInputs = true } = {}) {
    if (dependencies.executor) return dependencies.executor.transaction(callback);
    if (requireCurrentInputs) assertRuntimeInputsStable(prepared.env, prepared.preflight, prepared.credential);
    neonConfig.webSocketConstructor = ws;
    const pool = new Pool({
      connectionString: prepared.preflight.databaseUrl,
      max: 1,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 10_000,
      query_timeout: 10_000,
    });
    // The pool is deliberately short-lived and bound to the exact URL that
    // passed the pinned preflight, so a cached client cannot target another DB.
    pool.on('error', () => {});
    const executor = drizzle({ client: pool, schema: databaseSchema });
    try {
      return await executor.transaction(callback);
    } finally {
      await pool.end();
    }
  }

  function attachExecutionContext(binding, prepared, accountId) {
    BINDING_CONTEXTS.set(binding, Object.freeze({
      accountId,
      now: dependencies.now,
      acquireProviderLifecycleLock: dependencies.acquireProviderLifecycleLock,
      withExecutor: callback => withExecutor(prepared, callback),
      withReceiptExecutor: callback => withExecutor(prepared, callback, { requireCurrentInputs: false }),
      assertCurrent() {
        const now = exactDate(dependencies.now());
        prepared.assertFreshProof(prepared.proof, { now });
        assertRuntimeInputsStable(prepared.env, prepared.preflight, prepared.credential);
        assertBindingShape(binding, now);
      },
    }));
    return binding;
  }

  async function bootstrapVerifiedHeygenSpaceBinding(input) {
    const value = exactInput(input, new Set(['accountId', 'privateEvidenceDir']));
    const accountId = exactText(value.accountId, 'accountId');
    if (typeof value.privateEvidenceDir !== 'string' || !isAbsolute(value.privateEvidenceDir)
      || value.privateEvidenceDir !== value.privateEvidenceDir.trim()) {
      throw failure('INVALID_HEYGEN_SPACE_BINDING_INPUT', 'privateEvidenceDir must be an absolute protected path.', 400);
    }
    const prepared = await prepare({ privateEvidenceDir: value.privateEvidenceDir });
    const result = await withExecutor(prepared, async tx => {
      await dependencies.acquireProviderLifecycleLock(tx, accountId);
      prepared.assertFreshProof(prepared.proof, { now: exactDate(dependencies.now()) });
      assertRuntimeInputsStable(prepared.env, prepared.preflight, prepared.credential);
      await requireAccountTx(tx, accountId);
      const scope = await ensureVerifiedScopeTx(tx, prepared.proof, prepared.refs);
      const binding = await ensureBootstrapBindingTx(tx, {
        accountId,
        preflight: prepared.preflight,
        proof: prepared.proof,
        refs: prepared.refs,
      });
      const now = exactDate(dependencies.now());
      const promotion = await ensurePromotionTx(tx, {
        accountId,
        binding,
        scope,
        proof: prepared.proof,
        refs: prepared.refs,
        now,
      });
      prepared.assertFreshProof(prepared.proof, { now: exactDate(dependencies.now()) });
      return makeBinding({ accountId, preflight: prepared.preflight, proof: prepared.proof, binding, scope, promotion });
    });
    prepared.assertFreshProof(prepared.proof, { now: exactDate(dependencies.now()) });
    attachExecutionContext(result, prepared, accountId);
    return assertBindingShape(result, dependencies.now());
  }

  async function resolveFreshHeygenSpaceBinding(input) {
    const value = exactInput(input, new Set(['accountId']));
    const accountId = exactText(value.accountId, 'accountId');
    const prepared = await prepare();
    const result = await withExecutor(prepared, async tx => {
      await dependencies.acquireProviderLifecycleLock(tx, accountId);
      prepared.assertFreshProof(prepared.proof, { now: exactDate(dependencies.now()) });
      assertRuntimeInputsStable(prepared.env, prepared.preflight, prepared.credential);
      await requireAccountTx(tx, accountId);
      const bindings = await tx.select().from(providerAccountBindings).where(and(
        eq(providerAccountBindings.applicationAccountId, accountId),
        eq(providerAccountBindings.provider, 'heygen'),
        eq(providerAccountBindings.environment, prepared.preflight.environment),
        eq(providerAccountBindings.projectId, prepared.preflight.projectId),
        eq(providerAccountBindings.databaseBindingSha256, prepared.preflight.databaseBindingSha256),
        eq(providerAccountBindings.lifecycleState, 'active'),
      ));
      if (bindings.length !== 1) {
        throw failure('HEYGEN_SPACE_BINDING_NOT_ACTIVE', 'Exactly one active HeyGen space binding is required.', 409);
      }
      const binding = exactExistingBinding(bindings[0], accountId, prepared.preflight, prepared.proof, prepared.refs);
      const scopes = await tx.select().from(providerVerifiedAccountScopes).where(and(
        eq(providerVerifiedAccountScopes.provider, 'heygen'),
        eq(providerVerifiedAccountScopes.providerAccountFingerprint, prepared.proof.providerSpaceFingerprint),
      ));
      if (scopes.length !== 1) {
        throw failure('HEYGEN_SPACE_SCOPE_CONFLICT', 'Exactly one pinned HeyGen space scope is required.', 409);
      }
      const scope = exactExistingScope(scopes[0], prepared.proof, prepared.refs);
      const promotions = await tx.select().from(providerAccountBindingPromotions).where(
        eq(providerAccountBindingPromotions.bindingId, binding.id),
      );
      if (promotions.length !== 1) {
        throw failure('HEYGEN_SPACE_PROMOTION_CONFLICT', 'Exactly one HeyGen space promotion is required.', 409);
      }
      const promotion = exactExistingPromotion(promotions[0], binding, scope, prepared.proof, prepared.refs);
      prepared.assertFreshProof(prepared.proof, { now: exactDate(dependencies.now()) });
      return makeBinding({ accountId, preflight: prepared.preflight, proof: prepared.proof, binding, scope, promotion });
    });
    prepared.assertFreshProof(prepared.proof, { now: exactDate(dependencies.now()) });
    attachExecutionContext(result, prepared, accountId);
    return assertBindingShape(result, dependencies.now());
  }

  function assertFreshHeygenSpaceBinding(binding) {
    return assertBindingExecutionContext(binding);
  }

  function safeHeygenSpaceBindingStatus(binding) {
    const verified = assertFreshHeygenSpaceBinding(binding);
    return deepFreeze({
      version: verified.version,
      provider: verified.provider,
      scopeType: verified.scopeType,
      globalAccountIdVerified: false,
      environment: verified.environment,
      databaseBindingSha256: verified.databaseBindingSha256,
      credentialScopeFingerprint: verified.credentialScopeFingerprint,
      providerSpaceFingerprint: verified.providerSpaceFingerprint,
      canonicalScopeKey: verified.canonicalScopeKey,
      identityDigest: verified.identityDigest,
      freshUntil: verified.expiresAt,
      verified: true,
      runtimeActivation: false,
    });
  }

  return Object.freeze({
    bootstrapVerifiedHeygenSpaceBinding,
    resolveFreshHeygenSpaceBinding,
    assertFreshHeygenSpaceBinding,
    safeHeygenSpaceBindingStatus,
  });
}

const defaultRepository = createHeygenSpaceBindingRepository();

export const bootstrapVerifiedHeygenSpaceBinding = input => defaultRepository.bootstrapVerifiedHeygenSpaceBinding(input);
export const resolveFreshHeygenSpaceBinding = input => defaultRepository.resolveFreshHeygenSpaceBinding(input);
export const assertFreshHeygenSpaceBinding = binding => defaultRepository.assertFreshHeygenSpaceBinding(binding);
export const safeHeygenSpaceBindingStatus = binding => defaultRepository.safeHeygenSpaceBindingStatus(binding);
