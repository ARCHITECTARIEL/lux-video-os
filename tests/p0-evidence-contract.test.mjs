import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import {
  evaluateP0EvidenceBundle,
  P0_EVIDENCE_CANDIDATE_VERSION,
  P0_OBSERVATION_CONTRACTS,
  P0_OBSERVATION_VERSION,
  P0_STRUCTURALLY_COMPLETE_UNAUTHENTICATED,
  P0EvidenceError,
} from '../tools/p0-evidence/contract.mjs';
import {
  INCOMPLETE_EXIT_CODE,
  UNAUTHENTICATED_EXIT_CODE,
  runCli,
} from '../tools/p0-evidence/check-candidate.mjs';
import { verifyOfflineP0Candidate } from '../tools/p0-evidence/verify-offline-candidate.mjs';

const STARTED = '2026-10-11T14:00:00.000Z';
const CAPTURED = '2026-10-11T14:04:00.000Z';
const COMPLETED = '2026-10-11T14:10:00.000Z';

function digest(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

function proof() {
  return {
    proofId: '11111111-1111-4111-8111-111111111111',
    correlationId: 'corr-server-12345',
    jobId: 'job-server-12345',
    providerJobId: 'provider-job-12345',
    accountHash: 'a'.repeat(24),
    deploymentIdHash: digest('deployment'),
    sourceCommitHash: digest('source'),
    finalPathDigest: digest('private-final-path'),
    directBlobTargetDigest: digest('direct-private-object-target'),
    preflightProviderJobIdsDigest: digest('provider-preflight'),
    title: 'P0-PROOF-2026-10-11T14:00:00.000Z-abc12345',
    startedAt: STARTED,
    completedAt: COMPLETED,
  };
}

function syntheticMedia() {
  return {
    stored: {
      sha256: digest('final-media'),
      bytes: 1234,
      fullDecode: true,
      videoStreams: 1,
      audioStreams: 1,
      directBlobTargetDigest: digest('direct-private-object-target'),
    },
    download: {
      sha256: digest('final-media'),
      bytes: 1234,
      fullDecode: true,
      videoStreams: 1,
      audioStreams: 1,
    },
  };
}

function factsFor(id, binding, media) {
  if (id === 1) return {
    httpStatus: 200,
    authenticatedAccountHash: binding.accountHash,
    sessionIdDigest: digest('primary-session'),
    contextIdDigest: digest('primary-context'),
  };
  if (id === 2) return {
    preflightProviderJobIdsDigest: binding.preflightProviderJobIdsDigest,
    preflightProviderJobCount: 12,
    preflightContainsProofProviderJob: false,
    preflightPaginationComplete: true,
    providerNativeStatus: 'completed',
    appSubmissionEventCount: 1,
    providerMarkerMatchCount: 1,
    providerMarkerTitleDigest: digest(binding.title),
    providerSubmittedAt: '2026-10-11T14:02:00.000Z',
    providerCompletedAt: '2026-10-11T14:03:00.000Z',
  };
  if (id === 3) return {
    privatePathDigest: binding.finalPathDigest,
    directBlobTargetDigest: binding.directBlobTargetDigest,
    storedSha256: media.stored.sha256,
    storedBytes: media.stored.bytes,
    fullDecode: true,
    videoStreams: 1,
    audioStreams: 1,
  };
  if (id === 4) return {
    httpStatus: 200,
    historyMatchCount: 1,
    historyJobStatus: 'ready',
    outputAccepted: true,
    historyTitleDigest: digest(binding.title),
    sessionIdDigest: digest('primary-session'),
    contextIdDigest: digest('primary-context'),
  };
  if (id === 5) return {
    httpStatus: 200,
    authenticatedAccountHash: binding.accountHash,
    sessionIdDigest: digest('fresh-session'),
    contextIdDigest: digest('fresh-context'),
    sessionIssuedAt: '2026-10-11T14:03:30.000Z',
  };
  if (id === 6) return {
    httpStatus: 200,
    historyMatchCount: 1,
    historyJobStatus: 'ready',
    outputAccepted: true,
    historyTitleDigest: digest(binding.title),
    sessionIdDigest: digest('fresh-session'),
    contextIdDigest: digest('fresh-context'),
    storageRepairRequestCount: 0,
    routeReplayRequestCount: 0,
    networkTraceDigest: digest('fresh-network-trace'),
  };
  if (id === 7) return {
    httpStatus: 200,
    contentType: 'video/mp4',
    downloadedSha256: media.download.sha256,
    downloadedBytes: media.download.bytes,
  };
  if (id === 8) return {
    anonymousHttpStatus: 401,
    wrongAccountHttpStatus: 404,
    wrongAccountHash: 'b'.repeat(24),
    directBlobHttpStatus: 403,
    privateObjectPathDigest: binding.finalPathDigest,
    directRequestTargetDigest: binding.directBlobTargetDigest,
  };
  return {
    appProviderSubmissionCount: 1,
    providerNativeCreateCount: 1,
    creditDebitCount: 1,
    finalArtifactEventCount: 1,
    finalAssetCount: 1,
    repairEventCount: 0,
    correlationMismatchCount: 0,
    jobCostCredits: 90,
    creditDebitAmount: -90,
    finalSha256: media.stored.sha256,
    finalBytes: media.stored.bytes,
    privatePathDigest: binding.finalPathDigest,
  };
}

function bundle(media = syntheticMedia()) {
  const binding = proof();
  const observationBinding = Object.fromEntries(
    ['proofId', 'correlationId', 'jobId', 'providerJobId', 'accountHash', 'deploymentIdHash', 'sourceCommitHash']
      .map((key) => [key, binding[key]]),
  );
  return {
    version: P0_EVIDENCE_CANDIDATE_VERSION,
    proof: binding,
    observations: P0_OBSERVATION_CONTRACTS.map((contract) => ({
      version: P0_OBSERVATION_VERSION,
      observation: contract.id,
      key: contract.key,
      capturedAt: CAPTURED,
      binding: { ...observationBinding },
      probes: contract.sources.map((source) => ({
        source,
        method: 'direct',
        observedAt: CAPTURED,
        evidenceSha256: digest('probe-' + contract.id + '-' + source),
      })),
      facts: factsFor(contract.id, binding, media),
    })),
  };
}

function expectCode(fn, code, observation = null) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof P0EvidenceError);
    assert.equal(error.code, code);
    if (observation !== null) assert.equal(error.observation, observation);
    return true;
  });
}

