import admin from '../../routes/video-os-lite/admin.js';
import asset from '../../routes/video-os-lite/asset.js';
import identities from '../../routes/video-os-lite/identities.js';
import projects from '../../routes/video-os-lite/projects.js';
import providers from '../../routes/video-os-lite/providers.js';
import results from '../../routes/video-os-lite/results-v2.js';
import standard from '../../routes/video-os-lite/standard.js';
import { send } from '../../lib/video-os-account.js';

const handlers = { admin, asset, identities, projects, providers, results, standard };

export default async function handler(req, res) {
  const pathname = new URL(req.url, 'https://video-os.invalid').pathname;
  const route = pathname.split('/').filter(Boolean).pop();
  const selected = handlers[route];
  if (!selected) return send(res, 404, { ok: false, error: 'Workspace route not found.' });
  return selected(req, res);
}
