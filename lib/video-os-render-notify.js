// Shared by both render workflows (Premium/HeyGen and Standard/SadTalker) so
// "your video is ready" fires from one place for either tier. Best-effort:
// a broken email provider must never fail an already-finished render, so
// every failure here is captured for observability and swallowed, not thrown.
import { getAccount } from '../db/repositories.js';
import { publicOrigin } from './video-os-security.js';
import { captureJobError } from './video-os-observability.js';
import { sendRenderReadyEmail } from './video-os-notifications.js';
import { acceptedJobOutput } from './video-os-output-acceptance.js';

export async function notifyRenderReady(job, finalizedJob) {
  if (!finalizedJob?.justCompleted || finalizedJob.videoDeletedAt || !acceptedJobOutput(finalizedJob)) return;
  try {
    const account = await getAccount(job.accountId);
    if (!account?.user?.email) return;
    await sendRenderReadyEmail({ email: account.user.email, jobTitle: job.title, appUrl: publicOrigin() });
  } catch (error) {
    captureJobError(error, { jobId: job.id, accountId: job.accountId, correlationId: job.correlationId, stage: 'render_ready_notification' });
  }
}
