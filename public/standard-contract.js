// Transport is injected: this module has no provider, storage or fetch capability.
export const STANDARD_CONTRACT_VERSION = 'standard-narration-v1';
export const STANDARD_NARRATION_POLICY_VERSION = 'standard-narration-consent-v1-proposed';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSENT_REQUIRED = 'standard_narration_consent_required';

function contractError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function requireUuid(value, label) {
  if (!UUID_PATTERN.test(String(value || ''))) throw contractError(`${label} response is incomplete.`, 'invalid_response');
  return value;
}

function exactBinding(value, binding, label) {
  if (!value || value.projectId !== binding.projectId || value.identityId !== binding.identityId || value.audioAssetId !== binding.audioAssetId) {
    throw contractError(`${label} response does not match the reviewed inputs.`, 'binding_mismatch');
  }
}

function readinessUrl(binding, narrationConsentId) {
  const query = new URLSearchParams({ operation: 'readiness', ...binding });
  if (narrationConsentId) query.set('narrationConsentId', narrationConsentId);
  return `/api/video-os-lite/standard?${query}`;
}

// A readiness check (or any other well-formed 200/4xx/409 response whose
// content just isn't what this stage expected) is a DEFINITIVE answer --
// nothing is ambiguous about it, and it must never be shown as "the
// connection was lost." Real uncertainty is narrowly the set of signals
// getJson() (public/studio.js) produces when no real response ever came
// back at all (an aborted/timed-out fetch, or the network failing outright)
// or when the server's own reply couldn't even be parsed -- mirrors
// submitPremium()'s catch in public/studio.js, the existing correct
// pattern for this. A thrown contractError() from this file's own
// higher-level checks (readiness mismatch, binding mismatch, an invalid
// consent/quote) never sets `retryable` and never carries one of these
// codes, so it now correctly falls through as a normal, specific error
// instead of being swallowed into the early-stage-uncertain recovery flow.
function isUncertain(error) {
  return error?.retryable === true || ['network_timeout', 'network_unavailable', 'invalid_response'].includes(error?.code);
}

