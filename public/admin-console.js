const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
};

const ADMIN_BASE = '/api/video-os-lite/admin';
const panelData = { overview: null, jobs: null, attention: null, accounts: null, billing: null };
let currentTimelineJob = null;

async function getJson(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error('Admin console received an unreadable response.'), { status: response.status });
  }
  if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || `Request failed with status ${response.status}.`), { status: response.status });
  return data;
}

function postJson(url, body) {
  return getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function setStatus(message, isError = false) {
  const el = $('#admin-status');
  el.textContent = message || '';
  el.style.color = isError ? 'var(--danger)' : '';
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function statCard(label, value, detail, tone) {
  const card = node('div', 'stat-card');
  if (tone) card.dataset.tone = tone;
  card.append(node('span', 'stat-label', label), node('span', 'stat-value', String(value)));
  if (detail) card.append(node('span', 'stat-detail', detail));
  return card;
}

function renderOverview(overview) {
  const grid = $('#stat-grid');
  grid.textContent = '';
  grid.append(
    statCard('Total accounts', overview.users.total, `${overview.users.new7d} new in 7d · ${overview.users.new30d} in 30d`),
    statCard('Sign-ins (7d)', overview.signIns.last7d),
    statCard('Sign-ins (30d)', overview.signIns.last30d),
    statCard('Credit balance', overview.credits.balance, `${overview.credits.reserved} reserved`),
    statCard('Purchased / spent', `${overview.credits.purchased} / ${overview.credits.spent}`),
  );

  const statusGrid = $('#status-grid');
  statusGrid.textContent = '';
  const statuses = Object.entries(overview.jobsByStatus).sort((a, b) => b[1] - a[1]);
  if (!statuses.length) statusGrid.append(node('p', 'inline-empty', 'No jobs recorded yet.'));
  for (const [status, count] of statuses) {
    const tone = ['failed', 'cancelled', 'provider_submit_unknown'].includes(status) ? 'danger' : undefined;
    statusGrid.append(statCard(status, count, null, tone));
  }

  const banner = $('#reconciliation-banner');
  const { stuckJobs, readyWithoutAsset } = overview.reconciliation;
  if (stuckJobs > 0 || readyWithoutAsset > 0) {
    banner.hidden = false;
    banner.textContent = '';
    const parts = [];
    if (stuckJobs > 0) parts.push(`${stuckJobs} job(s) stuck past 30 minutes`);
    if (readyWithoutAsset > 0) parts.push(`${readyWithoutAsset} ready job(s) missing their final asset`);
    banner.append(node('strong', null, 'Reconciliation: '), node('span', null, parts.join(' · ')));
  } else {
    banner.hidden = true;
  }
}

function renderAttention(jobs) {
  const tbody = $('#attention-table tbody');
  tbody.textContent = '';
  $('#attention-empty').hidden = jobs.length > 0;
  for (const job of jobs) {
    const row = node('tr');
    row.append(
      node('td', 'mono', job.id),
      node('td', 'mono', job.accountId),
      node('td', null, job.provider),
      node('td', null, job.status),
      node('td', null, job.failureCategory || '—'),
      node('td', null, formatDate(job.updatedAt)),
    );
    const actionCell = node('td');
    const button = node('button', 'button quiet compact', 'View timeline');
    button.type = 'button';
    button.addEventListener('click', () => openJobTimeline(job, { allowResolve: true }));
    actionCell.append(button);
    row.append(actionCell);
    tbody.append(row);
  }
}

function renderJobsTable(jobs) {
  const tbody = $('#jobs-table tbody');
  tbody.textContent = '';
  $('#jobs-empty').hidden = jobs.length > 0;
  for (const job of jobs) {
    const row = node('tr');
    row.append(
      node('td', 'mono', job.id),
      node('td', 'mono', job.accountId),
      node('td', null, job.provider),
      node('td', null, job.status),
      node('td', null, formatDate(job.updatedAt)),
    );
    const actionCell = node('td');
    const button = node('button', 'button quiet compact', 'View');
    button.type = 'button';
    button.addEventListener('click', () => openJobTimeline(job, { allowResolve: ['failed', 'provider_submit_unknown'].includes(job.status) }));
    actionCell.append(button);
    row.append(actionCell);
    tbody.append(row);
  }
}

function renderAccounts(accounts) {
  const tbody = $('#accounts-table tbody');
  tbody.textContent = '';
  for (const account of accounts) {
    const row = node('tr');
    row.append(
      node('td', 'mono', account.accountId),
      node('td', null, account.email || '—'),
      node('td', null, account.role),
      node('td', null, formatDate(account.createdAt)),
      node('td', null, String(account.balance ?? 0)),
      node('td', null, String(account.reserved ?? 0)),
    );
    tbody.append(row);
  }
}

function renderBilling({ transactions, events }) {
  const ledgerBody = $('#ledger-table tbody');
  ledgerBody.textContent = '';
  for (const tx of transactions) {
    const row = node('tr');
    row.append(
      node('td', 'mono', tx.accountId),
      node('td', null, tx.sourceType),
      node('td', null, String(tx.amount)),
      node('td', null, String(tx.balanceAfter)),
      node('td', null, formatDate(tx.createdAt)),
    );
    ledgerBody.append(row);
  }

  const stripeBody = $('#stripe-table tbody');
  stripeBody.textContent = '';
  for (const event of events) {
    const row = node('tr');
    row.append(
      node('td', 'mono', event.stripeEventId),
      node('td', null, event.eventType),
      node('td', null, event.livemode ? 'yes' : 'no'),
      node('td', null, event.status),
      node('td', 'mono', event.accountId || '—'),
      node('td', null, formatDate(event.receivedAt)),
    );
    stripeBody.append(row);
  }
}

async function loadJobAssets(jobId) {
  const section = $('#job-assets-section');
  const list = $('#job-assets-list');
  list.textContent = '';
  try {
    const data = await getJson(`${ADMIN_BASE}?operation=job-assets&jobId=${encodeURIComponent(jobId)}`);
    if (!data.assets.length) { section.hidden = true; return; }
    section.hidden = false;
    for (const asset of data.assets) renderAssetRow(list, asset);
  } catch {
    section.hidden = true;
  }
}

function renderAssetRow(list, asset) {
  const item = node('li');
  item.dataset.quarantined = String(Boolean(asset.quarantinedAt));
  const meta = node('span', 'asset-meta', `${asset.kind} · ${asset.contentType} · ${asset.bytes} bytes`);
  item.append(meta);
  if (asset.quarantinedAt) {
    item.append(node('span', 'asset-quarantined-label', `Quarantined ${formatDate(asset.quarantinedAt)}`));
  } else {
    const button = node('button', 'button quiet compact', 'Quarantine');
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Quarantining…';
      try {
        await postJson(`${ADMIN_BASE}?operation=quarantine-asset`, { mediaAssetId: asset.id, reason: 'Quarantined from admin console job review.' });
        item.remove();
        renderAssetRow(list, { ...asset, quarantinedAt: new Date().toISOString() });
      } catch (error) {
        setStatus(error.message || 'Could not quarantine this asset.', true);
        button.disabled = false;
        button.textContent = 'Quarantine';
      }
    });
    item.append(button);
  }
  list.append(item);
}

