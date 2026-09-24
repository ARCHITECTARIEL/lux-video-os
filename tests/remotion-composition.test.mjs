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

test('getCompositionDimensions returns canonical 16:9 landscape and 9:16 portrait dimensions', async () => {
  const { getCompositionDimensions } = await import('../remotion/preview-composition.js');
  assert.deepEqual(getCompositionDimensions('landscape'), [1920, 1080]);
  assert.deepEqual(getCompositionDimensions('16:9'), [1920, 1080]);
  assert.deepEqual(getCompositionDimensions('portrait'), [1080, 1920]);
  assert.deepEqual(getCompositionDimensions('9:16'), [1080, 1920]);
  assert.deepEqual(getCompositionDimensions('vertical'), [1080, 1920]);
  assert.deepEqual(getCompositionDimensions('square'), [1080, 1080]);
});

test('getLowerThirdGeometry matches Remotion filter coordinate calculations', async () => {
  const { getLowerThirdGeometry } = await import('../remotion/preview-composition.js');
  const landscape = getLowerThirdGeometry(1920, 1080);
  assert.equal(landscape.boxX, 96);
  assert.equal(landscape.boxY, 930); // 1080 - 86 - Math.floor(1080 * 0.06) = 930
  assert.equal(landscape.boxWidth, 1056);
  assert.equal(landscape.boxHeight, 86);
  assert.equal(landscape.accentWidth, 6);
  assert.equal(landscape.brandStripWidth, 12);

  const portrait = getLowerThirdGeometry(1080, 1920);
  assert.equal(portrait.isPortrait, true);
  assert.equal(portrait.accentWidth, 8);
  assert.ok(portrait.boxWidth > 800);
});

test('getLowerThirdAnimation respects Remotion between(t,1,7) visibility window', async () => {
  const { getLowerThirdAnimation } = await import('../remotion/preview-composition.js');
  // t = 0.5s: before entry
  const before = getLowerThirdAnimation(0.5);
  assert.equal(before.visible, false);
  assert.equal(before.opacity, 0);

  // t = 1.2s: entering
  const entering = getLowerThirdAnimation(1.2);
  assert.equal(entering.visible, true);
  assert.ok(entering.opacity > 0 && entering.opacity < 1);

  // t = 3.0s: fully visible
  const active = getLowerThirdAnimation(3.0);
  assert.equal(active.visible, true);
  assert.equal(active.opacity, 1);
  assert.equal(active.slideOffset, 0);

  // t = 6.8s: exiting
  const exiting = getLowerThirdAnimation(6.8);
  assert.equal(exiting.visible, true);
  assert.ok(exiting.opacity < 1);

  // t = 7.5s: after exit
  const after = getLowerThirdAnimation(7.5);
  assert.equal(after.visible, false);
  assert.equal(after.opacity, 0);
});

test('computeCaptionSegments chunks script into timed subtitles and estimates duration', async () => {
  const { computeCaptionSegments, estimateScriptDuration } = await import('../remotion/preview-composition.js');
  const script = 'Welcome to LUX Video OS. Create studio quality presenter videos in seconds. Export to TikTok or YouTube.';
  const duration = estimateScriptDuration(script);
  assert.ok(duration >= 6 && duration <= 60);

  const segments = computeCaptionSegments(script, duration);
  assert.ok(segments.length >= 3);
  assert.ok(segments[0].text.includes('Welcome'));
  assert.ok(segments[0].startTime >= 0.5);
  assert.ok(segments[segments.length - 1].endTime <= duration);
});

