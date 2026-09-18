import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const portFlag = process.argv.indexOf('--port');
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 4173;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview server port.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4' };
createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  // Synthetic download transport for browser proof only; never included in API routing.
  if (process.argv.includes('--standard-contract-fixture') && pathname === '/api/video-os-lite/download') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    if (req.method !== 'GET' || query.get('jobId') !== 'fixture-standard-001') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': `${query.get('disposition') === 'inline' ? 'inline' : 'attachment'}; filename="fixture.mp4"`, 'Cache-Control': 'no-store' });
    createReadStream(join(root, 'assets/studio/fixture-output.mp4')).pipe(res);
    return;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = normalize(join(root, relative));
  if (!file.startsWith(normalize(root))) { res.writeHead(403).end(); return; }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not file');
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1');
