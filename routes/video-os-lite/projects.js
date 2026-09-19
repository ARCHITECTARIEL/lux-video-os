// Routed through the consolidated workspace function to stay within the Vercel function limit.
import { ensureAccount, listProjects, saveProject, saveStandardProject } from '../../db/repositories.js';
import { projectDto } from '../../db/dto.js';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { parseOrThrow, projectRequestSchema, standardProjectRequestSchema } from '../../lib/video-os-validation.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  try {
    const session = sessionFromRequest(req);
    if (req.method === 'GET') return send(res, 200, { ok: true, projects: (await listProjects(session.accountId)).map(projectDto) });
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use GET or POST for projects.' });
    const body = await readJson(req);
    if (body?.tier === 'STANDARD') {
      const payload = parseOrThrow(standardProjectRequestSchema, body, 'Standard project validation failed.');
      await ensureAccount({
        accountId: session.accountId,
        email: session.email,
        name: session.email || 'Video OS Account',
        initialCredits: Number(process.env.VIDEO_OS_TRIAL_CREDITS || 0),
      });
      const project = await saveStandardProject({
        accountId: session.accountId,
        title: payload.title,
        identityId: payload.identityId,
        narrationAudioAssetId: payload.narrationAudioAssetId,
      });
      return send(res, 201, { ok: true, project: projectDto(project) });
    }
    const payload = parseOrThrow(projectRequestSchema, body, 'Project validation failed.');
    if (!payload.id) {
      await ensureAccount({
        accountId: session.accountId,
        email: session.email,
        name: session.email || 'Video OS Account',
        initialCredits: Number(process.env.VIDEO_OS_TRIAL_CREDITS || 0),
      });
    }
    const project = await saveProject({ ...payload, accountId: session.accountId });
    return send(res, payload.id ? 200 : 201, { ok: true, project: projectDto(project) });
  } catch (error) {
    return send(res, error.statusCode || 400, { ok: false, error: error.message || 'Project request failed.', issues: error.issues });
  }
}
