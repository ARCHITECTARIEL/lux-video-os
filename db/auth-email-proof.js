import { createHash } from 'node:crypto';

import { database } from './client.js';
import { authChallenges } from './schema.js';

// Proof that an account's email was verified by a consumed magic link.
// It is a used `auth_challenges` row, the same evidence the Lux staff-grant
// check (verifiedStaffEmailTx) already reads: account_id = the signed-in
// account, lower(email) = the email the link was sent to, used_at set.
//
// Tamper resistance:
// - Written only by the auth-verify path, after the single-use magic token
//   was consumed with a compare-and-swap on its Blob record, so the email is
//   the address that received the link, never a request field.
// - token_hash is a domain-separated digest of the magic token digest, so it
//   can never collide with (or be replayed as) any other challenge row, and a
//   replayed link writes nothing new (ON CONFLICT DO NOTHING).
// - No route accepts a client-supplied proof; nothing here is exported to
//   request handlers except through auth-verify.
export const MAGIC_LINK_EMAIL_PROOF_TYPE = 'magic_link';
const PROOF_DOMAIN = 'lux-video-os/magic-link-email-proof/v1\n';
const SHA256 = /^[a-f0-9]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function magicLinkProofTokenHash(magicTokenHash) {
  if (!SHA256.test(String(magicTokenHash || ''))) throw Object.assign(new Error('Magic-link proof is invalid.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  return createHash('sha256').update(PROOF_DOMAIN).update(magicTokenHash).digest('hex');
}

export async function recordMagicLinkEmailProof({ accountId, email, magicTokenHash, usedAt = new Date(), executor } = {}) {
  const account = typeof accountId === 'string' ? accountId : '';
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const used = usedAt instanceof Date ? usedAt : new Date(usedAt);
  if (!account || account.length > 160 || /[\u0000-\u001f\u007f]/.test(account) || !EMAIL.test(normalized) || normalized.length > 320
    || !Number.isFinite(used.getTime())) {
    throw Object.assign(new Error('Magic-link proof is invalid.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  }
  const tokenHash = magicLinkProofTokenHash(magicTokenHash);
  const rows = await (executor || database()).insert(authChallenges).values({
    accountId: account,
    email: normalized,
    tokenHash,
    challengeType: MAGIC_LINK_EMAIL_PROOF_TYPE,
    expiresAt: used,
    usedAt: used,
  }).onConflictDoNothing({ target: authChallenges.tokenHash }).returning({ id: authChallenges.id });
  return { recorded: rows.length === 1 };
}
