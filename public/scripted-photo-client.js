export const SCRIPTED_PHOTO_CONTRACT_VERSION = 'scripted-photo-v1';
export const SCRIPTED_PHOTO_TIERS = Object.freeze(['STANDARD', 'PREMIUM']);

function clientError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function requireTier(tier) {
  if (!SCRIPTED_PHOTO_TIERS.includes(tier)) throw clientError('invalid_tier', 'Choose Standard or Premium.');
  return tier;
}

function canonicalDraft(tier, draft = {}) {
  return {
    tier: requireTier(tier),
    title: String(draft.title || '').trim(),
    script: String(draft.script || '').trim(),
    identityId: String(draft.identityId || '').trim(),
    format: String(draft.format || '').trim(),
  };
}

export function scriptedPhotoIntentSignature(tier, draft) {
  const value = canonicalDraft(tier, draft);
  return JSON.stringify([value.tier, value.title, value.script, value.identityId, value.format]);
}

function validateDraft(tier, draft) {
  const value = canonicalDraft(tier, draft);
  if (!value.title || value.title.length > 120) throw clientError('invalid_title', 'Enter a title up to 120 characters.');
  if (!value.script || value.script.length > 900) throw clientError('invalid_script', 'Enter a script up to 900 characters.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.identityId)) {
    throw clientError('invalid_identity', 'Choose a ready private identity.');
  }
  if (!['vertical', 'landscape', 'square'].includes(value.format)) throw clientError('invalid_format', 'Choose a supported format.');
  return value;
}

