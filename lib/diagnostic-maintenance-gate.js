const FLAG = 'VIDEO_OS_DIAGNOSTIC_MAINTENANCE';
const DIAGNOSTIC_REQUEST_URL = '/api/video-os-lite/admin?operation=db-binding';

export function diagnosticMaintenanceMode(env = process.env) {
  if (!Object.hasOwn(env, FLAG)) return 'off';
  if (env[FLAG] === 'false') return 'off';
  if (env[FLAG] === 'true') return 'active';
  return 'invalid';
}

export function blockForDiagnosticMaintenance(req, res, { allowDiagnostic = false, env = process.env } = {}) {
  const mode = diagnosticMaintenanceMode(env);
  if (mode === 'off') return false;
  if (mode === 'active' && allowDiagnostic && req?.method === 'GET' && req?.url === DIAGNOSTIC_REQUEST_URL) return false;

  res.statusCode = 503;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Retry-After', '60');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify({ ok: false, code: mode === 'invalid' ? 'maintenance_configuration_invalid' : 'diagnostic_maintenance_active' }));
  return true;
}
