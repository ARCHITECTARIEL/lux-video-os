// LUXIFY staff page. Uses the same strict JSON/Origin endpoint as consent.
// Ids live only in memory for follow-up calls; the page displays masked refs.
const endpoint = '/api/video-os-lite/luxify-consent';
const $ = id => document.getElementById(id);
const page = { context: null, subject: null };

function setStatus(message) { $('status').textContent = message; }
function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
function button(label, onClick) { const node = text('button', label); node.type = 'button'; node.addEventListener('click', onClick); return node; }
const mask = value => { const s = String(value || ''); return s.length > 4 ? `…${s.slice(-4)}` : '…'; };

async function call(body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error('Sign in, then reload this page.');
  if (!response.ok || !payload.ok) throw new Error(payload.error || 'Request failed.');
  return payload;
}

async function guarded(work, done) {
  try { await work(); if (done) setStatus(done); } catch (error) { setStatus(error.message); }
}

async function loadStaff() {
  const { grants } = await call({ action: 'list-staff' });
  $('staff-list').replaceChildren(...grants.map(grant => {
    const item = text('li', `${grant.emailRef} · account ${grant.staffRef} · ${grant.active ? 'active' : 'revoked'} · granted ${new Date(grant.grantedAt).toLocaleDateString()}`);
    if (grant.active) {
      item.append(' ', button('Revoke', () => guarded(async () => {
        if (!window.confirm('Revoke this staff access? Their look approvals and capability evidence close with it.')) return;
        await call({ action: 'revoke-staff', staffAccountId: grant.staffAccountId });
        await loadStaff();
      }, 'Staff access revoked.')));
    }
    return item;
  }));
}

function refreshGrant() {
  $('grant-staff').disabled = !($('explicit-grant').checked && $('staff-email').value.trim());
}

function selectedLook() {
  return page.subject?.identities.find(look => look.identityId === $('look').value) || null;
}

function refreshLookButtons() {
  const ready = Boolean(page.context?.hasStaffGrant && selectedLook());
  $('check-capability').disabled = !ready;
  $('approve-look').disabled = !ready;
}

async function loadApprovals() {
  if (!page.subject || !page.context?.hasStaffGrant) { $('approvals').replaceChildren(); return; }
  const { approvals } = await call({ action: 'list-look-approvals', accountId: page.subject.accountId });
  $('approvals').replaceChildren(...approvals.map(approval => {
    const item = text('li', `look ${approval.lookRef} · ${approval.status} · expires ${new Date(approval.expiresAt).toLocaleDateString()} · ref ${mask(approval.approvalId)}`);
    if (approval.open) {
      item.append(' ', button('Revoke approval', () => guarded(async () => {
        await call({ action: 'revoke-look-approval', approvalId: approval.approvalId });
        await loadApprovals();
      }, 'Look approval revoked.')));
    }
    return item;
  }));
}

$('staff-email').addEventListener('input', refreshGrant);
$('explicit-grant').addEventListener('change', refreshGrant);
$('look').addEventListener('change', refreshLookButtons);

$('grant-staff').addEventListener('click', () => guarded(async () => {
  const target = await call({ action: 'staff-lookup', email: $('staff-email').value.trim() });
  if (!target.emailVerified) throw new Error('That account has not verified its email yet. They need to sign in once with an email link.');
  await call({ action: 'grant-staff', staffAccountId: target.accountId, explicitGrant: $('explicit-grant').checked === true });
  $('explicit-grant').checked = false;
  refreshGrant();
  await loadStaff();
}, 'Staff access granted.'));

$('find-subject').addEventListener('click', () => guarded(async () => {
  page.subject = await call({ action: 'staff-lookup', email: $('subject-email').value.trim() });
  $('subject-summary').textContent = `Account ${page.subject.accountRef} · ${page.subject.identities.length} ready look(s)`;
  $('look').replaceChildren(...page.subject.identities.map(look => {
    const option = text('option', `${look.displayName} (look ${look.lookRef})`);
    option.value = look.identityId;
    return option;
  }));
  $('capability-result').textContent = '';
  refreshLookButtons();
  await loadApprovals();
}, 'Account loaded.'));

$('check-capability').addEventListener('click', () => guarded(async () => {
  const look = selectedLook();
  if (!look) return;
  $('check-capability').disabled = true;
  const result = await call({ action: 'check-capability', accountId: page.subject.accountId, identityId: look.identityId });
  $('capability-result').textContent = `${result.eligible ? 'Eligible' : 'Not eligible'} for cinematic avatar · type ${result.avatarType} · engines ${result.supportedApiEngines.join(', ') || 'none'} · evidence ${result.evidenceRef} · valid until ${new Date(result.expiresAt).toLocaleDateString()}`;
  refreshLookButtons();
}, 'Capability check recorded.'));

$('approve-look').addEventListener('click', () => guarded(async () => {
  const look = selectedLook();
  if (!look) return;
  await call({ action: 'approve-look', accountId: page.subject.accountId, identityId: look.identityId });
  await loadApprovals();
}, 'Look approved for 30 days.'));

async function start() {
  page.context = await call({ action: 'staff-context' });
  $('staff-panel').hidden = !page.context.canManageStaff;
  $('look-panel').hidden = false;
  if (page.context.canManageStaff) await loadStaff();
  setStatus(page.context.hasStaffGrant ? 'Ready.' : page.context.isCeo && !page.context.ceoEmailVerified
    ? 'Your owner email is not verified yet. Sign in once with an email link, then reload.'
    : 'You can manage staff. Grant yourself staff access to check and approve looks.');
  refreshLookButtons();
}

start().catch(error => setStatus(error.message));
