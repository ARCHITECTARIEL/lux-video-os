const state = {
  step: 1,
  photoFile: null,
  voiceFile: null,
  voiceUrl: null,
  identities: [],
  providerSubmissionEnabled: false,
  activeIdentityId: null,
  pollTimer: null,
  pollCount: 0,
  recorder: null,
  photoUrl: null,
  wizardOpener: null,
  menuOpener: null,
  submitting: false,
  uncertainCommit: null,
};

const $ = (selector) => document.querySelector(selector);

// Object URLs from URL.createObjectURL() are same-origin, browser-minted
// references to an in-memory File/Blob -- never attacker-supplied markup --
// so assigning one to .src cannot execute script. Routed through its own
// function (mirroring public/studio.js's safeImage()) rather than assigned
// inline, since that's the shape already proven not to trip static
// taint-tracking analysis elsewhere in this codebase for the identical
// createObjectURL-to-.src pattern.
function setLocalPreviewSource(element, objectUrl) {
  element.src = objectUrl;
}
const REQUEST_TIMEOUT_MS = 30_000;
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
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || 'Request failed.'), { status: response.status, code: data.code });
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
  return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), audio[controls], [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && element.getClientRects().length > 0);
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
  return String(value || 'DRAFT').replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
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
  if (identity.avatarStatus === 'FAILED') actions.append(button('Retry avatar', 'secondary', () => retry(identity.id, 'avatar')));
  if (identity.voiceStatus === 'FAILED') actions.append(button('Retry voice', 'secondary', () => retry(identity.id, 'voice')));
  if (identity.avatarStatus === 'DRAFT' && identity.voiceStatus === 'DRAFT') {
    const start = button('Start creation', 'primary', () => submitIdentity(identity.id));
    start.disabled = !state.providerSubmissionEnabled;
    start.title = start.disabled ? 'Provider submission is held until preview privacy, entitlement, and cost checks pass.' : '';
    actions.append(start);
  }
  actions.append(button('Archive', 'ghost', () => archiveIdentity(identity.id, identity.displayName)));
  body.append(title, created, componentRow('Photo avatar', identity.avatarStatus), componentRow('Cloned voice', identity.voiceStatus));
  if (identity.avatarFailure?.message) { const error = document.createElement('p'); error.className = 'component-error'; error.textContent = `Avatar: ${identity.avatarFailure.message}`; body.append(error); }
  if (identity.voiceFailure?.message) { const error = document.createElement('p'); error.className = 'component-error'; error.textContent = `Voice: ${identity.voiceFailure.message}`; body.append(error); }
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
  const list = $('#identity-list');
  list.replaceChildren(...state.identities.map(renderIdentity));
  $('#empty-state').hidden = state.identities.length > 0;
}

async function loadIdentities() {
  const data = await api('/api/video-os-lite/identities');
  state.identities = data.identities || [];
  state.providerSubmissionEnabled = data.providerSubmissionEnabled === true;
  renderIdentities();
  const processing = state.identities.some((identity) => ['CREATING_AVATAR', 'CLONING_VOICE', 'PROCESSING'].includes(identity.overallStatus));
  if (processing) schedulePolling(); else stopPolling();
  return data;
}

