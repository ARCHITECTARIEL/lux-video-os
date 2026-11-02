// Themes, kinetic captions, subtitle sidecars, the mandatory AI disclosure
// label, the corner bug and the logo end card for the local Luxify pipeline.
// Pure filter/text builders (no I/O) so they can be tested without ffmpeg.
// Spec: SPEC-THEME-CAPTIONS-1102 (defaults for open decisions D1-D11 are
// listed in docs/LUX-ASSETS.md).
import { AI_DISCLOSURE_TEXT } from '../lib/luxify-local-brief.js';

// Colour tokens (spec section 2.1). Dark keeps today's look for titles.
export const THEME_TOKENS = Object.freeze({
  dark: Object.freeze({ text: 'white', textSecondary: 'white@0.85', stroke: 'black@0.6', shadow: 'black@0.5', plate: 'black@0.6', titlePlate: 'black@0.45', lowerPlate: 'black@0.5', endBg: '0x09113E', ctaBg: 'white', ctaText: '0x10195E' }),
  light: Object.freeze({ text: '0x111111', textSecondary: '0x111111@0.8', stroke: 'white@0.7', shadow: 'black@0.15', plate: 'white@0.85', titlePlate: 'white@0.85', lowerPlate: 'white@0.85', endBg: 'white', ctaBg: '0x1A2B9E', ctaText: 'white' }),
});

export function themeTokens(theme = 'dark') {
  // QA L5: own keys only ('__proto__', 'constructor' are not themes).
  const tokens = typeof theme === 'string' && Object.hasOwn(THEME_TOKENS, theme) ? THEME_TOKENS[theme] : null;
  if (!tokens) throw Object.assign(new Error(`Unknown theme ${theme}`), { code: 'THEME_INVALID' });
  return tokens;
}

const n = v => +Number(v).toFixed(3);

// Layout fractions per aspect (spec section 3). Disclosure is priority 1, bottom-left.
// The label plate is drawtext box=1 (QA M2), so it sizes itself to the text;
// `pad` is its boxborderw. Subtitles are bottom-anchored just above the plate
// so the two never overlap (QA L4).
export function layout(width, height) {
  const portrait = height > width;
  const u = Math.min(width, height);
  const size = Math.max(18, Math.round(u * 0.026));
  const pad = Math.round(size * 0.4);
  const disclosure = { x: portrait ? 0.06 : 0.05, y: portrait ? 0.83 : 0.93, size, pad };
  const subtitleSize = Math.round(u * 0.05);
  return {
    u,
    kineticY: portrait ? 0.58 : 0.62,
    // Bottom edge (px) every subtitle plate must stay above.
    subtitleBottom: Math.round(height * disclosure.y) - pad - Math.round(size * 0.6),
    disclosure,
    bug: { h: Math.round(height * (portrait ? 0.045 : 0.08)), x: portrait ? 0.06 : 0.05, y: portrait ? 0.10 : 0.05 },
    kineticSize: Math.round(u * (portrait ? 0.11 : 0.09)),
    subtitleSize,
  };
}

// QA L4: kinetic lines shrink to fit 90% of the frame width. Bold sans glyphs
// average under 0.62 em, so this bound keeps 40-char lines inside 9:16.
export const KINETIC_EM_WIDTH = 0.62;
export function kineticFontSize(textValue, width, height) {
  const L = layout(width, height);
  const fit = Math.floor((width * 0.9) / (Math.max(1, [...textValue].length) * KINETIC_EM_WIDTH));
  return Math.max(16, Math.min(L.kineticSize, fit));
}

export function subtitleBox(textValue, width, height) {
  const L = layout(width, height);
  const lines = textValue.split('\n').length;
  const h = Math.round(L.subtitleSize * (lines * 1.3 + 0.5));
  return { x: Math.round(width * 0.08), y: L.subtitleBottom - h, w: Math.round(width * 0.84), h };
}

