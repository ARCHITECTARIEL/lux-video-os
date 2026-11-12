const REASONS = ['expired', 'used', 'invalid', 'google'];

function showReason() {
  const params = new URLSearchParams(location.search);
  const requested = params.get('reason');
  const reason = REASONS.includes(requested) ? requested : 'invalid';
  const next = new URL(location.href);
  next.search = `?reason=${reason}`;
  if (`${location.pathname}${location.search}` !== `${next.pathname}${next.search}`) {
    history.replaceState(null, '', `${next.pathname}${next.search}`);
  }
  const heading = document.getElementById(`reason-${reason}`);
  if (heading) heading.hidden = false;
}

async function sendNewLink(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = document.getElementById('resend-email');
  const button = form.querySelector('button');
  const status = document.getElementById('resend-status');
  if (!form.reportValidity()) return;
  const email = input.value.trim();
  button.disabled = true;
  status.hidden = false;
  status.classList.remove('error');
  status.textContent = 'Sending a new sign-in link.';
  try {
    const response = await fetch('/api/video-os-lite/auth-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      status.classList.add('error');
      status.textContent = data.error || 'We could not send a new link. Try again in a moment.';
      return;
    }
    status.textContent = data.message || 'Check your email for a new sign-in link.';
  } catch {
    status.classList.add('error');
    status.textContent = 'We could not send a new link. Try again in a moment.';
  } finally {
    button.disabled = false;
  }
}

showReason();
document.getElementById('resend-form').addEventListener('submit', event => { void sendNewLink(event); });
