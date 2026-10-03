import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { CommandError } from './errors.mjs';
import { validAccessToken } from './credentials.mjs';
import { DEFAULT_BASE_URL } from './api-client.mjs';
import { UploadError, API_ERROR_CODES } from './upload-errors.mjs';

/*
 * Narrow draft-upload transport. It is deliberately separate from the read-only diagnostic apiClient.
 * Exactly three operations exist: POST /uploads (single multipart file), POST /contents (JUMP draft only)
 * and owner GET /contents/{id}. There is no generic request method, no publish, no redirects,
 * no cookies, no service keys, no proxy/native capability headers and no automatic retry.
 */
export const MAX_MULTIPART_BYTES = 524_288_000;
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 65_536;
const SIXTEEN_MIB = 16 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const CONTENT_ID = /^cnt_[A-Za-z0-9_-]{1,128}$/;
const FILENAMES = new Set(['game.zwf', 'game.zip']);
const MEDIA_TYPES = new Set(['application/zwf', 'application/zip']);
// Remote detail strings are untrusted. Preserve public request fields, never arbitrary tokens.
const PUBLIC_FIELDS = new Set([
  'file', 'category', 'type', 'title', 'description', 'tags', 'age_rating', 'thumbnail_url', 'media_url', 'publish_to_thread',
  'jump', 'jump.game_id', 'jump.game_type', 'jump.genre', 'jump.distribution_mode', 'jump.status',
  'jump.platform', 'jump.platform.pc', 'jump.platform.mobile', 'jump.platform.tablet', 'jump.mobile_optimized',
  'jump.package', 'jump.package.format', 'jump.package.entry_point', 'jump.package.size_bytes', 'jump.package.hash', 'jump.package.version', 'jump.package.url',
  'jump.browser_requirements',
]);

function checkedOrigin(baseUrl, allowFixtureOrigin) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new CommandError('API_ORIGIN_REJECTED'); }
  const fixture = allowFixtureOrigin === true && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1' || (!fixture && url.href !== DEFAULT_BASE_URL)) throw new CommandError('API_ORIGIN_REJECTED');
  return url;
}

