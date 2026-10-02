// Offline browser integration only. Uses the SHIPPED scripted-photo client to
// detect endpoint/tier/quote drift; fixture responses never qualify as P0 proof.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createBrowserCollector } from '../../tools/p0-evidence/browser.mjs';
import { checkSession, sha256 } from '../../tools/p0-evidence/core.mjs';

const jobId = 'job-01234567-1234-4123-8123-012345678902';
const title = 'P0-PROOF-20261002T150000000Z-01234567-1234-4123-8123-012345678901';
const media = Buffer.from('offline-download-hash-fixture-not-real-media');
const shell = `<!doctype html><html><body>
<button id="login">Fixture sign-in</button><a data-nav="videos" href="#videos">My Videos</a>
<input id="premium-title"><button id="generate-video">Review Premium price</button>
<dialog id="scripted-photo-quote-dialog"><div id="scripted-photo-quote-summary"></div><button id="scripted-photo-quote-confirm">Confirm and start render</button></dialog>
<div id="result-gallery"></div><button id="result-gallery-toggle" hidden>All videos</button>
<script type="module">
import { createScriptedPhotoClient } from '/scripted-photo-client.js';
const request = async (url, options={}) => { const r = await fetch(url, { ...options, headers: {'Content-Type':'application/json'} }); const data = await r.json(); if (!r.ok) throw new Error('fixture request failed'); return data; };
const client = createScriptedPhotoClient({ request, storage: localStorage });
const draft = () => ({ title: document.querySelector('#premium-title').value, script: 'Approved fixture script with 200 credits mentioned', identityId: '01234567-1234-4123-8123-012345678903', format:'landscape' });
const history = async () => { const r = await request('/api/video-os-lite/results'); document.querySelector('#result-gallery').innerHTML = r.results.map(j => '<article class="result-card"><a href="/api/video-os-lite/download?jobId='+j.id+'" download="video.mp4">Download</a></article>').join(''); };
document.querySelector('#login').onclick = async () => { await request('/api/video-os-lite/password-login', { method:'POST', body: '{}' }); await history(); };
await client.loadCapabilities(); client.setScope('fixture-owner');
document.querySelector('#generate-video').onclick = async () => { const d = draft(); const result = await client.prepareQuote('PREMIUM', d); document.querySelector('#scripted-photo-quote-summary').innerHTML = '<div><span>Title</span><strong>'+d.title+'</strong></div><div><span>Script</span><strong>'+d.script+'</strong></div><div><span>Current price</span><strong>'+result.quote.credits.toLocaleString('en-US')+' credits</strong></div>'; document.querySelector('dialog').showModal(); };
document.querySelector('#scripted-photo-quote-confirm').onclick = async () => { await client.submit('PREMIUM', draft()); document.querySelector('dialog').close(); await history(); };
await history();
</script></body></html>`;

