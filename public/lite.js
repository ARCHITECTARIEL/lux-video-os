import { FEATURED_CAST, curateDefaultCast, matchedVoiceId, prioritizeVoices } from './video-os-cast.js';

const appState = { step: 0, avatar: null, voice: null, identityId: null, identities: [], voiceSelectionExplicit: false, project: null, uploadedAsset: null, generated: null, productionKit: null, kitSignature: null, assetCatalog: {}, providerRender: null, renderIdempotencyKey: null, finalizeTimer: null, finalizeAttempts: 0, finalizing: false, renderLocked: false, results: [], resultsState: 'signed-out', activeResult: null, resultLimit: 6, localEngine: false, providers: [], credits: null, account: null, signedIn: false, userEmail: null, assetLibraries: [], libraries: { avatar: [], voice: [] }, visible: { avatar: 20, voice: 20 } };

const fallbackTalent = {
  avatars: [
    { id: 'ai-presenter', name: 'AI Presenter', style: 'balanced', source: 'lite' },
    { id: 'studio-host', name: 'Studio Host', style: 'polished', source: 'lite' },
    { id: 'friendly-guide', name: 'Friendly Guide', style: 'warm', source: 'lite' },
  ],
  voices: [
    { id: 'clear-narrator', name: 'Clear Narrator', style: 'warm', source: 'lite' },
    { id: 'confident-seller', name: 'Confident Seller', style: 'sales', source: 'lite' },
    { id: 'calm-expert', name: 'Calm Expert', style: 'expert', source: 'lite' },
  ],
};

const publicDemoAccount = {
  ok: true,
  session: { accountId: 'demo-client', security: { configured: false, status: 'public_demo', message: 'Public preview. Live rendering connects after signup.' } },
  accountId: 'demo-client',
  account: { accountId: 'demo-client', name: 'Preview Account', subscription: { plan: 'Video OS Lite', status: 'preview', renewal: 'Signup unlocks live rendering' } },
  credits: { accountId: 'demo-client', balance: 1500, currency: 'credits' },
  assetLibraries: [
    { id: 'music-beds', name: 'Music beds', type: 'audio', url: 'https://drive.google.com/drive/folders/1DlpzePBzfxmxZI6c6n3nEuJiYOwj1vHR', examples: ['Waimea - Kellin.wav', 'Infinite Morning - Kellin.wav', 'Crystal Clear - Kellin.wav'] },
    { id: 'video-backgrounds', name: 'Video backgrounds', type: 'video', url: 'https://drive.google.com/drive/folders/1FSm9VTwfoG10GKm7bkEx9SvwbiCHTCMF', examples: ['VHS background Overlay.mp4', 'Kinetic Dots background (white).mp4', 'Static Background 1.mp4'] },
    { id: 'color-grades', name: 'LUT color grades', type: 'lut', url: 'https://drive.google.com/drive/folders/1j-fgAnRfgNYfGsf-eykMdgaEeRdswP7v', examples: ['Studio Contrast', 'Bright & Saturated', 'Clean Creator'] },
    { id: 'cta-motion', name: 'CTA motion assets', type: 'video', url: 'https://drive.google.com/drive/folders/1cRuC6v3fqI4kCpCVbzE7_bSN0GWlkOx_', examples: ['Like and Subscribe ProRes.mov', 'CIRCLE-1080.mov', 'Arrow_6.mov'] },
    { id: 'gif-reactions', name: 'GIF reactions and stickers', type: 'gif', url: 'https://drive.google.com/drive/folders/1EioIhUvCMgEIAjC9b7zRuCgdY1Z3E0AM', examples: ['78-Hundred-Points.gif', '77-Heart-2.gif', '75-Folded-Hands.gif'] },
  ],
};

const publicDemoProviders = [
  { id: 'heygen', name: 'HeyGen', cost: 90, configured: true, missing: [] },
  { id: 'argil', name: 'Argil', cost: 80, configured: true, missing: [] },
  { id: 'tavus', name: 'Tavus', cost: 120, configured: true, missing: [] },
  { id: 'did', name: 'D-ID', cost: 45, configured: true, missing: [] },
];
const panels = [...document.querySelectorAll('.wizard-panel')];
const stepButtons = [...document.querySelectorAll('[data-step-jump]')];
const form = document.querySelector('#video-form');
const toast = document.querySelector('#toast');
let authOpener = null;
let authLastAction = null;
let authPending = false;

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3600);
}



function formData() {
  const data = Object.fromEntries(new FormData(form).entries());
  data.captions = Boolean(data.captions);
  data.music = Boolean(data.music);
  data.voiceConsent = Boolean(data.voiceConsent);
  return data;
}

function canUseLocalApi() {
  return ['127.0.0.1', 'localhost', ''].includes(location.hostname);
}

function canUseHostedApi() {
  return canUseLocalApi() || location.hostname.endsWith('.vercel.app') || location.hostname === 'lux-video-os.vercel.app';
}

async function getJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    const headers = new Headers(options.headers || {});
    if (!headers.has('x-request-id')) headers.set('x-request-id', crypto.randomUUID());
    response = await fetch(url, { credentials: 'same-origin', ...options, headers, signal: controller.signal });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Video OS took too long to respond. Check your connection and try again.'
      : 'We couldn’t reach Video OS. Check your connection, refresh the page, and try again.';
    throw Object.assign(new Error(message), { code: 'network_unavailable', retryable: true });
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error(`Video OS returned an unexpected response (${response.status}). Refresh and try again.`), { code: 'invalid_response', status: response.status, retryable: true });
  }
  if (!response.ok || data.ok === false) {
    throw Object.assign(new Error(data.error || `Request failed with ${response.status}`), {
      code: data.code || 'request_failed',
      status: response.status,
      retryable: response.status >= 500,
    });
  }
  return data;
}

function setStep(next) {
  appState.step = Math.max(0, Math.min(panels.length - 1, next));
  panels.forEach((panel, index) => panel.classList.toggle('active', index === appState.step));
  stepButtons.forEach((button, index) => button.classList.toggle('active', index === appState.step));
  document.querySelector('#back-step').disabled = appState.step === 0;
  document.querySelector('#next-step').textContent = appState.step === panels.length - 1 ? 'Go to preview' : 'Next';
  if (appState.step === panels.length - 1) {
    renderSummary();
    ensureProductionKit();
  }
}

function requireCurrentStep() {
  const fields = [...panels[appState.step].querySelectorAll('[required]')];
  for (const field of fields) {
    if (!field.value.trim()) {
      field.focus();
      showToast('Fill in the required field before continuing.');
      return false;
    }
  }
  return true;
}

function availableAvatarItems() {
  const items = appState.libraries.avatar || [];
  const curated = curateDefaultCast(items, appState.results, 20);
  return curated.length || !canUseLocalApi() ? curated : items.slice(0, 20);
}

function availableVoiceItems() {
  const items = appState.libraries.voice || [];
  const prioritized = prioritizeVoices(items, appState.avatar?.id);
  const privateVoice = appState.voice?.source === 'identity' && appState.voice.identityId === appState.identityId ? [appState.voice] : [];
  const available = prioritized.length || !canUseLocalApi() ? prioritized : items;
  return [...privateVoice, ...available.filter((item) => item.id !== privateVoice[0]?.id)];
}

function identityAvatar(identity) {
  return { id: `identity-avatar:${identity.id}`, identityId: identity.id, name: identity.displayName || identity.name || 'My identity', source: 'identity', providerReady: true, previewUrl: identity.portraitUrl || '' };
}

function identityVoice(identity) {
  return { id: `identity-voice:${identity.id}`, identityId: identity.id, name: `${identity.displayName || identity.name || 'My identity'} cloned voice`, source: 'identity', providerReady: true };
}

function chooseIdentity(identity, { forcePairedVoice = false } = {}) {
  if (!identity?.id) return;
  appState.identityId = identity.id;
  appState.avatar = identityAvatar(identity);
  if (forcePairedVoice || !appState.voiceSelectionExplicit || appState.voice?.source === 'identity') {
    appState.voice = identityVoice(identity);
    appState.voiceSelectionExplicit = false;
  }
  renderMyCast();
  renderFeaturedCast();
  renderOptions('avatar');
  renderOptions('voice');
}

function renderMyCast() {
  const target = document.querySelector('#my-cast-list');
  if (!target) return;
  if (!appState.signedIn) {
    target.innerHTML = '<p class="my-cast-empty">Sign in to use your private video identities.</p>';
    return;
  }
  if (!appState.identities.length) {
    target.innerHTML = '<p class="my-cast-empty">No ready identities yet. Create one in Identity Studio.</p>';
    return;
  }
  target.replaceChildren(...appState.identities.map((identity) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `my-cast-card${appState.identityId === identity.id ? ' selected' : ''}`;
    button.dataset.identityId = identity.id;
    button.setAttribute('aria-pressed', String(appState.identityId === identity.id));
    const avatar = identityAvatar(identity);
    if (avatar.previewUrl) {
      const image = document.createElement('img');
      image.src = avatar.previewUrl;
      image.alt = `${avatar.name} private identity preview`;
      button.append(image);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'my-cast-avatar';
      fallback.textContent = avatar.name.slice(0, 2).toUpperCase();
      button.append(fallback);
    }
    const copy = document.createElement('span');
    copy.className = 'my-cast-copy';
    const name = document.createElement('strong');
    name.textContent = avatar.name;
    const status = document.createElement('small');
    status.textContent = 'Photo avatar + cloned voice ready';
    copy.append(name, status);
    button.append(copy);
    button.addEventListener('click', () => chooseIdentity(identity));
    return button;
  }));
}

