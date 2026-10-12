import { createHash } from 'node:crypto';

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { database } from './client.js';
import { projects, userIdentities, videoJobs } from './schema.js';
import {
  LUXIFY_ASPECT_RATIOS,
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_MAX_DURATION_SECONDS,
  LUXIFY_MAX_LOOKS,
  LUXIFY_MIN_DURATION_SECONDS,
  LUXIFY_MIN_LOOKS,
  LUXIFY_PROMPT_MAX_CHARS,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
  LUXIFY_RESOLUTIONS,
  LUXIFY_TITLE_MAX_CHARS,
  canonicalizeLuxifyIntent,
  luxifyFormatForAspectRatio,
} from '../lib/luxify-contract.js';
import { digestLuxifyLookBindings, safeLuxifyQuoteProof } from '../lib/luxify-quote.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const ELIGIBILITY_REVISION = /^[A-Za-z0-9_.:-]{1,160}$/;
const PROJECT_KEYS = new Set(['accountId', 'contractVersion', 'projectId', 'title', 'prompt', 'lookIdentityIds', 'aspectRatio', 'resolution', 'durationSeconds']);
const SETTING_KEYS = new Set(['contractVersion', 'renderMode', 'providerCapability', 'prompt', 'lookIdentityIds', 'aspectRatio', 'resolution', 'durationSeconds']);

function fail(code, message, statusCode = 409, failureCategory = 'RECONCILIATION') {
  throw Object.assign(new Error(message), { code, statusCode, failureCategory });
}

function exactRecord(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('LUXIFY_PROJECT_INVALID', message, 400, 'VALIDATION');
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some(key => !keys.has(key))) fail('LUXIFY_PROJECT_INVALID', message, 400, 'VALIDATION');
  return value;
}

function exactAccountId(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('LUXIFY_PROJECT_INVALID', 'LUXIFY account binding is invalid.', 400, 'VALIDATION');
  }
  return value;
}

function exactUuid(value, message = 'LUXIFY identifier is invalid.') {
  if (typeof value !== 'string' || !UUID.test(value)) fail('LUXIFY_PROJECT_INVALID', message, 400, 'VALIDATION');
  return value.toLowerCase();
}

function exactText(value, maximum, message) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maximum) fail('LUXIFY_PROJECT_INVALID', message, 400, 'VALIDATION');
  return value;
}

function exactLookIds(value) {
  if (!Array.isArray(value) || value.length < LUXIFY_MIN_LOOKS || value.length > LUXIFY_MAX_LOOKS) {
    fail('LUXIFY_PROJECT_INVALID', 'LUXIFY requires one to three look identities.', 400, 'VALIDATION');
  }
  const ids = value.map(item => exactUuid(item, 'LUXIFY look identity is invalid.'));
  if (new Set(ids).size !== ids.length) fail('LUXIFY_PROJECT_INVALID', 'LUXIFY look identities must be unique.', 400, 'VALIDATION');
  return Object.freeze(ids);
}

function canonicalProject(value) {
  const input = exactRecord(value, PROJECT_KEYS, 'LUXIFY project input is invalid.');
  const normalized = {
    accountId: exactAccountId(input.accountId),
    contractVersion: input.contractVersion,
    projectId: exactUuid(input.projectId, 'LUXIFY project identifier is invalid.'),
    title: exactText(input.title, LUXIFY_TITLE_MAX_CHARS, 'LUXIFY project title is invalid.'),
    prompt: exactText(input.prompt, LUXIFY_PROMPT_MAX_CHARS, 'LUXIFY prompt is invalid.'),
    lookIdentityIds: exactLookIds(input.lookIdentityIds),
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    durationSeconds: input.durationSeconds,
  };
  if (normalized.contractVersion !== LUXIFY_CONTRACT_VERSION || !LUXIFY_ASPECT_RATIOS.includes(normalized.aspectRatio)
    || !LUXIFY_RESOLUTIONS.includes(normalized.resolution) || !Number.isInteger(normalized.durationSeconds)
    || normalized.durationSeconds < LUXIFY_MIN_DURATION_SECONDS || normalized.durationSeconds > LUXIFY_MAX_DURATION_SECONDS) {
    fail('LUXIFY_PROJECT_INVALID', 'LUXIFY project settings are invalid.', 400, 'VALIDATION');
  }
  return Object.freeze(normalized);
}

