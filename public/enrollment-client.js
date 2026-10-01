export const ENROLLMENT_CONTRACT_VERSION = 'identity-phone-video-v1';
export const ENROLLMENT_POLICY_VERSION = 'identity-provider-bridge-v2';
export const ENROLLMENT_PURPOSE = 'identity-voice-enrollment';
export const ENROLLMENT_RESUME_KEY = 'luxVideoOsEnrollmentResumeV1';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function cleanUuid(value) {
  const normalized = String(value || '').trim();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

export function createIdempotencyKey() {
  return crypto.randomUUID();
}

export function buildProviderReconsentRequest(enrollment, idempotencyKey) {
  const enrollmentId = cleanUuid(enrollment?.id);
  const identityId = cleanUuid(enrollment?.identity?.id);
  const requestKey = cleanUuid(idempotencyKey);
  const expectedStateVersion = Number(enrollment?.stateVersion);
  const sourcePhotoSha256 = String(enrollment?.photo?.sha256 || '').trim().toLowerCase();
  const sourceVideoSha256 = String(enrollment?.sourceVideo?.sha256 || '').trim().toLowerCase();
  const derivedVoiceSha256 = String(enrollment?.derivedAudio?.sha256 || '').trim().toLowerCase();
  const bridgeConsent = enrollment?.providerBridgeConsent;

  if (!enrollmentId || !identityId || !requestKey || !Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0) {
    throw new TypeError('Updated provider consent requires the exact owned enrollment state.');
  }
  if (enrollment?.status !== 'IDENTITY_READY' || bridgeConsent?.reconsentAvailable !== true) {
    throw new TypeError('Updated provider consent is unavailable for this identity.');
  }
  if (![sourcePhotoSha256, sourceVideoSha256, derivedVoiceSha256].every(value => SHA256_PATTERN.test(value))) {
    throw new TypeError('The original owned identity sources are not ready for updated consent.');
  }

  return {
    action: 'provider-reconsent',
    contractVersion: ENROLLMENT_CONTRACT_VERSION,
    enrollmentId,
    identityId,
    expectedStateVersion,
    idempotencyKey: requestKey,
    policyVersion: ENROLLMENT_POLICY_VERSION,
    purpose: ENROLLMENT_PURPOSE,
    sourcePhotoSha256,
    sourceVideoSha256,
    derivedVoiceSha256,
    audioExtractionAuthorization: true,
    faceAuthorization: true,
    voiceAuthorization: true,
    providerProcessingAuthorization: true,
    archiveDeleteAcknowledgment: true,
    temporaryPublicProviderExposureAuthorization: true,
  };
}

export function enrollmentResumeStorageKey(accountId) {
  const normalized = String(accountId || '').trim();
  if (!normalized) throw new TypeError('Enrollment resume storage requires an authenticated account.');
  return `${ENROLLMENT_RESUME_KEY}:${encodeURIComponent(normalized)}`;
}

export function readEnrollmentResume(accountId, storage = localStorage) {
  try {
    const value = JSON.parse(storage.getItem(enrollmentResumeStorageKey(accountId)) || 'null');
    if (!value || typeof value !== 'object') return null;
    const enrollmentId = value.enrollmentId ? cleanUuid(value.enrollmentId) : null;
    const createIdempotencyKey = cleanUuid(value.createIdempotencyKey);
    if (!createIdempotencyKey) return null;
    return {
      enrollmentId,
      createIdempotencyKey,
      consentIdempotencyKey: cleanUuid(value.consentIdempotencyKey),
      retryIdempotencyKey: cleanUuid(value.retryIdempotencyKey),
      revokeIdempotencyKey: cleanUuid(value.revokeIdempotencyKey),
    };
  } catch {
    return null;
  }
}

export function writeEnrollmentResume(value, accountId, storage = localStorage) {
  const safe = {
    enrollmentId: value.enrollmentId ? cleanUuid(value.enrollmentId) : null,
    createIdempotencyKey: cleanUuid(value.createIdempotencyKey),
    consentIdempotencyKey: value.consentIdempotencyKey ? cleanUuid(value.consentIdempotencyKey) : null,
    retryIdempotencyKey: value.retryIdempotencyKey ? cleanUuid(value.retryIdempotencyKey) : null,
    revokeIdempotencyKey: value.revokeIdempotencyKey ? cleanUuid(value.revokeIdempotencyKey) : null,
  };
  if (!safe.createIdempotencyKey) throw new TypeError('Enrollment resume metadata requires a create idempotency key.');
  storage.setItem(enrollmentResumeStorageKey(accountId), JSON.stringify(safe));
  return safe;
}

export function clearEnrollmentResume(accountId, storage = localStorage) {
  storage.removeItem(enrollmentResumeStorageKey(accountId));
  // Remove the pre-account-scoping key if an earlier UI version created it.
  storage.removeItem(ENROLLMENT_RESUME_KEY);
}

function uploadFailure(message, code) {
  return Object.assign(new Error(message), { code });
}

function validateUploadInstruction(instruction, file) {
  if (!instruction || instruction.access !== 'private' || instruction.multipart !== true
    || typeof instruction.pathname !== 'string' || !instruction.pathname.trim()
    || typeof instruction.handleUploadUrl !== 'string' || !instruction.handleUploadUrl.startsWith('/api/')
    || instruction.clientPayload === undefined || instruction.clientPayload === null) {
    throw uploadFailure('Private upload instructions are incomplete. Refresh this enrollment before trying again.', 'upload_instructions_invalid');
  }
  const maximum = Number(instruction.maximumSizeInBytes);
  if (!Number.isFinite(maximum) || maximum <= 0 || file.size > maximum) {
    throw uploadFailure('The selected video exceeds this enrollment upload limit.', 'video_too_large');
  }
  const allowed = Array.isArray(instruction.allowedContentTypes) ? instruction.allowedContentTypes.map(value => String(value).toLowerCase()) : [];
  if (!allowed.includes(String(file.type || '').toLowerCase())) {
    throw uploadFailure('The selected video type is not allowed for this enrollment.', 'video_type_invalid');
  }
  if (instruction.expiresAt && new Date(instruction.expiresAt).getTime() <= Date.now()) {
    throw uploadFailure('Private upload instructions expired. Refresh this enrollment before trying again.', 'upload_instructions_expired');
  }
}

export async function uploadEnrollmentVideo(instruction, file, {
  onUploadProgress = () => {},
  abortSignal,
  loadSdk = () => import('/vendor/vercel-blob-client.js'),
} = {}) {
  validateUploadInstruction(instruction, file);
  const module = await loadSdk();
  if (typeof module?.upload !== 'function') throw uploadFailure('The private upload client is unavailable.', 'upload_client_unavailable');
  return module.upload(instruction.pathname, file, {
    access: 'private',
    multipart: true,
    handleUploadUrl: instruction.handleUploadUrl,
    clientPayload: instruction.clientPayload,
    onUploadProgress,
    abortSignal,
  });
}
