// LUXIFY consent operator page. Same-origin JSON posts to the consent route.
// The operator is the vos_session cookie. Never send an operator id, and never
// write tokens, names, emails, evidence paths, or account ids to the console.
const endpoint = '/api/video-os-lite/luxify-consent';
const $ = id => document.getElementById(id);
const page = { subjectAccountId: null, lookup: null, context: null, unavailable: false };
let busy = false;

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;
const mask = value => { const s = String(value || ''); return s.length > 4 ? `…${s.slice(-4)}` : '…'; };

function setStatus(message) { $('status').textContent = message; }
function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }

class ConsentRequestError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ConsentRequestError';
    this.status = status;
    this.code = code;
  }
}

function publicError(value) {
  const message = typeof value === 'string' ? value.trim() : '';
  return message ? message.slice(0, 500) : 'Request failed.';
}

function errorText(error) {
  const message = error?.message || 'Request failed.';
  const code = error?.code;
  if (!code || code === 'sign_in_required' || code === 'network' || message.includes(code) || !SAFE_CODE.test(code)) return message;
  return `${message} (${code})`;
}

async function call(body) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ConsentRequestError('The consent service could not be reached.', 0, 'network');
  }
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) throw new ConsentRequestError('Sign in, then reload this page.', 401, payload.code || 'sign_in_required');
  if (!response.ok || !payload.ok) throw new ConsentRequestError(publicError(payload.error), response.status, typeof payload.code === 'string' ? payload.code : '');
  return payload;
}

function setUnavailable() {
  page.unavailable = true;
  page.context = null;
  page.subjectAccountId = null;
  page.lookup = null;
  $('operator').dataset.state = 'unavailable';
  $('obo-state').hidden = false;
  $('obo-state').textContent = 'On-behalf LUXIFY consent is not enabled.';
  $('lookup-panel').hidden = true;
  $('context-panel').hidden = true;
  $('subject-summary').textContent = '';
  $('context-summary').textContent = '';
  $('attestation-text').textContent = '';
  $('notice-body').replaceChildren();
  $('consents').replaceChildren();
  $('grant').disabled = true;
  setStatus('On-behalf LUXIFY consent is not enabled.');
}

async function guarded(work) {
  try {
    await work();
  } catch (error) {
    if (error?.code === 'luxify_consent_obo_unavailable') setUnavailable();
    else setStatus(errorText(error));
  }
}

function onSubmit(work) {
  return event => {
    event.preventDefault();
    return guarded(work);
  };
}

function selectedIdentity() {
  return page.context?.identities?.find(identity => identity.identityId === $('look').value) || null;
}

function attestedDate(value) {
  if (!value) return null;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at : null;
}

// The sentence the operator reads is the same template the server hashes.
// notice version and sha256 come from operator-context, not from this file.
function previewText() {
  const identity = selectedIdentity();
  const version = page.context?.notice?.version;
  const noticeSha = page.context?.noticeSha256;
  const name = $('subject-name').value.trim().replace(/\s+/g, ' ');
  const method = $('method').value;
  const at = attestedDate($('attested-at').value);
  if (!page.context || page.unavailable || !identity || !version || !/^[a-f0-9]{64}$/.test(String(noticeSha || ''))) return '';
  if (!name || name.length > 120 || /[\u0000-\u001f]/.test(name)) return '';
  if (method !== 'written' && method !== 'recorded_verbal') return '';
  if (!at) return '';
  const how = method === 'written' ? 'in a signed written statement' : 'in a recorded verbal statement';
  return `I attest that ${name}, the person shown in enrolled identity ${identity.identityId}, personally gave consent ${how} at ${at.toISOString()} `
    + `to the LUXIFY cinematic consent notice ${version} (sha256 ${noticeSha}), including both authorizations. `
    + 'I am recording that consent on their behalf; I am not consenting for them.';
}

function refreshGrant() {
  const preview = previewText();
  $('attestation-text').textContent = preview;
  const ready = Boolean(preview)
    && $('evidence-ref').value.trim()
    && $('ack-generation').checked
    && $('ack-processing').checked
    && $('attestation-confirmed').checked
    && !page.unavailable
    && !busy;
  $('grant').disabled = !ready;
}

