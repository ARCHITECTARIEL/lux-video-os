export function createCopywriterIdempotency({ ttlMs = 15 * 60_000, maxEntries = 2000, now = Date.now } = {}) {
  const entries = new Map();
  return {
    claim(key, fingerprint) {
      const current = entries.get(key);
      if (current && (current.pending || current.expiresAt > now())) {
        if (current.fingerprint !== fingerprint) return { state: 'conflict' };
        if (current.pending) return { state: 'pending' };
        entries.delete(key);
        entries.set(key, current);
        return { state: 'replay', result: current.result };
      }
      entries.delete(key);
      entries.set(key, { fingerprint, pending: true, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldestCompleted = [...entries].find(([, entry]) => !entry.pending)?.[0];
        if (oldestCompleted === undefined) {
          entries.delete(key);
          return { state: 'capacity' };
        }
        entries.delete(oldestCompleted);
      }
      return { state: 'new' };
    },
    complete(key, result) {
      const entry = entries.get(key);
      if (entry) { entry.pending = false; entry.result = result; entry.expiresAt = now() + ttlMs; }
    },
    release(key) { entries.delete(key); },
  };
}