/** Multipart framing for exactly one file part; the total length is known before any network activity. */
export function multipartFraming(byteLength, { filename, mediaType, boundary = `ZukuJS-${randomBytes(18).toString('hex')}` }) {
  if (!FILENAMES.has(filename) || !MEDIA_TYPES.has(mediaType) || !/^[A-Za-z0-9-]{1,70}$/.test(boundary)) throw new CommandError('INVALID_INPUT');
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`, 'ascii');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'ascii');
  return { boundary, head, tail, contentLength: head.length + byteLength + tail.length };
}
export const uploadDeadlineMs = bodyBytes => bodyBytes > SIXTEEN_MIB ? 660_000 : 60_000;

/** Map a parsed error envelope to a validated public API code; unknown codes are never echoed. */
function apiFailure(status, envelope, stage) {
  const error = record(envelope) && envelope.success === false && record(envelope.error) ? envelope.error : undefined;
  let code = error && API_ERROR_CODES.has(error.code) ? error.code : undefined;
  if (!code) code = status === 401 ? 'UNAUTHORIZED' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 429 ? 'RATE_LIMITED' : 'API_REQUEST_FAILED';
  const fields = Array.isArray(error?.details) ? [...new Set(error.details.map(item => record(item) ? item.field : undefined).filter(field => PUBLIC_FIELDS.has(field)))].slice(0, 10) : undefined;
  return new UploadError(code, { stage, httpStatus: status, fields });
}

/**
 * @param {string} [baseUrl]
 * @param {{accessToken: string, allowFixtureOrigin?: boolean, signal?: AbortSignal, timeouts?: {upload?: number, json?: number}, onProgress?: (p: {sent: number, total: number}) => void, requestImpl?: Function}} options
 */
export function uploadClient(baseUrl = DEFAULT_BASE_URL, { accessToken, allowFixtureOrigin = false, signal, timeouts = {}, onProgress, requestImpl } = {}) {
  const origin = checkedOrigin(baseUrl, allowFixtureOrigin);
  if (!validAccessToken(accessToken)) throw new CommandError('UNAUTHORIZED');
  for (const value of [timeouts.upload, timeouts.json]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 900_000)) throw new CommandError('INVALID_INPUT');
  const send = requestImpl ?? (origin.protocol === 'https:' ? httpsRequest : httpRequest);

  /**
   * One HTTP exchange, never repeated. Resolves {status, envelope} or rejects with an UploadError whose
   * `ambiguous` flag says whether the server may have received the request.
   */
  function exchange({ method, path, headers, body, deadlineMs, stage }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new UploadError('COMMAND_CANCELLED', { stage })); return; }
      let settled = false, connected = false, timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        if (error) { req?.destroy(); reject(error); } else resolve(value);
      };
      const fail = code => {
        const error = new UploadError(code === 'COMMAND_CANCELLED' ? code : connected ? (stage === 'upload' ? 'UPLOAD_OUTCOME_UNKNOWN' : stage === 'draft' ? 'DRAFT_OUTCOME_UNKNOWN' : 'API_UNAVAILABLE') : 'API_UNAVAILABLE', { stage });
        error.ambiguous = connected;
        finish(error);
      };
      const onAbort = () => fail('COMMAND_CANCELLED');
      // Only the listed headers are sent: no Cookie, no capability/proxy headers, no keep-alive reuse.
      let req;
      try {
        req = send({ protocol: origin.protocol, hostname: origin.hostname.replace(/^\[|\]$/g, ''), port: origin.port || undefined, method, path: origin.pathname + path, headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, Connection: 'close', ...headers }, agent: false });
      } catch { settled = true; signal?.removeEventListener('abort', onAbort); reject(new UploadError('API_UNAVAILABLE', { stage })); return; }
      timer = setTimeout(() => fail('TIMEOUT'), deadlineMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('socket', socket => {
        const mark = () => { connected = true; };
        if (origin.protocol === 'https:') socket.once('secureConnect', mark); else if (socket.connecting) socket.once('connect', mark); else mark();
      });
      req.on('error', () => fail('NETWORK'));
      req.on('response', response => {
        connected = true;
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) { response.resume(); const error = new UploadError('API_REDIRECT_REJECTED', { stage, httpStatus: status }); error.ambiguous = true; finish(error); return; }
        const chunks = []; let size = 0;
        if (Number(response.headers['content-length'] ?? 0) > MAX_RESPONSE_BYTES) { finish(Object.assign(new UploadError('API_RESPONSE_INVALID', { stage, httpStatus: status }), { ambiguous: true })); return; }
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { finish(Object.assign(new UploadError('API_RESPONSE_INVALID', { stage, httpStatus: status }), { ambiguous: true })); return; }
          chunks.push(chunk);
        });
        response.on('error', () => fail('NETWORK'));
        response.on('end', () => {
          let envelope;
          try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { envelope = undefined; }
          // Response headers (including Set-Cookie) are discarded; only status and parsed JSON leave this function.
          finish(null, { status, envelope });
        });
      });
      if (body) writeBody(req, body, onProgress).catch(() => fail('NETWORK'));
      else req.end();
    });
  }

  return Object.freeze({
    /** POST /uploads with one file part and an exact Content-Length (Transfer-Encoding is never used). */
    async uploadPackage({ bytes, filename, mediaType }) {
      if (!(bytes instanceof Uint8Array) || bytes.length < 1) throw new CommandError('INVALID_INPUT');
      const frame = multipartFraming(bytes.length, { filename, mediaType });
      if (frame.contentLength > MAX_MULTIPART_BYTES) throw new UploadError('UPLOAD_INPUT_TOO_LARGE', { stage: 'upload' });
      const deadlineMs = timeouts.upload ?? uploadDeadlineMs(frame.contentLength);
      return exchange({ method: 'POST', path: '/uploads', stage: 'upload', deadlineMs,
        headers: { 'Content-Type': `multipart/form-data; boundary=${frame.boundary}`, 'Content-Length': String(frame.contentLength) },
        body: [frame.head, bytes, frame.tail] });
    },
    /** POST /contents with a JUMP draft body. Anything that is not an explicit draft is refused locally. */
    async createDraft(draft) {
      if (!record(draft) || draft.category !== 'jump' || draft.publish_to_thread !== false || !record(draft.jump) || draft.jump.status !== 'draft') throw new UploadError('UPLOAD_METADATA_INVALID', { stage: 'draft', reason: 'draft_only' });
      const json = Buffer.from(JSON.stringify(draft), 'utf8');
      if (json.length > MAX_JSON_BODY_BYTES) throw new UploadError('UPLOAD_METADATA_INVALID', { stage: 'draft', reason: 'body_too_large' });
      return exchange({ method: 'POST', path: '/contents', stage: 'draft', deadlineMs: timeouts.json ?? 30_000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(json.length) }, body: [json] });
    },
    /** Owner GET /contents/{id}; the id must be a server-issued content id (no path injection). */
    async getContent(id) {
      if (typeof id !== 'string' || !CONTENT_ID.test(id)) throw new CommandError('INVALID_INPUT');
      return exchange({ method: 'GET', path: `/contents/${id}`, stage: 'verify', deadlineMs: timeouts.json ?? 30_000 });
    },
    apiFailure,
  });
}
export { apiFailure };

async function writeBody(req, parts, onProgress) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  let sent = 0;
  for (const part of parts) {
    for (let offset = 0; offset < part.length; offset += CHUNK) {
      const slice = part.subarray(offset, Math.min(offset + CHUNK, part.length));
      if (req.destroyed) throw new Error('destroyed');
      const flushed = req.write(slice);
      sent += slice.length;
      try { onProgress?.({ sent, total }); } catch { /* progress display must not affect the transfer */ }
      if (!flushed) await new Promise((resolve, reject) => {
        const done = error => { req.off('drain', drained); req.off('close', closed); if (error) reject(error); else resolve(); };
        const drained = () => done();
        const closed = () => done(new Error('closed'));
        req.on('drain', drained); req.on('close', closed);
      });
    }
  }
  req.end();
}
