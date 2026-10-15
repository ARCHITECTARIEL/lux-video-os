export default function handler(req, res) {
  res.statusCode = 404;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify({ ok: false, code: 'not_found', path: new URL(req.url, 'https://video-os.invalid').pathname }));
}
