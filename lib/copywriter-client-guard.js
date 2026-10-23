const invisible = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
const lookalikes = { а: 'a', в: 'b', с: 'c', е: 'e', н: 'h', і: 'i', к: 'k', м: 'm', о: 'o', р: 'p', т: 't', у: 'y', х: 'x', Α: 'a', Β: 'b', Ε: 'e', Η: 'h', Ι: 'i', Κ: 'k', Μ: 'm', Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't', Χ: 'x', Υ: 'y', α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ο: 'o', ρ: 'p', τ: 't', χ: 'x' };

export function sanitizeCopywriterInput(value) {
  return String(value ?? '').replace(invisible, '').replace(/[<>]/g, character => character === '<' ? '&lt;' : '&gt;');
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').replace(invisible, '').toLowerCase().replace(/[а-яіα-ω]/g, character => lookalikes[character] || character).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function blockedClientTerms(env = process.env) {
  const raw = String(env.VIDEO_OS_COPYWRITER_BLOCKED_TERMS || '').trim();
  if (!raw) return [];
  let values;
  if (raw.startsWith('[')) {
    try { values = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) return [];
  } else values = raw.split(/[\n,]/);
  return [...new Set(values.map(normalize).filter(Boolean))];
}

export function namesBlockedClient(value, terms) {
  const normalized = ` ${normalize(value)} `;
  for (const term of terms) {
    const words = term.split(' ');
    const compact = words.join('');
    // A compact name may occur as a domain label, but never as a prefix of a longer word.
    for (const candidate of new Set([term, compact])) {
      let offset = normalized.indexOf(candidate);
      while (offset !== -1) {
        const before = normalized[offset - 1];
        const after = normalized[offset + candidate.length];
        if (before === ' ' && (after === ' ' || (after === 's' && normalized[offset + candidate.length + 1] === ' '))) return true;
        offset = normalized.indexOf(candidate, offset + 1);
      }
    }
  }
  return false;
}