function consentLabel(consent) {
  const expires = new Date(consent.expiresAt).toLocaleDateString();
  const attested = consent.attestedAt ? ` · attested ${new Date(consent.attestedAt).toLocaleDateString()}` : '';
  const ref = ` · ref ${mask(consent.id)}`;
  if (consent.status === 'pending_confirmation') return `waiting for the subject to confirm${attested} · expires ${expires}${ref}`;
  if (consent.consentMode === 'operator_on_behalf' && consent.status === 'active') return `confirmed by the subject${attested} · expires ${expires}${ref}`;
  const mode = consent.consentMode === 'operator_on_behalf' ? 'on behalf' : 'self';
  return `${consent.status} · ${mode}${attested} · expires ${expires}${ref}`;
}

function canWithdraw(consent) {
  return consent.consentMode === 'operator_on_behalf' && (consent.status === 'pending_confirmation' || consent.status === 'active');
}

function renderContext() {
  const context = page.context;
  const notice = context.notice || { title: '', paragraphs: [], acknowledgments: {} };
  const paragraphs = Array.isArray(notice.paragraphs) ? notice.paragraphs : [];
  $('notice-body').replaceChildren(...[notice.title, ...paragraphs].filter(Boolean).map(paragraph => text('p', paragraph)));
  $('ack-generation-text').textContent = notice.acknowledgments?.cinematicGenerationAuthorization || '';
  $('ack-processing-text').textContent = notice.acknowledgments?.providerProcessingAuthorization || '';
  $('attestation-version').textContent = context.attestationVersion ? `Attestation version ${context.attestationVersion}` : '';
  const select = $('look');
  const previous = select.value;
  const identities = context.identities;
  select.replaceChildren(...identities.map(identity => {
    const option = text('option', identity.displayName || 'Look');
    option.value = identity.identityId;
    return option;
  }));
  select.value = identities.some(identity => identity.identityId === previous) ? previous : (identities[0]?.identityId || '');
  const pending = context.consents.filter(consent => consent.status === 'pending_confirmation').length;
  const confirmed = context.consents.filter(consent => consent.consentMode === 'operator_on_behalf' && consent.status === 'active').length;
  $('context-summary').textContent = `${identities.length} ready look(s) · ${pending} waiting for the subject · ${confirmed} confirmed by the subject`;
  const ref = page.lookup?.accountRef || mask(page.subjectAccountId);
  const verified = page.lookup ? (page.lookup.emailVerified ? ' · email verified' : ' · email not verified') : '';
  $('subject-summary').textContent = `Account ${ref}${verified}`;
  const list = $('consents');
  if (!context.consents.length) {
    list.replaceChildren(text('li', 'No LUXIFY consents for this account yet.'));
  } else {
    list.replaceChildren(...context.consents.map(consent => {
      const item = text('li', consentLabel(consent));
      if (canWithdraw(consent)) {
        const control = text('button', 'Withdraw');
        control.type = 'button';
        control.addEventListener('click', () => guarded(async () => {
          if (!window.confirm('Withdraw this on-behalf LUXIFY consent? It will be closed.')) return;
          await call({ action: 'operator-withdraw', consentId: consent.id });
          await loadContext();
          setStatus('Consent withdrawn.');
        }));
        item.append(' ', control);
      }
      return item;
    }));
  }
  $('lookup-panel').hidden = false;
  $('context-panel').hidden = false;
  $('obo-state').hidden = true;
  $('operator').dataset.state = 'ready';
  refreshGrant();
}

async function loadContext() {
  if (page.unavailable) return;
  const accountId = page.subjectAccountId;
  if (!accountId) throw new ConsentRequestError('Enter the subject account.', 400, 'invalid_request');
  const context = await call({ action: 'operator-context', onBehalfOfAccountId: accountId });
  page.context = {
    ...context,
    identities: Array.isArray(context.identities) ? context.identities : [],
    consents: Array.isArray(context.consents) ? context.consents : [],
  };
  renderContext();
}

