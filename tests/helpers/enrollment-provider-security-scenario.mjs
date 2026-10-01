import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { mock } from 'node:test';

const scenario = process.argv[2];
const accountId = 'enrollment-provider-owner';
const identityId = '11111111-1111-4111-8111-111111111111';
const photoId = '22222222-2222-4222-8222-222222222222';
const voiceId = '33333333-3333-4333-8333-333333333333';
const videoId = '44444444-4444-4444-8444-444444444444';
const photoBytes = Buffer.from('verified-photo-bytes-only');
const voiceBytes = Buffer.from('derived-mono-16khz-pcm-wav-bytes-only');
const videoBytes = Buffer.from('original-phone-video-must-never-reach-provider');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

const assets = {
  [photoId]: { id: photoId, accountId, kind: 'identity-photo-source', contentType: 'image/png', privatePathname: `video-os/uploads/${accountId}/photo.png`, bytes: photoBytes.length, sha256: digest(photoBytes), quarantinedAt: null },
  [voiceId]: { id: voiceId, accountId, kind: 'identity-voice-source', contentType: 'audio/wav', privatePathname: `video-os/enrollment-sources/${accountId}/derived.wav`, bytes: voiceBytes.length, sha256: digest(voiceBytes), quarantinedAt: null },
  [videoId]: { id: videoId, accountId, kind: 'identity-phone-video-source', contentType: 'video/mp4', privatePathname: `video-os/enrollment-sources/${accountId}/source.mp4`, bytes: videoBytes.length, sha256: digest(videoBytes), quarantinedAt: null },
};

const identity = {
  id: identityId,
  accountId,
  displayName: 'Enrollment Identity',
  overallStatus: 'DRAFT',
  avatarStatus: 'DRAFT',
  voiceStatus: 'DRAFT',
  sourcePhotoAssetId: photoId,
  sourceVoiceAssetId: voiceId,
  archivedAt: null,
};

const calls = {
  assetReads: [], blobReads: [], uploads: [], avatarCreates: [], voiceCreates: [], claims: [], receipts: [], completes: [], failures: [], attaches: [], submissions: [], reservations: [], componentFailures: [],
};
let blockedMode = null;
let revoked = false;
let reconciliationStatus = 'NONE';

function error(message, statusCode, failureCategory) {
  return Object.assign(new Error(message), { statusCode, failureCategory });
}

function send(res, status, payload) {
  res.statusCode = status;
  res.body = payload;
  return payload;
}

mock.module('../../lib/video-os-account.js', { namedExports: {
  handleOptions: () => false,
  send,
  sessionFromRequest: () => ({ accountId, email: 'owner@example.test' }),
} });

mock.module('../../db/repositories.js', { namedExports: {
  archiveOwnedIdentity: async () => ({ ...identity, archivedAt: new Date(), overallStatus: 'ARCHIVED' }),
  attachProviderMediaAsset: async input => { calls.attaches.push(input); return assets[input.assetId]; },
  createIdentityDraft: async () => identity,
  ensureAccount: async () => ({}),
  getOwnedIdentity: async () => identity,
  getOwnedMediaAsset: async (_owner, assetId) => {
    calls.assetReads.push(assetId);
    const asset = assets[assetId];
    if (!asset) return null;
    if (blockedMode === 'quarantined') return { ...asset, quarantinedAt: new Date() };
    if (blockedMode === 'mismatched' && assetId === photoId) return { ...asset, sha256: digest(Buffer.from('different-consented-bytes')) };
    return asset;
  },
  listOwnedIdentities: async () => [identity],
  markIdentityComponentFailed: async input => { calls.componentFailures.push(input); return identity; },
  markIdentityComponentReady: async () => identity,
  prepareIdentityProviderRead: async ({ accountId: requestedAccountId, identityId: requestedIdentityId, component }) => Object.freeze({
    version: 'heygen-identity-read-claim/v1',
    accountId: requestedAccountId,
    identityId: requestedIdentityId,
    component,
    operationKey: 'fixture-operation',
    providerAvatarGroupId: component === 'avatar' ? 'provider-avatar-group' : null,
    providerRenderableAvatarId: component === 'avatar' ? 'provider-avatar-look' : null,
    providerVoiceId: component === 'voice' ? 'provider-voice' : null,
    resourceIds: Object.freeze(component === 'avatar' ? ['resource-group', 'resource-look'] : ['resource-voice']),
  }),
  prepareIdentityProviderRead: async input => ({
    version: 'heygen-identity-read-claim/v1',
    accountId: input.accountId,
    identityId: input.identityId,
    component: input.component,
    operationKey: input.component === 'avatar' ? identity.avatarOperationKey : identity.voiceOperationKey,
    providerAvatarGroupId: identity.providerAvatarGroupId || null,
    providerRenderableAvatarId: identity.providerRenderableAvatarId || null,
    providerVoiceId: identity.providerVoiceId || null,
    resourceIds: [],
  }),
  recordIdentityConsent: async () => ({ consent: { identityId } }),
  recordIdentityProviderSubmission: async input => {
    calls.submissions.push(input);
    if (input.component === 'avatar') identity.avatarStatus = 'PROCESSING';
    else identity.voiceStatus = 'PROCESSING';
    return identity;
  },
  reserveIdentityComponentCreation: async input => {
    assert.equal(providerBindings.has(input.providerBinding), true, 'component reservation must use a fresh provider binding');
    calls.reservations.push(input);
    return { identity, replayed: false };
  },
} });

