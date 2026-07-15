import * as Sentry from '@sentry/node';
import { accountHash } from './video-os-security.js';

let initialized = false;

export function initObservability() {
  if (initialized || !process.env.SENTRY_DSN) return Boolean(process.env.SENTRY_DSN);
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        if (event.request.url) event.request.url = event.request.url.split('?')[0];
      }
      return event;
    },
  });
  initialized = true;
  return true;
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
