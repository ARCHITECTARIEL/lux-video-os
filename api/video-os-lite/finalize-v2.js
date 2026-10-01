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
    if (job.status === 'failed' || job.status === 'cancelled') return send(res, 409, { ok: false, code: `render_${job.status}`, error: dto.message, ...dto });
    if (job.status === 'finish_contained') return send(res, 409, { ok: false, code: 'hosted_finishing_disabled', error: 'Provider render is complete, but hosted finishing remains disabled.', ...dto });
    if (job.videoDeletedAt) return send(res, 410, { ok: false, ready: false, code: 'output_unavailable', ...dto });
    return send(res, dto.outputAccepted ? 200 : 202, { ok: true, ready: dto.outputAccepted, ...dto });
  } catch (error) { return send(res, error.statusCode || 400, { ok: false, error: error.message || 'Render status failed.' }); }
}
