import { PREMIUM_COMPOSITION_CATALOG, resolvePremiumComposition } from './premium-composition-catalog.js';
import { FEATURED_CAST, curateDefaultCast, matchedVoiceId, prioritizeVoices } from './video-os-cast.js';
import { createCopywriterController } from './copywriter.js';
import { createStandardController } from './standard-contract.js';
import { createStudioPreviewController } from './studio-preview-player.js';
import { createScriptedPhotoClient } from './scripted-photo-client.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const localHost = ['127.0.0.1', 'localhost'].includes(location.hostname);
const startupUrl = new URL(location.href);
const fixtureName = startupUrl.searchParams.get('fixture');
const standardContractMode = localHost && fixtureName === 'standard-contract';
const standardFixtureMode = localHost && (fixtureName === 'standard-lifecycle' || standardContractMode);
const copywriterFixtureMode = localHost && fixtureName === 'copywriter';
const fixtureMode = standardFixtureMode || copywriterFixtureMode;
const allowedFixtureOutcomes = new Set(['success', 'retryable', 'final', 'cancelled', 'unaccepted']);
const requestedFixtureOutcome = startupUrl.searchParams.get('fixture-outcome') || 'success';
const fixtureOutcome = allowedFixtureOutcomes.has(requestedFixtureOutcome) ? requestedFixtureOutcome : 'success';
const fixtureMedia = {
  portrait: '/assets/studio/fixture-portrait.svg',
  audio: '/assets/studio/fixture-audio.wav',
  output: '/assets/studio/fixture-output.mp4',
};
const liveStates = new Set(['DRAFT', 'VALIDATING', 'QUEUED', 'SUBMITTING', 'PROCESSING']);
const retryableCategories = new Set(['INTERNAL', 'PERSISTENCE', 'PROVIDER_RESPONSE', 'SOURCE_POLICY', 'PROVIDER_TIMEOUT', 'WORKER_INTERRUPTION']);
const state = {
  signedIn: false,
  session: null,
  providers: [],
  identities: [],
  identitiesState: 'loading',
  results: [],
  resultsState: 'loading',
  project: null,
  libraries: { avatar: [], voice: [] },
  visible: { avatar: 20, voice: 20 },
  premium: {
    avatar: null,
    voice: null,
    identityId: null,
    voiceExplicit: false,
    submitting: false,
    pollingTimer: null,
    pollingAttempts: 0,
    idempotencyKey: null,
    idempotencySignature: null,
    pendingRequest: null,
    submissionUncertain: false,
    activeJobId: null,
    controlsLocked: false,
    terminal: false,
  },
  standard: {
    identityId: null,
    portrait: null,
    audio: null,
    permission: false,
    reviewed: false,
    running: false,
    objectUrls: new Set(),
    timers: [],
  },
  scripted: {
    capabilities: null,
    quoteTier: null,
    tiers: {
      STANDARD: { busy: false, job: null, pollingTimer: null, pollingAttempts: 0 },
      PREMIUM: { busy: false, job: null, pollingTimer: null, pollingAttempts: 0 },
    },
  },
  fixtureResults: [],
  resultLimit: 6,
  selectedResultId: null,
  workspaceGeneration: 0,
  authRetry: null,
};
let copywriterController = null;
let standardContractController = null;
let standardContractJob = null;
let studioPreviewController = null;
let scriptedPhotoClient = null;

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
};

function announce(message) {
  const target = $('#announcement');
  target.textContent = '';
  window.setTimeout(() => { target.textContent = message; }, 10);
}

function showToast(message) {
  const target = $('#toast');
  target.textContent = message;
  target.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { target.hidden = true; }, 5000);
}

function setNotice(message = '', tone = 'info', retry = false) {
  const notice = $('#app-notice');
  $('#app-notice-text').textContent = message;
  notice.hidden = !message;
  notice.dataset.tone = tone;
  notice.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  $('#workspace-retry').hidden = !retry;
}

function setFieldError(control, errorElement, message = '') {
  if (message) control.setAttribute('aria-invalid', 'true');
  else control.removeAttribute('aria-invalid');
  errorElement.textContent = message;
  errorElement.hidden = !message;
}

async function getJson(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (fixtureMode && !['GET', 'HEAD'].includes(method)) {
    throw Object.assign(new Error('Account and render changes are disabled in the local lifecycle fixture.'), { code: 'fixture_write_blocked', status: 405, retryable: false });
  }
  const { timeoutMs = 15000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(fetchOptions.headers || {});
    if (!headers.has('x-request-id')) headers.set('x-request-id', crypto.randomUUID());
    const response = await fetch(url, { credentials: 'same-origin', ...fetchOptions, headers, signal: controller.signal });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw Object.assign(new Error('Video OS returned an unreadable response. Try again.'), { code: 'invalid_response', status: response.status });
    }
    if (!response.ok || data.ok === false) {
      throw Object.assign(new Error(data.error || 'Request failed with status ' + response.status + '.'), {
        code: data.code || 'request_failed',
        status: response.status,
        retryable: response.status >= 500,
        payload: data,
      });
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('Video OS took too long to respond. Try again.'), { code: 'network_timeout', retryable: true });
    if (error.code) throw error;
    throw Object.assign(new Error('We could not reach Video OS. Check your connection and try again.'), { code: 'network_unavailable', retryable: true });
  } finally {
    window.clearTimeout(timeout);
  }
}

let scriptedSessionStorage = null;
try { scriptedSessionStorage = window.sessionStorage; } catch {}
scriptedPhotoClient = createScriptedPhotoClient({
  request: (url, options = {}) => getJson(url, {
    ...options,
    ...(options.body !== undefined ? { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } } : {}),
  }),
  storage: scriptedSessionStorage,
});

function scriptedTierState(tier) {
  return state.scripted.tiers[tier];
}

function activeScriptedTier() {
  return $('#premium-tab').getAttribute('aria-selected') === 'true' ? 'PREMIUM' : 'STANDARD';
}

function scriptedTierLocked(tier) {
  const normalized = tier.toLowerCase();
  const activeResult = state.results.some(item => String(item.tier || '').toLowerCase() === normalized && liveStates.has(presentedJobStatus(item)));
  return scriptedTierState(tier).busy || scriptedPhotoClient.publicState(tier).uncertain || activeResult;
}

function scriptedElements(tier) {
  if (tier === 'STANDARD') return {
    form: $('#scripted-standard-form'),
    title: $('#standard-scripted-title'),
    script: $('#standard-scripted-script'),
    count: $('#standard-scripted-count'),
    titleError: $('#standard-scripted-title-error'),
    scriptError: $('#standard-scripted-script-error'),
    identityError: $('#standard-scripted-identity-error'),
    identityList: $('#scripted-standard-identity-list'),
    format: $('#standard-scripted-format'),
    price: $('#standard-scripted-price'),
    submit: $('#standard-scripted-submit'),
    newDraft: $('#standard-scripted-new-draft'),
    status: $('#standard-scripted-status'),
    recovery: $('#standard-scripted-recovery'),
    check: $('#standard-scripted-check'),
    retry: $('#standard-scripted-retry'),
  };
  return {
    form: $('#video-form'),
    title: $('#premium-title'),
    script: $('#script-input'),
    count: $('#script-count'),
    titleError: $('#premium-title-error'),
    scriptError: $('#premium-script-error'),
    identityError: $('#premium-cast-error'),
    identityList: $('#premium-identity-list'),
    format: $('#export-format'),
    price: $('#finish-render-cost'),
    submit: $('#generate-video'),
    newDraft: $('#premium-new-draft'),
    status: $('#premium-status'),
    recovery: $('#premium-scripted-recovery'),
    check: $('#premium-scripted-check'),
    retry: $('#premium-scripted-retry'),
  };
}

function scriptedIdentityId(tier) {
  return tier === 'STANDARD' ? state.standard.identityId : state.premium.identityId;
}

function scriptedDraft(tier) {
  const elements = scriptedElements(tier);
  return {
    title: elements.title.value,
    script: elements.script.value,
    identityId: scriptedIdentityId(tier),
    format: elements.format.value,
  };
}

function scriptedReason(reasons = []) {
  if (reasons.includes('feature_disabled')) return 'Video creation is not enabled yet. Your draft stays available.';
  if (reasons.includes('standard_price_unconfigured')) return 'Standard pricing is not configured yet. Your draft stays available.';
  return 'This tier is not currently available. Your draft stays available.';
}

function scriptedIntentChanged(tier) {
  const changed = scriptedPhotoClient.bindIntent(tier, scriptedDraft(tier));
  if (changed && state.scripted.quoteTier === tier) closeDialog($('#scripted-photo-quote-dialog'));
  if (changed) {
    $('#scripted-photo-quote-error').hidden = true;
    $('#scripted-photo-requote').hidden = true;
  }
  renderScriptedAvailability(tier);
}

function scriptedIdentityChoice(identity, tier) {
  const button = node('button', 'identity-choice');
  button.type = 'button';
  button.dataset[tier === 'STANDARD' ? 'scriptedStandardIdentityId' : 'premiumIdentityId'] = identity.id;
  button.setAttribute('aria-pressed', String(scriptedIdentityId(tier) === identity.id));
  if (identity.portraitUrl) {
    const image = node('img');
    safeImage(image, identity.portraitUrl, (identity.displayName || 'Saved identity') + ' portrait');
    button.append(image);
  } else {
    button.append(node('span', 'identity-fallback', initials(identity.displayName)));
  }
  const copy = node('span');
  copy.append(node('strong', null, identity.displayName || 'Saved identity'), node('small', null, identity.ready === true ? 'Ready to use' : identityStatus(identity)));
  button.append(copy);
  const locked = scriptedTierState(tier).busy || Boolean(scriptedTierState(tier).job && liveStates.has(presentedJobStatus(scriptedTierState(tier).job)));
  if (identity.ready !== true || identity.archivedAt || locked) {
    button.disabled = true;
    button.title = locked ? 'This tier is locked while its current request is resolved.' : 'This presenter is not ready to use.';
  } else {
    button.addEventListener('click', () => {
      if (tier === 'STANDARD') state.standard.identityId = identity.id;
      else choosePremiumIdentity(identity);
      setFieldError(scriptedElements(tier).identityList, scriptedElements(tier).identityError);
      scriptedIntentChanged(tier);
      renderScriptedIdentityLists();
      announce((identity.displayName || 'Private identity') + ` selected for ${tier === 'STANDARD' ? 'Standard' : 'Premium'}.`);
    });
  }
  return button;
}

function renderScriptedIdentityLists() {
  if (standardFixtureMode) return;
  const identities = state.identities.filter(identity => !identity.archivedAt);
  for (const tier of ['STANDARD', 'PREMIUM']) {
    const target = scriptedElements(tier).identityList;
    if (!state.signedIn) {
      target.replaceChildren(node('p', 'inline-empty', 'Sign in to choose a ready private identity.'));
      continue;
    }
    if (!identities.length) {
      target.replaceChildren(node('p', 'inline-empty', 'No private identities are available. Open Identity Studio to enroll once.'));
      continue;
    }
    target.replaceChildren(...identities.map(identity => scriptedIdentityChoice(identity, tier)));
  }
}

function scriptedDraftValid(tier, { focus = false } = {}) {
  const elements = scriptedElements(tier);
  const identity = state.identities.find(item => item.id === scriptedIdentityId(tier) && item.ready === true && !item.archivedAt);
  const checks = [
    [Boolean(elements.title.value.trim()), elements.title, elements.titleError, 'Enter a video title.'],
    [Boolean(elements.script.value.trim()), elements.script, elements.scriptError, 'Enter the exact script.'],
    [Boolean(identity), elements.identityList, elements.identityError, 'Choose a ready private identity.'],
  ];
  for (const [valid, control, error, message] of checks) setFieldError(control, error, valid ? '' : message);
  const first = checks.find(([valid]) => !valid);
  if (focus && first) {
    if (first[1] === elements.identityList) (elements.identityList.querySelector('button:not([disabled])') || elements.identityList.querySelector('a') || elements.identityList).focus?.();
    else first[1].focus();
  }
  return !first;
}

function setScriptedLocked(tier, locked) {
  const elements = scriptedElements(tier);
  for (const control of [elements.title, elements.script, elements.format]) control.disabled = locked;
  scriptedTierState(tier).busy = locked;
  renderScriptedIdentityLists();
}

function renderScriptedAvailability(tier) {
  if (standardFixtureMode) return;
  const elements = scriptedElements(tier);
  const tierState = scriptedTierState(tier);
  const capability = scriptedPhotoClient.tierCapability(tier);
  const identity = state.identities.find(item => item.id === scriptedIdentityId(tier) && item.ready === true && !item.archivedAt);
  const inputsReady = Boolean(elements.title.value.trim() && elements.script.value.trim() && identity);
  const available = Boolean(state.signedIn && capability?.available);
  const hasJob = Boolean(tierState.job);
  const jobLive = hasJob && liveStates.has(presentedJobStatus(tierState.job));
  elements.price.textContent = capability?.available && capability.credits ? capability.credits.toLocaleString() + ' credits' : 'Not available';
  elements.submit.hidden = hasJob;
  elements.newDraft.hidden = !hasJob || jobLive;
  elements.submit.disabled = tierState.busy || hasJob || !available || !inputsReady;
  elements.submit.textContent = tierState.busy ? 'Working…' : `Review ${tier === 'STANDARD' ? 'Standard' : 'Premium'} price`;
  if (!state.signedIn) elements.status.textContent = 'Sign in to use an enrolled identity and request a price.';
  else if (!capability?.available) elements.status.textContent = scriptedReason(capability?.reasons);
  else if (!inputsReady) elements.status.textContent = 'Add a title and script, then choose a ready private identity.';
  else if (!hasJob && !scriptedPhotoClient.publicState(tier).uncertain) elements.status.textContent = 'Ready to save this draft and review the current price.';
  if (tier === 'PREMIUM') {
    $('#provider-status').dataset.state = available ? 'eligible' : 'unavailable';
    $('#provider-status').textContent = available ? 'Premium available' : 'Premium unavailable';
  }
}

function renderScriptedStudio() {
  $('#scripted-standard-form').hidden = standardFixtureMode;
  $('#legacy-standard-workspace').hidden = !standardFixtureMode;
  if (standardFixtureMode) return;
  renderScriptedIdentityLists();
  for (const tier of ['STANDARD', 'PREMIUM']) {
    const uncertain = scriptedPhotoClient.publicState(tier).uncertain;
    scriptedElements(tier).recovery.hidden = !uncertain;
    if (uncertain) {
      scriptedElements(tier).retry.disabled = true;
      setScriptedLocked(tier, true);
    }
  }
  renderScriptedAvailability('STANDARD');
  renderScriptedAvailability('PREMIUM');
}

function hydrateScriptedDrafts(restored) {
  for (const tier of ['STANDARD', 'PREMIUM']) {
    const draft = restored?.[tier]?.draft;
    if (!draft) continue;
    const elements = scriptedElements(tier);
    elements.title.value = draft.title || '';
    elements.script.value = draft.script || '';
    elements.count.textContent = elements.script.value.length + ' / 900';
    if (['vertical', 'landscape', 'square'].includes(draft.format)) elements.format.value = draft.format;
    if (tier === 'STANDARD') state.standard.identityId = draft.identityId || null;
    else state.premium.identityId = draft.identityId || null;
  }
}

