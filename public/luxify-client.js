export const LUXIFY_CONTRACT_VERSION = 'luxify-cinematic-v1';

const ENDPOINT = '/api/video-os-lite/luxify';
const RENDER_ENDPOINT = '/api/video-os-lite/render';
const STORAGE_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DRAFT_KEYS = new Set(['title', 'prompt', 'lookIdentityIds', 'aspectRatio', 'resolution', 'durationSeconds']);
const ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1']);
const RESOLUTIONS = new Set(['720p', '1080p']);

function clientError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function canonicalUuid(value, field) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID.test(normalized)) throw clientError('invalid_' + field, 'LUXIFY ' + field + ' is invalid.');
  return normalized;
}

function canonicalDraft(draft = {}) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)
    || Object.keys(draft).some(key => !DRAFT_KEYS.has(key))) {
    throw clientError('invalid_draft', 'LUXIFY draft contains unsupported fields.');
  }
  const title = String(draft.title || '').trim();
  const prompt = String(draft.prompt || '').trim();
  if (title.length > 120) throw clientError('invalid_title', 'Enter a title up to 120 characters.');
  if (prompt.length > 1_500) throw clientError('invalid_prompt', 'Enter a prompt up to 1500 characters.');
  const rawLooks = draft.lookIdentityIds ?? [];
  if (!Array.isArray(rawLooks) || rawLooks.length > 3) {
    throw clientError('invalid_looks', 'Choose up to three eligible looks.');
  }
  const lookIdentityIds = rawLooks.map(value => canonicalUuid(value, 'look'));
  if (new Set(lookIdentityIds).size !== lookIdentityIds.length) {
    throw clientError('invalid_looks', 'Choose each eligible look once.');
  }
  const aspectRatio = String(draft.aspectRatio || '').trim();
  if (aspectRatio && !ASPECT_RATIOS.has(aspectRatio)) throw clientError('invalid_aspect_ratio', 'Choose a supported aspect ratio.');
  const resolution = String(draft.resolution || '').trim();
  if (resolution && !RESOLUTIONS.has(resolution)) throw clientError('invalid_resolution', 'Choose 720p or 1080p.');
  const durationSeconds = draft.durationSeconds === undefined || draft.durationSeconds === null || draft.durationSeconds === ''
    ? null
    : draft.durationSeconds;
  if (durationSeconds !== null && (!Number.isInteger(durationSeconds) || durationSeconds < 4 || durationSeconds > 15)) {
    throw clientError('invalid_duration', 'Choose a duration from 4 to 15 seconds.');
  }
  return Object.freeze({
    title,
    prompt,
    lookIdentityIds: Object.freeze(lookIdentityIds),
    aspectRatio,
    resolution,
    durationSeconds,
  });
}

function validateDraft(draft) {
  const value = canonicalDraft(draft);
  if (!value.title) throw clientError('invalid_title', 'Enter a title up to 120 characters.');
  if (!value.prompt) throw clientError('invalid_prompt', 'Enter a prompt up to 1500 characters.');
  if (value.lookIdentityIds.length < 1) throw clientError('invalid_looks', 'Choose one to three eligible looks.');
  if (!ASPECT_RATIOS.has(value.aspectRatio)) throw clientError('invalid_aspect_ratio', 'Choose a supported aspect ratio.');
  if (!RESOLUTIONS.has(value.resolution)) throw clientError('invalid_resolution', 'Choose 720p or 1080p.');
  if (!Number.isInteger(value.durationSeconds)) throw clientError('invalid_duration', 'Choose a duration from 4 to 15 seconds.');
  return value;
}

export function luxifyIntentSignature(draft) {
  const value = canonicalDraft(draft);
  return JSON.stringify([
    LUXIFY_CONTRACT_VERSION,
    value.title,
    value.prompt,
    value.lookIdentityIds,
    value.aspectRatio,
    value.resolution,
    value.durationSeconds,
  ]);
}

function newState(createId, seed = {}) {
  return {
    projectId: seed.projectId || createId(),
    idempotencyKey: seed.idempotencyKey || null,
    signature: seed.signature || null,
    quote: null,
    quoteSignature: null,
    uncertain: seed.uncertain === true,
    recoveryChecked: seed.recoveryChecked === true,
    existingJob: null,
    draft: seed.draft || null,
  };
}

function safeReason(value) {
  const reason = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,80}$/.test(reason) ? reason : null;
}

function safeLabel(value) {
  const label = String(value || '').trim();
  return label && label.length <= 120 ? label : 'Eligible look';
}

