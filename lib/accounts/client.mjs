import { DEFAULT_BASE_URL } from '../api-client.mjs';
import { AccountError } from './errors.mjs';

export const ZUKU_CLIENT_ID = 'zuku-cli';
export const GAME_SCOPES = Object.freeze(['games:upload', 'games:create', 'games:publish']);
export const NATIVE_GAME_SCOPE = 'games:generate';
export function canonicalGameScopes(value) {
  const scopes = typeof value === 'string' ? value.split(' ') : value;
  if (!Array.isArray(scopes) || ![3, 4].includes(scopes.length) || new Set(scopes).size !== scopes.length || !GAME_SCOPES.every(s => scopes.includes(s)) || scopes.some(s => !GAME_SCOPES.includes(s) && s !== NATIVE_GAME_SCOPE)) return undefined;
  return [...GAME_SCOPES, ...(scopes.includes(NATIVE_GAME_SCOPE) ? [NATIVE_GAME_SCOPE] : [])].join(' ');
}
export const oauthAccessToken = token => typeof token === 'string' && /^zuku_oa_[a-f0-9]{64}$/.test(token);
export const oauthRefreshToken = token => typeof token === 'string' && /^zuku_or_[a-f0-9]{64}$/.test(token);
export const validDeploymentKey = key => typeof key === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const CONTENT_ID = /^cnt_[a-zA-Z0-9_-]{1,128}$/;

