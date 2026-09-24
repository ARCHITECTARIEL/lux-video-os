/**
 * LUX Video OS - Remotion Composition & Live Preview Definitions
 * Synchronizes client in-browser canvas renderer with server-side Remotion engine.
 */

export const REMOTION_VERSION = '4.0.0';
export const REMOTION_COMPOSITION_ID = 'lux-remotion-finisher';

/**
 * Returns canonical dimensions for video format.
 * @param {'landscape'|'portrait'|'square'|'16:9'|'9:16'|'1:1'|'vertical'} format
 * @returns {[number, number]} [width, height]
 */
export function getCompositionDimensions(format) {
  const norm = String(format || '').toLowerCase();
  if (norm === 'portrait' || norm === '9:16' || norm === 'vertical') {
    return [1080, 1920];
  }
  if (norm === 'square' || norm === '1:1') {
    return [1080, 1080];
  }
  return [1920, 1080];
}

/**
 * Computes lower-third badge placement geometry according to Remotion filter specifications.
 * @param {number} width
 * @param {number} height
 */
export function getLowerThirdGeometry(width, height) {
  const isPortrait = height > width;
  const boxHeight = Math.max(70, Math.floor(height * 0.08));
  const boxY = height - boxHeight - Math.floor(height * 0.06);
  const boxWidth = Math.floor(width * (isPortrait ? 0.82 : 0.55));
  const boxX = Math.floor(width * (isPortrait ? 0.09 : 0.05));
  const accentWidth = isPortrait ? 8 : 6;
  const brandStripWidth = 12;

  return {
    isPortrait,
    boxX,
    boxY,
    boxWidth,
    boxHeight,
    accentWidth,
    brandStripWidth,
  };
}

/**
 * Evaluates the animated lower-third badge opacity and slide offset at timestamp t.
 * Enters at entryTime (default 1.0s) and exits at exitTime (default 7.0s) matching Remotion between(t,1,7).
 * @param {number} currentTime
 * @param {number} entryTime
 * @param {number} exitTime
 * @param {number} transitionDuration
 * @returns {{ visible: boolean, opacity: number, slideOffset: number }}
 */
export function getLowerThirdAnimation(currentTime, entryTime = 1.0, exitTime = 7.0, transitionDuration = 0.4) {
  if (currentTime < entryTime) {
    return { visible: false, opacity: 0, slideOffset: -30 };
  }
  if (currentTime >= entryTime && currentTime < entryTime + transitionDuration) {
    const progress = (currentTime - entryTime) / transitionDuration;
    const ease = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    return { visible: true, opacity: ease, slideOffset: -30 * (1 - ease) };
  }
  if (currentTime >= entryTime + transitionDuration && currentTime <= exitTime - transitionDuration) {
    return { visible: true, opacity: 1, slideOffset: 0 };
  }
  if (currentTime > exitTime - transitionDuration && currentTime <= exitTime) {
    const progress = (exitTime - currentTime) / transitionDuration;
    const ease = Math.pow(progress, 2);
    return { visible: true, opacity: ease, slideOffset: -20 * (1 - ease) };
  }
  return { visible: false, opacity: 0, slideOffset: -20 };
}

/**
 * Splits user script text into timed subtitle/caption segments for real-time live preview.
 * @param {string} rawScript
 * @param {number} durationSeconds
 * @returns {Array<{ text: string, startTime: number, endTime: number, words: string[] }>}
 */
export function computeCaptionSegments(rawScript, durationSeconds = 10) {
  const text = String(rawScript || '').trim();
  if (!text) {
    return [];
  }

  // Tokenize into natural spoken phrases
  const rawPhrases = text
    .split(/(?<=[.?!;,\n])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  // If a phrase is too long (> 8 words), break into smaller chunks
  const chunks = [];
  for (const phrase of rawPhrases) {
    const words = phrase.split(/\s+/).filter(Boolean);
    if (words.length <= 8) {
      chunks.push(phrase);
    } else {
      for (let i = 0; i < words.length; i += 6) {
        chunks.push(words.slice(i, i + 6).join(' '));
      }
    }
  }

  if (chunks.length === 0) return [];

  const totalWords = chunks.reduce((acc, c) => acc + c.split(/\s+/).length, 0);
  const effectiveDuration = Math.max(3, durationSeconds);
  const startOffset = 0.5; // slight speech start delay
  const availableTime = Math.max(2, effectiveDuration - startOffset - 0.5);

  let currentStart = startOffset;
  return chunks.map((chunk, index) => {
    const words = chunk.split(/\s+/).filter(Boolean);
    const fraction = totalWords > 0 ? words.length / totalWords : 1 / chunks.length;
    const segmentDuration = Math.max(1.0, fraction * availableTime);
    const startTime = currentStart;
    const endTime = Math.min(effectiveDuration, currentStart + segmentDuration);
    currentStart = endTime;
    return {
      text: chunk,
      startTime: Number(startTime.toFixed(2)),
      endTime: Number(endTime.toFixed(2)),
      words,
    };
  });
}

/**
 * Estimates video duration based on script words (average 135 words per minute).
 * @param {string} script
 * @returns {number} estimated duration in seconds (clamped between 6s and 60s)
 */
export function estimateScriptDuration(script) {
  const words = String(script || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 10;
  // ~2.25 words per second
  const rawSeconds = Math.round(words.length / 2.25);
  return Math.max(6, Math.min(60, rawSeconds));
}
