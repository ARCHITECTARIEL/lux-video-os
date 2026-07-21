import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertIdentityProviderMutationEnabled,
  buildPhotoAvatarRequest,
  buildVoiceCloneRequest,
  cloneHeygenVoice,
  createHeygenPhotoAvatar,
  getHeygenPhotoAvatarStatus,
  getHeygenVoiceStatus,
  normalizeAvatarLook,
  normalizeIdentityProviderStatus,
  normalizeVoice,
  safeProviderErrorCode,
  uploadHeygenIdentityAsset,
} from '../services/heygen.js';

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  HEYGEN_API_KEY: process.env.HEYGEN_API_KEY,
  VIDEO_OS_IDENTITY_PROVIDER_ENABLED: process.env.VIDEO_OS_IDENTITY_PROVIDER_ENABLED,
  HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED: process.env.HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED,
};

function enableProviderMutations() {
  process.env.HEYGEN_API_KEY = 'test-key';
  process.env.VIDEO_OS_IDENTITY_PROVIDER_ENABLED = 'true';
  process.env.HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED = 'true';
}

function restoreEnvironment() {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test.afterEach(restoreEnvironment);

test('identity provider mutations require both independent safety gates', () => {
  assert.throws(() => assertIdentityProviderMutationEnabled({}), { failureCategory: 'IDENTITY_PROVIDER_DISABLED' });
  assert.throws(() => assertIdentityProviderMutationEnabled({ VIDEO_OS_IDENTITY_PROVIDER_ENABLED: 'true' }), { failureCategory: 'IDENTITY_ASSET_PRIVACY_UNCONFIRMED' });
  assert.doesNotThrow(() => assertIdentityProviderMutationEnabled({ VIDEO_OS_IDENTITY_PROVIDER_ENABLED: 'TRUE', HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED: 'true' }));
});

test('photo-avatar and voice-clone builders use current v3 asset-id contracts', () => {
  assert.deepEqual(buildPhotoAvatarRequest({ assetId: 'asset_123', name: 'CEO Identity' }), {
    type: 'photo',
    name: 'CEO Identity',
    file: { type: 'asset_id', asset_id: 'asset_123' },
  });
  assert.deepEqual(buildVoiceCloneRequest({ assetId: 'asset_456', name: 'CEO Voice', language: 'en' }), {
    audio: { type: 'asset_id', asset_id: 'asset_456' },
    voice_name: 'CEO Voice',
    remove_background_noise: true,
    language: 'en',
  });
});

test('status normalizers are defensive and never return raw provider failure text', () => {
  assert.equal(normalizeIdentityProviderStatus('READY'), 'completed');
  assert.equal(normalizeIdentityProviderStatus('', { hasPreview: true }), 'completed');
  assert.equal(normalizeIdentityProviderStatus('queued'), 'processing');
  assert.equal(safeProviderErrorCode('BAD/URL:https://secret.example'), null);

  const failedLook = normalizeAvatarLook({ data: { id: 'look_1', status: 'failed', error: { code: 'training_failed', message: 'secret signed url' } } });
  assert.equal(failedLook.status, 'failed');
  assert.equal(failedLook.failureCode, 'training_failed');
  assert.equal(failedLook.failureMessage, 'HeyGen avatar look processing failed.');
  assert.equal(JSON.stringify(failedLook).includes('secret signed url'), false);

  const readyVoice = normalizeVoice({ data: { voice_id: 'voice_1', preview_audio_url: 'https://files.heygen.ai/preview.mp3' } });
  assert.equal(readyVoice.ready, true);
});

test('identity asset upload is multipart, bounded, and does not set a broken content-type boundary', async () => {
  enableProviderMutations();
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ data: { asset_id: 'asset_uploaded', mime_type: 'image/png', size_bytes: 4 } }), { status: 200 });
  };

  const result = await uploadHeygenIdentityAsset({ buffer: new Uint8Array([1, 2, 3, 4]), contentType: 'image/png', filename: '../CEO photo.png' });
  assert.equal(result.providerAssetId, 'asset_uploaded');
  assert.equal(captured.url, 'https://api.heygen.com/v3/assets');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.body instanceof FormData, true);
  assert.equal(Object.keys(captured.options.headers).some((name) => name.toLowerCase() === 'content-type'), false);
  assert.equal(captured.options.body.get('file').name, '.._CEO_photo.png');
});