function normalizeCapabilities(response) {
  const source = response?.contractVersion === LUXIFY_CONTRACT_VERSION
    && response.capabilities && typeof response.capabilities === 'object' && !Array.isArray(response.capabilities)
    ? response.capabilities
    : null;
  if (!source) return Object.freeze({ available: false, reasons: Object.freeze(['contract_unavailable']), eligibleLooks: Object.freeze([]) });
  const seen = new Set();
  const eligibleLooks = [];
  for (const candidate of Array.isArray(source.eligibleLooks) ? source.eligibleLooks : []) {
    const identityId = String(candidate?.identityId || '').trim().toLowerCase();
    if (!UUID.test(identityId) || seen.has(identityId)) continue;
    seen.add(identityId);
    eligibleLooks.push(Object.freeze({ identityId, displayName: safeLabel(candidate.displayName) }));
  }
  const reasons = [...new Set((Array.isArray(source.reasons) ? source.reasons : []).map(safeReason).filter(Boolean))];
  const available = source.available === true && eligibleLooks.length > 0;
  if (!available && source.available === true && eligibleLooks.length === 0 && !reasons.includes('no_eligible_looks')) reasons.push('no_eligible_looks');
  return Object.freeze({
    available,
    reasons: Object.freeze(reasons),
    eligibleLooks: Object.freeze(eligibleLooks),
  });
}

