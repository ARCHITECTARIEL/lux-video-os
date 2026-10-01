import {
  buildProviderReconsentRequest,
  clearEnrollmentResume,
  createIdempotencyKey,
  ENROLLMENT_CONTRACT_VERSION,
  ENROLLMENT_POLICY_VERSION,
  ENROLLMENT_PURPOSE,
  readEnrollmentResume,
  uploadEnrollmentVideo,
  writeEnrollmentResume,
} from './enrollment-client.js';

const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const DEFAULT_VIDEO_LIMITS = Object.freeze({
  maximumSizeInBytes: 100 * 1024 * 1024,
  minimumDurationSeconds: 5,
  maximumDurationSeconds: 60,
  maximumDimensionPx: 4096,
  allowedContentTypes: [...VIDEO_TYPES],
});
const ENROLLMENT_ACTIVE_STATES = new Set(['AWAITING_UPLOAD', 'SOURCE_HASHING', 'AWAITING_EXTRACTION_CONSENT', 'EXTRACTION_QUEUED', 'EXTRACTING']);
const CONSENT_IDS = ['consent-face', 'consent-extraction', 'consent-voice', 'consent-process', 'consent-archive', 'consent-provider-exposure'];
const REQUEST_TIMEOUT_MS = 30_000;
const ENROLLMENT_POLL_MS = 2_000;
const ENROLLMENT_POLL_LIMIT = 180;

const state = {
  accountId: null,
  step: 1,
  photoFile: null,
  photoAssetId: null,
  photoUrl: null,
  videoFile: null,
  videoUrl: null,
  videoMetadata: null,
  videoAccepted: false,
  videoLimits: { ...DEFAULT_VIDEO_LIMITS },
  recorder: null,
  recordingTimer: null,
  captureRequestToken: 0,
  identities: [],
  providerSubmissionEnabled: false,
  activeIdentityId: null,
  pollTimer: null,
  pollCount: 0,
  enrollmentEnabled: false,
  extractionEnabled: false,
  enrollments: [],
  activeEnrollment: null,
  enrollmentPollTimer: null,
  enrollmentPollCount: 0,
  uploadInstruction: null,
  uploadController: null,
  resume: null,
  consentSourceSignature: null,
  consentSourceHash: null,
  providerReconsentMode: false,
  providerReconsentIdempotencyKey: null,
  wizardOpener: null,
  menuOpener: null,
  submitting: false,
  uncertainCommit: null,
};

const $ = selector => document.querySelector(selector);

function setLocalPreviewSource(element, objectUrl) {
  // This URL is minted from a selected File/Blob and is never parsed as markup.
  element.src = objectUrl;
}

