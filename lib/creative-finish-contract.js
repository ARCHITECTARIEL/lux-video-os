import { createHash } from 'node:crypto';

import { stableJson } from './video-os-render-authorization.js';

export const CREATIVE_FINISH_VERSION = 'creative-finish/v1';
export const CREATIVE_FINISH_REVISION_MODE = 'finish_only_v1';
export const CREATIVE_FINISH_FORMATS = Object.freeze(['landscape', 'vertical', 'square']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATIVE_BASE_PATH = /^video-os\/creative-base\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp4$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export class CreativeFinishContractError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'CreativeFinishContractError';
    this.code = code;
    this.statusCode = statusCode;
    this.failureCategory = statusCode === 503 ? 'CONFIG_MISSING' : 'VALIDATION';
  }
}

function fail(code, message, statusCode) {
  throw new CreativeFinishContractError(code, message, statusCode);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some(key => !keys.includes(key))) {
    fail('CREATIVE_FINISH_INVALID', `${label} is invalid.`);
  }
  return value;
}

function identifier(value, label, pattern = ID) {
  if (typeof value !== 'string' || !pattern.test(value) || value !== value.trim()) {
    fail('CREATIVE_FINISH_INVALID', `${label} is invalid.`);
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stableJson(value))).digest('hex');
}

// The opaque base ID is owned and checked in the retained-base repository.
// Keeping account/project/source identifiers out of the Blob path avoids a
// path format tied to a rotatable HMAC key or a provider job-ID alphabet.
export function isCreativeBasePathname(value) {
  return typeof value === 'string' && CREATIVE_BASE_PATH.test(value);
}

function text(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > maximum
    || (!allowEmpty && !value) || CONTROL.test(value) || /[<>]/.test(value)) {
    fail('CREATIVE_FINISH_INVALID', `${label} is invalid.`);
  }
  return value;
}

function approvedAsset(items, id, accountId, label, now) {
  const matches = Array.isArray(items) ? items.filter(item => item?.id === id) : [];
  if (matches.length !== 1) fail('CREATIVE_FINISH_ASSET_UNAVAILABLE', `${label} is unavailable.`, 409);
  const item = matches[0];
  if (item.status !== 'approved' || (item.accountId && item.accountId !== accountId)
    || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)
    || (item.expiresAt && (!Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= now))) {
    fail('CREATIVE_FINISH_ASSET_UNAVAILABLE', `${label} is unavailable.`, 409);
  }
  return item;
}

export function creativeFinishActivationStatus(accountId, env = process.env) {
  const pin = String(env.VIDEO_OS_CREATIVE_FINISH_ACCOUNT_ID || '').trim();
  const enabled = Boolean(pin) && accountId === pin
    && String(env.VIDEO_OS_CREATIVE_FINISH_ENABLED || '').trim().toLowerCase() === 'true';
  return Object.freeze({ enabled, reason: enabled ? 'contained_pilot' : 'creative_finish_disabled' });
}

export function configuredCreativeFinishRevisionCredits(env = process.env) {
  const raw = String(env.VIDEO_OS_CREATIVE_FINISH_REVISION_CREDITS || '').trim();
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    fail('CREATIVE_FINISH_PRICE_UNAVAILABLE', 'Creative Finish revision pricing is unavailable.', 503);
  }
  return Number(raw);
}

