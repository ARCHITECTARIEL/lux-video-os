const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set(['draft', 'shorten', 'improve_hook', 'revise']);
const GOALS = new Set(['sales', 'social', 'explainer', 'testimonial', 'custom']);
const TONES = new Set(['clear', 'warm', 'confident', 'professional']);

export function createCopywriterController(options) {
  const {
    getJson,
    isSignedIn,
    isFixtureMode,
    isPremiumLocked,
    getPremiumScript,
    applyPremiumScript,
    onSessionInvalid,
    openDialog,
    closeDialog,
    announce,
    showToast,
  } = options;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const controls = {
    availability: $('#copywriter-availability'),
    form: $('#copywriter-form'),
    topic: $('#copywriter-topic'),
    audience: $('#copywriter-audience'),
    goal: $('#copywriter-goal'),
    tone: $('#copywriter-tone'),
    keyPoints: $('#copywriter-key-points'),
    callToAction: $('#copywriter-cta'),
    draft: $('#copywriter-working-draft'),
    instructions: $('#copywriter-instructions'),
    draftAction: $('#copywriter-draft'),
    shortenAction: $('#copywriter-shorten'),
    hookAction: $('#copywriter-hook'),
    reviseAction: $('#copywriter-revise'),
    copyAction: $('#copywriter-copy'),
    premiumAction: $('#copywriter-use-premium'),
    premiumNote: $('#copywriter-premium-note'),
    status: $('#copywriter-status'),
    candidatePanel: $('#copywriter-candidate-panel'),
    candidate: $('#copywriter-candidate'),
    candidateState: $('#copywriter-candidate-state'),
    candidateNote: $('#copywriter-candidate-note'),
    reviewCandidate: $('#copywriter-review-candidate'),
    accept: $('#copywriter-accept'),
    discard: $('#copywriter-discard'),
    handoffDialog: $('#premium-handoff-dialog'),
    handoffConfirm: $('#premium-handoff-confirm'),
  };
  const state = {
    available: false,
    availabilityState: 'checking',
    pending: false,
    activeOperation: null,
    revision: 0,
    requestSerial: 0,
    availabilitySerial: 0,
    candidate: null,
    workingSource: 'local',
    pendingHandoff: null,
  };

  function setStatus(message, status = 'idle') {
    controls.status.textContent = message;
    controls.status.dataset.state = status;
    controls.status.setAttribute('role', ['error', 'timeout', 'rate-limited', 'refusal'].includes(status) ? 'alert' : 'status');
  }

  function setAvailability(value, status, message) {
    state.available = value;
    state.availabilityState = status;
    controls.availability.dataset.state = status;
    controls.availability.textContent = message;
    updateControls();
  }

  function setError(control, selector, message = '') {
    const target = $(selector);
    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
    target.textContent = message;
    target.hidden = !message;
  }

  function updateCount(control, selector, maximum) {
    $(selector).textContent = control.value.length + ' / ' + maximum;
  }

  function updateAllCounts() {
    updateCount(controls.topic, '#copywriter-topic-count', 120);
    updateCount(controls.audience, '#copywriter-audience-count', 160);
    updateCount(controls.keyPoints, '#copywriter-key-points-count', 2000);
    updateCount(controls.callToAction, '#copywriter-cta-count', 300);
    updateCount(controls.draft, '#copywriter-working-count', 900);
    updateCount(controls.instructions, '#copywriter-instructions-count', 600);
  }

  function workingText() {
    return controls.draft.value.trim();
  }

  function premiumLocked() {
    return Boolean(isPremiumLocked());
  }

  function updateActionLabels() {
    controls.draftAction.textContent = state.pending && state.activeOperation === 'draft' ? 'Drafting…' : 'Draft script';
    controls.shortenAction.textContent = state.pending && state.activeOperation === 'shorten' ? 'Shortening…' : 'Shorten';
    controls.hookAction.textContent = state.pending && state.activeOperation === 'improve_hook' ? 'Improving hook…' : 'Improve hook';
    controls.reviseAction.textContent = state.pending && state.activeOperation === 'revise' ? 'Revising…' : 'Apply custom revision';
  }

  function updateCandidate() {
    if (!state.candidate) {
      controls.candidatePanel.hidden = true;
      controls.reviewCandidate.hidden = true;
      controls.accept.disabled = true;
      return;
    }
    controls.candidatePanel.hidden = false;
    controls.reviewCandidate.hidden = false;
    controls.candidate.value = state.candidate.text;
    const stale = state.candidate.stale === true;
    const accepted = state.candidate.accepted === true;
    const fixture = state.candidate.fixture === true;
    controls.candidateState.dataset.state = stale ? 'stale' : accepted ? 'accepted' : fixture ? 'fixture' : 'ready';
    controls.candidateState.textContent = stale ? 'Draft changed · candidate is stale' : accepted ? 'Accepted into working draft' : fixture ? 'Synthetic fixture candidate' : 'Ready to review';
    controls.candidateNote.textContent = stale
      ? 'Your brief or working draft changed after this request started. This candidate cannot replace the newer text.'
      : accepted
        ? 'The working draft changed only after your explicit acceptance.'
        : 'Your working draft has not changed.';
    controls.accept.disabled = stale || accepted;
  }

  function updateControls() {
    const canRequest = state.available && !state.pending;
    const hasDraft = Boolean(workingText());
    controls.draftAction.disabled = !canRequest;
    controls.shortenAction.disabled = !canRequest || !hasDraft;
    controls.hookAction.disabled = !canRequest || !hasDraft;
    controls.reviseAction.disabled = !canRequest || !hasDraft;
    controls.copyAction.disabled = !hasDraft;
    controls.premiumAction.disabled = !hasDraft || premiumLocked();
    controls.premiumNote.hidden = !hasDraft || !premiumLocked();
    if (!hasDraft) controls.premiumAction.title = 'Accept or write a working draft first.';
    else if (premiumLocked()) controls.premiumAction.title = 'Premium is locked while a render, recovery, or completed draft is being resolved.';
    else controls.premiumAction.removeAttribute('title');
    updateActionLabels();
    updateCandidate();
  }

  function markCandidateStale() {
    if (state.candidate && !state.candidate.accepted) state.candidate.stale = true;
    updateCandidate();
  }

  function sourceEdited({ working = false } = {}) {
    state.revision += 1;
    if (working) {
      if (!controls.draft.value) state.workingSource = 'local';
      else if (state.workingSource !== 'ai' && state.workingSource !== 'fixture') state.workingSource = 'local';
    }
    markCandidateStale();
    updateAllCounts();
    updateControls();
  }

  function brief() {
    return {
      topic: controls.topic.value.trim(),
      audience: controls.audience.value.trim(),
      goal: GOALS.has(controls.goal.value) ? controls.goal.value : 'custom',
      tone: TONES.has(controls.tone.value) ? controls.tone.value : 'clear',
      keyPoints: controls.keyPoints.value.trim(),
      callToAction: controls.callToAction.value.trim(),
    };
  }

  function validateBrief({ focus = true } = {}) {
    const topicMessage = controls.topic.value.trim() ? '' : 'Enter a title or topic.';
    const audienceMessage = controls.audience.value.trim() ? '' : 'Enter the intended audience.';
    setError(controls.topic, '#copywriter-topic-error', topicMessage);
    setError(controls.audience, '#copywriter-audience-error', audienceMessage);
    const first = topicMessage ? controls.topic : audienceMessage ? controls.audience : null;
    if (focus) first?.focus();
    return !first;
  }

  function validateRefinement(operation) {
    if (!workingText()) {
      setError(controls.draft, '#copywriter-working-error', 'Write or accept a working draft before refining it.');
      controls.draft.focus();
      return false;
    }
    setError(controls.draft, '#copywriter-working-error');
    if (operation === 'revise' && !controls.instructions.value.trim()) {
      setError(controls.instructions, '#copywriter-instructions-error', 'Describe the revision you want.');
      controls.instructions.focus();
      return false;
    }
    setError(controls.instructions, '#copywriter-instructions-error');
    return true;
  }

  function fixtureResult(operation, payload) {
    const marker = 'LOCAL COPY FIXTURE — NOT AI OUTPUT';
    if (operation === 'draft') {
      const points = payload.brief.keyPoints
        ? payload.brief.keyPoints.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 4)
        : ['Explain the practical value in plain language.'];
      return [
        marker,
        '',
        'Hook: ' + payload.brief.topic + ' matters to ' + payload.brief.audience + '.',
        '',
        ...points.map((point) => '• ' + point),
        '',
        payload.brief.callToAction || 'End with one clear next step.',
      ].join('\n').slice(0, 900);
    }
    if (operation === 'shorten') {
      const words = payload.draft.split(/\s+/).filter(Boolean);
      return [marker, '', words.slice(0, Math.max(12, Math.ceil(words.length * .65))).join(' ')].join('\n').slice(0, 900);
    }
    if (operation === 'improve_hook') {
      return [marker, '', 'Start here: ' + payload.brief.topic + ' has one consequence your audience should understand now.', '', payload.draft].join('\n').slice(0, 900);
    }
    return [marker, '', 'Requested revision: ' + payload.instructions, '', payload.draft].join('\n').slice(0, 900);
  }

  function applyFailure(error, { availabilityCheck = false } = {}) {
    const code = String(error?.code || '');
    const message = error?.message || 'Copywriter could not complete this request.';
    if (code === 'sign_in_required' || error?.status === 401) {
      clearAccountState();
      onSessionInvalid?.();
      setAvailability(false, 'signed-out', 'Sign in to use AI');
      setStatus(message, 'error');
    } else if (code === 'copywriter_not_authorized' || error?.status === 403) {
      setAvailability(false, 'not-authorized', 'Not available for this account');
      setStatus(message, 'error');
    } else if (code === 'copywriter_unavailable' || error?.status === 503) {
      setAvailability(false, 'unavailable', 'Copywriter unavailable');
      setStatus(message, 'error');
    } else if (code === 'rate_limited' || error?.status === 429) {
      controls.availability.dataset.state = 'rate-limited';
      controls.availability.textContent = 'Request limit reached';
      setStatus(message, 'rate-limited');
    } else if (code === 'generation_refused' || error?.status === 422) {
      setStatus(message, 'refusal');
    } else if (code === 'generation_timeout' || code === 'network_timeout' || error?.status === 504) {
      if (availabilityCheck) setAvailability(false, 'error', 'Availability check failed');
      setStatus(message, 'timeout');
    } else {
      if (availabilityCheck) setAvailability(false, 'error', 'Availability check failed');
      setStatus(message, 'error');
    }
  }

  async function requestCandidate(operation) {
    if (!OPERATIONS.has(operation) || state.pending || !state.available) return;
    if (!validateBrief()) return;
    if (operation !== 'draft' && !validateRefinement(operation)) return;
    const payload = {
      idempotencyKey: crypto.randomUUID(),
      operation,
      brief: brief(),
    };
    if (operation !== 'draft') payload.draft = workingText();
    if (operation === 'revise') payload.instructions = controls.instructions.value.trim();
    const baseRevision = state.revision;
    const serial = ++state.requestSerial;
    state.pending = true;
    state.activeOperation = operation;
    setStatus(isFixtureMode() ? 'Preparing a synthetic fixture candidate…' : 'Preparing a new candidate…', 'pending');
    updateControls();
    try {
      let result;
      if (isFixtureMode()) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        result = { text: fixtureResult(operation, payload), operation, requestId: payload.idempotencyKey };
      } else {
        const data = await getJson('/api/video-os-lite/copywriter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          timeoutMs: 35000,
        });
        result = data.result;
      }
      if (serial !== state.requestSerial) return;
      const text = String(result?.text || '').trim();
      if (!text || text.length > 900 || result?.operation !== operation || !UUID_PATTERN.test(String(result?.requestId || '')) || result.requestId !== payload.idempotencyKey) {
        throw Object.assign(new Error('Copywriter returned an incomplete candidate. Your working draft was not changed.'), { code: 'generation_incomplete' });
      }
      const stale = state.revision !== baseRevision;
      state.candidate = {
        text,
        operation,
        requestId: result.requestId,
        baseRevision,
        stale,
        fixture: isFixtureMode(),
        accepted: false,
      };
      setStatus(stale ? 'Candidate received, but your draft changed while it was being prepared.' : 'Candidate ready. Review it before accepting.', stale ? 'stale' : 'ready');
      updateCandidate();
      announce(stale ? 'A stale Copywriter candidate is available for comparison.' : 'A Copywriter candidate is ready for review.');
    } catch (error) {
      if (serial === state.requestSerial) applyFailure(error);
    } finally {
      if (serial === state.requestSerial) {
        state.pending = false;
        state.activeOperation = null;
        updateControls();
      }
    }
  }

  function acceptCandidate() {
    if (!state.candidate || state.candidate.stale || state.candidate.accepted) return;
    controls.draft.value = state.candidate.text;
    state.workingSource = state.candidate.fixture ? 'fixture' : 'ai';
    state.revision += 1;
    state.candidate.accepted = true;
    updateAllCounts();
    updateControls();
    setStatus('Candidate accepted into your working draft.', 'accepted');
    announce('Candidate accepted. Review the working draft before using it.');
    controls.draft.focus();
  }

  function discardCandidate() {
    state.candidate = null;
    controls.candidate.value = '';
    controls.candidatePanel.hidden = true;
    updateControls();
    setStatus('Candidate discarded. Your working draft was unchanged.', 'idle');
    announce('Candidate discarded.');
  }

  function reviewCandidate() {
    if (!state.candidate) return;
    controls.candidatePanel.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    window.setTimeout(() => controls.candidate.focus(), 0);
  }

  async function copyForRecording() {
    const text = workingText();
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const start = controls.draft.selectionStart;
        const end = controls.draft.selectionEnd;
        controls.draft.focus();
        controls.draft.select();
        if (!document.execCommand?.('copy')) throw new Error('Clipboard access is unavailable.');
        controls.draft.setSelectionRange(start, end);
      }
      setStatus('Copied working draft. Record it in your own authorized voice for Standard.', 'copied');
      announce('Working draft copied for recording.');
    } catch {
      setStatus('Copy failed. Select the working draft and copy it manually.', 'error');
      controls.draft.focus();
    }
  }

  function completePremiumHandoff(text) {
    if (!text || premiumLocked()) {
      setStatus('Premium is locked while its current render or recovery is being resolved.', 'error');
      updateControls();
      return;
    }
    if (applyPremiumScript(text) === false) {
      setStatus('Premium became unavailable before the handoff completed. Your working draft was preserved.', 'error');
      updateControls();
      return;
    }
    setStatus('Working draft moved to Premium. Nothing was saved or rendered.', 'accepted');
    announce('Working draft moved to the Premium editor.');
  }

  function useInPremium() {
    const text = workingText();
    if (!text) return;
    if (premiumLocked()) {
      setStatus('Premium is locked while its current render or recovery is being resolved.', 'error');
      updateControls();
      return;
    }
    const existing = String(getPremiumScript() || '').trim();
    if (existing && existing !== text) {
      state.pendingHandoff = text;
      openDialog(controls.handoffDialog, $('[data-handoff-cancel]', controls.handoffDialog));
      return;
    }
    completePremiumHandoff(text);
  }

  function confirmPremiumHandoff() {
    const text = state.pendingHandoff;
    state.pendingHandoff = null;
    closeDialog(controls.handoffDialog);
    completePremiumHandoff(text);
  }

  async function loadAvailability() {
    const serial = ++state.availabilitySerial;
    if (isFixtureMode()) {
      setAvailability(true, 'fixture', 'Synthetic fixture mode');
      setStatus('Fixture mode uses deterministic sample text and sends no AI request.', 'idle');
      return;
    }
    if (!isSignedIn()) {
      setAvailability(false, 'signed-out', 'Sign in to use AI');
      setStatus('Sign in to draft or refine with AI. You can still write locally.', 'idle');
      return;
    }
    setAvailability(false, 'checking', 'Checking availability');
    try {
      const data = await getJson('/api/video-os-lite/copywriter', { timeoutMs: 35000 });
      if (serial !== state.availabilitySerial) return;
      const capability = data.copywriter || {};
      if (capability.available === true && capability.reason === 'ready') {
        setAvailability(true, 'ready', 'AI Copywriter available');
        setStatus('Ready when you are. No draft is saved automatically.', 'idle');
        return;
      }
      const mapping = {
        disabled: ['disabled', 'Copywriter is turned off'],
        setup_required: ['missing-setup', 'Setup required'],
        not_authorized: ['not-authorized', 'Not available for this account'],
      };
      const [status, fallback] = mapping[capability.reason] || ['unavailable', 'Copywriter unavailable'];
      setAvailability(false, status, fallback);
      setStatus(capability.message || fallback + '.', 'error');
    } catch (error) {
      if (serial !== state.availabilitySerial) return;
      applyFailure(error, { availabilityCheck: true });
    }
  }

  function clearAccountState() {
    state.requestSerial += 1;
    state.availabilitySerial += 1;
    state.pending = false;
    state.activeOperation = null;
    state.pendingHandoff = null;
    state.candidate = null;
    controls.candidate.value = '';
    controls.candidatePanel.hidden = true;
    controls.topic.value = '';
    controls.audience.value = '';
    controls.goal.value = 'explainer';
    controls.tone.value = 'clear';
    controls.keyPoints.value = '';
    controls.callToAction.value = '';
    controls.draft.value = '';
    controls.instructions.value = '';
    state.workingSource = 'local';
    state.revision += 1;
    setError(controls.topic, '#copywriter-topic-error');
    setError(controls.audience, '#copywriter-audience-error');
    setError(controls.draft, '#copywriter-working-error');
    setError(controls.instructions, '#copywriter-instructions-error');
    if (controls.handoffDialog.open) closeDialog(controls.handoffDialog, { restore: false });
    if (isFixtureMode()) {
      setAvailability(true, 'fixture', 'Synthetic fixture mode');
      setStatus('Fixture mode uses deterministic sample text and sends no AI request.', 'idle');
    } else {
      setAvailability(false, 'signed-out', 'Sign in to use AI');
      setStatus('Signed out. Account-generated candidates were cleared.', 'idle');
    }
    updateAllCounts();
    updateControls();
  }

  function syncSession() {
    if (isFixtureMode()) {
      setAvailability(true, 'fixture', 'Synthetic fixture mode');
    } else if (!isSignedIn()) {
      setAvailability(false, 'signed-out', 'Sign in to use AI');
      setStatus('Sign in to draft or refine with AI. You can still write locally.', 'idle');
    }
    updateControls();
  }

  function syncPremiumState() {
    updateControls();
  }

  [controls.topic, controls.audience, controls.keyPoints, controls.callToAction, controls.instructions].forEach((control) => {
    control.addEventListener('input', () => sourceEdited());
  });
  controls.topic.addEventListener('input', () => { if (controls.topic.value.trim()) setError(controls.topic, '#copywriter-topic-error'); });
  controls.audience.addEventListener('input', () => { if (controls.audience.value.trim()) setError(controls.audience, '#copywriter-audience-error'); });
  [controls.goal, controls.tone].forEach((control) => control.addEventListener('change', () => sourceEdited()));
  controls.draft.addEventListener('input', () => {
    setError(controls.draft, '#copywriter-working-error');
    sourceEdited({ working: true });
  });
  controls.instructions.addEventListener('input', () => {
    if (controls.instructions.value.trim()) setError(controls.instructions, '#copywriter-instructions-error');
  });
  controls.draftAction.addEventListener('click', () => requestCandidate('draft'));
  controls.shortenAction.addEventListener('click', () => requestCandidate('shorten'));
  controls.hookAction.addEventListener('click', () => requestCandidate('improve_hook'));
  controls.reviseAction.addEventListener('click', () => requestCandidate('revise'));
  controls.accept.addEventListener('click', acceptCandidate);
  controls.discard.addEventListener('click', discardCandidate);
  controls.reviewCandidate.addEventListener('click', reviewCandidate);
  controls.copyAction.addEventListener('click', copyForRecording);
  controls.premiumAction.addEventListener('click', useInPremium);
  controls.handoffConfirm.addEventListener('click', confirmPremiumHandoff);
  controls.form.addEventListener('submit', (event) => event.preventDefault());
  $$('[data-handoff-cancel]', controls.handoffDialog).forEach((button) => button.addEventListener('click', () => {
    state.pendingHandoff = null;
    closeDialog(controls.handoffDialog);
  }));

  updateAllCounts();
  updateCandidate();
  syncSession();

  return {
    loadAvailability,
    clearAccountState,
    syncSession,
    syncPremiumState,
  };
}