export function createStandardController({ request, uuid = () => crypto.randomUUID(), onStage = () => {} }) {
  let pending = null;
  let lastJob = null;
  let busy = false;
  let quoteContext = null;
  let earlyStageUncertain = null;
  const stage = (name, details = {}) => onStage(name, details);

  async function requestQuote({ binding, narrationConsentId, format }) {
    stage('QUOTING');
    const quoteResponse = await request('/api/video-os-lite/standard', {
      method: 'POST',
      body: { operation: 'quote', contractVersion: STANDARD_CONTRACT_VERSION, ...binding, narrationConsentId, format },
    });
    const quote = quoteResponse?.quote;
    const quoteId = requireUuid(quote?.id, 'Quote');
    exactBinding(quote, binding, 'Quote');
    if (quote.contractVersion !== STANDARD_CONTRACT_VERSION || quote.narrationConsentId !== narrationConsentId
      || quote.format !== format || !Number.isFinite(Number(quote.credits)) || Number(quote.credits) < 0) {
      throw contractError('Quote response does not match the reviewed request.', 'invalid_quote');
    }
    if (!quote.expiresAt || Number.isNaN(new Date(quote.expiresAt).getTime())) {
      throw contractError('Quote response is missing a valid expiry.', 'invalid_quote');
    }
    return { quote, quoteId };
  }

  async function sendPending() {
    if (!pending) throw contractError('No pending submission to recover.', 'no_pending_submission');
    stage('SUBMITTING', { recovery: pending.attempted === true });
    pending.attempted = true;
    let response;
    try {
      response = await request('/api/video-os-lite/render', { method: 'POST', body: pending.body });
    } catch (error) {
      if (Number(error?.status) >= 400) {
        pending = null;
        throw error;
      }
      throw contractError('Submission outcome is uncertain. Recover with the same request.', 'submission_uncertain', {
        cause: error,
        status: error?.status,
        retryable: true,
      });
    }
    if (!response?.job?.id) {
      throw contractError('Submission outcome is uncertain. Recover with the same request.', 'submission_uncertain', { retryable: true });
    }
    lastJob = response.job;
    pending = null;
    stage('QUEUED', { job: lastJob });
    return lastJob;
  }

  async function submitFixture({ title, identityId, audioAssetId }) {
    const { project } = await request('/api/video-os-lite/projects', {
      method: 'POST', body: { tier: 'STANDARD', title, identityId },
    });
    requireUuid(project?.id, 'Project');
    pending = {
      attempted: false,
      body: {
        tier: 'STANDARD', title, identityId, projectId: project.id,
        audioReference: { assetId: audioAssetId },
        consentReference: { identityId }, idempotencyKey: uuid(),
      },
    };
    return sendPending();
  }

  return {
    get pending() { return pending?.body || null; },
    get lastJob() { return lastJob; },

    async submit({ title, identityId, audio, audioAssetId, permission, format = 'vertical' }) {
      if (busy) throw contractError('A submission is already being checked.', 'submission_busy');
      if (!permission) throw contractError('Confirm authorization before submission.', 'consent_required');
      if (pending) throw contractError('Recover the pending submission before starting another.', 'recovery_required');
      if (earlyStageUncertain) throw contractError('Resolve the previous uncertain submission before starting another.', 'early_stage_uncertain_pending');
      if (!String(title || '').trim()) throw contractError('Enter a video title.', 'invalid_title');
      requireUuid(identityId, 'Identity');
      if (!['vertical', 'landscape', 'square'].includes(format)) throw contractError('Choose a supported video format.', 'invalid_format');

      busy = true;
      try {
        // Preserve the old synthetic fixture transport as a local-only test harness.
        if (!audio && audioAssetId) return await submitFixture({ title: title.trim(), identityId, audioAssetId });
        if (!audio?.name || !String(audio.dataUrl || '').startsWith('data:audio/')) {
          throw contractError('Choose a valid WAV recording.', 'invalid_audio');
        }
        const trimmedTitle = title.trim();

        // Snapshot before any write, so an uncertain outcome below can be checked
        // against what existed beforehand without guessing at server state.
        const before = await request('/api/video-os-lite/projects');
        const beforeProjectIds = new Set((before?.projects || []).map((item) => item.id));

        let stageName = 'upload';
        try {
          stage('UPLOADING');
          const uploaded = await request('/api/video-os-lite/uploads', {
            method: 'POST',
            headers: { 'x-request-id': uuid() },
            body: { kind: 'identity_voice', name: audio.name, dataUrl: audio.dataUrl },
            timeoutMs: 60000,
          });
          const uploadedAudioId = requireUuid(uploaded?.assetId, 'Audio upload');

          stageName = 'project';
          stage('DRAFT');
          const { project } = await request('/api/video-os-lite/projects', {
            method: 'POST',
            body: {
              tier: 'STANDARD',
              contractVersion: STANDARD_CONTRACT_VERSION,
              title: trimmedTitle,
              identityId,
              narrationAudioAssetId: uploadedAudioId,
            },
          });
          const projectId = requireUuid(project?.id, 'Project');
          const binding = { projectId, identityId, audioAssetId: uploadedAudioId };

          stage('VALIDATING');
          const beforeConsent = await request(readinessUrl(binding));
          if (beforeConsent?.readiness?.ready !== false || beforeConsent.readiness.reasonCode !== CONSENT_REQUIRED) {
            throw contractError('Standard readiness did not request a valid narration consent.', beforeConsent?.readiness?.reasonCode || 'unknown_readiness', {
              readiness: beforeConsent?.readiness,
            });
          }

          stageName = 'consent';
          stage('CONSENTING');
          const consentResponse = await request('/api/video-os-lite/standard', {
            method: 'POST',
            body: {
              operation: 'consent',
              contractVersion: STANDARD_CONTRACT_VERSION,
              ...binding,
              idempotencyKey: uuid(),
              policyVersion: STANDARD_NARRATION_POLICY_VERSION,
              consent: true,
            },
          });
          const consent = consentResponse?.consent;
          const narrationConsentId = requireUuid(consent?.id, 'Consent');
          exactBinding(consent, binding, 'Consent');
          if (consent.policyVersion !== STANDARD_NARRATION_POLICY_VERSION || consent.revokedAt) {
            throw contractError('Narration consent is invalid or no longer active.', 'invalid_consent');
          }

          const afterConsent = await request(readinessUrl(binding, narrationConsentId));
          if (afterConsent?.readiness?.ready !== true) {
            throw contractError('Standard is not ready for these reviewed inputs.', afterConsent?.readiness?.reasonCode || 'unknown_readiness', {
              readiness: afterConsent?.readiness,
            });
          }

          const { quote, quoteId } = await requestQuote({ binding, narrationConsentId, format });
          quoteContext = { binding, narrationConsentId, projectId, uploadedAudioId, title: trimmedTitle, format, quote, quoteId };
          stage('QUOTE_READY', { quote });
          return { awaitingConfirmation: true, quote };
        } catch (error) {
          if (isUncertain(error)) {
            earlyStageUncertain = { stage: stageName, title: trimmedTitle, identityId, beforeProjectIds };
            throw contractError('Submission outcome is unknown before a render request existed. Check before trying again.', 'early_stage_uncertain', { cause: error, stage: stageName });
          }
          throw error;
        }
      } finally {
        busy = false;
      }
    },

    get quote() { return quoteContext?.quote || null; },

    cancelQuote() {
      quoteContext = null;
    },

    get earlyStageUncertain() { return earlyStageUncertain ? { stage: earlyStageUncertain.stage, title: earlyStageUncertain.title } : null; },

    async checkExistingProject() {
      if (!earlyStageUncertain) throw contractError('No uncertain submission to check.', 'no_early_stage_uncertain');
      const { title, identityId, beforeProjectIds } = earlyStageUncertain;
      const response = await request('/api/video-os-lite/projects');
      const projects = response?.projects || [];
      return projects.find((item) => !beforeProjectIds.has(item.id) && item.identityId === identityId && item.title === title) || null;
    },

    dismissEarlyStageUncertain() {
      earlyStageUncertain = null;
    },

    async requote() {
      if (busy) throw contractError('A submission is already being checked.', 'submission_busy');
      if (!quoteContext) throw contractError('No quote is ready to refresh.', 'no_quote_ready');
      busy = true;
      try {
        const { binding, narrationConsentId, format } = quoteContext;
        const { quote, quoteId } = await requestQuote({ binding, narrationConsentId, format });
        quoteContext = { ...quoteContext, quote, quoteId };
        stage('QUOTE_READY', { quote });
        return quote;
      } finally {
        busy = false;
      }
    },

    async confirmQuote() {
      if (busy) throw contractError('A submission is already being checked.', 'submission_busy');
      if (!quoteContext) throw contractError('No quote is ready to confirm.', 'no_quote_ready');
      const { quote, quoteId, binding, narrationConsentId, projectId, uploadedAudioId, title, format } = quoteContext;
      if (Date.now() >= new Date(quote.expiresAt).getTime()) {
        throw contractError('This quote has expired. Request a new quote before submitting.', 'quote_expired');
      }
      busy = true;
      try {
        pending = {
          attempted: false,
          body: {
            tier: 'STANDARD',
            contractVersion: STANDARD_CONTRACT_VERSION,
            projectId,
            identityId: binding.identityId,
            audioReference: { assetId: uploadedAudioId },
            narrationConsentId,
            quoteId,
            idempotencyKey: uuid(),
            title,
            format,
          },
        };
        quoteContext = null;
        stage('QUOTED', { quote });
        return await sendPending();
      } finally {
        busy = false;
      }
    },

    async recoverSubmission() {
      if (busy) throw contractError('A submission is already being checked.', 'submission_busy');
      busy = true;
      try { return await sendPending(); }
      finally { busy = false; }
    },

    async results() {
      const response = await request('/api/video-os-lite/results');
      if (!Array.isArray(response?.results)) throw contractError('Library response is incomplete.', 'invalid_response');
      return response.results;
    },
  };
}