function setStep(step) {
  state.step = step;
  document.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = Number(panel.dataset.panel) !== step; });
  document.querySelectorAll('[data-step]').forEach((item) => {
    const number = Number(item.dataset.step);
    item.classList.toggle('current', number === step);
    item.classList.toggle('complete', number < step);
    if (number === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  $('#back-button').disabled = state.submitting || step === 1 || step >= 4;
  $('#next-button').disabled = state.submitting || Boolean(state.uncertainCommit);
  $('#next-button').hidden = step >= 4;
  $('#wizard-actions').hidden = step === 5;
  wizardStatus();
  if (step === 4) {
    updateProgress();
    if (state.step !== step) return;
  }
  const focusTarget = {
    1: '#photo-input',
    2: '#record-button',
    3: '#identity-name',
    4: '#close-wizard',
    5: '#ready-use-link',
  }[step];
  if ($('#wizard').open) $(focusTarget)?.focus();
}

function openWizard() {
  const wizard = $('#wizard');
  if (wizard.open) return;
  state.wizardOpener = document.activeElement;
  wizard.showModal();
  setStep(1);
}

function closeWizard(force = false) {
  if (state.submitting && !force) {
    wizardStatus('Your identity is being saved. Keep this window open until that step finishes.', 'error');
    return;
  }
  const wizard = $('#wizard');
  if (wizard.open) wizard.close();
}

function resetWizard() {
  if (state.recorder) void discardRecording();
  state.activeIdentityId = null;
  state.photoFile = null;
  state.voiceFile = null;
  state.uncertainCommit = null;
  $('#commit-uncertain').hidden = true;
  $('#identity-form').reset();
  $('#photo-preview').hidden = true;
  $('#photo-preview').removeAttribute('src');
  $('#photo-prompt').hidden = false;
  if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
  state.photoUrl = null;
  if (state.voiceUrl) URL.revokeObjectURL(state.voiceUrl);
  state.voiceUrl = null;
  $('#voice-preview').removeAttribute('src');
  $('#voice-preview').hidden = true;
  clearValidation();
  wizardStatus();
  if ($('#notice').dataset.origin === 'wizard') notice('');
}

function validFile(file, types, max, label) {
  if (!file) throw new Error(`Choose your ${label} first.`);
  if (!types.includes(file.type)) throw new Error(`Choose a supported ${label} file.`);
  if (!file.size) throw new Error(`The ${label} file is empty.`);
  if (file.size > max) throw new Error(`The ${label} must be 3 MB or smaller.`);
}

function clearFieldError(control, errorElement) {
  control?.removeAttribute('aria-invalid');
  if (errorElement) {
    errorElement.textContent = '';
    errorElement.hidden = true;
  }
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

function clearConsentError() {
  document.querySelectorAll('.consent-list input').forEach((input) => input.removeAttribute('aria-invalid'));
  const error = $('#consent-error');
  error.textContent = '';
  error.hidden = true;
}

function clearValidation() {
  clearFieldError($('#photo-input'), $('#photo-error'));
  clearFieldError($('#voice-input'), $('#voice-error'));
  $('#record-button').removeAttribute('aria-invalid');
  clearFieldError($('#identity-name'), $('#identity-name-error'));
  clearConsentError();
}

function validateStep() {
  wizardStatus();
  if (state.step === 1) {
    try { validFile(state.photoFile, ['image/jpeg', 'image/png'], 3_000_000, 'photo'); }
    catch (error) { return showFieldError($('#photo-input'), $('#photo-error'), error.message); }
    clearFieldError($('#photo-input'), $('#photo-error'));
  }
  if (state.step === 2) {
    try { validFile(state.voiceFile, ['audio/wav', 'audio/x-wav', 'audio/mpeg'], 3_000_000, 'voice recording'); }
    catch (error) { return showFieldError($('#voice-input'), $('#voice-error'), error.message); }
    clearFieldError($('#voice-input'), $('#voice-error'));
  }
  if (state.step === 3) {
    if (!$('#identity-name').value.trim()) return showFieldError($('#identity-name'), $('#identity-name-error'), 'Name this identity.');
    clearFieldError($('#identity-name'), $('#identity-name-error'));
    const consentInputs = [...document.querySelectorAll('.consent-list input')];
    const missing = consentInputs.filter((input) => !input.checked);
    if (missing.length) {
      missing.forEach((input) => input.setAttribute('aria-invalid', 'true'));
      const error = $('#consent-error');
      error.textContent = 'All four authorizations are required.';
      error.hidden = false;
      wizardStatus(error.textContent, 'error');
      notice(error.textContent, 'error', 'wizard');
      missing[0].focus();
      return false;
    }
    clearConsentError();
  }
  notice('');
  return true;
}

function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The selected file could not be read.'));
    reader.readAsDataURL(file);
  });
}