function renderJobVideoSection(job) {
  currentTimelineJob = job;
  const player = $('#job-video-player');
  const empty = $('#job-video-empty');
  const deleteButton = $('#job-delete-video-button');
  const retryButton = $('#job-retry-button');
  const approveButton = $('#job-approve-button');
  deleteButton.dataset.armed = 'false';
  deleteButton.textContent = 'Delete video';

  if (job.status === 'ready' && !job.videoDeletedAt) {
    player.hidden = false;
    player.src = `${ADMIN_BASE}?operation=video&jobId=${encodeURIComponent(job.id)}`;
    empty.hidden = true;
    deleteButton.hidden = false;
  } else {
    player.hidden = true;
    player.removeAttribute('src');
    empty.hidden = false;
    empty.textContent = job.videoDeletedAt ? `Video deleted ${formatDate(job.videoDeletedAt)}.` : 'This job has no final video yet.';
    deleteButton.hidden = true;
  }

  approveButton.disabled = false;
  approveButton.textContent = job.reviewedAt ? `Reviewed ✓ ${formatDate(job.reviewedAt)}` : 'Approve';
  retryButton.hidden = job.provider !== 'heygen';
  retryButton.disabled = false;
  retryButton.textContent = 'Retry render';
}

async function openJobTimeline(job, { allowResolve = false } = {}) {
  const jobId = job.id;
  const dialog = $('#job-timeline-dialog');
  $('#job-timeline-subtitle').textContent = jobId;
  const list = $('#job-timeline-list');
  list.textContent = '';
  list.append(node('li', null, 'Loading…'));
  $('#job-assets-section').hidden = true;
  $('#job-video-section').hidden = false;
  renderJobVideoSection(job);
  $('#job-resolve-section').hidden = !allowResolve;
  $('#job-resolve-note').value = '';
  dialog.showModal();
  try {
    const data = await getJson(`${ADMIN_BASE}?operation=job-events&jobId=${encodeURIComponent(jobId)}`);
    list.textContent = '';
    if (!data.events.length) list.append(node('li', null, 'No events recorded for this job.'));
    for (const event of data.events) {
      const item = node('li');
      const stageLine = node('span', 'timeline-stage', `${event.stageFrom || '—'} → ${event.stageTo || event.eventType}`);
      const meta = node('span', 'timeline-meta', [formatDate(event.createdAt), event.eventType, event.failureCategory].filter(Boolean).join(' · '));
      item.append(stageLine, meta);
      list.append(item);
    }
  } catch (error) {
    list.textContent = '';
    list.append(node('li', null, error.message || 'Could not load this job’s timeline.'));
  }
  await loadJobAssets(jobId);
}

