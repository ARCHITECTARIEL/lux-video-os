import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configuredCreativeFinishRevisionCredits,
  creativeFinishActivationStatus,
  resolveCreativeFinishSelection,
} from '../lib/creative-finish-contract.js';

const NOW = Date.UTC(2026, 9, 14, 12);
const LOGO = '11111111-1111-4111-8111-111111111111';

function catalog() {
  return {
    revision: 'catalog-v1',
    music: [{ id: 'music-one', status: 'approved', sha256: 'a'.repeat(64), licenseReceiptSha256: 'b'.repeat(64), allowedScopes: ['web', 'social'], durationMs: 10_000 }],
    graphics: [{ id: 'clean-intro', status: 'approved', sha256: 'c'.repeat(64), version: 'template-v1', formats: ['landscape', 'vertical', 'square'], maxHeadlineChars: 80, maxCtaChars: 40 }],
    logos: [{ id: LOGO, accountId: 'account-one', status: 'approved', sha256: 'd'.repeat(64) }],
    luts: [{ id: 'warm-look', status: 'approved', sha256: 'e'.repeat(64), version: 'lut-v1' }],
  };
}

function selection() {
  return {
    version: 'creative-finish/v1',
    music: { assetId: 'music-one', mix: 'balanced', startMs: 0 },
    graphic: { templateId: 'clean-intro', headline: 'A real offer', cta: 'Visit us', logoAssetId: LOGO },
    color: { lutId: 'warm-look', strength: 50 },
    captions: 'none',
  };
}

const resolve = (value, assets = catalog(), accountId = 'account-one', format = 'landscape') =>
  resolveCreativeFinishSelection(value, { accountId, format, distributionScope: 'social', catalog: assets, now: NOW });

test('Creative Finish is default off and requires both an exact account pin and explicit flag', () => {
  assert.equal(creativeFinishActivationStatus('account-one', {}).enabled, false);
  assert.equal(creativeFinishActivationStatus('account-one', { VIDEO_OS_CREATIVE_FINISH_ENABLED: 'true' }).enabled, false);
  const env = { VIDEO_OS_CREATIVE_FINISH_ENABLED: 'true', VIDEO_OS_CREATIVE_FINISH_ACCOUNT_ID: 'account-one' };
  assert.equal(creativeFinishActivationStatus('account-one', env).enabled, true);
  assert.equal(creativeFinishActivationStatus('account-two', env).enabled, false);
  assert.equal(creativeFinishActivationStatus('account-one', { ...env, VIDEO_OS_CREATIVE_FINISH_ENABLED: '1' }).enabled, false);
});

test('only an explicit positive server price can quote a finish-only revision', () => {
  assert.equal(configuredCreativeFinishRevisionCredits({ VIDEO_OS_CREATIVE_FINISH_REVISION_CREDITS: '7' }), 7);
  for (const raw of [undefined, '0', '-1', '1.5', '7x', '9007199254740992']) {
    assert.throws(() => configuredCreativeFinishRevisionCredits({ VIDEO_OS_CREATIVE_FINISH_REVISION_CREDITS: raw }),
      { code: 'CREATIVE_FINISH_PRICE_UNAVAILABLE' });
  }
});

test('server-approved media, graphics, logo and LUT are bound without asset paths', () => {
  const result = resolve(selection());
  assert.equal(result.selection.music.assetId, 'music-one');
  assert.equal(result.assets.music.licenseReceiptSha256, 'b'.repeat(64));
  assert.equal(result.assets.music.distributionScope, 'social');
  assert.equal(result.assets.graphic.logo.sha256, 'd'.repeat(64));
  assert.equal(result.assets.color.sha256, 'e'.repeat(64));
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /pathname|https?:\/\//);
  const differentlyOrdered = {
    captions: 'none', color: { strength: 50, lutId: 'warm-look' },
    graphic: { logoAssetId: LOGO, cta: 'Visit us', headline: 'A real offer', templateId: 'clean-intro' },
    music: { startMs: 0, mix: 'balanced', assetId: 'music-one' }, version: 'creative-finish/v1',
  };
  assert.equal(resolve(differentlyOrdered).digest, result.digest);
  assert.notEqual(resolve({ ...selection(), color: { lutId: 'warm-look', strength: 75 } }).digest, result.digest);
  assert.notEqual(resolve(selection(), { ...catalog(), revision: 'catalog-v2' }).digest, result.digest);
});

