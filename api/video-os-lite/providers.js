import { accountPayload, handleOptions, loadAccount, providerList, send, sessionFromRequest } from '../../lib/video-os-account.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET for provider status.' });
  try {
    try {
      const session = sessionFromRequest(req);
      const account = await loadAccount(session.accountId);
      return send(res, 200, {
        ok: true,
        signedIn: true,
        email: session.email,
        ...accountPayload(account),
        providers: providerList(),
        assetLibraries: [],
      });
    } catch {
      return send(res, 200, {
        ok: true,
        signedIn: false,
        accountId: 'signed-out',
        account: { accountId: 'signed-out', name: 'Sign in to render', subscription: { plan: 'Video OS Lite', status: 'preview', renewal: 'Sign in to unlock live rendering' } },
        credits: { accountId: 'signed-out', balance: 0, currency: 'credits' },
        security: { status: 'locked', message: 'Sign in with email to use credits and live rendering.' },
        providers: providerList(),
        assetLibraries: [],
      });
    }
  } catch (error) {
    send(res, error.statusCode || 400, { ok: false, error: error.message || 'Could not load account.' });
  }
}