function iso(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function storedProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) fail('LUXIFY_PROJECT_NOT_FOUND', 'LUXIFY project not found.', 404, 'OWNERSHIP');
  const settings = exactRecord(project.settings, SETTING_KEYS, 'Saved LUXIFY project binding is invalid.');
  if ((project.identityId !== null && project.identityId !== undefined) || project.script !== '' || settings.contractVersion !== LUXIFY_CONTRACT_VERSION
    || settings.renderMode !== LUXIFY_RENDER_MODE || settings.providerCapability !== LUXIFY_PROVIDER_CAPABILITY) {
    fail('LUXIFY_PROJECT_BINDING_CHANGED', 'Saved LUXIFY project binding changed.');
  }
  return {
    ...canonicalProject({
      accountId: project.accountId,
      contractVersion: settings.contractVersion,
      projectId: project.id,
      title: project.title,
      prompt: settings.prompt,
      lookIdentityIds: settings.lookIdentityIds,
      aspectRatio: settings.aspectRatio,
      resolution: settings.resolution,
      durationSeconds: settings.durationSeconds,
    }),
    createdAt: iso(project.createdAt),
    updatedAt: iso(project.updatedAt),
  };
}

export function luxifyProjectDto(project) {
  const value = storedProject(project);
  return Object.freeze({
    id: value.projectId,
    contractVersion: value.contractVersion,
    title: value.title,
    prompt: value.prompt,
    lookIdentityIds: Object.freeze([...value.lookIdentityIds]),
    aspectRatio: value.aspectRatio,
    resolution: value.resolution,
    durationSeconds: value.durationSeconds,
    ...(value.createdAt ? { createdAt: value.createdAt } : {}),
    ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
  });
}

function safeJobText(value, fallback) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 160
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : fallback;
}

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');