const api = async (url, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const method = String(options.method || 'GET').toUpperCase();
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({ ok: false, error: 'The server returned an unreadable response.' }));
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || 'Request failed.'), { status: response.status, code: data.code, payload: data });
    return data;
  } catch (error) {
    if (controller.signal.aborted) {
      const message = ['GET', 'HEAD'].includes(method)
        ? 'The request took too long. Check your connection and try again.'
        : 'The request took too long, so its final status is unknown. Reload this page to check before trying again.';
      throw Object.assign(new Error(message), { code: 'REQUEST_TIMEOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

function notice(message, tone = 'info', origin = 'page') {
  const element = $('#notice');
  element.textContent = message;
  element.className = `notice ${tone}`;
  element.dataset.origin = origin;
  element.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  element.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
  element.hidden = !message;
}

function wizardStatus(message = '', tone = 'info') {
  const element = $('#wizard-status');
  element.textContent = message;
  element.className = `wizard-status ${tone}`;
}

function updateSessionLabels(label) {
  $('#session-label').textContent = label;
  $('#mobile-session-label').textContent = label;
}

function focusableElements(container) {
  return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), audio[controls], video[controls], [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hidden && element.getClientRects().length > 0);
}

function trapFocus(event, container) {
  if (event.key !== 'Tab') return;
  const controls = focusableElements(container);
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function statusLabel(value) {
  return String(value || 'DRAFT').replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\S/g, letter => letter.toUpperCase());
}

function linkedEnrollmentForIdentity(identityId) {
  return state.enrollments.find(enrollment => enrollment?.identity?.id === identityId) || null;
}

function providerBridgeConsentActive(enrollment) {
  const consent = enrollment?.providerBridgeConsent;
  return consent?.status === 'active'
    && consent.policyVersion === ENROLLMENT_POLICY_VERSION
    && consent.temporaryPublicProviderExposureAuthorized === true;
}

function providerLifecyclePresentation(value) {
  const lifecycle = value && typeof value === 'object' ? value : null;
  if (!lifecycle) return null;
  const presentations = {
    not_started: ['Provider creation not started', 'No provider upload has started.'],
    preparing: ['Preparing presenter', 'Provider creation is in progress.'],
    temporary_sources_pending_removal: ['Removing temporary provider files', 'Temporary provider file removal is still pending.'],
    ready: ['Ready', 'Provider presenter creation and required temporary-file cleanup are reported ready.'],
    removal_requested: ['Removal requested', 'Provider removal was requested and remains pending.'],
    needs_attention: ['Needs attention', 'Provider setup or cleanup needs attention. No removal completion is claimed.'],
  };
  const stateName = Object.hasOwn(presentations, lifecycle.state) ? lifecycle.state : 'needs_attention';
  const [label, detail] = presentations[stateName];
  return { state: stateName, label, detail };
}

function appendProviderLifecycle(container, enrollment) {
  const presentation = providerLifecyclePresentation(enrollment?.providerLifecycle);
  if (!presentation) return;
  const panel = document.createElement('div');
  panel.className = 'identity-provider-state';
  panel.dataset.state = presentation.state;
  const label = document.createElement('strong');
  label.textContent = presentation.label;
  const detail = document.createElement('span');
  detail.textContent = presentation.detail;
  panel.append(label, detail);
  container.append(panel);
}

function appendProviderConsentState(container, enrollment) {
  if (providerBridgeConsentActive(enrollment)) return;
  const status = enrollment?.providerBridgeConsent?.status;
  let message = 'Updated provider consent is required. New provider uploads are held.';
  if (status === 'revoked') message = 'Provider permission was withdrawn. New provider uploads are held.';
  else if (status === 'source_unavailable') message = 'Updated provider consent needs attention because the original owned sources are unavailable.';
  else if (status === 'missing' && enrollment?.providerBridgeConsent?.reconsentAvailable) {
    message = 'Review the updated provider exposure permission before a provider upload.';
  }
  const note = document.createElement('p');
  note.className = 'provider-consent-hold';
  note.textContent = message;
  container.append(note);
}

function button(label, className, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `button ${className}`;
  element.textContent = label;
  element.addEventListener('click', action);
  return element;
}

function componentRow(label, status) {
  const row = document.createElement('div');
  row.className = 'component-row';
  const name = document.createElement('span');
  name.textContent = label;
  const value = document.createElement('strong');
  value.textContent = statusLabel(status);
  row.append(name, value);
  return row;
}

function renderIdentity(identity) {
  const linkedEnrollment = linkedEnrollmentForIdentity(identity.id);
  const card = document.createElement('article');
  card.className = 'identity-card';
  const media = document.createElement('div');
  media.className = 'identity-media';
  if (identity.portraitUrl) {
    const portrait = document.createElement('img');
    portrait.className = 'identity-portrait';
    portrait.src = identity.portraitUrl;
    portrait.alt = `${identity.displayName} portrait`;
    portrait.addEventListener('error', () => {
      const fallback = document.createElement('div');
      fallback.className = 'identity-media-fallback';
      fallback.textContent = 'Portrait unavailable';
      portrait.replaceWith(fallback);
    }, { once: true });
    media.append(portrait);
  } else {
    const fallback = document.createElement('div');
    fallback.className = 'identity-media-fallback';
    fallback.textContent = 'Portrait unavailable';
    media.append(fallback);
  }
  const body = document.createElement('div');
  body.className = 'identity-body';
  const title = document.createElement('div');
  title.className = 'identity-title';
  const heading = document.createElement('h3');
  heading.textContent = identity.displayName;
  const pill = document.createElement('span');
  pill.className = `status-pill ${identity.ready ? 'ready' : ''}`;
  pill.dataset.status = identity.overallStatus || 'DRAFT';
  pill.textContent = statusLabel(identity.overallStatus);
  title.append(heading, pill);
  const created = document.createElement('p');
  created.className = 'fine-print';
  created.textContent = `Created ${new Date(identity.createdAt).toLocaleDateString()}`;
  const actions = document.createElement('div');
  actions.className = 'identity-actions';
  if (identity.ready) {
    const use = document.createElement('a');
    use.className = 'button primary';
    use.href = `/?identityId=${encodeURIComponent(identity.id)}`;
    use.textContent = 'Use in Video OS';
    actions.append(use);
  }
  if (identity.voicePreviewUrl) {
    const previewButton = button('Preview voice', 'secondary', () => {
      const existing = card.querySelector('audio');
      if (existing) {
        existing.remove();
        previewButton.setAttribute('aria-expanded', 'false');
        return;
      }
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.setAttribute('aria-label', `${identity.displayName} saved voice preview`);
      audio.src = identity.voicePreviewUrl;
      body.insertBefore(audio, actions);
      previewButton.setAttribute('aria-expanded', 'true');
      audio.focus();
    });
    previewButton.setAttribute('aria-expanded', 'false');
    actions.append(previewButton);
  }
  if (identity.avatarStatus === 'FAILED') actions.append(button('Retry avatar', 'secondary', () => retryIdentityComponent(identity.id, 'avatar')));
  if (identity.voiceStatus === 'FAILED') actions.append(button('Retry voice', 'secondary', () => retryIdentityComponent(identity.id, 'voice')));
  if (!providerBridgeConsentActive(linkedEnrollment) && linkedEnrollment?.providerBridgeConsent?.reconsentAvailable === true) {
    actions.append(button('Review provider consent', 'secondary', () => openProviderReconsent(linkedEnrollment)));
  }
  if (identity.avatarStatus === 'DRAFT' && identity.voiceStatus === 'DRAFT') {
    const start = button('Start creation', 'primary', () => submitIdentity(identity.id));
    const consentReady = providerBridgeConsentActive(linkedEnrollment);
    start.disabled = !state.providerSubmissionEnabled || !consentReady;
    start.title = !consentReady
      ? 'Review the updated provider exposure permission before provider creation.'
      : start.disabled ? 'Provider submission is held until privacy, entitlement, and cost checks pass.' : '';
    actions.append(start);
  }
  actions.append(button('Archive', 'ghost', () => archiveIdentity(identity.id, identity.displayName)));
  body.append(title, created, componentRow('Photo avatar', identity.avatarStatus), componentRow('Reusable voice', identity.voiceStatus));
  appendProviderLifecycle(body, linkedEnrollment);
  appendProviderConsentState(body, linkedEnrollment);
  if (identity.avatarFailure?.message) {
    const error = document.createElement('p'); error.className = 'component-error'; error.textContent = `Avatar: ${identity.avatarFailure.message}`; body.append(error);
  }
  if (identity.voiceFailure?.message) {
    const error = document.createElement('p'); error.className = 'component-error'; error.textContent = `Voice: ${identity.voiceFailure.message}`; body.append(error);
  }
  body.append(actions);
  if (identity.avatarStatus === 'DRAFT' && identity.voiceStatus === 'DRAFT' && !state.providerSubmissionEnabled) {
    const held = document.createElement('p');
    held.className = 'provider-hold';
    held.textContent = 'Creation is held until privacy, entitlement, and cost checks pass.';
    body.append(held);
  }
  card.append(media, body);
  return card;
}

function renderIdentities() {
  $('#identity-list').replaceChildren(...state.identities.map(renderIdentity));
  $('#empty-state').hidden = state.identities.length > 0;
}

async function loadIdentities() {
  const data = await api('/api/video-os-lite/identities');
  state.identities = data.identities || [];
  state.providerSubmissionEnabled = data.providerSubmissionEnabled === true;
  renderIdentities();
  const processing = state.identities.some(identity => ['CREATING_AVATAR', 'CLONING_VOICE', 'PROCESSING'].includes(identity.overallStatus));
  if (processing) scheduleIdentityPolling(); else stopIdentityPolling();
  return data;
}

function normalizeVideoLimits(value = {}) {
  const source = value.sourceVideo || value.video || value;
  return {
    maximumSizeInBytes: Number(source.maximumSizeInBytes || source.maxBytes || DEFAULT_VIDEO_LIMITS.maximumSizeInBytes),
    minimumDurationSeconds: Number(source.minimumDurationSeconds || source.minDurationSeconds || (source.minimumDurationMs && source.minimumDurationMs / 1_000) || DEFAULT_VIDEO_LIMITS.minimumDurationSeconds),
    maximumDurationSeconds: Number(source.maximumDurationSeconds || source.maxDurationSeconds || (source.maximumDurationMs && source.maximumDurationMs / 1_000) || DEFAULT_VIDEO_LIMITS.maximumDurationSeconds),
    maximumDimensionPx: Number(source.maximumDimensionPx || source.maxDimensionPx || source.maximumDimension || DEFAULT_VIDEO_LIMITS.maximumDimensionPx),
    allowedContentTypes: Array.isArray(source.allowedContentTypes) && source.allowedContentTypes.length
      ? source.allowedContentTypes.map(item => String(item).toLowerCase())
      : [...DEFAULT_VIDEO_LIMITS.allowedContentTypes],
  };
}

function activeResumeEnrollment() {
  const resumeId = state.resume?.enrollmentId;
  return state.enrollments.find(item => item.id === resumeId)
    || state.enrollments.find(item => ENROLLMENT_ACTIVE_STATES.has(item.status) || item.status === 'FAILED')
    || null;
}

function enrollmentSummary(enrollment) {
  const detail = {
    AWAITING_UPLOAD: 'Waiting for the original phone video upload.',
    SOURCE_HASHING: 'Verifying the uploaded video bytes.',
    AWAITING_EXTRACTION_CONSENT: 'Waiting for explicit extraction and voice permissions.',
    EXTRACTION_QUEUED: 'Voice-sample extraction is queued.',
    EXTRACTING: 'Preparing the authorized reusable voice sample.',
    FAILED: enrollment?.failure?.message || 'Enrollment needs attention.',
  }[enrollment?.status];
  return detail ? `${statusLabel(enrollment?.status)}: ${detail}` : statusLabel(enrollment?.status);
}

function renderEnrollmentResume() {
  const enrollment = activeResumeEnrollment();
  $('#enrollment-resume').hidden = !enrollment;
  if (!enrollment) return;
  $('#resume-copy').textContent = enrollmentSummary(enrollment);
  $('#resume-enrollment').disabled = !state.enrollmentEnabled;
}

function setCreateAvailability() {
  const enabled = state.enrollmentEnabled && state.extractionEnabled;
  for (const selector of ['#create-button', '#empty-create-button']) {
    const control = $(selector);
    control.disabled = !enabled;
    control.title = enabled ? '' : 'Phone-video enrollment is currently unavailable.';
  }
}

async function loadEnrollments() {
  const data = await api('/api/video-os-lite/enrollments');
  state.enrollmentEnabled = data.enabled === true;
  state.extractionEnabled = data.extractionEnabled === true;
  state.videoLimits = normalizeVideoLimits(data.limits || {});
  state.enrollments = Array.isArray(data.enrollments) ? data.enrollments : [];
  state.resume = readEnrollmentResume(state.accountId);
  const resumable = activeResumeEnrollment();
  if (resumable) state.activeEnrollment = resumable;
  setCreateAvailability();
  renderEnrollmentResume();
  renderIdentities();
  return data;
}

function ensureResumeMetadata() {
  if (!state.resume?.createIdempotencyKey) {
    state.resume = { enrollmentId: null, createIdempotencyKey: createIdempotencyKey(), consentIdempotencyKey: null, retryIdempotencyKey: null, revokeIdempotencyKey: null };
  }
  state.resume = writeEnrollmentResume(state.resume, state.accountId);
  return state.resume;
}

function updateResumeMetadata(patch) {
  state.resume = writeEnrollmentResume({ ...ensureResumeMetadata(), ...patch }, state.accountId);
  return state.resume;
}

function clearResumeMetadata() {
  clearEnrollmentResume(state.accountId);
  state.resume = null;
}

const stepNames = ['Photo', 'Video', 'Consent', 'Creating', 'Ready'];

function setProviderReconsentMode(enabled) {
  state.providerReconsentMode = enabled;
  if (!enabled) state.providerReconsentIdempotencyKey = null;
  $('#wizard').classList.toggle('reconsent-mode', enabled);
  $('#provider-reconsent-note').hidden = !enabled;
  $('#identity-name').readOnly = enabled;
  $('#wizard-title').textContent = enabled ? 'Review provider consent' : 'Build your private presenter';
  $('#wizard-description').textContent = enabled
    ? 'Review the updated provider exposure permission for your existing account-owned identity sources.'
    : 'Add one photo and one phone video, then review every authorization before anything is saved.';
}

function setStep(step) {
  state.step = step;
  if (step === 3) syncConsentMediaReview();
  document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = Number(panel.dataset.panel) !== step; });
  const activePanel = document.querySelector(`[data-panel="${step}"]`);
  if (activePanel) activePanel.scrollTop = 0;
  document.querySelectorAll('[data-step]').forEach(item => {
    const number = Number(item.dataset.step);
    item.classList.toggle('current', number === step);
    item.classList.toggle('complete', number < step);
    if (number === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
  $('#compact-step-label').textContent = `${step} of 5: ${stepNames[step - 1]}`;
  document.querySelectorAll('[data-segment]').forEach(segment => {
    const number = Number(segment.dataset.segment);
    segment.classList.toggle('current', number === step);
    segment.classList.toggle('complete', number < step);
  });
  $('#back-button').hidden = state.providerReconsentMode;
  $('#back-button').disabled = state.submitting || state.providerReconsentMode || step === 1 || step >= 4;
  $('#next-button').disabled = state.submitting || Boolean(state.uncertainCommit);
  $('#next-button').hidden = step >= 4;
  $('#next-button').textContent = state.providerReconsentMode && step === 3 ? 'Save updated consent' : 'Continue';
  $('#wizard-actions').hidden = step === 5;
  if (step === 4) updateProgress();
  const focusTarget = state.providerReconsentMode && step === 3
    ? '#consent-face'
    : { 1: '#photo-input', 2: '#record-button', 3: '#identity-name', 4: '#close-wizard', 5: '#ready-done' }[step];
  if ($('#wizard').open) requestAnimationFrame(() => {
    if (activePanel) activePanel.scrollTop = 0;
    $(focusTarget)?.focus({ preventScroll: true });
    if (activePanel) activePanel.scrollTop = 0;
  });
}

function beginNewEnrollment() {
  setProviderReconsentMode(false);
  state.activeEnrollment = null;
  state.activeIdentityId = null;
  state.uploadInstruction = null;
  state.photoAssetId = null;
  state.resume = { enrollmentId: null, createIdempotencyKey: createIdempotencyKey(), consentIdempotencyKey: null, retryIdempotencyKey: null, revokeIdempotencyKey: null };
  writeEnrollmentResume(state.resume, state.accountId);
}

function openWizard() {
  if (!state.enrollmentEnabled || !state.extractionEnabled) {
    notice('Phone-video identity enrollment is currently unavailable. Existing identities were not changed.', 'error');
    return;
  }
  if ($('#wizard').open) return;
  if (activeResumeEnrollment()) {
    notice('Continue or cancel the saved setup before starting another identity.', 'info');
    void openEnrollmentResume();
    return;
  }
  beginNewEnrollment();
  state.wizardOpener = document.activeElement;
  $('#wizard').showModal();
  setStep(1);
}

function hasUnsavedMedia() {
  return Boolean((state.photoFile || state.videoFile || state.recorder) && !state.activeEnrollment?.id);
}

function closeWizard(force = false) {
  if (state.submitting && !force) {
    wizardStatus('This saved operation is still being confirmed. Wait for recovery controls.', 'error');
    return;
  }
  if (!force && hasUnsavedMedia() && !window.confirm('Discard the photo or video that has not been saved yet?')) return;
  cleanupCapture({ invalidate: true });
  if ($('#wizard').open) $('#wizard').close();
}

function revokeObjectUrl(key) {
  if (state[key]) URL.revokeObjectURL(state[key]);
  state[key] = null;
}

function clearConsentError() {
  for (const id of CONSENT_IDS) $(`#${id}`).removeAttribute('aria-invalid');
  $('#consent-error').textContent = '';
  $('#consent-error').hidden = true;
}

function clearConsentChecks(message = '') {
  for (const id of CONSENT_IDS) {
    const input = $(`#${id}`);
    input.checked = false;
    input.removeAttribute('aria-invalid');
  }
  state.consentSourceSignature = null;
  state.consentSourceHash = null;
  clearConsentError();
  if (message) wizardStatus(message);
}

function resetWizard() {
  cleanupCapture({ invalidate: true });
  state.photoFile = null;
  state.photoAssetId = null;
  state.videoFile = null;
  state.videoMetadata = null;
  state.videoAccepted = false;
  state.uncertainCommit = null;
  state.uploadInstruction = null;
  state.uploadController?.abort();
  state.uploadController = null;
  $('#commit-uncertain').hidden = true;
  $('#identity-form').reset();
  setProviderReconsentMode(false);
  revokeObjectUrl('photoUrl');
  revokeObjectUrl('videoUrl');
  $('#photo-preview').hidden = true;
  $('#photo-preview').removeAttribute('src');
  $('#photo-prompt').hidden = false;
  $('#consent-photo-preview').removeAttribute('src');
  $('#consent-video-preview').pause?.();
  $('#consent-video-preview').removeAttribute('src');
  resetVideoPresentation();
  clearValidation();
  clearConsentChecks();
  wizardStatus();
  if (!state.activeEnrollment?.id) clearResumeMetadata();
  if ($('#notice').dataset.origin === 'wizard') notice('');
}

function validPhotoFile(file) {
  if (!file) throw new Error('Choose your photo first.');
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('Choose a supported photo file.');
  if (!file.size) throw new Error('The photo file is empty.');
  if (file.size > 3_000_000) throw new Error('The photo must be 3 MB or smaller.');
}

function clearFieldError(control, errorElement) {
  control?.removeAttribute('aria-invalid');
  if (errorElement) { errorElement.textContent = ''; errorElement.hidden = true; }
}

function showFieldError(control, errorElement, message) {
  control?.setAttribute('aria-invalid', 'true');
  errorElement.textContent = message;
  errorElement.hidden = false;
  wizardStatus(message, 'error');
  notice(message, 'error', 'wizard');
  control?.focus();
  return false;
}

function clearValidation() {
  clearFieldError($('#photo-input'), $('#photo-error'));
  clearFieldError($('#video-input'), $('#video-error'));
  $('#video-capture-input').removeAttribute('aria-invalid');
  $('#record-button').removeAttribute('aria-invalid');
  clearFieldError($('#identity-name'), $('#identity-name-error'));
  clearConsentError();
}

function consentInputs() {
  return CONSENT_IDS.map(id => $(`#${id}`));
}

function videoSignature(file = state.videoFile) {
  return file ? `${file.name}\0${file.type}\0${file.size}\0${file.lastModified}` : null;
}

function safeOwnedPreview(value, kind) {
  const normalized = String(value || '');
  const prefix = kind === 'photo' ? '/api/video-os-lite/asset?' : '/api/video-os-lite/enrollments?';
  return normalized.startsWith(prefix) ? normalized : '';
}

function syncConsentMediaReview() {
  const photoPreview = $('#consent-photo-preview');
  const photoUrl = state.photoUrl || safeOwnedPreview(state.activeEnrollment?.photo?.previewUrl, 'photo');
  if (photoUrl) photoPreview.src = photoUrl; else photoPreview.removeAttribute('src');
  const videoPreview = $('#consent-video-preview');
  const videoUrl = state.videoUrl || safeOwnedPreview(state.activeEnrollment?.sourceVideo?.previewUrl, 'video');
  videoPreview.pause?.();
  if (videoUrl) videoPreview.src = videoUrl; else videoPreview.removeAttribute('src');
  const source = state.activeEnrollment?.sourceVideo;
  const duration = state.videoMetadata?.duration || (Number(source?.durationMs) > 0 ? Number(source.durationMs) / 1_000 : null);
  const dimensions = state.videoMetadata
    ? `${state.videoMetadata.width} × ${state.videoMetadata.height}`
    : source?.width && source?.height ? `${source.width} × ${source.height}` : '';
  $('#consent-video-caption').textContent = ['Phone video', duration ? `${duration.toFixed(duration < 10 ? 1 : 0)} seconds` : '', dimensions].filter(Boolean).join(' · ');
}

function validateStep() {
  wizardStatus();
  if (state.step === 1) {
    try { validPhotoFile(state.photoFile); }
    catch (error) { return showFieldError($('#photo-input'), $('#photo-error'), error.message); }
    clearFieldError($('#photo-input'), $('#photo-error'));
  }
  if (state.step === 2) {
    if (!state.videoFile) return showFieldError($('#video-input'), $('#video-error'), 'Record or choose your phone video first.');
    if (!state.videoAccepted) return showFieldError($('#video-input'), $('#video-error'), 'Preview the selected video, then choose Use this video.');
    clearFieldError($('#video-input'), $('#video-error'));
  }
  if (state.step === 3) {
    if (!$('#identity-name').value.trim()) return showFieldError($('#identity-name'), $('#identity-name-error'), 'Name this identity.');
    clearFieldError($('#identity-name'), $('#identity-name-error'));
    const missing = consentInputs().filter(input => !input.checked);
    if (missing.length) {
      missing.forEach(input => input.setAttribute('aria-invalid', 'true'));
      $('#consent-error').textContent = 'All six authorizations are required.';
      $('#consent-error').hidden = false;
      wizardStatus($('#consent-error').textContent, 'error');
      notice($('#consent-error').textContent, 'error', 'wizard');
      missing[0].focus();
      return false;
    }
    clearConsentError();
    const serverHash = state.activeEnrollment?.sourceVideo?.sha256 || null;
    if (serverHash) state.consentSourceHash = state.consentSourceHash || serverHash;
    else state.consentSourceSignature = state.consentSourceSignature || videoSignature();
  }
  notice('');
  return true;
}

function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The selected photo could not be read.'));
    reader.readAsDataURL(file);
  });
}

async function uploadPhoto(file, requestKey) {
  return api('/api/video-os-lite/uploads', {
    method: 'POST',
    headers: { 'x-request-id': requestKey },
    body: JSON.stringify({ kind: 'identity_photo', name: file.name, dataUrl: await fileDataUrl(file) }),
  });
}

function setWizardBusy(busy, message = '') {
  state.submitting = busy;
  $('#wizard').setAttribute('aria-busy', String(busy));
  $('#close-wizard').disabled = busy;
  $('#next-button').disabled = busy || Boolean(state.uncertainCommit);
  $('#back-button').disabled = busy || state.step === 1 || state.step >= 4;
  if (message) wizardStatus(message);
}

function isUncertainError(error) {
  return !Number.isInteger(error?.status);
}

function isProviderReconsentUncertain(error) {
  return isUncertainError(error) || Number(error?.status) >= 500;
}

function showCommitUncertain(show) {
  $('#commit-uncertain').hidden = !show;
  $('#next-button').disabled = state.submitting || show;
  if (show) $('#check-my-identities').focus();
}

function enrollmentBody(action, enrollment, idempotencyKey) {
  return { action, contractVersion: ENROLLMENT_CONTRACT_VERSION, enrollmentId: enrollment.id, expectedStateVersion: enrollment.stateVersion, idempotencyKey };
}

function setEnrollment(enrollment, { persistResume = true } = {}) {
  if (!enrollment?.id) throw new Error('Enrollment response did not include an identity.');
  const previousHash = state.activeEnrollment?.sourceVideo?.sha256 || state.consentSourceHash;
  const nextHash = enrollment.sourceVideo?.sha256 || null;
  state.activeEnrollment = enrollment;
  state.activeIdentityId = enrollment.identity?.id || state.activeIdentityId;
  if (persistResume) updateResumeMetadata({ enrollmentId: enrollment.id });
  const index = state.enrollments.findIndex(item => item.id === enrollment.id);
  if (index >= 0) state.enrollments[index] = enrollment; else state.enrollments.unshift(enrollment);
  if (previousHash && nextHash && previousHash !== nextHash) {
    clearConsentChecks('The stored source video changed. Review every permission again.');
  } else if (nextHash && state.consentSourceSignature && state.videoFile && state.consentSourceSignature === videoSignature()) {
    state.consentSourceHash = nextHash;
  }
  renderEnrollmentResume();
  updateProgress();
  return enrollment;
}

function sourceVideoVerified(enrollment) {
  return Boolean(enrollment?.sourceVideo?.sha256 && /^[a-f0-9]{64}$/i.test(enrollment.sourceVideo.sha256));
}

async function submitEnrollmentConsent(enrollment) {
  if (!sourceVideoVerified(enrollment)) throw new Error('The server has not finished verifying this video.');
  if (!consentInputs().every(input => input.checked)) {
    setStep(3);
    wizardStatus('Review and confirm every permission for the verified source video.', 'error');
    return null;
  }
  if (state.videoFile && state.consentSourceSignature && state.consentSourceSignature !== videoSignature()) {
    clearConsentChecks('The selected video changed. Review every permission again.');
    setStep(3);
    return null;
  }
  if (state.consentSourceHash && state.consentSourceHash !== enrollment.sourceVideo.sha256) {
    clearConsentChecks('The verified video hash changed. Review every permission again.');
    setStep(3);
    return null;
  }
  state.consentSourceHash = enrollment.sourceVideo.sha256;
  const resume = ensureResumeMetadata();
  const consentIdempotencyKey = resume.consentIdempotencyKey || createIdempotencyKey();
  updateResumeMetadata({ consentIdempotencyKey });
  const data = await api('/api/video-os-lite/enrollments', {
    method: 'POST',
    body: JSON.stringify({
      ...enrollmentBody('consent', enrollment, consentIdempotencyKey),
      policyVersion: ENROLLMENT_POLICY_VERSION,
      purpose: ENROLLMENT_PURPOSE,
      sourceVideoSha256: enrollment.sourceVideo.sha256,
      audioExtractionAuthorization: true,
      faceAuthorization: true,
      voiceAuthorization: true,
      providerProcessingAuthorization: true,
      archiveDeleteAcknowledgment: true,
      temporaryPublicProviderExposureAuthorization: true,
    }),
  });
  return setEnrollment(data.enrollment);
}

async function readBackProviderReconsent(enrollmentId) {
  const data = await api(`/api/video-os-lite/enrollments?enrollmentId=${encodeURIComponent(enrollmentId)}`);
  const enrollment = setEnrollment(data.enrollment, { persistResume: false });
  return { enrollment, confirmed: providerBridgeConsentActive(enrollment) };
}

async function submitProviderReconsent() {
  const enrollment = state.activeEnrollment;
  const requestKey = state.providerReconsentIdempotencyKey || createIdempotencyKey();
  state.providerReconsentIdempotencyKey = requestKey;
  let request;
  try {
    request = buildProviderReconsentRequest(enrollment, requestKey);
  } catch (error) {
    wizardStatus(error.message, 'error');
    notice(error.message, 'error', 'wizard');
    return;
  }

  setWizardBusy(true, 'Saving updated consent. This action does not start a provider upload.');
  notice('Saving updated provider consent. No provider upload is being started.', 'info', 'wizard');
  try {
    const data = await api('/api/video-os-lite/enrollments', { method: 'POST', body: JSON.stringify(request) });
    const updated = setEnrollment(data.enrollment, { persistResume: false });
    if (!providerBridgeConsentActive(updated)) throw new Error('The server did not confirm updated provider consent. Reload to check before trying again.');
    await Promise.all([loadIdentities(), loadEnrollments()]);
    closeWizard(true);
    notice('Updated provider consent is saved. No provider upload was started.', 'success');
  } catch (error) {
    if (isProviderReconsentUncertain(error)) {
      try {
        const readback = await readBackProviderReconsent(enrollment.id);
        if (readback.confirmed) {
          await Promise.all([loadIdentities(), loadEnrollments()]);
          closeWizard(true);
          notice('Updated provider consent is saved. No provider upload was started.', 'success');
          return;
        }
        wizardStatus('The save result is still unconfirmed. Reload this page to read the current consent state before trying again.', 'error');
        notice('Updated consent is unconfirmed. No provider upload was started by this screen.', 'error', 'wizard');
      } catch {
        wizardStatus('The save result could not be read back. Reload this page before trying again.', 'error');
        notice('Updated consent is unconfirmed. No provider upload was started by this screen.', 'error', 'wizard');
      }
    } else {
      wizardStatus(error.message, 'error');
      notice(error.message, 'error', 'wizard');
    }
  } finally {
    setWizardBusy(false);
  }
}

function uploadProgressMessage(progress) {
  const percentage = Number(progress?.percentage);
  if (Number.isFinite(percentage)) return `Uploading the phone video: ${Math.max(0, Math.min(100, Math.round(percentage)))}%.`;
  const loaded = Number(progress?.loaded || progress?.loadedBytes);
  const total = Number(progress?.total || progress?.totalBytes);
  if (Number.isFinite(loaded) && Number.isFinite(total) && total > 0) return `Uploading the phone video: ${Math.round(loaded / total * 100)}%.`;
  return 'Uploading the phone video securely.';
}

async function uploadAndReconcile(enrollment, instruction) {
  if (!state.videoFile) {
    setStep(2);
    throw new Error('Choose the original phone video again to resume its private upload. The file was not stored in this browser.');
  }
  state.uploadController?.abort();
  state.uploadController = new AbortController();
  $('#creating-detail').textContent = 'Uploading the phone video securely. Progress shown here is transfer progress only.';
  await uploadEnrollmentVideo(instruction, state.videoFile, {
    abortSignal: state.uploadController.signal,
    onUploadProgress: progress => { $('#creating-detail').textContent = uploadProgressMessage(progress); },
  });
  state.uploadController = null;
  let current = enrollment;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const reconciled = await api('/api/video-os-lite/enrollments', {
        method: 'POST',
        body: JSON.stringify({ action: 'reconcile-upload', contractVersion: ENROLLMENT_CONTRACT_VERSION, enrollmentId: current.id, expectedStateVersion: current.stateVersion }),
      });
      return setEnrollment(reconciled.enrollment);
    } catch (error) {
      if (error.status !== 409) throw error;
      const readback = await api(`/api/video-os-lite/enrollments?enrollmentId=${encodeURIComponent(current.id)}`);
      current = setEnrollment(readback.enrollment);
      if (current.status !== 'AWAITING_UPLOAD') return current;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw Object.assign(new Error('The video upload is saved, but its processing state has not caught up yet. Check status before uploading again.'), { status: 409, code: 'upload_reconciliation_pending' });
}

async function requestEnrollmentRetry(enrollment) {
  const action = enrollment.retry?.action === 'upload-instructions' ? 'upload-instructions' : 'retry';
  const resume = ensureResumeMetadata();
  const retryIdempotencyKey = resume.retryIdempotencyKey || createIdempotencyKey();
  if (action === 'retry') updateResumeMetadata({ retryIdempotencyKey });
  const body = action === 'retry'
    ? enrollmentBody(action, enrollment, retryIdempotencyKey)
    : { action, contractVersion: ENROLLMENT_CONTRACT_VERSION, enrollmentId: enrollment.id, expectedStateVersion: enrollment.stateVersion };
  const data = await api('/api/video-os-lite/enrollments', { method: 'POST', body: JSON.stringify(body) });
  if (data.enrollment) setEnrollment(data.enrollment);
  if (data.upload) state.uploadInstruction = data.upload;
  return data;
}

async function advanceEnrollment(enrollment) {
  setEnrollment(enrollment);
  if (enrollment.status === 'AWAITING_UPLOAD') {
    const retry = state.uploadInstruction ? { enrollment, upload: state.uploadInstruction } : await requestEnrollmentRetry(enrollment);
    setStep(4);
    return advanceEnrollment(await uploadAndReconcile(retry.enrollment || enrollment, retry.upload));
  }
  if (enrollment.status === 'AWAITING_EXTRACTION_CONSENT') {
    const consented = await submitEnrollmentConsent(enrollment);
    if (consented) return advanceEnrollment(consented);
    return;
  }
  if (['SOURCE_HASHING', 'EXTRACTION_QUEUED', 'EXTRACTING'].includes(enrollment.status)) {
    setStep(4);
    scheduleEnrollmentPolling();
    return;
  }
  if (enrollment.status === 'IDENTITY_READY') {
    clearResumeMetadata();
    stopEnrollmentPolling();
    if (enrollment.identity?.id) state.activeIdentityId = enrollment.identity.id;
    await loadIdentities().catch(() => {});
    updateProgress();
    setStep(5);
    return;
  }
  if (enrollment.status === 'FAILED') {
    setStep(4);
    showEnrollmentRecovery(enrollment.failure?.message || 'Enrollment could not complete.', enrollment.retry?.allowed === true);
    return;
  }
  if (['REVOKED', 'EXPIRED'].includes(enrollment.status)) {
    clearResumeMetadata();
    stopEnrollmentPolling();
    throw new Error(`This enrollment is ${enrollment.status.toLowerCase()} and cannot continue.`);
  }
}

async function createOrResumeEnrollment() {
  const displayName = $('#identity-name').value.trim();
  if (state.activeEnrollment?.id) return advanceEnrollment(state.activeEnrollment);
  if (!state.photoFile || !state.videoFile) throw new Error('The photo and phone video are required before enrollment.');
  const resume = ensureResumeMetadata();
  setStep(4);
  $('#creating-detail').textContent = 'Storing the authorized photo before creating the private video upload.';
  if (!state.photoAssetId) {
    const photo = await uploadPhoto(state.photoFile, resume.createIdempotencyKey);
    state.photoAssetId = photo.assetId;
  }
  const data = await api('/api/video-os-lite/enrollments', {
    method: 'POST',
    body: JSON.stringify({
      action: 'create', contractVersion: ENROLLMENT_CONTRACT_VERSION, idempotencyKey: resume.createIdempotencyKey,
      displayName, photoAssetId: state.photoAssetId, filename: state.videoFile.name, contentType: state.videoFile.type, bytes: state.videoFile.size,
    }),
  });
  const enrollment = setEnrollment(data.enrollment);
  state.uploadInstruction = data.upload || null;
  return advanceEnrollment(enrollment);
}

async function commitEnrollment() {
  if (!validateStep()) return;
  setWizardBusy(true, 'Saving this exact photo and phone video enrollment.');
  notice('Saving your private enrollment sources. No provider creation starts in this step.');
  try {
    await createOrResumeEnrollment();
  } catch (error) {
    if (isUncertainError(error) && !state.activeEnrollment?.id) {
      state.uncertainCommit = { createIdempotencyKey: ensureResumeMetadata().createIdempotencyKey };
      showCommitUncertain(true);
      if (state.step !== 3) setStep(3);
      wizardStatus('The connection was lost before the saved enrollment state was confirmed.', 'error');
      notice('Enrollment outcome is unknown. Check the saved enrollment before retrying.', 'error', 'wizard');
    } else {
      if (state.step !== 2) setStep(4);
      showEnrollmentRecovery(error.message, true);
      notice(error.message, 'error', 'wizard');
    }
  } finally {
    setWizardBusy(false);
  }
}

async function checkEnrollment() {
  $('#check-my-identities').disabled = true;
  try {
    await loadEnrollments();
    const found = activeResumeEnrollment();
    if (!found) {
      wizardStatus('No saved enrollment was found yet. Retry the same request only with these unchanged inputs.', 'error');
      return;
    }
    state.uncertainCommit = null;
    showCommitUncertain(false);
    setEnrollment(found);
    notice('Found the saved enrollment. Continuing from its current state.', 'success', 'wizard');
    await advanceEnrollment(found);
  } catch (error) {
    wizardStatus(error.message, 'error');
  } finally {
    $('#check-my-identities').disabled = false;
  }
}

function retryCommitSameRequest() {
  state.uncertainCommit = null;
  showCommitUncertain(false);
  void commitEnrollment();
}

async function next() {
  if (!validateStep()) return;
  if (state.step === 1) return setStep(2);
  if (state.step === 2) {
    state.consentSourceSignature = videoSignature();
    return setStep(3);
  }
  if (state.providerReconsentMode) return submitProviderReconsent();
  return commitEnrollment();
}

function progressCard(label, value) {
  const card = document.createElement('div');
  card.className = 'progress-card';
  const title = document.createElement('strong'); title.textContent = label;
  const status = document.createElement('span'); status.textContent = value;
  card.append(title, status);
  return card;
}

function enrollmentProgressCards(enrollment) {
  const sourceState = enrollment?.sourceVideo?.state || (enrollment?.status === 'AWAITING_UPLOAD' ? 'Awaiting upload' : 'Stored');
  const audioState = enrollment?.derivedAudio?.state || ({
    AWAITING_UPLOAD: 'Waiting for video', SOURCE_HASHING: 'Waiting for verification', AWAITING_EXTRACTION_CONSENT: 'Waiting for permission',
    EXTRACTION_QUEUED: 'Queued', EXTRACTING: 'Extracting', IDENTITY_READY: 'Prepared',
  }[enrollment?.status] || 'Not started');
  return [
    progressCard('Photo', 'Saved'),
    progressCard('Phone video', statusLabel(sourceState)),
    progressCard('Reusable voice', statusLabel(audioState)),
    progressCard('Presenter creation', enrollment?.identity ? statusLabel(enrollment.identity.avatarStatus || 'DRAFT') : 'Not started'),
    progressCard('Voice creation', enrollment?.identity ? statusLabel(enrollment.identity.voiceStatus || 'DRAFT') : 'Not started'),
  ];
}

function providerProgressCards(identity) {
  return [progressCard('Photo avatar', statusLabel(identity?.avatarStatus || 'DRAFT')), progressCard('Reusable voice', statusLabel(identity?.voiceStatus || 'DRAFT'))];
}

function updateProgress() {
  const identity = state.identities.find(item => item.id === state.activeIdentityId) || state.activeEnrollment?.identity || null;
  const linkedEnrollment = state.activeEnrollment?.identity?.id === identity?.id
    ? state.activeEnrollment
    : linkedEnrollmentForIdentity(identity?.id);
  const showingEnrollment = Boolean(state.activeEnrollment && state.activeEnrollment.status !== 'IDENTITY_READY');
  $('#component-progress').replaceChildren(...(showingEnrollment ? enrollmentProgressCards(state.activeEnrollment) : providerProgressCards(identity)));
  const readyUseLink = $('#ready-use-link');
  readyUseLink.href = identity?.ready && identity.id ? `/?identityId=${encodeURIComponent(identity.id)}` : '/';
  readyUseLink.setAttribute('aria-disabled', String(!(identity?.ready && identity.id)));
  readyUseLink.textContent = identity?.ready ? 'Use in Video OS' : 'Available after final creation';
  $('#ready-copy').textContent = identity?.ready
    ? 'Your authorized presenter and reusable voice are ready for Standard and Premium scripts.'
    : 'Your photo and reusable voice are prepared. Final presenter creation has not started.';
  const lifecycleStatus = $('#ready-provider-status');
  const lifecycle = providerLifecyclePresentation(linkedEnrollment?.providerLifecycle);
  lifecycleStatus.hidden = !lifecycle;
  lifecycleStatus.textContent = lifecycle ? `${lifecycle.label}. ${lifecycle.detail}` : '';
  if (lifecycle) lifecycleStatus.dataset.state = lifecycle.state; else lifecycleStatus.removeAttribute('data-state');
}

function showEnrollmentRecovery(message, retryAllowed) {
  $('#enrollment-recovery').hidden = false;
  $('#enrollment-recovery-message').textContent = message;
  $('#retry-enrollment').hidden = !retryAllowed;
}

function hideEnrollmentRecovery() {
  $('#enrollment-recovery').hidden = true;
  $('#enrollment-recovery-message').textContent = '';
}

function stopEnrollmentPolling() {
  clearTimeout(state.enrollmentPollTimer);
  state.enrollmentPollTimer = null;
  state.enrollmentPollCount = 0;
}

function scheduleEnrollmentPolling() {
  if (state.enrollmentPollTimer || state.enrollmentPollCount >= ENROLLMENT_POLL_LIMIT || !state.activeEnrollment?.id) return;
  state.enrollmentPollTimer = setTimeout(pollEnrollment, ENROLLMENT_POLL_MS);
}

async function pollEnrollment() {
  state.enrollmentPollTimer = null;
  state.enrollmentPollCount += 1;
  try {
    const data = await api(`/api/video-os-lite/enrollments?enrollmentId=${encodeURIComponent(state.activeEnrollment.id)}`);
    hideEnrollmentRecovery();
    await advanceEnrollment(data.enrollment);
  } catch (error) {
    showEnrollmentRecovery(`Status check paused: ${error.message}`, true);
  }
  if (state.activeEnrollment && ENROLLMENT_ACTIVE_STATES.has(state.activeEnrollment.status) && state.enrollmentPollCount < ENROLLMENT_POLL_LIMIT) scheduleEnrollmentPolling();
  else if (state.enrollmentPollCount >= ENROLLMENT_POLL_LIMIT) showEnrollmentRecovery('Automatic checks paused. Your durable enrollment remains saved.', true);
}

async function retryEnrollment() {
  if (!state.activeEnrollment) return;
  $('#retry-enrollment').disabled = true;
  hideEnrollmentRecovery();
  try {
    updateResumeMetadata({ retryIdempotencyKey: createIdempotencyKey() });
    const data = await requestEnrollmentRetry(state.activeEnrollment);
    await advanceEnrollment(data.enrollment || state.activeEnrollment);
  } catch (error) {
    showEnrollmentRecovery(error.message, true);
  } finally {
    $('#retry-enrollment').disabled = false;
  }
}

async function checkActiveEnrollment() {
  if (!state.activeEnrollment?.id) return;
  $('#check-enrollment').disabled = true;
  try {
    const data = await api(`/api/video-os-lite/enrollments?enrollmentId=${encodeURIComponent(state.activeEnrollment.id)}`);
    await advanceEnrollment(data.enrollment);
  } catch (error) {
    showEnrollmentRecovery(error.message, true);
  } finally {
    $('#check-enrollment').disabled = false;
  }
}

async function revokeActiveEnrollment() {
  const enrollment = activeResumeEnrollment();
  if (!enrollment || !window.confirm('Cancel this enrollment? Its saved consent and processing state will be revoked.')) return;
  try {
    const key = state.resume?.revokeIdempotencyKey || createIdempotencyKey();
    updateResumeMetadata({ revokeIdempotencyKey: key, enrollmentId: enrollment.id });
    await api('/api/video-os-lite/enrollments', { method: 'POST', body: JSON.stringify(enrollmentBody('revoke', enrollment, key)) });
    clearResumeMetadata();
    state.activeEnrollment = null;
    await loadEnrollments();
    notice('Enrollment cancelled.', 'success');
  } catch (error) { notice(error.message, 'error'); }
}

async function openEnrollmentResume() {
  const enrollment = activeResumeEnrollment();
  if (!enrollment) return;
  setProviderReconsentMode(false);
  state.activeEnrollment = enrollment;
  state.activeIdentityId = enrollment.identity?.id || null;
  state.wizardOpener = document.activeElement;
  $('#wizard').showModal();
  $('#identity-name').value = enrollment.displayName || enrollment.identity?.displayName || '';
  if (enrollment.status === 'AWAITING_UPLOAD') {
    setStep(2);
    wizardStatus('Choose the original video again to resume. Browser storage never retains the file.');
  } else if (enrollment.status === 'AWAITING_EXTRACTION_CONSENT') {
    state.consentSourceHash = enrollment.sourceVideo?.sha256 || null;
    setStep(3);
    wizardStatus('Review every permission for the server-verified video.');
  } else if (enrollment.status === 'IDENTITY_READY') {
    updateProgress();
    setStep(5);
  } else {
    setStep(4);
    updateProgress();
    if (enrollment.status === 'FAILED') showEnrollmentRecovery(enrollment.failure?.message || 'Enrollment needs attention.', enrollment.retry?.allowed === true);
    else scheduleEnrollmentPolling();
  }
}

function openProviderReconsent(enrollment) {
  if ($('#wizard').open) return;
  const requestKey = createIdempotencyKey();
  try {
    buildProviderReconsentRequest(enrollment, requestKey);
  } catch (error) {
    notice(error.message, 'error');
    return;
  }
  state.activeEnrollment = enrollment;
  state.activeIdentityId = enrollment.identity.id;
  state.providerReconsentIdempotencyKey = requestKey;
  state.wizardOpener = document.activeElement;
  clearConsentChecks();
  state.consentSourceHash = enrollment.sourceVideo.sha256;
  setProviderReconsentMode(true);
  $('#identity-name').value = enrollment.displayName || 'Existing identity';
  $('#wizard').showModal();
  setStep(3);
  wizardStatus('Review and confirm all six permissions. Saving consent does not start a provider upload.');
}

async function submitIdentity(identityId, openProgress = true) {
  if (!state.providerSubmissionEnabled) return notice('Provider creation is held until privacy, entitlement, and cost checks pass.', 'error');
  if (!providerBridgeConsentActive(linkedEnrollmentForIdentity(identityId))) {
    return notice('Review the updated provider exposure permission before provider creation.', 'error');
  }
  if (openProgress) {
    state.activeEnrollment = null;
    state.activeIdentityId = identityId;
    state.wizardOpener = document.activeElement;
    if (!$('#wizard').open) $('#wizard').showModal();
    setStep(4);
  }
  setWizardBusy(true, 'Starting provider presenter creation.');
  try {
    await api('/api/video-os-lite/identities', { method: 'POST', body: JSON.stringify({ action: 'submit', identityId }) });
    await Promise.all([loadIdentities(), loadEnrollments()]);
    updateProgress();
    scheduleIdentityPolling();
  } catch (error) {
    notice(error.message, 'error');
    wizardStatus(error.message, 'error');
    await Promise.all([loadIdentities(), loadEnrollments()]).catch(() => {});
    updateProgress();
  } finally { setWizardBusy(false); }
}

function showPollingExhausted(show) {
  $('#polling-exhausted').hidden = !show;
}

function stopIdentityPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.pollCount = 0;
  showPollingExhausted(false);
}

