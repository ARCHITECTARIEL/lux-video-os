const params = new URLSearchParams(location.search);
const invitationToken = params.get('invite');
const status = document.querySelector('#status');
const checkbox = document.querySelector('#affirmative-notice');
const button = document.querySelector('#continue');

if (params.has('returned')) {
  document.querySelector('#notice-panel').hidden = true;
  document.querySelector('#signin-help').hidden = true;
  document.querySelector('#intro').textContent = 'Your recording step has returned to Video OS.';
  status.textContent = 'HeyGen consent is being checked. Returning here does not mean it has been accepted; the inviting account will see the verified status.';
} else if (!invitationToken) {
  document.querySelector('#notice-panel').hidden = true;
  status.textContent = 'This invitation link is missing or incomplete. Ask the account owner for a new link.';
} else {
  checkbox.addEventListener('change', () => { button.disabled = !checkbox.checked; });
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Saving your decision…';
    try {
      const accepted = await post({ action: 'accept-notice', invitationToken, affirmativeNotice: true });
      if (!accepted.subjectConsent?.accepted) throw new Error('Consent could not be confirmed.');
      status.textContent = 'Preparing your private HeyGen recording link…';
      const idempotencyKey = await digest(invitationToken);
      const session = await post({ action: 'create-session', invitationToken, idempotencyKey });
      if (!session.launchUrl?.startsWith('/api/video-os-lite/provider-consent?action=launch&')) throw new Error('Recording link could not be verified.');
      const link = document.createElement('a');
      link.href = session.launchUrl;
      link.textContent = 'Open HeyGen consent recording';
      link.className = 'launch';
      link.rel = 'noreferrer';
      button.replaceWith(link);
      status.textContent = 'Your notice was saved. Open the one-time recording link to continue.';
    } catch (error) {
      status.textContent = error.message || 'Consent setup is unavailable. Sign in with the invited email or ask for a new link.';
      button.disabled = !checkbox.checked;
    }
  });
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function post(body) {
  const response = await fetch('/api/video-os-lite/provider-consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'This invitation could not be completed.');
  return data;
}
