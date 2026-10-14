import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MERGE_INTENT_PATTERN = /\b(DRAFT|WIP|do[- ]not[- ]merge)\b/i;

export function evaluateMergeIntent({ title, labels, isDraft }) {
  const reasons = [];

  if (isDraft === true || isDraft === 'true') {
    reasons.push('Pull request is marked as draft.');
  }
  if (MERGE_INTENT_PATTERN.test(title)) {
    reasons.push('Pull request title contains a draft or do-not-merge marker.');
  }
  if (labels.some((label) => MERGE_INTENT_PATTERN.test(label))) {
    reasons.push('Pull request label contains a draft or do-not-merge marker.');
  }

  return { ok: reasons.length === 0, reasons };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    const labels = JSON.parse(process.env.LABELS ?? '[]');
    if (!Array.isArray(labels) || !labels.every((label) => typeof label === 'string')) {
      throw new TypeError('LABELS must be a JSON array of names');
    }
    result = evaluateMergeIntent({
      title: process.env.TITLE ?? '',
      labels,
      isDraft: process.env.IS_DRAFT,
    });
  } catch {
    result = { ok: false, reasons: ['Invalid merge-intent guard input.'] };
  }

  if (result.ok) {
    console.log('OK');
  } else {
    for (const reason of result.reasons) console.error(`::error::${reason}`);
    process.exitCode = 1;
  }
}