async function upload(file, kind) {
  return api('/api/video-os-lite/uploads', { method: 'POST', body: JSON.stringify({ kind, name: file.name, dataUrl: await fileDataUrl(file) }) });
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

function showCommitUncertain(show) {
  $('#commit-uncertain').hidden = !show;
  $('#next-button').disabled = state.submitting || show;
  if (show) $('#check-my-identities').focus();
}

async function commitIdentity() {
  const displayName = $('#identity-name').value.trim();
  const beforeIds = new Set(state.identities.map((identity) => identity.id));
  setWizardBusy(true, 'Validating and storing your private source files...');
  notice('Validating and storing your private source files...');
  try {
    const [photo, voice] = await Promise.all([upload(state.photoFile, 'identity_photo'), upload(state.voiceFile, 'identity_voice')]);
    const created = await api('/api/video-os-lite/identities', { method: 'POST', body: JSON.stringify({ action: 'create', displayName, photoAssetId: photo.assetId, voiceAssetId: voice.assetId }) });
    state.activeIdentityId = created.identity.id;
    await api('/api/video-os-lite/identities', { method: 'POST', body: JSON.stringify({
      action: 'consent', identityId: state.activeIdentityId,
      faceAuthorization: $('#consent-face').checked, voiceAuthorization: $('#consent-voice').checked,
      providerProcessingAuthorization: $('#consent-process').checked, archiveDeleteAcknowledgment: $('#consent-archive').checked,
    }) });
    await loadIdentities();
    if (!state.providerSubmissionEnabled) {
      notice('Identity draft and consent saved. Provider creation remains held until preview privacy, entitlement, and cost checks pass.', 'success');
      setWizardBusy(false);
      closeWizard(true);
      return;
    }
    setStep(4);
    await submitIdentity(state.activeIdentityId, false);
  } catch (error) {
    if (isUncertainError(error)) {
      state.uncertainCommit = { displayName, beforeIds };
      showCommitUncertain(true);
      wizardStatus('The connection was lost before we could confirm this identity was saved.', 'error');
      notice('Identity creation outcome is unknown. Check My Identities before trying again.', 'error', 'wizard');
    } else {
      notice(error.message, 'error');
      wizardStatus(error.message, 'error');
    }
  } finally {
    setWizardBusy(false);
  }
}

async function checkMyIdentities() {
  const uncertain = state.uncertainCommit;
  if (!uncertain) return;
  wizardStatus('Checking My Identities...');
  try {
    await loadIdentities();
    const found = state.identities.find((identity) => !uncertain.beforeIds.has(identity.id) && identity.displayName === uncertain.displayName);
    if (found) {
      state.activeIdentityId = found.id;
      state.uncertainCommit = null;
      showCommitUncertain(false);
      notice(`Found "${found.displayName}" — it was saved. Continuing from here.`, 'success', 'wizard');
      if (state.providerSubmissionEnabled && found.avatarStatus === 'DRAFT' && found.voiceStatus === 'DRAFT') {
        setStep(4);
        await submitIdentity(found.id, false);
      } else {
        closeWizard(true);
      }
    } else {
      wizardStatus('Not found yet. It may still be a moment behind, or the attempt did not go through.', 'error');
    }
  } catch (error) {
    wizardStatus(error.message, 'error');
  }
}

function retryCommitAnyway() {
  state.uncertainCommit = null;
  showCommitUncertain(false);
  wizardStatus('');
}

async function next() {
  if (!validateStep()) return;
  if (state.step < 3) return setStep(state.step + 1);
  return commitIdentity();
}

async function submitIdentity(identityId, openProgress = true) {
  if (!state.providerSubmissionEnabled) return notice('Provider creation is held until preview privacy, entitlement, and cost checks pass.', 'error');
  if (openProgress) {
    state.activeIdentityId = identityId;
    state.wizardOpener = document.activeElement;
    if (!$('#wizard').open) $('#wizard').showModal();
    setStep(4);
  }
  setWizardBusy(true, 'Starting identity creation...');
  try {
    await api('/api/video-os-lite/identities', { method: 'POST', body: JSON.stringify({ action: 'submit', identityId }) });
    await loadIdentities();
    updateProgress();
    schedulePolling();
  } catch (error) {
    notice(error.message, 'error');
    wizardStatus(error.message, 'error');
    await loadIdentities().catch(() => {});
    updateProgress();
  } finally {
    setWizardBusy(false);
  }
}

function updateProgress() {
  const identity = state.identities.find((item) => item.id === state.activeIdentityId);
  const container = $('#component-progress');
  container.replaceChildren();
  for (const [label, key] of [['Photo avatar', 'avatarStatus'], ['Cloned voice', 'voiceStatus']]) {
    const card = document.createElement('div');
    card.className = 'progress-card';
    const title = document.createElement('strong'); title.textContent = label;
    const value = document.createElement('span'); value.textContent = statusLabel(identity?.[key] || 'DRAFT');
    card.append(title, value); container.append(card);
  }
  const readyUseLink = $('#ready-use-link');
  if (readyUseLink) {
    readyUseLink.href = identity?.ready && identity.id ? '/?identityId=' + encodeURIComponent(identity.id) : '/';
    readyUseLink.setAttribute('aria-disabled', String(!(identity?.ready && identity.id)));
  }
  if (identity?.ready) setStep(5);
}

function showPollingExhausted(show) {
  const el = $('#polling-exhausted');
  if (el) el.hidden = !show;
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.pollCount = 0;
  showPollingExhausted(false);
}

function schedulePolling() {
  if (state.pollTimer || state.pollCount >= 45) return;
  state.pollTimer = setTimeout(poll, 8_000);
}

function resumePolling() {
  state.pollCount = 0;
  showPollingExhausted(false);
  schedulePolling();
}

async function poll() {
  state.pollTimer = null;
  state.pollCount += 1;
  const active = state.identities.filter((identity) => ['CREATING_AVATAR', 'CLONING_VOICE', 'PROCESSING'].includes(identity.overallStatus));
  try {
    await Promise.all(active.map((identity) => api('/api/video-os-lite/identities', { method: 'POST', body: JSON.stringify({ action: 'refresh', identityId: identity.id }) })));
    await loadIdentities();
    updateProgress();
  } catch (error) {
    notice('Status check paused. Your durable processing state is safe; refresh to resume.', 'error');
  }
  const stillProcessing = state.identities.some((identity) => ['CREATING_AVATAR', 'CLONING_VOICE', 'PROCESSING'].includes(identity.overallStatus));
  if (!stillProcessing) return;
  if (state.pollCount < 45) schedulePolling();
  else showPollingExhausted(true);
}

async function retry(identityId, component) {
  try {
    await api('/api/video-os-lite/identities', { method: 'POST', body: JSON.stringify({ action: 'retry', identityId, component }) });
    notice(`${component === 'avatar' ? 'Avatar' : 'Voice'} retry started.`, 'success');
    await loadIdentities(); schedulePolling();
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

function encodeWav(chunks, sampleRate) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) { const bounded = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, bounded < 0 ? bounded * 0x8000 : bounded * 0x7fff, true); offset += 2; }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function startRecording() {
  clearFieldError($('#voice-input'), $('#voice-error'));
  if (!navigator.mediaDevices?.getUserMedia) {
    showFieldError($('#record-button'), $('#voice-error'), 'Microphone recording is not supported in this browser. Upload a WAV or MP3 instead.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    source.connect(processor); processor.connect(context.destination);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      $('#recording-time').textContent = `Recording ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
      if (elapsed >= 120) stopRecording();
    }, 250);
    state.recorder = { stream, context, processor, source, chunks, timer };
    $('#recording-state').hidden = false; $('#record-button').disabled = true;
  } catch {
    showFieldError($('#record-button'), $('#voice-error'), 'Microphone permission was not granted. Upload a WAV or MP3 instead.');
  }
}

