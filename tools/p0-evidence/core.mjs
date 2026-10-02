// Collection is not release authorization. This module has no receipt-import path.
import { createHash } from 'node:crypto';
import { acceptedJobOutput } from '../../lib/video-os-output-acceptance.js';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const accountHash = value => sha256(String(value)).slice(0, 24);
export const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const evidenceDigest = value => sha256(JSON.stringify(canonical(value)));
export function requireEvidence(condition, code) {
  if (!condition) throw Object.assign(new Error(`P0 collection stopped: ${code}. No release approval was issued.`), { code });
}
const text = value => typeof value === 'string' && value.length > 0;
const time = value => new Date(value).getTime();
const hash = value => /^[a-f0-9]{64}$/.test(value || '');

export function checkCandidate(value, expected) {
  requireEvidence(value?.origin === expected.origin && value.deploymentId === expected.deploymentId
    && value.projectId === expected.projectId && value.gitSha === expected.gitSha
    && value.state === 'READY' && value.target === 'production', 'CANDIDATE_MISMATCH');
}
export function checkSession(value, { sameAccount, differentAccount, differentSession } = {}) {
  requireEvidence(value?.signedIn === true && text(value.accountId) && hash(value.sessionSha256)
    && value.emptyContext === true && value.issuanceObserved === true && text(value.contextId), 'SESSION_UNVERIFIED');
  if (sameAccount) requireEvidence(value.accountId === sameAccount.accountId, 'RECOVERY_ACCOUNT_MISMATCH');
  if (differentAccount) requireEvidence(value.accountId !== differentAccount.accountId, 'WRONG_ACCOUNT_REQUIRED');
  if (differentSession) requireEvidence(value.sessionSha256 !== differentSession.sessionSha256
    && value.contextId !== differentSession.contextId, 'FRESH_SESSION_REQUIRED');
}
export function checkLedger(snapshot, { accountId, jobId, correlationId, providerJobId, title, startedAt, maxCredits }) {
  const job = snapshot?.job;
  requireEvidence(job && job.id === jobId && job.accountId === accountId && job.correlationId === correlationId
    && job.provider === 'heygen' && job.providerJobId === providerJobId && job.title === title
    && time(job.createdAt) >= time(startedAt) && job.status === 'ready' && !job.videoDeletedAt
    && Number.isSafeInteger(job.costCredits) && job.costCredits > 0 && job.costCredits <= maxCredits, 'JOB_BINDING_MISMATCH');
  requireEvidence(acceptedJobOutput(job), 'FINAL_NOT_ACCEPTED');
  const events = snapshot.events;
  requireEvidence(Array.isArray(events) && events.every(event => event.jobId === jobId && event.correlationId === correlationId
    && time(event.createdAt) >= time(startedAt)), 'EVENT_CORRELATION_MISMATCH');
  requireEvidence(events.filter(e => e.eventType === 'render.reserved').length === 1
    && events.filter(e => e.eventType === 'provider.submitted').length === 1
    && events.filter(e => e.eventType === 'finish.completed').length === 1, 'EVENT_COUNT_MISMATCH');
  requireEvidence(!events.some(e => /recovery|retry|repair|admin|failed|unknown|conflict/.test(e.eventType)), 'REPAIRED_OR_AMBIGUOUS_JOB');
  const submitted = events.find(e => e.eventType === 'provider.submitted');
  requireEvidence(submitted.stageTo === 'provider_submitted'
    && (!submitted.details?.providerJobId || submitted.details.providerJobId === providerJobId), 'SUBMISSION_EVENT_MISMATCH');
  const final = events.find(e => e.eventType === 'finish.completed');
  requireEvidence(final.details?.sha256 === job.output.sha256 && final.details?.bytes === job.output.bytes, 'FINAL_EVENT_MISMATCH');
  const debits = snapshot.debits;
  requireEvidence(Array.isArray(debits) && debits.length === 1 && debits[0].accountId === accountId
    && debits[0].sourceType === 'render' && debits[0].sourceId === `render:${jobId}`
    && debits[0].amount === -job.costCredits && debits[0].metadata?.jobId === jobId, 'DEBIT_MISMATCH');
  const finals = snapshot.finals;
  requireEvidence(Array.isArray(finals) && finals.length === 1 && finals[0].accountId === accountId
    && finals[0].jobId === jobId && finals[0].privatePathname === job.output.privatePathname
    && finals[0].sha256 === job.output.sha256 && finals[0].bytes === job.output.bytes, 'FINAL_ROW_MISMATCH');
  const operations = snapshot.operations;
  requireEvidence(Array.isArray(operations) && operations.length === 1 && operations[0].kind === 'video_create'
    && operations[0].applicationAccountId === accountId && operations[0].jobId === jobId
    && operations[0].correlationId === correlationId && operations[0].originOperationKey === jobId && operations[0].attempt === 1
    && operations[0].state === 'succeeded' && time(operations[0].submittedAt) >= time(startedAt), 'PROVIDER_OPERATION_MISMATCH');
  requireEvidence(snapshot.resources?.length === 1 && snapshot.resources[0].providerResourceId === providerJobId
    && snapshot.resources[0].applicationAccountId === accountId && snapshot.resources[0].kind === 'video'
    && snapshot.resources[0].originOperationId === operations[0].id && snapshot.resources[0].bindingId === operations[0].bindingId
    && snapshot.resources[0].originScopeKey === operations[0].originScopeKey, 'PROVIDER_RESOURCE_MISMATCH');
  requireEvidence(snapshot.binding?.id === operations[0].bindingId && snapshot.binding.applicationAccountId === accountId
    && snapshot.binding.originScopeKey === operations[0].originScopeKey && snapshot.binding.lifecycleState === 'active'
    && !snapshot.binding.revokedAt && snapshot.binding.environment === 'production', 'PROVIDER_BINDING_MISMATCH');
  return job;
}

