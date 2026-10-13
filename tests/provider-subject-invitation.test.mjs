import assert from 'node:assert/strict';
import test from 'node:test';

import {
  issueProviderSubjectInvitation,
  providerSubjectInvitationTokenHash,
  verifyProviderSubjectInvitation,
} from '../lib/provider-subject-invitation.js';

const env = { VIDEO_OS_HOSTED_SUBJECT_CONSENT_INVITATION_SECRET: 's'.repeat(48) };
const input = {
  accountId: 'owner-account',
  identityId: '11111111-1111-4111-8111-111111111111',
  subjectEmail: 'Subject@Example.test',
  expiresAt: '2026-10-07T18:15:00.000Z',
};

test('subject invitation is opaque, authenticated, expiring, and bound to the normalized subject email', () => {
  const invitation = issueProviderSubjectInvitation(input, { env, now: () => Date.parse('2026-10-07T18:00:00Z'), randomBytes: () => Buffer.alloc(24, 7) });
  assert.match(invitation.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(invitation.token.includes('Subject@Example.test'), false);
  const decodableSegments = invitation.token.split('.').map(segment => Buffer.from(segment, 'base64url').toString('utf8')).join(' ');
  assert.equal(decodableSegments.includes('owner-account'), false);
  assert.equal(decodableSegments.includes(input.identityId), false);
  assert.equal(decodableSegments.includes('subject@example.test'), false);
  assert.equal(invitation.tokenHash, providerSubjectInvitationTokenHash(invitation.token));
  assert.deepEqual(verifyProviderSubjectInvitation(invitation.token, { env, now: () => Date.parse('2026-10-07T18:01:00Z') }), {
    accountId: 'owner-account', identityId: input.identityId, subjectEmail: 'subject@example.test',
    expiresAt: input.expiresAt, tokenHash: invitation.tokenHash,
  });
  assert.throws(() => verifyProviderSubjectInvitation(`${invitation.token}x`, { env }), /invalid or expired/i);
  assert.throws(() => verifyProviderSubjectInvitation(invitation.token, { env, now: () => Date.parse(input.expiresAt) }), /invalid or expired/i);
});

test('subject invitation fails closed without dedicated signing authority', () => {
  assert.throws(() => issueProviderSubjectInvitation(input, { env: {}, now: () => Date.parse('2026-10-07T18:00:00Z') }), {
    code: 'subject_invitation_authority_unconfigured',
  });
});
