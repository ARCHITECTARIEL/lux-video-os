const videoPath = './video-os.json';
let state = null;
const gateCode = '1111';
const localProjectsKey = 'luxVideoOsLocalProjects';
const canUseLocalApi = () => ['127.0.0.1', 'localhost', ''].includes(location.hostname);
const workspacePanels = ['create', 'discover', 'projects', 'library', 'ops', 'admin'];
let discoverConfigDraft = null;
let projectSearchText = '';
let projectFilterMode = 'active';
const projectStatusLabels = {
  draft: 'Draft saved',
  review_required: 'Script ready for review',
  approved: 'Approved for handoff',
  render_queued: 'Render queued',
  rendering: 'Rendering',
  qc_required: 'QC required',
  rendered: 'Rendered',
  published: 'Published',
  failed: 'Failed',
  quarantined: 'Needs manual review',
};

function setWorkspace(name) {
  const active = workspacePanels.includes(name) ? name : 'create';
  document.querySelectorAll('[data-workspace-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.workspaceTab === active);
  });
  document.querySelectorAll('[data-workspace-link]').forEach((link) => {
    link.classList.toggle('active', link.dataset.workspaceLink === active);
  });
  document.querySelectorAll('[data-workspace-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.workspacePanel === active);
  });
}

function workspaceFromHash(hash = location.hash) {
  const target = String(hash || '').replace(/^#/, '');
  const map = {
    studio: 'create',
    trends: 'discover',
    'projects-panel': 'projects',
    'library-panel': 'library',
    'ops-panel': 'ops',
    'admin-panel': 'admin',
  };
  return map[target] || 'create';
}

function initWorkspaceTabs() {
  document.querySelectorAll('[data-workspace-tab]').forEach((button) => {
    button.addEventListener('click', () => setWorkspace(button.dataset.workspaceTab));
  });
  document.querySelectorAll('[data-workspace-link]').forEach((link) => {
    link.addEventListener('click', () => setWorkspace(link.dataset.workspaceLink));
  });
  setWorkspace(workspaceFromHash());
  window.addEventListener('hashchange', () => setWorkspace(workspaceFromHash()));
}

function setModeBanner(isLocal) {
  const banner = document.querySelector('#mode-banner');
  if (!banner) return;
  banner.classList.toggle('local-mode', isLocal);
  banner.querySelector('strong').textContent = isLocal ? 'Local Control Plane' : 'Hosted MVP Mode';
  banner.querySelector('span').textContent = isLocal
    ? 'Durable persistence, workers, HeyGen actions, trend scans, archive, and feedback storage are available on this local server.'
    : 'Projects and scripts created on this Vercel page are saved in this browser only. Local workers, HeyGen, archive, trend scans, and durable persistence run in the local Video OS control plane.';
}

function unlockOs() {
  sessionStorage.setItem('luxVideoOsUnlocked', 'true');
  document.body.classList.remove('locked');
  document.body.classList.add('unlocked');
  document.querySelector('#gate-code')?.blur();
}

function initGate() {
  const form = document.querySelector('#gate-form');
  const message = document.querySelector('#gate-message');
  if (sessionStorage.getItem('luxVideoOsUnlocked') === 'true') {
    unlockOs();
    return;
  }
  document.querySelector('#gate-code')?.focus();
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = new FormData(form).get('code');
    if (String(code).trim() === gateCode) {
      unlockOs();
      return;
    }
    message.textContent = 'Incorrect code. Ask the LUX project owner for MVP access.';
    form.classList.add('gate-error');
    setTimeout(() => form.classList.remove('gate-error'), 420);
  });
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

