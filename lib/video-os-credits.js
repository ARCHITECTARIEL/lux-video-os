import crypto from 'node:crypto';
import { get } from '@vercel/blob';
import { PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from './video-os-private-blob.js';

const CREDIT_PREFIX = 'video-os/credit-state/';
const EVENT_PREFIX = 'video-os/stripe-events/';
const token = () => process.env.BLOB_READ_WRITE_TOKEN;
const safe = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

async function readJson(path) {
  const result = await get(path, { access: 'private', token: token(), useCache: false });
  if (!result?.stream) return null;
  return { value: await new Response(result.stream).json(), etag: result.blob.etag };
}

async function ensureState(accountId, initialBalance = 0) {
  const path = `${CREDIT_PREFIX}${safe(accountId)}.json`;
  const found = await readJson(path);
  if (found) return { path, ...found };
  const value = { schemaVersion: 1, accountId: safe(accountId), balance: Number(initialBalance || 0), purchased: 0, spent: 0, appliedStripeEvents: {}, updatedAt: new Date().toISOString() };
  try {
    const created = await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.CREDIT_STATE, path, JSON.stringify(value), { contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false, token: token() });
    return { path, value, etag: created.etag };
  } catch (error) {
    if (error?.name !== 'BlobPreconditionFailedError' && error?.statusCode !== 409) throw error;
    const raced = await readJson(path);
    if (!raced) throw error;
    return { path, ...raced };
  }
}

async function mutate(accountId, initialBalance, change) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await ensureState(accountId, initialBalance);
    const next = change(structuredClone(current.value));
    next.updatedAt = new Date().toISOString();
    try {
      const saved = await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.CREDIT_STATE, current.path, JSON.stringify(next), { contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, ifMatch: current.etag, token: token() });
      return { ...next, etag: saved.etag };
    } catch (error) {
      if (error?.name !== 'BlobPreconditionFailedError' && error?.statusCode !== 412) throw error;
    }
  }
  throw Object.assign(new Error('Credit state is busy; retry safely.'), { statusCode: 503, failureCategory: 'RECONCILIATION' });
}

export async function loadCreditState(accountId, initialBalance) {
  return (await ensureState(accountId, initialBalance)).value;
}

export async function debitCredits(accountId, initialBalance, amount) {
  return mutate(accountId, initialBalance, (state) => {
    if (state.balance < amount) throw Object.assign(new Error('Insufficient credits.'), { statusCode: 402 });
    state.balance -= amount;
    state.spent = Number(state.spent || 0) + amount;
    return state;
  });
}

export function applyStripeEvent(state, { eventId, sessionId, credits }) {
  state.appliedStripeEvents ||= {};
  if (state.appliedStripeEvents[eventId]) return { state, applied: false };
  state.balance = Number(state.balance || 0) + Number(credits);
  state.purchased = Number(state.purchased || 0) + Number(credits);
  state.appliedStripeEvents[eventId] = { sessionId, credits: Number(credits), appliedAt: new Date().toISOString() };
  return { state, applied: true };
}

export async function issueStripeCredits({ eventId, sessionId, accountId, credits, rawBodySha256, eventCreatedAt }) {
  const eventPath = `${EVENT_PREFIX}${safe(eventId)}.json`;
  const event = { schemaVersion: 1, eventId, sessionId, accountId: safe(accountId), credits: Number(credits), rawBodySha256, eventCreatedAt, receivedAt: new Date().toISOString() };
  try {
    await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.STRIPE_EVENT, eventPath, JSON.stringify(event), { contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false, token: token() });
  } catch (error) {
    if (error?.name !== 'BlobPreconditionFailedError' && error?.statusCode !== 409) throw error;
    const existing = await readJson(eventPath);
    const expected = crypto.createHash('sha256').update(JSON.stringify({ eventId, sessionId, accountId: safe(accountId), credits: Number(credits), rawBodySha256 })).digest('hex');
    const actual = crypto.createHash('sha256').update(JSON.stringify({ eventId: existing?.value?.eventId, sessionId: existing?.value?.sessionId, accountId: existing?.value?.accountId, credits: existing?.value?.credits, rawBodySha256: existing?.value?.rawBodySha256 })).digest('hex');
    if (!existing || actual !== expected) throw Object.assign(new Error('Stripe ledger collision.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  }
  return mutate(accountId, 0, (state) => {
    return applyStripeEvent(state, { eventId, sessionId, credits }).state;
  });
}
