const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
};

const ADMIN_BASE = '/api/video-os-lite/admin';
const panelData = { overview: null, attention: null, accounts: null };

async function getJson(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
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
    button.addEventListener('click', () => openJobTimeline(job.id));
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

async function openJobTimeline(jobId) {
  const dialog = $('#job-timeline-dialog');
  $('#job-timeline-subtitle').textContent = jobId;
  const list = $('#job-timeline-list');
  list.textContent = '';
  list.append(node('li', null, 'Loading…'));
  dialog.showModal();
  try {
    const data = await getJson(`${ADMIN_BASE}?operation=job-events&jobId=${encodeURIComponent(jobId)}`);
    list.textContent = '';
    if (!data.events.length) { list.append(node('li', null, 'No events recorded for this job.')); return; }
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
}

async function loadPanel(name, force = false) {
  if (panelData[name] && !force) return;
  setStatus('Loading…');
  try {
    if (name === 'overview') {
      const data = await getJson(`${ADMIN_BASE}?operation=overview`);
      panelData.overview = data.overview;
      renderOverview(data.overview);
    } else if (name === 'attention') {
      const data = await getJson(`${ADMIN_BASE}?operation=attention`);
      panelData.attention = data.jobs;
      renderAttention(data.jobs);
    } else if (name === 'accounts') {
      const data = await getJson(`${ADMIN_BASE}?operation=accounts`);
      panelData.accounts = data.accounts;
      renderAccounts(data.accounts);
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
  $('#job-timeline-close').addEventListener('click', () => $('#job-timeline-dialog').close());
}

init();