async function api(path, payload) {
  const response = await fetch(`/api/video-os${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The live Vercel MVP is running in static mode. Use the local app for durable worker/API actions, or use the browser-local fallback for project/script drafts.');
  }
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  if (data.videoOs) render(data.videoOs);
  return data;
}

function readLocalProjects() {
  try {
    return JSON.parse(localStorage.getItem(localProjectsKey) || '[]');
  } catch {
    return [];
  }
}

function writeLocalProjects(projects) {
  localStorage.setItem(localProjectsKey, JSON.stringify(projects));
}

function flashNotice(title, detail, tone = 'success') {
  const notice = document.querySelector('#action-notice');
  if (!notice) return;
  notice.hidden = false;
  notice.className = `action-notice ${tone}`;
  document.querySelector('#action-notice-title').textContent = title;
  document.querySelector('#action-notice-detail').textContent = detail;
  window.clearTimeout(flashNotice.timeout);
  flashNotice.timeout = window.setTimeout(() => {
    notice.classList.add('settled');
  }, 2400);
}

function upsertLocalProject(project) {
  const projects = readLocalProjects();
  const index = projects.findIndex((item) => item.id === project.id);
  const next = index >= 0
    ? projects.map((item) => item.id === project.id ? project : item)
    : [project, ...projects];
  writeLocalProjects(next);
}

function slug(value) {
  return String(value || 'video')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'video';
}

function enrichWithLocalProjects(videoOs) {
  const localProjects = readLocalProjects();
  if (!localProjects.length) return videoOs;
  const localIds = new Set(localProjects.map((project) => project.id));
  return {
    ...videoOs,
    projects: [
      ...localProjects,
      ...(videoOs.projects ?? []).filter((project) => !localIds.has(project.id)),
    ],
  };
}

function localSceneRoutes(project) {
  const hasN8n = /n8n|workflow|automation|orchestration/i.test(`${project.topic} ${project.goal}`);
  const hasManager = /manager|coach|quality|dashboard/i.test(`${project.audience} ${project.goal}`);
  const base = [
    ['cold_open', 'Cold Open / Narrative Hook', 'Set the promise and why this matters now.'],
    ['transcript_flow', 'Fathom Transcript Flow', 'Show source intelligence becoming structured signal.'],
    ['kpi_proof', 'Dashboard / KPI Proof', 'Show what the team can measure and act on.'],
    ['cta', 'CTA / Feedback Ask', 'Ask the team for feedback and next use cases.'],
  ];
  if (hasN8n) base.splice(2, 0, ['n8n_logic', 'n8n Orchestration Logic', 'Show how automation moves the work forward.']);
  if (hasManager) base.splice(-1, 0, ['manager_coaching', 'Manager Coaching Insight', 'Translate the dashboard into coaching behavior.']);
  const routeMap = {
    cold_open: ['Static Background 1.mp4', 'Creative _ Teal Shadows _ Strong.cube', 'cinematic fade with subtle light sweep'],
    transcript_flow: ['Kinetic Dots background (white).mp4', 'iPhone 13 _ Anamorphic Levels _ Subtle.cube', 'soft slide from right with transcript card mask'],
    n8n_logic: ['Static Background 1.mp4', 'Creative _ Moody _ Strong.cube', 'node-line wipe'],
    kpi_proof: ['Static Background 1.mp4', 'Creative _ Moody _ Strong.cube', 'precision zoom to KPI panel'],
    manager_coaching: ['Kinetic Dots background (white).mp4', 'iPhone 13 _ Anamorphic Levels _ Subtle.cube', 'calm dissolve from KPI proof'],
    cta: ['Static Background 1.mp4', 'Creative _ Teal Shadows _ Strong.cube', 'minimal fade'],
  };
  return base.map(([purpose, label, visual], index) => {
    const [background, lut, transitionIn] = routeMap[purpose];
    return {
      id: `s${index + 1}`,
      sequence: index + 1,
      purpose,
      timecode: `${String(index).padStart(2, '0')}:00`,
      visual,
      cutaway: label,
      assetRoute: {
        purpose,
        label,
        background,
        lut,
        music: purpose === 'cta' ? 'Infinite Morning - Kellin.wav' : 'Crystal Clear - Kellin.wav',
        sfx: purpose === 'n8n_logic' ? ['Mouse Click.wav', 'Whip whoosh.mp3'] : ['Mouse Click.wav', 'Pop.wav'],
        transitionIn,
        motion: visual,
        technique: 'Hosted MVP draft route. Local worker can expand this into full Remotion/HyperFrames handoff.',
        rule: 'Keep each scene readable, purposeful, and tied to the viewer action.',
      },
    };
  });
}

function createLocalProject(payload) {
  const now = new Date().toISOString();
  const project = {
    id: `local-${slug(payload.name || payload.topic)}-${Date.now()}`,
    name: payload.name || payload.topic || 'Untitled Video',
    template: payload.template || 'custom',
    scriptMode: payload.scriptMode || 'generate',
    status: 'draft',
    audience: payload.audience || 'LUX team',
    goal: payload.goal || 'Explain the Video OS MVP.',
    topic: payload.topic || payload.name || 'LUX Video OS',
    tone: payload.tone || 'executive, clear, practical',
    aesthetic: payload.aesthetic || 'LUX command-center, cinematic, glass UI',
    avatar: { avatarId: payload.avatarId || 'default-studio-presenter', ...selectedTalent('#avatar-select') },
    voice: { voiceId: payload.voiceId || 'brand-neutral-executive', ...selectedTalent('#voice-select') },
    scriptInput: payload.scriptInput || '',
    provider: 'Hosted MVP browser draft',
    reviewState: 'brief_ready',
    cost: { renderAttempts: 0, estimatedCredits: 0, postProductionEstimate: 'not rendered' },
    telemetry: { providerStatus: 'not_submitted', latencyRisk: 'none' },
    versions: { scripts: [], sceneManifests: [], renders: [], postProduction: [] },
    feedbackCount: 0,
    nextActions: ['Generate a script from the goal and review the scene asset choices.'],
    createdAt: now,
    updatedAt: now,
  };
  const projects = [project, ...readLocalProjects()];
  writeLocalProjects(projects);
  render({ ...state, projects: [project, ...(state?.projects ?? [])] });
  requestAnimationFrame(() => document.querySelector('#projects-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  return project;
}

function selectedText(selector) {
  const node = document.querySelector(selector);
  return node?.selectedOptions?.[0]?.textContent || '';
}

function selectedTalent(selector) {
  const node = document.querySelector(selector);
  const option = node?.selectedOptions?.[0];
  return {
    name: option?.textContent || '',
    source: option?.dataset?.source || 'local',
    style: option?.dataset?.style || '',
    visibility: option?.dataset?.visibility || 'shared',
  };
}

function generateLocalScript(project) {
  const now = new Date().toISOString();
  const script = {
    id: `local-script-${Date.now()}`,
    createdAt: now,
    script: project.scriptMode === 'paste_exact' && project.scriptInput
      ? project.scriptInput
      : [
      'Scene 1 - Open the MVP.',
      `This video is for ${project.audience}. The goal is to ${String(project.goal || 'explain the Video OS MVP').toLowerCase()}.`,
      'Scene 2 - Show what the OS does.',
      `Video OS turns a topic like "${project.topic}" into a structured video project with narrative intelligence, script control, asset routing, review gates, cost visibility, and feedback capture.`,
      'Scene 3 - Show how the team uses it.',
      'The team can create projects, generate scripts, review scene plans, see recommended backgrounds, LUTs, transitions, music, SFX, and understand estimated costs before rendering.',
      'Scene 4 - Explain why it matters.',
      'This gives LUX a repeatable way to turn company intelligence, automation updates, client reports, and market narratives into polished videos.',
      'Scene 5 - Ask for feedback.',
      'Ask the team what was clear, what was missing, and which video workflows should be prioritized next.',
    ].join('\n\n'),
  };
  const sceneManifest = {
    id: `local-scene-${Date.now()}`,
    createdAt: now,
    scriptVersionId: script.id,
    assetRoutingVersion: 'hosted-mvp-scene-purpose-v1',
    scenes: localSceneRoutes(project),
  };
  project.versions.scripts.push(script);
  project.versions.sceneManifests.push(sceneManifest);
  project.status = 'review_required';
  project.reviewState = 'script_scene_review';
  project.nextActions = ['Review generated script and OS-selected asset routes.'];
  project.updatedAt = now;
  const projects = readLocalProjects().map((item) => item.id === project.id ? project : item);
  writeLocalProjects(projects);
  render({ ...state, projects: [project, ...(state?.projects ?? []).filter((item) => item.id !== project.id)] });
  requestAnimationFrame(() => document.querySelector(`#project-${CSS.escape(project.id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

async function load() {
  if (['127.0.0.1', 'localhost', ''].includes(location.hostname)) {
    try {
      const response = await fetch('/api/video-os');
      if (response.ok) {
        const payload = await response.json();
        document.querySelector('#connection-state').textContent = 'local persistence online';
        setModeBanner(true);
        return payload.videoOs;
      }
    } catch {
      // static preview fallback
    }
  }
  const response = await fetch(`${videoPath}?t=${Date.now()}`);
  document.querySelector('#connection-state').textContent = 'hosted static preview';
  setModeBanner(false);
  return enrichWithLocalProjects(await response.json());
}

function metric(label, value, detail) {
  const card = el('article', 'metric');
  card.append(el('span', null, label), el('strong', null, value), el('p', 'muted', detail));
  return card;
}

function tags(values = []) {
  const row = el('div', 'tag-row');
  row.append(...values.map((value) => el('span', 'tag', value)));
  return row;
}

function decisionClass(value = '') {
  return `decision-${String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function dimensionGrid(dimensions = {}) {
  const items = [
    ['Traffic', dimensions.trafficPotential],
    ['Intent', dimensions.buyerIntent],
    ['Velocity', dimensions.narrativeVelocity],
    ['Saturation', dimensions.contentSaturation],
    ['Brand Fit', dimensions.brandFit],
    ['Difficulty', dimensions.productionDifficulty],
  ];
  const grid = el('div', 'dimension-grid');
  items.forEach(([label, value]) => {
    const item = el('div', 'dimension-cell');
    item.append(el('small', null, label), el('strong', null, value === undefined ? 'n/a' : String(value)));
    grid.append(item);
  });
  return grid;
}

function angleList(angles = []) {
  const list = el('div', 'angle-list');
  (angles.length ? angles : [{ type: 'Default', hook: 'Turn the signal into a useful LUX explainer.', format: '90-sec explainer' }]).slice(0, 3).forEach((angle) => {
    const item = el('article', 'angle-card');
    item.append(el('small', null, angle.type ?? 'Angle'), el('strong', null, angle.hook ?? ''), el('span', null, angle.format ?? 'video brief'));
    list.append(item);
  });
  return list;
}

function render(videoOs) {
  state = videoOs;
  const projects = videoOs.projects ?? [];
  const templates = videoOs.templates ?? [];
  const gates = videoOs.gates ?? [];
  const jobs = videoOs.persistence?.jobCounts ?? {};
  const scored = projects.filter((project) => project.qualityScore !== null && project.qualityScore !== undefined && Number.isFinite(Number(project.qualityScore)));
  const avg = scored.length ? Math.round(scored.reduce((sum, project) => sum + Number(project.qualityScore), 0) / scored.length) : 'n/a';

  document.querySelector('#project-count').textContent = `${projects.length} projects`;
  document.querySelector('#generated-at').textContent = videoOs.generatedAt ? new Date(videoOs.generatedAt).toLocaleString() : 'static';
  document.querySelector('#metrics').replaceChildren(
    metric('Projects', String(projects.length), `${projects.filter((p) => p.status !== 'published').length} active`),
    metric('Templates', String(templates.length), 'repeatable lanes'),
    metric('Quality Gates', String(gates.length), 'before spend'),
    metric('Avg QC', String(avg), `${scored.length} scored`)
  );
  document.querySelector('#worker-counts').replaceChildren(
    el('span', null, 'Worker Queue'),
    ...['queued', 'running', 'completed', 'failed'].map((key) => el('strong', null, `${key}: ${jobs[key] ?? 0}`))
  );
  document.querySelector('#state-flow').replaceChildren(...(videoOs.stateMachine?.states ?? []).map((item) => el('span', 'pill', item.replace(/_/g, ' '))));
  renderOpsBoard(videoOs);
  renderTemplates(videoOs);
  renderGates(videoOs);
  renderProjects(videoOs);
  renderTrends(videoOs);
  renderAssets(videoOs);
  renderHealth(videoOs);
  fillTalent(videoOs);
  renderTalentConnection(videoOs);
  fillDiscoverOptions(videoOs);
  renderAdmin(videoOs);
  fillTemplates(videoOs);
}

function renderHealth(videoOs) {
  const worker = videoOs.systemHealth?.worker ?? {};
  const trends = videoOs.systemHealth?.last30days ?? {};
  const scheduler = videoOs.systemHealth?.scheduler ?? {};
  const workerBox = document.querySelector('#worker-health');
  if (workerBox) {
    const online = worker.status === 'online';
    workerBox.className = `health-card ${online ? 'ok' : 'warn'}`;
    workerBox.querySelector('strong').textContent = online ? 'Worker online' : 'Worker not draining automatically';
    workerBox.querySelector('span').textContent = worker.detail || 'Start the worker or use Run Next Job for one queued task.';
  }
  const trendBox = document.querySelector('#last30days-health');
  if (trendBox) {
    const ready = trends.status === 'ready';
    trendBox.className = `health-card ${ready ? 'ok' : 'warn'}`;
    trendBox.querySelector('strong').textContent = ready ? 'Last30Days ready' : 'Last30Days unavailable';
    trendBox.querySelector('span').textContent = trends.detail || trends.path || 'Configure LAST30DAYS_SCRIPT_PATH for fresh trend scans.';
  }
  const schedulerBox = document.querySelector('#scheduler-health');
  if (schedulerBox) {
    const active = scheduler.status === 'active';
    schedulerBox.className = `health-card ${active ? 'ok' : 'warn'}`;
    schedulerBox.querySelector('strong').textContent = active ? 'Scheduled scans active' : 'Scheduled scans disabled';
    schedulerBox.querySelector('span').textContent = active
      ? `${scheduler.enabledCount ?? 0} watchlists enabled, ${scheduler.dueCount ?? 0} due now.`
      : scheduler.detail || 'Enable VIDEO_OS_SCHEDULED_SCANS for recurring watchlist scans.';
  }
}

function renderOpsBoard(videoOs) {
  const projects = videoOs.projects ?? [];
  const jobs = videoOs.persistence?.jobCounts ?? {};
  const opportunities = videoOs.trends?.opportunities ?? [];
  const needsAttention = projects.filter((project) => ['review_required', 'qc_required', 'quarantined', 'failed'].includes(project.status));
  const rendering = projects.filter((project) => ['render_queued', 'rendering'].includes(project.status));
  const topTrend = opportunities[0];
  const topProject = needsAttention[0] ?? rendering[0] ?? projects[0];

  document.querySelector('#attention-count').textContent = String(needsAttention.length);
  document.querySelector('#attention-detail').textContent = needsAttention[0]
    ? `${needsAttention[0].name}: ${(needsAttention[0].reviewState ?? needsAttention[0].status).replace(/_/g, ' ')}`
    : 'No active blockers.';
  document.querySelector('#queue-signal').textContent = `${jobs.queued ?? 0} queued`;
  document.querySelector('#queue-detail').textContent = `${jobs.running ?? 0} running, ${jobs.failed ?? 0} failed`;
  document.querySelector('#trend-signal').textContent = topTrend ? String(topTrend.videoOpportunityScore ?? 0) : '0';
  document.querySelector('#trend-signal-detail').textContent = topTrend ? topTrend.title : 'No trend opportunities yet.';
  document.querySelector('#next-action-title').textContent = needsAttention.length ? 'Approve / QC' : topTrend ? (topTrend.launchRecommendation ?? 'Create From Trend') : 'Create Project';
  document.querySelector('#next-action-detail').textContent = topProject ? visibleNextAction(topProject) : topTrend?.recommendedAngle ?? 'Start with a brief or trend scan.';
}

function fillTemplates(videoOs) {
  const select = document.querySelector('#template-select');
  if (select.dataset.loaded === 'true') return;
  select.replaceChildren(...(videoOs.templates ?? []).map((template) => {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = template.name;
    return option;
  }));
  select.dataset.loaded = 'true';
}

function fillTalent(videoOs) {
  const inventory = videoOs.talentInventory ?? {};
  fillTalentSelect('#avatar-select', inventory.avatars ?? [], 'avatar');
  fillTalentSelect('#voice-select', inventory.voices ?? [], 'voice');
}

function renderTalentConnection(videoOs) {
  const connection = videoOs.talentConnection ?? {};
  const inventory = videoOs.talentInventory ?? {};
  const connected = connection.status === 'connected';
  const privateAvatars = (inventory.avatars ?? []).filter((item) => item.visibility === 'private');
  const detail = connected
    ? connection.detail
    : `${connection.detail || 'Using local fallback avatar/voice presets.'}${connection.missing?.length ? ` Missing: ${connection.missing.join(', ')}.` : ''}`;
  const boxes = [
    document.querySelector('#talent-connection'),
    document.querySelector('#admin-talent-status'),
  ].filter(Boolean);
  boxes.forEach((box) => {
    if (box.id === 'admin-talent-status') {
      box.replaceChildren(
        adminItem(connected ? 'Connected to HeyGen' : 'Local fallback inventory', detail, null),
        adminItem('Inventory counts', `${inventory.avatars?.length ?? 0} avatar options, ${inventory.voices?.length ?? 0} voice options | ${privateAvatars.length || connection.privateAvatarCount || 0} private avatar(s) pinned | source: ${inventory.source || connection.source || 'unknown'}`, null),
        ...(privateAvatars.length ? [adminItem('Private avatars', privateAvatars.map((item) => `${item.name || item.id} (${item.id})`).join(' | '), null)] : []),
        ...(connection.keyFileConfigured ? [adminItem('HeyGen credential', `${connection.keySource || 'local key file'} configured`, null)] : []),
        ...(connection.lastSyncError ? [adminItem('Last sync error', connection.lastSyncError, null)] : [])
      );
    } else {
      box.className = `health-card ${connected ? 'ok' : 'warn'}`;
      box.querySelector('strong').textContent = connected ? 'HeyGen talent connected' : 'Generic fallback talent';
      box.querySelector('span').textContent = privateAvatars.length
        ? `${detail} Private avatar pinned: ${privateAvatars.map((item) => item.name || item.id).join(', ')}.`
        : detail;
    }
  });
}

function fillTalentSelect(selector, items, kind) {
  const select = document.querySelector(selector);
  if (!select || !items.length) return;
  const current = select.value;
  select.replaceChildren(...items.map((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.name || item.id}${item.visibility === 'private' ? ' (private)' : item.source === 'heygen' ? '' : ' (fallback)'}`;
    option.dataset.source = item.source || 'local';
    option.dataset.style = item.style || kind;
    option.dataset.visibility = item.visibility || 'shared';
    return option;
  }));
  if (current && [...select.options].some((option) => option.value === current)) {
    select.value = current;
  }
}

