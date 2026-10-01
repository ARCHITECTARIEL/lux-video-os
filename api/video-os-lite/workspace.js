import admin from '../../routes/video-os-lite/admin.js';
import asset from '../../routes/video-os-lite/asset.js';
import copywriter from '../../routes/video-os-lite/copywriter.js';
import identities from '../../routes/video-os-lite/identities.js';
import projects from '../../routes/video-os-lite/projects.js';
import providers from '../../routes/video-os-lite/providers.js';
import results from '../../routes/video-os-lite/results-v2.js';
import standard from '../../routes/video-os-lite/standard.js';
import enrollments from '../../routes/video-os-lite/enrollments.js';
import enrollmentUpload from '../../routes/video-os-lite/enrollment-upload.js';
import scriptedPhoto from '../../routes/video-os-lite/scripted-photo.js';
import { send } from '../../lib/video-os-account.js';

const handlers = { admin, asset, copywriter, identities, projects, providers, results, standard, enrollments, 'enrollment-upload': enrollmentUpload, 'scripted-photo': scriptedPhoto };

export default async function handler(req, res) {
  const pathname = new URL(req.url, 'https://video-os.invalid').pathname;
  const route = pathname.split('/').filter(Boolean).pop();
  const selected = handlers[route];
  if (!selected) return send(res, 404, { ok: false, error: 'Workspace route not found.' });
  return selected(req, res);
}
