import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  FEATURED_CAST as PUBLIC_FEATURED_CAST,
  curateDefaultCast,
  matchedVoiceId,
  prioritizeVoices,
} from '../public/video-os-cast.js';
import { FEATURED_CAST as SERVER_FEATURED_CAST } from '../lib/video-os-featured-cast.js';
import { buildFeaturedAvatars, buildSharedAvatars, buildVoices } from '../api/video-os/talent.js';
import { mediaDisposition } from '../api/video-os-lite/download-v2.js';

const providerRecord = (item, overrides = {}) => ({
  id: item.avatarId,
  name: item.label,
  status: 'completed',
  preview_image_url: `https://media.example/${item.key}.jpg`,
  ...overrides,
});
const sharedRecord = (index, overrides = {}) => ({
  id: `shared-${String(index).padStart(2, '0')}`,
  name: `Shared ${String(index).padStart(2, '0')}`,
  status: 'completed',
  preview_image_url: `https://media.example/shared-${index}.jpg`,
  supported_api_engines: ['avatar_iv'],
  ...overrides,
});

test('public featured presentation metadata is keys-only and ordered Ariel, OSO, KD', () => {
  assert.deepEqual(PUBLIC_FEATURED_CAST, [
    { key: 'ariel', label: 'Ariel' },
    { key: 'oso', label: 'OSO' },
    { key: 'kd', label: 'KD' },
  ]);
  for (const item of PUBLIC_FEATURED_CAST) assert.deepEqual(Object.keys(item).sort(), ['key', 'label']);
});

test('server mapping has one exact avatar and voice ID for every presentation key', () => {
  assert.deepEqual(SERVER_FEATURED_CAST.map(({ key, label }) => ({ key, label })), PUBLIC_FEATURED_CAST);
  assert.equal(new Set(SERVER_FEATURED_CAST.map((item) => item.avatarId)).size, 3);
  assert.equal(new Set(SERVER_FEATURED_CAST.map((item) => item.voiceId)).size, 3);
  for (const item of SERVER_FEATURED_CAST) {
    assert.match(item.avatarId, /^[a-zA-Z0-9_-]+$/);
    assert.match(item.voiceId, /^[a-zA-Z0-9_-]+$/);
  }
});

test('featured records require exact IDs; duplicate display names cannot replace a mapping', () => {
  const exactFirst = providerRecord(SERVER_FEATURED_CAST[0], { name: 'Unrelated display name' });
  const nameOnlySecond = providerRecord(SERVER_FEATURED_CAST[1], { id: 'not-the-configured-record' });
  const exactThird = providerRecord(SERVER_FEATURED_CAST[2]);
  const built = buildFeaturedAvatars([exactFirst, nameOnlySecond, exactThird]);

  assert.deepEqual(built.map((item) => item.featuredKey), ['ariel', 'oso', 'kd']);
  assert.deepEqual(built.map((item) => item.id), ['featured:ariel', 'featured:oso', 'featured:kd']);
  assert.equal(built[0].providerReady, true);
  assert.equal(built[1].providerReady, false);
  assert.equal(built[2].providerReady, true);
  assert.match(built[1].unavailableReason, /not currently available/i);
});

test('default cast is unique, deterministic, capped at 20, and begins Ariel, OSO, KD', () => {
  const featured = buildFeaturedAvatars(SERVER_FEATURED_CAST.map((item) => providerRecord(item)));
  const shared = buildSharedAvatars(Array.from({ length: 24 }, (_, index) => sharedRecord(index)));
  const input = [...shared, ...featured, shared[3]].reverse();
  const first = curateDefaultCast(input, []);
  const second = curateDefaultCast([...input], []);

  assert.equal(first.length, 20);
  assert.equal(new Set(first.map((item) => item.id)).size, 20);
  assert.deepEqual(first.slice(0, 3).map((item) => item.featuredKey), ['ariel', 'oso', 'kd']);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
});

test('successful owned render usage ranks shared avatars after featured cast', () => {
  const featured = buildFeaturedAvatars(SERVER_FEATURED_CAST.map((item) => providerRecord(item)));
  const shared = buildSharedAvatars([1, 2, 3].map((index) => sharedRecord(index)));
  const input = [...featured, ...shared];
  const results = [
    { status: 'ready', avatar: { avatarId: 'shared-02' }, updatedAt: '2026-07-17T12:00:00Z' },
    { status: 'ready', avatar: { avatarId: 'shared-02' }, updatedAt: '2026-07-17T12:01:00Z' },
    { status: 'ready', avatar: { avatarId: 'shared-03' }, updatedAt: '2026-07-17T12:02:00Z' },
    { status: 'failed', avatar: { avatarId: 'shared-01' }, updatedAt: '2026-07-17T12:03:00Z' },
  ];
  assert.deepEqual(curateDefaultCast(input, results).slice(3).map((item) => item.id), ['shared-02', 'shared-03', 'shared-01']);
});

test('KD matched voice is prioritized without replacing an explicit user choice', () => {
  const kd = buildFeaturedAvatars([providerRecord(SERVER_FEATURED_CAST[2])])[2];
  const voices = buildVoices([
    { voice_id: 'ordinary-user-choice', voice_name: 'User choice', status: 'active' },
    ...SERVER_FEATURED_CAST.map((item) => ({ voice_id: item.voiceId, voice_name: item.label, status: 'active' })),
    { voice_id: 'duplicate-display-name', voice_name: 'KD', status: 'active' },
  ]);
  const ordered = prioritizeVoices(voices, kd);

  assert.equal(matchedVoiceId(kd), 'featured:kd:voice');
  assert.equal(ordered[0].id, 'featured:kd:voice');
  assert.notEqual(ordered[0].id, 'duplicate-display-name');
});

test('client preserves explicit voice selection when reprioritizing', async () => {
  const source = await readFile(new URL('../public/lite.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!appState\.voiceSelectionExplicit && recommended\) appState\.voice = recommended/);
  assert.match(source, /if \(type === ['"]voice['"] && explicit\) appState\.voiceSelectionExplicit = true/);
});

test('shared inventory rejects blocked, archived, incompatible, previewless, and duplicate records', () => {
  const valid = sharedRecord(1);
  const items = buildSharedAvatars([
    valid,
    { ...valid },
    sharedRecord(2, { blocked: true }),
    sharedRecord(3, { archived: true }),
    sharedRecord(4, { supported_api_engines: [] }),
    sharedRecord(5, { preview_image_url: '' }),
  ]);
  assert.deepEqual(items.map((item) => item.id), [valid.id]);
});

test('owner playback is inline while download remains an attachment by default', () => {
  assert.equal(mediaDisposition(new URL('https://video.example/download?disposition=inline'), 'final.mp4'), 'inline; filename="final.mp4"');
  assert.equal(mediaDisposition(new URL('https://video.example/download'), 'final.mp4'), 'attachment; filename="final.mp4"');
});
