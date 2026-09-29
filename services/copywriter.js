import { generateText } from 'ai';

// A real, confirmed-current AI Gateway model id (verified against Vercel AI
// SDK docs at the time this was built) -- override via
// VIDEO_OS_COPYWRITER_MODEL without a code change if pricing/quality needs
// to move to a different tier later.
export const DEFAULT_COPYWRITER_MODEL = 'anthropic/claude-sonnet-4.6';

function systemPrompt() {
  return [
    'You are an on-camera video script copywriter for LUX Video OS, a tool that lets small businesses create short avatar-presented videos.',
    'Write plain spoken text only: no markdown, no headings, no bullet characters, no stage directions, no surrounding quotation marks.',
    'Keep the result under 900 characters and natural to read aloud in one take.',
  ].join(' ');
}

function briefSummary(brief) {
  const lines = [
    `Topic: ${brief.topic}`,
    `Audience: ${brief.audience}`,
    `Goal: ${brief.goal}`,
    `Tone: ${brief.tone}`,
  ];
  if (brief.keyPoints) lines.push(`Key points:\n${brief.keyPoints}`);
  if (brief.callToAction) lines.push(`Call to action: ${brief.callToAction}`);
  return lines.join('\n');
}

function promptFor({ operation, brief, draft, instructions }) {
  const base = briefSummary(brief);
  if (operation === 'draft') return `${base}\n\nWrite a first-draft video script for this brief.`;
  if (operation === 'shorten') return `${base}\n\nShorten the following working draft to roughly two-thirds of its length, keeping its meaning and call to action intact:\n\n${draft}`;
  if (operation === 'improve_hook') return `${base}\n\nRewrite only the opening one or two sentences of the following working draft into a stronger hook. Keep the rest of the draft unchanged:\n\n${draft}`;
  return `${base}\n\nRevise the following working draft according to this instruction: "${instructions}"\n\nWorking draft:\n${draft}`;
}

export async function generateCopy({ operation, brief, draft, instructions }, {
  model = String(process.env.VIDEO_OS_COPYWRITER_MODEL || '').trim() || DEFAULT_COPYWRITER_MODEL,
  timeoutMs = 28_000,
  // Injectable for tests only -- every real caller leaves this at the
  // default, so this is a no-op change for production. Lets
  // tests/copywriter-service.test.mjs exercise the real timeout/
  // content-filter/empty-output/error-mapping logic below directly,
  // without hitting a real paid AI Gateway call or faking its wire format.
  generateTextFn = generateText,
} = {}) {
  let result;
  try {
    result = await generateTextFn({
      model,
      system: systemPrompt(),
      prompt: promptFor({ operation, brief, draft, instructions }),
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw Object.assign(new Error('The AI writing request timed out.'), { statusCode: 504, code: 'generation_timeout' });
    }
    throw Object.assign(new Error('The AI writing request failed.'), { statusCode: 502, code: 'generation_failed', cause: error });
  }
  if (result.finishReason === 'content-filter') {
    throw Object.assign(new Error('The AI declined this request.'), { statusCode: 422, code: 'generation_refused' });
  }
  const text = String(result.text || '').trim().slice(0, 900);
  if (!text) throw Object.assign(new Error('The AI declined this request.'), { statusCode: 422, code: 'generation_refused' });
  return text;
}
