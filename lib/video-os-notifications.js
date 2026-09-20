// Best-effort "your video is ready" email, sent once per job from the shared
// finalizeReadyJob completion point (db/repositories.js). Reuses the same
// Resend HTTP call shape as sendMagicEmail (lib/video-os-account.js) so both
// email paths share one provider-configuration story.

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export async function sendRenderReadyEmail({ email, jobTitle, appUrl }) {
  const key = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.AUTH_FROM_EMAIL || '').trim();
  if (!key || !from) throw Object.assign(new Error('Render-ready email is not configured. Add RESEND_API_KEY and AUTH_FROM_EMAIL.'), { statusCode: 501 });
  const title = String(jobTitle || 'Your video').trim().slice(0, 200) || 'Your video';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `${title} is ready to watch`,
      html: `<p>"${escapeHtml(title)}" has finished rendering.</p><p><a href="${appUrl}">Sign in to Video OS Lite</a> to watch or download it.</p>`,
      text: `"${title}" has finished rendering.\n\nSign in to watch or download it: ${appUrl}`,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    let providerCode = 'resend_rejected';
    try { providerCode = JSON.parse(text)?.name || JSON.parse(text)?.code || providerCode; } catch {}
    throw Object.assign(new Error('The email provider rejected the render-ready message.'), {
      statusCode: 502,
      providerStatus: response.status,
      providerCode: String(providerCode).slice(0, 80),
    });
  }
  return text ? JSON.parse(text) : { ok: true };
}
