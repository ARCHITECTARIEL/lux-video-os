import { randomUUID } from 'node:crypto';
import { mkdtemp, chmod, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireEvidence, sha256, evidenceDigest } from './core.mjs';

const LOGIN_PATHS = new Set(['/api/video-os-lite/password-login', '/api/video-os-lite/auth-verify', '/api/video-os-lite/google-callback', '/api/video-os-lite/ceo-access']);
const RENDER_PATHS = new Set(['/api/video-os-lite/render', '/api/video-os-lite/render-v2', '/api/video-os-lite/render-v2.js']);
const SUBMIT_PATH = '/api/video-os-lite/render-v2';
const MAX_BYTES = 100 * 1024 * 1024;

export function submissionGuard({ origin, title, state }, request) {
  const url = new URL(request.url());
  requireEvidence(url.origin === origin && RENDER_PATHS.has(url.pathname) && request.method() === 'POST', 'SUBMISSION_ROUTE_MISMATCH');
  requireEvidence(state.armed && state.sent === 0, 'ADDITIONAL_SUBMISSION_BLOCKED');
  const body = request.postDataJSON();
  requireEvidence(body?.title === title && body.tier === 'PREMIUM' && typeof body.idempotencyKey === 'string'
    && !request.headers()['x-request-id'] && state.expectedRequestDigest === evidenceDigest(body), 'SUBMISSION_INTENT_MISMATCH');
  state.sent += 1; // Consume before network. Never reset after response loss.
  return true;
}

