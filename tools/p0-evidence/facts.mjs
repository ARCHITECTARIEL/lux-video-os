import {
  ACCOUNT_HASH,
  digest,
  equal,
  exactKeys,
  fail,
  integer,
  object,
  sha256,
  timestamp,
} from './schema.mjs';

const FACT_KEYS = Object.freeze({
  1: ['httpStatus', 'authenticatedAccountHash', 'sessionIdDigest', 'contextIdDigest'],
  2: ['preflightProviderJobIdsDigest', 'preflightProviderJobCount', 'preflightContainsProofProviderJob', 'preflightPaginationComplete', 'providerNativeStatus', 'appSubmissionEventCount', 'providerMarkerMatchCount', 'providerMarkerTitleDigest', 'providerSubmittedAt', 'providerCompletedAt'],
  3: ['privatePathDigest', 'directBlobTargetDigest', 'storedSha256', 'storedBytes', 'fullDecode', 'videoStreams', 'audioStreams'],
  4: ['httpStatus', 'historyMatchCount', 'historyJobStatus', 'outputAccepted', 'historyTitleDigest', 'sessionIdDigest', 'contextIdDigest'],
  5: ['httpStatus', 'authenticatedAccountHash', 'sessionIdDigest', 'contextIdDigest', 'sessionIssuedAt'],
  6: ['httpStatus', 'historyMatchCount', 'historyJobStatus', 'outputAccepted', 'historyTitleDigest', 'sessionIdDigest', 'contextIdDigest', 'storageRepairRequestCount', 'routeReplayRequestCount', 'networkTraceDigest'],
  7: ['httpStatus', 'contentType', 'downloadedSha256', 'downloadedBytes'],
  8: ['anonymousHttpStatus', 'wrongAccountHttpStatus', 'wrongAccountHash', 'directBlobHttpStatus', 'privateObjectPathDigest', 'directRequestTargetDigest'],
  9: ['appProviderSubmissionCount', 'providerNativeCreateCount', 'creditDebitCount', 'finalArtifactEventCount', 'finalAssetCount', 'repairEventCount', 'correlationMismatchCount', 'jobCostCredits', 'creditDebitAmount', 'finalSha256', 'finalBytes', 'privatePathDigest'],
});

function facts(observations, id) {
  return exactKeys(
    object(observations.get(id).facts, 'INVALID_FACTS', 'Observation facts are required.', id),
    FACT_KEYS[id],
    'observation facts',
    id,
  );
}

function history(value, observation) {
  equal(value.httpStatus, 200, 'HISTORY_UNAVAILABLE', 'Account history was unavailable.', observation);
  equal(value.historyMatchCount, 1, 'HISTORY_CARDINALITY', 'Exactly one proof job must appear in history.', observation);
  equal(value.historyJobStatus, 'ready', 'HISTORY_NOT_READY', 'History did not show a ready job.', observation);
  equal(value.outputAccepted, true, 'OUTPUT_NOT_ACCEPTED', 'History did not show accepted output.', observation);
}

function validatePrimarySession(observations, proof) {
  const primary = facts(observations, 1);
  equal(primary.httpStatus, 200, 'PRIMARY_SESSION_UNAUTHENTICATED', 'Primary session was not authenticated.', 1);
  equal(primary.authenticatedAccountHash, proof.accountHash, 'ACCOUNT_MISMATCH', 'Primary account mismatch.', 1);
  digest(primary.sessionIdDigest, 'primary session digest', 1);
  digest(primary.contextIdDigest, 'primary context digest', 1);
  return primary;
}

function validateProvider(observations, proof, window) {
  const provider = facts(observations, 2);
  equal(provider.preflightProviderJobIdsDigest, proof.preflightProviderJobIdsDigest, 'PREFLIGHT_MISMATCH', 'Provider preflight mismatch.', 2);
  integer(provider.preflightProviderJobCount, 'provider preflight count', 2);
  equal(provider.preflightContainsProofProviderJob, false, 'PROVIDER_JOB_PREEXISTED', 'Provider job existed before proof start.', 2);
  equal(provider.preflightPaginationComplete, true, 'PROVIDER_PREFLIGHT_INCOMPLETE', 'Provider preflight was not exhaustive.', 2);
  equal(provider.providerNativeStatus, 'completed', 'PROVIDER_NOT_COMPLETE', 'Provider did not report completion.', 2);
  equal(provider.appSubmissionEventCount, 1, 'SUBMISSION_CARDINALITY', 'App submission count must equal one.', 2);
  equal(provider.providerMarkerMatchCount, 1, 'PROVIDER_CARDINALITY', 'Provider marker match count must equal one.', 2);
  equal(provider.providerMarkerTitleDigest, sha256(proof.title), 'PROVIDER_TITLE_MISMATCH', 'Provider title does not match the proof marker.', 2);
  const submitted = timestamp(provider.providerSubmittedAt, 'provider submitted timestamp', 2);
  const completed = timestamp(provider.providerCompletedAt, 'provider completed timestamp', 2);
  if (submitted < window.started || completed < submitted || completed > window.completed) {
    fail('PROVIDER_TIMELINE_MISMATCH', 'Provider timestamps do not fit the proof window.', 2);
  }
}

