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
};

const $ = (selector) => document.querySelector(selector);
const api = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({ ok: false, error: 'The server returned an unreadable response.' }));
  if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || 'Request failed.'), { status: response.status, code: data.code });
  return data;
};

function notice(message, tone = 'info') {
  const element = $('#notice');
  element.textContent = message;
  element.className = `notice ${tone}`;
  element.hidden = !message;
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
  const portrait = document.createElement('img');
  portrait.className = 'identity-portrait';
  portrait.src = identity.portraitUrl;
  portrait.alt = `${identity.displayName} portrait`;
  const body = document.createElement('div');
  body.className = 'identity-body';
  const title = document.createElement('div');
  title.className = 'identity-title';
  const heading = document.createElement('h3');
  heading.textContent = identity.displayName;
  const pill = document.createElement('span');
  pill.className = `status-pill ${identity.ready ? 'ready' : ''}`;
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
    actions.append(button('Preview voice', 'secondary', () => {
      const existing = card.querySelector('audio');
      if (existing) { existing.remove(); return; }
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.autoplay = true;
      audio.src = identity.voicePreviewUrl;
      body.insertBefore(audio, actions);
    }));
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
  if (identity.avatarFailure?.message) { const error = document.createElement('p'); error.className = 'fine-print'; error.textContent = `Avatar: ${identity.avatarFailure.message}`; body.append(error); }
  if (identity.voiceFailure?.message) { const error = document.createElement('p'); error.className = 'fine-print'; error.textContent = `Voice: ${identity.voiceFailure.message}`; body.append(error); }
  body.append(actions);
  card.append(portrait, body);
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
  });
  $('#back-button').disabled = step === 1 || step >= 4;
  $('#next-button').hidden = step >= 4;
  $('#wizard-actions').hidden = step === 5;
  if (step === 4) updateProgress();
  $('#wizard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openWizard() {
  $('#wizard').hidden = false;
  setStep(1);
}

function closeWizard() {
  $('#wizard').hidden = true;
  resetWizard();
}

function resetWizard() {
  state.activeIdentityId = null;
  state.photoFile = null;
  state.voiceFile = null;
  $('#identity-form').reset();
  $('#photo-preview').hidden = true;
  $('#photo-prompt').hidden = false;
  if (state.voiceUrl) URL.revokeObjectURL(state.voiceUrl);
  state.voiceUrl = null;
  $('#voice-preview').hidden = true;
}

function validFile(file, types, max, label) {
  if (!file) throw new Error(`Choose your ${label} first.`);
  if (!types.includes(file.type)) throw new Error(`Choose a supported ${label} file.`);
  if (!file.size || file.size > max) throw new Error(`The ${label} file is empty or too large.`);
}