async function harness(browser, credits = 90) {
  const contexts = [], tokens = new Map(); let current, rendered = false, renderCount = 0, loginCount = 0;
  const client = await readFile(new URL('../../public/scripted-photo-client.js', import.meta.url), 'utf8');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const token = /vos_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const accountId = tokens.get(token);
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(shell); }
    if (url.pathname === '/scripted-photo-client.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(client); }
    if (url.pathname === '/api/video-os-lite/password-login') {
      const next = randomUUID(); tokens.set(next, ++loginCount === 3 ? 'fixture-other' : 'fixture-owner');
      return json(200, { ok: true }, { 'Set-Cookie': `vos_session=${next}; Path=/; Secure; HttpOnly; SameSite=Lax` });
    }
    if (url.pathname === '/api/video-os-lite/session') return json(200, { signedIn: Boolean(accountId), accountId });
    if (url.pathname === '/api/video-os-lite/results') return json(200, { accountId, results: rendered && accountId === 'fixture-owner'
      ? [{ id: jobId, correlationId: 'fixture-correlation', outputAccepted: true }] : [] });
    if (url.pathname === '/api/video-os-lite/scripted-photo') {
      if (req.method === 'GET') return json(200, { capabilities: { tiers: { PREMIUM: { available: true, credits } } } });
      if (body.action === 'save-project') return json(200, { ok: true });
      return json(200, { quote: { credits, expiresAt: new Date(Date.now() + 300_000).toISOString(), token: 'fixture-quote-token' } });
    }
    if (url.pathname === '/api/video-os-lite/render-v2') {
      renderCount += 1; rendered = true;
      expect(body.tier).toBe('PREMIUM');
      return json(202, { ok: true, correlationId: 'fixture-correlation', job: { id: jobId, correlationId: 'fixture-correlation' } });
    }
    if (url.pathname === '/api/video-os-lite/download') {
      if (!accountId) return json(401, {});
      if (accountId !== 'fixture-owner') return json(404, {});
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="video.mp4"' }); return res.end(media);
    }
    return json(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://localhost:${server.address().port}`;
  const facade = {
    async newContext(options) {
      const context = await browser.newContext(options); current = context; contexts.push(context);
      // All app observations use real local HTTP. Only the private Blob denial
      // is stubbed: this offline suite must never contact a real storage host.
      const requestGet = context.request.get.bind(context.request);
      context.request.get = async (url, options) => new URL(url).hostname.endsWith('.private.blob.vercel-storage.com')
        ? { status: () => 403, dispose: async () => {} } : requestGet(url, options);
      return context;
    },
    async close() { for (const context of contexts) await context.close(); },
  };
  const collector = await createBrowserCollector({ origin, chromium: { launch: async () => facade }, prompt: async message => {
    if (message.startsWith('Sign in')) {
      const page = current.pages()[0];
      await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/video-os-lite/password-login')), page.locator('#login').click()]);
    }
    if (message.startsWith('Review the displayed')) expect(message).toContain('provider-spend');
  } });
  const close = collector.close;
  collector.close = async () => { await close(); await new Promise(resolve => server.close(resolve)); };
  return { collector, get renderCount() { return renderCount; } };
}

test('collector observes real client render-v2, distinct issued sessions, gallery downloads and all denials', async ({ browser }) => {
  const h = await harness(browser);
  try {
    const original = await h.collector.signIn('original'); checkSession(original);
    const submission = await h.collector.submitExactlyOne({ title, maxCredits: 90 });
    expect(submission.requestCount).toBe(1); expect(h.renderCount).toBe(1);
    const job = { id: jobId, correlationId: 'fixture-correlation', output: { bytes: media.length } };
    expect((await h.collector.galleryDownload(original, job)).sha256).toBe(sha256(media));
    await h.collector.closeSession(original);
    const fresh = await h.collector.signIn('recovery'); checkSession(fresh, { sameAccount: original, differentSession: original });
    expect((await h.collector.galleryDownload(fresh, job)).sha256).toBe(sha256(media));
    const wrong = await h.collector.signIn('wrong-account'); checkSession(wrong, { differentAccount: original, differentSession: fresh });
    expect(await h.collector.denials({ wrong, jobId, privateUrl: 'https://fixture.private.blob.vercel-storage.com/final.mp4' })).toEqual({ anonymous: 401, wrongAccount: 404, privateBlob: 403 });
    await h.collector.assertSingleSubmission();
  } finally { await h.collector.close(); }
});

test('a 1,200-credit server quote cannot become a 200-credit approved render', async ({ browser }) => {
  const h = await harness(browser, 1200);
  try {
    await h.collector.signIn('original');
    await expect(h.collector.submitExactlyOne({ title, maxCredits: 300 })).rejects.toMatchObject({ code: 'QUOTE_BINDING_INVALID' });
    expect(h.renderCount).toBe(0);
  } finally { await h.collector.close(); }
});