function invalidateJobLists() {
  panelData.jobs = null;
  panelData.attention = null;
  panelData.overview = null;
}

async function approveCurrentJob() {
  if (!currentTimelineJob) return;
  const button = $('#job-approve-button');
  button.disabled = true;
  button.textContent = 'Approving…';
  try {
    const data = await postJson(`${ADMIN_BASE}?operation=approve-job`, { jobId: currentTimelineJob.id });
    renderJobVideoSection(data.job);
    setStatus(`Job ${currentTimelineJob.id} marked reviewed.`);
  } catch (error) {
    setStatus(error.message || 'Could not approve this job.', true);
    button.disabled = false;
    button.textContent = 'Approve';
  }
}

async function deleteCurrentJobVideo() {
  if (!currentTimelineJob) return;
  const button = $('#job-delete-video-button');
  if (button.dataset.armed !== 'true') {
    button.dataset.armed = 'true';
    button.textContent = 'Confirm delete — cannot be undone';
    return;
  }
  button.disabled = true;
  button.textContent = 'Deleting…';
  try {
    const data = await postJson(`${ADMIN_BASE}?operation=delete-video`, { jobId: currentTimelineJob.id });
    renderJobVideoSection(data.job);
    invalidateJobLists();
    setStatus(`Video deleted for job ${currentTimelineJob.id}. The job record and its event history are kept.`);
  } catch (error) {
    setStatus(error.message || 'Could not delete this video.', true);
    button.disabled = false;
    button.dataset.armed = 'false';
    button.textContent = 'Delete video';
  }
}

async function retryCurrentJob() {
  if (!currentTimelineJob) return;
  const button = $('#job-retry-button');
  button.disabled = true;
  button.textContent = 'Starting render…';
  try {
    const data = await postJson(`${ADMIN_BASE}?operation=retry-job`, { jobId: currentTimelineJob.id });
    invalidateJobLists();
    setStatus(`Retry started as new job ${data.job.id}.`);
    $('#job-timeline-dialog').close();
    await openJobTimeline(data.job, { allowResolve: false });
  } catch (error) {
    setStatus(error.message || 'Could not start a retry render.', true);
    button.disabled = false;
    button.textContent = 'Retry render';
  }
}

