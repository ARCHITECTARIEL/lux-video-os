import assert from 'node:assert/strict';
import test from 'node:test';

import { FEATURED_CAST, curateDefaultCast, matchedVoiceId, prioritizeVoices } from '../public/video-os-cast.js';
import { buildFeaturedAvatars, buildSharedAvatars } from '../api/video-os/talent.js';
import { mediaDisposition } from '../api/video-os-lite/download-v2.js';

const featured = FEATURED_CAST.map((item) => ({ id: item.avatarId, name: item.label, source: 'heygen', shared: false, active: true, providerReady: true, archived: false, blocked: false, previewUrl: `https://media.example/${item.key}.jpg` }));
const shared = (index, overrides = {}) => ({ id: `shared-${String(index).padStart(2, '0')}`, name: `Shared ${String(index).padStart(2, '0')}`, source: 'heygen', shared: true, active: true, providerReady: true, archived: false, blocked: false, previewUrl: `https://media.example/shared-${index}.jpg`, providerOrder: index, ...overrides });

test('featured cast uses exact provider IDs in Ariel, OSO, KD order', () => {
  assert.deepEqual(FEATURED_CAST.map((item) => item.label), ['Ariel', 'OSO', 'KD']);
  assert.deepEqual(FEATURED_CAST.map((item) => item.avatarId), [
    'ddd0cccc81334e50b493a12c34fb47b1',
    'e8083119a1024dd0814b6ba7e9addfc4',
    '880ad1223ca84f9590f21a0df4bf66b2',
  ]);
});

test('default cast is unique, deterministic, capped at 20, and excludes private user avatars', () => {
  const privateAvatar = shared(98, { id: 'private-user-avatar', shared: false });
  const malformed = shared(99, { previewUrl: '', providerReady: false });
  const input = [...Array.from({ length: 24 }, (_, index) => shared(index)), ...featured, shared(3), privateAvatar, malformed].reverse();
  const first = curateDefaultCast(input, []);
  const second = curateDefaultCast([...input].sort(() => 0), []);
  assert.equal(first.length, 20);
  assert.equal(new Set(first.map((item) => item.id)).size, 20);
  assert.deepEqual(first.slice(0, 3).map((item) => item.id), FEATURED_CAST.map((item) => item.avatarId));
  assert.equal(first.some((item) => item.id === 'private-user-avatar'), false);
  assert.equal(first.some((item) => item.id === malformed.id), false);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
});

test('successful owned render usage ranks shared avatars after featured cast', () => {
  const input = [...featured, shared(1), shared(2), shared(3)];
  const results = [
    { status: 'ready', avatar: { avatarId: 'shared-02' }, updatedAt: '2026-07-17T12:00:00Z' },
    { status: 'ready', avatar: { avatarId: 'shared-02' }, updatedAt: '2026-07-17T12:01:00Z' },
    { status: 'ready', avatar: { avatarId: 'shared-03' }, updatedAt: '2026-07-17T12:02:00Z' },
    { status: 'failed', avatar: { avatarId: 'shared-01' }, updatedAt: '2026-07-17T12:03:00Z' },
  ];
  assert.deepEqual(curateDefaultCast(input, results).slice(3).map((item) => item.id), ['shared-02', 'shared-03', 'shared-01']);
});

test('selected featured avatar prioritizes only its exact matched voice', () => {
  const voices = FEATURED_CAST.map((item) => ({ id: item.voiceId, name: item.label, source: 'heygen', providerReady: true }));
  voices.push({ id: 'duplicate-name', name: 'KD', source: 'heygen', providerReady: true });
  const kd = FEATURED_CAST.find((item) => item.label === 'KD');
  const ordered = prioritizeVoices(voices, kd.avatarId);
  assert.equal(matchedVoiceId(kd.avatarId), kd.voiceId);
  assert.equal(ordered[0].id, kd.voiceId);
  assert.notEqual(ordered[0].id, 'duplicate-name');
});


test('featured provider inventory uses exact IDs and fails visibly when unavailable', () => {
  const records = FEATURED_CAST.slice(0, 2).map((item) => ({ avatar_id: item.avatarId, avatar_name: item.label, preview_image_url: `https://media.example/${item.key}.jpg`, status: 'active' }));
  const built = buildFeaturedAvatars(records);
  assert.deepEqual(built.map((item) => item.id), FEATURED_CAST.map((item) => item.avatarId));
  assert.equal(built[0].providerReady, true);
  assert.equal(built[1].providerReady, true);
  assert.equal(built[2].providerReady, false);
  assert.match(built[2].unavailableReason, /not currently available/i);
});

test('shared inventory rejects private, blocked, archived, incompatible, and previewless records', () => {
  const valid = { avatar_id: 'public-ready', avatar_name: 'Public Ready', preview_image_url: 'https://media.example/public.jpg', supported_api_engines: ['avatar_iv'] };
  const blocked = { ...valid, avatar_id: 'blocked', blocked: true };
  const archived = { ...valid, avatar_id: 'archived', archived: true };
  const incompatible = { ...valid, avatar_id: 'incompatible', supported_api_engines: ['studio'] };
  const previewless = { ...valid, avatar_id: 'previewless', preview_image_url: '' };
  assert.deepEqual(buildSharedAvatars([valid, blocked, archived, incompatible, previewless]).map((item) => item.id), ['public-ready']);
});

test('owner playback is inline while download remains an attachment by default', () => {
  assert.equal(mediaDisposition(new URL('https://video.example/download?disposition=inline'), 'final.mp4'), 'inline; filename="final.mp4"');
  assert.equal(mediaDisposition(new URL('https://video.example/download'), 'final.mp4'), 'attachment; filename="final.mp4"');
});