async function loadMyCast() {
  if (!appState.signedIn || !canUseHostedApi()) {
    appState.identities = [];
    renderMyCast();
    return;
  }
  try {
    const data = await getJson('/api/video-os-lite/identities');
    appState.identities = (data.identities || []).filter((identity) => !identity.archivedAt && [identity.overallStatus, identity.avatarStatus, identity.voiceStatus].every((status) => String(status || '').toUpperCase() === 'READY'));
  } catch {
    appState.identities = [];
  }
  renderMyCast();
}

function renderFeaturedCast() {
  const target = document.querySelector('#featured-cast-list');
  if (!target) return;
  const avatars = new Map((appState.libraries.avatar || []).map((item) => [item.id, item]));
  const voices = new Map((appState.libraries.voice || []).map((item) => [item.id, item]));
  target.replaceChildren(...FEATURED_CAST.map((featured) => {
    const item = avatars.get(featured.avatarId) || { id: featured.avatarId, name: featured.label, source: 'heygen', providerReady: false, unavailableReason: 'Provider availability has not been confirmed.' };
    const matchedVoice = voices.get(featured.voiceId);
    const pairReady = item.providerReady === true && matchedVoice?.providerReady !== false && Boolean(matchedVoice);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `featured-cast-card${appState.avatar?.id === item.id ? ' selected' : ''}${pairReady ? '' : ' unavailable'}`;
    button.dataset.featuredAvatarId = featured.avatarId;
    button.setAttribute('aria-pressed', String(appState.avatar?.id === item.id));
    button.disabled = !pairReady;
    if (item.previewUrl) {
      const image = document.createElement('img');
      image.src = item.previewUrl;
      image.alt = `${featured.label} provider preview`;
      image.loading = 'eager';
      button.append(image);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'featured-cast-fallback';
      fallback.textContent = featured.label.slice(0, 2).toUpperCase();
      button.append(fallback);
    }
    const copy = document.createElement('span');
    copy.className = 'featured-cast-copy';
    const name = document.createElement('strong');
    name.textContent = featured.label;
    const state = document.createElement('small');
    state.textContent = pairReady ? 'Presenter + matched voice ready' : item.providerReady !== true ? (item.unavailableReason || 'Provider unavailable') : `${featured.label}'s matched voice is unavailable.`;
    copy.append(name, state);
    button.append(copy);
    if (pairReady) button.addEventListener('click', () => chooseCard('avatar', item));
    return button;
  }));
}

function chooseCard(type, item, options = {}) {
  if (!item || item.providerReady === false) return;
  const recommendedId = type === 'avatar' ? matchedVoiceId(item.id) : null;
  const recommended = recommendedId ? (appState.libraries.voice || []).find((voice) => voice.id === recommendedId && voice.providerReady !== false) : null;
  if (recommendedId && !recommended) {
    const label = FEATURED_CAST.find((entry) => entry.avatarId === item.id)?.label || 'This presenter';
    showToast(`${label}'s exact matched voice is unavailable. Choose another provider-ready presenter.`);
    return;
  }
  const explicit = options.explicit !== false;
  if (type === 'voice' && explicit) appState.voiceSelectionExplicit = true;
  if (type === 'avatar' && item.source !== 'identity') appState.identityId = null;
  appState[type] = item;
  if (type === 'avatar') {
    if (!appState.voiceSelectionExplicit && recommended) appState.voice = recommended;
    renderFeaturedCast();
    renderOptions('voice');
  }
  document.querySelectorAll(`[data-${type}-id]`).forEach((card) => {
    const selected = card.dataset[`${type}Id`] === item.id;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-pressed', String(selected));
  });
}

function searchableItems(type) {
  const query = document.querySelector(`#${type}-search`)?.value.trim().toLowerCase() || '';
  const items = type === 'avatar' ? availableAvatarItems() : availableVoiceItems();
  if (!query) return items;
  return items.filter((item) => `${item.name || ''} ${item.id || ''} ${item.style || ''} ${item.role || ''}`.toLowerCase().includes(query));
}

function renderOptions(type) {
  const target = document.querySelector(type === 'avatar' ? '#avatar-list' : '#voice-list');
  const filtered = searchableItems(type);
  const visible = filtered.slice(0, appState.visible[type]);
  const recommendation = type === 'voice' ? matchedVoiceId(appState.avatar?.id) : null;
  target.replaceChildren(...visible.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `option-card${appState[type]?.id === item.id ? ' selected' : ''}`;
    button.dataset[`${type}Id`] = item.id;
    button.setAttribute('aria-pressed', String(appState[type]?.id === item.id));
    if (type === 'avatar' && item.previewUrl) {
      const image = document.createElement('img');
      image.src = item.previewUrl;
      image.alt = `${item.name || 'Avatar'} preview`;
      image.loading = 'lazy';
      button.append(image);
    }
    const name = document.createElement('strong');
    name.textContent = item.name || item.id;
    const meta = document.createElement('small');
    meta.textContent = `${item.style || item.role || 'Ready to use'} | ${item.source || 'local'}`;
    button.append(name, meta);
    if ((recommendation && item.id === recommendation) || (item.source === 'identity' && item.identityId === appState.identityId)) {
      const badge = document.createElement('span');
      badge.className = 'recommended-badge';
      badge.textContent = 'Recommended';
      button.append(badge);
    }
    button.addEventListener('click', () => chooseCard(type, item));
    return button;
  }));
  const count = document.querySelector(`#${type}-count`);
  if (count) count.textContent = type === 'avatar' ? `${filtered.length} of 20 curated avatars` : `${filtered.length.toLocaleString()} voices available`;
  const more = document.querySelector(`#${type}-more`);
  if (more) {
    more.hidden = visible.length >= filtered.length || type === 'avatar';
    more.textContent = `Show ${Math.min(20, filtered.length - visible.length)} more voices`;
  }
  if (!appState[type] || !filtered.some((item) => item.id === appState[type].id)) {
    if (type === 'avatar' && appState.identityId) return;
    const first = visible.find((item) => item.providerReady !== false);
    if (first) chooseCard(type, first, { explicit: false });
  }
}

function rerenderLibrary(type) {
  renderOptions(type);
}

async function loadTalent() {
  try {
    if (!canUseHostedApi()) throw new Error('Static mode');
    const data = await getJson('/api/video-os/talent');
    appState.libraries.avatar = data.talent?.avatars || [];
    appState.libraries.voice = data.talent?.voices || [];
    renderFeaturedCast();
    renderOptions('avatar');
    renderOptions('voice');
    document.querySelector('#connection-pill').textContent = data.connection?.connected ? 'HeyGen talent connected' : 'HeyGen talent partially available';
    appState.localEngine = true;
  } catch {
    appState.libraries.avatar = canUseLocalApi() ? fallbackTalent.avatars : [];
    appState.libraries.voice = canUseLocalApi() ? fallbackTalent.voices : [];
    renderFeaturedCast();
    renderOptions('avatar');
    renderOptions('voice');
    document.querySelector('#connection-pill').textContent = canUseLocalApi() ? 'Browser demo mode' : 'HeyGen talent unavailable';
  }
}

function localScript(payload) {
  const goal = payload.goalType || 'Explainer';
  const title = payload.title || 'Your video';
  const audience = payload.audience || 'your audience';
  const objective = payload.objective || 'take the next step';
  return [
    `Scene 1: ${title}`,
    `Hi ${audience}. In this short ${goal.toLowerCase()}, I will show you exactly why this matters and what to do next.`,
    '',
    'Scene 2: The problem',
    'Most videos take too long to plan, record, edit, caption, and format. Video OS Lite turns that work into a guided flow.',
    '',
    'Scene 3: The payoff',
    `The result is a focused video that helps the viewer ${objective.charAt(0).toLowerCase()}${objective.slice(1)}.`,
    '',
    'Scene 4: Next step',
    'Use the button, link, or offer on screen now. Keep the next action simple and easy to say yes to.',
  ].join('\n');
}