function scheduleIdentityPolling() {
  if (state.pollTimer || state.pollCount >= 45) return;
  state.pollTimer = setTimeout(pollIdentities, 8_000);
}

function resumeIdentityPolling() {
  state.pollCount = 0;
  showPollingExhausted(false);
  scheduleIdentityPolling();
}

async function pollIdentities() {
  state.pollTimer = null;
  state.pollCount += 1;
  const active = state.identities.filter(identity => ['CREATING_AVATAR', 'CLONING_VOICE', 'PROCESSING'].includes(identity.overallStatus));
  try {
    await Promise.all(active.map(identity => api('/api/video-os-lite/identities', { method: 'POST', body: JSON.stringify({ action: 'refresh', identityId: identity.id }) })));
    await Promise.all([loadIdentities(), loadEnrollments()]);
    updateProgress();
  } catch {
    notice('Status check paused. Your durable processing state is safe; refresh to resume.', 'error');
  }
  const stillProcessing = state.identities.some(identity => ['CREATING_AVATAR', 'CLONING_VOICE', 'PROCESSING'].includes(identity.overallStatus));
  if (!stillProcessing) return;
  if (state.pollCount < 45) scheduleIdentityPolling(); else showPollingExhausted(true);
}

async function retryIdentityComponent(identityId, component) {
  try {
    await api('/api/video-os-lite/identities', { method: 'POST', body: JSON.stringify({ action: 'retry', identityId, component }) });
    notice(`${component === 'avatar' ? 'Avatar' : 'Voice'} retry started.`, 'success');
    await Promise.all([loadIdentities(), loadEnrollments()]);
    scheduleIdentityPolling();
  } catch (error) { notice(error.message, 'error'); }
}

