import { AdapterError, fail, safeError, statusError } from './errors.mjs';

export const DEFAULT_TIMEOUTS = Object.freeze({ connectMs: 30_000, firstByteMs: 120_000, idleMs: 120_000, totalMs: 900_000 });
export const DEFAULT_LIMITS = Object.freeze({
  jsonBytes: 4 * 1024 * 1024, // model catalogs (OpenRouter's is large)
  errorBodyBytes: 16 * 1024,
  streamBytes: 32 * 1024 * 1024,
  lineBytes: 1024 * 1024,
});
const TIMEOUT_BOUNDS = { connectMs: [100, 120_000], firstByteMs: [100, 600_000], idleMs: [100, 600_000], totalMs: [100, 3_600_000] };

const CONTROL = /[\u0000-\u001f\u007f]/;
const ENCODED_ESCAPE = /%(2e|2f|5c|00)/i;
const ENDPOINT_SUFFIX = /\/(chat\/completions|responses|messages|api\/chat|api\/tags|models)$/i;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'cookie', 'set-cookie', 'te', 'trailer', 'keep-alive', 'expect', 'proxy-authorization', 'proxy-connection', 'origin', 'referer']);

export function isLoopbackHost(hostname) {
  if (hostname === '[::1]' || hostname === 'localhost') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return Boolean(m) && m.slice(1).every(part => Number(part) <= 255);
}

/**
 * Validate a provider base URL. Returns the normalized base without a trailing slash.
 * - https everywhere; http only for loopback hosts when `allowLoopbackHttp` is explicit.
 * - userinfo, query, fragment, dot segments, encoded separators, `//`, repeated version
 *   segments (`/v1/v1`) and bases that already end in an endpoint path are refused.
 */
export function validateBaseUrl(raw, { allowLoopbackHttp = false } = {}) {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 2048 || CONTROL.test(raw) || raw.includes('\\') || /\s/.test(raw)) fail('ADAPTER_ENDPOINT_REJECTED');
  let url;
  try { url = new URL(raw); } catch { fail('ADAPTER_ENDPOINT_REJECTED'); }
  if (url.username || url.password || url.search || url.hash || raw.includes('?') || raw.includes('#') || raw.includes('@')) fail('ADAPTER_ENDPOINT_REJECTED');
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && allowLoopbackHttp === true)) fail('ADAPTER_ENDPOINT_REJECTED');
  // Compare against the raw text too: WHATWG URL silently resolves dot segments.
  const rawPath = raw.replace(/^[a-z]+:\/\/[^/]*/i, '');
  if (ENCODED_ESCAPE.test(rawPath) || /(^|\/)\.{1,2}(\/|$)/.test(rawPath) || rawPath.includes('//')) fail('ADAPTER_ENDPOINT_REJECTED');
  const path = url.pathname.replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean);
  for (let i = 1; i < segments.length; i += 1) if (/^v\d+(beta\d*|alpha\d*)?$/i.test(segments[i]) && segments[i].toLowerCase() === segments[i - 1].toLowerCase()) fail('ADAPTER_ENDPOINT_REJECTED');
  if (ENDPOINT_SUFFIX.test(path)) fail('ADAPTER_ENDPOINT_REJECTED');
  return `${url.origin}${path}`;
}

/** Explicit loopback test origin (tests only): replaces the origin of an official base, keeps its path. */
export function rebaseForTest(officialBase, testOrigin) {
  const origin = validateBaseUrl(testOrigin, { allowLoopbackHttp: true });
  const test = new URL(origin);
  if (!isLoopbackHost(test.hostname) || test.pathname !== '/') fail('ADAPTER_ENDPOINT_REJECTED');
  return `${test.origin}${new URL(officialBase).pathname.replace(/\/+$/, '')}`;
}