function acceptedProviderIds(component, stage) {
  if (stage === 'asset') return { providerAssetId: `provider-${component}-asset` };
  return component === 'avatar'
    ? { providerRequestId: 'provider-avatar-request', providerAvatarGroupId: 'provider-avatar-group', providerRenderableAvatarId: 'provider-avatar-look' }
    : { providerVoiceId: 'provider-voice' };
}

mock.module('../../db/enrollment-repository.js', { namedExports: {
  assertEnrollmentProviderAllowed: async () => {
    if (blockedMode === 'revoked') throw error('Enrollment consent is revoked.', 409, 'CONSENT');
    if (revoked || reconciliationStatus === 'PENDING') throw error('Enrollment provider work requires reconciliation.', 409, 'RECONCILIATION');
    return true;
  },
  claimEnrollmentProviderOperation: async input => {
    calls.claims.push(input);
    const source = assets[input.component === 'avatar' ? photoId : voiceId];
    const providerAssetId = input.stage === 'create' || scenario === 'resume' || scenario === 'replay-missing-voice'
      ? acceptedProviderIds(input.component, 'asset').providerAssetId
      : null;
    const claimProof = Object.freeze({
      version: 'heygen-enrollment-provider-claim/v1',
      enrollmentId: 'fixture-enrollment',
      identityId,
      component: input.component,
      stage: input.stage,
      operationKey: input.operationKey,
      source: Object.freeze({
        assetId: source.id,
        sha256: source.sha256,
        bytes: source.bytes,
        contentType: source.contentType,
        providerAssetId,
      }),
    });
    const forcedReplay = scenario === 'resume' || scenario === 'replay-submitting-asset' || scenario === 'replay-missing-voice';
    const receipt = {
      ledgerOperationId: `ledger-${input.component}-${input.stage}`,
      operationKey: input.operationKey,
      status: scenario === 'replay-submitting-asset' ? 'SUBMITTING' : forcedReplay ? 'ACCEPTED' : 'SUBMITTING',
      ...(forcedReplay && scenario !== 'replay-submitting-asset'
        ? { providerIds: scenario === 'replay-missing-voice' && input.stage === 'create' ? {} : acceptedProviderIds(input.component, input.stage) }
        : {}),
    };
    if (forcedReplay) {
      return { enrollment: { id: 'fixture-enrollment', providerReconciliationStatus: 'SUBMITTING' }, receipt, replayed: true, claimProof };
    }
    if (scenario === 'claim-proof-missing') {
      return { enrollment: { id: 'fixture-enrollment', providerReconciliationStatus: reconciliationStatus }, receipt, replayed: false };
    }
    return { enrollment: { id: 'fixture-enrollment', providerReconciliationStatus: reconciliationStatus }, receipt, replayed: false, claimProof };
  },
  completeEnrollmentProviderOperation: async input => { calls.completes.push(input); return { providerReconciliationStatus: 'COMPLETE' }; },
  failEnrollmentProviderOperation: async input => { calls.failures.push(input); if (input.ambiguous) reconciliationStatus = 'PENDING'; return { providerReconciliationStatus: reconciliationStatus }; },
  getLinkedEnrollmentForIdentity: async () => null,
  recordEnrollmentProviderReceipt: async input => {
    calls.receipts.push(input);
    if (scenario === 'orphan' && revoked) {
      reconciliationStatus = 'PENDING';
      return { enrollment: { providerReconciliationStatus: 'PENDING' }, orphaned: true };
    }
    return { enrollment: { providerReconciliationStatus: 'SUBMITTING' }, orphaned: false };
  },
} });

