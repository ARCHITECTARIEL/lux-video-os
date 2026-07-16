import * as Sentry from '@sentry/node';
import { accountHash } from './video-os-security.js';

let initialized = false;

export function sanitizeSentryEvent(event) {
  if (!event?.request) return event;
  delete event.request.cookies;
  delete event.request.data;
  for (const key of Object.keys(event.request.headers || {})) {
    if (['authorization', 'cookie', 'set-cookie', 'x-vercel-protection-bypass'].includes(key.toLowerCase())) delete event.request.headers[key];
  }
  if (event.request.url) event.request.url = event.request.url.split('?')[0];
  return event;
}

function tracesSampleRate() {
  const configured = Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1);
  return Number.isFinite(configured) && configured >= 0 && configured <= 1 ? configured : 0.1;
}

export function initObservability() {
  if (initialized || !process.env.SENTRY_DSN) return Boolean(process.env.SENTRY_DSN);
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID,
    tracesSampleRate: tracesSampleRate(),
    sendDefaultPii: false,
    beforeSend: sanitizeSentryEvent,
  });
  initialized = true;
  return true;
}

export function captureRouteError(error, context = {}) {
  if (Number(error?.statusCode || 500) < 500) return;
  captureJobError(error, context);
}

export function captureJobError(error, context = {}) {
  if (!initObservability()) return;
  Sentry.withScope((scope) => {
    if (context.correlationId) scope.setTag('correlation_id', context.correlationId);
    if (context.jobId) scope.setTag('job_id', context.jobId);
    if (context.providerJobId) scope.setTag('provider_job_id', context.providerJobId);
    if (context.accountId) scope.setTag('account_hash', accountHash(context.accountId));
    if (context.failureCategory) scope.setTag('failure_category', context.failureCategory);
    scope.setContext('video_os', { stage: context.stage, route: context.route, attempt: context.attempt });
    Sentry.captureException(error);
  });
}