function fillDiscoverOptions(videoOs) {
  const options = videoOs.discoverOptions ?? {};
  fillOptionSelect('#discover-industry', options.industries ?? [], true);
  fillOptionSelect('#discover-demo', options.audiences ?? [], true);
  fillOptionSelect('#discover-region', options.regions ?? [], true);
  fillOptionSelect('#discover-topic', [
    ...(options.topics ?? []),
    { id: 'custom', label: 'Custom topic', value: '__custom__' },
  ], true);
  fillPlatformOptions(options.platforms ?? [], true);
  const limits = document.querySelector('#discover-limits');
  if (limits && !limits.dataset.loaded) {
    limits.replaceChildren(...(options.limits ?? []).map((item) => el('p', null, item)));
    limits.dataset.loaded = 'true';
  }
  const topicSelect = document.querySelector('#discover-topic');
  const customWrap = document.querySelector('#custom-topic-wrap');
  if (topicSelect && customWrap && !topicSelect.dataset.bound) {
    topicSelect.addEventListener('change', () => {
      customWrap.hidden = topicSelect.value !== '__custom__';
    });
    topicSelect.dataset.bound = 'true';
  }
}

function fillOptionSelect(selector, items, force = false) {
  const select = document.querySelector(selector);
  if (!select || !items.length || (select.dataset.loaded && !force)) return;
  const current = select.value;
  select.replaceChildren(...items.map((item) => {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    return option;
  }));
  if (current && [...select.options].some((option) => option.value === current)) select.value = current;
  select.dataset.loaded = 'true';
}

function fillPlatformOptions(platforms, force = false) {
  const box = document.querySelector('#discover-platforms');
  if (!box || !platforms.length || (box.dataset.loaded && !force)) return;
  const selected = new Set([...box.querySelectorAll('input[name="platform"]:checked')].map((item) => item.value));
  box.replaceChildren(...platforms.map((platform) => {
    const label = el('label', platform.available ? 'platform-option' : 'platform-option limited');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'platform';
    input.value = platform.id;
    input.checked = selected.size ? selected.has(platform.id) : ['reddit', 'youtube'].includes(platform.id);
    label.append(input, el('span', null, platform.label), el('small', null, platform.note || ''));
    return label;
  }));
  box.dataset.loaded = 'true';
}