const providerBindings = new WeakSet();
const resolvedBindings = [];
let bindingResolutionAttempts = 0;
mock.module('../../db/heygen-space-binding-repository.js', { namedExports: {
  resolveFreshHeygenSpaceBinding: async () => {
    bindingResolutionAttempts++;
    if (scenario === 'binding-reserve-failure'
      || (scenario === 'binding-claim-failure' && bindingResolutionAttempts > 1)) {
      throw error('Provider space binding is unavailable.', 409, 'RECONCILIATION');
    }
    const binding = Object.freeze({ fixture: 'fresh-provider-space-binding', sequence: calls.claims.length });
    providerBindings.add(binding);
    resolvedBindings.push(binding);
    return binding;
  },
  assertFreshHeygenSpaceBinding: binding => {
    assert.equal(providerBindings.has(binding), true, 'provider mutation must use a freshly resolved fixture binding');
    return binding;
  },
  assertFreshHeygenProviderClaimTx: (_tx, { providerBinding }) => {
    assert.equal(providerBindings.has(providerBinding), true, 'provider claim must use a freshly resolved fixture binding');
    return providerBinding;
  },
} });

mock.module('../../db/provider-reconciliation-repository.js', { namedExports: {
  providerCreationActivationStatus: () => Object.freeze({ enabled: true, reason: 'test_fixture_only' }),
} });

mock.module('../../lib/video-os-private-blob.js', { namedExports: {
  getPrivateBlob: async pathname => {
    calls.blobReads.push(pathname);
    const asset = Object.values(assets).find(value => value.privatePathname === pathname);
    if (!asset) return null;
    const bytes = asset.id === photoId ? photoBytes : asset.id === voiceId ? voiceBytes : videoBytes;
    return { stream: Readable.from([bytes]), blob: { etag: `etag-${asset.id}` } };
  },
} });

mock.module('../../services/heygen.js', { namedExports: {
  assertHeygenConfigured: () => true,
  assertIdentityProviderAccountAuthorized: () => true,
  assertIdentityProviderMutationEnabled: () => true,
  cloneHeygenVoice: async input => { calls.voiceCreates.push(input); return { providerVoiceId: 'provider-voice' }; },
  createHeygenPhotoAvatar: async input => {
    calls.avatarCreates.push(input);
    return {
      avatarGroup: { providerGroupId: 'provider-avatar-group' },
      avatarLook: { providerLookId: 'provider-avatar-look' },
    };
  },
  getHeygenPhotoAvatarStatus: async () => ({}),
  getHeygenVoiceStatus: async () => ({}),
  providerMediaHostname: () => 'files.heygen.com',
  uploadHeygenIdentityAsset: async input => {
    calls.uploads.push(input);
    if (scenario === 'ambiguous') throw error('Provider response was not confirmed.', 502, 'PROVIDER_TIMEOUT');
    if (scenario === 'orphan') revoked = true;
    return { providerAssetId: input.contentType.startsWith('image/') ? 'provider-avatar-asset' : 'provider-voice-asset' };
  },
} });

mock.module('workflow/api', { namedExports: { start: async () => ({ runId: 'workflow-run' }) } });

const { default: handler } = await import('../../routes/video-os-lite/identities.js');

async function submit() {
  const req = { method: 'POST', headers: {}, body: { action: 'submit', identityId } };
  const res = { setHeader() {}, end(raw) { if (raw) this.body = JSON.parse(raw); } };
  await handler(req, res);
  return res;
}