async function findSubject() {
  const email = $('subject-email').value.trim();
  if (!email) throw new ConsentRequestError('Enter the subject email.', 400, 'invalid_request');
  let target;
  try {
    target = await call({ action: 'staff-lookup', email });
  } catch (error) {
    if (error?.code === 'LUX_STAFF_PAGE_FORBIDDEN') {
      throw new ConsentRequestError(`${error.message} Enter the subject account id below to continue.`, error.status, error.code);
    }
    throw error;
  }
  if (!target?.accountId) throw new ConsentRequestError('That account could not be loaded.', 404, 'LUX_STAFF_ACCOUNT_NOT_FOUND');
  page.subjectAccountId = target.accountId;
  page.lookup = target;
  await loadContext();
  setStatus(target.emailVerified === false
    ? 'Subject loaded. That account has not verified its email yet, so an on-behalf consent cannot be recorded until they sign in once with an email link.'
    : 'Subject loaded.');
}

async function loadByAccount() {
  const accountId = $('subject-account').value.trim();
  if (!accountId) throw new ConsentRequestError('Enter the subject account id.', 400, 'invalid_request');
  page.subjectAccountId = accountId;
  page.lookup = null;
  await loadContext();
  setStatus('Subject loaded.');
}

function emailNote(result) {
  if (result.confirmationEmail === 'sent') {
    const when = result.confirmationExpiresAt ? ` The confirmation link expires ${new Date(result.confirmationExpiresAt).toLocaleString()}.` : '';
    return `Confirmation email sent. The consent stays pending until the subject confirms.${when}`;
  }
  if (result.confirmationEmail === 'failed') return 'Consent was recorded, but the confirmation email was not confirmed. It stays pending until the subject confirms.';
  if (result.replayed) return 'This consent was already recorded.';
  return 'Consent recorded. It stays pending until the subject confirms.';
}

async function grant() {
  if (busy || page.unavailable) return;
  const identity = selectedIdentity();
  const attested = attestedDate($('attested-at').value);
  const evidence = $('evidence-ref').value.trim();
  const subjectName = $('subject-name').value.trim();
  const method = $('method').value;
  if (!page.context || !page.subjectAccountId || !identity?.challenge || !attested || !evidence || !subjectName) return;
  if (method !== 'written' && method !== 'recorded_verbal') return;
  if (!$('ack-generation').checked || !$('ack-processing').checked || !$('attestation-confirmed').checked) return;
  busy = true;
  $('grant').disabled = true;
  try {
    const result = await call({
      action: 'grant-on-behalf',
      onBehalfOfAccountId: page.subjectAccountId,
      identityId: identity.identityId,
      idempotencyKey: crypto.randomUUID(),
      challenge: identity.challenge,
      noticeSha256: page.context.noticeSha256,
      cinematicGenerationAuthorization: true,
      providerProcessingAuthorization: true,
      subjectName,
      attestationMethod: method,
      attestedAt: attested.toISOString(),
      attestationEvidenceRef: evidence,
      attestationConfirmed: true,
    });
    $('subject-name').value = '';
    $('evidence-ref').value = '';
    $('attested-at').value = '';
    $('ack-generation').checked = false;
    $('ack-processing').checked = false;
    $('attestation-confirmed').checked = false;
    await loadContext();
    setStatus(emailNote(result));
  } finally {
    busy = false;
    refreshGrant();
  }
}

for (const id of ['subject-name', 'method', 'attested-at', 'evidence-ref', 'look']) {
  $(id).addEventListener('input', refreshGrant);
  $(id).addEventListener('change', refreshGrant);
}
for (const id of ['ack-generation', 'ack-processing', 'attestation-confirmed']) {
  $(id).addEventListener('change', refreshGrant);
}
$('email-form').addEventListener('submit', onSubmit(findSubject));
$('account-form').addEventListener('submit', onSubmit(loadByAccount));
$('grant-form').addEventListener('submit', onSubmit(grant));
$('context-panel').hidden = true;
$('obo-state').hidden = true;
$('grant').disabled = true;
