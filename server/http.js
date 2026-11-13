// Static files, health checks and metrics. No framework: the whole site is a handful of files.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon'
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest']);
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

// Third-party files are served from our own origin, straight out of node_modules. Nothing loads from a CDN.
const VENDOR = {
  '/vendor/three/three.module.js': 'node_modules/three/build/three.module.js',
  '/vendor/three/three.core.js': 'node_modules/three/build/three.core.js',
  '/vendor/fonts/bodoni-moda.woff2': 'node_modules/@fontsource-variable/bodoni-moda/files/bodoni-moda-latin-wght-normal.woff2',
  '/vendor/fonts/bodoni-moda-italic.woff2': 'node_modules/@fontsource-variable/bodoni-moda/files/bodoni-moda-latin-wght-italic.woff2',
  '/vendor/fonts/manrope.woff2': 'node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2',
  '/vendor/fonts/dm-mono-400.woff2': 'node_modules/@fontsource/dm-mono/files/dm-mono-latin-400-normal.woff2',
  '/vendor/fonts/dm-mono-500.woff2': 'node_modules/@fontsource/dm-mono/files/dm-mono-latin-500-normal.woff2'
};

async function walk(dir, base = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = base + '/' + e.name;
    if (e.isDirectory()) out.push(...await walk(path.join(dir, e.name), rel)); else out.push(rel);
  }
  return out;
}

export async function createHttpHandler({ metrics, production, ready }) {
  // The complete set of URLs is fixed at boot, so a request can never reach outside it.
  const routes = new Map();
  for (const rel of await walk(path.join(ROOT, 'public'))) routes.set(rel, { file: path.join(ROOT, 'public', rel), cc: 'no-cache' });
  routes.set('/', routes.get('/index.html'));
  routes.set('/faq', routes.get('/faq.html'));
  routes.set('/privacy', routes.get('/privacy.html'));
  routes.set('/terms', routes.get('/terms.html'));
  routes.set('/shared/engine.js', { file: path.join(ROOT, 'shared/engine.js'), cc: 'no-cache' });
  for (const [url, rel] of Object.entries(VENDOR)) routes.set(url, { file: path.join(ROOT, rel), cc: 'public, max-age=604800' });

  // The service worker carries a hash of every other file it serves, so any change to them
  // ships a new worker, and phones that installed the app pick up the new version.
  const SW = path.join(ROOT, 'public', 'sw.js');
  async function appVersion() {
    const h = createHash('sha1');
    for (const f of [...new Set([...routes.values()].map(r => r.file))].sort()) if (f !== SW) h.update(f).update(await readFile(f));
    return h.digest('hex').slice(0, 12);
  }
  let version = production ? await appVersion() : null;

  const cache = new Map();
  async function asset(route) {
    if (production && cache.has(route.file)) return cache.get(route.file);
    let buf = await readFile(route.file); const ext = path.extname(route.file);
    if (route.file === SW) buf = Buffer.from(buf.toString().replace("'__VERSION__'", `'${version || await appVersion()}'`));
    const a = { buf, type: TYPES[ext] || 'application/octet-stream', cc: route.cc, etag: '"' + createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"' };
    if (COMPRESSIBLE.has(ext) && buf.length > 1024) {
      a.gz = gzipSync(buf, { level: production ? 9 : 1 });
      if (production) a.br = brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 9, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length } });
    }
    if (production) cache.set(route.file, a);
    return a;
  }
  if (production) await Promise.all([...new Set(routes.values())].map(asset));   // warm the cache before taking traffic

  const text = (res, code, body, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...HEADERS }); res.end(body); };

  return async function handler(req, res) {
    try {
      const url = (req.url || '/').split('?')[0];
      if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Method not allowed');
      if (url === '/healthz') return text(res, 200, 'ok');
      if (url === '/readyz') { const ok = await ready(); return text(res, ok ? 200 : 503, ok ? 'ready' : 'not ready'); }
      if (url === '/metrics') return text(res, 200, metrics.render(), 'text/plain; version=0.0.4; charset=utf-8');
      // /faq/ and the like lead to the page itself. Only known pages redirect, so this never points off-site.
      if (url.length > 1 && url.endsWith('/') && routes.has(url.slice(0, -1))) {
        res.writeHead(301, { Location: url.slice(0, -1) + (req.url || '').slice(url.length), 'Cache-Control': 'public, max-age=86400', ...HEADERS });
        return res.end();
      }
      const route = routes.get(url) || { ...routes.get('/404.html'), cc: 'no-cache' };
      if (!routes.has(url)) {
        const a = await asset(route);
        const head = { 'Content-Type': a.type, 'Cache-Control': a.cc, ETag: a.etag, Vary: 'Accept-Encoding', ...HEADERS };
        head['Content-Length'] = a.buf.length;
        res.writeHead(404, head);
        return res.end(req.method === 'HEAD' ? undefined : a.buf);
      }
      const a = await asset(route);
      const head = { 'Content-Type': a.type, 'Cache-Control': a.cc, ETag: a.etag, Vary: 'Accept-Encoding', ...HEADERS };
      if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, head); return res.end(); }
      const accepts = String(req.headers['accept-encoding'] || '');
      let body = a.buf;
      if (a.br && /\bbr\b/.test(accepts)) { body = a.br; head['Content-Encoding'] = 'br'; }
      else if (a.gz && /\bgzip\b/.test(accepts)) { body = a.gz; head['Content-Encoding'] = 'gzip'; }
      head['Content-Length'] = body.length;
      res.writeHead(200, head);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      text(res, 500, 'Server error');
    }
  };
}
