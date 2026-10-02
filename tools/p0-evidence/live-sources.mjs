// Only fixed-origin HTTPS reads and repeatable-read READ ONLY database queries.
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requireEvidence, sha256 } from './core.mjs';
import { loadTargetManifest, loadSchemaLock, validateTarget, checkDatabaseMigrations } from '../check-migrations.mjs';
import { databaseBindingSha256 } from '../../lib/provider-reconciliation-target.js';
import { loadPinnedHeygenSpaceAnchorProjection, validateFreshHeygenQualification, assertFreshHeygenSpaceProof } from '../../lib/heygen-space-anchor.js';
import { qualifyHeygenCredential } from '../../services/heygen-account-qualification.js';

const MAX_BYTES = 100 * 1024 * 1024;
const camel = row => row && Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value instanceof Date ? value.toISOString() : value]));
const rows = result => result.rows.map(camel);
export function normalizeVideo(value) {
  requireEvidence(value && /^[A-Za-z0-9_.:-]{1,255}$/.test(value.id || '') && typeof value.title === 'string'
    && Number.isSafeInteger(value.created_at) && value.created_at > 0 && typeof value.status === 'string', 'PROVIDER_VIDEO_INVALID');
  return { id: value.id, title: value.title, status: value.status, createdAt: new Date(value.created_at * 1000).toISOString() };
}
export async function readAllProviderVideos(get) {
  const ids = new Set(), tokens = new Set(), videos = [];
  let token;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL('https://api.heygen.com/v3/videos');
    url.searchParams.set('limit', '100');
    if (token) url.searchParams.set('token', token);
    const payload = await get(url);
    requireEvidence(Array.isArray(payload.data) && typeof payload.has_more === 'boolean', 'PROVIDER_INVENTORY_INVALID');
    for (const raw of payload.data) {
      const video = normalizeVideo(raw);
      // Repeated entries could indicate pagination drift; do not silently dedupe.
      requireEvidence(!ids.has(video.id), 'PROVIDER_INVENTORY_DUPLICATE');
      ids.add(video.id); videos.push(video);
    }
    if (!payload.has_more) return { complete: true, ids: [...ids], videos };
    requireEvidence(typeof payload.next_token === 'string' && payload.next_token.length > 0
      && payload.next_token.length <= 2048 && !tokens.has(payload.next_token), 'PROVIDER_PAGINATION_INVALID');
    token = payload.next_token; tokens.add(token);
  }
  requireEvidence(false, 'PROVIDER_INVENTORY_LIMIT');
}
async function getJson(url, headers) {
  const response = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  requireEvidence(response.ok, 'TRUSTED_SOURCE_HTTP_FAILED');
  const chunks = []; let bytes = 0;
  for await (const part of response.body) {
    bytes += part.length; requireEvidence(bytes <= 2 * 1024 * 1024, 'TRUSTED_SOURCE_BODY_LIMIT'); chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { requireEvidence(false, 'TRUSTED_SOURCE_JSON_INVALID'); }
}

export async function createLiveSources({ intent, env = process.env }) {
  for (const key of ['DATABASE_URL', 'HEYGEN_API_KEY', 'BLOB_READ_WRITE_TOKEN', 'VERCEL_TOKEN']) {
    requireEvidence(typeof env[key] === 'string' && env[key].length > 0, 'REQUIRED_CREDENTIAL_UNAVAILABLE');
  }
  const targetPath = new URL('../../config/database-target.production.json', import.meta.url).pathname;
  const targetInfo = await loadTargetManifest(targetPath, { requiredEnvironment: 'production' });
  validateTarget(env.DATABASE_URL, targetInfo.target, 'production');
  const lockInfo = await loadSchemaLock(targetPath, targetInfo.target);
  const bindingDigest = databaseBindingSha256({ environment: 'production', providerProjectId: targetInfo.target.projectId,
    providerBranchId: targetInfo.target.branchId, databaseName: targetInfo.target.database, applicationProjectId: intent.projectId });
  const { Pool, neonConfig } = await import('@neondatabase/serverless');
  neonConfig.webSocketConstructor = (await import('ws')).default;
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
  async function readOnly(callback) {
    const client = await pool.connect();
    try {
      await client.query('begin isolation level repeatable read read only');
      await client.query('set local search_path = public, pg_catalog');
      const identity = (await client.query('select current_database() as database, current_user as role')).rows[0];
      requireEvidence(identity.database === targetInfo.target.database && targetInfo.target.roles.includes(identity.role), 'DATABASE_IDENTITY_MISMATCH');
      return await callback(client);
    } finally { await client.query('rollback').catch(() => {}); client.release(); }
  }
  function vercel(path) {
    const url = new URL(path, 'https://api.vercel.com');
    if (env.VERCEL_TEAM_ID) url.searchParams.set('teamId', env.VERCEL_TEAM_ID);
    return getJson(url, { Authorization: `Bearer ${env.VERCEL_TOKEN}`, Accept: 'application/json' });
  }
  const providerGet = url => getJson(url, { 'X-Api-Key': env.HEYGEN_API_KEY, Accept: 'application/json' });
  let qualification;
  return {
    async candidate() {
      const alias = await vercel(`/v4/aliases/${encodeURIComponent(new URL(intent.origin).hostname)}`);
      const deployment = await vercel(`/v13/deployments/${encodeURIComponent(intent.deploymentId)}`);
      requireEvidence(!alias.redirect && !alias.deletedAt && alias.alias === new URL(intent.origin).hostname
        && alias.deploymentId === intent.deploymentId && alias.projectId === intent.projectId, 'ALIAS_BINDING_MISMATCH');
      return { origin: intent.origin, deploymentId: deployment.id, projectId: deployment.projectId,
        gitSha: deployment.meta?.githubCommitSha || deployment.meta?.gitCommitSha,
        state: deployment.readyState, target: deployment.target,
        sourceByteAttested: false };
    },
    async verifyDatabase() {
      return checkDatabaseMigrations(env.DATABASE_URL, { ...targetInfo, ...lockInfo, requiredEnvironment: 'production' });
    },
    async verifyBinding(accountId, expected) {
      qualification = await qualifyHeygenCredential({ apiKey: env.HEYGEN_API_KEY });
      requireEvidence(qualification.publicSummary.credentialStatus === 'active'
        && qualification.publicSummary.permissions.videos.read === true, 'PROVIDER_CREDENTIAL_UNQUALIFIED');
      const anchor = await loadPinnedHeygenSpaceAnchorProjection();
      const proof = validateFreshHeygenQualification(anchor, qualification);
      const bindings = await readOnly(async client => rows(await client.query(
        `select * from provider_account_bindings where application_account_id=$1 and provider='heygen'
         and environment='production' and project_id=$2 and lifecycle_state='active' and revoked_at is null`, [accountId, intent.projectId])));
      requireEvidence(bindings.length === 1 && bindings[0].databaseBindingSha256 === bindingDigest
        && bindings[0].credentialScopeFingerprint === qualification.credentialScopeFingerprint
        && (!expected || expected.id === bindings[0].id), 'LIVE_PROVIDER_BINDING_MISMATCH');
      const evidencePrefix = `heygen-space-anchor-evidence/v1/${proof.probeResultSha256}`;
      requireEvidence(bindings[0].credentialEvidenceDigest === proof.preflightEvidenceSha256
        && bindings[0].credentialEvidenceRef === `${evidencePrefix}/preflight.json`, 'BINDING_EVIDENCE_MISMATCH');
      await readOnly(async client => {
        const promotions = rows(await client.query('select * from provider_account_binding_promotions where binding_id=$1', [bindings[0].id]));
        requireEvidence(promotions.length === 1, 'BINDING_PROMOTION_MISMATCH');
        const promotion = promotions[0];
        const scopes = rows(await client.query('select * from provider_verified_account_scopes where id=$1', [promotion.verifiedAccountScopeId]));
        requireEvidence(scopes.length === 1 && scopes[0].provider === 'heygen'
          && scopes[0].providerAccountFingerprint === proof.providerSpaceFingerprint && scopes[0].canonicalScopeKey === proof.canonicalScopeKey
          && scopes[0].evidenceDigest === proof.spaceProofSha256 && scopes[0].evidenceRef === `${evidencePrefix}/space-proof.json` && promotion.state === 'verified' && !promotion.revokedAt
          && promotion.applicationAccountId === accountId && promotion.originScopeKey === bindings[0].originScopeKey
          && promotion.evidenceDigest === proof.identityDigest && promotion.evidenceRef === `${evidencePrefix}/identity-proof.json`
          && promotion.observedAt === (proof.originSpaceObservedAt || proof.spaceObservedAt)
          && Date.parse(promotion.verifiedAt) >= Date.parse(promotion.observedAt), 'BINDING_PROMOTION_MISMATCH');
      });
      assertFreshHeygenSpaceProof(proof);
      return { bindingId: bindings[0].id, credentialScopeFingerprint: qualification.credentialScopeFingerprint,
        providerSpaceFingerprint: proof.providerSpaceFingerprint, canonicalScopeKey: proof.canonicalScopeKey, qualifiedAt: proof.qualifiedAt }; 
    },
    async beginProof() {
      return readOnly(async client => camel((await client.query('select gen_random_uuid()::text as proof_id, clock_timestamp() as started_at')).rows[0]));
    },
    async providerInventory() { return readAllProviderVideos(providerGet); },
    async providerJob(id) {
      requireEvidence(/^[A-Za-z0-9_.:-]{1,255}$/.test(id), 'PROVIDER_ID_INVALID');
      const payload = await providerGet(new URL(`/v3/videos/${encodeURIComponent(id)}`, 'https://api.heygen.com'));
      return normalizeVideo(payload.data);
    },
    async jobSnapshot(jobId) {
      return readOnly(async client => {
        const jobs = rows(await client.query('select * from video_jobs where id=$1', [jobId]));
        requireEvidence(jobs.length === 1, 'JOB_NOT_FOUND');
        const job = jobs[0];
        // No LIMIT or clipped log window: inspect the complete job/correlation graph.
        const events = rows(await client.query('select * from job_events where job_id=$1 or correlation_id=$2 order by created_at,id', [jobId, job.correlationId]));
        const debits = rows(await client.query("select * from credit_transactions where source_id=$1 or metadata->>'jobId'=$2 order by created_at,id", [`render:${jobId}`, jobId]));
        const finals = rows(await client.query("select * from media_assets where job_id=$1 and kind='final' order by created_at,id", [jobId]));
        const operations = rows(await client.query("select * from provider_lifecycle_operations where kind='video_create' and (job_id=$1 or correlation_id=$2) order by created_at,id", [jobId, job.correlationId]));
        const resources = rows(await client.query("select r.* from provider_resources r join provider_lifecycle_operations o on r.origin_operation_id=o.id where r.kind='video' and (o.job_id=$1 or o.correlation_id=$2) order by r.created_at,r.id", [jobId, job.correlationId]));
        const bindings = operations.length ? rows(await client.query('select * from provider_account_bindings where id=$1', [operations[0].bindingId])) : [];
        return { job, events, debits, finals, operations, resources, binding: bindings[0] || null };
      });
    },
    async privateArtifact(artifact) {
      requireEvidence(typeof artifact.privatePathname === 'string' && artifact.privatePathname.startsWith('video-os/finals/')
        && !artifact.privatePathname.includes('..') && !/[\\?#\s]/.test(artifact.privatePathname)
        && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && artifact.bytes <= MAX_BYTES, 'PRIVATE_ARTIFACT_INVALID');
      const { get } = await import('@vercel/blob');
      const result = await get(artifact.privatePathname, { access: 'private', useCache: false, token: env.BLOB_READ_WRITE_TOKEN, abortSignal: AbortSignal.timeout(60_000) });
      requireEvidence(result?.statusCode === 200 && result.stream && result.blob?.pathname === artifact.privatePathname, 'PRIVATE_ARTIFACT_UNAVAILABLE');
      const privateUrl = new URL(result.blob.url);
      requireEvidence(privateUrl.protocol === 'https:' && /^[a-z0-9-]+\.private\.blob\.vercel-storage\.com$/.test(privateUrl.hostname)
        && decodeURIComponent(privateUrl.pathname.slice(1)) === artifact.privatePathname
        && !privateUrl.search && !privateUrl.hash && !privateUrl.username && !privateUrl.password, 'PRIVATE_BLOB_URL_INVALID');
      const chunks = []; let count = 0;
      try {
        for await (const chunk of result.stream) {
          count += chunk.length; requireEvidence(count <= artifact.bytes && count <= MAX_BYTES, 'PRIVATE_ARTIFACT_BYTE_LIMIT'); chunks.push(Buffer.from(chunk));
        }
      } finally { result.stream.destroy?.(); }
      const bytes = Buffer.concat(chunks);
      requireEvidence(count === artifact.bytes && sha256(bytes) === artifact.sha256, 'PRIVATE_ARTIFACT_HASH_MISMATCH');
      const temp = await mkdtemp(join(tmpdir(), 'p0-media-')); await chmod(temp, 0o700);
      try {
        const file = join(temp, 'final.mp4'); await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
        const { inspectMedia } = await import('../../services/final-media-validation.js');
        return { bytes: count, sha256: sha256(bytes), media: await inspectMedia(file), privateUrl: privateUrl.href };
      } finally { await rm(temp, { recursive: true, force: true }); }
    },
    async close() { await pool.end(); },
  };
}