// Kinetic "pop": 180 ms fade/scale-in, 120 ms fade-out, timed to the brief's
// beats (D5). drawtext reads text from files with expansion=none.
export function kineticFilters(captions, { font, width, height, theme, textFile, esc }) {
  const t = themeTokens(theme);
  const L = layout(width, height);
  return captions.map((c, i) => {
    const s = n(c.start), e = n(c.end);
    const alpha = `if(lt(t,${s}),0,if(lt(t,${n(s + 0.18)}),(t-${s})/0.18,if(gt(t,${n(e - 0.12)}),max(0,(${e}-t)/0.12),1)))`;
    const rise = `if(lt(t,${n(s + 0.18)}),${Math.round(L.u * 0.02)}*(1-(t-${s})/0.18),0)`;
    const size = kineticFontSize(c.text, width, height);
    return `drawtext=fontfile=${esc(font)}:expansion=none:textfile=${esc(textFile(i))}:fontcolor=${t.text}:fontsize=${size}:borderw=${Math.max(2, Math.round(size * 0.06))}:bordercolor=${t.stroke}:shadowx=0:shadowy=${Math.round(size * 0.04)}:shadowcolor=${t.shadow}:alpha='${alpha}':x=(w-text_w)/2:y='h*${L.kineticY}+${rise}':enable='between(t,${s},${e})'`;
  });
}

// Burned-in subtitles (captionStyle subtitle|both) on a plate in the subtitle zone.
export function subtitleFilters(cues, { font, width, height, theme, textFile, esc }) {
  const t = themeTokens(theme);
  const L = layout(width, height);
  return cues.flatMap((c, i) => {
    const enable = `enable='between(t,${n(c.start)},${n(c.end)})'`;
    const b = subtitleBox(c.text, width, height);
    return [`drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${t.plate}:t=fill:${enable}`,
      `drawtext=fontfile=${esc(font)}:expansion=none:textfile=${esc(textFile(i))}:fontcolor=${t.text}:fontsize=${L.subtitleSize}:line_spacing=${Math.round(L.subtitleSize * 0.25)}:x=(w-text_w)/2:y=${b.y + Math.round(L.subtitleSize * 0.25)}:${enable}`];
  });
}

// Mandatory label: full duration (end card included), own plate, never hidden.
export function disclosureFilters({ font, width, height, theme, textFile, esc }) {
  const t = themeTokens(theme);
  const L = layout(width, height);
  const { size, pad } = L.disclosure;
  const x = Math.round(width * L.disclosure.x), y = Math.round(height * L.disclosure.y);
  // QA M2: box=1 makes ffmpeg size the plate to the rendered text (+pad on every side).
  return [`drawtext=fontfile=${esc(font)}:expansion=none:textfile=${esc(textFile)}:fontcolor=${t.text}:fontsize=${size}:box=1:boxcolor=${t.plate}:boxborderw=${pad}:x=${x}:y=${y}`];
}

// Upper bound of the label plate (text width bounded at 0.7 em/char) for layout checks.
export function disclosureBox(width, height) {
  const L = layout(width, height);
  const { size, pad } = L.disclosure;
  const x = Math.round(width * L.disclosure.x), y = Math.round(height * L.disclosure.y);
  return { x: x - pad, y: y - pad, w: Math.round(size * 0.7 * AI_DISCLOSURE_TEXT.length) + pad * 2, h: Math.round(size * 1.25) + pad * 2 };
}

// Corner bug: top-right (disclosure is bottom-left), hidden during the end card.
export function bugFilter({ logoLabel, videoLabel, outLabel, width, height, opacity, until }) {
  const L = layout(width, height);
  return `${logoLabel}scale=-1:${L.bug.h},format=rgba,colorchannelmixer=aa=${opacity}[bugimg];${videoLabel}[bugimg]overlay=W-w-${Math.round(width * L.bug.x)}:${Math.round(height * L.bug.y)}:shortest=1:enable='lt(t,${n(until)})'${outLabel}`;
}

// End card (D2: appended). Logo centred at y 0.40 when present; CTA pill and URL.
export function endCardGraph({ width, height, duration, theme, logoLabel, ctaFile, urlFile, font, esc, outLabel }) {
  const t = themeTokens(theme);
  const L = layout(width, height);
  const parts = [`color=c=${t.endBg}:s=${width}x${height}:r=30:d=${duration},format=yuv420p,setsar=1[ecbg]`];
  let cur = '[ecbg]';
  if (logoLabel) {
    const lw = Math.round(width * (height > width ? 0.55 : 0.30));
    parts.push(`${logoLabel}scale=${lw}:-1,format=rgba[eclogo]`);
    parts.push(`${cur}[eclogo]overlay=(W-w)/2:H*0.40-h/2:shortest=1[ecl]`);
    cur = '[ecl]';
  }
  const ctaSize = Math.round(L.u * 0.06), urlSize = Math.round(L.u * 0.04);
  const draws = [];
  if (ctaFile) draws.push(`drawtext=fontfile=${esc(font)}:expansion=none:textfile=${esc(ctaFile)}:fontcolor=${t.ctaText}:fontsize=${ctaSize}:box=1:boxcolor=${t.ctaBg}:boxborderw=${Math.round(ctaSize * 0.6)}:x=(w-text_w)/2:y=h*0.60:alpha='min(1,max(0,(t-0.3)/0.3))'`);
  if (urlFile) draws.push(`drawtext=fontfile=${esc(font)}:expansion=none:textfile=${esc(urlFile)}:fontcolor=${t.textSecondary}:fontsize=${urlSize}:x=(w-text_w)/2:y=h*0.72`);
  parts.push(`${cur}${draws.length ? draws.join(',') : 'null'},format=yuv420p${outLabel}`);
  return parts.join(';');
}