async function archiveIdentity(identityId, name) {
  if (!window.confirm(`Archive “${name}”? It will leave My Cast and its active consent will be revoked.`)) return;
  try {
    await api('/api/video-os-lite/identities', { method: 'POST', body: JSON.stringify({ action: 'archive', identityId }) });
    notice('Identity archived and removed from My Cast.', 'success');
    await loadIdentities();
  } catch (error) { notice(error.message, 'error'); }
}

function resetVideoPresentation() {
  const live = $('#video-live');
  live.pause?.();
  live.srcObject = null;
  live.hidden = true;
  const preview = $('#video-preview');
  preview.pause?.();
  preview.removeAttribute('src');
  preview.hidden = true;
  $('#video-placeholder').hidden = false;
  $('#video-recording-state').hidden = true;
  $('#video-review-actions').hidden = true;
  $('#video-metadata').textContent = '';
  $('#native-capture-label').hidden = true;
}

function cleanupCapture({ invalidate = false } = {}) {
  if (invalidate) state.captureRequestToken += 1;
  clearInterval(state.recordingTimer);
  state.recordingTimer = null;
  const active = state.recorder;
  if (active?.mediaRecorder && active.mediaRecorder.state !== 'inactive') {
    active.mediaRecorder.ondataavailable = null;
    active.mediaRecorder.onstop = null;
    try { active.mediaRecorder.stop(); } catch {}
  }
  for (const track of active?.stream?.getTracks?.() || []) track.stop();
  state.recorder = null;
  $('#video-recording-state').hidden = true;
  $('#record-button').disabled = false;
  $('#video-live').srcObject = null;
  $('#video-live').hidden = true;
}

