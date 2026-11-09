const endpoint = '/api/video-os-lite/luxify-consent';
const $ = id => document.getElementById(id);
let state = null;

// CON-24: the emailed on-behalf confirmation link is /luxify-consent#confirm=<token>.
// Read the token once, then remove it from the address bar and history before
// anything else runs. The token stays in this closure only: it is never logged,
// written to the page, or stored.
let confirmToken = readConfirmToken();

function readConfirmToken() {
  const hash = typeof location.hash === 'string' ? location.hash : '';
  if (!hash || hash === '#') return null;
  const value = new URLSearchParams(hash.slice(1)).get('confirm');
  if (value === null) return null;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

const CONFIRM_MESSAGES = Object.freeze({
  ready: 'Check the consent below, then confirm it.',
  working: 'Confirming…',
  success: 'Thank you. Your LUXIFY consent is confirmed and active. It expires in 12 months unless you withdraw it sooner.',
  expired: 'This confirmation link expired, so the consent recorded for you was closed. Nothing was activated. Ask Lux staff to record it again if you still want it.',
  used: 'This confirmation link was already used. Your consents below show the current status.',
  closed: 'This consent was already withdrawn, revoked or expired, so it can no longer be confirmed.',
  wrong_account: 'This link is not for the account you are signed in to. Sign in with the email address the link was sent to, then open the link from the email again.',
  signed_out: 'Sign in with the email address this link was sent to, then open the link from the email again.',
  flag_off: 'Confirming consent recorded by Lux staff is turned off right now. Nothing was changed. Try the link from the email again later.',
  malformed: 'This confirmation link is incomplete. Open it again from the email.',
  error: 'Your consent could not be confirmed right now. Nothing was changed. Try again, or open the link from the email again.',
});

function setStatus(message) { $('status').textContent = message; }

function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

class ConsentRequestError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(method, body) {
  const response = await fetch(endpoint, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) throw new ConsentRequestError('Sign in to your own account, then reload this page.', 401, payload.code || 'sign_in_required');
  if (!response.ok || !payload.ok) throw new ConsentRequestError(payload.error || 'Consent request failed.', response.status, payload.code);
  return payload;
}

function confirmStateFor(error) {
  if (error?.status === 401) return 'signed_out';
  switch (error?.code) {
    case 'LUXIFY_CONFIRMATION_EXPIRED': return 'expired';
    case 'LUXIFY_CONFIRMATION_USED': return 'used';
    case 'LUXIFY_CONFIRMATION_CLOSED': return 'closed';
    case 'LUXIFY_CONFIRMATION_INVALID':
    case 'LUXIFY_CONFIRMATION_EMAIL_MISMATCH': return 'wrong_account';
    case 'luxify_consent_obo_unavailable': return 'flag_off';
    default: return 'error';
  }
}

function setConfirmState(name) {
  const panel = $('confirm-panel');
  panel.hidden = false;
  panel.dataset.state = name;
  $('confirm-status').textContent = CONFIRM_MESSAGES[name];
  const retryable = name === 'ready' || name === 'error';
  // Only a retryable state keeps the token; every final state drops it.
  if (!retryable && name !== 'working') confirmToken = null;
  $('confirm').hidden = !retryable && name !== 'working';
  $('confirm').disabled = !retryable || !confirmToken || !state;
}

function statusLabel(consent) {
  const expires = new Date(consent.expiresAt).toLocaleDateString();
  if (consent.status === 'pending_confirmation') return `waiting for your confirmation · recorded by Lux staff · expires ${expires}`;
  const recorded = consent.consentMode === 'operator_on_behalf' ? ' · recorded by Lux staff' : '';
  return `${consent.status}${recorded} · expires ${expires}`;
}

function refreshButton() {
  $('grant').disabled = !($('ack-generation').checked && $('ack-processing').checked && $('identity').value);
}

function render() {
  $('notice-title').textContent = state.notice.title;
  const body = $('notice-body');
  body.replaceChildren(...state.notice.paragraphs.map(paragraph => text('p', paragraph)));
  $('ack-generation-text').textContent = state.notice.acknowledgments.cinematicGenerationAuthorization;
  $('ack-processing-text').textContent = state.notice.acknowledgments.providerProcessingAuthorization;
  $('identity').replaceChildren(...state.identities.map(identity => {
    const option = text('option', identity.displayName);
    option.value = identity.identityId;
    return option;
  }));
  const list = $('consents');
  list.replaceChildren(...state.consents.map(consent => {
    const item = text('li', statusLabel(consent));
    if (consent.status === 'active' || consent.status === 'pending_confirmation') {
      const pending = consent.status === 'pending_confirmation';
      const button = text('button', pending ? 'Decline' : 'Withdraw');
      button.type = 'button';
      button.addEventListener('click', async () => {
        const question = pending
          ? 'Decline the LUXIFY consent Lux staff recorded for you? It will be closed and never used.'
          : 'Withdraw this LUXIFY consent? New LUXIFY renders for this look stop immediately.';
        if (!window.confirm(question)) return;
        try {
          await call('POST', { action: 'withdraw', consentId: consent.id });
          setStatus(pending ? 'Consent declined.' : 'Consent withdrawn.');
          await load();
        } catch (error) { setStatus(error.message); }
      });
      item.append(' ', button);
    }
    return item;
  }));
  $('confirm-pending').replaceChildren(...state.consents
    .filter(consent => consent.status === 'pending_confirmation')
    .map(consent => text('li', `Recorded by Lux staff${consent.attestedAt ? ` on ${new Date(consent.attestedAt).toLocaleDateString()}` : ''} · expires ${new Date(consent.expiresAt).toLocaleDateString()}`)));
  if (!state.identities.length) setStatus('You have no ready look to consent for yet.');
  refreshButton();
}

async function load() {
  state = await call('GET');
  render();
  if (confirmToken && $('confirm-panel').dataset.state === 'loading') setConfirmState('ready');
}

async function confirmOnBehalf() {
  if (!confirmToken) return;
  setConfirmState('working');
  $('confirm').disabled = true;
  try {
    await call('POST', { action: 'confirm-on-behalf', token: confirmToken });
    setConfirmState('success');
  } catch (error) {
    setConfirmState(confirmStateFor(error));
  }
  try { await load(); } catch (error) { setStatus(error.message); }
}

$('ack-generation').addEventListener('change', refreshButton);
$('ack-processing').addEventListener('change', refreshButton);
$('identity').addEventListener('change', refreshButton);
$('confirm').addEventListener('click', confirmOnBehalf);
$('grant').addEventListener('click', async () => {
  const identity = state.identities.find(item => item.identityId === $('identity').value);
  if (!identity) return;
  $('grant').disabled = true;
  try {
    await call('POST', {
      action: 'grant',
      identityId: identity.identityId,
      idempotencyKey: crypto.randomUUID(),
      challenge: identity.challenge,
      noticeSha256: state.noticeSha256,
      cinematicGenerationAuthorization: $('ack-generation').checked,
      providerProcessingAuthorization: $('ack-processing').checked,
    });
    setStatus('Consent recorded. It expires in 12 months unless you withdraw it sooner.');
    $('ack-generation').checked = false;
    $('ack-processing').checked = false;
    await load();
  } catch (error) {
    setStatus(error.message);
    refreshButton();
  }
});

if (confirmToken === '') setConfirmState('malformed');
else if (confirmToken) {
  $('confirm-panel').hidden = false;
  $('confirm-panel').dataset.state = 'loading';
  $('confirm-status').textContent = 'Loading…';
}

load().catch(error => {
  setStatus(error.message);
  if (confirmToken) setConfirmState(error?.status === 401 ? 'signed_out' : 'error');
});