export function resolveCreativeFinishSelection(value, { accountId, format, distributionScope, catalog, now = Date.now() }) {
  identifier(accountId, 'Account');
  if (!CREATIVE_FINISH_FORMATS.includes(format)) fail('CREATIVE_FINISH_INVALID', 'Output format is invalid.');
  identifier(distributionScope, 'Distribution scope');
  if (!Number.isSafeInteger(now) || now <= 0) fail('CREATIVE_FINISH_INVALID', 'Time is invalid.');
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)
    || !ID.test(String(catalog.revision || ''))) {
    fail('CREATIVE_FINISH_CATALOG_UNAVAILABLE', 'Approved Creative Finish assets are unavailable.', 503);
  }
  const input = exact(value, ['version', 'music', 'graphic', 'color', 'captions'], 'Creative Finish selection');
  if (input.version !== CREATIVE_FINISH_VERSION || input.captions !== 'none') {
    fail('CREATIVE_FINISH_INVALID', 'Creative Finish version or captions are invalid.');
  }

  let music = null;
  let musicBinding = null;
  if (input.music !== null) {
    const choice = exact(input.music, ['assetId', 'mix', 'startMs'], 'Music selection');
    identifier(choice.assetId, 'Music asset');
    if (!['quiet', 'balanced', 'bold'].includes(choice.mix)
      || !Number.isInteger(choice.startMs) || choice.startMs < 0 || choice.startMs > 60_000) {
      fail('CREATIVE_FINISH_INVALID', 'Music selection is invalid.');
    }
    const asset = approvedAsset(catalog.music, choice.assetId, accountId, 'Music asset', now);
    if (!SHA256.test(String(asset.licenseReceiptSha256 || ''))
      || !Array.isArray(asset.allowedScopes) || !asset.allowedScopes.includes(distributionScope)
      || !Number.isSafeInteger(asset.durationMs) || asset.durationMs <= choice.startMs) {
      fail('CREATIVE_FINISH_ASSET_UNAVAILABLE', 'Music license evidence is unavailable.', 409);
    }
    music = { assetId: choice.assetId, mix: choice.mix, startMs: choice.startMs };
    musicBinding = { id: asset.id, sha256: asset.sha256.toLowerCase(),
      licenseReceiptSha256: asset.licenseReceiptSha256.toLowerCase(), distributionScope,
      durationMs: asset.durationMs, expiresAt: asset.expiresAt || null };
  }

  let graphic = null;
  let graphicBinding = null;
  if (input.graphic !== null) {
    const choice = exact(input.graphic, ['templateId', 'headline', 'cta', 'logoAssetId'], 'Graphic selection');
    identifier(choice.templateId, 'Graphic template');
    const template = approvedAsset(catalog.graphics, choice.templateId, accountId, 'Graphic template', now);
    if (!ID.test(String(template.version || '')) || !Array.isArray(template.formats)
      || !template.formats.includes(format)
      || !Number.isInteger(template.maxHeadlineChars) || template.maxHeadlineChars < 1 || template.maxHeadlineChars > 120
      || !Number.isInteger(template.maxCtaChars) || template.maxCtaChars < 0 || template.maxCtaChars > 120) {
      fail('CREATIVE_FINISH_ASSET_UNAVAILABLE', 'Graphic template is unavailable for this format.', 409);
    }
    const headline = text(choice.headline, 'Graphic headline', template.maxHeadlineChars);
    const cta = text(choice.cta, 'Graphic call to action', template.maxCtaChars, { allowEmpty: true });
    let logo = null;
    if (choice.logoAssetId !== null) {
      identifier(choice.logoAssetId, 'Logo asset', UUID);
      const asset = approvedAsset(catalog.logos, choice.logoAssetId, accountId, 'Logo asset', now);
      if (asset.accountId !== accountId) fail('CREATIVE_FINISH_ASSET_UNAVAILABLE', 'Logo asset is unavailable.', 409);
      logo = { id: asset.id.toLowerCase(), sha256: asset.sha256.toLowerCase() };
    }
    graphic = { templateId: choice.templateId, headline, cta, logoAssetId: logo?.id || null };
    graphicBinding = { id: template.id, version: template.version, sha256: template.sha256.toLowerCase(),
      maxHeadlineChars: template.maxHeadlineChars, maxCtaChars: template.maxCtaChars, logo };
  }

  let color = null;
  let colorBinding = null;
  if (input.color !== null) {
    const choice = exact(input.color, ['lutId', 'strength'], 'Color selection');
    identifier(choice.lutId, 'Color look');
    if (!Number.isInteger(choice.strength) || choice.strength < 0 || choice.strength > 100 || choice.strength % 25 !== 0) {
      fail('CREATIVE_FINISH_INVALID', 'Color look strength is invalid.');
    }
    const lut = approvedAsset(catalog.luts, choice.lutId, accountId, 'Color look', now);
    if (!ID.test(String(lut.version || ''))) fail('CREATIVE_FINISH_ASSET_UNAVAILABLE', 'Color look is unavailable.', 409);
    color = { lutId: choice.lutId, strength: choice.strength };
    colorBinding = { id: lut.id, version: lut.version, sha256: lut.sha256.toLowerCase() };
  }

  const selection = Object.freeze({ version: CREATIVE_FINISH_VERSION, music, graphic, color, captions: input.captions });
  const assets = Object.freeze({ music: musicBinding, graphic: graphicBinding, color: colorBinding });
  return Object.freeze({ selection, assets, catalogRevision: catalog.revision, digest: digest({ selection, assets, catalogRevision: catalog.revision }) });
}
