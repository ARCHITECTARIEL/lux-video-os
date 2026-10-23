import { generateText } from 'ai';

// A real, confirmed-current AI Gateway model id (verified against Vercel AI
// SDK docs at the time this was built) -- override via
// VIDEO_OS_COPYWRITER_MODEL without a code change if pricing/quality needs
// to move to a different tier later.
export const DEFAULT_COPYWRITER_MODEL = 'anthropic/claude-sonnet-4.6';

const safeField = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(value) && !/(?:key|token|secret|bearer|authorization|https?:|vck_|eyJ\.|(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,})/i.test(value) ? value : null;

export function sanitizeProviderMessage(message) {
  if (typeof message !== 'string') return null;
  // Provider prose is optional diagnostic data. Drop the whole message when it
  // contains a possible credential, contact, URL, or opaque user payload.
  if (/(?:key|token|secret|bearer|auth(?:orization)?|https?:|www\.|@|vck_|eyJ\.|[A-Za-z0-9+/_=-]{20,})/i.test(message)) return null;
  return message.slice(0, 200);
}

export function describeProviderError(error, { forbidden = [] } = {}) {
  const retryWrapped = error?.name === 'AI_RetryError' || Array.isArray(error?.errors);
  const attempts = retryWrapped && Array.isArray(error?.errors) ? error.errors.length : null;
  let detail = retryWrapped ? error?.lastError || error?.errors?.at(-1) || error : error;
  for (let i = 0; i < 3 && detail?.cause && !detail?.statusCode && !detail?.status && !/^Gateway.*Error$|^(?:Abort|Timeout)Error$/.test(detail?.name || ''); i++) detail = detail.cause;
  const safe = value => {
    const candidate = safeField(value);
    if (!candidate || candidate.length < 8) return candidate;
    return forbidden.some(value => String(value || '').includes(candidate)) ? null : candidate;
  };
  const rawMessage = detail?.message;
  let message = sanitizeProviderMessage(rawMessage);
  if (message && forbidden.some(value => {
    const source = String(value || '');
    for (let i = 0; i + 8 <= source.length; i++) {
      if (message.includes(source.slice(i, i + 8))) return true;
    }
    return false;
  })) message = null;
  return {
    errorName: safe(detail?.name),
    errorCode: safe(detail?.code),
    providerStatus: Number.isInteger(detail?.statusCode ?? detail?.status) ? (detail.statusCode ?? detail.status) : null,
    providerErrorType: safe(detail?.errorType ?? detail?.type),
    generationId: safe(detail?.generationId),
    retryWrapped,
    attempts,
    message,
  };
}

export function statusClass(detail) {
  const status = detail?.providerStatus;
  const type = detail?.providerErrorType;
  const name = detail?.errorName;
  if (status === 402 || ['insufficient_funds', 'quota_for_entity_exceeded', 'customer_verification_required'].includes(type)) return 'billing';
  if (status === 401) return 'auth';
  if (status === 404 || name === 'GatewayModelNotFoundError') return 'model';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limit';
  if (status === 408 || ['GatewayTimeoutError', 'AbortError', 'TimeoutError'].includes(name)) return 'timeout';
  if (status === 400) return 'invalid_request';
  return 'upstream';
}

export function gatewayAuthMode(env = process.env) {
  if (String(env.AI_GATEWAY_API_KEY || '').trim()) return 'api-key';
  if (String(env.VERCEL_OIDC_TOKEN || '').trim()) return 'oidc';
  return 'none';
}

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
  maxOutputTokens = Number(process.env.VIDEO_OS_COPYWRITER_MAX_OUTPUT_TOKENS) || 400,
  timeoutMs = 28_000,
  // Injectable for tests only -- every real caller leaves this at the
  // default, so this is a no-op change for production. Lets
  // tests/copywriter-service.test.mjs exercise the real timeout/
  // content-filter/empty-output/error-mapping logic below directly,
  // without hitting a real paid AI Gateway call or faking its wire format.
  generateTextFn = generateText,
} = {}) {
  let result;
  const system = systemPrompt();
  const prompt = promptFor({ operation, brief, draft, instructions });
  try {
    result = await generateTextFn({
      model,
      system,
      prompt,
      abortSignal: AbortSignal.timeout(timeoutMs),
      // Set to 0 only when a fallback model is added (P1 follow-up).
      maxRetries: 2,
      maxOutputTokens: Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : 400,
    });
  } catch (error) {
    const providerDetail = { ...describeProviderError(error, { forbidden: [prompt, system] }), model: safeField(model) };
    const category = statusClass(providerDetail);
    throw Object.assign(new Error('AI writing could not be completed.'), {
      statusCode: category === 'timeout' ? 504 : 502,
      code: category === 'timeout' ? 'generation_timeout' : 'copywriter_provider_error',
      statusClass: category,
      providerDetail,
    });
  }
  if (result.finishReason === 'content-filter') {
    throw Object.assign(new Error('The AI declined this request.'), { statusCode: 422, code: 'generation_refused' });
  }
  const text = String(result.text || '').trim().slice(0, 900);
  if (!text) throw Object.assign(new Error('The AI declined this request.'), { statusCode: 422, code: 'generation_refused' });
  return text;
}
