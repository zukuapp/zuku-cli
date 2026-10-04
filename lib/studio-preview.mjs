import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { relativePath, ProtocolError } from './agent-protocol/index.mjs';

const MIME = Object.freeze({ html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', wasm: 'application/wasm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', woff: 'font/woff', woff2: 'font/woff2' });
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Read-only snapshot proxy. It reads no filesystem and accepts no model-supplied URL. */
export async function createStudioPreview({ dispatchNative, port = 0, ttlMs = 600000 } = {}) {
  if (typeof dispatchNative !== 'function' || !Number.isInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3600000) throw new ProtocolError('INVALID_INPUT');
  const grants = new Map(); let origin, closed = false, inflight = 0;
  const server = createServer(async (req, res) => {
    const reject = status => { res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(); };
    if (closed || inflight >= 8) { reject(503); return; }
    inflight++;
    try {
      if (req.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(req.method) || (req.url?.length ?? 0) > 2048 || /[\\\x00-\x1f]/.test(req.url ?? '')) { reject(400); return; }
      const url = new URL(req.url, origin), match = /^\/p\/([a-f0-9]{32})\/(.*)$/.exec(url.pathname);
      if (!match || url.search || url.hash) { reject(404); return; }
      const grant = grants.get(match[1]); if (!grant || Date.now() >= grant.expiresAt) { grants.delete(match[1]); reject(404); return; }
      if (!match[2]) {
        res.writeHead(302, { location: `/p/${match[1]}/${grant.entry.split('/').map(encodeURIComponent).join('/')}`, 'cache-control': 'no-store' }); res.end(); return;
      }
      let path; try { path = decodeURIComponent(match[2]) || grant.entry; } catch { reject(400); return; }
      if (!relativePath(path) || /%[0-9a-f]{2}/i.test(path)) { reject(400); return; }
      const info = await dispatchNative('preview.info', { previewHandle: grant.previewHandle });
      if (info.version !== grant.version) { reject(409); return; }
      const chunks = []; let offset = 0, size, sha;
      do {
        const part = await dispatchNative('preview.read', { previewHandle: grant.previewHandle, path, offset, length: 49152 });
        if (part.version !== grant.version || part.offset !== offset || part.encoding !== 'base64' || !Number.isSafeInteger(part.bytes) || part.bytes > 4 * 1024 * 1024 || part.length > 49152) throw new ProtocolError('PROJECT_CHANGED');
        const bytes = Buffer.from(part.data, 'base64');
        if (bytes.length !== part.length || size !== undefined && (size !== part.bytes || sha !== part.sha256) || !bytes.length && !part.complete) throw new ProtocolError('PROJECT_CHANGED');
        size = part.bytes; sha = part.sha256; chunks.push(bytes); offset += bytes.length;
        if (part.complete) { if (offset !== size) throw new ProtocolError('PROJECT_CHANGED'); break; }
        if (offset >= size) throw new ProtocolError('PROJECT_CHANGED');
      } while (!closed && !req.destroyed);
      const bytes = Buffer.concat(chunks); if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== sha) throw new ProtocolError('PROJECT_CHANGED');
      res.writeHead(200, { 'content-type': MIME[path.split('.').at(-1).toLowerCase()] ?? 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP, 'referrer-policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { if (!res.headersSent) reject(404); else res.destroy(); }
    finally { inflight--; }
  });
  server.maxConnections = 16; server.requestTimeout = 10000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  server.on('error', () => {}); origin = `http://127.0.0.1:${server.address().port}`;
  return Object.freeze({ origin,
    async resolve(previewHandle) {
      if (closed) throw new ProtocolError('CORE_CLOSED');
      const info = await dispatchNative('preview.info', { previewHandle }); if (!relativePath(info.entry)) throw new ProtocolError('INVALID_INPUT');
      for (const [nonce, value] of grants) if (Date.now() >= value.expiresAt) grants.delete(nonce);
      if (grants.size >= 16) throw new ProtocolError('PROJECT_LIMIT');
      const nonce = randomBytes(16).toString('hex'); grants.set(nonce, { previewHandle, entry: info.entry, version: info.version, expiresAt: Date.now() + ttlMs });
      return { url: `${origin}/p/${nonce}/` };
    },
    async close() { if (closed) return; closed = true; grants.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  });
}
