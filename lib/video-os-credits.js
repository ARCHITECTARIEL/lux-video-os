export function applyStripeEvent(state, { eventId, sessionId, credits }) {
  state.appliedStripeEvents ||= {};
  if (state.appliedStripeEvents[eventId]) return { state, applied: false };
  state.balance = Number(state.balance || 0) + Number(credits);
  state.purchased = Number(state.purchased || 0) + Number(credits);
  state.appliedStripeEvents[eventId] = { sessionId, credits: Number(credits), appliedAt: new Date().toISOString() };
  return { state, applied: true };
}