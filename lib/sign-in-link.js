const SIGN_IN_REASONS = new Set(['expired', 'used', 'invalid', 'google', 'unavailable']);

export function mediaRangeQuality(header, type) {
  const wanted = String(type || '').toLowerCase();
  let best = 0;
  for (const part of String(header || '').split(',')) {
    const [range, ...params] = part.split(';').map(item => item.trim().toLowerCase());
    if (range !== wanted) continue;
    const qParam = params.find(item => item.startsWith('q='));
    const quality = qParam ? Number(qParam.slice(2)) : 1;
    if (Number.isFinite(quality)) best = Math.max(best, quality);
  }
  return best;
}

export function prefersHtmlResponse(accept) {
  const header = String(accept || '');
  const html = mediaRangeQuality(header, 'text/html');
  const json = mediaRangeQuality(header, 'application/json');
  return html > 0 && html >= json;
}

export function signInFailureReason(error, action) {
  const message = String(error?.message || '');
  const status = Number(error?.statusCode || 0);
  if (status >= 500 || /storage|unavailable|temporarily|could not be consumed/i.test(message)) return 'unavailable';
  if (action === 'google-callback') return 'google';
  if (/expired/i.test(message)) return 'expired';
  if (/already used/i.test(message)) return 'used';
  return 'invalid';
}

export function signInLinkRedirect(reason) {
  const safe = SIGN_IN_REASONS.has(reason) ? reason : 'invalid';
  return `/sign-in-link?reason=${safe}`;
}
