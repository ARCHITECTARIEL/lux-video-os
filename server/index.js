// Plain Node HTTP entrypoint for VPS hosting -- replaces vercel.json's
// routing layer. Every route handler under api/ and routes/ was already
// written against the plain (req, res) Node http contract (see
// lib/video-os-account.js: send/handleOptions/readJson/readRaw all use
// only standard IncomingMessage/ServerResponse APIs), so this file's only
// real job is routing plus two things Vercel's Node runtime gives handlers
// for free that a raw http.Server does not:
//   1. `req.body` pre-parsed for JSON requests (several handlers, e.g.
//      api/video-os-lite/uploads.js, read `req.body` directly with no
//      readJson() fallback).
//   2. A request body stream that can still be read after body-parsing
//      (api/video-os-lite/stripe-webhook-v2.js needs the *raw* bytes via
//      readRaw() for signature verification, even though the body was
//      already buffered for step 1).
// Both are handled by bufferRequestBody()/attachBody() below: the body is
// read into memory once, `req.body` is set for JSON payloads, and the
// request's async iterator is replaced so any later `for await (const
// chunk of req)` (readJson/readRaw) replays the same bytes.
//
// The actual route table is vercel.json itself -- its `src`/`dest` pairs
// are already valid regex-and-$1-substitution rules, so reading it at
// startup means this router can never drift out of sync with the routes
// Vercel serves. Only two things aren't expressible that way and are
// handled directly below: the /healthz probe (infra-only, not a product
// route) and 404s.
import { createReadStream, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_BUFFERED_BODY_BYTES = 30_000_000;
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const VERCEL_ROUTES = JSON.parse(readFileSync(join(REPO_ROOT, 'vercel.json'), 'utf8')).routes
  .map((route) => ({ ...route, pattern: new RegExp(`^${route.src}$`) }));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.cube': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

async function bufferRequestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BUFFERED_BODY_BYTES) throw Object.assign(new Error('Request body too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function attachBody(req, rawBody) {
  req[Symbol.asyncIterator] = async function* replay() {
    if (rawBody.length) yield rawBody;
  };
  if (rawBody.length && String(req.headers['content-type'] || '').includes('application/json')) {
    try { req.body = JSON.parse(rawBody.toString('utf8')); } catch { /* leave req.body unset; handlers fall back to readJson/readRaw */ }
  }
}

function staticFilePath(dest) {
  const withoutPublicPrefix = dest.replace(/^\/public\//, '/');
  const resolved = normalize(join(REPO_ROOT, 'public', withoutPublicPrefix));
  if (!resolved.startsWith(join(REPO_ROOT, 'public') + sep)) return null;
  return resolved;
}

function serveStatic(res, filePath, headers) {
  let stats;
  try { stats = statSync(filePath); } catch { return null; }
  if (!stats.isFile()) return null;
  res.statusCode = 200;
  res.setHeader('Content-Type', CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Length', stats.size);
  for (const [key, value] of Object.entries(headers || {})) res.setHeader(key, value);
  createReadStream(filePath).pipe(res);
  return true;
}

async function loadApiHandler(dest) {
  const filePath = join(REPO_ROOT, dest.replace(/^\//, ''));
  const module = await import(pathToFileURL(filePath).href);
  return module.default;
}

function send404(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: 'Not found.' }));
}

function matchRoute(pathname) {
  for (const route of VERCEL_ROUTES) {
    const match = route.pattern.exec(pathname);
    if (match) return { dest: pathname.replace(route.pattern, route.dest), headers: route.headers };
  }
  return null;
}

async function handleRequest(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/healthz') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ok: true, uptimeSeconds: Math.round(process.uptime()) }));
  }

  const matched = matchRoute(pathname);
  if (!matched) return send404(res);

  if (matched.dest.startsWith('/api/')) {
    try {
      const rawBody = await bufferRequestBody(req);
      attachBody(req, rawBody);
    } catch (error) {
      res.statusCode = error.statusCode || 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    let handler;
    try {
      handler = await loadApiHandler(matched.dest);
    } catch (error) {
      console.error(JSON.stringify({ event: 'server.route_load_failed', dest: matched.dest, error: String(error?.message || error) }));
      return send404(res);
    }
    if (typeof handler !== 'function') return send404(res);
    try {
      return await handler(req, res);
    } catch (error) {
      console.error(JSON.stringify({ event: 'server.handler_threw', dest: matched.dest, error: String(error?.stack || error) }));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: 'Internal server error.' }));
      }
      return;
    }
  }

  const filePath = staticFilePath(matched.dest);
  if (!filePath || !serveStatic(res, filePath, matched.headers)) return send404(res);
}

export function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error(JSON.stringify({ event: 'server.unhandled_error', error: String(error?.stack || error) }));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: 'Internal server error.' }));
      }
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(JSON.stringify({ event: 'server.started', host: HOST, port: PORT }));
  });
  const shutdown = () => {
    console.log(JSON.stringify({ event: 'server.stopping' }));
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
