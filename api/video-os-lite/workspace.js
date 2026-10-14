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
import providerConsent from '../../routes/video-os-lite/provider-consent.js';
import luxify from '../../routes/video-os-lite/luxify.js';
import { send, sessionFromRequest } from '../../lib/video-os-account.js';
import { blockForDiagnosticMaintenance } from '../../lib/diagnostic-maintenance-gate.js';

const handlers = { admin, asset, copywriter, identities, projects, providers, results, standard, enrollments, luxify, 'enrollment-upload': enrollmentUpload, 'scripted-photo': scriptedPhoto, 'provider-consent': providerConsent };

export default async function handler(req, res) {
  if (blockForDiagnosticMaintenance(req, res, { allowDiagnostic: true })) return;
  const pathname = new URL(req.url, 'https://video-os.invalid').pathname;
  const route = pathname.split('/').filter(Boolean).pop();
  const selected = handlers[route];
  if (!selected) {
    if (route === 'workspace') {
      let session;
      try {
        session = sessionFromRequest(req);
      } catch {
        // Missing or invalid sessions use the same unauthenticated response.
      }
      if (!session) return send(res, 401, { ok: false, code: 'sign_in_required', error: 'Sign in required.' });
    }
    return send(res, 404, { ok: false, error: 'Workspace route not found.' });
  }
  return selected(req, res);
}