function adminConfig(videoOs = state) {
  if (!discoverConfigDraft) {
    const options = videoOs?.discoverOptions ?? {};
    discoverConfigDraft = JSON.parse(JSON.stringify({
      industries: options.industries ?? [],
      audiences: options.audiences ?? [],
      topics: options.topics ?? [],
      regions: options.regions ?? [],
      platforms: options.platforms ?? [],
      watchlists: options.watchlists ?? videoOs?.trends?.watchlists ?? [],
      scanRecipes: options.scanRecipes ?? [],
      scanSchedules: options.scanSchedules ?? videoOs?.systemHealth?.scheduler?.schedules ?? [],
    }));
  }
  return discoverConfigDraft;
}

function renderAdmin(videoOs) {
  const config = adminConfig(videoOs);
  renderAdminOptions(config);
  renderAdminPlatforms(config.platforms ?? []);
  renderAdminCollection('#admin-watchlists', config.watchlists ?? [], ['industry', 'demo', 'topic', 'region', 'platforms', 'scheduleHours']);
  renderAdminCollection('#admin-recipes', config.scanRecipes ?? [], ['industry', 'demo', 'topic', 'region', 'platforms']);
  renderAdminScheduler(videoOs);
}

function renderAdminOptions(config) {
  const box = document.querySelector('#admin-options');
  if (!box) return;
  const groups = [
    ['industries', 'Industries'],
    ['audiences', 'Audiences'],
    ['topics', 'Topics'],
    ['regions', 'Regions'],
  ];
  box.replaceChildren(...groups.map(([key, label]) => {
    const group = el('section', 'admin-group');
    group.append(el('h4', null, label));
    (config[key] ?? []).forEach((item) => group.append(adminItem(item.label, item.value, () => {
      config[key] = (config[key] ?? []).filter((candidate) => candidate.id !== item.id);
      renderAdmin(state);
    })));
    return group;
  }));
}

function renderAdminPlatforms(platforms) {
  const box = document.querySelector('#admin-platforms');
  if (!box) return;
  box.replaceChildren(...platforms.map((platform) => adminItem(
    `${platform.label} (${platform.id})`,
    `${platform.available ? 'available' : 'limited'} - ${platform.note || ''}`,
    () => {
      const config = adminConfig();
      config.platforms = (config.platforms ?? []).filter((candidate) => candidate.id !== platform.id);
      renderAdmin(state);
    }
  )));
}

function renderAdminCollection(selector, items, fields) {
  const box = document.querySelector(selector);
  if (!box) return;
  box.replaceChildren(...items.map((item) => adminItem(
    item.name || item.topic || item.id,
    fields.map((field) => `${field}: ${Array.isArray(item[field]) ? item[field].join(',') : (item[field] ?? '')}`).join(' | '),
    () => {
      const config = adminConfig();
      const key = selector.includes('watchlist') ? 'watchlists' : 'scanRecipes';
      config[key] = (config[key] ?? []).filter((candidate) => candidate.id !== item.id);
      renderAdmin(state);
    }
  )));
}

function formatDate(value) {
  if (!value) return 'not scheduled';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'not scheduled' : date.toLocaleString();
}

function renderAdminScheduler(videoOs) {
  const box = document.querySelector('#admin-scheduler-summary');
  if (!box) return;
  const scheduler = videoOs?.systemHealth?.scheduler ?? {};
  const schedules = scheduler.schedules ?? adminConfig(videoOs).scanSchedules ?? [];
  const summary = adminItem(
    scheduler.status === 'active' ? 'Scheduler active' : 'Scheduler disabled',
    `${scheduler.enabledCount ?? 0}/${scheduler.scheduleCount ?? schedules.length} watchlists enabled | ${scheduler.dueCount ?? 0} due now | default ${scheduler.defaultIntervalHours ?? 24}h`,
    null
  );
  const scheduleItems = schedules.slice(0, 8).map((schedule) => adminItem(
    schedule.watchlistName || schedule.watchlistId,
    `every ${schedule.intervalHours ?? 24}h | next ${formatDate(schedule.nextRunAt)} | last job ${schedule.lastJobId || 'none'}`,
    null
  ));
  box.replaceChildren(summary, ...scheduleItems);
}

function adminItem(title, detail, onRemove) {
  const item = el('article', 'admin-item');
  const copy = el('div');
  copy.append(el('strong', null, title), el('span', null, detail || ''));
  item.append(copy);
  if (onRemove) {
    const remove = el('button', 'secondary-action', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', onRemove);
    item.append(remove);
  }
  return item;
}

function splitCsv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function bindAdminForms() {
  const optionForm = document.querySelector('#admin-option-form');
  optionForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const config = adminConfig();
    const payload = Object.fromEntries(new FormData(optionForm).entries());
    if (!payload.label || !payload.value) return;
    config[payload.category].push({ id: slug(payload.label), label: payload.label, value: payload.value });
    optionForm.reset();
    renderAdmin(state);
  });
  const platformForm = document.querySelector('#admin-platform-form');
  platformForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const config = adminConfig();
    const payload = Object.fromEntries(new FormData(platformForm).entries());
    if (!payload.id || !payload.label) return;
    config.platforms.push({ id: slug(payload.id), label: payload.label, available: payload.available === 'true', note: payload.note || '' });
    platformForm.reset();
    renderAdmin(state);
  });
  bindScanForm('#admin-watchlist-form', 'watchlists');
  bindScanForm('#admin-recipe-form', 'scanRecipes');
  document.querySelector('#save-discover-config')?.addEventListener('click', saveDiscoverConfig);
  document.querySelector('#run-due-scans')?.addEventListener('click', runDueScans);
  document.querySelector('#refresh-heygen-talent')?.addEventListener('click', refreshHeyGenTalent);
}

function bindScanForm(selector, key) {
  const form = document.querySelector(selector);
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const config = adminConfig();
    const payload = Object.fromEntries(new FormData(form).entries());
    if (!payload.name || !payload.topic) return;
    config[key].push({
      id: slug(payload.name),
      name: payload.name,
      industry: payload.industry,
      demo: payload.demo,
      topic: payload.topic,
      region: payload.region || 'US',
      platforms: splitCsv(payload.platforms || 'reddit,youtube'),
      freshnessDays: Number(payload.freshnessDays || 30),
      scheduleHours: Number(payload.scheduleHours || 24),
    });
    form.reset();
    renderAdmin(state);
  });
}

async function saveDiscoverConfig() {
  const status = document.querySelector('#admin-status');
  if (!canUseLocalApi()) {
    status.textContent = 'Admin changes require the local Video OS control plane.';
    return;
  }
  try {
    status.textContent = 'Saving intelligence settings...';
    const data = await api('/discover-options', adminConfig());
    discoverConfigDraft = JSON.parse(JSON.stringify(data.discoverOptions));
    status.textContent = 'Intelligence settings saved.';
    await load().then(render);
  } catch (error) {
    status.textContent = error.message;
  }
}

async function runDueScans() {
  const status = document.querySelector('#admin-status');
  if (!canUseLocalApi()) {
    status.textContent = 'Scheduled scans require the local Video OS control plane.';
    return;
  }
  try {
    status.textContent = 'Queuing due watchlists...';
    const data = await api('/scheduler/run-due', { force: false });
    const queued = data.scheduler?.queued?.length ?? 0;
    status.textContent = queued ? `Queued ${queued} scheduled scan(s).` : 'No watchlists are due right now.';
    await load().then(render);
  } catch (error) {
    status.textContent = error.message;
  }
}

async function refreshHeyGenTalent() {
  const status = document.querySelector('#admin-status');
  if (!canUseLocalApi()) {
    status.textContent = 'HeyGen talent refresh requires the local Video OS control plane.';
    return;
  }
  try {
    status.textContent = 'Refreshing HeyGen talent inventory...';
    const data = await api('/talent/refresh', {});
    const connection = data.connection ?? {};
    status.textContent = connection.status === 'connected'
      ? `HeyGen talent connected: ${connection.avatarCount} avatar(s), ${connection.voiceCount} voice(s).`
      : `Talent refresh did not connect to HeyGen. ${connection.lastSyncError || connection.detail || ''}`;
    await load().then(render);
  } catch (error) {
    status.textContent = error.message;
  }
}

