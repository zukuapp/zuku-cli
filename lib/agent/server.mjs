import { createServer } from 'node:http';

/*
 * Loopback-only static server for one validated, in-memory project snapshot. It serves exactly
 * the bytes that were validated and digested — never the live file system — on 127.0.0.1 with a
 * random port, a strict Host check (DNS-rebinding safe) and a CSP that forbids external loads.
 */
export const PLAYTEST_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "media-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'", "worker-src 'none'", "child-src 'none'",
  "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "manifest-src 'none'", "frame-ancestors 'none'",
].join('; ');
const TYPES = Object.freeze({
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', wasm: 'application/wasm',
});
const HEADERS = Object.freeze({
  'Content-Security-Policy': PLAYTEST_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), payment=(), clipboard-read=(), clipboard-write=()',
});

function lookup(files, entry, url) {
  let path;
  try { path = decodeURIComponent(new URL(url, 'http://127.0.0.1').pathname).slice(1); } catch { return undefined; }
  if (path === '') path = entry;
  if (path.length > 1024 || /[\\\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '..' || part.startsWith('.'))) return undefined;
  return files.has(path) ? { path, bytes: files.get(path) } : undefined;
}

/** @param {Map<string, Uint8Array>} files source-relative path → bytes */
export async function serveSnapshot(files, entry) {
  let host;
  const server = createServer((req, res) => {
    if (req.headers.host !== host) { res.writeHead(421, HEADERS).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...HEADERS, Allow: 'GET, HEAD' }).end(); return; }
    const found = lookup(files, entry, req.url ?? '/');
    if (!found) { res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('not found'); return; }
    const type = TYPES[found.path.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { ...HEADERS, 'Content-Type': type, 'Content-Length': found.bytes.length });
    res.end(req.method === 'HEAD' ? undefined : found.bytes);
  });
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
  const { port } = server.address();
  host = `127.0.0.1:${port}`;
  return {
    origin: `http://${host}`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