if (scenario === 'bytes') {
  const res = await submit();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls.uploads.length, 2);
  const photoUpload = calls.uploads.find(call => call.contentType === 'image/png');
  const voiceUpload = calls.uploads.find(call => call.contentType === 'audio/wav');
  assert.deepEqual(Buffer.from(photoUpload.buffer), photoBytes);
  assert.deepEqual(Buffer.from(voiceUpload.buffer), voiceBytes);
  assert.ok(calls.uploads.every(call => !Buffer.from(call.buffer).equals(videoBytes)));
  assert.deepEqual(calls.assetReads.sort(), [photoId, voiceId].sort());
  assert.ok(calls.blobReads.every(pathname => !pathname.endsWith('/source.mp4')));
  assert.deepEqual(calls.claims.map(call => `${call.component}:${call.stage}`).sort(), ['avatar:asset', 'avatar:create', 'voice:asset', 'voice:create']);
  assert.deepEqual(calls.receipts.map(call => `${call.component}:${call.stage}`).sort(), ['avatar:asset', 'avatar:create', 'voice:asset', 'voice:create']);
  assert.deepEqual(calls.completes.map(call => `${call.component}:${call.stage}`).sort(), ['avatar:asset', 'avatar:create', 'voice:asset', 'voice:create']);
  for (const claim of calls.claims) {
    assert.equal(providerBindings.has(claim.providerBinding), true);
    assert.ok(calls.receipts.some(receipt => receipt.component === claim.component && receipt.stage === claim.stage
      && receipt.operationKey === claim.operationKey && receipt.providerBinding === claim.providerBinding));
    assert.ok(calls.completes.some(complete => complete.component === claim.component && complete.stage === claim.stage
      && complete.operationKey === claim.operationKey && complete.providerBinding === claim.providerBinding));
  }
  assert.equal(new Set(resolvedBindings).size, calls.claims.length + calls.reservations.length, 'reservation/asset/create boundaries must not reuse a provider binding');
  assert.equal(calls.failures.length, 0);
} else if (scenario === 'blocked') {
  identity.voiceStatus = 'READY';
  for (const mode of ['revoked', 'quarantined', 'mismatched']) {
    blockedMode = mode;
    identity.avatarStatus = 'DRAFT';
    const res = await submit();
    assert.equal(res.statusCode, 409, `${mode}: ${JSON.stringify(res.body)}`);
  }
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.avatarCreates.length, 0);
  assert.equal(calls.voiceCreates.length, 0);
  assert.equal(calls.claims.length, 0, 'source authorization and byte verification must precede provider claims');
} else if (scenario === 'orphan') {
  identity.avatarStatus = 'READY';
  identity.voiceStatus = 'DRAFT';
  const first = await submit();
  assert.equal(first.statusCode, 200);
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.receipts.length, 1);
  assert.deepEqual(calls.receipts[0].providerIds, { providerAssetId: 'provider-voice-asset' });
  assert.equal(calls.receipts[0].operationKey, calls.claims[0].operationKey);
  assert.equal(reconciliationStatus, 'PENDING');
  assert.equal(calls.attaches.length, 0);
  assert.equal(calls.voiceCreates.length, 0);
  assert.equal(calls.completes.length, 0);
  const second = await submit();
  assert.equal(second.statusCode, 200);
  assert.equal(calls.uploads.length, 1, 'pending orphan reconciliation must prevent an ambiguous repeat provider call');
  assert.equal(calls.voiceCreates.length, 0);
} else if (scenario === 'ambiguous') {
  identity.avatarStatus = 'READY';
  identity.voiceStatus = 'DRAFT';
  const first = await submit();
  assert.equal(first.statusCode, 200);
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.failures.length, 1);
  assert.equal(calls.failures[0].ambiguous, true);
  assert.equal(reconciliationStatus, 'PENDING');
  assert.equal(calls.receipts.length, 0);
  assert.equal(calls.voiceCreates.length, 0);
  const second = await submit();
  assert.equal(second.statusCode, 200);
  assert.equal(calls.uploads.length, 1, 'ambiguous provider submission must not be repeated while reconciliation is pending');
} else if (scenario === 'resume') {
  identity.avatarStatus = 'DRAFT';
  identity.voiceStatus = 'READY';
  const res = await submit();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.avatarCreates.length, 0);
  assert.equal(calls.voiceCreates.length, 0);
  assert.equal(calls.attaches.length, 1);
  assert.equal(calls.submissions.length, 1);
  assert.deepEqual(calls.completes.map(call => `${call.component}:${call.stage}`), ['avatar:asset', 'avatar:create']);
  assert.equal(calls.failures.length, 0);
} else if (scenario === 'binding-reserve-failure') {
  const res = await submit();
  assert.equal(res.statusCode, 200);
  assert.equal(calls.reservations.length, 0, 'binding resolution must precede component reservation');
  assert.equal(calls.claims.length, 0);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.componentFailures.length, 0, 'no reservation means no component status write');
} else if (scenario === 'binding-claim-failure') {
  identity.voiceStatus = 'READY';
  const res = await submit();
  assert.equal(res.statusCode, 200);
  assert.equal(calls.reservations.length, 1);
  assert.equal(calls.claims.length, 0);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.componentFailures.length, 1, 'later resolution failure must release the reserved component');
  assert.strictEqual(calls.componentFailures[0].providerBinding, calls.reservations[0].providerBinding);
} else if (scenario === 'claim-proof-missing') {
  identity.voiceStatus = 'READY';
  const res = await submit();
  assert.equal(res.statusCode, 200);
  assert.equal(calls.claims.length, 1);
  assert.equal(calls.uploads.length, 0, 'malformed canonical claim must stop before provider HTTP');
  assert.equal(calls.avatarCreates.length, 0);
  assert.equal(calls.failures.length >= 1, true, 'claimed operation must be durably failed');
} else if (scenario === 'replay-submitting-asset') {
  identity.voiceStatus = 'READY';
  const res = await submit();
  assert.equal(res.statusCode, 200);
  assert.equal(calls.claims.length, 1);
  assert.equal(calls.uploads.length, 0, 'SUBMITTING asset replay cannot upload again');
  assert.equal(calls.avatarCreates.length, 0);
  assert.equal(calls.failures.length >= 1, true);
} else if (scenario === 'replay-missing-voice') {
  identity.avatarStatus = 'READY';
  const res = await submit();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.claims.map(call => call.stage), ['asset', 'create']);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.voiceCreates.length, 0, 'ACCEPTED voice replay without providerVoiceId cannot clone again');
  assert.equal(calls.failures.length >= 1, true);
} else {
  throw new Error(`Unknown enrollment provider security scenario: ${scenario}`);
}
