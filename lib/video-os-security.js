import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export const featureEnabled = (name) => String(process.env[name] || '').trim().toLowerCase() === 'true';

export { isTesterAccountId, isTesterEmailDomain, registerTesterAccountId, revokeTesterAccountId, REGISTERED_TESTER_ACCOUNTS } from './video-os-testers.js';
import { isTesterAccountId, isTesterEmailDomain, registerTesterAccountId, revokeTesterAccountId, REGISTERED_TESTER_ACCOUNTS } from './video-os-testers.js';

// Shared by requireRenderAccountAuthorization (below, the hard backend gate)
// and any sign-in path that needs to know whether to also grant the
// liveRendering entitlement.
export function accountAllowedForContainedRendering(accountId, email) {
  if (isTesterAccountId(accountId)) return true;
  if (email && isTesterEmailDomain(email)) return true;
  const allowed = String(process.env.VIDEO_OS_RENDER_ACCOUNT_ID || '').split(',').map((id) => id.trim()).filter(Boolean);
  return allowed.some((id) => timingSafeMatch(accountId, id));
}

export function requireRenderAccountAuthorization(accountId, email) {
  if (isTesterAccountId(accountId)) return true;
  if (email && isTesterEmailDomain(email)) return true;
  const allowed = String(process.env.VIDEO_OS_RENDER_ACCOUNT_ID || '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!allowed.length && !REGISTERED_TESTER_ACCOUNTS.size) {
    throw Object.assign(new Error('Contained rendering account is not configured.'), { statusCode: 503, failureCategory: 'CONFIG_MISSING' });
  }
  if (!accountAllowedForContainedRendering(accountId, email)) {
    throw Object.assign(new Error('This account is not authorized for contained rendering.'), { statusCode: 403, failureCategory: 'ENTITLEMENT' });
  }
  return true;
}

export function standardRenderingEmailDomainAllowed(email) {
  const domains = String(process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS || '').split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean);
  if (!domains.length) return false;
  const normalized = String(email || '').trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at === -1) return false;
  return domains.includes(normalized.slice(at + 1));
}

// Shared by every authenticated sign-in path (Google, magic-link, workspace)
// so contained-rendering eligibility is re-derived fresh from the same two
// real signals every time, independent of *which* method a given sign-in
// happened to use.
export function containedRenderingEntitlementKeys(accountId, email) {
  if (isTesterEmailDomain(email) || isTesterAccountId(accountId)) {
    registerTesterAccountId(accountId);
    return ['liveRendering', 'standardRendering', 'tester'];
  }
  if (accountAllowedForContainedRendering(accountId)) return ['liveRendering', 'standardRendering'];
  return [];
}

export function timingSafeMatch(input, expected) {
  const value = Buffer.from(String(input || '').trim());
  const target = Buffer.from(String(expected || '').trim());
  return target.length > 0 && value.length === target.length && crypto.timingSafeEqual(value, target);
}

export function requireRecoveryAuthorization(req) {
  const expected = String(process.env.CRON_SECRET || '').trim();
  const match = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!expected) throw Object.assign(new Error('Recovery authorization is not configured.'), { statusCode: 503 });
  if (!timingSafeMatch(match?.[1], expected)) throw Object.assign(new Error('Recovery authorization required.'), { statusCode: 401 });
}

export function publicOrigin() {
  const raw = String(process.env.VIDEO_OS_PUBLIC_ORIGIN || '').trim();
  if (!raw) throw Object.assign(new Error('VIDEO_OS_PUBLIC_ORIGIN is not configured.'), { statusCode: 503 });
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Object.assign(new Error('VIDEO_OS_PUBLIC_ORIGIN must be a bare HTTPS origin.'), { statusCode: 503 });
  return url.origin;
}

let blockedNetworks = null;
function getBlockedNetworks() {
  if (!blockedNetworks) {
    blockedNetworks = new net.BlockList();
    for (const [network, prefix, family] of [
      ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
      ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'],
      ['192.168.0.0', 16, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'], ['203.0.113.0', 24, 'ipv4'],
      ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'], ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'],
      ['100::', 64, 'ipv6'], ['2001:db8::', 32, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
    ]) blockedNetworks.addSubnet(network, prefix, family);
  }
  return blockedNetworks;
}

function privateIp(address) {
  if (!net.isIP(address)) return true;
  if (address.startsWith('::ffff:')) return privateIp(address.slice(7));
  return getBlockedNetworks().check(address, net.isIP(address) === 4 ? 'ipv4' : 'ipv6');
}

export function assertAllowedMediaUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw Object.assign(new Error('Provider media URL is invalid.'), { statusCode: 400, failureCategory: 'SOURCE_POLICY' }); }
  const hosts = String(process.env.VIDEO_OS_PROVIDER_MEDIA_HOSTS || '').split(',').map((host) => host.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Object.assign(new Error('Provider media URL must be credential-free HTTPS.'), { statusCode: 400, failureCategory: 'SOURCE_POLICY' });
  if (!hosts.length || !hosts.includes(hostname)) throw Object.assign(new Error('Provider media hostname is not allowlisted.'), { statusCode: 403, failureCategory: 'SOURCE_POLICY' });
  return url;
}

export async function assertPublicDns(url) {
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => privateIp(address))) throw Object.assign(new Error('Provider media hostname resolved to a blocked network.'), { statusCode: 403, failureCategory: 'SOURCE_POLICY' });
  return addresses;
}

export const accountHash = (id) => crypto.createHash('sha256').update(String(id || '')).digest('hex').slice(0, 24);
export const requestId = (req) => (/^[\w-]{8,100}$/.test(String(req.headers?.['x-request-id'] || '')) ? String(req.headers['x-request-id']) : crypto.randomUUID());
const SENSITIVE_LOG_KEY_FRAGMENTS = ['email', 'cookie', 'token', 'script', 'sourceurl', 'url'];

export function logEvent(event, fields = {}) {
  const safe = Object.fromEntries(Object.entries(fields).filter(([key, value]) => {
    const normalizedKey = String(key).toLowerCase();
    return value !== undefined && !SENSITIVE_LOG_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment));
  }));
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...safe }));
}