/** Join a validated base with a fixed protocol path. Dynamic segments must already be encoded. */
export function joinUrl(base, path, query) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..') || path.includes('//') || CONTROL.test(path)) fail('ADAPTER_ENDPOINT_REJECTED');
  const url = new URL(base + path);
  if (url.origin !== new URL(base).origin) fail('ADAPTER_ENDPOINT_REJECTED');
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  return url.href;
}

export const segment = value => encodeURIComponent(value);

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/;
export function validModelId(id) {
  return typeof id === 'string' && MODEL_ID.test(id) && !id.split('/').some(part => part === '' || part === '.' || part === '..');
}
export function requireModelId(id) {
  if (id === undefined || id === null || id === '') fail('ADAPTER_MODEL_REQUIRED');
  if (!validModelId(id)) fail('ADAPTER_MODEL_INVALID');
  return id;
}

function checkHeader(name, value) {
  if (typeof name !== 'string' || !TOKEN.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('proxy-') || name.toLowerCase().startsWith('sec-')) fail('ADAPTER_HEADER_REJECTED');
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || CONTROL.test(value)) fail('ADAPTER_HEADER_REJECTED');
}

/**
 * Merge protocol-fixed headers with user metadata headers and secret headers.
 * User/secret headers may not replace protocol-managed names.
 */
export function buildHeaders(fixed, ...extra) {
  const out = new Headers();
  const managed = new Set();
  for (const [name, value] of Object.entries(fixed)) {
    if (value === undefined) continue;
    checkHeader(name, value);
    out.set(name, value);
    managed.add(name.toLowerCase());
  }
  let count = 0;
  for (const group of extra) {
    if (group === undefined || group === null) continue;
    if (typeof group !== 'object' || Array.isArray(group)) fail('ADAPTER_HEADER_REJECTED');
    for (const [name, value] of Object.entries(group)) {
      checkHeader(name, value);
      if (managed.has(name.toLowerCase()) || out.has(name)) fail('ADAPTER_HEADER_REJECTED');
      if (++count > 32) fail('ADAPTER_HEADER_REJECTED');
      out.set(name, value);
    }
  }
  return out;
}

export function resolveTimeouts(overrides = {}) {
  const out = { ...DEFAULT_TIMEOUTS };
  for (const [key, [min, max]] of Object.entries(TIMEOUT_BOUNDS)) {
    const value = overrides?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < min || value > max) fail('ADAPTER_REQUEST_INVALID');
    out[key] = value;
  }
  return out;
}

function contextHint(text) {
  const lower = text.toLowerCase();
  return /context_length_exceeded|context length|maximum context|prompt is too long|too many tokens|input is too long|exceeds the context window|model_context_window_exceeded/.test(lower) ? 'context' : undefined;
}

async function readLimited(body, limit, onChunk) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk?.();
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); return { bytes: null, size }; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return { bytes: Buffer.concat(chunks), size };
}

/**
 * One HTTP exchange. Never retried, never follows redirects, credentials omitted
 * from cookies, combined caller/total/first-byte/idle aborts.
 */