test('complete correlated claims remain structurally complete and unauthenticated', () => {
  const result = evaluateP0EvidenceBundle(bundle(), syntheticMedia());
  assert.equal(result.status, P0_STRUCTURALLY_COMPLETE_UNAUTHENTICATED);
  assert.equal(result.observationClaimsPresent, 9);
  assert.equal(result.observationsAuthenticated, false);
  assert.equal(result.releaseGateCleared, false);
  assert.equal(result.nextRequiredAction, 'authenticate_live_sources_and_independent_review');
});

test('missing evidence and self-asserted approval labels fail closed', () => {
  const missing = bundle();
  missing.observations.pop();
  expectCode(() => evaluateP0EvidenceBundle(missing, syntheticMedia()), 'OBSERVATION_SET_MISMATCH');

  const asserted = bundle();
  asserted.observations[0].signoff = { status: 'APPROVED' };
  expectCode(() => evaluateP0EvidenceBundle(asserted, syntheticMedia()), 'SELF_ASSERTED_STATUS');

  const nonV4 = bundle();
  nonV4.proof.proofId = '11111111-1111-1111-8111-111111111111';
  for (const observation of nonV4.observations) observation.binding.proofId = nonV4.proof.proofId;
  expectCode(() => evaluateP0EvidenceBundle(nonV4, syntheticMedia()), 'INVALID_BINDING');
});

test('raw URLs, query strings, and credential-bearing evidence are rejected', () => {
  const rawUrl = bundle();
  rawUrl.observations[0].facts.debug = 'https://private.invalid/final.mp4?token=secret';
  expectCode(() => evaluateP0EvidenceBundle(rawUrl, syntheticMedia()), 'SENSITIVE_VALUE');

  const credential = bundle();
  credential.observations[0].facts.debug = 'Bearer private-secret';
  expectCode(() => evaluateP0EvidenceBundle(credential, syntheticMedia()), 'SENSITIVE_VALUE');

  for (const key of ['userEmail', 'accessToken', 'requestUrl']) {
    const variant = bundle();
    variant.observations[0].probes[0][key] = 'redacted';
    expectCode(() => evaluateP0EvidenceBundle(variant, syntheticMedia()), 'SENSITIVE_FIELD');
  }
});

test('unknown manifest, observation, fact, and probe keys are rejected', () => {
  for (const mutate of [
    (candidate) => { candidate.unexpected = true; },
    (candidate) => { candidate.proof.unexpected = true; },
    (candidate) => { candidate.observations[0].unexpected = true; },
    (candidate) => { candidate.observations[0].binding.unexpected = true; },
    (candidate) => { candidate.observations[0].facts.unexpected = true; },
    (candidate) => { candidate.observations[0].probes[0].unexpected = true; },
  ]) {
    const candidate = bundle();
    mutate(candidate);
    expectCode(() => evaluateP0EvidenceBundle(candidate, syntheticMedia()), 'UNKNOWN_KEY');
  }
});