function validateStoredFinal(observations, proof, media) {
  const stored = facts(observations, 3);
  equal(stored.privatePathDigest, proof.finalPathDigest, 'FINAL_PATH_MISMATCH', 'Private path digest mismatch.', 3);
  equal(stored.directBlobTargetDigest, proof.directBlobTargetDigest, 'DIRECT_BLOB_TARGET_MISMATCH', 'Stored direct Blob target digest mismatch.', 3);
  equal(media.stored.directBlobTargetDigest, proof.directBlobTargetDigest, 'DIRECT_BLOB_TARGET_MISMATCH', 'Stored artifact target digest mismatch.', 3);
  equal(stored.storedSha256, media.stored.sha256, 'STORED_HASH_MISMATCH', 'Stored hash mismatch.', 3);
  equal(stored.storedBytes, media.stored.bytes, 'STORED_BYTES_MISMATCH', 'Stored byte count mismatch.', 3);
  equal(stored.fullDecode, true, 'MEDIA_NOT_DECODED', 'Stored evidence lacks full decode.', 3);
  equal(stored.videoStreams, media.stored.videoStreams, 'MEDIA_STREAM_MISMATCH', 'Stored video stream mismatch.', 3);
  equal(stored.audioStreams, media.stored.audioStreams, 'MEDIA_STREAM_MISMATCH', 'Stored audio stream mismatch.', 3);
  if (media.stored.fullDecode !== true || media.stored.videoStreams < 1 || media.stored.audioStreams < 1) {
    fail('MEDIA_STREAM_MISSING', 'Stored final lacks a fully decoded audio/video stream.', 3);
  }
}

function validateSessionsAndHistory(observations, proof, primary, window) {
  const original = facts(observations, 4);
  history(original, 4);
  equal(original.historyTitleDigest, sha256(proof.title), 'HISTORY_TITLE_MISMATCH', 'Original history title mismatch.', 4);
  equal(original.sessionIdDigest, primary.sessionIdDigest, 'SESSION_MISMATCH', 'Original history session mismatch.', 4);
  equal(original.contextIdDigest, primary.contextIdDigest, 'CONTEXT_MISMATCH', 'Original history context mismatch.', 4);

  const fresh = facts(observations, 5);
  equal(fresh.httpStatus, 200, 'FRESH_SESSION_UNAUTHENTICATED', 'Fresh session was not authenticated.', 5);
  equal(fresh.authenticatedAccountHash, proof.accountHash, 'ACCOUNT_MISMATCH', 'Fresh account mismatch.', 5);
  digest(fresh.sessionIdDigest, 'fresh session digest', 5);
  digest(fresh.contextIdDigest, 'fresh context digest', 5);
  if (fresh.sessionIdDigest === primary.sessionIdDigest || fresh.contextIdDigest === primary.contextIdDigest) {
    fail('FRESH_SESSION_REUSED', 'Fresh check reused the original session or context.', 5);
  }
  const issued = timestamp(fresh.sessionIssuedAt, 'fresh session issued timestamp', 5);
  if (issued < window.started || issued > window.completed) {
    fail('FRESH_SESSION_NOT_NEW', 'Fresh session was not issued during the proof window.', 5);
  }

  const recovered = facts(observations, 6);
  history(recovered, 6);
  equal(recovered.historyTitleDigest, sha256(proof.title), 'HISTORY_TITLE_MISMATCH', 'Fresh history title mismatch.', 6);
  equal(recovered.sessionIdDigest, fresh.sessionIdDigest, 'SESSION_MISMATCH', 'Fresh history session mismatch.', 6);
  equal(recovered.contextIdDigest, fresh.contextIdDigest, 'CONTEXT_MISMATCH', 'Fresh history context mismatch.', 6);
  equal(recovered.storageRepairRequestCount, 0, 'REPAIR_USED', 'Fresh recovery used storage repair.', 6);
  equal(recovered.routeReplayRequestCount, 0, 'ROUTE_REPLAY_USED', 'Fresh recovery used route replay.', 6);
  digest(recovered.networkTraceDigest, 'fresh network trace digest', 6);
}