async function generateScript() {
  const status = document.querySelector('#script-status');
  const payload = formData();
  status.textContent = 'Writing...';
  try {
    let script;
    if (canUseLocalApi()) {
      const data = await getJson('/api/video-os-lite/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      script = data.script;
    } else {
      script = localScript(payload);
    }
    document.querySelector('#script-input').value = script;
    status.textContent = 'Script ready.';
  } catch (error) {
    document.querySelector('#script-input').value = localScript(payload);
    status.textContent = 'Used browser fallback.';
    showToast(error.message);
  }
}

function tightenScript() {
  const input = document.querySelector('#script-input');
  const paragraphs = input.value.split(/\n+/).filter(Boolean);
  input.value = paragraphs.slice(0, 8).join('\n');
  document.querySelector('#script-status').textContent = 'Shortened.';
}


async function loadAssetCatalog() {
  try {
    if (!canUseLocalApi()) throw new Error('Static mode');
    const data = await getJson('/api/video-os-lite/assets');
    appState.assetCatalog = data.assets || {};
    if (appState.productionKit) renderProductionKit(appState.productionKit);
  } catch {
    appState.assetCatalog = {};
  }
}

function kitSignature(payload = formData()) {
  return [payload.goalType, payload.tone, payload.music ? 'music' : 'silent'].join('|');
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function kitItemName(kit, key) {
  const item = kit?.[key];
  return typeof item === 'object' ? item?.name : item;
}

function assetOptions(folder, selected) {
  const names = (appState.assetCatalog[folder] || []).map((item) => item.name).filter(Boolean);
  const unique = [...new Set([selected, ...names].filter(Boolean))];
  return unique.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
}

function updateProductionKitFromControls() {
  if (!appState.productionKit) return;
  ['music', 'background', 'lut', 'cta'].forEach((key) => {
    const control = document.querySelector(`[data-kit-control="${key}"]`);
    if (control?.value) appState.productionKit[key] = { ...(appState.productionKit[key] || {}), name: control.value };
  });
  if (appState.generated) appState.generated.productionKit = appState.productionKit;
  appState.kitSignature = kitSignature();
  renderSummary();
}

async function ensureProductionKit(force = false) {
  const payload = formData();
  const signature = kitSignature(payload);
  if (!force && appState.productionKit && appState.kitSignature === signature) return appState.productionKit;
  const target = document.querySelector('#production-kit');
  if (target) target.innerHTML = '<strong>Auto-selected kit</strong><small>Choosing the best sales-ready finish...</small>';
  appState.productionKit = await recommendProductionKit(payload);
  appState.kitSignature = signature;
  renderProductionKit(appState.productionKit);
  renderSummary();
  return appState.productionKit;
}
async function recommendProductionKit(payload) {
  try {
    if (!canUseLocalApi()) throw new Error('Static mode');
    const data = await getJson('/api/video-os-lite/assets/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return data.productionKit;
  } catch {
    return {
      name: 'Auto production kit',
      reason: 'Picked automatically from the included starter libraries.',
      music: { name: 'Infinite Morning - Kellin.wav' },
      background: { name: 'Kinetic Dots background (white).mp4' },
      lut: { name: 'iPhone 13 : Studio Contrast : Strong.cube' },
      cta: { name: 'CIRCLE-1080.mov' },
      overlay: { name: '77-Heart-2.gif' },
    };
  }
}

function renderProductionKit(kit) {
  const target = document.querySelector('#production-kit');
  if (!target || !kit) return;
  const controls = [
    ['music', 'Music', 'music'],
    ['background', 'Background', 'backgrounds'],
    ['lut', 'Color grade', 'luts'],
    ['cta', 'CTA motion', 'cta'],
  ];
  target.innerHTML = `
    <div class="kit-head">
      <span><strong>Auto-selected kit</strong><small>${escapeHtml(kit.reason || 'Picked to make the video feel polished before editing.')}</small></span>
      <button class="ghost kit-refresh" type="button" data-kit-refresh>Auto-pick again</button>
    </div>
    <div class="kit-sell"><b>Ready-to-sell polish</b><span>Override anything before generating.</span></div>
    <div class="kit-controls">
      ${controls.map(([key, label, folder]) => `<label>${label}<select data-kit-control="${key}">${assetOptions(folder, kitItemName(kit, key))}</select></label>`).join('')}
    </div>`;
  controls.forEach(([key]) => {
    const control = target.querySelector(`[data-kit-control="${key}"]`);
    if (control) {
      control.value = kitItemName(kit, key) || control.value;
      control.addEventListener('change', updateProductionKitFromControls);
    }
  });
  target.querySelector('[data-kit-refresh]')?.addEventListener('click', () => ensureProductionKit(true));
}function renderSummary() {
  const data = formData();
  const rows = [
    ['Goal', data.goalType],
    ['Title', data.title || 'Untitled'],
    ['Presenter', appState.avatar?.name || 'AI Presenter'],
    ['Voice', appState.voice?.name || 'Clear Narrator'],
    ['Language', data.language || 'English'],
    ['Brand', data.brandName || 'No brand name'],
    ['Captions', data.captions ? 'On' : 'Off'],
    ['Render provider', selectedProvider()?.name || 'HeyGen'],
    ['Production kit', appState.productionKit ? 'Auto-selected' : 'Pending'],
  ];
  document.querySelector('#summary').replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    row.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    return row;
  }));
}

async function saveLocalProject(payload) {
  const data = await getJson('/api/video-os-lite/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: appState.project?.id,
      identityId: appState.identityId || undefined,
      title: payload.title,
      script: payload.script,
      avatar: { id: appState.avatar?.id, name: appState.avatar?.name, source: appState.avatar?.source, ...(appState.avatar?.previewUrl ? { previewUrl: appState.avatar.previewUrl } : {}) },
      voice: { id: appState.voice?.id, name: appState.voice?.name, source: appState.voice?.source },
      settings: {
        identityId: appState.identityId || undefined,
        audience: payload.audience,
        objective: payload.objective,
        goalType: payload.goalType,
        tone: payload.tone,
        name: payload.brandName,
        logoUrl: payload.logoUrl,
        primaryColor: payload.primaryColor,
        accentColor: payload.accentColor,
        captions: payload.captions,
        music: payload.music,
      },
    }),
  });
  appState.project = data.project;
  return data.project;
}

async function restoreLatestProject() {
  if (!appState.signedIn || !canUseHostedApi()) return;
  const data = await getJson('/api/video-os-lite/projects');
  const project = data.projects?.[0];
  if (!project) return;
  appState.project = project;
  const requestedIdentityId = project.identityId || project.settings?.identityId || null;
  const restoredIdentity = requestedIdentityId ? appState.identities.find((identity) => identity.id === requestedIdentityId) : null;
  appState.identityId = restoredIdentity ? requestedIdentityId : null;
  appState.avatar = restoredIdentity ? identityAvatar(restoredIdentity) : (project.avatar?.source === 'identity' ? null : project.avatar);
  appState.voice = restoredIdentity && project.voice?.source === 'identity'
    ? identityVoice(restoredIdentity)
    : (project.voice?.source === 'identity' ? null : project.voice);
  appState.voiceSelectionExplicit = Boolean(appState.voice?.id);
  renderMyCast();
  const title = form.elements.namedItem('title');
  const script = form.elements.namedItem('script');
  if (title) title.value = project.title || '';
  if (script) script.value = project.script || '';
  renderFeaturedCast();
  rerenderLibrary('avatar');
  rerenderLibrary('voice');
}

function consumeIdentitySelection() {
  if (!appState.signedIn) return;
  const url = new URL(window.location.href);
  const identityId = url.searchParams.get('identityId');
  if (!identityId) return;
  url.searchParams.delete('identityId');
  window.history.replaceState({}, '', url);
  const identity = appState.identities.find((item) => item.id === identityId);
  if (!identity) {
    showToast('That private identity is unavailable for this account.');
    return;
  }
  chooseIdentity(identity, { forcePairedVoice: true });
  setStep(1);
  showToast((identity.displayName || 'Private identity') + ' is ready in Cast.');
}

function firstCaption(script) {
  const clean = String(script || '').split(/\n+/).map((line) => line.replace(/^Scene\s+\d+:\s*/i, '').trim()).filter(Boolean);
  return clean.find((line) => line.length > 24) || clean[0] || 'Your AI video is ready to preview.';
}

async function generateVideo() {
  if (!requireCurrentStep()) return;
  if (!appState.signedIn) { showToast('Sign in before live rendering.'); openAuthModal(); return; }
  const privateIdentityReady = Boolean(appState.identityId && appState.avatar?.source === 'identity' && appState.voice);
  if (!appState.avatar || !appState.voice || (!privateIdentityReady && (appState.avatar.source !== 'heygen' || appState.voice.source !== 'heygen'))) { showToast('Choose a connected HeyGen avatar and voice before rendering.'); return; }
  const progress = document.querySelector('#progress');
  const bar = progress.querySelector('span');
  const payload = formData();
  const button = document.querySelector('#generate-video');
  progress.hidden = false;
  bar.style.width = '12%';
  button.disabled = true;
  button.textContent = 'Creating your video...';
  try {
    resetFinalRenderStep();
    const project = await saveLocalProject(payload).catch((error) => {
      showToast(`Saved as preview only: ${error.message}`);
      return null;
    });
    await ensureProductionKit();
    appState.renderIdempotencyKey = crypto.randomUUID();
    bar.style.width = '45%';
    appState.generated = { ...payload, projectId: project?.id, avatar: appState.avatar, voice: appState.voice, productionKit: appState.productionKit };
    renderPreview({ scroll: true });
    setFinalRenderStep('submitted', 'Preparing your final video...');
    bar.style.width = '68%';
    const render = await renderWithProvider({ automatic: true });
    bar.style.width = render ? '88%' : '100%';
  } finally {
    button.disabled = false;
    button.textContent = 'Create final video';
  }
}