test('fresh session must use a distinct context and newly issued session', () => {
  const candidate = bundle();
  candidate.observations[4].facts.sessionIdDigest = digest('primary-session');
  expectCode(() => evaluateP0EvidenceBundle(candidate, syntheticMedia()), 'FRESH_SESSION_REUSED', 5);
});

test('anonymous, wrong-account, and direct Blob denial results are exact', () => {
  const candidate = bundle();
  candidate.observations[7].facts.wrongAccountHttpStatus = 401;
  expectCode(() => evaluateP0EvidenceBundle(candidate, syntheticMedia()), 'CROSS_ACCOUNT_DOWNLOAD_ESCAPE', 8);

  const publicBlob = bundle();
  publicBlob.observations[7].facts.directBlobHttpStatus = 200;
  expectCode(() => evaluateP0EvidenceBundle(publicBlob, syntheticMedia()), 'DIRECT_BLOB_ESCAPE', 8);

  const wrongTarget = bundle();
  wrongTarget.observations[7].facts.directRequestTargetDigest = digest('another-direct-target');
  expectCode(() => evaluateP0EvidenceBundle(wrongTarget, syntheticMedia()), 'DIRECT_BLOB_TARGET_MISMATCH', 8);
});

test('duplicate submission, debit, or final evidence fails cardinality', () => {
  for (const [field, code] of [
    ['appProviderSubmissionCount', 'SUBMISSION_CARDINALITY'],
    ['creditDebitCount', 'DEBIT_CARDINALITY'],
    ['finalArtifactEventCount', 'FINAL_EVENT_CARDINALITY'],
  ]) {
    const candidate = bundle();
    candidate.observations[8].facts[field] = 2;
    expectCode(() => evaluateP0EvidenceBundle(candidate, syntheticMedia()), code, 9);
  }
});

function createFixtureMedia(filename) {
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x14213d:s=320x240:r=5:d=0.8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=0.8',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '32k', '-shortest', '-movflags', '+faststart',
    filename,
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, String(result.stderr).slice(-500));
}