async function loadScriptedCapabilities() {
  state.scripted.capabilities = await scriptedPhotoClient.loadCapabilities();
  return state.scripted.capabilities;
}

function showScriptedQuote(tier, prepared) {
  state.scripted.quoteTier = tier;
  const draft = scriptedDraft(tier);
  const identity = state.identities.find(item => item.id === draft.identityId);
  $('#scripted-photo-quote-title').textContent = `Start this ${tier === 'STANDARD' ? 'Standard' : 'Premium'} render?`;
  const summary = $('#scripted-photo-quote-summary');
  summary.replaceChildren(...[
    ['Title', draft.title.trim()],
    ['Script', draft.script.trim()],
    ['Presenter', identity?.displayName || 'Private identity'],
    ['Format', draft.format],
    ['Current price', `${Number(prepared.quote.credits).toLocaleString()} credits`],
    ['Quote expires', new Date(prepared.quote.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })],
  ].map(([label, value]) => { const row = node('div'); row.append(node('span', null, label), node('strong', null, value)); return row; }));
  $('#scripted-photo-quote-error').hidden = true;
  $('#scripted-photo-requote').hidden = true;
  $('#scripted-photo-quote-confirm').disabled = false;
  openDialog($('#scripted-photo-quote-dialog'), $('#scripted-photo-quote-confirm'));
}

async function requestScriptedQuote(tier) {
  if (!scriptedDraftValid(tier, { focus: true })) return;
  const tierState = scriptedTierState(tier);
  const elements = scriptedElements(tier);
  setScriptedLocked(tier, true);
  elements.status.textContent = 'Saving this exact draft and requesting the current price.';
  try {
    const prepared = await scriptedPhotoClient.prepareQuote(tier, scriptedDraft(tier));
    if (prepared.recovered && prepared.existingJob) {
      mergeScriptedJob(tier, prepared.existingJob, { recovered: true });
      return;
    }
    showScriptedQuote(tier, prepared);
    elements.status.textContent = 'Price ready. Confirm the exact inputs in the dialog.';
  } catch (error) {
    elements.status.textContent = error.message;
    showToast(error.message);
  } finally {
    const held = scriptedPhotoClient.publicState(tier).uncertain
      || Boolean(scriptedTierState(tier).job && liveStates.has(presentedJobStatus(scriptedTierState(tier).job)));
    setScriptedLocked(tier, held);
    renderScriptedAvailability(tier);
  }
}

function mergeScriptedJob(tier, job, { recovered = false } = {}) {
  if (!job?.id) throw new Error('The render response did not include a recoverable job.');
  const tierState = scriptedTierState(tier);
  tierState.job = job;
  tierState.pollingAttempts = 0;
  state.results = [job, ...state.results.filter(item => item.id !== job.id)];
  state.resultsState = 'ready';
  renderResults();
  const status = presentedJobStatus(job);
  scriptedElements(tier).status.textContent = recovered ? 'Existing render found. Check My Videos for its current state.' : `${tier === 'STANDARD' ? 'Standard' : 'Premium'} render accepted. Check My Videos for progress.`;
  setScriptedLocked(tier, liveStates.has(status));
  scriptedElements(tier).recovery.hidden = true;
  if (liveStates.has(status)) scheduleScriptedPolling(tier, job.id);
  renderScriptedAvailability(tier);
}

function stopScriptedPolling(tier) {
  const tierState = scriptedTierState(tier);
  clearTimeout(tierState.pollingTimer);
  tierState.pollingTimer = null;
}

function scheduleScriptedPolling(tier, jobId) {
  const tierState = scriptedTierState(tier);
  if (tierState.pollingTimer || tierState.pollingAttempts >= 45) return;
  tierState.pollingTimer = window.setTimeout(async () => {
    tierState.pollingTimer = null;
    tierState.pollingAttempts += 1;
    try {
      await loadResults();
      const job = state.results.find(item => item.id === jobId);
      if (job) tierState.job = job;
      if (job && liveStates.has(presentedJobStatus(job))) scheduleScriptedPolling(tier, jobId);
      else {
        setScriptedLocked(tier, false);
        scriptedElements(tier).status.textContent = job ? statusCopy(presentedJobStatus(job), job) : 'The saved render remains available in My Videos.';
        renderScriptedAvailability(tier);
      }
    } catch {
      scriptedElements(tier).status.textContent = 'Status checks paused. The saved request remains available in My Videos.';
      setScriptedLocked(tier, false);
    }
  }, Math.min(30_000, 5_000 + tierState.pollingAttempts * 1_000));
}

function prepareAnotherScriptedDraft(tier) {
  stopScriptedPolling(tier);
  scriptedTierState(tier).job = null;
  scriptedPhotoClient.resetCompletedIntent(tier);
  scriptedPhotoClient.bindIntent(tier, scriptedDraft(tier));
  setScriptedLocked(tier, false);
  scriptedElements(tier).status.textContent = 'Draft preserved. Review a new price when you are ready.';
  renderScriptedAvailability(tier);
  scriptedElements(tier).title.focus();
}

async function confirmScriptedQuote({ recoveryFirst = false } = {}) {
  const tier = state.scripted.quoteTier;
  if (!tier) return;
  const elements = scriptedElements(tier);
  const quoteStatus = scriptedPhotoClient.quoteStatus(tier, scriptedDraft(tier));
  if (!quoteStatus.valid) {
    $('#scripted-photo-quote-error').textContent = quoteStatus.code === 'quote_expired' ? 'This quote expired. Get a new quote; the same request key will be preserved.' : 'These inputs changed. Review a new quote before submitting.';
    $('#scripted-photo-quote-error').hidden = false;
    $('#scripted-photo-requote').hidden = false;
    $('#scripted-photo-quote-confirm').disabled = true;
    return;
  }
  setScriptedLocked(tier, true);
  $('#scripted-photo-quote-confirm').disabled = true;
  elements.status.textContent = recoveryFirst ? 'Checking the existing request before retrying.' : 'Submitting this quoted render.';
  try {
    const result = await scriptedPhotoClient.submit(tier, scriptedDraft(tier), { recoveryFirst });
    closeDialog($('#scripted-photo-quote-dialog'));
    mergeScriptedJob(tier, result.job, { recovered: result.recovered });
  } catch (error) {
    if (error.code === 'submission_uncertain') {
      closeDialog($('#scripted-photo-quote-dialog'));
      elements.recovery.hidden = false;
      elements.check.disabled = false;
      elements.retry.disabled = true;
      elements.status.textContent = error.message;
    } else if (error.quoteRejected || ['quote_expired', 'quote_missing'].includes(error.code)) {
      $('#scripted-photo-quote-error').textContent = error.message;
      $('#scripted-photo-quote-error').hidden = false;
      $('#scripted-photo-requote').hidden = false;
    } else {
      elements.status.textContent = error.message;
      showToast(error.message);
    }
  } finally {
    const uncertain = scriptedPhotoClient.publicState(tier).uncertain;
    if (!uncertain && !scriptedTierState(tier).job) setScriptedLocked(tier, false);
    $('#scripted-photo-quote-confirm').disabled = false;
    renderScriptedAvailability(tier);
  }
}

async function checkScriptedRecovery(tier) {
  const elements = scriptedElements(tier);
  elements.check.disabled = true;
  elements.status.textContent = 'Checking the same request without creating new work.';
  try {
    const job = await scriptedPhotoClient.recover(tier);
    if (job) mergeScriptedJob(tier, job, { recovered: true });
    else {
      elements.status.textContent = 'No existing render was found. You may retry the same request and request key.';
      elements.retry.disabled = false;
    }
  } catch (error) {
    elements.status.textContent = error.message;
  } finally {
    elements.check.disabled = false;
  }
}

async function retryScriptedRequest(tier) {
  const quote = scriptedPhotoClient.quoteStatus(tier, scriptedDraft(tier));
  if (!quote.valid) return requestScriptedQuote(tier);
  state.scripted.quoteTier = tier;
  return confirmScriptedQuote({ recoveryFirst: true });
}

function rawJobStatus(item = {}) {
  const raw = String(item.status || item.stage || '').trim().toUpperCase();
  const legacy = {
    READY: 'SUCCEEDED',
    RENDERING: 'PROCESSING',
    FINISHING: 'PROCESSING',
    PROVIDER_RENDERING: 'PROCESSING',
    PROVIDER_READY: 'PROCESSING',
    WORKFLOW_STARTED: 'QUEUED',
    RESERVED: 'QUEUED',
    FAILED: retryableCategories.has(String(item.failureCategory || '').toUpperCase()) ? 'FAILED_RETRYABLE' : 'FAILED_FINAL',
    CANCELLED: 'CANCELLED',
  };
  return legacy[raw] || (['DRAFT', 'VALIDATING', 'QUEUED', 'SUBMITTING', 'PROCESSING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED'].includes(raw) ? raw : 'DRAFT');
}

