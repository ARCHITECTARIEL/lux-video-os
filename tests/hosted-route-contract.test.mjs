import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import workspaceHandler from '../api/video-os-lite/workspace.js';
import { checkOwnerCaptionVtt, checkWorkspaceUnauthJson, runCli } from '../tools/p0-evidence/check-candidate.mjs';

const root = new URL('../', import.meta.url);
const captionPath = '/assets/showcase/owner-kristian.vtt';
const workspacePath = '/api/video-os-lite/workspace';

test('workspace handler returns JSON 401 for the bare unauthenticated path and 404 for other unknown paths', async () => {
  const invoke = async (url) => {
    const headers = {};
    let body;
    const res = {
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      end(value) { body = value; },
    };
    await workspaceHandler({ method: 'GET', url, headers: {} }, res);
    return { status: res.statusCode, headers, body: JSON.parse(body) };
  };

  const bare = await invoke(workspacePath);
  assert.equal(bare.status, 401);
  assert.match(bare.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(bare.body, { ok: false, code: 'sign_in_required', error: 'Sign in required.' });

  const unknown = await invoke('/api/video-os-lite/nonexistent');
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { ok: false, error: 'Workspace route not found.' });
});

test('hosted caption and workspace routes precede the fallback without earlier shadowing', async () => {
  const { routes } = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'));
  const fallback = routes.findIndex((route) => route.src === '/(.*)');
  assert.ok(fallback >= 0);
  for (const [path, destination] of [[captionPath, '/$1'], [workspacePath, '/api/video-os-lite/workspace.js']]) {
    const index = routes.findIndex((route) => route.dest === destination && new RegExp(`^${route.src}$`).test(path));
    assert.ok(index >= 0 && index < fallback, `${path} must route before the fallback`);
    for (const earlier of routes.slice(0, index)) {
      assert.equal(new RegExp(`^${earlier.src}$`).test(path), false, `${earlier.src} shadows ${path}`);
    }
  }
  const captionRoute = routes.find((route) => route.src === '/(.*\\.vtt)');
  assert.ok(captionRoute);
  assert.equal(captionRoute.headers['Content-Type'], 'text/vtt; charset=utf-8');
  assert.equal(captionRoute.headers['Cache-Control'], 'no-store');
  assert.match(captionPath, new RegExp(`^${captionRoute.src}$`));
  assert.ok(routes.some((route) => route.src === workspacePath && route.dest === '/api/video-os-lite/workspace.js'));
});

test('Welcome caption references exist in public and start with WEBVTT', async () => {
  const html = await readFile(new URL('public/landing.html', root), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="(\/[^\"]+\.js)"/g)]
    .map((match) => match[1]).filter((script) => !script.startsWith('/_vercel/'));
  const sources = [html, ...await Promise.all(scripts.map((script) => readFile(new URL(`public${script}`, root), 'utf8')))];
  const captions = new Set(sources.flatMap((source) => [...source.matchAll(/["'](\/[^"']+\.vtt)["']/g)].map((match) => match[1])));
  assert.ok(captions.size > 0, 'Welcome must reference at least one caption');
  for (const caption of captions) {
    assert.ok(!caption.includes('..'), `unsafe caption path: ${caption}`);
    const body = await readFile(new URL(`public${caption}`, root), 'utf8');
    assert.ok(body.replace(/^\uFEFF/, '').startsWith('WEBVTT'), `${caption} is not WEBVTT`);
  }
});

test('hosted checks accept the caption and unauthenticated JSON contract without network', async () => {
  const requests = [];
  const fetcher = async (url) => {
    requests.push(url);
    return url.endsWith('.vtt')
      ? new Response('\uFEFFWEBVTT\n', { status: 200, headers: { 'content-type': 'text/vtt; charset=utf-8' } })
      : new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json; charset=utf-8' } });
  };
  await checkOwnerCaptionVtt('https://example.invalid/', fetcher);
  await checkWorkspaceUnauthJson('https://example.invalid/', fetcher);
  assert.deepEqual(requests, [`https://example.invalid${captionPath}`, `https://example.invalid${workspacePath}`]);
  let stdout = '';
  assert.equal(await runCli(['--base-url', 'https://example.invalid'], { fetch: fetcher, stdout: { write: (s) => { stdout += s; } } }), 0);
  assert.match(stdout, /HOSTED_ROUTE_SMOKE_OK/);
});

test('hosted checks reject fallback HTML and a workspace 404', async () => {
  await assert.rejects(checkOwnerCaptionVtt('https://example.invalid', async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })), /OWNER_CAPTION_VTT_FAILED/);
  await assert.rejects(checkWorkspaceUnauthJson('https://example.invalid', async () => new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })), /WORKSPACE_UNAUTH_JSON_FAILED/);
});