function validateDownload(observations, media) {
  const download = facts(observations, 7);
  equal(download.httpStatus, 200, 'AUTHORIZED_DOWNLOAD_FAILED', 'Authorized download did not return 200.', 7);
  equal(download.contentType, 'video/mp4', 'AUTHORIZED_DOWNLOAD_TYPE', 'Authorized download type mismatch.', 7);
  equal(download.downloadedSha256, media.download.sha256, 'DOWNLOAD_HASH_MISMATCH', 'Downloaded hash mismatch.', 7);
  equal(download.downloadedBytes, media.download.bytes, 'DOWNLOAD_BYTES_MISMATCH', 'Downloaded byte count mismatch.', 7);
  equal(media.download.sha256, media.stored.sha256, 'ARTIFACT_IDENTITY_MISMATCH', 'Download differs from stored final.', 7);
  equal(media.download.bytes, media.stored.bytes, 'ARTIFACT_IDENTITY_MISMATCH', 'Download differs from stored final.', 7);
}

function validateDenials(observations, proof) {
  const denials = facts(observations, 8);
  equal(denials.anonymousHttpStatus, 401, 'ANONYMOUS_DOWNLOAD_ESCAPE', 'Anonymous download did not return 401.', 8);
  equal(denials.wrongAccountHttpStatus, 404, 'CROSS_ACCOUNT_DOWNLOAD_ESCAPE', 'Wrong-account download did not return 404.', 8);
  if (!ACCOUNT_HASH.test(String(denials.wrongAccountHash || '')) || denials.wrongAccountHash === proof.accountHash) {
    fail('WRONG_ACCOUNT_NOT_DISTINCT', 'Wrong-account evidence is missing or not distinct.', 8);
  }
  if (![401, 403, 404].includes(denials.directBlobHttpStatus)) {
    fail('DIRECT_BLOB_ESCAPE', 'Direct private Blob access was not denied.', 8);
  }
  equal(denials.privateObjectPathDigest, proof.finalPathDigest, 'DIRECT_BLOB_TARGET_MISMATCH', 'Blob denial targeted another object.', 8);
  equal(denials.directRequestTargetDigest, proof.directBlobTargetDigest, 'DIRECT_BLOB_TARGET_MISMATCH', 'Direct Blob denial targeted another request URL.', 8);
}

function validateCardinality(observations, proof, media) {
  const correlated = facts(observations, 9);
  const countFields = [
    ['appProviderSubmissionCount', 'SUBMISSION_CARDINALITY'],
    ['providerNativeCreateCount', 'PROVIDER_CARDINALITY'],
    ['creditDebitCount', 'DEBIT_CARDINALITY'],
    ['finalArtifactEventCount', 'FINAL_EVENT_CARDINALITY'],
    ['finalAssetCount', 'FINAL_ASSET_CARDINALITY'],
  ];
  for (const [field, code] of countFields) equal(correlated[field], 1, code, field + ' must equal one.', 9);
  equal(correlated.repairEventCount, 0, 'REPAIR_USED', 'Proof job contains a repair event.', 9);
  equal(correlated.correlationMismatchCount, 0, 'CORRELATION_MISMATCH', 'Correlated identities mismatch.', 9);
  integer(correlated.jobCostCredits, 'job cost credits', 9, 1);
  if (!Number.isSafeInteger(correlated.creditDebitAmount) || correlated.creditDebitAmount !== -correlated.jobCostCredits) {
    fail('DEBIT_AMOUNT_MISMATCH', 'Credit debit does not equal job cost.', 9);
  }
  equal(correlated.finalSha256, media.stored.sha256, 'FINAL_EVENT_MISMATCH', 'Final event hash mismatch.', 9);
  equal(correlated.finalBytes, media.stored.bytes, 'FINAL_EVENT_MISMATCH', 'Final event bytes mismatch.', 9);
  equal(correlated.privatePathDigest, proof.finalPathDigest, 'FINAL_EVENT_MISMATCH', 'Final event path mismatch.', 9);
}

export function validateObservationFacts(observations, proof, media, window) {
  object(media, 'MEDIA_REQUIRED', 'Locally inspected media files are required.');
  object(media.stored, 'MEDIA_REQUIRED', 'Stored media inspection is required.');
  object(media.download, 'MEDIA_REQUIRED', 'Download media inspection is required.');
  const primary = validatePrimarySession(observations, proof);
  validateProvider(observations, proof, window);
  validateStoredFinal(observations, proof, media);
  validateSessionsAndHistory(observations, proof, primary, window);
  validateDownload(observations, media);
  validateDenials(observations, proof);
  validateCardinality(observations, proof, media);
}
