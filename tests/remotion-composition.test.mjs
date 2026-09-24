import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRemotionFilterGraph, REMOTION_VERSION, REMOTION_COMPOSITION_ID } from '../services/remotion-finisher.js';
import { finishingEngine } from '../workflows/video-render.js';

test('finishingEngine selects ffmpeg by default', () => {
  assert.equal(finishingEngine({}), 'ffmpeg');
  assert.equal(finishingEngine({ VIDEO_OS_COMPOSITION_ENGINE: '' }), 'ffmpeg');
  assert.equal(finishingEngine({ VIDEO_OS_COMPOSITION_ENGINE: 'ffmpeg' }), 'ffmpeg');
});

test('finishingEngine supports remotion engine selection', () => {
  assert.equal(finishingEngine({ VIDEO_OS_COMPOSITION_ENGINE: 'remotion' }), 'remotion');
  assert.equal(finishingEngine({ VIDEO_OS_COMPOSITION_ENGINE: 'REMOTION' }), 'remotion');
});

test('finishingEngine enforces hyperframes feature flag', () => {
  assert.throws(() => finishingEngine({ VIDEO_OS_COMPOSITION_ENGINE: 'hyperframes' }), /HyperFrames was requested but disabled/);
  assert.equal(finishingEngine({ VIDEO_OS_COMPOSITION_ENGINE: 'hyperframes', VIDEO_OS_HYPERFRAMES_ENABLED: 'true' }), 'hyperframes');
});

test('buildRemotionFilterGraph builds valid multi-track filter for landscape 16:9', () => {
  const filter = buildRemotionFilterGraph(1920, 1080, { presenterTitle: 'Ariel', presenterSubtitle: 'LUX Video OS' });
  assert.match(filter, /scale=1920:1080/);
  assert.match(filter, /crop=1920:1080/);
  assert.match(filter, /drawbox=x=0:y=0:w=12/);
  assert.match(filter, /drawbox=x=96:y=930/);
  assert.match(filter, /format=yuv420p/);
});

test('buildRemotionFilterGraph builds valid multi-track filter for portrait 9:16', () => {
  const filter = buildRemotionFilterGraph(1080, 1920, { presenterTitle: 'Kristian', presenterSubtitle: 'LUX Video OS' });
  assert.match(filter, /scale=1080:1920/);
  assert.match(filter, /crop=1080:1920/);
  assert.match(filter, /format=yuv420p/);
});

test('Remotion metadata constants are versioned and identifiable', () => {
  assert.equal(REMOTION_VERSION, '4.0.0');
  assert.equal(REMOTION_COMPOSITION_ID, 'lux-remotion-finisher');
});