function renderPreview(options = {}) {
  const data = appState.generated;
  if (!data) return;
  const stage = document.querySelector('.video-stage');
  stage.querySelector('.avatar-preview-media')?.remove();
  if (data.avatar?.previewUrl) {
    const image = document.createElement('img');
    image.className = 'avatar-preview-media';
    image.src = data.avatar.previewUrl;
    image.alt = `${data.avatar.name || 'Selected avatar'} preview`;
    stage.prepend(image);
  }
  stage.style.background = `radial-gradient(circle at 72% 22%, ${data.accentColor || '#2f6df6'}66, transparent 28%), linear-gradient(145deg, ${data.primaryColor || '#111827'}, #283243)`;
  stage.querySelector('.presenter').textContent = (data.avatar?.name || 'AI').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  stage.querySelector('.caption').textContent = firstCaption(data.script);
  document.querySelector('#preview-card').classList.remove('empty');
  document.querySelector('#preview-empty').textContent = `${data.title || 'Untitled video'} is being created. You can download a draft while the final MP4 renders.`;
  document.querySelector('#export-mp4').disabled = false;
  document.querySelector('#render-provider').hidden = true;
  document.querySelector('#render-provider').disabled = true;
  document.querySelector('#finalize-render').hidden = true;
  document.querySelector('#finalize-render').disabled = true;
  if (options.scroll !== false) document.querySelector('#preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function exportMp4() {
  const status = document.querySelector('#export-status');
  const link = document.querySelector('#download-link');
  const payload = appState.generated;
  if (!payload) return;
  status.textContent = 'Preparing MP4...';
  link.hidden = true;
  try {
    if (!canUseLocalApi()) throw new Error('MP4 export needs the local Video OS engine.');
    const data = await getJson('/api/video-os-lite/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, format: document.querySelector('#export-format').value }),
    });
    link.href = data.url;
    link.download = data.filename;
    link.textContent = `Download ${data.filename}`;
    link.hidden = false;
    renderExportEffects(data.effects);
    status.textContent = data.voice === 'local-tts' ? 'MP4 draft ready with narration, music bed, and production kit effects. Real avatar render still requires HeyGen.' : 'MP4 draft ready with production kit effects.';
  } catch (error) {
    renderExportEffects(null);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    link.href = URL.createObjectURL(blob);
    link.download = `${(payload.title || 'video-os-lite').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    link.textContent = 'Download project brief';
    link.hidden = false;
    status.textContent = error.message;
  }
}

function selectedProvider() {
  const value = document.querySelector('#provider-select')?.value || 'heygen';
  return appState.providers.find((provider) => provider.id === value) || appState.providers[0] || null;
}

function providerBuyerLabel(provider) {
  const labels = {
    heygen: 'Best Quality',
    argil: 'Clone Studio',
    tavus: 'Digital Twin',
    did: 'Fast Talking Head',
  };
  return labels[provider?.id] || provider?.label || provider?.name || 'Provider';
}

function updateFinishCost() {
  const provider = selectedProvider();
  const balance = appState.credits?.balance ?? 0;
  const cost = provider?.cost || 0;
  const balanceEl = document.querySelector('#finish-credit-balance');
  const costEl = document.querySelector('#finish-render-cost');
  const countEl = document.querySelector('#finish-render-count');
  if (balanceEl) balanceEl.textContent = `${balance.toLocaleString()} credits`;
  if (costEl) costEl.textContent = cost ? `${cost} credits` : '-- credits';
  if (countEl) countEl.textContent = cost ? `${Math.floor(balance / cost)} ${providerBuyerLabel(provider).toLowerCase()} render${Math.floor(balance / cost) === 1 ? '' : 's'}` : '-- renders';
}

function renderProviderStatus() {
  const provider = selectedProvider();
  const status = document.querySelector('#provider-status');
  const credits = document.querySelector('#credits-pill');
  const balance = appState.credits?.balance ?? 0;
  credits.textContent = appState.signedIn ? `Credits: ${balance}` : 'Sign in to render';
  if (!provider) {
    status.textContent = 'Provider routing is unavailable.';
    updateFinishCost();
    return;
  }
  const ready = provider.configured ? 'Ready now' : `Needs ${provider.missing.join(', ')}`;
  status.textContent = appState.signedIn ? `${providerBuyerLabel(provider)}: ${provider.cost} credits. ${ready}.` : 'Sign in to use credits and live rendering.';
  updateFinishCost();
}
function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value > 1000000) return `${(value / 1000000).toFixed(1)} MB`;
  if (value > 1000) return `${Math.round(value / 1000)} KB`;
  return `${value} B`;
}

function formatDate(value) {
  if (!value) return 'Just now';
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatResultLabel(value) {
  return String(value || 'Auto').replace(/\.[a-z0-9]+$/i, '').replace(/[:_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function inlineMediaUrl(value) {
  const url = new URL(value, location.origin);
  url.searchParams.set('disposition', 'inline');
  return `${url.pathname}${url.search}`;
}

function setFinalCutState(state, message) {
  const preview = document.querySelector('#preview');
  const card = document.querySelector('#preview-card');
  const stage = document.querySelector('.video-stage');
  preview.dataset.previewState = state;
  document.querySelector('#preview-empty').textContent = message;
  if (state !== 'completed') {
    stage.querySelector('.final-preview-media')?.remove();
    stage.querySelector('.presenter').hidden = false;
    stage.querySelector('.caption').hidden = false;
    card.classList.toggle('empty', state === 'empty');
    document.querySelector('#download-link').hidden = true;
  }
  if (state === 'rendering') setFinalRenderStep('rendering', message);
  if (state === 'failed') setFinalRenderStep('error', message);
}

function bindFinalCutResult(item, options = {}) {
  if (!item?.url || item.status !== 'ready') return false;
  const stage = document.querySelector('.video-stage');
  stage.querySelector('.final-preview-media')?.remove();
  const video = document.createElement('video');
  video.className = 'final-preview-media';
  video.src = inlineMediaUrl(item.url);
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.setAttribute('aria-label', `Play ${item.title || item.filename || 'completed final cut'}`);
  stage.prepend(video);
  stage.querySelector('.presenter').hidden = true;
  stage.querySelector('.caption').hidden = true;
  appState.activeResult = item;
  document.querySelector('#preview').dataset.previewState = 'completed';
  document.querySelector('#preview-card').classList.remove('empty');
  document.querySelector('#preview-empty').textContent = `${item.title || 'Final cut'} is complete and ready to play.`;
  const format = document.querySelector('#export-format');
  if (format && [...format.options].some((option) => option.value === item.format)) format.value = item.format;
  const link = document.querySelector('#download-link');
  link.href = item.url;
  link.download = item.filename || 'video-os-final.mp4';
  link.textContent = `Download ${item.filename || 'final MP4'}`;
  link.hidden = false;
  setFinalRenderStep('ready', item.message || 'Final MP4 ready.');
  if (options.scroll) document.querySelector('#preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
}

function hydrateFinalCutFromResults() {
  const latest = appState.results[0];
  if (latest?.status === 'ready' && latest.url) return bindFinalCutResult(latest);
  if (latest && !['ready', 'failed', 'cancelled'].includes(latest.status)) return setFinalCutState('rendering', `${latest.title || 'Your video'} is still rendering. Refresh safely to recover its status.`);
  if (latest?.status === 'failed') return setFinalCutState('failed', `${latest.title || 'The latest render'} could not be completed. Review the saved project and use the contained retry path when authorized.`);
  if (appState.resultsState === 'signed-out') return setFinalCutState('empty', 'Sign in to recover completed videos in Final Cut Preview.');
  if (appState.resultsState === 'error') return setFinalCutState('failed', 'Video history could not be loaded. Refresh or sign in again; no render was submitted.');
  return setFinalCutState('empty', 'No video yet. Complete a contained render and it will appear here automatically.');
}

function resultCard(item) {
  const status = item.status || item.stage || (item.url ? 'ready' : 'rendering');
  const card = document.createElement('article');
  card.className = `result-card ${status === 'ready' ? 'is-final' : 'is-draft'}`;
  card.dataset.jobId = item.id || '';
  const media = document.createElement('div');
  media.className = `result-media ${item.format || 'mp4'}`;
  if (item.url) {
    const video = document.createElement('video');
    video.src = inlineMediaUrl(item.url);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.setAttribute('aria-label', `Completed preview for ${item.title || item.filename}`);
    media.append(video);
  } else {
    media.innerHTML = '<div class="result-pending">Rendering</div>';
  }
  const badge = document.createElement('span');
  badge.className = `result-badge status-${status}`;
  badge.textContent = status === 'ready' ? 'Final MP4' : status === 'failed' ? 'Needs attention' : status === 'finishing' ? 'Finishing' : 'Rendering';
  media.append(badge);
  const body = document.createElement('div');
  body.className = 'result-body';
  const title = document.createElement('strong');
  title.textContent = item.title || item.scriptTitle || item.filename || 'Video OS render';
  const providerName = item.provider?.name || item.provider || 'HeyGen';
  const meta = document.createElement('span');
  meta.className = 'result-meta';
  meta.textContent = `${providerName} | ${item.format || 'vertical'} | ${item.cost || 0} credits | ${formatDate(item.updatedAt || item.createdAt)}`;
  const talent = document.createElement('span');
  talent.className = 'result-talent';
  talent.textContent = `${item.avatar?.name || item.avatar || 'Selected avatar'} + ${item.voice?.name || item.voice || 'Selected voice'}`;
  const message = document.createElement('span');
  message.className = 'result-message';
  message.textContent = item.message || (status === 'ready' ? 'Ready to download.' : 'Lux is still finishing this video.');
  body.append(title, meta, talent, message);
  const kit = document.createElement('div');
  kit.className = 'result-kit';
  const kitItems = item.effects || item.kit || item.productionKit || {};
  ['music', 'lut', 'cta'].forEach((key) => {
    const chip = document.createElement('span');
    chip.textContent = formatResultLabel(kitItems[key]?.name || kitItems[key]);
    kit.append(chip);
  });
  const actions = document.createElement('div');
  actions.className = 'result-actions';
  if (item.url) {
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'secondary';
    preview.textContent = 'Preview';
    preview.addEventListener('click', () => bindFinalCutResult(item, { scroll: true }));
    const download = document.createElement('a');
    download.className = 'download-link';
    download.href = item.url;
    download.download = item.filename || 'video-os-final.mp4';
    download.textContent = 'Download';
    actions.append(preview, download);
  }
  const regenerate = document.createElement('button');
  regenerate.type = 'button';
  regenerate.className = 'ghost';
  regenerate.textContent = 'Regenerate';
  regenerate.addEventListener('click', () => {
    if (item.title) document.querySelector('input[name="title"]').value = item.title;
    setStep(0);
    document.querySelector('.creator').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  actions.append(regenerate);
  card.append(media, body, kit, actions);
  return card;
}

function renderResultGallery() {
  const target = document.querySelector('#result-gallery');
  const toggle = document.querySelector('#result-gallery-toggle');
  if (!target) return;
  const items = (appState.results || []).slice(0, 30);
  if (!items.length) {
    const messages = {
      'signed-out': ['Sign in to recover your videos', 'Completed account-owned videos will return here and in Final Cut Preview.'],
      error: ['Video history is temporarily unavailable', 'Refresh or sign in again. No new render has been submitted.'],
      empty: ['No final videos yet', 'Your first completed private MP4 will appear here automatically.'],
    };
    const [title, copy] = messages[appState.resultsState] || messages.empty;
    target.innerHTML = `<article class="empty-result" data-results-state="${appState.resultsState}"><strong>${title}</strong><span>${copy}</span></article>`;
    if (toggle) toggle.hidden = true;
    return;
  }
  const visibleCount = Math.min(appState.resultLimit, items.length);
  target.replaceChildren(...items.slice(0, visibleCount).map(resultCard));
  if (toggle) {
    toggle.hidden = items.length <= 6;
    toggle.textContent = visibleCount >= items.length ? 'Show recent six' : `View all ${items.length} videos`;
    toggle.setAttribute('aria-expanded', String(visibleCount >= items.length));
  }
}

async function loadResults() {
  if (!canUseHostedApi() || !appState.signedIn) {
    appState.results = [];
    appState.resultsState = 'signed-out';
    renderResultGallery();
    hydrateFinalCutFromResults();
    return;
  }
  try {
    appState.resultsState = 'loading';
    const data = await getJson('/api/video-os-lite/results');
    appState.results = data.results || [];
    appState.resultsState = appState.results.length ? 'ready' : 'empty';
  } catch {
    appState.results = [];
    appState.resultsState = 'error';
  }
  renderResultGallery();
  hydrateFinalCutFromResults();
  rerenderLibrary('avatar');
}

function renderPricing() {
  const balance = appState.credits?.balance ?? 0;
  const providers = appState.providers || [];
  const readyProviders = providers.filter((provider) => provider.configured);
  const cheapestReady = readyProviders.length ? Math.min(...readyProviders.map((provider) => provider.cost)) : 0;
  const heygen = providers.find((provider) => provider.id === 'heygen') || readyProviders[0] || providers[0];
  const balanceEl = document.querySelector('#pricing-balance');
  if (balanceEl) balanceEl.textContent = `${balance.toLocaleString()} credits`;
  const buyingPower = document.querySelector('#pricing-buying-power');
  if (buyingPower) {
    const renderCost = heygen?.cost || cheapestReady || 90;
    const count = Math.floor(balance / renderCost);
    buyingPower.textContent = count > 0 ? `Enough for ${count} ${heygen?.name || 'provider'} render${count === 1 ? '' : 's'}.` : 'Add credits to unlock live provider renders.';
  }
  const renderCost = document.querySelector('#pricing-render-cost');
  if (renderCost) {
    const costSource = readyProviders.length ? readyProviders : providers;
    const costs = costSource.map((p) => p.cost || 0).filter(Boolean);
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    renderCost.textContent = minCost === maxCost ? `${minCost} credits` : `${minCost || 45}-${maxCost || 120} credits`;
  }
  const providerPricing = document.querySelector('#provider-pricing');
  if (providerPricing) {
    providerPricing.textContent = readyProviders.length
      ? `${readyProviders.map((provider) => `${provider.name} ${provider.cost}`).join(' | ')} ready now.`
      : 'Connect a provider to start live avatar rendering.';
  }
  const recommendation = document.querySelector('#pricing-recommendation');
  const recommendationCopy = document.querySelector('#pricing-recommendation-copy');
  const packageCredits = balance < 500 ? 500 : balance < 1000 ? 1000 : 2000;
  if (recommendation) recommendation.textContent = `${packageCredits.toLocaleString()} credits`;
  if (recommendationCopy) {
    const renderCost = heygen?.cost || cheapestReady || 90;
    recommendationCopy.textContent = `Adds about ${Math.floor(packageCredits / renderCost)} ${heygen?.name || 'provider'} renders.`;
  }
  const list = document.querySelector('#provider-cost-list');
  if (list) {
    list.replaceChildren(...providers.map((provider) => {
      const item = document.createElement('article');
      item.className = provider.configured ? 'is-ready' : 'needs-setup';
      const canRender = provider.cost ? Math.floor(balance / provider.cost) : 0;
      item.innerHTML = `<strong>${provider.name}</strong><span>${provider.cost} credits</span><small>${provider.configured ? `${canRender} available now` : `Needs ${provider.missing?.join(', ') || 'setup'}`}</small>`;
      return item;
    }));
  }
}
async function loadProviders() {
  const select = document.querySelector('#provider-select');
  try {
    if (!canUseHostedApi()) throw new Error('Static mode');
    const data = await getJson('/api/video-os-lite/providers');
    appState.providers = data.providers || [];
    appState.account = data.account ? data : appState.account;
    appState.credits = data.credits || { balance: 0 };
  } catch {
    appState.providers = publicDemoProviders;
    appState.credits = publicDemoAccount.credits;
    appState.account = publicDemoAccount;
  }
  select.replaceChildren(...appState.providers.map((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = `${providerBuyerLabel(provider)} (${provider.cost} credits)`;
    return option;
  }));
  renderProviderStatus();
  renderPricing();
  updateFinishCost();
}

async function addCredits(quantity = 1) {
  if (!appState.signedIn) { showToast('Sign in before adding credits.'); openAuthModal(); return; }
  const packageQuantity = Math.max(1, Number(quantity) || 1);
  try {
    if (!canUseHostedApi()) throw new Error('Stripe checkout needs the Video OS engine.');
    const data = await getJson('/api/video-os-lite/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: location.origin, quantity: packageQuantity }),
    });
    if (!data.url) throw new Error('Stripe did not return a checkout URL.');
    location.href = data.url;
  } catch (error) {
    showToast(error.message);
  }
}

function renderExportEffects(effects) {
  const target = document.querySelector('#export-effects');
  if (!target) return;
  if (!effects) {
    target.replaceChildren();
    return;
  }
  const rows = [
    ['Music', effects.music],
    ['Background', effects.background],
    ['Color', effects.lut],
    ['CTA', effects.cta],
    ['Overlay', effects.overlay],
  ];
  target.replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    row.innerHTML = `<span>${label}</span><strong>${value || 'Auto'}</strong>`;
    return row;
  }));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

async function uploadAvatarSource(type) {
  if (!appState.signedIn) { showToast('Sign in before uploading avatar assets.'); openAuthModal(); return; }
  const isTwin = type === 'digital_twin';
  const fileInput = document.querySelector(isTwin ? '#digital-twin-file' : '#photo-avatar-file');
  const urlInput = document.querySelector(isTwin ? '#digital-twin-url' : '#photo-avatar-url');
  const status = document.querySelector(isTwin ? '#digital-upload-status' : '#photo-upload-status');
  const file = fileInput?.files?.[0];
  if (!file) return;
  status.textContent = `Uploading ${file.name}...`;
  try {
    if (!canUseHostedApi()) throw new Error('Uploads need the Video OS engine.');
    if (file.size > 20_000_000) throw new Error('Use a file under 20 MB for the local MVP.');
    const dataUrl = await readFileAsDataUrl(file);
    const data = await getJson('/api/video-os-lite/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: type, name: file.name, dataUrl }),
    });
    appState.uploadedAsset = data;
    urlInput.value = data.previewUrl || '';
    status.textContent = `${data.message} ${data.providerUrl ? 'Provider-ready.' : 'Staged locally.'}`;
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message);
  }
}
function setRecoveryAction(id, visible, disabled = false) {
  const button = document.querySelector(id);
  if (!button) return;
  button.hidden = !visible;
  button.disabled = disabled;
}

function resetFinalRenderStep() {
  appState.providerRender = null;
  appState.finalizeAttempts = 0;
  stopAutoFinalize();
  setRecoveryAction('#render-provider', false, true);
  setRecoveryAction('#finalize-render', false, true);
  document.querySelector('#download-link').hidden = true;
  document.querySelector('#export-status').textContent = '';
  document.querySelectorAll('[data-render-step]').forEach((item) => item.classList.remove('active', 'done', 'error'));
}
function setFinalRenderStep(step, message) {
  const order = ['submitted', 'rendering', 'finishing', 'ready'];
  const index = order.indexOf(step);
  document.querySelectorAll('[data-render-step]').forEach((item) => {
    const itemIndex = order.indexOf(item.dataset.renderStep);
    item.classList.toggle('active', item.dataset.renderStep === step);
    item.classList.toggle('done', itemIndex >= 0 && index >= 0 && itemIndex < index);
    item.classList.toggle('error', step === 'error' && item.dataset.renderStep !== 'ready');
  });
  if (step === 'ready') {
    document.querySelectorAll('[data-render-step]').forEach((item) => item.classList.add('done'));
  }
  if (message) document.querySelector('#export-status').textContent = message;
}

function stopAutoFinalize() {
  if (appState.finalizeTimer) {
    window.clearTimeout(appState.finalizeTimer);
    appState.finalizeTimer = null;
  }
}

function scheduleAutoFinalize(delay = 12000) {
  stopAutoFinalize();
  appState.finalizeTimer = window.setTimeout(() => {
    finalizeProviderRender({ automatic: true });
  }, delay);
}

async function finishHostedProviderMp4(payload, render, sourceData) {
  if (!sourceData?.url || canUseLocalApi()) return sourceData;
  setFinalRenderStep('finishing', 'Applying hosted color, CTA, and export finish...');
  return getJson('/api/video-os-lite/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      provider: render.provider?.id || selectedProvider()?.id,
      providerJobId: render.providerJobId,
      sourceUrl: sourceData.url,
      format: document.querySelector('#export-format').value,
      productionKit: appState.productionKit || payload.productionKit,
    }),
  });
}
async function finalizeProviderRender(options = {}) {
  if (appState.finalizing) return null;
  const automatic = Boolean(options.automatic);
  const status = document.querySelector('#export-status');
  const link = document.querySelector('#download-link');
  const payload = appState.generated;
  const render = appState.providerRender;
  if (!payload || !render) return null;
  appState.finalizing = true;
  stopAutoFinalize();
  setRecoveryAction('#finalize-render', false, true);
  setFinalRenderStep(automatic ? 'rendering' : 'finishing', automatic ? 'Checking provider render status...' : 'Applying production kit to the provider render...');
  link.hidden = true;
  try {
    if (!canUseHostedApi()) throw new Error('Final render needs the Video OS engine.');
    let data = await getJson('/api/video-os-lite/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: render.job?.id }),
    });
    if (data.ready === false) {
      appState.finalizeAttempts += 1;
      const waitSeconds = Math.min(30, 8 + (appState.finalizeAttempts * 4));
      setFinalRenderStep('rendering', `${data.message || 'Avatar video is still rendering.'} Lux will finish the MP4 automatically.`);
      scheduleAutoFinalize(waitSeconds * 1000);
      return data;
    }
    stopAutoFinalize();
    appState.finalizeAttempts = 0;
    link.href = data.url;
    link.download = data.filename;
    link.textContent = `Download final ${data.filename}`;
    link.hidden = false;
    renderExportEffects(data.effects);
    setFinalRenderStep('ready', data.message || 'Final MP4 ready.');
    setRecoveryAction('#render-provider', false, true);
    setRecoveryAction('#finalize-render', false, true);
    loadResults();
    return data;
  } catch (error) {
    const message = `${error.message} You can retry finalizing or download a draft MP4.`;
    status.textContent = message;
    setFinalRenderStep('error', message);
    setRecoveryAction('#finalize-render', true, false);
    showToast(error.message);
    if (!automatic) stopAutoFinalize();
    return null;
  } finally {
    appState.finalizing = false;
  }
}
async function renderWithProvider(options = {}) {
  if (appState.renderLocked) return null;
  const automatic = Boolean(options.automatic);
  const status = document.querySelector('#export-status');
  const payload = appState.generated;
  const provider = selectedProvider();
  if (!payload || !provider) return null;
  appState.renderLocked = true;
  stopAutoFinalize();
  appState.finalizeAttempts = 0;
  setRecoveryAction('#render-provider', false, true);
  setRecoveryAction('#finalize-render', false, true);
  status.textContent = `Submitting to ${providerBuyerLabel(provider)}...`;
  setFinalRenderStep('submitted', `Submitting to ${providerBuyerLabel(provider)}...`);
  try {
    if (!canUseHostedApi()) throw new Error('Live render needs the Video OS engine.');
    const requestPayload = { idempotencyKey: appState.renderIdempotencyKey || crypto.randomUUID(), projectId: payload.projectId, provider: provider.id, title: payload.title || 'Video OS', format: document.querySelector('#export-format').value, script: payload.script || payload.scriptInput, productionKit: appState.productionKit || {} };
    if (appState.identityId) {
      requestPayload.identityId = appState.identityId;
      if (appState.voiceSelectionExplicit && payload.voice?.source === 'heygen') requestPayload.voice = { voiceId: payload.voice.voiceId || payload.voice.id, locale: payload.voice.locale };
    }
    else {
      requestPayload.avatar = { avatarId: payload.avatar?.avatarId || payload.avatar?.id };
      requestPayload.voice = { voiceId: payload.voice?.voiceId || payload.voice?.id, locale: payload.voice?.locale };
    }
    const data = await getJson('/api/video-os-lite/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });
    appState.credits = data.credits;
    appState.providerRender = data;
    renderProviderStatus();
    renderPricing();
    const jobLabel = data.job?.id ? `: ${data.job.id}` : '';
    setFinalRenderStep('submitted', `${data.provider.name} render submitted${jobLabel}. Lux will finish the final MP4 automatically.`);
    scheduleAutoFinalize(automatic ? 3000 : 1000);
    showToast('Final video is rendering automatically.');
    return data;
  } catch (error) {
    const message = `${error.message} You can retry the live render or download a draft MP4.`;
    status.textContent = message;
    setFinalRenderStep('error', message);
    setRecoveryAction('#render-provider', true, false);
    showToast(error.message);
    return null;
  } finally {
    appState.renderLocked = false;
  }
}
const assetVisuals = {
  music: {
    label: 'Soundtrack',
    title: 'Music beds',
    copy: 'Licensed-feeling beds that make short-form edits feel finished before a manual edit pass.',
    accent: 'blue',
  },
  backgrounds: {
    label: 'Motion',
    title: 'Video backgrounds',
    copy: 'Clean movement and creator-style backdrops for hooks, product moments, and explainer scenes.',
    accent: 'cyan',
  },
  luts: {
    label: 'Color',
    title: 'LUT color grades',
    copy: 'Fast visual polish for studio contrast, bright social clips, and clean creator-style output.',
    accent: 'violet',
  },
  cta: {
    label: 'Conversion',
    title: 'CTA motion',
    copy: 'Like, subscribe, arrow, and end-frame prompts built for buyer action without clutter.',
    accent: 'green',
  },
  'gif-reactions': {
    label: 'Social proof',
    title: 'Animated overlays',
    copy: 'Lightweight reaction stickers that add momentum to UGC, testimonials, and social ads.',
    accent: 'pink',
  },
};

const gifPreviewMap = {
  '78-Hundred-Points.gif': 'assets/overlays/78-Hundred-Points.gif',
  '77-Heart-2.gif': 'assets/overlays/77-Heart-2.gif',
  '75-Folded-Hands.gif': 'assets/overlays/75-Folded-Hands.gif',
  '74-Thumbs-Up.gif': 'assets/overlays/74-Thumbs-Up.gif',
  '72-Clapping-Hands.gif': 'assets/overlays/72-Clapping-Hands.gif',
};

function assetCategory(asset) {
  const haystack = `${asset.id || ''} ${asset.name || ''} ${asset.type || ''}`.toLowerCase();
  if (haystack.includes('gif') || haystack.includes('sticker') || haystack.includes('reaction') || haystack.includes('overlay')) return 'gif-reactions';
  if (haystack.includes('music') || haystack.includes('audio') || haystack.includes('sound')) return 'music';
  if (haystack.includes('lut') || haystack.includes('color')) return 'luts';
  if (haystack.includes('cta') || haystack.includes('subscribe') || haystack.includes('arrow')) return 'cta';
  if (haystack.includes('background') || haystack.includes('video')) return 'backgrounds';
  return asset.id || 'default';
}

function assetMeta(asset) {
  const category = assetCategory(asset);
  return assetVisuals[category] || {
    label: asset.type || 'Asset',
    title: asset.name || 'Creative asset',
    copy: 'Ready-to-use production material for faster AI video output.',
    accent: 'blue',
  };
}

function renderAssetPreview(asset, examples) {
  const category = assetCategory(asset);
  if (category === 'gif-reactions') {
    const gifs = examples.filter((name) => gifPreviewMap[name]).slice(0, 3);
    return gifs.length ? `<div class="asset-gif-strip" aria-label="Animated overlay previews">${gifs.map((name) => `<img src="${gifPreviewMap[name]}" alt="${escapeHtml(name.replace(/[-_]/g, ' ').replace(/\.gif$/i, ''))}" loading="lazy">`).join('')}</div>` : '<div class="asset-preview asset-preview-social"><span>GIF</span></div>';
  }
  const previewLabel = {
    music: 'Audio mix',
    backgrounds: 'Motion bed',
    luts: 'Color grade',
    cta: 'CTA motion',
  }[category] || (asset.type || 'Asset');
  return `<div class="asset-preview asset-preview-${escapeHtml(category || 'default')}"><span>${escapeHtml(previewLabel)}</span></div>`;
}

function renderAssetCard(asset) {
  const meta = assetMeta(asset);
  const examples = (asset.examples || []).slice(0, 4);
  const link = document.createElement('a');
  link.className = `asset-card asset-card-${meta.accent}`;
  link.href = asset.url || '#';
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.innerHTML = `
    <div class="asset-card-top">
      <small class="asset-type-badge">${escapeHtml(meta.label)}</small>
      <span class="asset-count">${examples.length || 1} ready</span>
    </div>
    ${renderAssetPreview(asset, examples)}
    <strong>${escapeHtml(meta.title)}</strong>
    <p>${escapeHtml(meta.copy)}</p>
    <div class="asset-chip-row">${examples.slice(0, 3).map((name) => `<span>${escapeHtml(name.replace(/\.[a-z0-9]+$/i, ''))}</span>`).join('')}</div>
    <span class="asset-card-cta">Open source folder</span>
  `;
  return link;
}

function renderAccount() {
  if (!appState.account) return;
  syncAuthUi();
  const account = appState.account.account || {};
  const subscription = account.subscription || {};
  const credits = appState.account.credits || appState.credits || { balance: 0 };
  const sessionSecurity = appState.account.security || appState.account.session?.security || { configured: false, message: 'Set VIDEO_OS_SESSION_SECRET before launch.' };
  const rows = [
    ['Account', account.name || 'Client Account'],
    ['Access', appState.signedIn ? 'Signed in' : 'Preview mode'],
    ['Plan', subscription.plan || 'Lite MVP'],
    ['Session', sessionSecurity.status === 'guarded' ? 'Guarded' : (sessionSecurity.configured ? 'Launch ready' : 'Setup needed'), sessionSecurity.message || ''],
  ];
  document.querySelector('#account-summary').replaceChildren(...rows.map(([label, value, note]) => {
    const row = document.createElement('div');
    if (note) row.className = 'summary-warning';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const valueEl = document.createElement('strong');
    valueEl.textContent = value;
    row.replaceChildren(labelEl, valueEl);
    if (note) {
      const noteEl = document.createElement('small');
      noteEl.textContent = note;
      row.appendChild(noteEl);
    }
    return row;
  }));
  const libraries = (appState.account.assetLibraries && appState.account.assetLibraries.length ? appState.account.assetLibraries : (appState.assetLibraries && appState.assetLibraries.length ? appState.assetLibraries : publicDemoAccount.assetLibraries)) || [];
  document.querySelector('#asset-list').replaceChildren(...libraries.map(renderAssetCard));
}

async function loadAccount() {
  try {
    let data;
    if (canUseHostedApi()) {
      data = await getJson('/api/video-os-lite/session');
      appState.signedIn = Boolean(data.signedIn);
      appState.userEmail = data.email || null;
      if (!appState.signedIn) data = await getJson('/api/video-os-lite/providers');
    } else {
      data = await getJson('/api/video-os-lite/account');
      appState.signedIn = true;
    }
    appState.account = data;
    appState.credits = data.credits;
    if (data.providers) appState.providers = data.providers;
    renderProviderStatus();
    renderPricing();
    renderAccount();
    await loadMyCast();
    await loadResults();
  } catch {
    if (!appState.account) appState.account = publicDemoAccount;
    if (!appState.credits) appState.credits = publicDemoAccount.credits;
    renderProviderStatus();
    renderPricing();
    renderAccount();
  }
}


function syncAuthUi() {
  const modal = document.querySelector('#auth-modal');
  document.querySelectorAll('[data-auth-signed-out]').forEach((element) => { element.hidden = appState.signedIn; });
  const sessionSummary = document.querySelector('#auth-session-summary');
  if (sessionSummary) sessionSummary.hidden = !appState.signedIn;
  const sessionEmail = document.querySelector('#auth-session-email');
  if (sessionEmail) sessionEmail.textContent = appState.userEmail || appState.account?.account?.name || 'Your LUX account';
  const signOutButton = document.querySelector('#sign-out');
  if (signOutButton) signOutButton.hidden = !appState.signedIn;
  document.querySelectorAll('#open-login, [data-open-login]').forEach((button) => {
    button.dataset.signedOutLabel ||= button.textContent.trim();
    button.textContent = appState.signedIn ? (button.dataset.signedInLabel || 'Account') : button.dataset.signedOutLabel;
    button.setAttribute('aria-expanded', String(Boolean(modal && !modal.hidden)));
  });
}

function openAuthModal() {
  const modal = document.querySelector('#auth-modal');
  if (!modal) return;
  authOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  syncAuthUi();
  if (!authPending) setAuthStatus(appState.signedIn ? 'Your workspace session is active.' : '', 'idle');
  setTimeout(() => document.querySelector(appState.signedIn ? '#sign-out' : '#password-username')?.focus(), 0);
}

function closeAuthModal() {
  const modal = document.querySelector('#auth-modal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  syncAuthUi();
  authOpener?.focus?.();
  authOpener = null;
}

function setAuthStatus(message, state = 'idle') {
  const status = document.querySelector('#auth-status');
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
  status.setAttribute('role', state === 'error' ? 'alert' : 'status');
}

function setAuthPending(method, pending) {
  authPending = pending;
  document.querySelectorAll('#password-login-form input, #password-login-form button, #magic-link-form input, #magic-link-form button').forEach((control) => { control.disabled = pending; });
  const signOutButton = document.querySelector('#sign-out');
  if (signOutButton) signOutButton.disabled = pending;
  const passwordButton = document.querySelector('#password-login');
  const magicButton = document.querySelector('#send-magic-link');
  if (passwordButton) passwordButton.textContent = pending && method === 'password' ? 'Signing in…' : 'Sign in to workspace';
  if (magicButton) magicButton.textContent = pending && method === 'magic' ? 'Sending link…' : 'Send sign-in link';
  if (pending) document.querySelector('#auth-retry').hidden = true;
}

function showAuthFailure(error, retryAction) {
  authLastAction = retryAction;
  const fallback = error?.code === 'network_unavailable'
    ? 'We couldn’t reach Video OS. Check your connection, refresh the page, and try again.'
    : 'Sign-in could not be completed. Review your details and try again.';
  const message = String(error?.message || fallback).replace(/^Failed to fetch$/i, fallback);
  setAuthStatus(message, 'error');
  const retry = document.querySelector('#auth-retry');
  retry.hidden = false;
  showToast(message);
}

async function passwordLogin() {
  const formElement = document.querySelector('#password-login-form');
  if (!formElement?.reportValidity()) return;
  const username = document.querySelector('#password-username')?.value.trim();
  const password = document.querySelector('#password-password')?.value;
  const accessType = document.querySelector('input[name="access-type"]:checked')?.value || 'demo';
  setAuthPending('password', true);
  setAuthStatus('Signing in to the ' + accessType + ' workspace...', 'pending');
  try {
    const data = await getJson('/api/video-os-lite/password-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessType, username, password }),
    });
    appState.signedIn = true;
    appState.userEmail = data.email || username;
    appState.account = data;
    appState.credits = data.credits;
    authLastAction = null;
    document.querySelector('#auth-retry').hidden = true;
    setAuthStatus(data.message || 'Signed in. Live rendering is ready.', 'success');
    await loadProviders();
    await loadMyCast().catch(() => {});
    await restoreLatestProject().catch(() => {});
    consumeIdentitySelection();
    await loadResults().catch(() => {});
    renderAccount();
    closeAuthModal();
    showToast('Signed in. You can render videos now.');
  } catch (error) {
    showAuthFailure(error, passwordLogin);
  } finally {
    setAuthPending('password', false);
  }
}

async function requestMagicLink() {
  const formElement = document.querySelector('#magic-link-form');
  if (!formElement?.reportValidity()) return;
  const email = document.querySelector('#auth-email')?.value.trim();
  setAuthPending('magic', true);
  setAuthStatus('Sending your secure link...', 'pending');
  try {
    const data = await getJson('/api/video-os-lite/auth-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, origin: location.origin }),
    });
    authLastAction = null;
    document.querySelector('#auth-retry').hidden = true;
    setAuthStatus('Check your inbox at ' + (data.email || email) + '. The link expires in 15 minutes.', 'success');
  } catch (error) {
    showAuthFailure(error, requestMagicLink);
  } finally {
    setAuthPending('magic', false);
  }
}

async function signOut() {
  setAuthPending('signout', true);
  setAuthStatus('Signing out…', 'pending');
  try {
    await getJson('/api/video-os-lite/session', { method: 'POST' });
    appState.signedIn = false;
    appState.userEmail = null;
    appState.results = [];
    appState.identities = [];
    appState.identityId = null;
    appState.project = null;
    appState.avatar = null;
    appState.voice = null;
    appState.voiceSelectionExplicit = false;
    authLastAction = null;
    renderMyCast();
    renderFeaturedCast();
    renderOptions('avatar');
    renderOptions('voice');
    await loadProviders();
    await loadAccount();
    renderResultGallery();
    closeAuthModal();
    showToast('Signed out.');
  } catch (error) {
    showAuthFailure(error, signOut);
  } finally {
    setAuthPending('signout', false);
    syncAuthUi();
  }
}

function consumeAuthReturn() {
  const url = new URL(location.href);
  const returnedFromAuth = url.searchParams.get('signed_in') === '1' || url.searchParams.get('ceo_access') === '1';
  if (!returnedFromAuth) return;
  url.searchParams.delete('signed_in');
  url.searchParams.delete('ceo_access');
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  if (appState.signedIn) {
    setAuthStatus('Email sign-in complete. Your workspace is ready.', 'success');
    showToast('Email sign-in complete. Your workspace is ready.');
    syncAuthUi();
    return;
  }
  openAuthModal();
  setAuthStatus('The sign-in link could not be confirmed. Request a new link and try again.', 'error');
}
async function createAvatarBuild(type) {
  if (!appState.signedIn) { showToast('Sign in before creating avatars.'); openAuthModal(); return; }
  const isTwin = type === 'digital_twin';
  const name = document.querySelector(isTwin ? '#digital-twin-name' : '#photo-avatar-name').value.trim();
  const fileUrl = document.querySelector(isTwin ? '#digital-twin-url' : '#photo-avatar-url').value.trim();
  const consent = document.querySelector(isTwin ? '#digital-twin-consent' : '#photo-avatar-consent').checked;
  try {
    if (!canUseLocalApi()) throw new Error('Avatar builds need the local Video OS engine.');
    const data = await getJson('/api/video-os-lite/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, name, fileUrl, consent }),
    });
    appState.credits = data.credits;
    showToast(data.message || `${isTwin ? 'Digital twin' : 'Photo avatar'} submitted.`);
    document.querySelector(isTwin ? '#digital-upload-status' : '#photo-upload-status').textContent = data.message || 'Avatar build submitted.';
    await loadAccount();
  } catch (error) {
    showToast(error.message);
  }
}
function applyTemplateGoal(goal) {
  const input = document.querySelector(`input[name="goalType"][value="${goal}"]`);
  if (input) input.checked = true;
  const title = document.querySelector('input[name="title"]');
  const audience = document.querySelector('input[name="audience"]');
  if (title && !title.value.trim()) title.value = `${goal} for my offer`;
  if (audience && !audience.value.trim()) audience.value = 'Potential customers';
  setStep(0);
  document.querySelector('.creator').scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast(`${goal} template selected.`);
}
document.querySelector('[data-start]').addEventListener('click', () => document.querySelector('.creator').scrollIntoView({ behavior: 'smooth' }));
document.querySelectorAll('[data-template-goal]').forEach((button) => button.addEventListener('click', () => applyTemplateGoal(button.dataset.templateGoal)));
document.querySelector('#next-step').addEventListener('click', () => {
  if (appState.step === panels.length - 1) {
    document.querySelector('#preview').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  if (requireCurrentStep()) setStep(appState.step + 1);
});
document.querySelector('#back-step').addEventListener('click', () => setStep(appState.step - 1));
stepButtons.forEach((button) => button.addEventListener('click', () => {
  const target = Number(button.dataset.stepJump);
  if (target <= appState.step || requireCurrentStep()) setStep(target);
}));
document.querySelector('#avatar-search').addEventListener('input', () => { appState.visible.avatar = 20; rerenderLibrary('avatar'); });
document.querySelector('#voice-search').addEventListener('input', () => { appState.visible.voice = 20; rerenderLibrary('voice'); });
document.querySelector('#avatar-more').addEventListener('click', () => { appState.visible.avatar = 20; rerenderLibrary('avatar'); });
document.querySelector('#voice-more').addEventListener('click', () => { appState.visible.voice += 20; rerenderLibrary('voice'); });
document.querySelector('#generate-script').addEventListener('click', generateScript);
document.querySelector('#tighten-script').addEventListener('click', tightenScript);
document.querySelector('#generate-video').addEventListener('click', generateVideo);
document.querySelector('#provider-select').addEventListener('change', renderProviderStatus);
document.querySelector('#add-credits').addEventListener('click', addCredits);
document.querySelector('#account-add-credits').addEventListener('click', () => document.querySelector('#credits').scrollIntoView({ behavior: 'smooth', block: 'start' }));
document.querySelector('#pricing-add-credits').addEventListener('click', () => addCredits(1));
document.querySelector('#open-login').addEventListener('click', openAuthModal);
document.querySelectorAll('[data-open-login]').forEach((button) => button.addEventListener('click', openAuthModal));
document.querySelector('#close-login').addEventListener('click', closeAuthModal);
document.querySelector('[data-close-login]').addEventListener('click', closeAuthModal);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAuthModal(); });
document.querySelector('#password-login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  passwordLogin();
});
document.querySelector('#magic-link-form').addEventListener('submit', (event) => {
  event.preventDefault();
  requestMagicLink();
});
document.querySelector('#sign-out').addEventListener('click', signOut);
document.querySelector('#auth-retry').addEventListener('click', () => {
  if (!authPending && authLastAction) authLastAction();
});
document.querySelector('#result-gallery-toggle').addEventListener('click', () => {
  appState.resultLimit = appState.resultLimit > 6 ? 6 : 30;
  renderResultGallery();
});
document.querySelectorAll('[data-credit-quantity]').forEach((button) => button.addEventListener('click', () => addCredits(button.dataset.creditQuantity)));
document.querySelector('#photo-avatar-file').addEventListener('change', () => uploadAvatarSource('photo'));
document.querySelector('#digital-twin-file').addEventListener('change', () => uploadAvatarSource('digital_twin'));
document.querySelector('#create-photo-avatar').addEventListener('click', () => createAvatarBuild('photo'));
document.querySelector('#create-digital-twin').addEventListener('click', () => createAvatarBuild('digital_twin'));
document.querySelector('#render-provider').addEventListener('click', renderWithProvider);
document.querySelector('#finalize-render').addEventListener('click', finalizeProviderRender);
document.querySelector('#export-mp4').addEventListener('click', exportMp4);
form.addEventListener('input', () => { if (appState.step === panels.length - 1) renderSummary(); });
document.querySelector('#export-format').addEventListener('change', () => {
  if (!appState.providerRender) return;
  appState.finalizeAttempts = 0;
  setFinalRenderStep('submitted', 'Format changed. Lux will finish this size automatically.');
  scheduleAutoFinalize(500);
});
setStep(0);
Promise.all([loadTalent(), loadProviders(), loadAssetCatalog(), loadAccount()]).then(async () => {
  consumeAuthReturn();
  await restoreLatestProject().catch(() => {});
  consumeIdentitySelection();
  await loadResults();
});
































