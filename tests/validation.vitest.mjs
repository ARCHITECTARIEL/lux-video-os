import { describe, expect, it } from 'vitest';
import { applyStripeEvent } from '../lib/video-os-credits.js';
import { parseOrThrow, renderRequestSchema, stripeCheckoutSessionSchema } from '../lib/video-os-validation.js';

describe('render validation', () => {
  it('requires a UUID idempotency key and rejects unknown fields', () => {
    expect(() => parseOrThrow(renderRequestSchema, { title: 'x' })).toThrow();
    expect(() => parseOrThrow(renderRequestSchema, { idempotencyKey: crypto.randomUUID(), provider: 'heygen', title: 'Proof', format: 'vertical', script: 'Hello', avatar: { avatarId: 'a' }, voice: { voiceId: 'v' }, productionKit: {}, sourceUrl: 'https://evil.test' })).toThrow();
  });
});

describe('Stripe validation', () => {
  it('accepts only server-known packages and policy version', () => {
    const base = { id: 'cs_test', payment_status: 'paid', metadata: { accountId: 'acct', packageId: 'credits_500', policyVersion: '2026-07-p0' } };
    expect(parseOrThrow(stripeCheckoutSessionSchema, base).metadata.packageId).toBe('credits_500');
    expect(() => parseOrThrow(stripeCheckoutSessionSchema, { ...base, metadata: { ...base.metadata, packageId: 'credits_999999' } })).toThrow();
  });

  it('keeps duplicate application side-effect free', () => {
    const initial = { balance: 0, purchased: 0, appliedStripeEvents: {} };
    expect(applyStripeEvent(initial, { eventId: 'evt_1', sessionId: 'cs_1', credits: 500 }).applied).toBe(true);
    expect(applyStripeEvent(initial, { eventId: 'evt_1', sessionId: 'cs_1', credits: 500 }).applied).toBe(false);
    expect(initial.balance).toBe(500);
  });
});
