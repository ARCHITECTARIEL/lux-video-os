import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL || process.env.VIDEO_OS_PROOF_BASE_URL || 'http://127.0.0.1:4187', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: process.env.VIDEO_OS_PROOF_BASE_URL ? undefined : { command: 'node tools/serve-public.mjs --port 4187', url: 'http://127.0.0.1:4187', reuseExistingServer: false },
});