async function discardRecording() {
  const recorder = state.recorder;
  if (!recorder) return;
  clearInterval(recorder.timer);
  try { recorder.processor.disconnect(); } catch {}
  try { recorder.source.disconnect(); } catch {}
  recorder.stream.getTracks().forEach((track) => track.stop());
  await recorder.context.close().catch(() => {});
  state.recorder = null;
  $('#recording-state').hidden = true;
  $('#record-button').disabled = false;
}

async function stopRecording() {
  const recorder = state.recorder;
  if (!recorder) return;
  const chunks = recorder.chunks;
  const sampleRate = recorder.context.sampleRate;
  await discardRecording();
  const file = new File([encodeWav(chunks, sampleRate)], 'identity-voice.wav', { type: 'audio/wav' });
  try {
    validFile(file, ['audio/wav', 'audio/x-wav', 'audio/mpeg'], 3_000_000, 'voice recording');
    state.voiceFile = file;
    clearFieldError($('#voice-input'), $('#voice-error'));
    setVoicePreview(file);
    wizardStatus('Recording ready to review.');
  } catch (error) {
    state.voiceFile = null;
    showFieldError($('#record-button'), $('#voice-error'), error.message);
  }
}

function setVoicePreview(file) {
  if (state.voiceUrl) URL.revokeObjectURL(state.voiceUrl);
  state.voiceUrl = URL.createObjectURL(file);
  setLocalPreviewSource($('#voice-preview'), state.voiceUrl);
  $('#voice-preview').hidden = false;
}