async function resolveCurrentJob() {
  if (!currentTimelineJob) return;
  const jobId = currentTimelineJob.id;
  const button = $('#job-resolve-confirm');
  button.disabled = true;
  button.textContent = 'Resolving…';
  try {
    await postJson(`${ADMIN_BASE}?operation=resolve-job`, { jobId, note: $('#job-resolve-note').value });
    setStatus(`Job ${jobId} marked failed and any reserved credits released.`);
    invalidateJobLists();
    $('#job-timeline-dialog').close();
    await loadPanel('attention', true);
  } catch (error) {
    setStatus(error.message || 'Could not resolve this job.', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Mark failed & release credits';
  }
}

async function loadPanel(name, force = false) {
  if (panelData[name] && !force) return;
  setStatus('Loading…');
  try {
    if (name === 'overview') {
      const data = await getJson(`${ADMIN_BASE}?operation=overview`);
      panelData.overview = data.overview;
      renderOverview(data.overview);
    } else if (name === 'jobs') {
      const data = await getJson(`${ADMIN_BASE}?operation=jobs`);
      panelData.jobs = data.jobs;
      renderJobsTable(data.jobs);
    } else if (name === 'attention') {
      const data = await getJson(`${ADMIN_BASE}?operation=attention`);
      panelData.attention = data.jobs;
      renderAttention(data.jobs);
    } else if (name === 'accounts') {
      const data = await getJson(`${ADMIN_BASE}?operation=accounts`);
      panelData.accounts = data.accounts;
      renderAccounts(data.accounts);
    } else if (name === 'billing') {
      const [ledger, stripe] = await Promise.all([
        getJson(`${ADMIN_BASE}?operation=credit-ledger`),
        getJson(`${ADMIN_BASE}?operation=stripe-events`),
      ]);
      panelData.billing = { transactions: ledger.transactions, events: stripe.events };
      renderBilling(panelData.billing);
    }
    setStatus('');
  } catch (error) {
    setStatus(error.message || 'Could not load admin data.', true);
  }
}

function activateTab(name) {
  for (const button of $$('[data-admin-tab]')) button.setAttribute('aria-selected', String(button.dataset.adminTab === name));
  for (const panel of $$('.admin-panel')) panel.hidden = panel.id !== `panel-${name}`;
  loadPanel(name);
}

async function init() {
  try {
    await getJson(`${ADMIN_BASE}?operation=overview`);
  } catch (error) {
    if (error.status === 401) {
      $('#admin-denied').hidden = false;
      $('#admin-auth-state').textContent = 'Signed out';
      $('#admin-auth-state').dataset.state = 'error';
      return;
    }
    setStatus(error.message || 'Could not reach the admin API.', true);
  }
  $('#admin-auth-state').textContent = 'Owner access';
  $('#admin-auth-state').dataset.state = 'signed-in';
  $('#admin-content').hidden = false;
  activateTab('overview');

  for (const button of $$('[data-admin-tab]')) button.addEventListener('click', () => activateTab(button.dataset.adminTab));
  $('#admin-refresh').addEventListener('click', () => {
    const active = $$('[data-admin-tab]').find((button) => button.getAttribute('aria-selected') === 'true');
    const name = active?.dataset.adminTab || 'overview';
    panelData[name] = null;
    loadPanel(name, true);
  });
  $('#job-timeline-close').addEventListener('click', () => {
    $('#job-video-player').removeAttribute('src');
    currentTimelineJob = null;
    $('#job-timeline-dialog').close();
  });
  $('#job-resolve-confirm').addEventListener('click', resolveCurrentJob);
  $('#job-approve-button').addEventListener('click', approveCurrentJob);
  $('#job-delete-video-button').addEventListener('click', deleteCurrentJobVideo);
  $('#job-retry-button').addEventListener('click', retryCurrentJob);
}

init();
