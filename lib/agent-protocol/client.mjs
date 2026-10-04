import { PROTOCOL_VERSION, ProtocolError, validateRequest, validateEvent, safeError } from './schema.mjs';

const opaque = prefix => {
  const bytes = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) throw new ProtocolError('CORE_UNAVAILABLE');
  globalThis.crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
};
function result(response, id) {
  if (!response || response.protocolVersion !== PROTOCOL_VERSION || response.id !== id) throw new ProtocolError('PROTOCOL_MISMATCH');
  if (response.error) { const error = new ProtocolError(safeError(response.error).code); Object.assign(error, safeError(response.error)); throw error; }
  if (!Object.hasOwn(response, 'result')) throw new ProtocolError('INVALID_INPUT');
  return response.result;
}
/** A transport wrapper, never another agent or credential/configuration store. */
export function createAgentClient({ dispatch, subscribe, native = false } = {}) {
  if (typeof dispatch !== 'function' || typeof subscribe !== 'function') throw new ProtocolError('INVALID_INPUT');
  return Object.freeze({
    async call(method, params = {}, options = {}) {
      const envelope = validateRequest({ protocolVersion: PROTOCOL_VERSION, id: options.id ?? opaque('req_'), method, params }, { native });
      return result(await dispatch(envelope, options), envelope.id);
    },
    async *events(params) {
      for await (const event of subscribe(params)) yield validateEvent(event);
    },
  });
}
function loopback(value) {
  let url;
  try { url = new URL(value); } catch { throw new ProtocolError('INVALID_INPUT'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ProtocolError('INVALID_INPUT');
  return url.origin;
}
async function jsonResponse(response, maxBytes = 262144) {
  if (!response.body) throw new ProtocolError('CORE_UNAVAILABLE');
  const reader = response.body.getReader(); const parts = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > maxBytes) throw new ProtocolError('BODY_TOO_LARGE');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new ProtocolError('INVALID_INPUT'); }
}
/** Browser tokens live only in this closure; no cookie/localStorage or cloud credential is used. */
export function createBrowserClient({ baseUrl = 'http://127.0.0.1:43127', fetchImpl = globalThis.fetch, protocolVersion = PROTOCOL_VERSION } = {}) {
  const base = loopback(baseUrl);
  if (typeof fetchImpl !== 'function' || protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError('PROTOCOL_MISMATCH');
  let token, expiresAt = 0, pending, closed = false;
  const streams = new Set();
  async function request(path, { method = 'GET', data, authenticated = true, signal, stream = false } = {}) {
    if (closed) throw new ProtocolError('CORE_CLOSED');
    if (authenticated && (!token || expiresAt <= Date.now())) throw new ProtocolError('PERMISSION_REQUIRED');
    const headers = { 'X-Zuku-Protocol': String(PROTOCOL_VERSION) };
    if (authenticated) headers.Authorization = `Bearer ${token}`;
    if (method !== 'GET') headers['X-Zuku-Request-Id'] = opaque('nonce_');
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(base + path, { method, headers, ...(data !== undefined ? { body: JSON.stringify(data) } : {}), signal, credentials: 'omit', cache: 'no-store', redirect: 'error', targetAddressSpace: 'loopback' });
    } catch (error) {
      if (signal?.aborted) throw new ProtocolError('COMMAND_CANCELLED');
      // A failed fetch cannot distinguish missing software from browser permission denial.
      throw new ProtocolError(error?.name === 'NotAllowedError' ? 'PERMISSION_REQUIRED' : 'CORE_UNAVAILABLE');
    }
    if (!response.ok) {
      const body = await jsonResponse(response).catch(() => ({}));
      if (['INVALID_TOKEN', 'TOKEN_EXPIRED'].includes(body.code)) { token = undefined; expiresAt = 0; throw new ProtocolError('PERMISSION_REQUIRED'); }
      throw new ProtocolError(safeError({ code: body.code }).code);
    }
    return stream ? response : jsonResponse(response);
  }
  return Object.freeze({
    async health({ signal } = {}) {
      const info = await request('/v1/health', { authenticated: false, signal });
      if (info.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError('PROTOCOL_MISMATCH');
      return info;
    },
    async challenge({ signal } = {}) {
      const nonce = opaque('').padEnd(64, '0');
      const value = await request('/v1/pair/challenge', { method: 'POST', data: { browserNonce: nonce }, authenticated: false, signal });
      if (typeof value.challengeId !== 'string' || !Number.isSafeInteger(value.expiresAt)) throw new ProtocolError('INVALID_INPUT');
      pending = { id: value.challengeId, nonce, expiresAt: value.expiresAt };
      return { challengeId: value.challengeId, expiresAt: value.expiresAt };
    },
    async confirm({ challengeId = pending?.id, signal } = {}) {
      if (!pending || challengeId !== pending.id || pending.expiresAt <= Date.now()) throw new ProtocolError('PERMISSION_REQUIRED');
      const value = await request('/v1/pair/confirm', { method: 'POST', authenticated: false, signal, data: { challengeId, browserNonce: pending.nonce } });
      if (typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isSafeInteger(value.expiresAt)) throw new ProtocolError('INVALID_INPUT');
      token = value.token; expiresAt = value.expiresAt; pending = undefined;
      return { status: 'connected', expiresAt };
    },
    async call(method, params = {}, { signal, id = opaque('req_') } = {}) {
      const envelope = validateRequest({ protocolVersion: PROTOCOL_VERSION, id, method, params });
      return result(await request('/v1/rpc', { method: 'POST', data: envelope, signal }), id);
    },
    async *events({ sessionId, afterSequence = 0, signal } = {}) {
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new ProtocolError('INVALID_INPUT');
      const controller = new AbortController(); streams.add(controller);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let reader;
      try {
        const response = await request(`/v1/sessions/${sessionId}/events?afterSequence=${afterSequence}`, { signal: combined, stream: true });
        reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '', cursor = afterSequence;
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 65536) throw new ProtocolError('BODY_TOO_LARGE');
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            let event; try { event = validateEvent(JSON.parse(line)); } catch { throw new ProtocolError('INVALID_INPUT'); }
            if (event.sessionId !== sessionId || event.sequence !== cursor + 1) throw new ProtocolError('INVALID_CURSOR');
            cursor = event.sequence; yield event;
          }
        }
        buffer += decoder.decode(); if (buffer.trim()) throw new ProtocolError('INVALID_INPUT');
      } finally { streams.delete(controller); controller.abort(); await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    },
    close() { closed = true; token = undefined; pending = undefined; expiresAt = 0; for (const controller of streams) controller.abort(); streams.clear(); },
  });
}