// Keep the hash preimage reviewable without retaining customer scripts, raw
// account IDs, cookies, tokens, private paths, URLs or arbitrary event details.
export function retainLedger(snapshot) {
  const pick = (row, keys) => Object.fromEntries(keys.filter(key => row?.[key] !== undefined).map(key => [key, row[key]]));
  const owned = (row, keys, owner = 'accountId') => ({ ...pick(row, keys), accountHash: accountHash(row?.[owner]) });
  return {
    job: { ...owned(snapshot.job, ['id', 'correlationId', 'provider', 'providerJobId', 'status', 'title', 'format', 'costCredits', 'createdAt', 'completedAt', 'videoDeletedAt']),
      output: { ...pick(snapshot.job.output, ['bytes', 'sha256']), pathnameSha256: sha256(snapshot.job.output?.privatePathname || ''),
        acceptance: { ...pick(snapshot.job.output?.acceptance, ['version', 'policy', 'status', 'validatorVersion', 'validatedAt', 'jobId', 'bytes', 'sha256']),
          accountHash: accountHash(snapshot.job.output?.acceptance?.accountId),
          pathnameSha256: sha256(snapshot.job.output?.acceptance?.privatePathname || ''),
          media: pick(snapshot.job.output?.acceptance?.media, ['fullDecode', 'videoStreams', 'audioStreams', 'width', 'height', 'durationMs']),
          checks: pick(snapshot.job.output?.acceptance?.checks, ['duration', 'dimensions', 'byteLimit']) } } },
    events: snapshot.events.map(row => ({ ...pick(row, ['id', 'jobId', 'correlationId', 'eventType', 'stageFrom', 'stageTo', 'failureCategory', 'createdAt']),
      details: pick(row.details, ['bytes', 'sha256', 'providerJobId', 'providerLifecycleOperationId', 'acceptancePolicy', 'validatorVersion']) })),
    debits: snapshot.debits.map(row => ({ ...owned(row, ['id', 'sourceType', 'sourceId', 'amount', 'balanceAfter', 'createdAt']), jobId: row.metadata?.jobId })),
    finals: snapshot.finals.map(row => ({ ...owned(row, ['id', 'jobId', 'kind', 'contentType', 'bytes', 'sha256', 'createdAt']), pathnameSha256: sha256(row.privatePathname) })),
    operations: snapshot.operations.map(row => owned(row, ['id', 'bindingId', 'originScopeKey', 'kind', 'state', 'originOperationKey', 'attempt', 'correlationId', 'jobId', 'requestDigest', 'submittedAt', 'completedAt', 'createdAt'], 'applicationAccountId')),
    resources: snapshot.resources.map(row => owned(row, ['id', 'bindingId', 'originScopeKey', 'verifiedAccountScopeId', 'kind', 'providerResourceId', 'originOperationId', 'state', 'createdAt', 'updatedAt'], 'applicationAccountId')),
    binding: owned(snapshot.binding, ['id', 'provider', 'environment', 'projectId', 'databaseBindingSha256', 'credentialScopeFingerprint', 'originScopeKey', 'credentialEvidenceDigest', 'lifecycleState', 'revokedAt', 'createdAt'], 'applicationAccountId'),
  };
}