function renderTemplates(videoOs) {
  const box = document.querySelector('#templates');
  box.replaceChildren(...(videoOs.templates ?? []).map((template) => {
    const card = el('article', 'template-card');
    card.append(el('h3', null, template.name), el('p', null, template.goal), tags(template.requiredGates ?? []));
    return card;
  }));
}

function renderGates(videoOs) {
  const box = document.querySelector('#gates');
  box.replaceChildren(...(videoOs.gates ?? []).map((gate) => {
    const card = el('article', 'gate-card');
    card.append(el('h3', null, gate.name), el('p', null, gate.failureMode), tags(gate.checks ?? []));
    return card;
  }));
}

function queueButton(project, type, label, payload = {}, variant = '') {
  const button = el('button', null, label);
  if (variant) button.classList.add(variant);
  button.type = 'button';
  const unavailable = actionUnavailableReason(project, type);
  if (unavailable) {
    button.classList.add('disabled-action');
    button.title = unavailable;
    button.disabled = true;
    return button;
  }
  const localOnly = ['heygen_submit', 'heygen_poll', 'artifact_archive', 'post_production_handoff'].includes(type);
  if (!canUseLocalApi() && localOnly) {
    button.classList.add('disabled-action');
    button.textContent = `${label} (local only)`;
    button.title = 'This action requires the local Video OS worker/API.';
    button.disabled = true;
    return button;
  }
  button.addEventListener('click', async () => {
    const original = button.textContent;
    try {
      if (!canUseLocalApi() && type === 'script_generation') {
        button.textContent = 'Generated';
        generateLocalScript(project);
        setTimeout(() => { button.textContent = original; }, 900);
        return;
      }
      if (!canUseLocalApi()) {
        button.textContent = 'Local only';
        button.title = 'Hosted MVP supports browser-local project and script drafts only. Use the local app for workers, HeyGen, archive, and feedback persistence.';
        setTimeout(() => { button.textContent = original; }, 1400);
        return;
      }
      button.textContent = 'Queued';
      await api('/jobs', { projectId: project.id, type, payload });
      button.textContent = original;
    } catch (error) {
      button.textContent = 'Blocked';
      button.title = error.message;
      setTimeout(() => { button.textContent = original; }, 1400);
    }
  });
  return button;
}

function actionUnavailableReason(project, type) {
  const hasScript = (project.versions?.scripts ?? []).length > 0 || Boolean(project.scriptInput);
  const hasProviderJob = Boolean(project.providerJobId);
  const hasRenderableStatus = ['approved', 'render_queued', 'rendering', 'rendered', 'qc_required'].includes(project.status);
  if (type === 'script_generation' && project.status === 'rendering') return 'Script generation is locked while a render is in progress.';
  if (type === 'heygen_submit' && project.status !== 'approved') return 'Approve script and scene plan before queuing HeyGen.';
  if (type === 'heygen_submit' && !hasScript) return 'Generate or paste a script before render submission.';
  if (type === 'heygen_poll' && !hasProviderJob) return 'Polling requires a HeyGen provider job id.';
  if (type === 'artifact_archive' && !hasRenderableStatus && !hasScript) return 'Archive unlocks after a script or render exists.';
  if (type === 'post_production_handoff' && !['rendered', 'qc_required'].includes(project.status)) return 'Post-production handoff unlocks after a rendered or QC-ready video.';
  return '';
}

function feedbackForm(project) {
  const form = el('form', 'feedback-form');
  const reviewer = document.createElement('input');
  reviewer.name = 'reviewer';
  reviewer.placeholder = 'Reviewer';
  const persona = document.createElement('select');
  persona.name = 'persona';
  ['rep', 'manager', 'leadership', 'editor'].forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    persona.append(option);
  });
  const requestedChange = document.createElement('input');
  requestedChange.name = 'requestedChange';
  requestedChange.placeholder = 'Feedback or requested change';
  const submit = el('button', null, 'Save Feedback');
  submit.type = 'submit';
  form.append(reviewer, persona, requestedChange, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());
    if (!payload.requestedChange?.trim()) return;
    await api('/feedback', { ...payload, projectId: project.id });
    form.reset();
  });
  return form;
}

function latestSceneRoutes(project) {
  const manifests = project.versions?.sceneManifests ?? [];
  const latest = manifests[manifests.length - 1];
  return latest?.scenes ?? [];
}

function latestScript(project) {
  const scripts = project.versions?.scripts ?? [];
  return scripts[scripts.length - 1] ?? null;
}

function mergeProjectIntoState(project) {
  return {
    ...state,
    projects: [project, ...(state?.projects ?? []).filter((item) => item.id !== project.id)],
  };
}

function visibleNextAction(project) {
  if (!canUseLocalApi() && project.status === 'approved') {
    return 'Approved. Rendering is locked on Vercel; open the local Video OS control plane to submit to HeyGen.';
  }
  if (canUseLocalApi() && project.status === 'approved') {
    return 'Approved. Submit the HeyGen dry run or prepare post-production handoff.';
  }
  return project.nextActions?.[0] ?? 'Review current state and choose the next production step.';
}

function localControlLink() {
  const link = el('a', 'primary-action action-link', 'Open Local Control Plane');
  link.href = 'http://127.0.0.1:8789/dashboard';
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.title = 'Run the local Video OS server, then open the local control plane for HeyGen and worker actions.';
  return link;
}

