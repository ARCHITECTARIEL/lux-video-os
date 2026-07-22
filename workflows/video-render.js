import { FatalError, sleep } from 'workflow';
import { finalizeReadyJob, getJob, markJobFailedAndRelease, transitionJob } from '../db/repositories.js';
import { featureEnabled } from '../lib/video-os-security.js';
import { resolveFeaturedProviderSelections } from '../lib/video-os-featured-cast.js';
import { classifyFailure } from '../lib/video-os-operations.js';
import { captureJobError } from '../lib/video-os-observability.js';
import { pollHeygen, submitHeygen } from '../services/heygen.js';
import { finishMedia } from '../services/media-finisher.js';

async function submitProvider(jobId) {
  'use step';
  const job = await getJob(jobId);
  if (!job) throw new FatalError('Video job not found.');
  if (job.providerJobId) return { providerJobId: job.providerJobId };
  if (job.status === 'provider_submitting' || job.status === 'provider_submit_unknown') throw Object.assign(new FatalError('Provider submission requires reconciliation.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  try {
    await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started' });
    const submitted = await submitHeygen({ ...job, input: resolveFeaturedProviderSelections(job.input) });
    await transitionJob({ jobId, stageTo: 'provider_submitted', eventType: 'provider.submitted', providerJobId: submitted.providerJobId });
    return submitted;
  } catch (error) {
    captureJobError(error, { jobId, accountId: job.accountId, correlationId: job.correlationId, stage: 'provider_submit', failureCategory: classifyFailure(error, 'PROVIDER_SUBMIT') });
    await transitionJob({ jobId, stageTo: 'provider_submit_unknown', eventType: 'provider.submit_unknown', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
    throw Object.assign(new FatalError('Provider submission outcome is uncertain; automatic resubmission is blocked to prevent duplicate charges.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  }
}

async function pollProvider(jobId, providerJobId) {
  'use step';
  const job = await getJob(jobId);
  if (!job) throw new FatalError('Video job not found.');
  const status = await pollHeygen(providerJobId);
  if (['provider_ready', 'finishing'].includes(job.status) && status.ready) return status;
  if (['provider_ready', 'finishing'].includes(job.status)) throw Object.assign(new FatalError('Provider state regressed after media became ready.'), { failureCategory: 'RECONCILIATION' });
  if (!status.ready) await transitionJob({ jobId, stageTo: 'provider_rendering', eventType: 'provider.polled', details: { providerStatus: status.status } });
  else await transitionJob({ jobId, stageTo: 'provider_ready', eventType: 'provider.ready' });
  return status;
}

async function finishProviderMedia(jobId, sourceUrl) {
  'use step';
  const job = await getJob(jobId);
  if (!job) throw new FatalError('Video job not found.');
  if (!featureEnabled('VIDEO_OS_HOSTED_FINISHING_ENABLED')) {
    await transitionJob({ jobId, stageTo: 'finish_contained', eventType: 'finish.contained', details: { reason: 'hosted_finishing_disabled' } });
    return { contained: true };
  }
  if (job.status === 'ready') return job.output;
  if (job.status === 'provider_ready') await transitionJob({ jobId, stageTo: 'finishing', eventType: 'finish.started' });
  else if (job.status !== 'finishing') throw Object.assign(new FatalError(`Finishing cannot resume from ${job.status}.`), { failureCategory: 'RECONCILIATION' });
  const artifact = await finishMedia(job, sourceUrl);
  await finalizeReadyJob(jobId, artifact);
  return artifact;
}

async function failWorkflow(jobId, error) {
  'use step';
  const category = classifyFailure(error, 'INTERNAL');
  if (category === 'PROVIDER_SUBMIT_UNKNOWN') return;
  await markJobFailedAndRelease(jobId, category, String(error?.message || 'Workflow failed.').slice(0, 300));
}

export async function videoRenderWorkflow(jobId) {
  'use workflow';
  try {
    const { providerJobId } = await submitProvider(jobId);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await pollProvider(jobId, providerJobId);
      if (status.ready) return await finishProviderMedia(jobId, status.sourceUrl);
      await sleep('15s');
    }
    throw Object.assign(new Error('Provider render exceeded the 30 minute workflow deadline.'), { failureCategory: 'PROVIDER_TIMEOUT' });
  } catch (error) {
    await failWorkflow(jobId, error);
    throw error;
  }
}