export function createLuxifyClient({
  request,
  createId = () => crypto.randomUUID(),
  now = () => Date.now(),
  storage = null,
} = {}) {
  if (typeof request !== 'function') throw new TypeError('A request function is required.');
  let state = newState(createId);
  let capabilities = null;
  let storageKey = null;

  function persist() {
    if (!storage || !storageKey) return;
    try {
      storage.setItem(storageKey, JSON.stringify({
        version: STORAGE_VERSION,
        state: {
          projectId: state.projectId,
          idempotencyKey: state.idempotencyKey,
          signature: state.signature,
          uncertain: state.uncertain,
          recoveryChecked: state.recoveryChecked,
          draft: state.draft,
        },
      }));
    } catch {}
  }

  function publicState() {
    return {
      projectId: state.projectId,
      idempotencyKey: state.idempotencyKey,
      signature: state.signature,
      quote: state.quote ? {
        credits: state.quote.credits,
        currency: state.quote.currency,
        expiresAt: state.quote.expiresAt,
        pricingVersion: state.quote.pricingVersion,
      } : null,
      uncertain: state.uncertain,
      recoveryChecked: state.recoveryChecked,
      existingJob: state.existingJob,
      draft: state.draft ? { ...state.draft, lookIdentityIds: [...state.draft.lookIdentityIds] } : null,
    };
  }

  function setScope(accountId) {
    capabilities = null;
    const normalized = String(accountId || '').trim();
    storageKey = normalized ? 'video-os-luxify-v1:' + encodeURIComponent(normalized) : null;
    let candidate = null;
    if (storage && storageKey) {
      try {
        const saved = JSON.parse(storage.getItem(storageKey) || 'null');
        candidate = saved?.version === STORAGE_VERSION ? saved.state : null;
      } catch {}
    }
    let seed = {};
    try {
      const validProject = UUID.test(candidate?.projectId || '');
      const validKey = candidate?.idempotencyKey === null || UUID.test(candidate?.idempotencyKey || '');
      const draft = candidate?.draft ? canonicalDraft(candidate.draft) : null;
      const validSignature = !draft || candidate.signature === luxifyIntentSignature(draft);
      if (validProject && validKey && validSignature) seed = { ...candidate, projectId: candidate.projectId.toLowerCase(), idempotencyKey: candidate.idempotencyKey?.toLowerCase() || null, draft };
    } catch {}
    state = newState(createId, seed);
    persist();
    return publicState();
  }

  function clearScope() {
    if (storage && storageKey) {
      try { storage.removeItem(storageKey); } catch {}
    }
    state = newState(createId);
    capabilities = null;
    storageKey = null;
  }

  function bindIntent(draft) {
    const normalized = canonicalDraft(draft);
    const signature = luxifyIntentSignature(normalized);
    if (signature !== state.signature && state.uncertain) {
      throw clientError('intent_locked', 'Resolve the uncertain LUXIFY submission before changing its inputs.');
    }
    state.draft = normalized;
    if (signature !== state.signature) {
      state.signature = signature;
      state.idempotencyKey = null;
      state.quote = null;
      state.quoteSignature = null;
      state.recoveryChecked = false;
      state.existingJob = null;
      persist();
      return true;
    }
    persist();
    return false;
  }

  function ensureIntent(draft) {
    const value = validateDraft(draft);
    bindIntent(value);
    if (!state.idempotencyKey) {
      state.idempotencyKey = createId();
      persist();
    }
    return value;
  }

  async function loadCapabilities() {
    capabilities = normalizeCapabilities(await request(ENDPOINT));
    return capabilities;
  }

  function luxifyCapability() {
    return capabilities;
  }

  function requireAvailable() {
    if (!capabilities?.available) {
      throw clientError('luxify_unavailable', 'LUXIFY is not currently available.', { reasons: capabilities?.reasons || [] });
    }
  }

  async function prepareQuote(draft) {
    const value = ensureIntent(draft);
    requireAvailable();
    await request(ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        action: 'save-project',
        contractVersion: LUXIFY_CONTRACT_VERSION,
        projectId: state.projectId,
        ...value,
      }),
    });
    const response = await request(ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        action: 'quote',
        contractVersion: LUXIFY_CONTRACT_VERSION,
        projectId: state.projectId,
        idempotencyKey: state.idempotencyKey,
      }),
    });
    if (response.recovered === true && response.existingJob) {
      state.existingJob = response.existingJob;
      state.uncertain = false;
      state.recoveryChecked = true;
      persist();
      return { project: response.project, existingJob: response.existingJob, recovered: true, idempotencyKey: state.idempotencyKey };
    }
    const quote = response.quote;
    if (!quote || typeof quote.token !== 'string' || quote.token.length < 40
      || !Number.isSafeInteger(quote.credits) || quote.credits <= 0
      || quote.currency !== 'lux_credits' || !Number.isFinite(Date.parse(quote.expiresAt))) {
      throw clientError('invalid_quote_response', 'LUXIFY returned an invalid quote.');
    }
    state.quote = { ...quote };
    state.quoteSignature = state.signature;
    state.recoveryChecked = false;
    persist();
    return { quote: { ...quote }, project: response.project, idempotencyKey: state.idempotencyKey };
  }

  function quoteStatus(draft) {
    const signature = luxifyIntentSignature(draft);
    if (!state.quote || state.quoteSignature !== signature) return { valid: false, code: 'quote_missing' };
    const expiresAt = Date.parse(state.quote.expiresAt);
    if (!Number.isFinite(expiresAt) || now() >= expiresAt) return { valid: false, code: 'quote_expired' };
    return { valid: true, quote: { ...state.quote } };
  }

  async function recover() {
    if (!state.idempotencyKey) return null;
    const query = new URLSearchParams({
      contractVersion: LUXIFY_CONTRACT_VERSION,
      projectId: state.projectId,
      idempotencyKey: state.idempotencyKey,
    });
    const response = await request(ENDPOINT + '?' + query);
    state.recoveryChecked = true;
    state.existingJob = response.existingJob || null;
    if (state.existingJob) state.uncertain = false;
    persist();
    return state.existingJob;
  }

  async function submit(draft, { recoveryFirst = false } = {}) {
    const value = ensureIntent(draft);
    if (recoveryFirst || state.uncertain) {
      const existing = await recover();
      if (existing) return { job: existing, recovered: true };
    }
    requireAvailable();
    const status = quoteStatus(value);
    if (!status.valid) {
      throw clientError(status.code, status.code === 'quote_expired'
        ? 'This LUXIFY quote expired. Get a new quote before retrying.'
        : 'Review a current LUXIFY quote before submitting.');
    }
    try {
      const response = await request(RENDER_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({
          contractVersion: LUXIFY_CONTRACT_VERSION,
          projectId: state.projectId,
          idempotencyKey: state.idempotencyKey,
          title: value.title,
          prompt: value.prompt,
          lookIdentityIds: value.lookIdentityIds,
          aspectRatio: value.aspectRatio,
          resolution: value.resolution,
          durationSeconds: value.durationSeconds,
          quoteToken: state.quote.token,
        }),
        timeoutMs: 30_000,
      });
      state.uncertain = false;
      state.recoveryChecked = false;
      state.existingJob = response.job || null;
      persist();
      return { ...response, recovered: false };
    } catch (error) {
      if ([400, 409, 410].includes(error?.status) && /^LUXIFY_QUOTE_/.test(String(error?.code || ''))) {
        state.quote = null;
        state.quoteSignature = null;
        persist();
        throw clientError(error.code, error.message, { status: error.status, quoteRejected: true });
      }
      if (error?.retryable || !Number.isInteger(error?.status)
        || ['network_timeout', 'network_unavailable', 'invalid_response'].includes(error?.code)) {
        state.uncertain = true;
        state.recoveryChecked = false;
        persist();
        throw clientError('submission_uncertain', 'The connection ended before this LUXIFY render was confirmed. Check the existing request before retrying.', { cause: error });
      }
      throw error;
    }
  }

  function resetCompletedIntent() {
    const previous = state;
    state = newState(createId);
    persist();
    return previous;
  }

  return {
    bindIntent,
    clearScope,
    loadCapabilities,
    luxifyCapability,
    prepareQuote,
    publicState,
    quoteStatus,
    recover,
    resetCompletedIntent,
    setScope,
    submit,
  };
}
