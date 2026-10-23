const invisible = /[\p{Cf}\u00AD\u034F\u180E\u115F\u1160\u3164]/gu;
const lookalikes = {
  '\u0430': 'a', '\u0432': 'b', '\u0441': 'c', '\u0435': 'e', '\u043d': 'h', '\u0456': 'i', '\u043a': 'k', '\u043c': 'm', '\u043e': 'o', '\u0440': 'p', '\u0442': 't', '\u0443': 'y', '\u0445': 'x',
  '\u03b1': 'a', '\u03b2': 'b', '\u03b5': 'e', '\u03b9': 'i', '\u03ba': 'k', '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c7': 'x',
  '\u0251': 'a', '\u0455': 's', '\u0501': 'd', '\u04cf': 'l',
  '\u1d00': 'a', '\u0299': 'b', '\u1d04': 'c', '\u1d05': 'd', '\u1d07': 'e', '\u0493': 'f', '\u0262': 'g', '\u029c': 'h', '\u026a': 'i', '\u1d0a': 'j', '\u1d0b': 'k', '\u029f': 'l', '\u1d0d': 'm', '\u0274': 'n', '\u1d0f': 'o', '\u1d18': 'p', '\u0280': 'r', '\ua731': 's', '\u1d1b': 't', '\u1d1c': 'u', '\u1d20': 'v', '\u1d21': 'w', '\u028f': 'y', '\u1d22': 'z',
};
const leet = { '3': 'e', '4': 'a', '0': 'o', '5': 's', '7': 't', '@': 'a', '$': 's' };

export function sanitizeCopywriterInput(value) {
  return String(value ?? '').replace(invisible, '').replace(/&/g, '&amp;').replace(/[<>]/g, character => character === '<' ? '&lt;' : '&gt;');
}

function normalize(value, one = 'i') {
  return String(value ?? '').replace(invisible, '').normalize('NFKC').normalize('NFD')
    .replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[\p{L}\p{N}@$]/gu, character => character === '1' ? one : lookalikes[character] || leet[character] || character)
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function blockedClientTerms(env = process.env) {
  const raw = String(env.VIDEO_OS_COPYWRITER_BLOCKED_TERMS || '').trim();
  if (!raw) return [];
  let values;
  if (raw.startsWith('[')) {
    try { values = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) return [];
  } else values = raw.split(/[\n,]/);
  return [...new Set(values.map(value => normalize(value)).filter(Boolean))];
}

export function namesBlockedClient(value, terms) {
  for (const one of ['i', 'l']) {
    const normalized = ` ${normalize(value, one)} `;
    const compactText = normalized.replace(/[^\p{L}\p{N}]/gu, '');
    for (const rawTerm of terms) {
      const term = normalize(rawTerm, one);
      if (!term) continue;
      const compactTerm = term.replace(/[^\p{L}\p{N}]/gu, '');
      if (compactTerm.length >= 4 && compactText.includes(compactTerm)) return true;
      for (const candidate of new Set([term, compactTerm])) {
        let offset = normalized.indexOf(candidate);
        while (offset !== -1) {
          const before = normalized[offset - 1];
          const after = normalized[offset + candidate.length];
          if (before === ' ' && (after === ' ' || (after === 's' && normalized[offset + candidate.length + 1] === ' '))) return true;
          offset = normalized.indexOf(candidate, offset + 1);
        }
      }
    }
  }
  return false;
}