export function assertLuxifyJobBinding(job, { accountId, projectId, idempotencyKey }) {
  if (!job || job.accountId !== accountId || job.projectId !== projectId || job.idempotencyKey !== idempotencyKey
    || job.provider !== 'heygen' || job.input?.renderMode !== LUXIFY_RENDER_MODE
    || job.input?.providerCapability !== LUXIFY_PROVIDER_CAPABILITY) {
    fail('LUXIFY_RECOVERY_BINDING_MISMATCH', 'Existing request does not match this LUXIFY project.');
  }
  let intent;
  try {
    intent = canonicalizeLuxifyIntent({
      contractVersion: job.input?.contractVersion,
      projectId: job.input?.projectId,
      idempotencyKey: job.idempotencyKey,
      title: job.input?.title,
      prompt: job.input?.prompt,
      lookIdentityIds: job.input?.lookIdentityIds,
      aspectRatio: job.input?.aspectRatio,
      resolution: job.input?.resolution,
      durationSeconds: job.input?.durationSeconds,
    });
  } catch {
    fail('LUXIFY_RECOVERY_BINDING_MISMATCH', 'Existing request does not match this LUXIFY project.');
  }
  if (intent.projectId !== projectId || intent.idempotencyKey !== idempotencyKey
    || job.title !== intent.title || job.format !== luxifyFormatForAspectRatio(intent.aspectRatio)) {
    fail('LUXIFY_RECOVERY_BINDING_MISMATCH', 'Existing request does not match this LUXIFY project.');
  }
  const providerLookIds = job.input?.eligibleLookIds;
  const eligibilityRevision = job.input?.eligibilityRevision;
  if (!Array.isArray(providerLookIds) || providerLookIds.length !== intent.lookIdentityIds.length
    || providerLookIds.some(id => !PROVIDER_ID.test(id || '')) || new Set(providerLookIds).size !== providerLookIds.length
    || !ELIGIBILITY_REVISION.test(eligibilityRevision || '')) {
    fail('LUXIFY_RECOVERY_BINDING_MISMATCH', 'Existing request does not match this LUXIFY project.');
  }
  const lookBindings = intent.lookIdentityIds.map((identityId, index) => ({ identityId, providerLookId: providerLookIds[index] }));
  let proof;
  try {
    proof = safeLuxifyQuoteProof(job.input?.quoteProof);
  } catch {
    fail('LUXIFY_RECOVERY_BINDING_MISMATCH', 'Existing request does not match this LUXIFY project.');
  }
  if (proof.accountSha256 !== sha256(accountId) || proof.projectId !== projectId
    || proof.idempotencyKeySha256 !== sha256(idempotencyKey) || proof.titleSha256 !== sha256(intent.title)
    || proof.promptSha256 !== sha256(intent.prompt) || proof.lookBindingsSha256 !== digestLuxifyLookBindings(lookBindings)
    || proof.eligibilityRevisionSha256 !== sha256(eligibilityRevision) || proof.aspectRatio !== intent.aspectRatio
    || proof.resolution !== intent.resolution || proof.durationSeconds !== intent.durationSeconds
    || proof.renderMode !== LUXIFY_RENDER_MODE || proof.providerCapability !== LUXIFY_PROVIDER_CAPABILITY
    || proof.luxCredits !== job.costCredits) {
    fail('LUXIFY_RECOVERY_BINDING_MISMATCH', 'Existing request does not match this LUXIFY project.');
  }
  return intent;
}

export function luxifyJobDto(job) {
  const id = safeJobText(job?.id, null);
  if (!id) fail('LUXIFY_RECOVERY_BINDING_MISMATCH', 'Existing LUXIFY request is invalid.');
  return Object.freeze({
    id,
    mode: 'luxify',
    status: safeJobText(job.status, 'unknown'),
    title: safeJobText(job.title, 'LUXIFY video'),
    projectId: exactUuid(job.projectId, 'LUXIFY job project is invalid.'),
    ...(iso(job.createdAt) ? { createdAt: iso(job.createdAt) } : {}),
    ...(iso(job.updatedAt) ? { updatedAt: iso(job.updatedAt) } : {}),
  });
}

const defaultStore = Object.freeze({
  transaction: work => database().transaction(work),
  lockProject: (tx, accountId, projectId) => tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${accountId}:${projectId}:luxify-project`}, 0))`,
  ),
  findProjectById: async (tx, projectId) => (
    await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  )[0] || null,
  findOwnedLookIdentities: (tx, accountId, identityIds) => tx.select({
    id: userIdentities.id,
    displayName: userIdentities.displayName,
  }).from(userIdentities).where(and(
    eq(userIdentities.accountId, accountId),
    inArray(userIdentities.id, identityIds),
    isNull(userIdentities.archivedAt),
  )),
  insertProject: async (tx, values) => (await tx.insert(projects).values(values).returning())[0],
  updateProject: async (tx, accountId, projectId, values) => (
    await tx.update(projects).set(values).where(and(eq(projects.id, projectId), eq(projects.accountId, accountId))).returning()
  )[0] || null,
  findOwnedJob: async (accountId, idempotencyKey) => (
    await database().select().from(videoJobs).where(and(
      eq(videoJobs.accountId, accountId),
      eq(videoJobs.idempotencyKey, idempotencyKey),
    )).limit(1)
  )[0] || null,
});

