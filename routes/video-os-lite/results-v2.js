// Routed through the consolidated workspace function to stay within the Vercel function limit.
import { jobDto } from '../../db/dto.js';
import { listAccountJobs } from '../../db/repositories.js';
import { handleOptions, send, sessionFromRequest } from '../../lib/video-os-account.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET for results.' });
  try {
    const session = sessionFromRequest(req);
    return send(res, 200, { ok: true, accountId: session.accountId, results: (await listAccountJobs(session.accountId)).map(jobDto) });
  } catch (error) { return send(res, error.statusCode || 401, { ok: false, error: error.statusCode === 401 ? error.message : 'Results unavailable.', results: [] }); }
}
