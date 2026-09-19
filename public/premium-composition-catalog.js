export const PREMIUM_COMPOSITION_CONTRACT_VERSION = 'premium-composition-v1';
export const PREMIUM_COMPOSITION_SUPPORTED_FORMATS = Object.freeze(['landscape']);

export const PREMIUM_COMPOSITION_DEFAULTS = Object.freeze({
  backgroundId: 'midnight-grid',
  layoutId: 'editorial-split',
});

const backgrounds = Object.freeze([
  Object.freeze({
    id: 'midnight-grid',
    name: 'Midnight Grid',
    description: 'Deep navy with a lime guide rail and a quiet technical grid.',
    preview: Object.freeze({
      surface: 'linear-gradient(126deg, #071018 0%, #0b1822 53%, #0d2830 100%)',
      accent: '#cdff64',
      foreground: '#f7f3eb',
      motif: 'grid',
    }),
    render: Object.freeze({
      surface: 'radial-gradient(circle at 18% 18%, rgba(61, 122, 141, .2), transparent 31%), linear-gradient(126deg, #071018 0%, #0b1822 53%, #0d2830 100%)',
      accent: '#cdff64',
      foreground: '#f7f3eb',
      muted: '#b8c8ce',
      gridOpacity: '.15',
      gridSize: '72px 72px',
    }),
  }),
  Object.freeze({
    id: 'ember-halo',
    name: 'Ember Halo',
    description: 'Warm charcoal with an amber glow and a broad cinematic pattern.',
    preview: Object.freeze({
      surface: 'linear-gradient(135deg, #180c09 0%, #2b1510 52%, #130d12 100%)',
      accent: '#ffb45e',
      foreground: '#fff6eb',
      motif: 'halo',
    }),
    render: Object.freeze({
      surface: 'radial-gradient(circle at 25% 22%, rgba(255, 126, 61, .34), transparent 35%), radial-gradient(circle at 78% 82%, rgba(139, 62, 92, .22), transparent 38%), linear-gradient(135deg, #180c09 0%, #2b1510 52%, #130d12 100%)',
      accent: '#ffb45e',
      foreground: '#fff6eb',
      muted: '#dec9b8',
      gridOpacity: '.09',
      gridSize: '112px 112px',
    }),
  }),
]);

const layouts = Object.freeze([
  Object.freeze({
    id: 'editorial-split',
    name: 'Editorial Split',
    description: 'Campaign message at left with the presenter framed at right.',
    preview: Object.freeze({
      presenter: Object.freeze({ x: 36.6, y: 6.3, width: 59.5, height: 87.4 }),
      copy: Object.freeze({ x: 4.8, y: 26.1, width: 29.7 }),
    }),
    render: Object.freeze({
      presenter: 'left:702px;top:68px;width:1142px;height:944px;border-radius:32px;',
      headline: 'left:92px;top:282px;width:570px;font-size:92px;text-shadow:none;',
      summary: 'left:98px;top:596px;width:500px;',
      brand: 'left:92px;top:72px;',
      badge: 'left:98px;top:760px;',
      cta: 'left:92px;bottom:90px;width:530px;',
    }),
  }),
  Object.freeze({
    id: 'cinematic-overlay',
    name: 'Cinematic Overlay',
    description: 'The presenter fills the frame while campaign copy floats above it.',
    preview: Object.freeze({
      presenter: Object.freeze({ x: 4.2, y: 5.6, width: 91.6, height: 88.8 }),
      copy: Object.freeze({ x: 6.8, y: 17.6, width: 40.6 }),
    }),
    render: Object.freeze({
      presenter: 'left:80px;top:60px;width:1760px;height:960px;border-radius:42px;',
      headline: 'left:130px;top:190px;width:780px;font-size:100px;text-shadow:0 6px 32px rgba(0,0,0,.88);z-index:4;',
      summary: 'left:136px;top:525px;width:650px;padding:20px 24px;background:rgba(3,9,13,.72);border-radius:16px;color:var(--lux-muted);z-index:4;',
      brand: 'left:130px;top:94px;z-index:4;text-shadow:0 3px 18px rgba(0,0,0,.9);',
      badge: 'left:auto;right:126px;top:96px;z-index:4;',
      cta: 'left:130px;bottom:116px;width:700px;padding:20px 24px;background:rgba(3,9,13,.76);border-radius:16px;z-index:4;',
    }),
  }),
]);

export const PREMIUM_COMPOSITION_CATALOG = Object.freeze({
  contractVersion: PREMIUM_COMPOSITION_CONTRACT_VERSION,
  engine: 'hyperframes',
  supportedFormats: PREMIUM_COMPOSITION_SUPPORTED_FORMATS,
  defaults: PREMIUM_COMPOSITION_DEFAULTS,
  backgrounds,
  layouts,
});

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400, failureCategory: 'VALIDATION' });
}

function catalogItem(items, id, kind) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw validationError(`Unsupported Premium composition ${kind}: ${id}.`);
  return item;
}

export function normalizePremiumCompositionSelection(value) {
  if (value === undefined || value === null) {
    return Object.freeze({
      contractVersion: PREMIUM_COMPOSITION_CONTRACT_VERSION,
      ...PREMIUM_COMPOSITION_DEFAULTS,
      defaulted: true,
    });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('Premium composition selection must be an object.');
  }
  const allowedKeys = new Set(['contractVersion', 'backgroundId', 'layoutId']);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw validationError(`Unsupported Premium composition field: ${unknownKey}.`);
  const contractVersion = value.contractVersion;
  if (contractVersion !== undefined && contractVersion !== PREMIUM_COMPOSITION_CONTRACT_VERSION) {
    throw validationError(`Unsupported Premium composition contract: ${contractVersion}.`);
  }
  const backgroundId = value.backgroundId;
  const layoutId = value.layoutId;
  catalogItem(backgrounds, backgroundId, 'background');
  catalogItem(layouts, layoutId, 'layout');
  if (contractVersion === undefined) throw validationError('Explicit Premium composition requires a contract version.');
  return Object.freeze({ contractVersion, backgroundId, layoutId, defaulted: false });
}

export function resolvePremiumComposition(value) {
  const selection = normalizePremiumCompositionSelection(value);
  return Object.freeze({
    selection,
    background: catalogItem(backgrounds, selection.backgroundId, 'background'),
    layout: catalogItem(layouts, selection.layoutId, 'layout'),
    supportedFormats: PREMIUM_COMPOSITION_SUPPORTED_FORMATS,
  });
}

export function premiumCompositionSelectionFromJob(job = {}) {
  return normalizePremiumCompositionSelection(job.input?.productionKit?.composition);
}
