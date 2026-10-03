import { CommandError } from './errors.mjs';
import { validAccessToken } from './credentials.mjs';

export const DEFAULT_BASE_URL = 'https://www.zuzunza.com/api/v1';
const READ_PATHS = new Set(['/billing/catalog', '/auth/me']);
const API_CODES = new Set(['UNAUTHORIZED', 'FORBIDDEN', 'ACCOUNT_SUSPENDED', 'AUTH_UNAVAILABLE', 'BILLING_UNAVAILABLE', 'RATE_LIMITED', 'NOT_FOUND']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkedOrigin(baseUrl, allowFixtureOrigin) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new CommandError('API_ORIGIN_REJECTED'); }
  const fixture = allowFixtureOrigin === true && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1' || (!fixture && url.href !== DEFAULT_BASE_URL)) throw new CommandError('API_ORIGIN_REJECTED');
  return url.href;
}
async function boundedJson(response) {
  if (!response.body) throw new CommandError('API_RESPONSE_INVALID');
  if (Number(response.headers.get('content-length') ?? 0) > 65536) {
    await response.body.cancel();
    throw new CommandError('API_RESPONSE_INVALID');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new CommandError('API_RESPONSE_INVALID'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CommandError('API_RESPONSE_INVALID'); }
}

/** Public bearer reads only. Service HMAC keys and arbitrary URLs/paths are unsupported. */
export async function apiClient(baseUrl = DEFAULT_BASE_URL, { accessToken, fetch: call = fetch, allowFixtureOrigin = false, timeoutMs = 3000, signal } = {}) {
  const origin = checkedOrigin(baseUrl, allowFixtureOrigin);
  if (accessToken !== undefined && !validAccessToken(accessToken)) throw new CommandError('CREDENTIALS_INVALID');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new CommandError('INVALID_INPUT');
  return Object.freeze({
    async request(path, options = {}) {
      if (!READ_PATHS.has(path) || !record(options) || Object.keys(options).some(key => key !== 'method') || (options.method !== undefined && options.method !== 'GET')) throw new CommandError('API_READ_ONLY');
      if (path === '/auth/me' && !accessToken) throw new CommandError('UNAUTHORIZED');
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      try {
        const headers = { Accept: 'application/json' };
        // Anonymous catalog never receives a user's token.
        if (path === '/auth/me') headers.Authorization = `Bearer ${accessToken}`;
        const response = await call(origin + path, { method: 'GET', headers, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
        const envelope = await boundedJson(response);
        if (!record(envelope) || !record(envelope.meta) || typeof envelope.success !== 'boolean') throw new CommandError('API_RESPONSE_INVALID');
        if (response.ok && envelope.success === true && Object.hasOwn(envelope, 'data')) return envelope;
        if (envelope.success !== false || !record(envelope.error)) throw new CommandError('API_RESPONSE_INVALID');
        const code = API_CODES.has(envelope.error.code) ? envelope.error.code : response.status === 401 ? 'UNAUTHORIZED' : 'API_UNAVAILABLE';
        throw new CommandError(code);
      } catch (error) {
        if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
        if (error instanceof CommandError) throw error;
        throw new CommandError('API_UNAVAILABLE');
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
  });
}