async function writeCandidate(root) {
  await mkdir(path.join(root, 'observations'), { recursive: true });
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  const storedPath = path.join(root, 'artifacts', 'private-stored-final.mp4');
  const downloadPath = path.join(root, 'artifacts', 'authorized-customer-download.mp4');
  createFixtureMedia(storedPath);
  await copyFile(storedPath, downloadPath);
  const storedBytes = await readFile(storedPath);
  const media = {
    stored: { sha256: digest(storedBytes), bytes: storedBytes.length, fullDecode: true, videoStreams: 1, audioStreams: 1 },
    download: { sha256: digest(storedBytes), bytes: storedBytes.length, fullDecode: true, videoStreams: 1, audioStreams: 1 },
  };
  const candidate = bundle(media);
  const observationDescriptors = [];
  for (const observation of candidate.observations) {
    const name = String(observation.observation).padStart(2, '0') + '.json';
    const relative = 'observations/' + name;
    const bytes = Buffer.from(JSON.stringify(observation));
    await writeFile(path.join(root, relative), bytes);
    observationDescriptors.push({ id: observation.observation, path: relative, sha256: digest(bytes) });
  }
  const manifest = {
    version: candidate.version,
    proof: candidate.proof,
    observations: observationDescriptors,
    artifacts: {
      storedFinal: {
        path: 'artifacts/private-stored-final.mp4',
        sha256: media.stored.sha256,
        bytes: media.stored.bytes,
        directBlobTargetDigest: candidate.proof.directBlobTargetDigest,
      },
      authorizedDownload: { path: 'artifacts/authorized-customer-download.mp4', sha256: media.download.sha256, bytes: media.download.bytes },
    },
  };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

test('offline checker validates separate regular MP4 files but cannot authenticate their capture provenance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p0-evidence-complete-'));
  try {
    await writeCandidate(root);
    const before = (await readdir(root, { recursive: true })).sort();
    const result = await verifyOfflineP0Candidate(root);
    assert.equal(result.status, P0_STRUCTURALLY_COMPLETE_UNAUTHENTICATED);
    assert.equal(result.observationsAuthenticated, false);
    assert.equal(result.releaseGateCleared, false);
    assert.match(result.candidateSha256, /^[a-f0-9]{64}$/u);

    let stdout = '';
    let stderr = '';
    const exitCode = await runCli(['--run-dir', root], {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    });
    assert.equal(exitCode, UNAUTHENTICATED_EXIT_CODE);
    assert.match(stdout, /STRUCTURALLY_COMPLETE_UNAUTHENTICATED/);
    assert.match(stdout, /claimsPresent=9/);
    assert.match(stdout, /authenticated=false/);
    assert.match(stdout, /releaseGateCleared=false/);
    assert.equal(stderr, '');
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('altered observation bytes and unsafe artifact paths fail before review', async () => {
  const altered = await mkdtemp(path.join(os.tmpdir(), 'p0-evidence-altered-'));
  try {
    await writeCandidate(altered);
    await writeFile(path.join(altered, 'observations', '04.json'), '{tampered:true}');
    await assert.rejects(verifyOfflineP0Candidate(altered), (error) => {
      assert.equal(error.code, 'EVIDENCE_HASH_MISMATCH');
      return true;
    });
  } finally {
    await rm(altered, { recursive: true, force: true });
  }

  const unsafe = await mkdtemp(path.join(os.tmpdir(), 'p0-evidence-unsafe-'));
  try {
    const manifest = await writeCandidate(unsafe);
    manifest.artifacts.storedFinal.path = '../outside.mp4';
    await writeFile(path.join(unsafe, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyOfflineP0Candidate(unsafe), (error) => {
      assert.equal(error.code, 'UNSAFE_PATH');
      return true;
    });
  } finally {
    await rm(unsafe, { recursive: true, force: true });
  }
});

test('offline manifest allowlists and exact Blob target binding fail closed', async () => {
  const unknown = await mkdtemp(path.join(os.tmpdir(), 'p0-evidence-unknown-'));
  try {
    const manifest = await writeCandidate(unknown);
    manifest.unexpected = true;
    await writeFile(path.join(unknown, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyOfflineP0Candidate(unknown), (error) => {
      assert.equal(error.code, 'UNKNOWN_KEY');
      return true;
    });
  } finally {
    await rm(unknown, { recursive: true, force: true });
  }

  const sensitiveDescriptor = await mkdtemp(path.join(os.tmpdir(), 'p0-evidence-sensitive-'));
  try {
    const manifest = await writeCandidate(sensitiveDescriptor);
    manifest.artifacts.storedFinal.requestUrl = 'redacted';
    await writeFile(path.join(sensitiveDescriptor, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyOfflineP0Candidate(sensitiveDescriptor), (error) => {
      assert.equal(error.code, 'SENSITIVE_FIELD');
      return true;
    });
  } finally {
    await rm(sensitiveDescriptor, { recursive: true, force: true });
  }

  const targetMismatch = await mkdtemp(path.join(os.tmpdir(), 'p0-evidence-target-'));
  try {
    const manifest = await writeCandidate(targetMismatch);
    manifest.artifacts.storedFinal.directBlobTargetDigest = digest('wrong-direct-target');
    await writeFile(path.join(targetMismatch, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyOfflineP0Candidate(targetMismatch), (error) => {
      assert.equal(error.code, 'DIRECT_BLOB_TARGET_MISMATCH');
      return true;
    });
  } finally {
    await rm(targetMismatch, { recursive: true, force: true });
  }
});

test('offline checker requires canonical evidence filenames without echoing rejected paths', async () => {
  for (const mutate of [
    (manifest) => { manifest.observations[0].path = 'observations/owner@example.invalid.json'; },
    (manifest) => { manifest.artifacts.storedFinal.path = 'artifacts/account-123-final.mp4'; },
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'p0-evidence-path-'));
    try {
      const manifest = await writeCandidate(root);
      mutate(manifest);
      await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
      await assert.rejects(verifyOfflineP0Candidate(root), (error) => {
        assert.equal(error.code, 'NONCANONICAL_EVIDENCE_PATH');
        assert.doesNotMatch(error.message, /owner@example|account-123/u);
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('CLI hides private paths and identifiers on incomplete input', async () => {
  let stdout = '';
  let stderr = '';
  const secretPath = 'C:\\private\\owner-sensitive-proof';
  const exitCode = await runCli(['--run-dir', secretPath], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  assert.equal(exitCode, INCOMPLETE_EXIT_CODE);
  assert.equal(stdout, '');
  assert.match(stderr, /INCOMPLETE/);
  assert.match(stderr, /releaseGateCleared=false/);
  assert.doesNotMatch(stderr, /owner-sensitive-proof|C:\\private/u);
});
