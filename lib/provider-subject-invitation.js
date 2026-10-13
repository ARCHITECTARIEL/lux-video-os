import crypto from 'node:crypto';

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure() {
  return Object.assign(new Error('Subject consent invitation is invalid or expired.'), {
    statusCode: 410,
    code: 'subject_invitation_invalid',
    failureCategory: 'SUBJECT_CONSENT_CHALLENGE_INVALID',
  });
}

function secret(env) {
  const value = String(env.VIDEO_OS_HOSTED_SUBJECT_CONSENT_INVITATION_SECRET || '').trim();
  if (Buffer.byteLength(value) < 32) {
    throw Object.assign(new Error('Hosted subject consent invitation authority is not configured.'), {
      statusCode: 503,
      code: 'subject_invitation_authority_unconfigured',
      failureCategory: 'CONFIG_MISSING',
    });
  }
  return value;
}

const AAD = Buffer.from('video-os/provider-subject-invitation/v1');
function encryptionKey(env) { return crypto.createHash('sha256').update(AAD).update('\0').update(secret(env)).digest(); }
export function providerSubjectInvitationTokenHash(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }

export function issueProviderSubjectInvitation({ accountId, identityId, subjectEmail, expiresAt }, { env = process.env, now = Date.now, randomBytes = crypto.randomBytes } = {}) {
  const email = String(subjectEmail || '').trim().toLowerCase();
  const expiry = new Date(expiresAt).getTime();
  if (!accountId || !UUID.test(String(identityId || '')) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || !Number.isFinite(expiry) || expiry <= now()) throw failure();
  const iv = randomBytes(12).subarray(0, 12);
  if (iv.length !== 12) throw failure();
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(env), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ v: VERSION, a: String(accountId), i: identityId, e: email, x: expiry, n: randomBytes(24).toString('base64url') }), 'utf8'), cipher.final()]);
  const token = `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  return Object.freeze({ token, tokenHash: providerSubjectInvitationTokenHash(token), expiresAt: new Date(expiry).toISOString() });
}

export function verifyProviderSubjectInvitation(token, { env = process.env, now = Date.now } = {}) {
  const [ivText, ciphertextText, tagText, extra] = String(token || '').split('.');
  if (!ivText || !ciphertextText || !tagText || extra) throw failure();
  let data;
  try {
    const iv = Buffer.from(ivText, 'base64url');
    const ciphertext = Buffer.from(ciphertextText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw failure();
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(env), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    data = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch { throw failure(); }
  if (data?.v !== VERSION || !data.a || !UUID.test(String(data.i || ''))
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.e || ''))
    || !Number.isFinite(data.x) || data.x <= now() || typeof data.n !== 'string') throw failure();
  return Object.freeze({ accountId: data.a, identityId: data.i, subjectEmail: data.e, expiresAt: new Date(data.x).toISOString(), tokenHash: providerSubjectInvitationTokenHash(token) });
}