// Always fresh nonpersistent contexts; no storageState, cookie injection, route
// fulfillment, response replay, traces, screenshots, or HAR recording.
export async function createBrowserCollector({ origin, prompt, chromium }) {
  const browser = await chromium.launch({ headless: false });
  const sessions = new Map();
  const state = { armed: false, sent: 0, violations: 0, title: null };
  let original;
  async function newContext() {
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
    requireEvidence((await context.cookies()).length === 0, 'CONTEXT_NOT_EMPTY');
    await context.route('**/api/video-os-lite/render**', async route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.continue();
      try {
        requireEvidence(context === original?.context, 'SUBMISSION_CONTEXT_MISMATCH');
        const outgoingHeaders = await request.allHeaders();
        const outgoingCookie = /(?:^|;\s*)vos_session=([^;]+)/.exec(outgoingHeaders.cookie || '')?.[1];
        requireEvidence(outgoingCookie && sha256(decodeURIComponent(outgoingCookie)) === original.sessionSha256
          && !outgoingHeaders['x-request-id'], 'SUBMISSION_SESSION_CHANGED');
        requireEvidence(submissionGuard({ origin, title: state.title, state }, request), 'SUBMISSION_ROUTE_MISMATCH');
        await route.continue();
      } catch { state.violations += 1; await route.abort('blockedbyclient'); }
    });
    return context;
  }
  async function readSession(context) {
    const response = await context.request.get(`${origin}/api/video-os-lite/session`, { maxRedirects: 0, timeout: 20_000 });
    try {
      requireEvidence(response.status() === 200, 'SESSION_RESPONSE_INVALID');
      const body = await response.json();
      requireEvidence(body.signedIn === true && typeof body.accountId === 'string', 'SESSION_NOT_SIGNED_IN');
      return body.accountId;
    } finally { await response.dispose(); }
  }
  async function status(context, url) {
    const response = await context.request.get(url, { maxRedirects: 0, timeout: 30_000 });
    try { return response.status(); } finally { await response.dispose(); }
  }
  return {
    async signIn(role) {
      const context = await newContext();
      const session = { contextId: randomUUID(), context, emptyContext: true, page: await context.newPage() };
      sessions.set(session.contextId, session);
      if (role === 'original') original = session;
      const issued = new Set();
      const tasks = [];
      const observe = response => {
        tasks.push((async () => {
          const url = new URL(response.url());
          if (url.origin !== origin || !LOGIN_PATHS.has(url.pathname) || ![200, 302, 303].includes(response.status())) return;
          for (const header of await response.headersArray()) {
            if (header.name.toLowerCase() !== 'set-cookie') continue;
            const token = /^vos_session=([^;]+)/.exec(header.value)?.[1];
            if (token) issued.add(sha256(decodeURIComponent(token)));
          }
        })());
      };
      context.on('response', observe);
      await session.page.goto(`${origin}/?signin=1`, { waitUntil: 'domcontentloaded' });
      await prompt(role === 'wrong-account'
        ? 'Sign in in the newly opened browser as a DIFFERENT existing account. Do not create or render anything. Press Enter after sign-in.'
        : `Sign in normally in the newly opened ${role} browser${role === 'recovery' ? ' as the SAME account used for the proof' : ''}. Press Enter after sign-in. Do not paste credentials here.`);
      await Promise.all(tasks);
      context.off('response', observe);
      const accountId = await readSession(context);
      const cookies = (await context.cookies(origin)).filter(cookie => cookie.name === 'vos_session');
      requireEvidence(cookies.length === 1 && cookies[0].httpOnly && cookies[0].secure, 'SESSION_COOKIE_INVALID');
      const sessionSha256 = sha256(decodeURIComponent(cookies[0].value));
      requireEvidence(issued.has(sessionSha256), 'NEW_SESSION_ISSUANCE_NOT_OBSERVED');
      Object.assign(session, { accountId, sessionSha256, signedIn: true, issuanceObserved: true });
      return { accountId, sessionSha256, signedIn: true, issuanceObserved: true, emptyContext: true, contextId: session.contextId };
    },
    async submitExactlyOne({ title, maxCredits, beforeSubmit = async () => {} }) {
      state.title = title;
      const page = original.page;
      await page.goto(`${origin}/#create`, { waitUntil: 'domcontentloaded' });
      // Operator selects the approved existing identity and exact script. No
      // identity creation, uploads, grant, or authorization mutation is automated.
      await prompt(`Prepare the approved Premium draft in the browser with an existing identity and approved script. Do not request a quote yet. Maximum approved cost: ${maxCredits} credits. Press Enter when ready.`);
      await page.locator('#premium-title').fill(title);
      const savePromise = page.waitForResponse(response => new URL(response.url()).origin === origin && new URL(response.url()).pathname === '/api/video-os-lite/scripted-photo' && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'save-project');
      const quotePromise = page.waitForResponse(response => new URL(response.url()).origin === origin && new URL(response.url()).pathname === '/api/video-os-lite/scripted-photo' && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'quote');
      await page.locator('#generate-video').click();
      const [saveResponse, quoteResponse] = await Promise.all([savePromise, quotePromise]);
      requireEvidence(saveResponse.ok() && quoteResponse.ok(), 'QUOTE_HTTP_FAILED');
      const saved = saveResponse.request().postDataJSON();
      const quoted = quoteResponse.request().postDataJSON();
      const quote = (await quoteResponse.json()).quote;
      requireEvidence(saved.title === title && saved.tier === 'PREMIUM' && quoted.tier === 'PREMIUM'
        && saved.projectId === quoted.projectId && saved.format === quoted.format
        && Number.isSafeInteger(quote?.credits) && quote.credits > 0 && quote.credits <= maxCredits
        && typeof quote.token === 'string' && Date.parse(quote.expiresAt) > Date.now(), 'QUOTE_BINDING_INVALID');
      const { action: _action, ...approvedDraft } = saved;
      state.expectedRequestDigest = evidenceDigest({ ...approvedDraft, idempotencyKey: quoted.idempotencyKey, quoteToken: quote.token });
      await page.locator('#scripted-photo-quote-dialog[open]').waitFor({ timeout: 30_000 });
      const summary = await page.locator('#scripted-photo-quote-summary').innerText();
      const priceText = await page.locator('#scripted-photo-quote-summary > div').filter({ has: page.locator('span', { hasText: /^Current price$/ }) }).locator('strong').innerText();
      // The quote UI is human reviewed, but the exact debit is independently
      // checked against the ceiling in the DB after execution as well.
      await prompt(`Review the displayed exact script, identity, format and price. Continue ONLY if within ${maxCredits} credits and the separately authorized provider-spend limit. Type APPROVE ONE RENDER to submit once.`, 'APPROVE ONE RENDER');
      requireEvidence(summary.includes(title), 'QUOTE_TITLE_MISMATCH');
      const creditMatches = [...priceText.replaceAll(',', '').matchAll(/^(\d+)\s+credits?$/gi)];
      requireEvidence(creditMatches.length === 1 && Number(creditMatches[0][1]) > 0
        && Number(creditMatches[0][1]) === quote.credits && Number(creditMatches[0][1]) <= maxCredits, 'QUOTE_CREDIT_LIMIT_UNVERIFIED');
      await beforeSubmit();
      const activeAccount = await readSession(original.context);
      const activeCookies = (await original.context.cookies(origin)).filter(cookie => cookie.name === 'vos_session');
      requireEvidence(activeAccount === original.accountId && activeCookies.length === 1
        && sha256(decodeURIComponent(activeCookies[0].value)) === original.sessionSha256, 'SUBMISSION_SESSION_CHANGED');
      requireEvidence(Date.parse(quote.expiresAt) > Date.now(), 'QUOTE_EXPIRED');
      state.armed = true;
      const responsePromise = page.waitForResponse(response => new URL(response.url()).origin === origin
        && new URL(response.url()).pathname === SUBMIT_PATH && response.request().method() === 'POST', { timeout: 60_000 });
      let response;
      try {
        [response] = await Promise.all([responsePromise, page.locator('#scripted-photo-quote-confirm').click()]);
      } finally { state.armed = false; }
      requireEvidence([200, 202].includes(response.status()), 'SUBMISSION_HTTP_FAILED');
      const body = await response.json();
      requireEvidence(/^job-[a-f0-9-]{36}$/.test(body.job?.id || ''), 'JOB_ID_INVALID');
      requireEvidence(body.ok === true && body.job?.id && body.correlationId && body.job.correlationId === body.correlationId, 'SUBMISSION_RESPONSE_INVALID');
      return { jobId: body.job.id, correlationId: body.correlationId, recovered: body.recovered === true,
        requestDigest: state.expectedRequestDigest, requestCount: state.sent, requestHadCorrelationHeader: Boolean(response.request().headers()['x-request-id']) };
    },
    async galleryDownload(reference, job) {
      const session = sessions.get(reference.contextId);
      requireEvidence(session && await readSession(session.context) === reference.accountId, 'SESSION_CHANGED');
      // Normal entry and gallery navigation only, not a result API replay or
      // localStorage injection. Observe the app's own results request.
      const historyPromise = session.page.waitForResponse(response => new URL(response.url()).origin === origin
        && new URL(response.url()).pathname === '/api/video-os-lite/results' && response.request().method() === 'GET', { timeout: 30_000 });
      await session.page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      const history = await historyPromise;
      requireEvidence(history.status() === 200, 'GALLERY_HTTP_FAILED');
      const body = await history.json();
      requireEvidence(body.accountId === reference.accountId && body.results?.some(item => item.id === job.id
        && item.correlationId === job.correlationId && item.outputAccepted === true), 'GALLERY_JOB_MISSING');
      await session.page.locator('a[data-nav="videos"]').first().click();
      const card = session.page.locator('article.result-card').filter({ has: session.page.locator(`a[href="/api/video-os-lite/download?jobId=${encodeURIComponent(job.id)}"]`) });
      if (!(await card.isVisible()) && await session.page.locator('#result-gallery-toggle').isVisible()) await session.page.locator('#result-gallery-toggle').click();
      await card.waitFor({ state: 'visible', timeout: 30_000 });
      const link = card.getByRole('link', { name: 'Download', exact: true });
      const href = await link.getAttribute('href');
      requireEvidence(new URL(href, origin).href === `${origin}/api/video-os-lite/download?jobId=${encodeURIComponent(job.id)}`, 'DOWNLOAD_URL_MISMATCH');
      const temp = await mkdtemp(join(tmpdir(), 'p0-download-'));
      await chmod(temp, 0o700);
      try {
        const [download] = await Promise.all([session.page.waitForEvent('download', { timeout: 90_000 }), link.click()]);
        requireEvidence(await download.failure() === null, 'BROWSER_DOWNLOAD_FAILED');
        const file = join(temp, 'final.mp4');
        await download.saveAs(file); await chmod(file, 0o600);
        const size = await lstat(file);
        requireEvidence(size.isFile() && !size.isSymbolicLink() && size.size > 0 && size.size <= MAX_BYTES
          && size.size === job.output?.bytes, 'DOWNLOAD_BYTES_INVALID');
        const bytes = await readFile(file);
        requireEvidence(bytes.length > 0 && bytes.length <= MAX_BYTES, 'DOWNLOAD_BYTES_INVALID');
        await download.delete();
        return { galleryRecovered: true, sha256: sha256(bytes), bytes: bytes.length };
      } finally { await rm(temp, { recursive: true, force: true }); }
    },
    async denials({ wrong, jobId, privateUrl }) {
      const anonymous = await newContext();
      const wrongSession = sessions.get(wrong.contextId);
      requireEvidence(await readSession(wrongSession.context) === wrong.accountId, 'WRONG_SESSION_CHANGED');
      const download = `${origin}/api/video-os-lite/download?jobId=${encodeURIComponent(jobId)}`;
      const blob = new URL(privateUrl);
      requireEvidence(blob.protocol === 'https:' && /^[a-z0-9-]+\.private\.blob\.vercel-storage\.com$/.test(blob.hostname)
        && !blob.username && !blob.password && !blob.search && !blob.hash, 'PRIVATE_BLOB_URL_INVALID');
      try { return { anonymous: await status(anonymous, download), wrongAccount: await status(wrongSession.context, download), privateBlob: await status(anonymous, blob.href) }; }
      finally { await anonymous.close(); }
    },
    async closeSession(reference) { const session = sessions.get(reference.contextId); await session?.context.close(); sessions.delete(reference.contextId); },
    async assertSingleSubmission() { requireEvidence(state.sent === 1 && state.violations === 0, 'ADDITIONAL_SUBMISSION_BLOCKED'); },
    async submissionMayHaveOccurred() { return state.sent > 0; },
    async close() { await browser.close(); },
  };
}
