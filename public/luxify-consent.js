const endpoint = '/api/video-os-lite/luxify-consent';
const $ = id => document.getElementById(id);
let state = null;

function setStatus(message) { $('status').textContent = message; }

function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

async function call(method, body) {
  const response = await fetch(endpoint, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error('Sign in to your own account, then reload this page.');
  if (!response.ok || !payload.ok) throw new Error(payload.error || 'Consent request failed.');
  return payload;
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
    const item = text('li', `${consent.status} · expires ${new Date(consent.expiresAt).toLocaleDateString()}`);
    if (consent.status === 'active') {
      const button = text('button', 'Withdraw');
      button.type = 'button';
      button.addEventListener('click', async () => {
        if (!window.confirm('Withdraw this LUXIFY consent? New LUXIFY renders for this look stop immediately.')) return;
        try {
          await call('POST', { action: 'withdraw', consentId: consent.id });
          setStatus('Consent withdrawn.');
          await load();
        } catch (error) { setStatus(error.message); }
      });
      item.append(' ', button);
    }
    return item;
  }));
  if (!state.identities.length) setStatus('You have no ready look to consent for yet.');
  refreshButton();
}

async function load() {
  state = await call('GET');
  render();
}

$('ack-generation').addEventListener('change', refreshButton);
$('ack-processing').addEventListener('change', refreshButton);
$('identity').addEventListener('change', refreshButton);
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

load().catch(error => setStatus(error.message));