test('photo-avatar creation sends one idempotent v3 request and normalizes both IDs', async () => {
  enableProviderMutations();
  let calls = 0;
  let captured;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    captured = { url, options };
    return new Response(JSON.stringify({ data: {
      avatar_group: { id: 'group_1', status: 'completed', consent_status: null },
      avatar_item: { id: 'look_1', group_id: 'group_1', status: 'completed', supported_api_engines: ['avatar_iv'] },
    } }), { status: 200 });
  };

  const result = await createHeygenPhotoAvatar({ assetId: 'asset_1', name: 'CEO', idempotencyKey: 'identity:avatar:1' });
  assert.equal(calls, 1);
  assert.equal(captured.url, 'https://api.heygen.com/v3/avatars');
  assert.equal(captured.options.headers['Idempotency-Key'], 'identity:avatar:1');
  assert.deepEqual(JSON.parse(captured.options.body), buildPhotoAvatarRequest({ assetId: 'asset_1', name: 'CEO' }));
  assert.equal(result.avatarGroup.providerGroupId, 'group_1');
  assert.equal(result.avatarLook.providerLookId, 'look_1');
});

test('voice cloning uses local-reservation semantics without inventing a provider idempotency header', async () => {
  enableProviderMutations();
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ data: { voice_clone_id: 'voice_clone_1' } }), { status: 200 });
  };

  const result = await cloneHeygenVoice({ assetId: 'asset_2', name: 'CEO Voice' });
  assert.equal(result.providerVoiceId, 'voice_clone_1');
  assert.equal(captured.url, 'https://api.heygen.com/v3/voices/clone');
  assert.equal(Object.keys(captured.options.headers).some((name) => name.toLowerCase() === 'idempotency-key'), false);
});

test('status reads use exact group, look, and voice endpoints', async () => {
  process.env.HEYGEN_API_KEY = 'test-key';
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.includes('/looks/')) return new Response(JSON.stringify({ data: { id: 'look_1', group_id: 'group_1', status: 'completed' } }), { status: 200 });
    if (url.includes('/voices/')) return new Response(JSON.stringify({ data: { voice_id: 'voice_1', status: 'complete', preview_audio_url: 'https://files.heygen.ai/voice.mp3' } }), { status: 200 });
    return new Response(JSON.stringify({ data: { id: 'group_1', status: 'completed' } }), { status: 200 });
  };

  const avatar = await getHeygenPhotoAvatarStatus({ groupId: 'group_1', lookId: 'look_1' });
  const voice = await getHeygenVoiceStatus('voice_1');
  assert.equal(avatar.ready, true);
  assert.equal(voice.ready, true);
  assert.deepEqual(urls, [
    'https://api.heygen.com/v3/avatars/group_1',
    'https://api.heygen.com/v3/avatars/looks/look_1',
    'https://api.heygen.com/v3/voices/voice_1',
  ]);
});

test('provider HTTP failures expose only a sanitized code and generic message', async () => {
  enableProviderMutations();
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'plan_upgrade_required', message: 'private signed url https://secret.example' } }), { status: 403 });
  await assert.rejects(
    cloneHeygenVoice({ assetId: 'asset_2', name: 'CEO Voice' }),
    (error) => error.message === 'HeyGen request failed with HTTP 403.' && error.providerErrorCode === 'plan_upgrade_required' && !error.message.includes('secret.example'),
  );
});
