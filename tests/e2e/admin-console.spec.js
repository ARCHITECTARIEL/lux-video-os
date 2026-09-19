import { expect, test } from '@playwright/test';

const overview = {
  users: { total: 42, new7d: 3, new30d: 9 },
  signIns: { last7d: 11, last30d: 30 },
  jobsByStatus: { ready: 12, failed: 2, provider_rendering: 1 },
  credits: { balance: 5000, reserved: 300, purchased: 8000, spent: 3000 },
  reconciliation: { stuckJobs: 1, readyWithoutAsset: 0 },
};

const attentionJobs = [
  { id: 'job-proof-1', accountId: 'account-proof-1', provider: 'heygen', status: 'failed', failureCategory: 'PROVIDER_SUBMIT', updatedAt: '2026-09-19T20:00:00.000Z' },
];

const accounts = [
  { accountId: 'account-proof-1', email: 'proof@example.test', role: 'customer', createdAt: '2026-09-18T12:00:00.000Z', balance: 200, reserved: 0 },
];

const jobEvents = [
  { stageFrom: null, stageTo: 'reserved', eventType: 'render.reserved', failureCategory: null, createdAt: '2026-09-19T19:58:00.000Z' },
  { stageFrom: 'reserved', stageTo: 'workflow_started', eventType: 'workflow.prepared', failureCategory: null, createdAt: '2026-09-19T19:58:05.000Z' },
  { stageFrom: 'workflow_started', stageTo: 'failed', eventType: 'workflow.failed', failureCategory: 'PROVIDER_SUBMIT', createdAt: '2026-09-19T19:58:10.000Z' },
];

async function stubAdminApi(page, { authorized = true } = {}) {
  await page.route('**/api/video-os-lite/admin*', async (route) => {
    if (!authorized) return route.fulfill({ status: 401, json: { ok: false, error: 'Admin login required.' } });
    const url = new URL(route.request().url());
    const operation = url.searchParams.get('operation') || 'jobs';
    if (operation === 'overview') return route.fulfill({ json: { ok: true, overview } });
    if (operation === 'attention') return route.fulfill({ json: { ok: true, jobs: attentionJobs } });
    if (operation === 'accounts') return route.fulfill({ json: { ok: true, accounts } });
    if (operation === 'job-events') return route.fulfill({ json: { ok: true, jobId: url.searchParams.get('jobId'), events: jobEvents } });
    return route.fulfill({ status: 400, json: { ok: false, error: `Unknown admin operation: ${operation}` } });
  });
}

test('unauthorized visitors see the sign-in-required message, not the console', async ({ page }) => {
  await stubAdminApi(page, { authorized: false });
  await page.goto('/admin-console.html');
  await expect(page.locator('#admin-denied')).toBeVisible();
  await expect(page.locator('#admin-content')).toBeHidden();
  await expect(page.locator('#admin-auth-state')).toHaveText('Signed out');
});

test('authorized owner sees real overview stats and can switch tabs', async ({ page }) => {
  await stubAdminApi(page);
  await page.goto('/admin-console.html');
  await expect(page.locator('#admin-content')).toBeVisible();
  await expect(page.locator('#admin-auth-state')).toHaveText('Owner access');

  const statGrid = page.locator('#stat-grid');
  await expect(statGrid).toContainText('42');
  await expect(statGrid).toContainText('11');
  await expect(statGrid).toContainText('5000');
  await expect(page.locator('#reconciliation-banner')).toBeVisible();
  await expect(page.locator('#reconciliation-banner')).toContainText('1 job(s) stuck');

  await page.locator('[data-admin-tab="attention"]').click();
  await expect(page.locator('#panel-attention')).toBeVisible();
  await expect(page.locator('#attention-table')).toContainText('job-proof-1');
  await expect(page.locator('#attention-table')).toContainText('PROVIDER_SUBMIT');

  await page.locator('[data-admin-tab="accounts"]').click();
  await expect(page.locator('#panel-accounts')).toBeVisible();
  await expect(page.locator('#accounts-table')).toContainText('proof@example.test');
});

test('viewing a job timeline shows its real, ordered stage history', async ({ page }) => {
  await stubAdminApi(page);
  await page.goto('/admin-console.html');
  await page.locator('[data-admin-tab="attention"]').click();
  await page.locator('#attention-table button', { hasText: 'View timeline' }).click();

  const dialog = page.locator('#job-timeline-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('job-proof-1');
  const items = dialog.locator('.timeline-list li');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('reserved');
  await expect(items.nth(2)).toContainText('failed');
  await expect(items.nth(2)).toContainText('PROVIDER_SUBMIT');

  await page.locator('#job-timeline-close').click();
  await expect(dialog).toBeHidden();
});