test('missing, unapproved, cross-account, expired and unlicensed assets fail closed', () => {
  assert.throws(() => resolve(selection(), null), { code: 'CREATIVE_FINISH_CATALOG_UNAVAILABLE' });
  const cases = [
    [{ ...catalog(), music: [] }, 'CREATIVE_FINISH_ASSET_UNAVAILABLE'],
    [{ ...catalog(), music: [{ ...catalog().music[0], status: 'pending' }] }, 'CREATIVE_FINISH_ASSET_UNAVAILABLE'],
    [{ ...catalog(), music: [{ ...catalog().music[0], licenseReceiptSha256: null }] }, 'CREATIVE_FINISH_ASSET_UNAVAILABLE'],
    [{ ...catalog(), music: [{ ...catalog().music[0], allowedScopes: ['web'] }] }, 'CREATIVE_FINISH_ASSET_UNAVAILABLE'],
    [{ ...catalog(), music: [{ ...catalog().music[0], durationMs: 0 }] }, 'CREATIVE_FINISH_ASSET_UNAVAILABLE'],
    [{ ...catalog(), music: [{ ...catalog().music[0], expiresAt: new Date(NOW).toISOString() }] }, 'CREATIVE_FINISH_ASSET_UNAVAILABLE'],
    [{ ...catalog(), logos: [{ ...catalog().logos[0], accountId: 'account-two' }] }, 'CREATIVE_FINISH_ASSET_UNAVAILABLE'],
    [{ ...catalog(), logos: [{ id: LOGO, status: 'approved', sha256: 'd'.repeat(64) }] }, 'CREATIVE_FINISH_ASSET_UNAVAILABLE'],
    [{ ...catalog(), graphics: [{ ...catalog().graphics[0], formats: ['square'] }] }, 'CREATIVE_FINISH_ASSET_UNAVAILABLE'],
    [{ ...catalog(), graphics: [{ ...catalog().graphics[0], maxHeadlineChars: 0 }] }, 'CREATIVE_FINISH_ASSET_UNAVAILABLE'],
  ];
  for (const [assets, code] of cases) assert.throws(() => resolve(selection(), assets), { code });
});

test('unknown fields, unbounded text, invalid color and unsupported formats are rejected', () => {
  assert.throws(() => resolve({ ...selection(), provider: 'runway' }), { code: 'CREATIVE_FINISH_INVALID' });
  assert.throws(() => resolve({ ...selection(), captions: 'sidecar' }), { code: 'CREATIVE_FINISH_INVALID' });
  assert.throws(() => resolve({ ...selection(), graphic: { ...selection().graphic, headline: 'x'.repeat(121) } }), { code: 'CREATIVE_FINISH_INVALID' });
  assert.throws(() => resolve({ ...selection(), graphic: { ...selection().graphic, headline: 'x'.repeat(81) } }), { code: 'CREATIVE_FINISH_INVALID' });
  assert.throws(() => resolve({ ...selection(), graphic: { ...selection().graphic, cta: 'Line\nbreak' } }), { code: 'CREATIVE_FINISH_INVALID' });
  assert.throws(() => resolve({ ...selection(), music: { ...selection().music, startMs: 10_000 } }), { code: 'CREATIVE_FINISH_ASSET_UNAVAILABLE' });
  assert.throws(() => resolve({ ...selection(), graphic: { ...selection().graphic, headline: '<script>' } }), { code: 'CREATIVE_FINISH_INVALID' });
  assert.throws(() => resolve({ ...selection(), color: { lutId: 'warm-look', strength: 37 } }), { code: 'CREATIVE_FINISH_INVALID' });
  assert.throws(() => resolve(selection(), catalog(), 'account-one', '4k'), { code: 'CREATIVE_FINISH_INVALID' });
});

test('music, graphics and grading may each be off, without creating a fake asset approval', () => {
  const result = resolve({ version: 'creative-finish/v1', music: null, graphic: null, color: null, captions: 'none' });
  assert.deepEqual(result.assets, { music: null, graphic: null, color: null });
});
