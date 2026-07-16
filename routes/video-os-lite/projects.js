// Routed through the consolidated workspace function to stay within the Vercel function limit.
import { listProjects, saveProject } from '../../db/repositories.js';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { parseOrThrow, projectRequestSchema } from '../../lib/video-os-validation.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  try {
    const session = sessionFromRequest(req);
    if (req.method === 'GET') return send(res, 200, { ok: true, projects: await listProjects(session.accountId) });
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use GET or POST for projects.' });
    const payload = parseOrThrow(projectRequestSchema, await readJson(req), 'Project validation failed.');
    const project = await saveProject({ ...payload, accountId: session.accountId });
    return send(res, payload.id ? 200 : 201, { ok: true, project });
  } catch (error) {
    return send(res, error.statusCode || 400, { ok: false, error: error.message || 'Project request failed.', issues: error.issues });
  }
}