export class Exchange {
  constructor({ fetch: call = globalThis.fetch, signals = [], timeouts, limits } = {}) {
    if (typeof call !== 'function') fail('ADAPTER_INVALID_DESCRIPTOR');
    this.fetch = call;
    this.timeouts = resolveTimeouts(timeouts);
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.controller = new AbortController();
    this.signals = signals.filter(Boolean);
    this.timedOut = false;
    this.timers = new Set();
    this.onAbort = () => this.controller.abort();
    for (const signal of this.signals) {
      if (signal.aborted) this.controller.abort();
      else signal.addEventListener('abort', this.onAbort, { once: true });
    }
    this.total = this.#timer(this.timeouts.totalMs);
  }
  get signal() { return this.controller.signal; }
  get callerAborted() { return this.signals.some(signal => signal.aborted); }
  #timer(ms) {
    const id = setTimeout(() => { this.timedOut = true; this.controller.abort(); }, ms);
    this.timers.add(id);
    return id;
  }
  #clear(id) { clearTimeout(id); this.timers.delete(id); }
  error(error) {
    if (this.callerAborted) return new AdapterError('COMMAND_CANCELLED');
    if (this.timedOut) return new AdapterError('PROVIDER_TIMEOUT');
    return safeError(error);
  }
  async send(url, { method = 'GET', headers, body } = {}) {
    if (this.controller.signal.aborted) throw this.error();
    const first = this.#timer(this.timeouts.firstByteMs);
    let response;
    try {
      // 'manual': a 3xx is surfaced (and refused below) instead of followed.
      response = await this.fetch(url, { method, headers, body, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: this.controller.signal });
    } catch (error) {
      this.#clear(first);
      throw this.error(error);
    }
    this.firstByteTimer = first;
    if (!response || typeof response.status !== 'number') { this.#clear(first); throw new AdapterError('PROVIDER_RESPONSE_INVALID'); }
    if (response.redirected || (response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      this.#clear(first);
      await response.body?.cancel().catch(() => {});
      throw new AdapterError('PROVIDER_REDIRECT_REJECTED', { status: response.status || undefined });
    }
    if (!response.ok) {
      let hint;
      try {
        if (response.body) {
          const { bytes } = await readLimited(response.body, this.limits.errorBodyBytes);
          if (bytes) hint = contextHint(bytes.toString('utf8'));
        }
      } catch { /* classification only */ }
      this.#clear(first);
      throw statusError(response.status, hint);
    }
    return response;
  }
  async json(response) {
    if (!response.body) { this.#clear(this.firstByteTimer); throw new AdapterError('PROVIDER_RESPONSE_INVALID'); }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > this.limits.jsonBytes) { await response.body.cancel().catch(() => {}); throw new AdapterError('PROVIDER_RESPONSE_TOO_LARGE'); }
    let result;
    try { result = await readLimited(response.body, this.limits.jsonBytes, () => this.#clear(this.firstByteTimer)); }
    catch (error) { throw this.error(error); }
    finally { this.#clear(this.firstByteTimer); }
    if (!result.bytes) throw new AdapterError('PROVIDER_RESPONSE_TOO_LARGE');
    try { return JSON.parse(result.bytes.toString('utf8')); } catch { throw new AdapterError('PROVIDER_RESPONSE_INVALID'); }
  }
  /** Raw body chunks with first-byte/idle timers and a total byte bound. */
  async *chunks(response) {
    if (!response.body) { this.#clear(this.firstByteTimer); throw new AdapterError('PROVIDER_RESPONSE_INVALID'); }
    const reader = response.body.getReader();
    let size = 0;
    let idle;
    try {
      while (true) {
        let result;
        try { result = await reader.read(); } catch (error) { throw this.error(error); }
        if (this.firstByteTimer !== undefined) { this.#clear(this.firstByteTimer); this.firstByteTimer = undefined; }
        if (idle !== undefined) this.#clear(idle);
        if (result.done) return;
        size += result.value.byteLength;
        if (size > this.limits.streamBytes) throw new AdapterError('PROVIDER_RESPONSE_TOO_LARGE');
        idle = this.#timer(this.timeouts.idleMs);
        yield result.value;
        if (this.controller.signal.aborted) throw this.error();
      }
    } finally {
      if (idle !== undefined) this.#clear(idle);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  close() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    for (const signal of this.signals) signal.removeEventListener('abort', this.onAbort);
    if (!this.controller.signal.aborted) this.controller.abort();
  }
}

/** GET a JSON document with one exchange. */
export async function getJson(context, url, headers, { signal, timeouts } = {}) {
  const exchange = new Exchange({ fetch: context.fetch, signals: [context.signal, signal], timeouts: timeouts ?? context.timeouts, limits: context.limits });
  try {
    const response = await exchange.send(url, { method: 'GET', headers });
    return await exchange.json(response);
  } catch (error) {
    throw exchange.error(error);
  } finally { exchange.close(); }
}