function projectValues(input, updatedAt) {
  return {
    accountId: input.accountId,
    identityId: null,
    title: input.title,
    // Legacy deployments can still enforce projects.script NOT NULL. Keep the
    // Presenter field empty and store the prompt only inside the exact LUXIFY
    // settings contract so generic project DTOs cannot relabel it as a script.
    script: '',
    avatar: {},
    voice: {},
    settings: {
      contractVersion: LUXIFY_CONTRACT_VERSION,
      renderMode: LUXIFY_RENDER_MODE,
      providerCapability: LUXIFY_PROVIDER_CAPABILITY,
      prompt: input.prompt,
      lookIdentityIds: [...input.lookIdentityIds],
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      durationSeconds: input.durationSeconds,
    },
    updatedAt,
  };
}

export function createLuxifyRepository({ store = defaultStore, now = () => new Date() } = {}) {
  const methods = ['transaction', 'lockProject', 'findProjectById', 'findOwnedLookIdentities', 'insertProject', 'updateProject', 'findOwnedJob'];
  if (!store || methods.some(method => typeof store[method] !== 'function')) throw new TypeError('A complete LUXIFY repository store is required.');

  async function saveProject(value) {
    const input = canonicalProject(value);
    return store.transaction(async tx => {
      await store.lockProject(tx, input.accountId, input.projectId);
      const existing = await store.findProjectById(tx, input.projectId);
      if (existing && existing.accountId !== input.accountId) fail('LUXIFY_PROJECT_NOT_FOUND', 'LUXIFY project not found.', 404, 'OWNERSHIP');
      if (existing) storedProject(existing);

      const identities = await store.findOwnedLookIdentities(tx, input.accountId, [...input.lookIdentityIds]);
      const ownedIds = new Set((identities || []).map(identity => String(identity?.id || '').toLowerCase()));
      if (ownedIds.size !== input.lookIdentityIds.length || input.lookIdentityIds.some(id => !ownedIds.has(id))) {
        fail('LUXIFY_LOOK_NOT_FOUND', 'One or more LUXIFY looks are unavailable.', 404, 'OWNERSHIP');
      }

      const timestamp = now();
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) throw new TypeError('LUXIFY repository clock is invalid.');
      const values = projectValues(input, timestamp);
      const saved = existing
        ? await store.updateProject(tx, input.accountId, input.projectId, values)
        : await store.insertProject(tx, { id: input.projectId, ...values });
      if (!saved) fail('LUXIFY_PROJECT_NOT_FOUND', 'LUXIFY project not found.', 404, 'OWNERSHIP');
      return luxifyProjectDto(saved);
    });
  }

  async function getProject(accountId, projectId) {
    const owner = exactAccountId(accountId);
    const id = exactUuid(projectId, 'LUXIFY project identifier is invalid.');
    return store.transaction(async tx => {
      const project = await store.findProjectById(tx, id);
      if (!project || project.accountId !== owner) fail('LUXIFY_PROJECT_NOT_FOUND', 'LUXIFY project not found.', 404, 'OWNERSHIP');
      return luxifyProjectDto(project);
    });
  }

  async function recoverJob({ accountId, contractVersion, projectId, idempotencyKey }) {
    const owner = exactAccountId(accountId);
    const project = exactUuid(projectId, 'LUXIFY project identifier is invalid.');
    const key = exactUuid(idempotencyKey, 'LUXIFY idempotency key is invalid.');
    if (contractVersion !== LUXIFY_CONTRACT_VERSION) fail('LUXIFY_RECOVERY_INVALID', 'LUXIFY recovery contract is invalid.', 400, 'VALIDATION');
    const job = await store.findOwnedJob(owner, key);
    if (!job) return null;
    assertLuxifyJobBinding(job, { accountId: owner, projectId: project, idempotencyKey: key });
    return luxifyJobDto(job);
  }

  return Object.freeze({ getProject, recoverJob, saveProject });
}

export const luxifyRepository = createLuxifyRepository();