function chooseRecorderMimeType() {
  for (const type of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return '';
}

function inspectVideoFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    const finish = (error, value) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load?.();
      URL.revokeObjectURL(url);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('The video took too long to read. Try a shorter MP4 or WebM file.')), 12_000);
    video.onloadedmetadata = () => finish(null, { duration: video.duration, width: video.videoWidth, height: video.videoHeight });
    video.onerror = () => finish(new Error('This browser could not read the video metadata. Try MP4, MOV, or WebM.'));
    video.src = url;
    video.load?.();
  });
}

async function validateVideoFile(file) {
  if (!file) throw new Error('Record or choose your phone video first.');
  if (!state.videoLimits.allowedContentTypes.includes(String(file.type || '').toLowerCase()) || !VIDEO_TYPES.has(String(file.type || '').toLowerCase())) throw new Error('Use an MP4, MOV, or WebM phone video.');
  if (!file.size) throw new Error('The selected video is empty.');
  if (file.size > Math.min(DEFAULT_VIDEO_LIMITS.maximumSizeInBytes, state.videoLimits.maximumSizeInBytes)) throw new Error('The phone video must be 100 MiB or smaller.');
  const metadata = await inspectVideoFile(file);
  if (!Number.isFinite(metadata.duration) || metadata.duration < state.videoLimits.minimumDurationSeconds || metadata.duration > state.videoLimits.maximumDurationSeconds) {
    throw new Error(`Use a video between ${state.videoLimits.minimumDurationSeconds} and ${state.videoLimits.maximumDurationSeconds} seconds.`);
  }
  if (!metadata.width || !metadata.height || metadata.width > state.videoLimits.maximumDimensionPx || metadata.height > state.videoLimits.maximumDimensionPx) {
    throw new Error(`Use a video no larger than ${state.videoLimits.maximumDimensionPx} pixels on either side.`);
  }
  return metadata;
}

