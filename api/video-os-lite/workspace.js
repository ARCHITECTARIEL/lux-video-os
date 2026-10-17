import admin, { adminActorType } from '../../routes/video-os-lite/admin.js';
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
import { deferAdminResponse } from '../../lib/admin-request-audit.js';
import health from '../../lib/health.js';
import notFound from '../../lib/api-not-found.js';

const handlers = { admin, asset, copywriter, identities, projects, providers, results, standard, enrollments, luxify, 'enrollment-upload': enrollmentUpload, 'scripted-photo': scriptedPhoto, 'provider-consent': providerConsent, 'watchdog-cron': admin };

export default async function handler(req, res) {
  const pathname = String(req.url || '').split('?', 1)[0];
  if (pathname === '/api/health') {
    if (blockForDiagnosticMaintenance(req, res, { allowDiagnostic: true })) return;
    return health(req, res);
  }
  if (!pathname.startsWith('/api/video-os-lite/')) return notFound(req, res);
  const route = pathname.slice('/api/video-os-lite/'.length);
  if (!route || route.includes('/')) return send(res, 404, { ok: false, code: 'not_found', error: 'Workspace route not found.' });
  const selected = Object.hasOwn(handlers, route) ? handlers[route] : undefined;
  if (!selected && route !== 'workspace') return send(res, 404, { ok: false, code: 'not_found', error: 'Workspace route not found.' });
  if (selected === admin) {
    const operation = route === 'watchdog-cron' ? 'watchdog-sweep' : new URL(req.url, 'https://video-os.invalid').searchParams.get('operation') || 'jobs';
    const deferred = deferAdminResponse(req, res, {
      operation,
      actorType: () => adminActorType(req),
      env: process.env,
    });
    if (blockForDiagnosticMaintenance(req, res, { allowDiagnostic: true })) {
      await deferred.wait();
      return;
    }
    deferred.cancel();
    return selected(req, res);
  }
  if (blockForDiagnosticMaintenance(req, res, { allowDiagnostic: true })) return;
  if (route === 'workspace') {
    let session;
    try {
      session = sessionFromRequest(req);
    } catch {
      // Missing or invalid sessions use the same unauthenticated response.
    }
    if (!session) return send(res, 401, { ok: false, code: 'sign_in_required', error: 'Sign in required.' });
    return send(res, 404, { ok: false, code: 'not_found', error: 'Workspace route not found.' });
  }
  return selected(req, res);
}