function newTierState(createId, seed = {}) {
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

export function createScriptedPhotoClient({ request, createId = () => crypto.randomUUID(), now = () => Date.now(), storage = null } = {}) {
  if (typeof request !== 'function') throw new TypeError('A request function is required.');
  const tiers = Object.fromEntries(SCRIPTED_PHOTO_TIERS.map(tier => [tier, newTierState(createId)]));
  let capabilities = null;
  let storageKey = null;

  function persist() {
    if (!storage || !storageKey) return;
    try {
      const payload = { version: 1, tiers: Object.fromEntries(SCRIPTED_PHOTO_TIERS.map(tier => {
        const state = tiers[tier];
        return [tier, { projectId: state.projectId, idempotencyKey: state.idempotencyKey, signature: state.signature, uncertain: state.uncertain, recoveryChecked: state.recoveryChecked, draft: state.draft }];
      })) };
      storage.setItem(storageKey, JSON.stringify(payload));
    } catch {}
  }

  function setScope(accountId) {
    capabilities = null;
    const normalized = String(accountId || '').trim();
    storageKey = normalized ? `video-os-scripted-photo-v1:${encodeURIComponent(normalized)}` : null;
    let saved = null;
    if (storage && storageKey) {
      try { saved = JSON.parse(storage.getItem(storageKey) || 'null'); } catch {}
    }
    for (const tier of SCRIPTED_PHOTO_TIERS) {
      const candidate = saved?.version === 1 ? saved.tiers?.[tier] : null;
      const validProject = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate?.projectId || '');
      const validKey = candidate?.idempotencyKey === null || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate?.idempotencyKey || '');
      const draft = candidate?.draft && typeof candidate.draft === 'object' ? canonicalDraft(tier, candidate.draft) : null;
      const validSignature = !candidate?.idempotencyKey || (draft && candidate.signature === scriptedPhotoIntentSignature(tier, draft));
      tiers[tier] = newTierState(createId, validProject && validKey && validSignature ? { ...candidate, draft } : {});
    }
    persist();
    return Object.fromEntries(SCRIPTED_PHOTO_TIERS.map(tier => [tier, publicState(tier)]));
  }

  function clearScope() {
    if (storage && storageKey) { try { storage.removeItem(storageKey); } catch {} }
    for (const tier of SCRIPTED_PHOTO_TIERS) tiers[tier] = newTierState(createId);
    capabilities = null;
    storageKey = null;
  }

  function stateFor(tier) {
    return tiers[requireTier(tier)];
  }

  function publicState(tier) {
    const state = stateFor(tier);
    return {
      projectId: state.projectId,
      idempotencyKey: state.idempotencyKey,
      signature: state.signature,
      quote: state.quote ? { credits: state.quote.credits, expiresAt: state.quote.expiresAt, pricingVersion: state.quote.pricingVersion } : null,
      uncertain: state.uncertain,
      recoveryChecked: state.recoveryChecked,
      existingJob: state.existingJob,
      draft: state.draft ? { ...state.draft } : null,
    };
  }

  function bindIntent(tier, draft) {
    const state = stateFor(tier);
    const normalized = canonicalDraft(tier, draft);
    const signature = scriptedPhotoIntentSignature(tier, normalized);
    state.draft = normalized;
    if (signature !== state.signature) {
      state.signature = signature;
      state.idempotencyKey = null;
      state.quote = null;
      state.quoteSignature = null;
      state.uncertain = false;
      state.recoveryChecked = false;
      state.existingJob = null;
      persist();
      return true;
    }
    persist();
    return false;
  }

  function ensureIntent(tier, draft) {
    const value = validateDraft(tier, draft);
    bindIntent(tier, value);
    const state = stateFor(tier);
    if (!state.idempotencyKey) { state.idempotencyKey = createId(); persist(); }
    return { state, value };
  }

  async function loadCapabilities() {
    const response = await request('/api/video-os-lite/scripted-photo');
    capabilities = response;
    return response;
  }

  function tierCapability(tier) {
    return capabilities?.capabilities?.tiers?.[requireTier(tier)] || null;
  }

  async function prepareQuote(tier, draft) {
    const { state, value } = ensureIntent(tier, draft);
    const capability = tierCapability(tier);
    if (!capability?.available) throw clientError('tier_unavailable', 'This render tier is not currently available.', { reasons: capability?.reasons || [] });
    await request('/api/video-os-lite/scripted-photo', {
      method: 'POST',
      body: JSON.stringify({
        action: 'save-project',
        contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION,
        projectId: state.projectId,
        ...value,
      }),
    });
    const response = await request('/api/video-os-lite/scripted-photo', {
      method: 'POST',
      body: JSON.stringify({ action: 'quote', projectId: state.projectId, tier: value.tier, format: value.format, idempotencyKey: state.idempotencyKey }),
    });
    if (response.recovered === true && response.existingJob) {
      state.existingJob = response.existingJob;
      state.uncertain = false;
      state.recoveryChecked = true;
      persist();
      return { project: response.project, existingJob: response.existingJob, recovered: true, idempotencyKey: state.idempotencyKey };
    }
    state.quote = response.quote;
    state.quoteSignature = state.signature;
    state.recoveryChecked = false;
    persist();
    return { quote: response.quote, project: response.project, idempotencyKey: state.idempotencyKey };
  }

  function quoteStatus(tier, draft) {
    const state = stateFor(tier);
    const signature = scriptedPhotoIntentSignature(tier, draft);
    if (!state.quote || state.quoteSignature !== signature) return { valid: false, code: 'quote_missing' };
    const expiresAt = Date.parse(state.quote.expiresAt);
    if (!Number.isFinite(expiresAt) || now() >= expiresAt) return { valid: false, code: 'quote_expired' };
    return { valid: true, quote: { ...state.quote } };
  }

  async function recover(tier) {
    const state = stateFor(tier);
    if (!state.idempotencyKey) return null;
    const query = new URLSearchParams({
      contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION,
      projectId: state.projectId,
      tier: requireTier(tier),
      idempotencyKey: state.idempotencyKey,
    });
    const response = await request(`/api/video-os-lite/scripted-photo?${query}`);
    state.recoveryChecked = true;
    state.existingJob = response.existingJob || null;
    if (state.existingJob) state.uncertain = false;
    persist();
    return state.existingJob;
  }

  async function submit(tier, draft, { recoveryFirst = false } = {}) {
    const { state, value } = ensureIntent(tier, draft);
    if (recoveryFirst || state.uncertain) {
      const existing = await recover(tier);
      if (existing) return { job: existing, recovered: true };
    }
    const quote = quoteStatus(tier, value);
    if (!quote.valid) throw clientError(quote.code, quote.code === 'quote_expired' ? 'This quote expired. Get a new quote before retrying.' : 'Review a current quote before submitting.');
    try {
      const response = await request('/api/video-os-lite/render-v2', {
        method: 'POST',
        body: JSON.stringify({
          contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION,
          ...value,
          projectId: state.projectId,
          idempotencyKey: state.idempotencyKey,
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
      if ([400, 409, 410].includes(error?.status) && /^SCRIPTED_PHOTO_QUOTE_/.test(String(error?.code || ''))) {
        state.quote = null;
        state.quoteSignature = null;
        persist();
        throw clientError(error.code, error.message, { status: error.status, quoteRejected: true });
      }
      if (error?.retryable || !Number.isInteger(error?.status) || ['network_timeout', 'network_unavailable', 'invalid_response'].includes(error?.code)) {
        state.uncertain = true;
        state.recoveryChecked = false;
        persist();
        throw clientError('submission_uncertain', 'The connection ended before this render was confirmed. Check the existing request before retrying.', { cause: error });
      }
      throw error;
    }
  }

  function resetCompletedIntent(tier) {
    const state = stateFor(tier);
    tiers[tier] = newTierState(createId);
    persist();
    return state;
  }

  return { bindIntent, clearScope, loadCapabilities, prepareQuote, publicState, quoteStatus, recover, resetCompletedIntent, setScope, submit, tierCapability };
}