async function handleVideoFile(file, control = $('#video-input')) {
  clearFieldError(control, $('#video-error'));
  if (!file) return;
  try {
    const metadata = await validateVideoFile(file);
    revokeObjectUrl('videoUrl');
    state.videoFile = file;
    state.videoMetadata = metadata;
    state.videoAccepted = false;
    state.videoUrl = URL.createObjectURL(file);
    const preview = $('#video-preview');
    setLocalPreviewSource(preview, state.videoUrl);
    preview.hidden = false;
    $('#video-live').hidden = true;
    $('#video-placeholder').hidden = true;
    $('#video-review-actions').hidden = false;
    $('#video-metadata').textContent = `${metadata.duration.toFixed(metadata.duration < 10 ? 1 : 0)} seconds · ${metadata.width} × ${metadata.height} · ${(file.size / 1024 / 1024).toFixed(1)} MiB`;
    clearConsentChecks('Preview the video, then choose Use this video.');
    notice('');
  } catch (error) {
    control.value = '';
    showFieldError(control, $('#video-error'), `${error.message} Your previous valid video was kept.`);
  }
}

async function startRecording() {
  clearFieldError($('#record-button'), $('#video-error'));
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    $('#native-capture-label').hidden = false;
    showFieldError($('#record-button'), $('#video-error'), 'In-browser recording is unavailable. Use your phone camera or choose an existing video.');
    return;
  }
  const requestToken = ++state.captureRequestToken;
  $('#record-button').disabled = true;
  $('#video-recording-status').textContent = 'Requesting camera and microphone access.';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1080 }, height: { ideal: 1920 } }, audio: { echoCancellation: true, noiseSuppression: true } });
    if (requestToken !== state.captureRequestToken || !$('#wizard').open || state.step !== 2) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const mimeType = chooseRecorderMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks = [];
    const startedAt = Date.now();
    state.recorder = { stream, mediaRecorder: recorder, chunks, startedAt, mimeType: recorder.mimeType || mimeType || 'video/webm' };
    const live = $('#video-live');
    live.srcObject = stream;
    live.hidden = false;
    $('#video-preview').hidden = true;
    $('#video-placeholder').hidden = true;
    $('#video-recording-state').hidden = false;
    $('#video-recording-status').textContent = 'Recording started.';
    await live.play().catch(() => {});
    recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      const snapshot = state.recorder;
      stream.getTracks().forEach(track => track.stop());
      clearInterval(state.recordingTimer);
      state.recordingTimer = null;
      state.recorder = null;
      $('#video-recording-state').hidden = true;
      $('#record-button').disabled = false;
      live.srcObject = null;
      live.hidden = true;
      if (requestToken !== state.captureRequestToken) return;
      const type = snapshot?.mimeType?.split(';')[0] || 'video/webm';
      const extension = type === 'video/mp4' ? 'mp4' : 'webm';
      const file = new File(chunks, `identity-video.${extension}`, { type, lastModified: Date.now() });
      $('#video-recording-status').textContent = 'Recording stopped. Validating the preview.';
      await handleVideoFile(file, $('#record-button'));
    };
    recorder.start(1_000);
    state.recordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1_000);
      $('#recording-time').textContent = `Recording ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
      if (elapsed >= state.videoLimits.maximumDurationSeconds) stopRecording();
    }, 1_000);
  } catch {
    if (requestToken !== state.captureRequestToken) return;
    $('#record-button').disabled = false;
    $('#native-capture-label').hidden = false;
    showFieldError($('#record-button'), $('#video-error'), 'Camera or microphone access was not granted. Use your phone camera or choose an existing video.');
  }
}

function stopRecording() {
  const recorder = state.recorder?.mediaRecorder;
  if (!recorder || recorder.state === 'inactive') return;
  $('#video-recording-status').textContent = 'Stopping recording.';
  recorder.stop();
}

function acceptVideo() {
  if (!state.videoFile || !state.videoMetadata) return;
  state.videoAccepted = true;
  clearFieldError($('#video-input'), $('#video-error'));
  wizardStatus('Video accepted for this enrollment. Continue to review permissions.');
  $('#next-button').focus();
}

function retakeVideo() {
  if (state.videoFile && !window.confirm('Discard this unsaved video and record or choose another one?')) return;
  cleanupCapture({ invalidate: true });
  revokeObjectUrl('videoUrl');
  state.videoFile = null;
  state.videoMetadata = null;
  state.videoAccepted = false;
  $('#video-input').value = '';
  $('#video-capture-input').value = '';
  resetVideoPresentation();
  clearConsentChecks('Record or choose the replacement video.');
  $('#record-button').focus();
}

function handlePhotoFile(file, control = $('#photo-input')) {
  clearFieldError(control, $('#photo-error'));
  if (!file) return;
  try { validPhotoFile(file); }
  catch (error) {
    control.value = '';
    showFieldError(control, $('#photo-error'), `${error.message} Your previous valid photo was kept.`);
    return;
  }
  state.photoFile = file;
  state.photoAssetId = null;
  revokeObjectUrl('photoUrl');
  state.photoUrl = URL.createObjectURL(file);
  setLocalPreviewSource($('#photo-preview'), state.photoUrl);
  $('#photo-preview').hidden = false;
  $('#photo-prompt').hidden = true;
  clearConsentChecks();
  notice('');
  wizardStatus(`${file.name} selected.`);
}

async function init() {
  $('#loading-state').hidden = false;
  $('#signed-out').hidden = true;
  $('#load-error').hidden = true;
  $('#studio').hidden = true;
  updateSessionLabels('Checking session...');
  try {
    const session = await api('/api/video-os-lite/session');
    state.accountId = session.account?.accountId || session.accountId || null;
    updateSessionLabels(session.email || session.account?.name || 'Private account');
    await Promise.all([loadIdentities(), loadEnrollments()]);
    $('#studio').hidden = false;
  } catch (error) {
    if (error.status === 401) {
      updateSessionLabels('Signed out');
      $('#signed-out').hidden = false;
    } else {
      updateSessionLabels('Unavailable');
      $('#load-error').hidden = false;
      notice(error.message, 'error');
    }
  } finally { $('#loading-state').hidden = true; }
}

$('#create-button').addEventListener('click', openWizard);
$('#empty-create-button').addEventListener('click', openWizard);
$('#resume-enrollment').addEventListener('click', openEnrollmentResume);
$('#revoke-enrollment').addEventListener('click', revokeActiveEnrollment);
$('#close-wizard').addEventListener('click', () => closeWizard());
$('#next-button').addEventListener('click', next);
$('#back-button').addEventListener('click', () => setStep(Math.max(1, state.step - 1)));
$('#check-my-identities').addEventListener('click', checkEnrollment);
$('#commit-retry-anyway').addEventListener('click', retryCommitSameRequest);
$('#resume-polling').addEventListener('click', resumeIdentityPolling);
$('#retry-enrollment').addEventListener('click', retryEnrollment);
$('#check-enrollment').addEventListener('click', checkActiveEnrollment);
$('#ready-done').addEventListener('click', () => closeWizard(true));
$('#photo-input').addEventListener('change', event => handlePhotoFile(event.target.files[0] || null, event.target));
$('#photo-capture-input').addEventListener('change', event => handlePhotoFile(event.target.files[0] || null, event.target));
$('#video-input').addEventListener('change', event => handleVideoFile(event.target.files[0] || null, event.target));
$('#video-capture-input').addEventListener('change', event => handleVideoFile(event.target.files[0] || null, event.target));
$('#use-video').addEventListener('click', acceptVideo);
$('#retake-video').addEventListener('click', retakeVideo);
$('#identity-name').addEventListener('input', () => { if ($('#identity-name').value.trim()) clearFieldError($('#identity-name'), $('#identity-name-error')); });
for (const input of consentInputs()) input.addEventListener('change', () => {
  input.removeAttribute('aria-invalid');
  const currentHash = state.activeEnrollment?.sourceVideo?.sha256 || null;
  if (currentHash) state.consentSourceHash = state.consentSourceHash || currentHash;
  else state.consentSourceSignature = state.consentSourceSignature || videoSignature();
  if (consentInputs().every(item => item.checked)) clearConsentError();
});
$('#record-button').addEventListener('click', startRecording);
$('#stop-recording').addEventListener('click', stopRecording);
$('#retry-load').addEventListener('click', () => { notice(''); void init(); });

const wizard = $('#wizard');
wizard.addEventListener('keydown', event => trapFocus(event, wizard));
wizard.addEventListener('cancel', event => { event.preventDefault(); closeWizard(); });
wizard.addEventListener('close', () => {
  resetWizard();
  const opener = state.wizardOpener;
  state.wizardOpener = null;
  if (opener?.isConnected) opener.focus();
});

const menu = $('#mobile-menu');
$('#open-menu').addEventListener('click', () => {
  state.menuOpener = document.activeElement;
  $('#open-menu').setAttribute('aria-expanded', 'true');
  menu.showModal();
  requestAnimationFrame(() => menu.querySelector('a')?.focus());
});
$('#close-menu').addEventListener('click', () => menu.close());
menu.addEventListener('keydown', event => trapFocus(event, menu));
menu.addEventListener('cancel', event => { event.preventDefault(); menu.close(); });
menu.addEventListener('close', () => {
  $('#open-menu').setAttribute('aria-expanded', 'false');
  const opener = state.menuOpener;
  state.menuOpener = null;
  if (opener?.isConnected) opener.focus();
});
menu.querySelectorAll('a').forEach(link => link.addEventListener('click', () => menu.close()));

$('#ready-use-link').addEventListener('click', event => { if ($('#ready-use-link').getAttribute('aria-disabled') === 'true') event.preventDefault(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) cleanupCapture({ invalidate: true }); });
window.addEventListener('beforeunload', () => {
  cleanupCapture({ invalidate: true });
  state.uploadController?.abort();
  stopEnrollmentPolling();
  stopIdentityPolling();
});

void init();
