import { jobDto } from '../../db/dto.js';
import { getOwnedJob } from '../../db/repositories.js';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { finishRequestSchema, parseOrThrow } from '../../lib/video-os-validation.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST to check a render.' });
  try {
    const session = sessionFromRequest(req);
    const { jobId } = parseOrThrow(finishRequestSchema, await readJson(req, 20_000));
    const job = await getOwnedJob(session.accountId, jobId);
    if (!job) return send(res, 404, { ok: false, error: 'Render not found.' });
    const dto = jobDto(job);
    return send(res, job.status === 'ready' ? 200 : 202, { ok: true, ready: job.status === 'ready', ...dto });
  } catch (error) { return send(res, error.statusCode || 400, { ok: false, error: error.message || 'Render status failed.' }); }
}
