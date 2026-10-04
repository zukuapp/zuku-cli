// Restricted renderer client over window.zukuStudio. It validates every call with
// the shared protocol schema; it never touches fetch, storage, credentials or the OS.
import { PROTOCOL_VERSION, validateRequest, validateEvent } from '../../lib/agent-protocol/schema.mjs';
import { subscriptionStatus } from './state.mjs';

export const RENDERER_METHODS = Object.freeze([
  'hello', 'project.list', 'project.read', 'project.patch', 'project.search',
  'session.create', 'session.list', 'session.get', 'session.input', 'session.cancel', 'session.close',
  'provider.list', 'provider.use', 'provider.configure', 'provider.enable', 'provider.disable',
  'model.list', 'model.use', 'model.info', 'auth.list', 'auth.request', 'auth.logout',
  'game.run', 'game.stop', 'game.preview',
]);
// Methods the shared schema marks native-only; hidden when no trusted native host exists.
export const NATIVE_ONLY = Object.freeze(['provider.configure', 'provider.enable', 'provider.disable']);

export class StudioClientError extends Error {
  constructor(code, extra = {}) { super(code); this.name = 'StudioClientError'; this.code = code; Object.assign(this, extra); }
}
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
export function toClientError(error) {
  if (error instanceof StudioClientError) return error;
  const source = error?.error && typeof error.error === 'object' ? error.error : error;
  const extra = {};
  if (['login', 'update', 'retry', 'inspect_project', 'recover_deployment'].includes(source?.action)) extra.action = source.action;
  if (Number.isSafeInteger(source?.retryAfterMs) && source.retryAfterMs >= 0 && source.retryAfterMs <= 21600000) extra.retryAfterMs = source.retryAfterMs;
  return new StudioClientError(typeof source?.code === 'string' && CODE.test(source.code) ? source.code : 'CORE_OPERATION_FAILED', extra);
}

export function createRequestId(prefix = 'req', crypto = globalThis.crypto) {
  if (!/^[a-z]{1,16}$/.test(prefix) || typeof crypto?.getRandomValues !== 'function') throw new StudioClientError('CORE_UNAVAILABLE');
  const raw = crypto.getRandomValues(new Uint8Array(18));
  let text = '';
  for (const byte of raw) text += String.fromCharCode(byte);
  return `${prefix}_${btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** validateParams(method, params, {native}) -> params; throws StudioClientError with a safe code. */
export function validateParams(method, params, { native = true } = {}) {
  if (!RENDERER_METHODS.includes(method)) throw new StudioClientError('METHOD_NOT_ALLOWED');
  if (!native && NATIVE_ONLY.includes(method)) throw new StudioClientError('NATIVE_PERMISSION_REQUIRED');
  try { validateRequest({ protocolVersion: PROTOCOL_VERSION, id: 'renderer_check', method, params }, { native }); }
  catch (error) { throw toClientError(error); }
  return params;
}

export function createStudioClient(bridge, { native = true, timeoutMs = 30000, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  if (!bridge || typeof bridge.call !== 'function' || typeof bridge.subscribe !== 'function') throw new StudioClientError('BRIDGE_UNAVAILABLE');
  return Object.freeze({
    native,
    async call(method, params = {}) {
      validateParams(method, params, { native });
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimer(() => reject(new StudioClientError('CORE_TIMEOUT')), timeoutMs); });
      try { return await Promise.race([Promise.resolve().then(() => bridge.call(method, params)), timeout]); }
      catch (error) { throw toClientError(error); }
      finally { clearTimer(timer); }
    },
    // onEvent receives only schema-valid events; onStatus receives relay status or drop notices.
    // The returned function detaches this subscriber only; it never cancels agent work.
    subscribe({ sessionId, afterSequence }, onEvent, onStatus = () => {}) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId ?? '') || !Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new StudioClientError('INVALID_CURSOR');
      let active = true, detach = null;
      try {
        detach = bridge.subscribe({ sessionId, afterSequence }, message => {
          if (!active) return;
          const status = subscriptionStatus(message);
          if (status) { onStatus(status); return; }
          try { validateEvent(message); } catch { onStatus({ state: 'dropped', code: 'INVALID_EVENT', minimumSequence: null }); return; }
          onEvent(message);
        });
      } catch (error) { active = false; throw toClientError(error); }
      return () => {
        if (!active) return;
        active = false;
        try { if (typeof detach === 'function') detach(); } catch { /* detaching must not throw into unmount */ }
      };
    },
  });
}