function safeOwnedOutputUrl(item = {}) {
  if (!item.url || !item.id) return null;
  let url;
  try {
    url = new URL(item.url, location.origin);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  if (standardFixtureMode && item.id === 'fixture-standard-001' && url.pathname === fixtureMedia.output) return url.pathname;
  if (url.pathname !== '/api/video-os-lite/download' || url.searchParams.get('jobId') !== String(item.id)) return null;
  return url.pathname + url.search;
}

function resultAccepted(item = {}) {
  return rawJobStatus(item) === 'SUCCEEDED' && item.outputAccepted === true && Boolean(safeOwnedOutputUrl(item));
}

function presentedJobStatus(item = {}) {
  const status = rawJobStatus(item);
  return status === 'SUCCEEDED' && item.outputAccepted !== true ? 'PROCESSING' : status;
}

function statusCopy(status, item = {}) {
  if (status === 'DRAFT') return 'Preparing inputs';
  if (status === 'VALIDATING') return 'Checking inputs';
  if (status === 'QUEUED') return 'Queued';
  if (status === 'SUBMITTING') return 'Starting render';
  if (status === 'PROCESSING') return rawJobStatus(item) === 'SUCCEEDED' ? 'Output acceptance pending' : 'Processing';
  if (status === 'SUCCEEDED') return safeOwnedOutputUrl(item) ? 'Accepted output' : 'Output unavailable';
  if (status === 'FAILED_RETRYABLE') return 'Retry needs review';
  if (status === 'FAILED_FINAL') return 'Failed';
  if (status === 'CANCELLED') return 'Cancelled';
  return 'Preparing';
}

function formatDate(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function initials(value) {
  return String(value || 'L').trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'L';
}

function safeImage(image, url, alt, options = {}) {
  image.alt = alt;
  if (!url) return;
  image.onerror = () => {
    if (typeof options.onError === 'function') {
      options.onError(image);
      return;
    }
    const fallback = node('span', 'image-missing', initials(options.fallbackText || alt));
    fallback.setAttribute('role', 'img');
    fallback.setAttribute('aria-label', alt + ' unavailable');
    image.replaceWith(fallback);
  };
  image.src = url;
}

const dialogOpeners = new WeakMap();
function openDialog(dialog, preferredFocus) {
  dialogOpeners.set(dialog, document.activeElement instanceof HTMLElement ? document.activeElement : null);
  dialog.showModal();
  window.setTimeout(() => (preferredFocus || $('button, input, textarea, select, a[href]', dialog))?.focus(), 0);
}

function closeDialog(dialog, { restore = true } = {}) {
  if (!dialog.open) return;
  dialog.dataset.restoreFocus = String(restore);
  dialog.close();
}

for (const dialog of [$('#mobile-menu'), $('#review-dialog'), $('#premium-handoff-dialog'), $('#auth-modal'), $('#standard-quote-dialog'), $('#scripted-photo-quote-dialog')]) {
  dialog.addEventListener('close', () => {
    if (dialog === $('#mobile-menu')) $('#open-menu').setAttribute('aria-expanded', 'false');
    if (dialog === $('#auth-modal')) $$('[aria-controls="auth-modal"]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
    if (dialog === $('#standard-quote-dialog')) standardContractController?.cancelQuote();
    if (dialog.dataset.restoreFocus !== 'false') dialogOpeners.get(dialog)?.focus?.();
    delete dialog.dataset.restoreFocus;
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = $$('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])', dialog)
      .filter((control) => control.getClientRects().length > 0 && !control.hidden);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function activeView() {
  const requested = location.hash.slice(1) || 'create';
  return ['create', 'copywriter', 'identities', 'videos', 'account'].includes(requested) ? requested : 'create';
}

function navigate({ focus = true } = {}) {
  const view = activeView();
  $$('.view').forEach((section) => { section.hidden = section.id !== view + '-view'; });
  $$('[data-nav]').forEach((link) => {
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if ($('#mobile-menu').open) closeDialog($('#mobile-menu'), { restore: false });
  if (focus) {
    $('#main').focus();
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
}

function setTier(tier, { focus = false } = {}) {
  const standard = tier !== 'premium';
  $('#standard-tab').setAttribute('aria-selected', String(standard));
  $('#premium-tab').setAttribute('aria-selected', String(!standard));
  $('#standard-tab').tabIndex = standard ? 0 : -1;
  $('#premium-tab').tabIndex = standard ? -1 : 0;
  $('#standard-panel').hidden = !standard;
  $('#premium-panel').hidden = standard;
  if (!standardFixtureMode) renderScriptedStudio();
  if (focus) (standard ? $('#standard-tab') : $('#premium-tab')).focus();
}

function reviewRows(rows, warning) {
  const summary = $('#review-summary');
  summary.replaceChildren(...rows.map(([label, value]) => {
    const row = node('div');
    row.append(node('span', null, label), node('strong', null, value));
    return row;
  }));
  if (warning) summary.append(node('p', 'review-warning', warning));
}

function showTierComparison() {
  $('#review-dialog-title').textContent = 'Standard and Premium';
  reviewRows([
    ['Standard', 'Ready private identity + exact script'],
    ['Premium', 'Ready private identity + exact script'],
    ['Live availability', 'Checked separately for each tier'],
  ], 'Availability, access, and price are checked separately for each tier before a render can start.');
  openDialog($('#review-dialog'), $('[data-dialog-close]', $('#review-dialog')));
}

function entitlementAllowsPremium() {
  const entitlements = state.session?.entitlements || {};
  return ['liveRendering', 'fullAccess', 'ownerAccess'].some((key) => entitlements[key] === true);
}

function premiumProvider() {
  return state.providers.find((provider) => provider.id === 'heygen') || null;
}

function premiumQuote(provider = premiumProvider()) {
  return typeof provider?.cost === 'number' && Number.isFinite(provider.cost) && provider.cost > 0 ? provider.cost : null;
}

function renderAccount() {
  const label = $('#account-nav-label');
  const detail = $('#account-nav-detail');
  const avatar = $('#account-avatar');
  const target = $('#account-summary');
  const signedOutControls = $$('[data-open-login]');
  if (!state.signedIn || !state.session?.account) {
    label.textContent = 'Account';
    detail.textContent = 'Signed out';
    avatar.textContent = 'A';
    target.replaceChildren(node('p', null, 'Sign in to see your private identities, jobs, and videos.'));
    signedOutControls.forEach((button) => {
      button.hidden = false;
      button.textContent = 'Sign in';
      button.setAttribute('aria-expanded', String($('#auth-modal').open));
    });
    return;
  }
  const account = state.session.account;
  const subscription = account.subscription || {};
  const credits = state.session.credits;
  label.textContent = account.name || state.session.email || 'Account';
  detail.textContent = subscription.plan || 'Signed in';
  avatar.textContent = initials(account.name || state.session.email);
  const rows = [
    ['Account', account.name || state.session.email || 'Signed-in account'],
    ['Plan', subscription.plan || 'Plan unavailable'],
    ['Session', 'Signed in'],
    ['Credits', Number.isFinite(Number(credits?.balance)) ? Number(credits.balance).toLocaleString() : 'Unavailable'],
  ];
  target.replaceChildren(...rows.map(([name, value]) => {
    const row = node('div');
    row.append(node('span', null, name), node('strong', null, value));
    return row;
  }));
  signedOutControls.forEach((button) => {
    button.hidden = false;
    button.textContent = 'Manage session';
    button.setAttribute('aria-expanded', String($('#auth-modal').open));
  });
}

function identityStatus(identity) {
  return String(identity.overallStatus || 'DRAFT').replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function identityChoice(identity, mode) {
  const button = node('button', 'identity-choice');
  button.type = 'button';
  const selected = mode === 'standard' ? state.standard.identityId === identity.id : state.premium.identityId === identity.id;
  button.setAttribute('aria-pressed', String(selected));
  button.dataset[mode === 'standard' ? 'standardIdentityId' : 'premiumIdentityId'] = identity.id;
  if (identity.portraitUrl) {
    const image = node('img');
    safeImage(image, identity.portraitUrl, (identity.displayName || 'Saved identity') + ' portrait');
    button.append(image);
  } else {
    button.append(node('span', 'identity-fallback', initials(identity.displayName)));
  }
  const copy = node('span');
  copy.append(node('strong', null, identity.displayName || 'Saved identity'), node('small', null, identity.ready === true ? 'Ready to use' : identityStatus(identity)));
  button.append(copy);
  if (identity.ready !== true || (mode === 'premium' && state.premium.controlsLocked)) {
    button.disabled = true;
    button.title = state.premium.controlsLocked ? 'This Premium submission is locked while its outcome is pending.' : 'This identity is not ready for Premium.';
  } else {
    button.addEventListener('click', () => mode === 'standard' ? selectStandardIdentity(identity) : choosePremiumIdentity(identity));
  }
  return button;
}

function renderMyCast() {
  const target = $('#my-cast-list');
  if (!state.signedIn) {
    target.replaceChildren(node('p', 'inline-empty', 'Sign in to view saved identities, or choose a local portrait below.'));
    return;
  }
  if (state.identitiesState === 'error') {
    target.replaceChildren(node('p', 'inline-empty', 'Saved identities could not be loaded. Try loading the workspace again.'));
    return;
  }
  const available = state.identities.filter((identity) => !identity.archivedAt);
  if (!available.length) {
    target.replaceChildren(node('p', 'inline-empty', 'No saved identities yet. You can still inspect a local portrait without uploading it.'));
    return;
  }
  target.replaceChildren(...available.map((identity) => identityChoice(identity, 'standard')));
}

function renderIdentityLibrary() {
  const target = $('#identity-library');
  if (!state.signedIn) {
    const empty = node('div', 'empty-state');
    empty.append(node('span', 'empty-mark', 'L'), node('h2', null, 'Sign in to see your identities'), node('p', null, 'Identity media and permission records stay tied to your account.'));
    const button = node('button', 'button primary', 'Sign in');
    button.type = 'button';
    button.addEventListener('click', openAuthModal);
    empty.append(button);
    target.replaceChildren(empty);
    return;
  }
  if (state.identitiesState === 'loading') {
    const loading = node('div', 'empty-state');
    loading.append(node('span', 'empty-mark', 'L'), node('h2', null, 'Checking your identities'), node('p', null, 'Loading your private identity records.'));
    target.replaceChildren(loading);
    return;
  }
  if (state.identitiesState === 'error') {
    const error = node('div', 'empty-state');
    error.append(node('span', 'empty-mark', 'L'), node('h2', null, 'Identities could not be loaded'), node('p', null, 'Try loading the workspace again. No identity was selected.'));
    target.replaceChildren(error);
    return;
  }
  const identities = state.identities.filter((identity) => !identity.archivedAt);
  if (!identities.length) {
    const empty = node('div', 'empty-state');
    empty.append(node('span', 'empty-mark', 'L'), node('h2', null, 'No identities yet'), node('p', null, 'Create a private identity with the existing upload and permission flow.'));
    const link = node('a', 'button primary', 'Open Identity Studio');
    link.href = '/identity';
    empty.append(link);
    target.replaceChildren(empty);
    return;
  }
  target.replaceChildren(...identities.map((identity) => {
    const card = node('article', 'identity-library-card');
    if (identity.portraitUrl) {
      const image = node('img');
      safeImage(image, identity.portraitUrl, (identity.displayName || 'Saved identity') + ' portrait');
      card.append(image);
    } else {
      card.append(node('div', 'identity-library-image', initials(identity.displayName)));
    }
    const body = node('div', 'identity-library-body');
    const badge = node('span', 'identity-status' + (identity.ready ? ' ready' : ''), identityStatus(identity));
    const title = node('h2', null, identity.displayName || 'Saved identity');
    const copy = node('p', null, identity.ready ? 'Available in Standard and Premium, subject to your access and current pricing.' : 'The identity workspace shows its current setup state.');
    const actions = node('div', 'result-actions');
    const use = node('button', 'button secondary compact', 'Use in Studio');
    use.type = 'button';
    use.addEventListener('click', () => {
      selectStandardIdentity(identity);
      choosePremiumIdentity(identity);
      location.hash = 'create';
      setTier('standard');
    });
    const manage = node('a', 'button quiet compact', 'Manage');
    manage.href = '/identity';
    actions.append(use, manage);
    body.append(badge, title, copy, actions);
    card.append(body);
    return card;
  }));
}

function selectStandardIdentity(identity) {
  if (!identity?.id || identity.ready !== true) return;
  state.standard.identityId = identity.id;
  if (!standardFixtureMode) {
    setFieldError($('#scripted-standard-identity-list'), $('#standard-scripted-identity-error'));
    scriptedIntentChanged('STANDARD');
    renderScriptedIdentityLists();
    return;
  }
  replaceStandardPortrait({
    kind: 'identity',
    identityId: identity.id,
    name: identity.displayName || 'Saved identity',
    url: identity.portraitUrl || '',
    meta: 'Saved identity · local preparation only',
  });
  renderMyCast();
  announce('Selected ' + (identity.displayName || 'saved identity') + ' for local Standard preparation.');
}

function revokeStandardUrl(value) {
  if (value && state.standard.objectUrls.has(value)) {
    URL.revokeObjectURL(value);
    state.standard.objectUrls.delete(value);
  }
}

function resetStandardReview() {
  state.standard.reviewed = false;
  if ($('#standard-submit').dataset.action === 'view') $('#standard-submit').dataset.action = 'run';
  if (!state.standard.running) {
    $('#standard-status').dataset.state = 'DRAFT';
    $('#standard-status').textContent = 'Inputs have not been reviewed.';
  }
  configureStandardSubmit();
}

function replaceStandardPortrait(portrait) {
  const prior = state.standard.portrait;
  revokeStandardUrl(state.standard.portrait?.url);
  state.standard.portrait = portrait;
  if (prior !== portrait && $('#standard-permission').checked) {
    $('#standard-permission').checked = false;
    state.standard.permission = false;
  }
  setFieldError($('#standard-portrait-file'), $('#portrait-error'));
  $('#portrait-state').textContent = portrait ? 'Selected' : 'Not selected';
  $('#portrait-selection').hidden = !portrait;
  $('#portrait-name').textContent = portrait?.name || '';
  $('#portrait-meta').textContent = portrait?.meta || '';
  const thumb = $('#portrait-thumbnail');
  const preview = $('#input-preview-image');
  if (portrait?.url) {
    thumb.hidden = false;
    safeImage(thumb, portrait.url, (portrait.name || 'Selected') + ' portrait preview', { onError: (image) => { image.hidden = true; } });
    safeImage(preview, portrait.url, (portrait.name || 'Selected') + ' portrait input preview', { onError: (image) => { image.hidden = true; $('#input-preview-placeholder').hidden = false; } });
    preview.hidden = false;
    $('#input-preview-placeholder').hidden = true;
  } else {
    thumb.removeAttribute('src');
    preview.removeAttribute('src');
    preview.hidden = true;
    $('#input-preview-placeholder').hidden = false;
  }
  $('#review-identity').textContent = portrait?.name || 'Not selected';
  renderMyCast();
  resetStandardReview();
}

function replaceStandardAudio(audio) {
  const prior = state.standard.audio;
  revokeStandardUrl(state.standard.audio?.url);
  state.standard.audio = audio;
  if (prior !== audio && $('#standard-permission').checked) {
    $('#standard-permission').checked = false;
    state.standard.permission = false;
  }
  setFieldError($('#standard-audio-file'), $('#audio-error'));
  $('#audio-state').textContent = audio ? 'Selected' : 'Not selected';
  $('#audio-selection').hidden = !audio;
  $('#audio-name').textContent = audio?.name || '';
  $('#audio-meta').textContent = audio?.meta || '';
  $('#review-audio').textContent = audio?.name || 'Not selected';
  $('#review-duration').textContent = Number.isFinite(audio?.duration) ? audio.duration.toFixed(audio.duration < 10 ? 1 : 0) + ' seconds' : 'Not available';
  const player = $('#standard-audio-preview');
  if (audio?.url) {
    player.src = audio.url;
    player.hidden = false;
    player.load();
  } else {
    player.pause();
    player.removeAttribute('src');
    player.hidden = true;
  }
  resetStandardReview();
}

async function imageMetadata(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = window.setTimeout(() => {
      image.src = '';
      reject(new Error('The portrait took too long to read. Choose it again.'));
    }, 5000);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('The portrait could not be read as an image.'));
    };
    image.src = url;
  });
}

async function validatePortraitFile(file) {
  if (!file) throw new Error('Choose a JPEG or PNG portrait.');
  if (!file.size || file.size > 20_000_000) throw new Error('Choose a nonempty portrait under 20 MB.');
  const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = signature.length >= 8 && [137,80,78,71,13,10,26,10].every((value, index) => signature[index] === value);
  const jpeg = signature.length >= 3 && signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
  if (!png && !jpeg) throw new Error('The file contents must be JPEG or PNG.');
  const url = URL.createObjectURL(file);
  try {
    const metadata = await imageMetadata(url);
    if (metadata.width < 256 || metadata.height < 256 || metadata.width > 4096 || metadata.height > 4096) throw new Error('Use a portrait between 256 and 4096 pixels on each side.');
    state.standard.objectUrls.add(url);
    return { kind: 'file', name: file.name, url, meta: metadata.width + ' × ' + metadata.height + ' · local only' };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function wavText(bytes, offset, length) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

async function validateAudioFile(file) {
  if (!file) throw new Error('Choose a PCM WAV recording.');
  if (!file.size || file.size > 3_000_000) throw new Error('Choose a nonempty WAV recording under 3 MB.');
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 65536)).arrayBuffer());
  if (bytes.length < 44 || wavText(bytes, 0, 4) !== 'RIFF' || wavText(bytes, 8, 4) !== 'WAVE') throw new Error('The recording must be a valid WAV file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== file.size) throw new Error('The WAV recording is truncated or has an invalid length.');
  let offset = 12;
  let format = null;
  let dataBytes = null;
  while (offset + 8 <= bytes.length) {
    const id = wavText(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === 'fmt ' && size >= 16 && start + 16 <= bytes.length) {
      format = {
        encoding: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        byteRate: view.getUint32(start + 8, true),
        blockAlign: view.getUint16(start + 12, true),
        bits: view.getUint16(start + 14, true),
      };
    }
    if (id === 'data') {
      if (start + size > file.size) throw new Error('The WAV recording is truncated.');
      dataBytes = size;
      break;
    }
    const next = start + size + (size % 2);
    if (next <= offset || next > bytes.length) break;
    offset = next;
  }
  if (!format || !dataBytes || ![1, 3].includes(format.encoding) || ![1, 2].includes(format.channels) || ![8, 16, 24, 32].includes(format.bits) || !format.byteRate) throw new Error('Use an uncompressed PCM WAV recording.');
  if (format.sampleRate < 8000 || format.sampleRate > 192000
    || format.blockAlign !== format.channels * format.bits / 8
    || format.byteRate !== format.sampleRate * format.blockAlign
    || dataBytes % format.blockAlign !== 0
    || (format.encoding === 3 && format.bits !== 32)) throw new Error('The WAV recording has inconsistent PCM metadata.');
  const duration = dataBytes / format.byteRate;
  if (!Number.isFinite(duration) || duration < 5 || duration > 60) throw new Error('Use a recording between 5 and 60 seconds.');
  const url = URL.createObjectURL(file);
  state.standard.objectUrls.add(url);
  return { kind: 'file', name: file.name, file, url, duration, meta: duration.toFixed(duration < 10 ? 1 : 0) + ' seconds · ready for private upload' };
}

function standardInputsValid({ focus = false, showErrors = focus } = {}) {
  const checks = [
    [Boolean(state.standard.portrait), $('#standard-portrait-file'), $('#portrait-error'), 'Choose an authorized portrait first.'],
    [Boolean(state.standard.audio), $('#standard-audio-file'), $('#audio-error'), 'Choose an authorized WAV recording first.'],
    [Boolean($('#video-title').value.trim()), $('#video-title'), $('#title-error'), 'Enter a video title.'],
    [$('#standard-permission').checked, $('#standard-permission'), $('#permission-error'), 'Confirm that you are authorized to use both inputs.'],
  ];
  if (!standardFixtureMode) {
    checks.unshift(
      [state.signedIn, $('#standard-portrait-file'), $('#portrait-error'), 'Sign in before preparing a Standard submission.'],
      [state.standard.portrait?.kind === 'identity', $('#standard-portrait-file'), $('#portrait-error'), 'Select an authorized saved identity for Standard.'],
    );
  }
  if (showErrors) for (const [valid, control, error, message] of checks) setFieldError(control, error, valid ? '' : message);
  const first = checks.find(([valid]) => !valid);
  if (focus && first) first[1].focus();
  return !first;
}

function configureStandardSubmit() {
  const button = $('#standard-submit');
  const fixtureInputs = state.standard.portrait?.kind === 'fixture' && state.standard.audio?.kind === 'fixture';
  $('#fixture-submit-note').hidden = !standardFixtureMode;
  if (!standardFixtureMode) {
    if (button.dataset.action === 'view') return;
    if (standardContractController?.earlyStageUncertain) {
      button.dataset.action = 'blocked';
      button.textContent = 'Resolve the uncertain submission above';
      button.disabled = true;
      return;
    }
    if (standardContractController?.pending) {
      button.dataset.action = 'recover';
      button.textContent = 'Recover uncertain Standard submission';
      button.disabled = state.standard.running;
      return;
    }
    if (standardContractJob) {
      button.dataset.action = 'status';
      button.textContent = 'Check Standard status';
      button.disabled = state.standard.running;
      return;
    }
    button.dataset.action = 'run';
    button.textContent = state.signedIn ? 'Submit Standard video' : 'Sign in to submit Standard';
    button.disabled = state.standard.running || !state.signedIn || !state.standard.reviewed
      || state.standard.portrait?.kind !== 'identity' || state.standard.audio?.kind !== 'file' || !standardInputsValid();
    return;
  }
  if (standardContractMode && standardContractController?.pending) return;
  if (button.dataset.action === 'view') return;
  button.dataset.action = 'run';
  button.textContent = state.fixtureResults.length ? 'Run local lifecycle fixture again' : 'Run local lifecycle fixture';
  button.disabled = state.standard.running || !state.standard.reviewed || !fixtureInputs || !standardInputsValid();
}

function showStandardReview() {
  if (!standardInputsValid({ focus: true })) {
    $('#standard-status').dataset.state = 'DRAFT';
    $('#standard-status').textContent = 'Complete the highlighted inputs before review.';
    return;
  }
  state.standard.reviewed = true;
  const duration = state.standard.audio?.duration;
  $('#review-dialog-title').textContent = 'Review Standard inputs';
  reviewRows([
    ['Title', $('#video-title').value.trim()],
    ['Portrait', state.standard.portrait.name],
    ['Audio', state.standard.audio.name],
    ['Duration', Number.isFinite(duration) ? duration.toFixed(duration < 10 ? 1 : 0) + ' seconds' : 'Not available'],
    ['Output', 'MP4 as generated'],
    ['Render cost', 'Not available'],
    ['Permission', 'Confirmed for local review'],
  ], standardFixtureMode
    ? 'This review is local. The named lifecycle fixture uses only synthetic sample assets and never sends these inputs.'
    : state.signedIn && state.standard.portrait?.kind === 'identity'
      ? 'Review does not upload or charge. Submit privately uploads this exact WAV, records versioned consent, requests a server quote, and starts only if Standard is ready.'
      : 'Sign in and select an authorized saved identity before Standard can upload or submit.');
  $('#standard-status').dataset.state = 'VALIDATING';
  $('#standard-status').textContent = standardFixtureMode
    ? 'Fixture inputs reviewed. Ready to run the local lifecycle.'
    : state.signedIn && state.standard.portrait?.kind === 'identity'
      ? 'Inputs reviewed. Submit will check the current Standard runtime before consent or render.'
      : 'Inputs reviewed locally. Sign in and select a saved identity to submit.';
  configureStandardSubmit();
  openDialog($('#review-dialog'), $('[data-dialog-close]', $('#review-dialog')));
}

function mergeFixtureResult(job) {
  state.fixtureResults = [job];
  renderResults();
}

function setFixtureStage(job, status, options = {}) {
  const updated = {
    ...job,
    status,
    stage: status,
    updatedAt: new Date().toISOString(),
    outputAccepted: options.outputAccepted === true,
    url: options.url || null,
    filename: options.filename || null,
    message: options.message || statusCopy(status, job) + ' in local lifecycle fixture.',
  };
  mergeFixtureResult(updated);
  const presented = presentedJobStatus(updated);
  $('#standard-status').dataset.state = presented;
  $('#standard-status').textContent = updated.message;
  return updated;
}

function finishFixture(job) {
  state.standard.running = false;
  if (fixtureOutcome === 'retryable') {
    setFixtureStage(job, 'FAILED_RETRYABLE', { message: 'Local fixture stopped in a retryable failure state. No render was submitted.' });
  } else if (fixtureOutcome === 'final') {
    setFixtureStage(job, 'FAILED_FINAL', { message: 'Local fixture stopped in a final failure state. No render was submitted.' });
  } else if (fixtureOutcome === 'cancelled') {
    setFixtureStage(job, 'CANCELLED', { message: 'Local fixture was cancelled before output acceptance.' });
  } else if (fixtureOutcome === 'unaccepted') {
    setFixtureStage(job, 'SUCCEEDED', { url: fixtureMedia.output, message: 'Fixture rendering ended, but output acceptance is still pending.' });
  } else {
    const accepted = setFixtureStage(job, 'SUCCEEDED', {
      outputAccepted: true,
      url: fixtureMedia.output,
      filename: 'lux-standard-local-fixture.mp4',
      message: 'Local fixture output accepted. Find it in My Videos.',
    });
    $('#standard-submit').dataset.action = 'view';
    $('#standard-submit').textContent = 'View fixture in My Videos';
    $('#standard-submit').disabled = false;
    announce('Local fixture output accepted and available in My Videos.');
    renderResults();
    return accepted;
  }
  $('#standard-submit').dataset.action = 'run';
  configureStandardSubmit();
  announce($('#standard-status').textContent);
  return state.fixtureResults[0];
}

function runFixtureLifecycle() {
  if (standardContractMode) { runStandardContractFixture(); return; }
  if (!standardFixtureMode || state.standard.running || !standardInputsValid({ focus: true })) return;
  if (state.standard.portrait?.kind !== 'fixture' || state.standard.audio?.kind !== 'fixture') {
    showToast('The lifecycle fixture runs only with the supplied synthetic portrait and audio.');
    return;
  }
  state.standard.running = true;
  state.standard.timers.forEach(window.clearTimeout);
  state.standard.timers = [];
  $('#standard-submit').disabled = true;
  const title = $('#video-title').value.trim();
  let job = {
    id: 'fixture-standard-001',
    title,
    tier: 'standard',
    provider: { id: 'standard', name: 'Standard' },
    createdAt: new Date().toISOString(),
    avatar: { name: 'Synthetic fixture portrait' },
    audioReference: { kind: 'local_fixture' },
    fixture: true,
  };
  job = setFixtureStage(job, 'DRAFT', { message: 'Local fixture draft created in memory.' });
  const steps = [
    ['VALIDATING', 'Local fixture inputs are being checked.'],
    ['QUEUED', 'Local fixture job is queued in memory.'],
    ['SUBMITTING', 'Local fixture is entering the simulated render boundary.'],
    ['PROCESSING', 'Local fixture is processing synthetic media.'],
  ];
  steps.forEach(([status, message], index) => {
    const timer = window.setTimeout(() => { job = setFixtureStage(job, status, { message }); }, 400 * (index + 1));
    state.standard.timers.push(timer);
  });
  state.standard.timers.push(window.setTimeout(() => finishFixture(job), 400 * (steps.length + 1)));
}

async function runStandardContractFixture() {
  if (state.standard.running) return;
  if (!standardContractController && (!state.standard.reviewed || !standardInputsValid({ focus: true })
    || state.standard.portrait?.kind !== 'fixture' || state.standard.audio?.kind !== 'fixture')) return;
  state.standard.running = true;
  const button = $('#standard-submit');
  button.disabled = true;
  try {
    const { createStandardFixtureTransport, standardFixtureIds } = await import('./standard-contract-fixture.js');
    if (!standardContractController) {
      const transport = createStandardFixtureTransport({ hostname: location.hostname, outcome: requestedFixtureOutcome });
      standardContractController = createStandardController({ request: transport.request });
      standardContractJob = await standardContractController.submit({
        title: $('#video-title').value.trim(), identityId: standardFixtureIds.identity,
        audioAssetId: standardFixtureIds.audio, permission: $('#standard-permission').checked,
      });
    } else if (!standardContractJob) {
      standardContractJob = await standardContractController.recoverSubmission();
    } else {
      const results = await standardContractController.results();
      standardContractJob = results.find(item => item.id === standardContractJob.id) || standardContractJob;
    }
    mergeFixtureResult(standardContractJob);
    const status = presentedJobStatus(standardContractJob);
    $('#standard-status').dataset.state = status;
    $('#standard-status').textContent = 'Local contract fixture: ' + statusCopy(status, standardContractJob) + '.';
    button.textContent = 'Check fixture status / retrieve library';
    button.disabled = false;
  } catch (error) {
    $('#standard-status').dataset.state = error.status === 403 ? 'FAILED_FINAL' : 'DRAFT';
    $('#standard-status').textContent = 'Local contract fixture: ' + error.message;
    button.textContent = error.status ? 'Fixture submission blocked' : 'Recover uncertain fixture submission';
    button.disabled = Boolean(error.status);
  } finally {
    state.standard.running = false;
    // Bind review to the pending request; recovery cannot silently change media or title.
    for (const selector of ['#video-title', '#standard-permission', '#standard-portrait-file', '#standard-audio-file', '#use-fixture-portrait', '#use-fixture-audio', '#review-inputs', '#remove-portrait', '#remove-audio']) {
      const control = $(selector);
      if (control) control.disabled = true;
    }
  }
}

function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('The WAV recording could not be read for private upload.'));
    reader.readAsDataURL(file);
  });
}

async function standardRequest(url, options = {}) {
  const { body, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers || {});
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return getJson(url, {
    ...requestOptions,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function setStandardInputsLocked(locked) {
  for (const selector of ['#video-title', '#standard-permission', '#standard-portrait-file', '#standard-audio-file', '#review-inputs', '#remove-portrait', '#remove-audio']) {
    const control = $(selector);
    if (control) control.disabled = locked;
  }
}

function showStandardControllerStage(stage, details = {}) {
  const messages = {
    UPLOADING: 'Privately uploading this video\'s narration.',
    DRAFT: 'Creating the script-free Standard project.',
    VALIDATING: 'Checking identity, audio, account, and runtime readiness.',
    CONSENTING: 'Recording versioned consent for this identity and narration.',
    QUOTING: 'Requesting the current Standard quote.',
    QUOTED: 'Server quote accepted. Preparing the idempotent render request.',
    SUBMITTING: details.recovery ? 'Recovering the same Standard request and idempotency key.' : 'Submitting the quoted Standard request.',
    QUEUED: 'Standard request accepted. The saved job can now be recovered from My Videos.',
  };
  $('#standard-status').dataset.state = ['UPLOADING', 'DRAFT', 'VALIDATING', 'CONSENTING', 'QUOTING', 'QUOTED'].includes(stage) ? 'VALIDATING' : stage;
  $('#standard-status').textContent = messages[stage] || 'Checking Standard submission.';
  if (stage === 'QUOTED' && Number.isFinite(Number(details.quote?.credits))) {
    $('#standard-cost').textContent = Number(details.quote.credits).toLocaleString() + ' credits';
  }
}

function mergeStandardResult(job) {
  state.results = [job, ...state.results.filter((item) => item.id !== job.id)];
  state.resultsState = 'ready';
  renderResults();
}

function standardFailureMessage(error) {
  const unavailable = new Set([
    'standard_narration_unavailable', 'standard_narration_policy_unapproved', 'standard_narration_migration_unapproved',
    'standard_narration_pricing_unapproved', 'standard_narration_durable_workflow_disabled', 'standard_narration_render_disabled',
    'standard_narration_account_gate_unavailable', 'standard_narration_account_not_authorized',
  ]);
  if (unavailable.has(error?.code)) return `Standard runtime is not live for this account (${error.code}). No render was submitted.`;
  if (error?.code === 'standard_narration_insufficient_credits') return 'You do not have enough credits for this render. No render was submitted.';
  return error?.message || 'Standard submission could not be completed.';
}

function finishStandardOutcome(job) {
  standardContractJob = job;
  mergeStandardResult(job);
  const status = presentedJobStatus(job);
  $('#standard-status').dataset.state = status;
  $('#standard-status').textContent = 'Standard: ' + statusCopy(status, job) + '.';
  setStandardInputsLocked(true);
  if (resultAccepted(job)) {
    $('#standard-submit').dataset.action = 'view';
    $('#standard-submit').textContent = 'View accepted video in My Videos';
    $('#standard-submit').disabled = false;
  }
}

function showStandardEarlyUncertain(show) {
  $('#standard-early-uncertain').hidden = !show;
  setStandardInputsLocked(show || state.standard.running);
  configureStandardSubmit();
  if (show) $('#standard-check-existing').focus();
}

async function checkStandardExisting() {
  $('#standard-check-existing').disabled = true;
  try {
    const found = await standardContractController.checkExistingProject();
    if (found) {
      $('#standard-status').dataset.state = 'DRAFT';
      $('#standard-status').textContent = `Found "${found.title}" already saved — this submission went through. Check My Videos instead of trying again.`;
      standardContractController.dismissEarlyStageUncertain();
      showStandardEarlyUncertain(false);
    } else {
      $('#standard-status').dataset.state = 'DRAFT';
      $('#standard-status').textContent = 'Not found. The earlier attempt likely did not go through, so it is safe to try again.';
    }
  } catch (error) {
    $('#standard-status').textContent = error.message;
  } finally {
    $('#standard-check-existing').disabled = false;
  }
}

function retryStandardAnyway() {
  standardContractController.dismissEarlyStageUncertain();
  showStandardEarlyUncertain(false);
  state.standard.reviewed = true;
  $('#standard-status').dataset.state = 'DRAFT';
  $('#standard-status').textContent = 'You can try again. This may create a duplicate project if the earlier attempt succeeded.';
}

function failStandardOutcome(error) {
  if (error?.code === 'early_stage_uncertain') {
    $('#standard-status').dataset.state = 'DRAFT';
    $('#standard-status').textContent = 'The connection was lost before we could confirm this submission was saved.';
    showStandardEarlyUncertain(true);
    return;
  }
  const uncertain = error?.code === 'submission_uncertain' && standardContractController?.pending;
  $('#standard-status').dataset.state = uncertain ? 'SUBMITTING' : 'DRAFT';
  $('#standard-status').textContent = standardFailureMessage(error);
  if (uncertain) setStandardInputsLocked(true);
  else {
    state.standard.reviewed = false;
    setStandardInputsLocked(false);
  }
}

function formatQuoteExpiry(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'less than a minute';
  const minutes = Math.round(ms / 60000);
  return minutes <= 1 ? 'about a minute' : `about ${minutes} minutes`;
}

function renderStandardQuote(quote) {
  $('#standard-quote-credits').textContent = Number(quote.credits).toLocaleString() + ' credits';
  $('#standard-quote-expiry').textContent = formatQuoteExpiry(quote.expiresAt);
  $('#standard-cost').textContent = Number(quote.credits).toLocaleString() + ' credits';
  $('#standard-quote-expired-notice').hidden = true;
  $('#standard-quote-requote').hidden = true;
  $('#standard-quote-confirm').hidden = false;
  $('#standard-quote-confirm').disabled = false;
  $('#standard-quote-confirm').textContent = 'Confirm and start render';
}

function openStandardQuoteDialog(quote) {
  renderStandardQuote(quote);
  openDialog($('#standard-quote-dialog'), $('#standard-quote-confirm'));
}

async function confirmStandardQuote() {
  if (state.standard.running) return;
  state.standard.running = true;
  $('#standard-quote-confirm').disabled = true;
  $('#standard-quote-confirm').textContent = 'Starting render…';
  try {
    const job = await standardContractController.confirmQuote();
    closeDialog($('#standard-quote-dialog'));
    finishStandardOutcome(job);
  } catch (error) {
    if (error?.code === 'quote_expired') {
      $('#standard-quote-expired-notice').hidden = false;
      $('#standard-quote-confirm').hidden = true;
      $('#standard-quote-requote').hidden = false;
    } else {
      closeDialog($('#standard-quote-dialog'));
      failStandardOutcome(error);
    }
  } finally {
    state.standard.running = false;
    configureStandardSubmit();
    $('#standard-quote-confirm').textContent = 'Confirm and start render';
  }
}

async function requoteStandard() {
  if (state.standard.running) return;
  state.standard.running = true;
  $('#standard-quote-requote').disabled = true;
  try {
    const quote = await standardContractController.requote();
    renderStandardQuote(quote);
  } catch (error) {
    closeDialog($('#standard-quote-dialog'));
    failStandardOutcome(error);
  } finally {
    state.standard.running = false;
    $('#standard-quote-requote').disabled = false;
    configureStandardSubmit();
  }
}

async function runStandardContract() {
  if (standardFixtureMode || state.standard.running) return;
  const recovering = Boolean(standardContractController?.pending);
  const checking = Boolean(standardContractJob) && !recovering;
  if (!recovering && !checking && (!state.standard.reviewed || !standardInputsValid({ focus: true }))) return;
  state.standard.running = true;
  configureStandardSubmit();
  try {
    if (!standardContractController) {
      standardContractController = createStandardController({ request: standardRequest, onStage: showStandardControllerStage });
    }
    if (recovering) {
      finishStandardOutcome(await standardContractController.recoverSubmission());
    } else if (checking) {
      const results = await standardContractController.results();
      finishStandardOutcome(results.find((item) => item.id === standardContractJob.id) || standardContractJob);
    } else {
      const audio = state.standard.audio;
      const result = await standardContractController.submit({
        title: $('#video-title').value.trim(),
        identityId: state.standard.portrait.identityId,
        audio: { name: audio.name, dataUrl: await fileDataUrl(audio.file) },
        permission: $('#standard-permission').checked,
        format: 'vertical',
      });
      if (result?.awaitingConfirmation) openStandardQuoteDialog(result.quote);
      else finishStandardOutcome(result);
    }
  } catch (error) {
    failStandardOutcome(error);
  } finally {
    state.standard.running = false;
    configureStandardSubmit();
  }
}

function useFixturePortrait() {
  replaceStandardPortrait({ kind: 'fixture', name: 'Synthetic fixture portrait', url: fixtureMedia.portrait, meta: 'Local fixture · not a real person' });
  announce('Synthetic fixture portrait selected.');
}

function useFixtureAudio() {
  replaceStandardAudio({ kind: 'fixture', name: 'fixture-audio.wav', url: fixtureMedia.audio, duration: 1, meta: '1.0 second tone · no spoken voice' });
  announce('Synthetic fixture audio selected.');
}

function premiumIdentityAvatar(identity) {
  return { id: 'identity-avatar:' + identity.id, identityId: identity.id, name: identity.displayName || 'My identity', source: 'identity', previewUrl: identity.portraitUrl || '' };
}

function premiumIdentityVoice(identity) {
  return { id: 'identity-voice:' + identity.id, identityId: identity.id, name: (identity.displayName || 'My identity') + ' voice', source: 'identity' };
}

function choosePremiumIdentity(identity) {
  if (!identity?.id || identity.ready !== true) return;
  state.premium.identityId = identity.id;
  state.premium.avatar = premiumIdentityAvatar(identity);
  state.premium.voice = premiumIdentityVoice(identity);
  state.premium.voiceExplicit = false;
  setFieldError($('#avatar-search'), $('#premium-cast-error'));
  renderPremiumCast();
  renderPremiumAvailability();
  if (!fixtureMode) {
    scriptedIntentChanged('PREMIUM');
    renderScriptedIdentityLists();
  }
  studioPreviewController?.updatePresenter(state.premium.avatar);
}

function choosePremiumAvatar(item, { explicit = true } = {}) {
  if (!item || item.providerReady === false) return;
  const recommendedId = matchedVoiceId(item);
  const recommended = recommendedId ? state.libraries.voice.find((voice) => voice.id === recommendedId && voice.providerReady !== false) : null;
  if (recommendedId && !recommended) {
    setFieldError($('#avatar-search'), $('#premium-cast-error'), (item.name || 'This presenter') + ' requires a matched voice that is unavailable.');
    return;
  }
  setFieldError($('#avatar-search'), $('#premium-cast-error'));
  state.premium.identityId = null;
  state.premium.avatar = item;
  if (!state.premium.voiceExplicit && recommended) state.premium.voice = recommended;
  if (!explicit && !state.premium.voice && state.libraries.voice.length) state.premium.voice = prioritizeVoices(state.libraries.voice, item)[0] || null;
  renderPremiumCast();
  renderPremiumAvailability();
  studioPreviewController?.updatePresenter(item);
}

function choosePremiumVoice(item, { explicit = true } = {}) {
  if (!item || item.providerReady === false) return;
  state.premium.voice = item;
  if (explicit) state.premium.voiceExplicit = true;
  if (state.premium.avatar) setFieldError($('#avatar-search'), $('#premium-cast-error'));
  renderPremiumCast();
  renderPremiumAvailability();
}

function premiumOption(item, type) {
  const button = node('button', 'option-card');
  button.type = 'button';
  button.dataset[type + 'Id'] = item.id;
  const selected = state.premium[type]?.id === item.id;
  button.setAttribute('aria-pressed', String(selected));
  if (type === 'avatar' && item.previewUrl) {
    const image = node('img');
    safeImage(image, item.previewUrl, (item.name || 'Premium presenter') + ' preview');
    button.append(image);
  } else {
    button.append(node('span', 'option-fallback', initials(item.name)));
  }
  const copy = node('span');
  copy.append(node('strong', null, item.name || item.id), node('small', null, type === 'voice' && item.id === matchedVoiceId(state.premium.avatar) ? 'Matched voice' : 'Premium option'));
  button.append(copy);
  const missingMatchedVoice = type === 'avatar' && matchedVoiceId(item) && !state.libraries.voice.some((voice) => voice.id === matchedVoiceId(item) && voice.providerReady !== false);
  if (item.providerReady === false || missingMatchedVoice || state.premium.controlsLocked) {
    button.disabled = true;
    button.title = state.premium.controlsLocked
      ? 'This Premium submission is locked while its outcome is pending.'
      : missingMatchedVoice
        ? 'This presenter’s matched voice is unavailable.'
        : (item.unavailableReason || 'This option is unavailable.');
    if (missingMatchedVoice) copy.querySelector('small').textContent = 'Matched voice unavailable';
  } else {
    button.addEventListener('click', () => type === 'avatar' ? choosePremiumAvatar(item) : choosePremiumVoice(item));
  }
  return button;
}

function renderPremiumCast() {
  const identityTarget = $('#premium-identity-list');
  const readyIdentities = state.identities.filter((identity) => identity.ready === true && !identity.archivedAt);
  if (state.signedIn && readyIdentities.length) identityTarget.replaceChildren(...readyIdentities.map((identity) => identityChoice(identity, 'premium')));
  else identityTarget.replaceChildren(node('p', 'inline-empty', state.signedIn ? 'No Premium-ready private identities.' : 'Sign in to use a private identity.'));

  const usageResults = state.results.map((item) => ({ ...item, status: resultAccepted(item) ? 'ready' : item.status }));
  let avatars = curateDefaultCast(state.libraries.avatar, usageResults, 20);
  if (state.premium.avatar?.source === 'heygen' && !avatars.some((item) => item.id === state.premium.avatar.id)) avatars = [state.premium.avatar, ...avatars].slice(0, 20);
  const avatarQuery = $('#avatar-search').value.trim().toLowerCase();
  const filteredAvatars = avatarQuery ? avatars.filter((item) => (String(item.name || '') + ' ' + String(item.id || '')).toLowerCase().includes(avatarQuery)) : avatars;

  const STUDIO_MAX_CHOICES = 5;
  const topFeaturedKeys = FEATURED_CAST.slice(0, STUDIO_MAX_CHOICES).map((item) => item.key);
  const allowedKeys = new Set(topFeaturedKeys);

  // Exactly 5 curated featured presenters; unapproved HeyGen characters are purged
  const featured = topFeaturedKeys
    .map((key) => filteredAvatars.find((item) => item.featuredKey === key))
    .filter(Boolean);

  $('#featured-cast-list').replaceChildren(...featured.map((item) => {
    const card = premiumOption(item, 'avatar');
    card.dataset.featuredKey = item.featuredKey;
    return card;
  }));
  // Purge any raw HeyGen public characters: only show message if search yields no results
  $('#avatar-list').replaceChildren(...(featured.length ? [] : [node('p', 'inline-empty', avatarQuery ? 'No presenters match this search.' : 'No Premium presenters are available.')]));
  $('#avatar-count').textContent = featured.length + ' curated presenter' + (featured.length === 1 ? '' : 's');
  $('#avatar-more').hidden = true;

  // Exactly 5 curated matched voices corresponding to the top 5 presenters
  let voices = prioritizeVoices(state.libraries.voice, state.premium.avatar)
    .filter((item) => item.featuredKey && allowedKeys.has(item.featuredKey));
  if (state.premium.voice && !voices.some((item) => item.id === state.premium.voice.id)) {
    voices = [state.premium.voice, ...voices];
  }
  const voiceQuery = $('#voice-search').value.trim().toLowerCase();
  const filteredVoices = voiceQuery ? voices.filter((item) => (String(item.name || '') + ' ' + String(item.id || '')).toLowerCase().includes(voiceQuery)) : voices;
  const visibleVoices = filteredVoices.slice(0, STUDIO_MAX_CHOICES);
  $('#voice-list').replaceChildren(...(visibleVoices.length ? visibleVoices.map((item) => premiumOption(item, 'voice')) : [node('p', 'inline-empty', voiceQuery ? 'No voices match this search.' : 'No Premium voices are available.') ]));
  $('#voice-count').textContent = visibleVoices.length + ' available voice' + (visibleVoices.length === 1 ? '' : 's');
  $('#voice-more').hidden = true;
}

function premiumInputsValid({ focus = false, showErrors = focus } = {}) {
  const title = $('#premium-title');
  const script = $('#script-input');
  const castControl = state.premium.avatar ? (state.premium.identityId ? $('[data-premium-identity-id="' + state.premium.identityId + '"]') : $('[data-avatar-id="' + state.premium.avatar.id + '"]')) : $('#avatar-search');
  const checks = [
    [Boolean(title.value.trim()), title, $('#premium-title-error'), 'Enter a Premium video title.'],
    [Boolean(script.value.trim()), script, $('#premium-script-error'), 'Enter the exact Premium script.'],
    [Boolean(state.premium.avatar && state.premium.voice), castControl || $('#avatar-search'), $('#premium-cast-error'), 'Choose a Premium presenter and voice, or a ready private identity.'],
  ];
  if (showErrors) for (const [valid, control, error, message] of checks) {
      if (error === $('#premium-cast-error')) setFieldError($('#avatar-search'), error, valid ? '' : message);
      else setFieldError(control, error, valid ? '' : message);
    }
  const first = checks.find(([valid]) => !valid);
  if (focus && first) first[1]?.focus?.();
  return !first;
}

function premiumDraftSignature() {
  return JSON.stringify({
    title: $('#premium-title').value.trim(),
    script: $('#script-input').value.trim(),
    identityId: state.premium.identityId,
    avatarId: state.premium.avatar?.id || null,
    voiceId: state.premium.voice?.id || null,
    format: $('#export-format').value,
    productionKit: productionPreferences(),
  });
}

function syncPremiumControlLock() {
  const locked = state.premium.controlsLocked;
  $$('#premium-title, #script-input, #avatar-search, #voice-search, #voice-more, #export-format, #provider-select, #premium-composition-enabled, #premium-background, #premium-layout').forEach((control) => { control.disabled = locked; });
  renderPremiumCast();
  renderCompositionPreview();
  copywriterController?.syncPremiumState();
}

function markPremiumTerminal(item) {
  state.premium.activeJobId = null;
  state.premium.submissionUncertain = false;
  state.premium.terminal = true;
  state.premium.controlsLocked = true;
  $('#premium-new-draft').hidden = false;
  $('#generate-video').hidden = true;
  syncPremiumControlLock();
  $('#premium-status').textContent = item.message || statusCopy(presentedJobStatus(item), item);
}

function prepareAnotherPremiumDraft() {
  stopPremiumPolling();
  state.premium.idempotencyKey = null;
  state.premium.idempotencySignature = null;
  state.premium.pendingRequest = null;
  state.premium.submissionUncertain = false;
  state.premium.activeJobId = null;
  state.premium.controlsLocked = false;
  state.premium.terminal = false;
  state.standard.identityId = null;
  state.scripted.capabilities = null;
  state.scripted.quoteTier = null;
  scriptedPhotoClient.clearScope();
  for (const tier of ['STANDARD', 'PREMIUM']) {
    stopScriptedPolling(tier);
    state.scripted.tiers[tier] = { busy: false, job: null, pollingTimer: null, pollingAttempts: 0 };
  }
  state.standard.identityId = null;
  state.scripted.capabilities = null;
  state.scripted.quoteTier = null;
  for (const tier of ['STANDARD', 'PREMIUM']) {
    stopScriptedPolling(tier);
    state.scripted.tiers[tier] = { busy: false, job: null, pollingTimer: null, pollingAttempts: 0 };
    scriptedPhotoClient.resetCompletedIntent(tier);
  }
  state.premium.identityId = null;
  state.premium.avatar = null;
  state.premium.voice = null;
  state.premium.voiceExplicit = false;
  state.project = null;
  $('#premium-composition-enabled').checked = false;
  $('#premium-background').value = PREMIUM_COMPOSITION_CATALOG.defaults.backgroundId;
  $('#premium-layout').value = PREMIUM_COMPOSITION_CATALOG.defaults.layoutId;
  renderCompositionPreview();
  $('#premium-title').value = '';
  $('#script-input').value = '';
  $('#script-count').textContent = '0 / 900';
  setFieldError($('#premium-title'), $('#premium-title-error'));
  setFieldError($('#script-input'), $('#premium-script-error'));
  setFieldError($('#avatar-search'), $('#premium-cast-error'));
  $('#standard-scripted-title').value = '';
  $('#standard-scripted-script').value = '';
  $('#standard-scripted-count').textContent = '0 / 900';
  setFieldError($('#standard-scripted-title'), $('#standard-scripted-title-error'));
  setFieldError($('#standard-scripted-script'), $('#standard-scripted-script-error'));
  setFieldError($('#scripted-standard-identity-list'), $('#standard-scripted-identity-error'));
  $('#standard-scripted-title').value = '';
  $('#standard-scripted-script').value = '';
  $('#standard-scripted-count').textContent = '0 / 900';
  setFieldError($('#standard-scripted-title'), $('#standard-scripted-title-error'));
  setFieldError($('#standard-scripted-script'), $('#standard-scripted-script-error'));
  setFieldError($('#scripted-standard-identity-list'), $('#standard-scripted-identity-error'));
  $('#premium-new-draft').hidden = true;
  $('#generate-video').hidden = false;
  syncPremiumControlLock();
  renderPremiumAvailability();
  studioPreviewController?.updatePresenter(null);
  studioPreviewController?.updateTitle('');
  studioPreviewController?.updateScriptAndCaptions('');
  $('#premium-title').focus();
}

function renderPremiumAvailability() {
  if (!fixtureMode) {
    renderScriptedAvailability('PREMIUM');
    return;
  }
  const provider = premiumProvider();
  const status = $('#provider-status');
  const cost = $('#finish-render-cost');
  const button = $('#generate-video');
  if (fixtureMode) {
    status.dataset.state = 'unavailable';
    status.textContent = 'Unavailable in local fixture mode';
    cost.textContent = 'Not available';
    button.hidden = false;
    button.disabled = true;
    button.textContent = 'Premium unavailable in fixture mode';
    $('#premium-new-draft').hidden = true;
    $('#premium-status').textContent = 'Leave local lifecycle fixture mode before using account or Premium actions.';
    return;
  }
  if (state.premium.terminal) {
    button.hidden = true;
    button.disabled = true;
    $('#premium-new-draft').hidden = false;
    return;
  }
  button.hidden = false;
  $('#premium-new-draft').hidden = true;
  if (!state.signedIn) {
    status.dataset.state = 'unavailable';
    status.textContent = 'Sign in to check Premium';
    cost.textContent = 'Not available';
    button.disabled = true;
    $('#premium-status').textContent = 'Sign in to use your private Premium inputs.';
    return;
  }
  if (!entitlementAllowsPremium()) {
    status.dataset.state = 'unavailable';
    status.textContent = 'Premium is not enabled for this account';
    cost.textContent = premiumQuote(provider) !== null ? premiumQuote(provider) + ' credits' : 'Not available';
    button.disabled = true;
    $('#premium-status').textContent = 'This account does not currently include Premium rendering.';
    return;
  }
  const quote = premiumQuote(provider);
  if (!provider?.configured || quote === null) {
    status.dataset.state = 'unavailable';
    status.textContent = 'Premium service is unavailable';
    cost.textContent = 'Not available';
    button.disabled = true;
    $('#premium-status').textContent = 'Try again later. No render has been submitted.';
    return;
  }
  if (!state.premium.submissionUncertain && !state.premium.activeJobId && $('#premium-composition-enabled').checked && ($('#export-format').value !== 'landscape' || provider.compositionAvailable !== true)) {
    status.dataset.state = 'unavailable';
    status.textContent = 'Background and layout rendering unavailable';
    button.disabled = true;
    $('#premium-status').textContent = $('#export-format').value !== 'landscape' ? 'Choose landscape to use a background and layout.' : 'You can preview these choices. Rendering is not configured for this workspace yet.';
    return;
  }
  status.dataset.state = 'eligible';
  status.textContent = 'Account eligible · service configured';
  cost.textContent = quote + ' credits';
  if (state.premium.activeJobId) {
    button.disabled = true;
    button.textContent = 'Premium render in progress';
    $('#premium-status').textContent = 'The current Premium job is still running. No second submission is available.';
    return;
  }
  if (state.premium.submissionUncertain) {
    button.disabled = state.premium.submitting;
    button.textContent = state.premium.submitting ? 'Recovering submission…' : 'Recover Premium submission';
    $('#premium-status').textContent = 'The prior response was interrupted. Recovery reuses the same request key.';
    return;
  }
  const balance = Number(state.session?.credits?.balance);
  const reserved = Number(state.session?.credits?.reserved || 0);
  if (Number.isFinite(balance) && balance - reserved < quote) {
    status.dataset.state = 'unavailable';
    status.textContent = 'Not enough available credits';
    button.disabled = true;
    $('#premium-status').textContent = 'This render needs ' + quote + ' credits. Your current available balance is ' + Math.max(0, balance - reserved) + '.';
    return;
  }
  button.textContent = state.premium.submitting ? 'Submitting Premium video…' : 'Create Premium video';
  button.disabled = state.premium.submitting || !premiumInputsValid();
  $('#premium-status').textContent = 'Final availability and credit checks run when you submit.';
}

function productionPreferences() {
  if (!$('#premium-composition-enabled').checked) return {};
  return { composition: {
    contractVersion: PREMIUM_COMPOSITION_CATALOG.contractVersion,
    backgroundId: $('#premium-background').value,
    layoutId: $('#premium-layout').value,
  } };
}

function renderCompositionPreview() {
  const enabled = $('#premium-composition-enabled').checked;
  $('#premium-composition-options').hidden = !enabled;
  $('#premium-background').disabled = !enabled || state.premium.controlsLocked;
  $('#premium-layout').disabled = !enabled || state.premium.controlsLocked;
  if (!enabled) return;
  const { background, layout } = resolvePremiumComposition(productionPreferences().composition);
  const preview = $('#premium-composition-preview');
  preview.style.background = background.render.surface;
  preview.style.color = background.preview.foreground;
  preview.dataset.backgroundId = background.id;
  preview.dataset.layoutId = layout.id;
  const presenter = $('#premium-composition-presenter');
  for (const [key, css] of [['x', 'left'], ['y', 'top'], ['width', 'width'], ['height', 'height']]) presenter.style[css] = layout.preview.presenter[key] + '%';
  const copy = $('#premium-composition-copy');
  copy.style.left = layout.preview.copy.x + '%';
  copy.style.top = layout.preview.copy.y + '%';
  copy.style.width = layout.preview.copy.width + '%';
  copy.textContent = $('#premium-title').value.trim() || 'Your message';
  $('#premium-composition-caption').textContent = background.name + ' · ' + layout.name + '. Layout illustration, not a generated video.';
}

function initializeCompositionControls() {
  for (const [selector, items] of [['#premium-background', PREMIUM_COMPOSITION_CATALOG.backgrounds], ['#premium-layout', PREMIUM_COMPOSITION_CATALOG.layouts]]) {
    for (const item of items) { const option = node('option', null, item.name); option.value = item.id; $(selector).append(option); }
  }
  $('#premium-background').value = PREMIUM_COMPOSITION_CATALOG.defaults.backgroundId;
  $('#premium-layout').value = PREMIUM_COMPOSITION_CATALOG.defaults.layoutId;
  renderCompositionPreview();
}

async function savePremiumProject() {
  const avatar = state.premium.avatar;
  const voice = state.premium.voice;
  const body = {
    id: state.project?.id,
    title: $('#premium-title').value.trim(),
    script: $('#script-input').value.trim(),
    avatar: { id: avatar.id, name: avatar.name, source: avatar.source || 'heygen' },
    voice: { id: voice.id, name: voice.name, source: voice.source || 'heygen' },
    settings: {
      format: $('#export-format').value,
      ...productionPreferences(),
    },
  };
  if (state.premium.identityId) body.identityId = state.premium.identityId;
  const data = await getJson('/api/video-os-lite/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  state.project = data.project;
  return data.project;
}

function mergeResult(item) {
  if (!item?.id) return;
  state.results = [item, ...state.results.filter((candidate) => candidate.id !== item.id)].slice(0, 30);
  renderResults();
}

function stopPremiumPolling() {
  window.clearTimeout(state.premium.pollingTimer);
  state.premium.pollingTimer = null;
  state.premium.pollingAttempts = 0;
}

async function pollPremiumResult(jobId) {
  state.premium.pollingTimer = null;
  state.premium.pollingAttempts += 1;
  try {
    const data = await getJson('/api/video-os-lite/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    const item = { ...data, id: data.id || jobId };
    mergeResult(item);
    const presented = presentedJobStatus(item);
    $('#premium-status').textContent = item.message || statusCopy(presented, item);
    if (resultAccepted(item)) {
      stopPremiumPolling();
      markPremiumTerminal(item);
      showToast('Premium output accepted and available in My Videos.');
      loadResults().catch(() => setNotice('The accepted video is ready, but the full video list could not be refreshed.', 'error', true));
      return;
    }
    if (['FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED'].includes(presented)) {
      stopPremiumPolling();
      markPremiumTerminal(item);
      return;
    }
    if (state.premium.pollingAttempts >= 45) {
      $('#premium-status').textContent = 'Status checks paused. The saved job may still be running; no second submission is available.';
      setNotice('Premium status checks paused. Reload the workspace to recover the saved job state.', 'error', true);
      return;
    }
    state.premium.pollingTimer = window.setTimeout(() => pollPremiumResult(jobId), Math.min(30000, 5000 + state.premium.pollingAttempts * 1000));
  } catch (error) {
    const failedItem = error.payload?.id || error.payload?.status
      ? { ...error.payload, id: error.payload.id || jobId }
      : null;
    if (failedItem && ['FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED'].includes(presentedJobStatus(failedItem))) {
      mergeResult(failedItem);
      stopPremiumPolling();
      markPremiumTerminal(failedItem);
      return;
    }
    $('#premium-status').textContent = error.message + ' The saved job was not submitted again.';
    setNotice('Premium status could not be refreshed. Reload the workspace to recover the saved job state.', 'error', true);
    showToast(error.message);
    stopPremiumPolling();
  }
}

async function submitPremium(event) {
  event.preventDefault();
  if (state.premium.submitting || state.premium.activeJobId || state.premium.terminal) return;
  if (!state.premium.submissionUncertain && !premiumInputsValid({ focus: true })) return;
  const provider = premiumProvider();
  if (!state.signedIn) {
    openAuthModal();
    return;
  }
  if (!entitlementAllowsPremium() || !provider?.configured || premiumQuote(provider) === null) {
    renderPremiumAvailability();
    return;
  }
  if (!state.premium.submissionUncertain && $('#premium-composition-enabled').checked
      && ($('#export-format').value !== 'landscape' || provider.compositionAvailable !== true)) {
    renderPremiumAvailability();
    return;
  }
  state.premium.submitting = true;
  copywriterController?.syncPremiumState();
  renderPremiumAvailability();
  let renderAttempted = false;
  try {
    let request = state.premium.pendingRequest;
    if (!state.premium.submissionUncertain || !request) {
      $('#premium-status').textContent = 'Saving the Premium project before submission.';
      const project = await savePremiumProject();
      const signature = premiumDraftSignature();
      if (!state.premium.idempotencyKey || state.premium.idempotencySignature !== signature) {
        state.premium.idempotencyKey = crypto.randomUUID();
        state.premium.idempotencySignature = signature;
      }
      request = {
        idempotencyKey: state.premium.idempotencyKey,
        projectId: project.id,
        provider: 'heygen',
        tier: 'PREMIUM',
        title: $('#premium-title').value.trim(),
        script: $('#script-input').value.trim(),
        format: $('#export-format').value,
        productionKit: productionPreferences(),
      };
      if (state.premium.identityId) request.identityId = state.premium.identityId;
      else {
        request.avatar = { avatarId: state.premium.avatar.avatarId || state.premium.avatar.id };
        request.voice = { voiceId: state.premium.voice.voiceId || state.premium.voice.id, locale: state.premium.voice.locale };
      }
      state.premium.pendingRequest = request;
      state.premium.controlsLocked = true;
      syncPremiumControlLock();
    }
    $('#premium-status').textContent = state.premium.submissionUncertain ? 'Recovering the prior Premium submission.' : 'Submitting one Premium render.';
    renderAttempted = true;
    const data = await getJson('/api/video-os-lite/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!data.job?.id) throw Object.assign(new Error('Premium submission returned no recoverable job reference.'), { code: 'invalid_response', retryable: true });
    state.premium.submissionUncertain = false;
    if (data.credits && state.session) state.session.credits = data.credits;
    if (data.job) mergeResult(data.job);
    renderAccount();
    $('#premium-status').textContent = data.message || 'Premium job accepted.';
    if (data.job?.id) {
      state.premium.activeJobId = data.job.id;
      stopPremiumPolling();
      state.premium.pollingTimer = window.setTimeout(() => pollPremiumResult(data.job.id), 3000);
    }
  } catch (error) {
    if (renderAttempted && (error.retryable || ['network_timeout', 'network_unavailable', 'invalid_response'].includes(error.code))) {
      state.premium.submissionUncertain = true;
      state.premium.controlsLocked = true;
      $('#premium-status').textContent = error.message + ' Recover with the same request key; do not start another render.';
    } else {
      state.premium.idempotencyKey = null;
      state.premium.idempotencySignature = null;
      state.premium.pendingRequest = null;
      state.premium.controlsLocked = false;
      syncPremiumControlLock();
      $('#premium-status').textContent = error.message;
    }
    showToast(error.message);
  } finally {
    state.premium.submitting = false;
    copywriterController?.syncPremiumState();
    renderPremiumAvailability();
  }
}

function safeProviderName(item) {
  if (item.fixture) return 'Local lifecycle fixture';
  const tier = String(item.tier || '').toLowerCase();
  const providerId = String(typeof item.provider === 'object' ? item.provider.id : item.provider || '').toLowerCase();
  return tier === 'standard' || providerId === 'standard' ? 'Standard' : 'Premium';
}

function resultCard(item) {
  const status = presentedJobStatus(item);
  const accepted = resultAccepted(item);
  const url = accepted ? safeOwnedOutputUrl(item) : null;
  const card = node('article', 'result-card');
  card.dataset.jobId = item.id || '';
  card.dataset.jobState = status;
  const media = node('div', 'result-media');
  const marker = node('span', 'result-badge', statusCopy(status, item));
  marker.dataset.tone = accepted ? 'success' : ['FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED'].includes(status) ? 'error' : 'neutral';
  media.append(node('strong', null, accepted ? 'Accepted MP4' : statusCopy(status, item)), marker);
  const body = node('div', 'result-body');
  body.append(node('strong', null, item.title || 'Untitled video'));
  const details = [safeProviderName(item), formatDate(item.updatedAt || item.createdAt)];
  body.append(node('span', 'result-meta', details.join(' · ')));
  body.append(node('span', 'result-message', item.message || statusCopy(status, item)));
  const actions = node('div', 'result-actions');
  if (accepted && url) {
    const preview = node('button', 'button secondary compact result-preview-action', 'Preview');
    preview.type = 'button';
    preview.addEventListener('click', () => bindAcceptedResult(item));
    const download = node('a', 'button quiet compact', 'Download');
    download.href = url;
    download.download = item.filename || 'lux-video.mp4';
    actions.append(preview, download);
  }
  if (status === 'FAILED_RETRYABLE') actions.append(node('span', 'result-meta', 'Review inputs before any new submission.'));
  body.append(actions);
  card.append(media, body);
  return card;
}

function combinedResults() {
  return [...state.fixtureResults, ...state.results.filter((item) => !state.fixtureResults.some((fixture) => fixture.id === item.id))].slice(0, 30);
}

function bindAcceptedResult(item) {
  const url = resultAccepted(item) ? safeOwnedOutputUrl(item) : null;
  if (!url) return false;
  state.selectedResultId = item.id;
  const preview = $('#preview');
  const video = $('#accepted-video');
  video.onerror = () => {
    video.hidden = true;
    preview.dataset.previewState = 'error';
    $('#preview-empty').textContent = 'The accepted video preview could not be loaded. The secure download remains available.';
  };
  video.src = url + (url.includes('?') ? '&' : '?') + (url === fixtureMedia.output ? 'fixture=1' : 'disposition=inline');
  video.setAttribute('aria-label', 'Play ' + (item.title || item.filename || 'accepted video'));
  video.hidden = false;
  video.load();
  $('#preview-empty').textContent = (item.title || 'Accepted video') + ' passed output acceptance and is ready to play.';
  const link = $('#download-link');
  link.href = url;
  link.download = item.filename || 'lux-video.mp4';
  link.textContent = 'Download ' + (item.filename || 'accepted MP4');
  link.hidden = false;
  preview.hidden = false;
  preview.dataset.previewState = 'completed';
  return true;
}

function clearAcceptedPreview() {
  const video = $('#accepted-video');
  video.pause();
  video.removeAttribute('src');
  video.hidden = true;
  $('#download-link').removeAttribute('href');
  $('#download-link').hidden = true;
  $('#preview').hidden = true;
  $('#preview').dataset.previewState = 'empty';
  state.selectedResultId = null;
}

function renderResults() {
  const items = combinedResults();
  const target = $('#result-gallery');
  const status = $('#results-state');
  const toggle = $('#result-gallery-toggle');
  if (!items.length) {
    clearAcceptedPreview();
    const empty = node('div', 'empty-state');
    const title = state.signedIn ? 'Your first video starts here' : 'Sign in to recover your videos';
    const copy = state.signedIn ? 'Accepted outputs and in-flight jobs will appear here.' : 'Account-owned jobs and accepted videos are hidden while signed out.';
    empty.append(node('span', 'empty-mark', 'L'), node('h2', null, title), node('p', null, copy));
    const action = node(state.signedIn ? 'a' : 'button', 'button primary', state.signedIn ? 'Create a video' : 'Sign in');
    if (state.signedIn) action.href = '#create';
    else {
      action.type = 'button';
      action.addEventListener('click', openAuthModal);
    }
    empty.append(action);
    target.replaceChildren(empty);
    status.textContent = state.resultsState === 'error' ? 'Video history could not be loaded. Try loading the workspace again.' : (state.signedIn ? 'No videos yet' : 'Signed out');
    toggle.hidden = true;
    return;
  }
  const count = Math.min(state.resultLimit, items.length);
  target.replaceChildren(...items.slice(0, count).map(resultCard));
  status.textContent = items.length + ' job' + (items.length === 1 ? '' : 's') + ' shown from this workspace';
  toggle.hidden = items.length <= 6;
  toggle.textContent = count >= items.length ? 'Show recent six' : 'View all ' + items.length + ' videos';
  toggle.setAttribute('aria-expanded', String(count >= items.length));
  const selected = state.selectedResultId ? items.find((item) => item.id === state.selectedResultId && resultAccepted(item)) : null;
  if (selected) {
    if ($('#preview').dataset.previewState !== 'completed') bindAcceptedResult(selected);
  } else if (resultAccepted(items[0])) {
    bindAcceptedResult(items[0]);
  } else {
    clearAcceptedPreview();
  }
}

function renderConnection(stateName, text) {
  const pill = $('#connection-pill');
  pill.dataset.state = stateName;
  pill.textContent = text;
}

async function loadProviders(generation = state.workspaceGeneration) {
  const data = await getJson('/api/video-os-lite/providers');
  if (generation !== state.workspaceGeneration) return;
  state.providers = (data.providers || []).filter((provider) => provider.id === 'heygen');
  if (data.account && state.session) state.session = { ...state.session, ...data, signedIn: true };
}

async function loadIdentities(generation = state.workspaceGeneration) {
  state.identitiesState = 'loading';
  renderMyCast();
  renderIdentityLibrary();
  try {
    const data = await getJson('/api/video-os-lite/identities');
    if (generation !== state.workspaceGeneration) return;
    state.identities = data.identities || [];
    state.identitiesState = 'ready';
  } catch (error) {
    if (generation === state.workspaceGeneration) state.identitiesState = 'error';
    throw error;
  }
}

async function loadTalent(generation = state.workspaceGeneration) {
  const data = await getJson('/api/video-os/talent');
  if (generation !== state.workspaceGeneration) return;
  state.libraries.avatar = data.talent?.avatars || [];
  state.libraries.voice = data.talent?.voices || [];
}

async function loadProjects(generation = state.workspaceGeneration) {
  const data = await getJson('/api/video-os-lite/projects');
  if (generation !== state.workspaceGeneration) return;
  state.project = data.projects?.find(project => project.settings?.tier !== 'STANDARD') || null;
}

async function loadResults(generation = state.workspaceGeneration) {
  if (!state.signedIn) {
    state.results = [];
    state.resultsState = 'signed-out';
    renderResults();
    return;
  }
  try {
    state.resultsState = 'loading';
    const data = await getJson('/api/video-os-lite/results');
    if (generation !== state.workspaceGeneration) return;
    state.results = data.results || [];
    state.resultsState = state.results.length ? 'ready' : 'empty';
  } catch (error) {
    if (generation !== state.workspaceGeneration) return;
    state.results = [];
    state.resultsState = 'error';
    throw error;
  } finally {
    renderResults();
  }
}

function restoreLatestProject() {
  if (!fixtureMode && scriptedPhotoClient.publicState('PREMIUM').draft) return;
  const project = state.project;
  if (!project) return;
  $('#premium-title').value = project.title || '';
  if (project.settings?.composition) {
    try {
      const { selection } = resolvePremiumComposition(project.settings.composition);
      $('#premium-composition-enabled').checked = true;
      $('#premium-background').value = selection.backgroundId;
      $('#premium-layout').value = selection.layoutId;
      $('#export-format').value = 'landscape';
    } catch { setNotice('The saved layout could not be restored. Review your composition before submitting.', 'error'); }
  }
  renderCompositionPreview();
  $('#script-input').value = project.script || '';
  $('#script-count').textContent = $('#script-input').value.length + ' / 900';
  const identity = project.identityId ? state.identities.find((item) => item.id === project.identityId && item.ready === true && !item.archivedAt) : null;
  if (identity) {
    choosePremiumIdentity(identity);
  } else {
    const avatarId = project.avatar?.id;
    const voiceId = project.voice?.id;
    state.premium.identityId = null;
    state.premium.avatar = state.libraries.avatar.find((item) => item.id === avatarId) || null;
    state.premium.voice = state.libraries.voice.find((item) => item.id === voiceId) || null;
    state.premium.voiceExplicit = Boolean(state.premium.voice);
  }
  const active = state.results.find((item) => item.projectId === project.id && liveStates.has(presentedJobStatus(item)));
  if (active) {
    state.premium.activeJobId = active.id;
    state.premium.controlsLocked = true;
    syncPremiumControlLock();
  }
  studioPreviewController?.updatePresenter(state.premium.avatar);
  studioPreviewController?.updateScriptAndCaptions($('#script-input').value);
  studioPreviewController?.updateTitle($('#premium-title').value);
}

function selectDefaultPremiumCast() {
  if (!fixtureMode) return;
  if (state.premium.avatar || state.premium.identityId) return;
  const candidates = curateDefaultCast(state.libraries.avatar, [], 20);
  const first = candidates.find((item) => item.providerReady !== false);
  if (first) choosePremiumAvatar(first, { explicit: false });
}

function reconcilePremiumResultState() {
  if (!state.premium.activeJobId) return;
  const tracked = state.results.find((item) => item.id === state.premium.activeJobId);
  if (!tracked) return;
  const status = presentedJobStatus(tracked);
  if (resultAccepted(tracked) || ['FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED'].includes(status)) markPremiumTerminal(tracked);
}

function consumeIdentityHandoff() {
  if (!state.signedIn) return;
  const url = new URL(location.href);
  const identityId = url.searchParams.get('identityId');
  if (!identityId) return;
  url.searchParams.delete('identityId');
  history.replaceState({}, '', url.pathname + url.search + url.hash);
  const identity = state.identities.find((item) => item.id === identityId && item.ready === true && !item.archivedAt);
  if (!identity) {
    showToast('That private identity is unavailable for this account.');
    return;
  }
  selectStandardIdentity(identity);
  choosePremiumIdentity(identity);
  announce((identity.displayName || 'Private identity') + ' selected.');
}

function consumeAuthReturn() {
  const url = new URL(location.href);
  const returned = url.searchParams.get('signed_in') === '1' || url.searchParams.get('ceo_access') === '1';
  const requestedSignIn = url.searchParams.get('signin') === '1';
  if (returned) {
    url.searchParams.delete('signed_in');
    url.searchParams.delete('ceo_access');
    history.replaceState({}, '', url.pathname + url.search + url.hash);
    if (state.signedIn) showToast('Sign-in complete. Your workspace is ready.');
  }
  if (requestedSignIn && !state.signedIn) openAuthModal();
}

function clearWorkspaceData() {
  state.providers = [];
  state.identities = [];
  state.identitiesState = 'ready';
  state.results = [];
  state.resultsState = 'signed-out';
  state.project = null;
  state.libraries.avatar = [];
  state.libraries.voice = [];
  state.premium.avatar = null;
  state.premium.voice = null;
  state.premium.identityId = null;
  state.premium.voiceExplicit = false;
  state.premium.idempotencyKey = null;
  state.premium.idempotencySignature = null;
  state.premium.pendingRequest = null;
  state.premium.submissionUncertain = false;
  state.premium.activeJobId = null;
  state.premium.controlsLocked = false;
  state.premium.terminal = false;
  $('#premium-composition-enabled').checked = false;
  $('#premium-background').value = PREMIUM_COMPOSITION_CATALOG.defaults.backgroundId;
  $('#premium-layout').value = PREMIUM_COMPOSITION_CATALOG.defaults.layoutId;
  renderCompositionPreview();
  $('#premium-title').value = '';
  $('#script-input').value = '';
  $('#script-count').textContent = '0 / 900';
  setFieldError($('#premium-title'), $('#premium-title-error'));
  setFieldError($('#script-input'), $('#premium-script-error'));
  setFieldError($('#avatar-search'), $('#premium-cast-error'));
  $('#premium-new-draft').hidden = true;
  $('#generate-video').hidden = false;
  if (state.standard.portrait?.kind === 'identity') replaceStandardPortrait(null);
  $('#standard-permission').checked = false;
  state.standard.permission = false;
  standardContractController = null;
  standardContractJob = null;
  setStandardInputsLocked(false);
  resetStandardReview();
  state.selectedResultId = null;
  clearAcceptedPreview();
  stopPremiumPolling();
  syncPremiumControlLock();
}

function renderWorkspace() {
  renderAccount();
  renderMyCast();
  renderIdentityLibrary();
  renderPremiumCast();
  renderPremiumAvailability();
  renderScriptedStudio();
  renderResults();
  configureStandardSubmit();
  copywriterController?.syncSession();
  copywriterController?.syncPremiumState();
}

async function refreshWorkspace() {
  const generation = ++state.workspaceGeneration;
  setNotice();
  renderConnection('loading', 'Checking workspace');
  $('#account-nav-detail').textContent = 'Checking session';
  try {
    const session = await getJson('/api/video-os-lite/session');
    if (generation !== state.workspaceGeneration) return;
    const priorAccountId = state.session?.account?.accountId;
    const nextAccountId = session.account?.accountId;
    if (priorAccountId && nextAccountId && priorAccountId !== nextAccountId) {
      copywriterController?.clearAccountState();
      clearWorkspaceData();
    }
    state.signedIn = Boolean(session.signedIn);
    state.session = state.signedIn ? session : { ok: true, signedIn: false };
    if (!state.signedIn) {
      // /welcome is the front door for anonymous visitors now; this shell
      // is reached directly only via its own ?signin=1 links (from
      // /welcome's CTAs) or on localhost (dev/E2E, same exemption
      // fixtureMode already uses) -- everyone else gets redirected there
      // instead of landing on a signed-out shell.
      if (!localHost && new URL(location.href).searchParams.get('signin') !== '1') {
        location.replace('/welcome');
        return;
      }
      if (priorAccountId) copywriterController?.clearAccountState();
      clearWorkspaceData();
      renderConnection('signed-out', 'Sign in for saved work');
      renderWorkspace();
      consumeAuthReturn();
      return;
    }
    hydrateScriptedDrafts(scriptedPhotoClient.setScope(nextAccountId));
    renderConnection('signed-in', fixtureMode ? 'Local fixture workspace' : 'Signed-in workspace');
    const operations = [
      ['identities', loadIdentities(generation)],
      ['saved projects', loadProjects(generation)],
      ['videos', loadResults(generation)],
    ];
    if (fixtureMode) operations.push(['Premium availability', loadProviders(generation)], ['presenters and voices', loadTalent(generation)]);
    else operations.push(['scripted rendering availability', loadScriptedCapabilities()]);
    if (!fixtureMode) operations.push(['AI Copywriter', copywriterController.loadAvailability()]);
    const outcomes = await Promise.allSettled(operations.map((entry) => entry[1]));
    if (generation !== state.workspaceGeneration) return;
    const failed = outcomes.map((outcome, index) => outcome.status === 'rejected' ? operations[index][0] : null).filter(Boolean);
    restoreLatestProject();
    consumeIdentityHandoff();
    selectDefaultPremiumCast();
    reconcilePremiumResultState();
    renderWorkspace();
    if (failed.length) setNotice('Some workspace data could not be loaded: ' + failed.join(', ') + '.', 'error', true);
    consumeAuthReturn();
  } catch (error) {
    if (generation !== state.workspaceGeneration) return;
    if (state.session?.account?.accountId) copywriterController?.clearAccountState();
    state.signedIn = false;
    state.session = null;
    clearWorkspaceData();
    renderConnection('error', 'Workspace unavailable');
    renderWorkspace();
    setNotice(error.message, 'error', true);
  }
}

function setAuthStatus(message = '', tone = 'info') {
  const target = $('#auth-status');
  target.textContent = message;
  target.dataset.tone = tone;
  target.setAttribute('role', tone === 'error' ? 'alert' : 'status');
}

const AUTH_MODE_COPY = {
  signin: { title: 'Welcome back', intro: 'Sign in to your creative workspace.' },
  signup: { title: 'Create your workspace', intro: 'Set up access with an email link or workspace credentials.' },
};

function setAuthMode(mode) {
  const resolved = AUTH_MODE_COPY[mode] ? mode : 'signin';
  $$('[data-auth-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.authMode === resolved)));
  $('#auth-modal-title').textContent = AUTH_MODE_COPY[resolved].title;
  $('#auth-intro').textContent = AUTH_MODE_COPY[resolved].intro;
}

function syncAuthModal() {
  $$('[data-auth-signed-out]').forEach((element) => { element.hidden = state.signedIn; });
  $('#auth-session-summary').hidden = !state.signedIn;
  $('#sign-out').hidden = !state.signedIn;
  $('#auth-session-email').textContent = state.session?.email || state.session?.account?.name || 'Your LUX account';
  $$('[aria-controls="auth-modal"]').forEach((button) => button.setAttribute('aria-expanded', String($('#auth-modal').open)));
  if (fixtureMode) {
    $$('#password-login-form input, #password-login-form button, #magic-link-form input, #magic-link-form button, #sign-out').forEach((control) => { control.disabled = true; });
  }
}

function openAuthModal() {
  setAuthMode('signin');
  syncAuthModal();
  setAuthStatus(fixtureMode ? 'Account changes are disabled in the local lifecycle fixture.' : (state.signedIn ? 'Your workspace session is active.' : ''));
  openDialog($('#auth-modal'), fixtureMode ? $('#close-login') : (state.signedIn ? $('#sign-out') : $('#password-username')));
  syncAuthModal();
}

function setAuthPending(pending, method = '') {
  $$('#auth-modal input, #auth-modal button').forEach((control) => {
    if (control.id !== 'close-login') control.disabled = pending || fixtureMode;
  });
  $('#password-login').textContent = pending && method === 'password' ? 'Signing in…' : 'Sign in to workspace';
  $('#send-magic-link').textContent = pending && method === 'magic' ? 'Sending link…' : 'Send sign-in link';
}

async function passwordLogin(event) {
  event.preventDefault();
  const form = $('#password-login-form');
  if (!form.reportValidity()) return;
  const username = $('#password-username').value.trim();
  const password = $('#password-password').value;
  setAuthPending(true, 'password');
  setAuthStatus('Signing in…');
  state.authRetry = () => passwordLogin(new Event('submit'));
  try {
    await getJson('/api/video-os-lite/password-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    state.authRetry = null;
    $('#auth-retry').hidden = true;
    setAuthStatus('Signed in. Loading your workspace.', 'success');
    await refreshWorkspace();
    closeDialog($('#auth-modal'));
  } catch (error) {
    setAuthStatus(error.message, 'error');
    $('#auth-retry').hidden = false;
  } finally {
    setAuthPending(false);
  }
}

async function requestMagicLink(event) {
  event.preventDefault();
  const form = $('#magic-link-form');
  if (!form.reportValidity()) return;
  const email = $('#auth-email').value.trim();
  setAuthPending(true, 'magic');
  setAuthStatus('Sending your secure link…');
  state.authRetry = () => requestMagicLink(new Event('submit'));
  try {
    const data = await getJson('/api/video-os-lite/auth-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, origin: location.origin }),
    });
    state.authRetry = null;
    $('#auth-retry').hidden = true;
    setAuthStatus('Check your inbox at ' + (data.email || email) + '.', 'success');
  } catch (error) {
    setAuthStatus(error.message, 'error');
    $('#auth-retry').hidden = false;
  } finally {
    setAuthPending(false);
  }
}

async function signOut() {
  state.workspaceGeneration += 1;
  setAuthPending(true);
  setAuthStatus('Signing out…');
  try {
    await getJson('/api/video-os-lite/session', { method: 'POST' });
    state.signedIn = false;
    state.session = { ok: true, signedIn: false };
    copywriterController?.clearAccountState();
    clearWorkspaceData();
    renderConnection('signed-out', 'Sign in for saved work');
    renderWorkspace();
    closeDialog($('#auth-modal'));
    showToast('Signed out.');
  } catch (error) {
    setAuthStatus(error.message, 'error');
  } finally {
    setAuthPending(false);
  }
}

copywriterController = createCopywriterController({
  getJson,
  isSignedIn: () => state.signedIn,
  isFixtureMode: () => copywriterFixtureMode,
  isPremiumLocked: () => scriptedTierLocked(activeScriptedTier()),
  getPremiumScript: () => scriptedElements(activeScriptedTier()).script.value,
  applyPremiumScript: (text) => {
    const tier = activeScriptedTier();
    const tierLabel = tier === 'PREMIUM' ? 'Premium' : 'Standard';
    if (scriptedTierLocked(tier)) {
      window.setTimeout(() => { $('#copywriter-status').textContent = `${tierLabel} is locked while its current render or recovery is being resolved.`; }, 0);
      return false;
    }
    const input = scriptedElements(tier).script;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setTier(tier === 'PREMIUM' ? 'premium' : 'standard');
    if (location.hash !== '#create') location.hash = 'create';
    else navigate({ focus: false });
    window.setTimeout(() => input.focus(), 0);
    window.setTimeout(() => {
      $('#copywriter-status').textContent = `Working draft moved to ${tierLabel}. Nothing was saved or rendered.`;
      announce(`Working draft moved to the ${tierLabel} editor.`);
    }, 0);
    return true;
  },
  onSessionInvalid: () => {
    state.workspaceGeneration += 1;
    state.signedIn = false;
    state.session = { ok: true, signedIn: false };
    clearWorkspaceData();
    renderConnection('signed-out', 'Sign in for saved work');
    renderWorkspace();
  },
  openDialog,
  closeDialog,
  announce,
  showToast,
});

studioPreviewController = createStudioPreviewController({
  getScript: () => $('#script-input')?.value || '',
  getTitle: () => $('#premium-title')?.value || '',
  getPresenter: () => state.premium.avatar,
  onFormatChange: (format) => {
    const select = $('#export-format');
    if (select && select.value !== format) {
      select.value = format;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  },
});

$('#open-menu').addEventListener('click', () => {
  $('#open-menu').setAttribute('aria-expanded', 'true');
  openDialog($('#mobile-menu'), $('[data-menu-close]', $('#mobile-menu')));
});
$('[data-menu-close]').addEventListener('click', () => closeDialog($('#mobile-menu')));
$$('#mobile-menu a').forEach((link) => link.addEventListener('click', () => {
  if (location.hash === link.hash) {
    closeDialog($('#mobile-menu'), { restore: false });
    navigate();
  }
}));
window.addEventListener('hashchange', () => navigate());

$('#standard-tab').addEventListener('click', () => setTier('standard'));
$('#premium-tab').addEventListener('click', () => setTier('premium'));
$$('[role="tab"]').forEach((tab) => tab.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  setTier(tab.id === 'standard-tab' ? 'premium' : 'standard', { focus: true });
}));
$('#premium-info').addEventListener('click', showTierComparison);

$('#standard-portrait-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  try {
    replaceStandardPortrait(await validatePortraitFile(file));
    announce('Local portrait selected. Nothing was uploaded.');
  } catch (error) {
    event.target.value = '';
    setFieldError(event.target, $('#portrait-error'), error.message);
  }
});
$('#remove-portrait').addEventListener('click', () => {
  replaceStandardPortrait(null);
  $('#standard-portrait-file').value = '';
  $('#standard-portrait-file').focus();
  announce('Portrait removed.');
});
$('#standard-audio-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  try {
    replaceStandardAudio(await validateAudioFile(file));
    announce('Local WAV recording selected. Nothing was uploaded.');
  } catch (error) {
    event.target.value = '';
    setFieldError(event.target, $('#audio-error'), error.message);
  }
});
$('#remove-audio').addEventListener('click', () => {
  replaceStandardAudio(null);
  $('#standard-audio-file').value = '';
  $('#standard-audio-file').focus();
  announce('Audio removed.');
});
$('#video-title').addEventListener('input', () => {
  if ($('#video-title').value.trim()) setFieldError($('#video-title'), $('#title-error'));
  resetStandardReview();
});
$('#standard-permission').addEventListener('change', () => {
  state.standard.permission = $('#standard-permission').checked;
  if (state.standard.permission) setFieldError($('#standard-permission'), $('#permission-error'));
  resetStandardReview();
});
$('#review-inputs').addEventListener('click', showStandardReview);
$('#standard-submit').addEventListener('click', () => {
  if ($('#standard-submit').dataset.action === 'view') {
    location.hash = 'videos';
    const item = [...state.fixtureResults, ...state.results].find((result) => result.id === standardContractJob?.id && resultAccepted(result))
      || state.fixtureResults.find(resultAccepted);
    if (item) bindAcceptedResult(item);
    return;
  }
  if (standardFixtureMode) runFixtureLifecycle();
  else runStandardContract();
});
$('#use-fixture-portrait').addEventListener('click', useFixturePortrait);
$('#use-fixture-audio').addEventListener('click', useFixtureAudio);
$('#standard-quote-confirm').addEventListener('click', confirmStandardQuote);
$('#standard-quote-requote').addEventListener('click', requoteStandard);
$('#standard-check-existing').addEventListener('click', checkStandardExisting);
$('#standard-retry-anyway').addEventListener('click', retryStandardAnyway);
$('#scripted-standard-form').addEventListener('submit', (event) => { event.preventDefault(); void requestScriptedQuote('STANDARD'); });
$('#standard-scripted-title').addEventListener('input', () => {
  if ($('#standard-scripted-title').value.trim()) setFieldError($('#standard-scripted-title'), $('#standard-scripted-title-error'));
  scriptedIntentChanged('STANDARD');
});
$('#standard-scripted-script').addEventListener('input', () => {
  $('#standard-scripted-count').textContent = $('#standard-scripted-script').value.length + ' / 900';
  if ($('#standard-scripted-script').value.trim()) setFieldError($('#standard-scripted-script'), $('#standard-scripted-script-error'));
  scriptedIntentChanged('STANDARD');
});
$('#standard-scripted-format').addEventListener('change', () => scriptedIntentChanged('STANDARD'));
$('#standard-scripted-check').addEventListener('click', () => void checkScriptedRecovery('STANDARD'));
$('#standard-scripted-retry').addEventListener('click', () => void retryScriptedRequest('STANDARD'));
$('#standard-scripted-new-draft').addEventListener('click', () => prepareAnotherScriptedDraft('STANDARD'));

$$('[data-dialog-close]').forEach((button) => button.addEventListener('click', () => closeDialog(button.closest('dialog'))));
$$('[data-scripted-quote-close]').forEach((button) => button.addEventListener('click', () => closeDialog($('#scripted-photo-quote-dialog'))));
$('#scripted-photo-quote-confirm').addEventListener('click', () => void confirmScriptedQuote());
$('#scripted-photo-requote').addEventListener('click', () => {
  const tier = state.scripted.quoteTier;
  closeDialog($('#scripted-photo-quote-dialog'));
  if (tier) void requestScriptedQuote(tier);
});
$('#close-login').addEventListener('click', () => closeDialog($('#auth-modal')));
$$('[data-open-login]').forEach((button) => button.addEventListener('click', openAuthModal));
$('#password-login-form').addEventListener('submit', passwordLogin);
$('#magic-link-form').addEventListener('submit', requestMagicLink);
$('#sign-out').addEventListener('click', signOut);
$('#auth-retry').addEventListener('click', () => state.authRetry?.());
$('#workspace-retry').addEventListener('click', refreshWorkspace);

$$('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
$('#toggle-auth-password').addEventListener('click', () => {
  const input = $('#password-password');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  $('#toggle-auth-password').textContent = showing ? 'Show' : 'Hide';
  $('#toggle-auth-password').setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  $('#toggle-auth-password').setAttribute('aria-pressed', String(!showing));
});

$('#script-input').addEventListener('input', () => {
  $('#script-count').textContent = $('#script-input').value.length + ' / 900';
  if ($('#script-input').value.trim()) setFieldError($('#script-input'), $('#premium-script-error'));
  renderPremiumAvailability();
  if (!fixtureMode) scriptedIntentChanged('PREMIUM');
});
$('#premium-title').addEventListener('input', () => {
  if ($('#premium-title').value.trim()) setFieldError($('#premium-title'), $('#premium-title-error'));
  renderPremiumAvailability();
  if (!fixtureMode) scriptedIntentChanged('PREMIUM');
});
$('#avatar-search').addEventListener('input', renderPremiumCast);
$('#voice-search').addEventListener('input', () => { state.visible.voice = 20; renderPremiumCast(); });
$('#voice-more').addEventListener('click', () => { state.visible.voice += 20; renderPremiumCast(); });
$('#video-form').addEventListener('submit', (event) => {
  if (fixtureMode) return submitPremium(event);
  event.preventDefault();
  void requestScriptedQuote('PREMIUM');
});
$('#premium-new-draft').addEventListener('click', () => fixtureMode ? prepareAnotherPremiumDraft() : prepareAnotherScriptedDraft('PREMIUM'));
$$('#voice-more, #export-format, #provider-select').forEach((control) => control.addEventListener('change', () => {
  renderPremiumAvailability();
  if (!fixtureMode && control.id === 'export-format') scriptedIntentChanged('PREMIUM');
}));
$('#premium-scripted-check').addEventListener('click', () => void checkScriptedRecovery('PREMIUM'));
$('#premium-scripted-retry').addEventListener('click', () => void retryScriptedRequest('PREMIUM'));
$('#premium-composition-enabled').addEventListener('change', () => {
  if ($('#premium-composition-enabled').checked) $('#export-format').value = 'landscape';
  renderCompositionPreview(); renderPremiumAvailability();
});
$$('#premium-background, #premium-layout').forEach(control => control.addEventListener('change', () => { renderCompositionPreview(); renderPremiumAvailability(); }));
$('#premium-title').addEventListener('input', renderCompositionPreview);
$('#result-gallery-toggle').addEventListener('click', () => {
  state.resultLimit = state.resultLimit > 6 ? 6 : 30;
  renderResults();
});

window.addEventListener('beforeunload', () => {
  stopPremiumPolling();
  stopScriptedPolling('STANDARD');
  stopScriptedPolling('PREMIUM');
  state.standard.timers.forEach(window.clearTimeout);
  state.standard.objectUrls.forEach((url) => URL.revokeObjectURL(url));
});

if (standardFixtureMode) {
  document.body.classList.add('fixture-mode');
  $('#fixture-banner').hidden = false;
  $$('.fixture-control').forEach((control) => { control.hidden = false; });
  $('#fixture-submit-note').hidden = false;
}
if (!standardFixtureMode) {
  $('#permission-help').textContent = 'Submitting records versioned consent for this exact saved identity and uploaded narration.';
  $('#audio-help').textContent = 'Current private upload accepts a 5–60 second PCM WAV, up to 3 MB. No script or synthetic voice is needed.';
}
if (copywriterFixtureMode) {
  document.body.classList.add('fixture-mode');
  $('#copywriter-fixture-banner').hidden = false;
}

initializeCompositionControls();
navigate({ focus: false });
setTier('standard');
renderMyCast();
renderIdentityLibrary();
renderPremiumCast();
renderResults();
configureStandardSubmit();
refreshWorkspace();