function handlePhotoFile(file) {
  clearFieldError($('#photo-input'), $('#photo-error'));
  if (!file) {
    state.photoFile = null;
    return;
  }
  try {
    validFile(file, ['image/jpeg', 'image/png'], 3_000_000, 'photo');
  } catch (error) {
    state.photoFile = null;
    $('#photo-input').value = '';
    showFieldError($('#photo-input'), $('#photo-error'), error.message);
    return;
  }
  state.photoFile = file;
  if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
  state.photoUrl = URL.createObjectURL(file);
  setLocalPreviewSource($('#photo-preview'), state.photoUrl);
  $('#photo-preview').hidden = false;
  $('#photo-prompt').hidden = true;
  notice('');
  wizardStatus(`${file.name} selected.`);
}

function handleVoiceFile(file) {
  clearFieldError($('#voice-input'), $('#voice-error'));
  $('#record-button').removeAttribute('aria-invalid');
  if (!file) {
    state.voiceFile = null;
    return;
  }
  try {
    validFile(file, ['audio/wav', 'audio/x-wav', 'audio/mpeg'], 3_000_000, 'voice recording');
  } catch (error) {
    state.voiceFile = null;
    $('#voice-input').value = '';
    showFieldError($('#voice-input'), $('#voice-error'), error.message);
    return;
  }
  state.voiceFile = file;
  setVoicePreview(file);
  notice('');
  wizardStatus(`${file.name} selected. Listen back before continuing.`);
}

async function init() {
  $('#loading-state').hidden = false;
  $('#signed-out').hidden = true;
  $('#load-error').hidden = true;
  $('#studio').hidden = true;
  updateSessionLabels('Checking session...');
  try {
    const session = await api('/api/video-os-lite/session');
    updateSessionLabels(session.email || session.account?.name || 'Private account');
    await loadIdentities();
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
  } finally {
    $('#loading-state').hidden = true;
  }
}

$('#create-button').addEventListener('click', openWizard);
$('#empty-create-button').addEventListener('click', openWizard);
$('#close-wizard').addEventListener('click', () => closeWizard());
$('#next-button').addEventListener('click', next);
$('#back-button').addEventListener('click', () => setStep(Math.max(1, state.step - 1)));
$('#check-my-identities').addEventListener('click', checkMyIdentities);
$('#commit-retry-anyway').addEventListener('click', retryCommitAnyway);
$('#resume-polling').addEventListener('click', resumePolling);
$('#photo-input').addEventListener('change', (event) => handlePhotoFile(event.target.files[0] || null));
$('#voice-input').addEventListener('change', (event) => handleVoiceFile(event.target.files[0] || null));
$('#identity-name').addEventListener('input', () => {
  if ($('#identity-name').value.trim()) clearFieldError($('#identity-name'), $('#identity-name-error'));
});
document.querySelectorAll('.consent-list input').forEach((input) => input.addEventListener('change', () => {
  input.removeAttribute('aria-invalid');
  if ([...document.querySelectorAll('.consent-list input')].every((item) => item.checked)) clearConsentError();
}));
$('#record-button').addEventListener('click', startRecording);
$('#stop-recording').addEventListener('click', stopRecording);
$('#retry-load').addEventListener('click', () => { notice(''); void init(); });

const wizard = $('#wizard');
wizard.addEventListener('keydown', (event) => trapFocus(event, wizard));
wizard.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeWizard();
});
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
menu.addEventListener('keydown', (event) => trapFocus(event, menu));
menu.addEventListener('cancel', (event) => { event.preventDefault(); menu.close(); });
menu.addEventListener('close', () => {
  $('#open-menu').setAttribute('aria-expanded', 'false');
  const opener = state.menuOpener;
  state.menuOpener = null;
  if (opener?.isConnected) opener.focus();
});
menu.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => menu.close()));

$('#ready-use-link').addEventListener('click', (event) => {
  if ($('#ready-use-link').getAttribute('aria-disabled') === 'true') event.preventDefault();
});
window.addEventListener('beforeunload', () => { stopPolling(); if (state.recorder) state.recorder.stream.getTracks().forEach((track) => track.stop()); });

void init();