// All adapters are instantiated in-process by the CLI, not loaded from user JSON/modules.
// Injection exists for offline tests; neither this result nor a passing fixture clears P0.
export async function collectEvidence({ browser, sources, writeEvidence, intent, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  requireEvidence(intent?.ownerAuthorized === true && Number.isSafeInteger(intent.maxCredits) && intent.maxCredits > 0, 'BOUNDED_AUTHORIZATION_REQUIRED');
  const candidate = await sources.candidate();
  checkCandidate(candidate, intent);
  const database = await sources.verifyDatabase();
  requireEvidence(database.verified === true && database.environment === 'production', 'DATABASE_UNVERIFIED');
  const original = await browser.signIn('original');
  checkSession(original);
  const providerBinding = await sources.verifyBinding(original.accountId);
  const inventory = await sources.providerInventory();
  requireEvidence(inventory.complete === true && Array.isArray(inventory.ids)
    && inventory.ids.every(text) && new Set(inventory.ids).size === inventory.ids.length, 'PROVIDER_PREFLIGHT_INCOMPLETE');
  const proof = await sources.beginProof();
  requireEvidence(/^[a-f0-9-]{36}$/.test(proof.proofId || '') && Number.isFinite(time(proof.startedAt))
    && Math.abs(now() - time(proof.startedAt)) < 60_000, 'SERVER_PROOF_UNVERIFIED');
  const title = `P0-PROOF-${new Date(proof.startedAt).toISOString().replace(/[^0-9TZ]/g, '')}-${proof.proofId}`;
  const journal = { version: 'p0-observations/v1', proofId: proof.proofId, startedAt: proof.startedAt,
    title, candidate, databaseEvidenceSha256: evidenceDigest(database), accountHash: accountHash(original.accountId),
    preflight: { count: inventory.ids.length, providerJobIdsSha256: evidenceDigest([...inventory.ids].sort()) },
    sourceEvidence: { candidateReads: [candidate], database, providerBinding, preflightProviderIds: [...inventory.ids].sort() },
    p0Cleared: false, releaseAuthorized: false, status: 'collecting', qualification: 'incomplete_release_evidence', observations: {} };
  await writeEvidence(journal); // Preserve recovery identity before the sole possible spend.
  let submitted = false;
  try {
    const beforeSubmitCandidate = await sources.candidate(); checkCandidate(beforeSubmitCandidate, intent);
    journal.sourceEvidence.candidateReads.push(beforeSubmitCandidate);
    const submission = await browser.submitExactlyOne({ title, maxCredits: intent.maxCredits, beforeSubmit: async () => {
      const lastCandidate = await sources.candidate(); checkCandidate(lastCandidate, intent);
      journal.sourceEvidence.candidateReads.push(lastCandidate);
      journal.sourceEvidence.beforeSubmitBinding = await sources.verifyBinding(original.accountId);
      await writeEvidence(journal);
    } });
    submitted = true;
    requireEvidence(submission.requestCount === 1 && submission.requestHadCorrelationHeader === false
      && text(submission.jobId) && text(submission.correlationId) && submission.recovered !== true, 'SUBMISSION_UNVERIFIED');
    journal.jobId = submission.jobId; journal.correlationId = submission.correlationId; journal.requestDigest = submission.requestDigest;
    journal.observations.session = { accountHash: journal.accountHash, sessionSha256: original.sessionSha256, contextId: original.contextId, issuanceObserved: true };
    await writeEvidence(journal);
    const deadline = now() + (intent.timeoutMs || 30 * 60_000);
    let snapshot, provider;
    while (true) {
      snapshot = await sources.jobSnapshot(submission.jobId);
      requireEvidence(snapshot.job?.accountId === original.accountId && snapshot.job.correlationId === submission.correlationId, 'JOB_BINDING_MISMATCH');
      requireEvidence(!['failed', 'provider_submit_unknown'].includes(snapshot.job.status), 'JOB_FAILED_OR_AMBIGUOUS');
      if (snapshot.job.providerJobId) {
        requireEvidence(!inventory.ids.includes(snapshot.job.providerJobId), 'PROVIDER_JOB_NOT_NEW');
        provider = await sources.providerJob(snapshot.job.providerJobId);
        requireEvidence(provider.id === snapshot.job.providerJobId && provider.title === title
          && time(provider.createdAt) >= time(proof.startedAt), 'PROVIDER_JOB_BINDING_MISMATCH');
        requireEvidence(!['failed', 'error'].includes(provider.status), 'PROVIDER_JOB_FAILED');
      }
      if (snapshot.job.status === 'ready' && provider?.status === 'completed') break;
      requireEvidence(now() < deadline, 'OBSERVATION_TIMEOUT_NO_RESUBMISSION');
      await sleep(Math.min(15_000, deadline - now()));
    }
    const binding = { accountId: original.accountId, ...submission, providerJobId: provider.id, title, startedAt: proof.startedAt, maxCredits: intent.maxCredits };
    const job = checkLedger(snapshot, binding);
    journal.sourceEvidence.ledger = retainLedger(snapshot);
    journal.sourceEvidence.providerJob = provider;
    await writeEvidence(journal);
    journal.sourceEvidence.finalProviderBinding = await sources.verifyBinding(original.accountId, snapshot.binding);
    const artifact = await sources.privateArtifact(job.output);
    requireEvidence(artifact.bytes === job.output.bytes && artifact.sha256 === job.output.sha256
      && artifact.media?.fullDecode === true && artifact.media.videoStreams === 1 && artifact.media.audioStreams === 1
      && artifact.media.sha256 === artifact.sha256 && artifact.media.bytes === artifact.bytes, 'PRIVATE_ARTIFACT_MISMATCH');
    const originalHistory = await browser.galleryDownload(original, job);
    requireEvidence(originalHistory.sha256 === artifact.sha256 && originalHistory.bytes === artifact.bytes
      && originalHistory.galleryRecovered === true, 'ORIGINAL_GALLERY_MISMATCH');
    await browser.closeSession(original);
    const fresh = await browser.signIn('recovery');
    checkSession(fresh, { sameAccount: original, differentSession: original });
    const recovery = await browser.galleryDownload(fresh, job);
    requireEvidence(recovery.galleryRecovered === true && recovery.sha256 === artifact.sha256
      && recovery.bytes === artifact.bytes, 'RECOVERY_DOWNLOAD_MISMATCH');
    const wrong = await browser.signIn('wrong-account');
    checkSession(wrong, { differentAccount: original, differentSession: fresh });
    const denials = await browser.denials({ wrong, jobId: job.id, privateUrl: artifact.privateUrl });
    requireEvidence(denials.anonymous === 401 && denials.wrongAccount === 404
      && [401, 403, 404].includes(denials.privateBlob), 'DOWNLOAD_DENIAL_FAILED');
    // Re-read after browser observations, detecting late duplicate/repair or alias drift.
    const finalSnapshot = await sources.jobSnapshot(job.id);
    checkLedger(finalSnapshot, binding);
    requireEvidence(evidenceDigest(finalSnapshot) === evidenceDigest(snapshot), 'LEDGER_CHANGED_DURING_RECOVERY');
    const finalCandidate = await sources.candidate(); checkCandidate(finalCandidate, intent);
    journal.sourceEvidence.candidateReads.push(finalCandidate);
    const endingInventory = await sources.providerInventory();
    requireEvidence(endingInventory.complete === true && endingInventory.ids.includes(provider.id)
      && endingInventory.videos.filter(v => v.title === title).length === 1, 'PROVIDER_SUBMISSION_COUNT_MISMATCH');
    journal.sourceEvidence.finalProviderInventory = { complete: true, ids: endingInventory.ids,
      videos: endingInventory.videos.map(video => ({ id: video.id, titleSha256: sha256(video.title), ...video.title === title ? { proofTitle: title } : {} })) };
    journal.sourceEvidence.wrongAccount = { accountHash: accountHash(wrong.accountId), sessionSha256: wrong.sessionSha256, contextId: wrong.contextId, issuanceObserved: true };
    journal.sourceEvidence.finalLedger = retainLedger(finalSnapshot);
    await browser.assertSingleSubmission();
    journal.providerJobId = provider.id;
    journal.status = 'collected_requires_independent_review';
    journal.observations = { ...journal.observations,
      provider: { id: provider.id, status: provider.status, createdAt: provider.createdAt },
      privateArtifact: { pathnameSha256: sha256(job.output.privatePathname), bytes: artifact.bytes, sha256: artifact.sha256, media: artifact.media },
      originalHistory, freshSession: { accountHash: accountHash(fresh.accountId), sessionSha256: fresh.sessionSha256, contextId: fresh.contextId, issuanceObserved: true },
      recovery, denials, ledger: { snapshotSha256: evidenceDigest(journal.sourceEvidence.ledger), submissions: 1, debits: 1, finals: 1, creditCost: job.costCredits,
        bindingId: snapshot.binding.id, originScopeKey: snapshot.binding.originScopeKey } };
    journal.unresolvedGates = ['independent_source_byte_attestation', 'deployed_configuration_attestation', 'legacy_public_storage_migration', 'independent_observation_review_and_private_canonical_signoff'];
    journal.completedAt = new Date(now()).toISOString();
    await writeEvidence(journal);
    return { evidenceSha256: evidenceDigest(journal), p0Cleared: false, releaseAuthorized: false, status: journal.status };
  } catch (error) {
    journal.status = 'incomplete';
    journal.failureCode = /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'COLLECTION_FAILED';
    journal.submissionMayHaveOccurred = submitted || await browser.submissionMayHaveOccurred();
    await writeEvidence(journal);
    throw error;
  } finally { await browser.close(); }
}