export function checkedBase(baseUrl = DEFAULT_BASE_URL, allowFixtureOrigin = false) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new AccountError('API_ORIGIN_REJECTED'); }
  const fixture = allowFixtureOrigin === true && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1' || (!fixture && url.href !== DEFAULT_BASE_URL)) throw new AccountError('API_ORIGIN_REJECTED');
  return url.href;
}
async function boundedJson(response) {
  if (!response.body || Number(response.headers.get('content-length') ?? 0) > 131072) { await response.body?.cancel(); throw new AccountError('ZUKU_AUTH_RESPONSE_INVALID'); }
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 131072) { await reader.cancel(); throw new AccountError('ZUKU_AUTH_RESPONSE_INVALID'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AccountError('ZUKU_AUTH_RESPONSE_INVALID'); }
}
/** Fixed official origin and paths; no cookie forwarding, redirects, or mutation retries. */
export function accountClient(baseUrl = DEFAULT_BASE_URL, { accessToken, fetch: call = fetch, allowFixtureOrigin = false, signal, timeoutMs = 15000, requestedScopes = GAME_SCOPES } = {}) {
  const base = checkedBase(baseUrl, allowFixtureOrigin);
  const requested = canonicalGameScopes(requestedScopes);
  if (!requested) throw new AccountError('INVALID_INPUT');
  if (accessToken !== undefined && !oauthAccessToken(accessToken)) throw new AccountError('ZUKU_LOGIN_REQUIRED');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new AccountError('INVALID_INPUT');
  async function request(path, method, body, form = false, authenticated = false, key) {
    if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
    const controller = new AbortController(); const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true }); const timer = setTimeout(abort, timeoutMs);
    try {
      const headers = { Accept: 'application/json' };
      if (key !== undefined) { if (!validDeploymentKey(key)) throw new AccountError('INVALID_INPUT'); headers['Idempotency-Key'] = key; }
      if (body !== undefined) headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
      if (authenticated) { if (!accessToken) throw new AccountError('ZUKU_LOGIN_REQUIRED'); headers.Authorization = `Bearer ${accessToken}`; }
      const response = await call(base + path, { method, headers, body: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body), signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
      const data = await boundedJson(response);
      return { status: response.status, data, retryAfter: Number(response.headers.get('retry-after') ?? 0) };
    } catch (error) { if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED'); if (error instanceof AccountError) throw error; throw new AccountError('ZUKU_AUTH_UNAVAILABLE'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return Object.freeze({
    device: () => request('/oauth/device/authorization', 'POST', { client_id: ZUKU_CLIENT_ID, scope: requested }, true),
    poll: deviceCode => request('/oauth/token', 'POST', { client_id: ZUKU_CLIENT_ID, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode }, true),
    refresh: refreshToken => { if (!oauthRefreshToken(refreshToken)) throw new AccountError('ZUKU_ACCOUNT_EXPIRED'); return request('/oauth/token', 'POST', { client_id: ZUKU_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }, true); },
    revoke: token => { if (!oauthRefreshToken(token)) throw new AccountError('ZUKU_ACCOUNT_EXPIRED'); return request('/oauth/revoke', 'POST', { client_id: ZUKU_CLIENT_ID, token, token_type_hint: 'refresh_token' }, true); },
    me: () => request('/oauth/me', 'GET', undefined, false, true),
    quota: () => request('/oauth/deploy-quota', 'GET', undefined, false, true),
    content: id => { if (!CONTENT_ID.test(id)) throw new AccountError('INVALID_INPUT'); return request(`/contents/${id}`, 'GET', undefined, false, true); },
    deployment: key => { if (!validDeploymentKey(key)) throw new AccountError('INVALID_INPUT'); return request(`/oauth/games/deployments/${encodeURIComponent(key)}`, 'GET', undefined, false, true); },
    publish: (id, key) => { if (!CONTENT_ID.test(id) || !validDeploymentKey(key)) throw new AccountError('INVALID_INPUT'); return request(`/contents/${id}/publish`, 'POST', { mode: 'yolo' }, false, true, key); },
  });
}
export function readTokens(result, now = Date.now(), expectedScopes) {
  const data = result?.status === 200 && record(result.data) ? result.data : undefined;
  if (!data || !oauthAccessToken(data.access_token) || !oauthRefreshToken(data.refresh_token) || data.token_type !== 'Bearer' || !Number.isSafeInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 3600 || typeof data.scope !== 'string') throw new AccountError(result?.data?.error === 'invalid_grant' ? 'ZUKU_ACCOUNT_EXPIRED' : 'ZUKU_AUTH_RESPONSE_INVALID');
  const scope = canonicalGameScopes(data.scope);
  if (!scope || expectedScopes !== undefined && scope !== canonicalGameScopes(expectedScopes)) throw new AccountError('ZUKU_AUTH_RESPONSE_INVALID');
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Number(now) + data.expires_in * 1000, scope };
}
export function readQuota(result) {
  const q = result?.status === 200 && result?.data?.success === true ? result.data.data : undefined;
  if (!record(q) || q.limit !== 3 || q.window_seconds !== 21600 || !Number.isSafeInteger(q.used) || q.used < 0 || q.used > 3 || !Number.isSafeInteger(q.pending) || q.pending < 0 || q.used + q.pending > 3 || q.remaining !== 3 - q.used - q.pending || !Number.isSafeInteger(q.retry_after) || q.retry_after < 0 || q.retry_after > 21600 || (q.remaining > 0 ? q.retry_after !== 0 : q.retry_after < 1) || (q.used + q.pending === 0 ? q.reset_at !== null : !date(q.reset_at))) throw new AccountError(result?.status === 401 ? 'ZUKU_ACCOUNT_EXPIRED' : 'ZUKU_AUTH_RESPONSE_INVALID');
  return { limit: q.limit, window_seconds: q.window_seconds, used: q.used, pending: q.pending, remaining: q.remaining, reset_at: q.reset_at, retry_after: q.retry_after };
}
const date = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
export function readIdentity(result, expectedScopes) {
  const d = result?.status === 200 && result?.data?.success === true ? result.data.data : undefined;
  if (!record(d) || d.client_id !== ZUKU_CLIENT_ID || !record(d.user) || !/^usr_[1-9][0-9]*$/.test(d.user.id ?? '') || typeof d.user.handle !== 'string' || d.user.handle.length > 128 || !canonicalGameScopes(d.scopes) || expectedScopes !== undefined && canonicalGameScopes(d.scopes) !== canonicalGameScopes(expectedScopes) || !date(d.expires_at)) throw new AccountError(result?.status === 401 ? 'ZUKU_ACCOUNT_EXPIRED' : 'ZUKU_AUTH_RESPONSE_INVALID');
  return { id: d.user.id, handle: d.user.handle };
}
/** A status response alone never proves publication without matching durable source identity. */
export function readDeployment(result, expected, { complete = false } = {}) {
  const d = result?.status === 200 && result?.data?.success === true ? result.data.data?.deployment : undefined;
  if (!record(d) || !validDeploymentKey(expected?.idempotency_key) || d.idempotency_key !== expected.idempotency_key || !CONTENT_ID.test(d.content_id ?? '') || (expected.content_id && d.content_id !== expected.content_id) || !/^[a-f0-9]{64}$/.test(d.package_sha256 ?? '') || d.package_sha256 !== expected.package_sha256 || !Number.isSafeInteger(d.size_bytes) || d.size_bytes < 1 || d.size_bytes !== expected.size_bytes || !['creating', 'draft', 'publishing', 'published', 'uncertain'].includes(d.status) || (d.reserved_at !== null && !date(d.reserved_at)) || (d.completed_at !== null && !date(d.completed_at))) throw new AccountError('DEPLOY_OUTCOME_UNKNOWN');
  if (complete && (d.source_verified !== true || !['draft', 'published'].includes(d.content_status))) throw new AccountError('DEPLOY_OUTCOME_UNKNOWN');
  const published = complete && d.status === 'published' && d.content_status === 'published' && d.source_verified === true && date(d.reserved_at) && date(d.completed_at);
  const notPublished = complete && d.status === 'draft' && d.content_status === 'draft' && d.source_verified === true && d.reserved_at === null && d.completed_at === null;
  return { ...expected, content_id: d.content_id, state: published ? 'published' : notPublished ? 'not_published' : 'unknown', source_verified: d.source_verified === true, reserved_at: d.reserved_at, completed_at: d.completed_at };
}