async function approveProjectReview(project, button) {
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Approving...';
  }
  const patch = {
    status: 'approved',
    reviewState: canUseLocalApi() ? 'approved_for_render_gate' : 'approved_for_local_handoff',
    nextActions: [
      canUseLocalApi()
        ? 'Approved. Queue HeyGen dry run or prepare post-production handoff.'
        : 'Approved in this browser. Use the local Video OS control plane to submit to HeyGen or prepare post-production handoff.',
    ],
    updatedAt: new Date().toISOString(),
  };
  Object.assign(project, patch);

  try {
    if (canUseLocalApi() && !String(project.id).startsWith('local-')) {
      await api('/projects/update', { projectId: project.id, patch });
      flashNotice('Project approved', `${project.name} is approved for the render gate.`);
    } else {
      upsertLocalProject(project);
      render(mergeProjectIntoState(project));
      flashNotice('Project approved', `${project.name} is approved and saved in this browser.`);
    }
    requestAnimationFrame(() => document.querySelector(`#project-${CSS.escape(project.id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
    flashNotice('Approval blocked', error.message, 'error');
  }
}

function reviewRoom(project) {
  const script = latestScript(project);
  const scenes = latestSceneRoutes(project);
  if (!script && !scenes.length) return null;
  const isApproved = project.status === 'approved';
  const panel = el('section', isApproved ? 'review-room approved' : 'review-room');
  const head = el('div', 'review-room-head');
  head.append(
    el('div', null, ''),
    el('span', isApproved ? 'status approved-status' : 'status', isApproved ? 'Approved' : 'Needs review')
  );
  head.firstChild.append(el('small', null, 'Review Room'), el('h3', null, 'Script + Scene Review'));

  if (isApproved) {
    const approvedPanel = el('article', 'approved-review-panel');
    approvedPanel.append(
      el('small', null, 'Approved Handoff'),
      el('strong', null, 'Script, scene timing, and asset routing are approved.'),
      el('p', null, visibleNextAction(project)),
      tags([
        `${(project.versions?.scripts ?? []).length} script version(s)`,
        `${(project.versions?.sceneManifests ?? []).length} scene manifest(s)`,
        canUseLocalApi() ? 'local production enabled' : 'local production required',
      ])
    );
    panel.append(head, approvedPanel);
    return panel;
  }

  const scriptBox = el('article', 'script-review');
  scriptBox.append(el('small', null, 'Generated Script'));
  const pre = el('pre', null, script?.script ?? 'No script generated yet.');
  scriptBox.append(pre);

  const sceneBox = el('article', 'scene-review');
  sceneBox.append(el('small', null, 'Scene Plan'));
  scenes.forEach((scene) => {
    const route = scene.assetRoute ?? {};
    const item = el('div', 'scene-review-item');
    item.append(
      el('strong', null, `${scene.sequence ?? ''}. ${route.label ?? scene.purpose ?? scene.id}`),
      el('p', null, scene.visual ?? scene.cutaway ?? ''),
      tags([route.background, route.lut, route.transitionIn].filter(Boolean))
    );
    sceneBox.append(item);
  });

  const checklist = el('article', 'review-checklist');
  checklist.append(
    el('small', null, 'Approval Decision'),
    el('strong', 'review-decision-title', 'Approve the script, scene timing, and OS-selected asset route.'),
    el('p', 'review-decision-copy', canUseLocalApi()
      ? 'Approval moves this project to the render gate so the team can queue a HeyGen dry run, poll the provider, archive artifacts, and prepare post-production.'
      : 'Approval is saved in this browser. HeyGen rendering, polling, archive, and handoff stay locked until the local Video OS control plane is running.'),
    tags([
      script ? 'script visible' : 'script missing',
      scenes.length ? 'scene plan visible' : 'scene plan missing',
      scenes.some((scene) => scene.assetRoute) ? 'asset routes visible' : 'asset routes missing',
      canUseLocalApi() ? 'local production actions available' : 'hosted draft only',
    ])
  );
  const approve = el('button', isApproved ? 'approved-action' : 'primary-action', isApproved ? 'Approved' : 'Approve Script + Scenes');
  approve.type = 'button';
  if (isApproved) {
    approve.disabled = true;
    checklist.append(el('p', 'approval-note', 'Approved. The next production action is now visible on this project card.'));
  } else {
    approve.addEventListener('click', () => approveProjectReview(project, approve));
  }
  checklist.append(approve);

  panel.append(head, scriptBox, sceneBox, checklist);
  return panel;
}

function assetRoutePreview(project) {
  const scenes = latestSceneRoutes(project);
  if (!scenes.length) return null;
  const panel = el('div', 'project-asset-routes');
  panel.append(el('small', null, 'OS Asset Choices'));
  scenes.slice(0, 6).forEach((scene) => {
    const route = scene.assetRoute ?? {};
    const item = el('article', 'project-asset-route');
    item.append(
      el('strong', null, route.label ?? scene.purpose ?? `Scene ${scene.sequence ?? ''}`),
      el('span', null, `${route.background ?? 'background TBD'} | ${route.lut ?? 'LUT TBD'}`),
      tags([route.transitionIn, ...(route.sfx ?? []).slice(0, 2)].filter(Boolean))
    );
    panel.append(item);
  });
  return panel;
}

function statusTimeline(project) {
  const hasScript = (project.versions?.scripts ?? []).length > 0;
  const hasScenes = (project.versions?.sceneManifests ?? []).length > 0;
  const hasRender = (project.versions?.renders ?? []).length > 0;
  const reviewDone = ['approved', 'render_queued', 'rendering', 'qc_required', 'rendered', 'published'].includes(project.status);
  const steps = [
    ['Brief', true],
    ['Script', hasScript],
    ['Scenes', hasScenes],
    ['Review', reviewDone],
    ['HeyGen', hasRender || Boolean(project.providerJobId) || ['render_queued', 'rendering', 'qc_required', 'rendered', 'published'].includes(project.status)],
    ['Publish', ['published'].includes(project.status)],
  ];
  const row = el('div', 'status-timeline');
  steps.forEach(([label, done]) => row.append(el('span', done ? 'done' : '', label)));
  return row;
}

function projectStatusText(project) {
  return projectStatusLabels[project.status] ?? project.status?.replace(/_/g, ' ') ?? 'draft';
}

function projectStatusClass(project) {
  return `status status-${String(project.status || 'draft').replace(/[^a-z0-9_-]/gi, '-')}`;
}

function projectPriority(project) {
  const ranks = {
    rendering: 0,
    render_queued: 1,
    qc_required: 2,
    rendered: 3,
    failed: 4,
    quarantined: 5,
    review_required: 6,
    approved: 7,
    draft: 8,
    published: 9,
  };
  return ranks[project.status] ?? 10;
}

function latestVideoUrl(project) {
  const renders = [...(project.versions?.renders ?? [])].reverse();
  for (const render of renders) {
    const url = render.videoUrl || render.video_url || render.raw?.data?.video_url || render.raw?.video_url;
    if (url) return url;
  }
  return project.videoUrl || project.renderUrl || null;
}

function renderStartedAt(project) {
  const renders = [...(project.versions?.renders ?? [])].reverse();
  const submitted = renders.find((render) => render.submittedAt || render.raw?.data?.created_at || render.raw?.created_at || render.createdAt || render.polledAt);
  const providerCreated = submitted?.raw?.data?.created_at || submitted?.raw?.created_at;
  if (providerCreated) {
    const seconds = Number(providerCreated);
    if (!Number.isNaN(seconds)) return new Date(seconds * 1000).toISOString();
  }
  return submitted?.submittedAt || submitted?.createdAt || submitted?.polledAt || project.renderSubmittedAt || project.updatedAt || project.createdAt || null;
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;
    return `${hours}h ${String(remaining).padStart(2, '0')}m`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function providerDurationSeconds(project) {
  const renders = [...(project.versions?.renders ?? [])].reverse();
  for (const render of renders) {
    const duration = Number(render.durationSeconds || render.raw?.data?.duration || render.raw?.duration);
    if (!Number.isNaN(duration) && duration > 0) return duration;
  }
  return Number(project.durationSeconds || 0) || null;
}

function renderElapsedText(project, now = Date.now()) {
  const duration = providerDurationSeconds(project);
  if (['rendered', 'qc_required', 'published'].includes(project.status) && duration) {
    return `Video duration ${formatElapsed(duration * 1000)}`;
  }
  const started = renderStartedAt(project);
  if (!started) return 'Timer starts after HeyGen accepts the job.';
  const startMs = new Date(started).getTime();
  if (Number.isNaN(startMs)) return 'Timer starts after HeyGen accepts the job.';
  const label = ['rendered', 'qc_required', 'published'].includes(project.status) ? 'Completed after' : 'Elapsed';
  return `${label} ${formatElapsed(now - startMs)}`;
}

function renderProgressPercent(project, now = Date.now()) {
  if (['rendered', 'qc_required', 'published'].includes(project.status)) return 100;
  if (project.status !== 'rendering') return 0;
  const started = renderStartedAt(project);
  const startMs = started ? new Date(started).getTime() : NaN;
  if (Number.isNaN(startMs)) return 14;
  const etaMinutes = Number(project.telemetry?.etaMinutes || 12);
  const estimatedMs = Math.max(5, etaMinutes) * 60 * 1000;
  return Math.max(8, Math.min(92, Math.round(((now - startMs) / estimatedMs) * 100)));
}

function renderProgress(project) {
  const wrap = el('div', `render-progress render-progress-${project.status || 'draft'}`);
  const head = el('div', 'render-progress-head');
  const percent = renderProgressPercent(project);
  head.append(
    el('span', null, ['rendered', 'qc_required', 'published'].includes(project.status) ? 'HeyGen complete' : 'HeyGen build timer'),
    el('strong', 'render-elapsed', renderElapsedText(project))
  );
  const track = el('div', 'render-progress-track');
  const bar = el('span', null);
  bar.style.width = `${percent}%`;
  track.append(bar);
  const foot = el('p', null, project.status === 'rendering'
    ? 'This is a live elapsed timer with estimated progress. HeyGen only confirms the exact state when polled.'
    : project.status === 'rendered' || project.status === 'qc_required'
      ? 'HeyGen returned the video. Review it before publishing or post-production.'
      : 'Progress appears here after HeyGen accepts the render.');
  wrap.append(head, track, foot);
  return wrap;
}

function refreshRenderTimers() {
  document.querySelectorAll('[data-render-project-id]').forEach((node) => {
    const project = state?.projects?.find((item) => item.id === node.dataset.renderProjectId);
    if (!project) return;
    const elapsed = node.querySelector('.render-elapsed');
    const bar = node.querySelector('.render-progress-track span');
    if (elapsed) elapsed.textContent = renderElapsedText(project);
    if (bar) bar.style.width = `${renderProgressPercent(project)}%`;
  });
}

function projectSearchHaystack(project) {
  return [
    project.name,
    project.id,
    project.status,
    project.reviewState,
    project.providerJobId,
    project.avatar?.name,
    project.avatar?.avatarId,
    project.goal,
    project.topic,
  ].filter(Boolean).join(' ').toLowerCase();
}

function projectMatchesFilter(project) {
  const query = projectSearchText.trim().toLowerCase();
  if (query && !projectSearchHaystack(project).includes(query)) return false;
  if (projectFilterMode === 'all') return true;
  if (projectFilterMode === 'rendering') return ['rendering', 'render_queued'].includes(project.status);
  if (projectFilterMode === 'needs_attention') return ['review_required', 'qc_required', 'quarantined', 'failed'].includes(project.status);
  return !['published', 'cancelled'].includes(project.status);
}

function renderCurrentProject(project) {
  const box = document.querySelector('#current-render');
  if (!box) return;
  if (!project) {
    const empty = el('article', 'current-render-empty');
    empty.append(
      el('small', null, 'Current video'),
      el('strong', null, 'No active render found'),
      el('p', null, 'Create or approve a project to start a visible render lane.')
    );
    box.replaceChildren(empty);
    return;
  }

  const videoUrl = latestVideoUrl(project);
  const provider = project.providerJobId || 'not submitted';
  const hero = el('article', `current-render-card ${project.status === 'rendering' ? 'is-rendering' : ''}`);
  hero.dataset.renderProjectId = project.id;
  const copy = el('div', 'current-render-copy');
  copy.append(
    el('small', null, 'Current video'),
    el('h3', null, project.name),
    el('p', null, project.goal || 'No goal recorded.'),
    tags([
      projectStatusText(project),
      project.avatar?.name ? `Avatar: ${project.avatar.name}` : 'Avatar not set',
      provider === 'not submitted' ? provider : `HeyGen: ${provider}`,
    ])
  );
  const status = el('div', 'current-render-status');
  status.append(
    el('span', projectStatusClass(project), projectStatusText(project)),
    el('strong', null, project.status === 'rendering'
      ? 'Rendering in HeyGen'
      : videoUrl
        ? 'HeyGen render is ready'
        : visibleNextAction(project)),
    el('p', null, project.status === 'rendering'
      ? 'The video has been submitted. Poll HeyGen until the video URL appears, then move it to QC.'
      : videoUrl
        ? 'The MP4 is available. Open it, review quality, then move to post-production.'
      : visibleNextAction(project))
  );
  const actions = el('div', 'current-render-actions');
  if (videoUrl) {
    const link = el('a', 'action-link primary-action', 'Open Video');
    link.href = videoUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    actions.append(link);
  }
  status.append(renderProgress(project));
  actions.append(
    queueButton(project, 'heygen_poll', 'Poll HeyGen', {}, 'primary-action'),
    queueButton(project, 'artifact_archive', 'Archive', {}, 'secondary-action')
  );
  hero.append(copy, status, actions);
  box.replaceChildren(hero);
}

function projectSummaryLine(project) {
  if (project.status === 'rendering') return 'Submitted to HeyGen. Waiting for provider video URL.';
  if (project.status === 'rendered' || project.status === 'qc_required') return 'Render is available. Review it before publishing or post-production.';
  if (project.status === 'review_required') return 'Script and scene plan are ready. Approve before render spend.';
  if (project.status === 'approved') return 'Approved and ready for HeyGen submission.';
  if (project.status === 'quarantined' || project.status === 'failed') return 'Needs manual review before the next production action.';
  return visibleNextAction(project);
}

function renderProjects(videoOs) {
  const box = document.querySelector('#projects');
  const projects = [...(videoOs.projects ?? [])].sort((a, b) => projectPriority(a) - projectPriority(b));
  const currentProject = projects.find((project) => ['rendering', 'render_queued'].includes(project.status) || project.providerJobId)
    ?? projects[0];
  renderCurrentProject(currentProject);
  if (!projects.length) {
    box.replaceChildren(el('p', 'muted', 'No projects yet. Create one from the studio console.'));
    return;
  }
  const visibleProjects = projects.filter(projectMatchesFilter);
  if (!visibleProjects.length) {
    box.replaceChildren(el('p', 'muted', 'No projects match this filter.'));
    return;
  }
  box.replaceChildren(...visibleProjects.map((project) => {
    const card = el('article', `project-card project-row status-card-${project.status || 'draft'}`);
    card.id = `project-${project.id}`;
    card.dataset.renderProjectId = project.id;
    if (String(project.id).startsWith('local-')) card.classList.add('local-project');
    if (project.status === 'approved') card.classList.add('approved-project');
    if (project.id === currentProject?.id) card.classList.add('current-project');
    const head = el('div', 'project-head');
    head.append(
      (() => {
        const title = el('div', 'project-title-block');
        title.append(el('h3', null, project.name), el('p', null, projectSummaryLine(project)));
        return title;
      })(),
      el('span', projectStatusClass(project), projectStatusText(project))
    );
    const meta = el('div', 'project-meta');
    [
      ['Avatar', project.avatar?.name || project.avatar?.avatarId || 'not selected'],
      ['HeyGen ID', project.providerJobId || 'not submitted'],
      ['Render', latestVideoUrl(project) ? 'video URL ready' : project.telemetry?.providerStatus ?? project.status ?? 'unknown'],
      ['Updated', project.updatedAt ? new Date(project.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'n/a'],
    ].forEach(([label, value]) => {
      const item = el('div', 'meta-box');
      item.append(el('small', null, label), el('strong', null, value));
      meta.append(item);
    });
    const actions = el('div', 'project-actions');
    const actionMode = el('span', canUseLocalApi() ? 'action-mode local' : 'action-mode hosted', canUseLocalApi() ? 'Local actions enabled' : 'Hosted preview: render actions locked');
    const recommended = !canUseLocalApi() && project.status === 'approved'
      ? localControlLink()
      : canUseLocalApi() && project.status === 'approved'
        ? queueButton(project, 'heygen_submit', 'Submit HeyGen Dry Run', { allowLive: false }, 'primary-action')
        : project.status === 'rendered' || project.status === 'qc_required'
          ? queueButton(project, 'post_production_handoff', 'Prepare Handoff', {}, 'primary-action')
          : queueButton(project, 'script_generation', 'Generate Script', {}, 'primary-action');
    actions.append(actionMode, recommended);
    if (!(canUseLocalApi() && project.status === 'approved')) {
      actions.append(queueButton(project, 'heygen_submit', 'HeyGen Dry Run', { allowLive: false }, 'secondary-action'));
    }
    actions.append(
      queueButton(project, 'heygen_poll', 'Poll HeyGen', {}, 'secondary-action'),
      queueButton(project, 'artifact_archive', 'Archive', {}, 'secondary-action')
    );
    const next = el('div', 'next-action');
    next.append(el('small', null, project.status === 'rendering' ? 'Where is the video?' : 'Next Action'), el('strong', null, projectSummaryLine(project)));
    const versions = tags([
      `scripts: ${(project.versions?.scripts ?? []).length}`,
      `scenes: ${(project.versions?.sceneManifests ?? []).length}`,
      `renders: ${(project.versions?.renders ?? []).length}`,
      `post: ${(project.versions?.postProduction ?? []).length}`,
      `feedback: ${project.feedbackCount ?? 0}`
    ]);
    const routePreview = assetRoutePreview(project);
    card.append(head, statusTimeline(project), meta, next, versions);
    const review = reviewRoom(project);
    if (review) card.append(review);
    if (routePreview) card.append(routePreview);
    card.append(actions, feedbackForm(project));
    return card;
  }));
}

function createTrendButton(trend) {
  const converted = Boolean(trend.convertedProjectId) || trend.status === 'converted';
  const button = el('button', converted ? 'disabled-action' : null, converted ? 'Converted' : 'Create Video');
  button.type = 'button';
  if (converted) {
    button.disabled = true;
    button.title = `Already converted to ${trend.convertedProjectId || 'a project'}.`;
    return button;
  }
  button.addEventListener('click', async () => {
    const original = button.textContent;
    try {
      button.textContent = 'Queued';
      await api('/trends/create-video', { trendId: trend.id });
      button.textContent = 'Create Video';
    } catch (error) {
      button.textContent = 'Blocked';
      button.title = error.message;
      setTimeout(() => { button.textContent = original; }, 1400);
    }
  });
  return button;
}

function renderNarrativeDesk(trends) {
  const summary = trends.narrativeSummary ?? {};
  document.querySelector('#narrative-recommendation').textContent = summary.recommendation ?? 'Run Scan';
  document.querySelector('#narrative-recommendation').className = decisionClass(summary.recommendation ?? 'Run Scan');
  document.querySelector('#narrative-headline').textContent = summary.headline ?? 'No live narrative signal yet.';
  document.querySelector('#narrative-why').textContent = summary.whyNow ?? 'Run a trend scan to identify narrative movement.';
  document.querySelector('#narrative-window').textContent = summary.window ?? 'unknown';
  document.querySelector('#narrative-decay').textContent = summary.decay ? `decay: ${summary.decay}` : 'no decay clock';
  document.querySelector('#narrative-platform').textContent = summary.primaryPlatform ?? 'mixed';
  document.querySelector('#narrative-platform-move').textContent = summary.platformMove ?? 'No platform strategy available.';
}

function renderTrends(videoOs) {
  const trends = videoOs.trends ?? {};
  const stats = trends.stats ?? {};
  const opportunities = trends.opportunities ?? [];
  renderNarrativeDesk(trends);
  document.querySelector('#trend-count').textContent = `${stats.opportunities ?? opportunities.length} opportunities`;
  document.querySelector('#trend-metrics').replaceChildren(
    metric('Pounce Now', String(stats.pounceNow ?? 0), stats.topDecision ?? 'no active call'),
    metric('High Score', String(stats.highScore ?? 0), 'narrative launch fit'),
    metric('Watchlists', String(stats.watchlists ?? 0), 'tracked markets'),
    metric('Last Scan', stats.lastRunAt ? new Date(stats.lastRunAt).toLocaleDateString() : 'none', 'local worker')
  );
  document.querySelector('#watchlists').replaceChildren(...(trends.watchlists ?? []).map((item) => {
    const card = el('article', 'watchlist-card');
    card.append(el('strong', null, item.name), el('span', null, item.topic), tags(item.platforms ?? []));
    return card;
  }));

  const box = document.querySelector('#opportunities');
  if (!opportunities.length) {
    box.replaceChildren(el('p', 'muted', 'No trend opportunities yet. Run a scan to populate the radar.'));
    return;
  }

  box.replaceChildren(...opportunities.map((trend) => {
    const narrative = trend.narrative ?? {};
    const decay = narrative.decay ?? {};
    const platform = narrative.platformStrategy ?? {};
    const card = el('article', 'opportunity-card');
    const head = el('div', 'project-head');
    const decision = el('span', `decision-badge ${decisionClass(trend.launchRecommendation ?? narrative.decision ?? '')}`, trend.launchRecommendation ?? narrative.decision ?? 'Watch');
    const score = el('span', 'score-badge', String(trend.videoOpportunityScore ?? 0));
    head.append(el('h3', null, trend.title), decision, score);
    const meta = el('div', 'project-meta');
    [
      ['Industry', trend.industry],
      ['Audience', trend.demo],
      ['Platform', platform.primary ?? trend.platform],
      ['Window', decay.window ?? trend.velocity],
    ].forEach(([label, value]) => {
      const item = el('div', 'meta-box');
      item.append(el('small', null, label), el('strong', null, value || 'n/a'));
      meta.append(item);
    });
    const thesis = el('div', 'narrative-thesis');
    thesis.append(
      el('small', null, 'Why Now'),
      el('p', null, narrative.whyNow ?? trend.recommendedAngle ?? ''),
      el('small', null, 'Competitive Gap'),
      el('p', null, narrative.competitiveGap ?? 'Needs gap analysis.')
    );
    const play = el('div', 'platform-play');
    play.append(
      el('small', null, 'Platform Strategy'),
      el('strong', null, platform.move ?? 'Turn the strongest question into a platform-native video.'),
      el('span', null, platform.tone ?? 'clear, useful, evidence-led')
    );
    const evidence = el('div', 'evidence-list');
    evidence.append(el('small', null, 'Evidence'));
    (trend.evidence ?? []).slice(0, 3).forEach((item) => {
      const link = el('a', null, item.url);
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      evidence.append(link);
    });
    const actions = el('div', 'project-actions');
    actions.append(createTrendButton(trend));
    card.append(
      head,
      meta,
      thesis,
      dimensionGrid(narrative.dimensions ?? {}),
      angleList(narrative.angles ?? []),
      play,
      tags([trend.evidenceStrength, trend.brandSafety, trend.audienceFit, trend.status].filter(Boolean)),
      evidence,
      actions
    );
    return card;
  }));
}

function renderAssets(videoOs) {
  const assets = videoOs.assetIntelligence ?? {};
  const packs = assets.packs ?? [];
  document.querySelector('#asset-count').textContent = `${packs.length} packs`;
  document.querySelector('#asset-packs').replaceChildren(...packs.map((pack) => {
    const card = el('article', 'asset-card');
    const head = el('div', 'project-head');
    head.append(el('h3', null, pack.name), el('span', 'status', `${pack.count ?? 0} files`));
    card.append(
      head,
      el('p', null, pack.role ?? ''),
      tags(pack.bestUses ?? []),
      el('small', null, 'Recommended'),
      tags(pack.recommended ?? []),
    );
    if (pack.avoidForExecutive?.length) {
      card.append(el('small', null, 'Avoid For Executive Master'), tags(pack.avoidForExecutive));
    }
    if (pack.useSparingly?.length) {
      card.append(el('small', null, 'Use Sparingly'), tags(pack.useSparingly));
    }
    return card;
  }));

  document.querySelector('#scene-routing').replaceChildren(...(assets.sceneRouting ?? []).map((route) => {
    const card = el('article', 'route-card');
    card.append(el('h3', null, route.moment), el('p', null, route.direction ?? ''), tags(route.assets ?? []));
    return card;
  }));

  document.querySelector('#external-sources').replaceChildren(...(assets.externalSources ?? []).map((source) => {
    const card = el('article', 'source-card');
    card.append(
      el('h3', null, source.name),
      el('p', null, source.bestFor ?? ''),
      tags([source.type, source.status].filter(Boolean)),
      el('small', null, source.licenseNote ?? '')
    );
    return card;
  }));
}

document.querySelector('#project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.querySelector('#form-status');
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    payload.avatar = { avatarId: payload.avatarId, ...selectedTalent('#avatar-select') };
    payload.voice = { voiceId: payload.voiceId, ...selectedTalent('#voice-select') };
    try {
    if (!canUseLocalApi()) {
      createLocalProject(payload);
      event.currentTarget.reset();
      status.textContent = 'Project created in this browser. Generate Script will draft from the goal and selected topic.';
      return;
    }
    status.textContent = 'Creating persisted video project...';
    await api('/projects', payload);
    event.currentTarget.reset();
    status.textContent = 'Project created.';
  } catch (error) {
    status.textContent = error.message;
  }
});

document.querySelector('#trend-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.querySelector('#trend-status');
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  const form = event.currentTarget;
  const selectedPlatforms = [...form.querySelectorAll('input[name="platform"]:checked')].map((item) => item.value);
  payload.platforms = selectedPlatforms.length ? selectedPlatforms : ['reddit', 'youtube'];
  payload.topic = payload.topicPreset === '__custom__'
    ? String(payload.customTopic || '').trim()
    : payload.topicPreset;
  delete payload.topicPreset;
  delete payload.customTopic;
  delete payload.platform;
  payload.freshnessDays = Number(payload.freshnessDays || 30);
  if (!payload.topic) {
    status.textContent = 'Choose a topic preset or enter a custom topic.';
    return;
  }
  try {
    if (!canUseLocalApi()) {
      status.textContent = 'Hosted MVP trend scans require the local worker. Use the local app to run last30days evidence collection.';
      return;
    }
    status.textContent = 'Trend discovery queued. Run the next worker job to collect evidence.';
    await api('/trends/discover', payload);
  } catch (error) {
    status.textContent = error.message;
  }
});

document.querySelector('#run-next').addEventListener('click', async () => {
  try {
    if (!canUseLocalApi()) {
      document.querySelector('#connection-state').textContent = 'hosted static preview: workers run locally';
      document.querySelector('#queue-detail').textContent = 'Run Next Job is local-only. Use Generate Script on a project in this hosted MVP.';
      return;
    }
    await api('/jobs/run-next', {});
  } catch (error) {
    document.querySelector('#connection-state').textContent = error.message;
  }
});

document.querySelector('#refresh').addEventListener('click', async () => render(await load()));
document.querySelector('#project-search')?.addEventListener('input', (event) => {
  projectSearchText = event.currentTarget.value || '';
  if (state) renderProjects(state);
});
document.querySelector('#project-filter')?.addEventListener('change', (event) => {
  projectFilterMode = event.currentTarget.value || 'active';
  if (state) renderProjects(state);
});

setInterval(refreshRenderTimers, 1000);

if ('EventSource' in window && location.hostname === '127.0.0.1') {
  const source = new EventSource('/events');
  source.addEventListener('video-os', (event) => render(JSON.parse(event.data).videoOs));
}

initGate();
initWorkspaceTabs();
bindAdminForms();
load().then(render);

