import crypto from 'node:crypto';
import Stripe from 'stripe';
import { issueStripeCredit } from '../../db/repositories.js';
import { handleOptions, readRaw, send } from '../../lib/video-os-account.js';
import { featureEnabled } from '../../lib/video-os-security.js';
import { captureRouteError } from '../../lib/video-os-observability.js';
import { parseOrThrow, stripeCheckoutSessionSchema } from '../../lib/video-os-validation.js';

// Exported so lib/video-os-stripe-reconciliation.js checks the same
// package->credits mapping this handler actually grants against, instead of
// a second, driftable copy.
export const PACKAGE_CREDITS = { credits_500: 500, credits_1000: 1000, credits_2000: 2000 };

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST for Stripe webhooks.' });
  try {
    const raw = await readRaw(req);
    const stripeSecret = String(process.env.STRIPE_SECRET_KEY || '').trim();
    const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!stripeSecret || !webhookSecret) throw Object.assign(new Error('Stripe webhook configuration is incomplete.'), { statusCode: 503 });
    const stripe = new Stripe(stripeSecret);
    const event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], webhookSecret);
    if (!featureEnabled('VIDEO_OS_BILLING_ENABLED')) return send(res, 200, { ok: true, received: true, credited: false, code: 'billing_disabled', type: event.type });
    if (event.type !== 'checkout.session.completed') return send(res, 200, { ok: true, received: true, credited: false, type: event.type });
    if (!['true', 'false'].includes(String(process.env.STRIPE_EXPECT_LIVEMODE || '').trim().toLowerCase())) throw Object.assign(new Error('STRIPE_EXPECT_LIVEMODE must be explicitly configured.'), { statusCode: 503 });
    const expectedLive = featureEnabled('STRIPE_EXPECT_LIVEMODE');
    if (Boolean(event.livemode) !== expectedLive) throw Object.assign(new Error('Stripe event mode mismatch.'), { statusCode: 409 });
    const session = parseOrThrow(stripeCheckoutSessionSchema, event.data.object, 'Stripe checkout session was invalid.');
    if (session.client_reference_id !== session.metadata.accountId) throw Object.assign(new Error('Stripe account binding mismatch.'), { statusCode: 409 });
    const credits = PACKAGE_CREDITS[session.metadata.packageId];
    const expectedPrice = String(process.env[`STRIPE_PRICE_ID_${credits}`] || '').trim();
    const verified = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items.data.price'] });
    const item = verified.line_items?.data?.[0];
    if (!expectedPrice || verified.payment_status !== 'paid' || verified.client_reference_id !== session.metadata.accountId || item?.price?.id !== expectedPrice || item?.quantity !== 1) throw Object.assign(new Error('Stripe economic package verification failed.'), { statusCode: 409 });
    const result = await issueStripeCredit({ stripeEventId: event.id, eventType: event.type, livemode: event.livemode, payloadSha256: crypto.createHash('sha256').update(raw).digest('hex'), accountId: session.metadata.accountId, sessionId: session.id, credits });
    return send(res, 200, { ok: true, received: true, credited: result.applied, duplicate: result.duplicate, type: event.type });
  } catch (error) {
    captureRouteError(error, { route: 'stripe-webhook', failureCategory: error?.failureCategory || 'BILLING' });
    return send(res, error.statusCode || 400, { ok: false, error: error.message || 'Webhook failed.' });
  }
}
