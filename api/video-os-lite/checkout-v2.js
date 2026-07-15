import Stripe from 'stripe';
import { ensureAccount } from '../../db/repositories.js';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { featureEnabled, publicOrigin } from '../../lib/video-os-security.js';

const PACKAGES = { 1: { packageId: 'credits_500', credits: 500 }, 2: { packageId: 'credits_1000', credits: 1000 }, 4: { packageId: 'credits_2000', credits: 2000 } };
const priceFor = (pack) => String(process.env[`STRIPE_PRICE_ID_${pack.credits}`] || '').trim();

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST to start checkout.' });
  try {
    const session = sessionFromRequest(req);
    if (!featureEnabled('VIDEO_OS_BILLING_ENABLED')) return send(res, 503, { ok: false, code: 'billing_disabled', error: 'Checkout is temporarily unavailable.' });
    const body = await readJson(req, 20_000);
    const pack = PACKAGES[[1, 2, 4].includes(Number(body.quantity)) ? Number(body.quantity) : 1];
    const price = priceFor(pack);
    const secret = String(process.env.STRIPE_SECRET_KEY || '').trim();
    if (!secret || !price) throw Object.assign(new Error('Stripe package configuration is incomplete.'), { statusCode: 503 });
    await ensureAccount({ accountId: session.accountId, email: session.email, name: session.email || 'Video OS Account', initialCredits: Number(process.env.VIDEO_OS_TRIAL_CREDITS || 180) });
    const origin = publicOrigin(req);
    const checkout = await new Stripe(secret).checkout.sessions.create({ mode: 'payment', client_reference_id: session.accountId, success_url: `${origin}/?checkout=success`, cancel_url: `${origin}/?checkout=cancelled`, line_items: [{ price, quantity: 1 }], metadata: { accountId: session.accountId, packageId: pack.packageId, policyVersion: '2026-07-p0' }, allow_promotion_codes: true });
    return send(res, 200, { ok: true, url: checkout.url, sessionId: checkout.id });
  } catch (error) { return send(res, error.statusCode || 400, { ok: false, error: error.message || 'Checkout failed.' }); }
}
