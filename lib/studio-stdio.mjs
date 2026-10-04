import { randomBytes } from 'node:crypto';
import { createBrowserAdapter } from './browser-adapter/server.mjs';
import { createStudioPreview } from './studio-preview.mjs';
import { ProtocolError, safeError, validateRequest, validateEvent, projectPublicResult } from './agent-protocol/index.mjs';
import { nativeAuthorizationUrl } from './agent-core/native-auth.mjs';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, required, optional = []) => {
  if (!object(value) || Object.keys(value).some(key => ![...required, ...optional].includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new ProtocolError('INVALID_INPUT');
};
const fail = code => { throw new ProtocolError(code); };

/** Inherited native pipe. GTK is the only consumer of private pairing/auth/project messages. */
export async function createStudioStdio({ context, input, output, adapterOptions = {}, signal } = {}) {
  if (!context || typeof context.dispatchNative !== 'function' || typeof context.subscribeNative !== 'function' || !context.adapterHost || !input?.[Symbol.asyncIterator] || !output?.write) fail('CORE_UNAVAILABLE');
  let closed = false, closing, buffer = Buffer.alloc(0), writes = Promise.resolve(), writeBytes = 0, inflight = 0, adapter;
  const aborter = new AbortController(), combined = signal ? AbortSignal.any([signal, aborter.signal]) : aborter.signal;
  const prompts = new Map(), subscriptions = new Map(), replay = new Set(), active = new Set();
  const preview = await createStudioPreview({ dispatchNative: context.dispatchNative });
  const send = value => {
    if (closed) return Promise.resolve();
    const line = JSON.stringify(value) + '\n', size = Buffer.byteLength(line);
    if (size > 262144 || writeBytes + size > 1048576) return Promise.reject(new ProtocolError('SLOW_SUBSCRIBER'));
    writeBytes += size;
    const next = writes.then(() => new Promise((resolve, reject) => {
      if (closed) { writeBytes -= size; resolve(); return; }
      let timer, done = false;
      const finish = error => { if (done) return; done = true; clearTimeout(timer); writeBytes -= size; error ? reject(new ProtocolError('CORE_NOT_RUNNING')) : resolve(); };
      timer = setTimeout(() => finish(true), 5000); timer.unref();
      try { output.write(line, finish); } catch { finish(true); }
    }));
    writes = next.catch(() => {}); return next;
  };
  const emit = (type, data) => send({ protocolVersion: 1, type, data: projectPublicResult(data) });
  const ask = (kind, data, { expiresAt = Date.now() + 120000, signal: requestSignal } = {}) => {
    if (closed || prompts.size >= 4 || combined.aborted || requestSignal?.aborted) return Promise.reject(new ProtocolError('COMMAND_CANCELLED'));
    const requestId = `native_prompt_${randomBytes(16).toString('hex')}`, expires = Math.min(expiresAt, Date.now() + 120000);
    const stop = requestSignal ? AbortSignal.any([combined, requestSignal]) : combined;
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const finish = (value, error) => {
        if (settled) return; settled = true; clearTimeout(timer); stop.removeEventListener('abort', cancel); prompts.delete(requestId);
        void send({ protocolVersion: 1, type: kind === 'pairing' ? 'native.pairingClosed' : 'native.authClosed', data: { requestId } }).catch(() => {});
        error ? reject(error) : resolve(value);
      };
      const cancel = () => finish(undefined, new ProtocolError('COMMAND_CANCELLED'));
      prompts.set(requestId, { kind, finish }); stop.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(cancel, Math.max(1, expires - Date.now())); timer.unref();
      // Explicitly private: native C consumes these frames and never forwards them to WebKit.
      void send({ protocolVersion: 1, type: kind === 'pairing' ? 'native.pairing' : 'native.auth', data: { ...data, requestId, expiresAt: expires } }).catch(() => finish(undefined, new ProtocolError('CORE_NOT_RUNNING')));
    });
  };
  const nativePrompt = async (request, { signal: requestSignal } = {}) => {
    let question = request.title;
    if (request.kind === 'decision') question += `\n${request.purpose === 'logout' ? 'Sign out of this provider?' : 'Allow this provider login request?'}`;
    if (request.kind === 'secret') question += '\nAPI key (stored by the local Core).';
    if (request.userCode) question += `\nCode: ${request.userCode}`;
    if (request.url) question += `\n${request.url}\nComplete authorization in your browser, then return here.`;
    if (Buffer.byteLength(question) > 1000) fail('BODY_TOO_LARGE');
    const value = await ask('auth', { kind: request.kind, providerId: request.providerId, methodId: request.authMethodId, question, experimental: request.experimental, ...(request.url ? { url: nativeAuthorizationUrl(request.providerId, request.url) } : {}) }, { expiresAt: request.expiresAt, signal: requestSignal });
    if (!value || value === 'deny') return { cancelled: true };
    if (request.kind === 'secret') return { value };
    if (request.kind === 'decision') return { approved: value === 'allow' };
    return value === 'ack' ? { acknowledged: true } : { cancelled: true };
  };
  try {
    await context.setNativePrompter(nativePrompt);
    adapter = await createBrowserAdapter({ ...adapterOptions, host: context.adapterHost,
      approvePairing: options => ask('pairing', { origin: options.origin }, options),
      approveResume: options => ask('pairing', { origin: options.origin, projectName: 'ZUKU game project' }, options),
    });
  } catch (error) { await preview.close(); await context.setNativePrompter(null).catch(() => {}); throw error; }

  const nativeEnvelope = value => {
    exact(value, ['protocolVersion', 'id', 'method', 'params']);
    if (value.protocolVersion !== 1 || !identifier(value.id) || typeof value.method !== 'string') fail('INVALID_INPUT');
    return value;
  };
  const subscribe = async params => {
    exact(params, ['subscriptionId', 'sessionId', 'afterSequence']);
    if (!identifier(params.subscriptionId) || !identifier(params.sessionId) || !Number.isSafeInteger(params.afterSequence) || params.afterSequence < 0 || subscriptions.has(params.subscriptionId) || subscriptions.size >= 16) fail('INVALID_INPUT');
    const snap = await context.dispatchNative('session.get', { sessionId: params.sessionId });
    if (params.afterSequence > snap.sequence) fail('INVALID_CURSOR'); if (params.afterSequence < snap.minimumSequence - 1) fail('CURSOR_EXPIRED');
    const controller = new AbortController(), stop = AbortSignal.any([combined, controller.signal]);
    subscriptions.set(params.subscriptionId, controller);
    void (async () => {
      try {
        for await (const event of context.subscribeNative({ sessionId: params.sessionId, afterSequence: params.afterSequence, signal: stop })) {
          validateEvent(event); await send({ protocolVersion: 1, type: 'native.subscription', data: { subscriptionId: params.subscriptionId, event } });
        }
        if (!closed) await send({ protocolVersion: 1, type: 'native.subscription', data: { subscriptionId: params.subscriptionId, status: { kind: 'status', state: 'closed' } } });
      } catch (error) {
        if (!closed) await send({ protocolVersion: 1, type: 'native.subscription', data: { subscriptionId: params.subscriptionId, status: { kind: 'status', state: error.code === 'CURSOR_EXPIRED' ? 'cursor_expired' : 'disconnected', code: safeError(error).code, ...(error.code === 'CURSOR_EXPIRED' ? { minimumSequence: snap.minimumSequence } : {}) } } }).catch(() => {});
      } finally { subscriptions.delete(params.subscriptionId); }
    })();
    return { status: 'connected' };
  };
  const dispatch = async raw => {
    try {
      const value = nativeEnvelope(raw);
      if (replay.has(value.id) || active.has(value.id)) fail('REQUEST_CONFLICT');
      active.add(value.id); replay.add(value.id); if (replay.size > 4096) replay.delete(replay.values().next().value);
      let result;
      if (value.method === 'native.projectChosen') {
        exact(value.params, ['requestId', 'localPath']);
        if (value.params.requestId !== value.id || typeof value.params.localPath !== 'string' || !value.params.localPath.length || value.params.localPath.length > 4096 || /[\x00-\x1f]/.test(value.params.localPath)) fail('INVALID_INPUT');
        result = await context.grantNativeProject(value.params.localPath, { requestId: value.id });
      } else if (value.method === 'native.pairingDecision' || value.method === 'native.authResponse') {
        const pairing = value.method === 'native.pairingDecision'; exact(value.params, ['requestId', pairing ? 'allow' : 'value']);
        const prompt = prompts.get(value.params.requestId);
        if (!prompt || prompt.kind !== (pairing ? 'pairing' : 'auth')) fail('PERMISSION_REQUIRED');
        if (pairing && typeof value.params.allow !== 'boolean' || !pairing && (typeof value.params.value !== 'string' || !/^[\x20-\x7e]{0,16384}$/.test(value.params.value))) fail('INVALID_INPUT');
        prompt.finish(pairing ? value.params.allow : value.params.value); result = { status: 'acknowledged' };
      } else if (value.method === 'native.subscribe') result = await subscribe(value.params);
      else if (value.method === 'native.unsubscribe') {
        exact(value.params, ['subscriptionId']); if (!identifier(value.params.subscriptionId)) fail('INVALID_INPUT');
        subscriptions.get(value.params.subscriptionId)?.abort(); result = { status: 'closed' };
      } else if (value.method === 'native.resolvePreview') {
        exact(value.params, ['previewHandle']); if (!identifier(value.params.previewHandle)) fail('INVALID_INPUT'); result = await preview.resolve(value.params.previewHandle);
      } else {
        validateRequest(value, { native: true });
        if (value.method === 'project.grant') fail('NATIVE_PERMISSION_REQUIRED');
        // Paths are supplied only through the C-owned picker, with a second boundary here.
        result = await context.dispatchNative(value);
      }
      // Preview URL is an opaque native-only response; C validates and consumes it without renderer forwarding.
      await send({ protocolVersion: 1, id: value.id, result: value.method === 'native.resolvePreview' ? result : projectPublicResult(result) });
    } catch (error) { await send({ protocolVersion: 1, id: identifier(raw?.id) ? raw.id : 'invalid', error: safeError(error) }).catch(() => {}); }
    finally { active.delete(raw?.id); }
  };
  async function close() {
    if (closing) return closing;
    closed = true;
    closing = Promise.resolve().then(async () => {
      aborter.abort();
      for (const prompt of [...prompts.values()]) prompt.finish(undefined, new ProtocolError('COMMAND_CANCELLED'));
      for (const controller of subscriptions.values()) controller.abort();
      await adapter.close(); await preview.close(); await context.setNativePrompter(null).catch(() => {}); await context.close();
    }); return closing;
  }
  const consume = async () => {
    try {
      for await (const chunk of input) {
        if (closed || combined.aborted) break;
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        let newline;
        while ((newline = buffer.indexOf(10)) >= 0) {
          if (newline > 65536 || inflight >= 32) fail('BODY_TOO_LARGE');
          const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1); let raw;
          try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { fail('INVALID_INPUT'); }
          inflight++; void dispatch(raw).finally(() => { inflight--; });
        }
        if (buffer.length > 65536) fail('BODY_TOO_LARGE');
      }
    } finally { await close(); }
  };
  combined.addEventListener('abort', () => { input.destroy?.(); void close(); }, { once: true });
  const done = consume().catch(() => {});
  await emit('host.ready', { status: 'ready', protocolVersion: 1 });
  return Object.freeze({ adapter, preview, close, done });
}