function validateStep() {
  if (state.step === 1) validFile(state.photoFile, ['image/jpeg', 'image/png'], 3_000_000, 'photo');
  if (state.step === 2) validFile(state.voiceFile, ['audio/wav', 'audio/x-wav', 'audio/mpeg'], 3_000_000, 'voice recording');
  if (state.step === 3) {
    if (!$('#identity-name').value.trim()) throw new Error('Name this identity.');
    if (![...document.querySelectorAll('.consent-list input')].every((input) => input.checked)) throw new Error('All four authorizations are required.');
  }
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

async function commitIdentity() {
  $('#next-button').disabled = true;
  notice('Validating and storing your private source files…');
  try {
    const [photo, voice] = await Promise.all([upload(state.photoFile, 'identity_photo'), upload(state.voiceFile, 'identity_voice')]);
    const created = await api('/api/video-os-lite/identities', { method: 'POST', body: JSON.stringify({ action: 'create', displayName: $('#identity-name').value.trim(), photoAssetId: photo.assetId, voiceAssetId: voice.assetId }) });
    state.activeIdentityId = created.identity.id;
    await api('/api/video-os-lite/identities', { method: 'POST', body: JSON.stringify({
      action: 'consent', identityId: state.activeIdentityId,
      faceAuthorization: $('#consent-face').checked, voiceAuthorization: $('#consent-voice').checked,
      providerProcessingAuthorization: $('#consent-process').checked, archiveDeleteAcknowledgment: $('#consent-archive').checked,
    }) });
    await loadIdentities();
    if (!state.providerSubmissionEnabled) {
      notice('Identity draft and consent saved. Provider creation remains held until preview privacy, entitlement, and cost checks pass.', 'success');
      closeWizard();
      return;
    }
    setStep(4);
    await submitIdentity(state.activeIdentityId, false);
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    $('#next-button').disabled = false;
  }
}

async function next() {
  try { validateStep(); } catch (error) { return notice(error.message, 'error'); }
  notice('');
  if (state.step < 3) return setStep(state.step + 1);
  return commitIdentity();
}

async function submitIdentity(identityId, openProgress = true) {
  if (!state.providerSubmissionEnabled) return notice('Provider creation is held until preview privacy, entitlement, and cost checks pass.', 'error');
  if (openProgress) { state.activeIdentityId = identityId; $('#wizard').hidden = false; setStep(4); }
  try {
    await api('/api/video-os-lite/identities', { method: 'POST', body: JSON.stringify({ action: 'submit', identityId }) });
    await loadIdentities();
    updateProgress();
    schedulePolling();
  } catch (error) {
    notice(error.message, 'error');
    await loadIdentities().catch(() => {});
    updateProgress();
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
  if (identity?.ready) setStep(5);
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.pollCount = 0;
}

function schedulePolling() {
  if (state.pollTimer || state.pollCount >= 45) return;
  state.pollTimer = setTimeout(poll, 8_000);
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
  if (state.pollCount < 45 && state.identities.some((identity) => ['CREATING_AVATAR', 'CLONING_VOICE', 'PROCESSING'].includes(identity.overallStatus))) schedulePolling();
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
  if (!navigator.mediaDevices?.getUserMedia) return notice('Microphone recording is not supported in this browser. Upload a WAV or MP3 instead.', 'error');
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
  } catch { notice('Microphone permission was not granted. Upload a WAV or MP3 instead.', 'error'); }
}

async function stopRecording() {
  const recorder = state.recorder;
  if (!recorder) return;
  clearInterval(recorder.timer); recorder.processor.disconnect(); recorder.source.disconnect(); recorder.stream.getTracks().forEach((track) => track.stop());
  await recorder.context.close(); state.recorder = null; $('#recording-state').hidden = true; $('#record-button').disabled = false;
  const blob = encodeWav(recorder.chunks, recorder.context.sampleRate);
  state.voiceFile = new File([blob], 'identity-voice.wav', { type: 'audio/wav' });
  setVoicePreview(state.voiceFile);
}

function setVoicePreview(file) {
  if (state.voiceUrl) URL.revokeObjectURL(state.voiceUrl);
  state.voiceUrl = URL.createObjectURL(file);
  $('#voice-preview').src = state.voiceUrl; $('#voice-preview').hidden = false;
}

async function init() {
  try {
    const session = await api('/api/video-os-lite/session');
    $('#session-label').textContent = session.email || session.account?.name || 'Private account';
    $('#studio').hidden = false;
    await loadIdentities();
  } catch (error) {
    $('#session-label').textContent = 'Signed out'; $('#signed-out').hidden = false;
    if (error.status !== 401) notice(error.message, 'error');
  }
}

$('#create-button').addEventListener('click', openWizard);
$('#empty-state').addEventListener('click', openWizard);
$('#close-wizard').addEventListener('click', closeWizard);
$('#next-button').addEventListener('click', next);
$('#back-button').addEventListener('click', () => setStep(Math.max(1, state.step - 1)));
$('#photo-input').addEventListener('change', (event) => {
  state.photoFile = event.target.files[0] || null;
  if (!state.photoFile) return;
  $('#photo-preview').src = URL.createObjectURL(state.photoFile); $('#photo-preview').hidden = false; $('#photo-prompt').hidden = true;
});
$('#voice-input').addEventListener('change', (event) => { state.voiceFile = event.target.files[0] || null; if (state.voiceFile) setVoicePreview(state.voiceFile); });
$('#record-button').addEventListener('click', startRecording);
$('#stop-recording').addEventListener('click', stopRecording);
window.addEventListener('beforeunload', () => { stopPolling(); if (state.recorder) state.recorder.stream.getTracks().forEach((track) => track.stop()); });

init();