// ---- Subtitle sidecars ----------------------------------------------------
// Full verbatim script, split into sentences and timed proportionally to
// character count over the voice duration (D5 default: approxTiming, no aligner).
export function wrapCue(textValue, maxChars) {
  const words = textValue.split(/\s+/).filter(Boolean);
  const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (cur && (cur + ' ' + w).length > maxChars) lines.push(w); else lines[lines.length - 1] = cur ? `${cur} ${w}` : w;
  }
  return lines;
}

export function buildCues(script, voiceSeconds, { maxChars = 42, maxLines = 2 } = {}) {
  const flat = script.replace(/\s+/g, ' ').trim();
  const sentences = flat.match(/[^.!?]+(?:[.!?]+|$)/g)?.map(s => s.trim()).filter(Boolean) || [flat];
  const pieces = [];
  for (const s of sentences) {
    const lines = wrapCue(s, maxChars);
    for (let i = 0; i < lines.length; i += maxLines) pieces.push(lines.slice(i, i + maxLines).join('\n'));
  }
  const weight = pieces.reduce((a, p) => a + p.length, 0) || 1;
  let t = 0;
  return pieces.map(p => {
    const d = voiceSeconds * p.length / weight;
    const cue = { start: n(t), end: n(t + d), text: p };
    t += d;
    return cue;
  });
}

const stamp = (sec, sep) => {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
};
// QA B1: cue text is plain text in both formats. Every angle bracket is
// dropped (no tags of any kind survive) and every run of two or more hyphens
// becomes one en dash, so no cue-timing arrow or comment marker can form.
// Ampersands are escaped for VTT; blank lines (which end a cue) are removed.
// Tag-shaped spans (`<...>`) are removed whole by a character scan, then any
// stray bracket is dropped, so the output can never contain `<` or `>`.
function stripTags(value) {
  let out = '', pending = null;
  for (const ch of value) {
    if (ch === '<') { if (pending !== null) out += pending; pending = ''; continue; }
    if (ch === '>') { pending = null; continue; }
    if (pending !== null) pending += ch; else out += ch;
  }
  return pending !== null ? out + pending : out;
}

export function sanitizeCueText(value) {
  return stripTags(String(value).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/[\uFF1C\u2039]/g, '<').replace(/[\uFF1E\u203A]/g, '>'))
    .replace(/[<>]/g, '')
    .replace(/-{2,}/g, '\u2013')
    .split('\n').map(line => line.replace(/ {2,}/g, ' ').trim()).filter(Boolean).join('\n');
}
const vttText = value => sanitizeCueText(value).replace(/&/g, '&amp;');

export function toVtt(cues) {
  return `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${stamp(c.start, '.')} --> ${stamp(c.end, '.')} line:82%\n${vttText(c.text)}\n`).join('\n')}`;
}

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${sanitizeCueText(c.text)}\n`).join('\n');
}

// Reads a PCM WAV duration from its header (null if not a WAV).
export function wavDurationSeconds(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12, byteRate = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data' && byteRate) return n(Math.min(size, buf.length - off - 8) / byteRate);
    off += 8 + size + (size % 2);
  }
  return null;
}

export function kineticWarnings(captions) {
  return captions.filter(c => c.text.trim().split(/\s+/).length > 3).map(c => `KINETIC_LONG_BEAT: "${c.text}" has more than 3 words`);
}

// Advisory: a kinetic line that had to shrink a lot to fit the frame.
export function kineticFitWarnings(captions, width, height) {
  const full = layout(width, height).kineticSize;
  return captions.filter(c => kineticFontSize(c.text, width, height) < full * 0.6).map(c => `KINETIC_SHRUNK: "${c.text}" was shrunk to fit the frame width`);
}
