import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createCoreStorage } from './storage.mjs';
import { nativeAddress } from './host.mjs';
import { ProtocolError, validateRequest, validateEvent, safeError } from '../agent-protocol/index.mjs';
import { validateNativePrompt, validateNativeReply } from './native-auth.mjs';

const opaque = prefix => `${prefix}${randomBytes(16).toString('hex')}`;
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new ProtocolError('COMMAND_CANCELLED')); return; }
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new ProtocolError('COMMAND_CANCELLED')); };
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  signal?.addEventListener('abort', abort, { once: true });
});
async function connect(storage, context) {
  const record = await storage.readJSON('connection');
  if (!record || record.schema !== 'zuku-core-ipc/1' || record.protocolVersion !== 1 || record.address !== nativeAddress(storage.dir, context.platform) || typeof record.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.token) || !/^core_[a-f0-9]{32}$/.test(record.instance)) throw new ProtocolError('CORE_NOT_RUNNING');
  if ((context.platform ?? process.platform) !== 'win32') {
    await storage.guard(record.address); const stat = await lstat(record.address);
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new ProtocolError('CORE_STATE_UNSAFE');
  }
  const socket = createConnection(record.address), pending = new Map(), subscriptions = new Map(), nativePrompts = new Map();
  let closed = false, authenticated = false, buffer = '', writes = Promise.resolve(), resolveAuth, rejectAuth, nativePrompter;
  const auth = new Promise((resolve, reject) => { resolveAuth = resolve; rejectAuth = reject; });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const stop = error => {
    if (closed) return; closed = true;
    const safe = error instanceof ProtocolError ? error : new ProtocolError('CORE_NOT_RUNNING');
    rejectAuth(safe); for (const value of pending.values()) { clearTimeout(value.timer); value.reject(safe); } pending.clear();
    nativePrompter = undefined; for (const controller of nativePrompts.values()) controller.abort(); nativePrompts.clear();
    for (const value of subscriptions.values()) { value.error = safe; value.closed = true; value.wake?.(); } socket.destroy();
  };
  const send = message => {
    const line = JSON.stringify(message) + '\n'; if (Buffer.byteLength(line) > 131072) throw new ProtocolError('BODY_TOO_LARGE');
    const work = writes.then(() => new Promise((resolve, reject) => {
      if (closed) { reject(new ProtocolError('CORE_CLOSED')); return; }
      if (socket.write(line)) { resolve(); return; }
      let timer;
      const cleanup = () => { clearTimeout(timer); socket.off('drain', done); socket.off('close', fail); };
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new ProtocolError('CORE_NOT_RUNNING')); };
      socket.once('drain', done); socket.once('close', fail); timer = setTimeout(() => { fail(); stop(); }, 5000); timer.unref();
    }));
    writes = work.catch(() => {}); return work;
  };
  socket.on('data', chunk => {
    try { buffer += decoder.decode(chunk, { stream: true }); } catch { stop(new ProtocolError('INVALID_INPUT')); return; }
    if (Buffer.byteLength(buffer) > 600000) { stop(new ProtocolError('BODY_TOO_LARGE')); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); let message;
      try { message = JSON.parse(line); } catch { stop(new ProtocolError('INVALID_INPUT')); return; }
      if (!authenticated) {
        if (message.type === 'authenticated' && message.protocolVersion === 1 && message.instance === record.instance) { authenticated = true; resolveAuth(); } else stop(new ProtocolError('CORE_AUTH_REQUIRED'));
        continue;
      }
      if (['response', 'transport-error', 'native-attached', 'native-detached'].includes(message.type)) {
        const value = pending.get(message.id); if (!value) continue;
        pending.delete(message.id); clearTimeout(value.timer);
        if (message.error) value.reject(new ProtocolError(safeError(message.error).code)); else value.resolve(message.envelope);
        continue;
      }
      if (message.type === 'native-prompt') {
        let prompt;
        try { prompt = validateNativePrompt(message.prompt); } catch { stop(new ProtocolError('INVALID_INPUT')); return; }
        if (!nativePrompter || nativePrompts.size >= 4 || nativePrompts.has(prompt.id) || prompt.expiresAt > Date.now() + 121000) { stop(new ProtocolError('INVALID_INPUT')); return; }
        const callback = nativePrompter, controller = new AbortController(); nativePrompts.set(prompt.id, controller);
        const timer = setTimeout(() => controller.abort(), Math.max(1, prompt.expiresAt - Date.now())); timer.unref();
        // No public protocol/event subscription ever receives this native-only frame.
        void (async () => {
          let reply;
          try {
            reply = await Promise.race([Promise.resolve().then(() => callback(Object.freeze(prompt), { signal: controller.signal })), new Promise(resolve => { controller.signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }); })]);
            if (closed || callback !== nativePrompter) return;
            validateNativeReply(prompt, reply); await send({ type: 'native-reply', id: prompt.id, reply });
          } catch { if (!closed) await send({ type: 'native-reply', id: prompt.id, reply: { cancelled: true } }).catch(() => {}); }
          finally { reply = undefined; clearTimeout(timer); controller.abort(); nativePrompts.delete(prompt.id); }
        })();
        continue;
      }
      const sub = subscriptions.get(message.id); if (!sub) continue;
      if (message.type === 'event') {
        let event; try { event = validateEvent(message.event); } catch { stop(new ProtocolError('INVALID_INPUT')); return; }
        const size = Buffer.byteLength(JSON.stringify(event));
        if (sub.bytes + size > 256 * 1024) { sub.error = new ProtocolError('SLOW_SUBSCRIBER'); sub.closed = true; sub.queue = []; sub.bytes = 0; void send({ type: 'unsubscribe', id: message.id }).catch(() => {}); }
        else { sub.queue.push({ event, bytes: size }); sub.bytes += size; }
      }
      if (message.type === 'stream-error') { sub.error = new ProtocolError(safeError(message.error).code); sub.closed = true; }
      if (message.type === 'ended' || message.type === 'unsubscribed') sub.closed = true;
      sub.wake?.(); sub.wake = undefined;
    }
  });
  socket.once('error', () => stop(new ProtocolError('CORE_NOT_RUNNING'))); socket.once('close', () => stop(new ProtocolError('CORE_NOT_RUNNING')));
  const handshake = setTimeout(() => stop(new ProtocolError('CORE_NOT_RUNNING')), 3000); handshake.unref();
  socket.once('connect', () => { void send({ type: 'authenticate', protocolVersion: 1, token: record.token, clientId: opaque('native_') }).catch(stop); });
  try { await auth; } finally { clearTimeout(handshake); }
  const nativeControl = async type => {
    if (closed) throw new ProtocolError('CORE_CLOSED'); if (pending.size >= 32) throw new ProtocolError('REQUEST_LIMIT');
    const id = opaque('native_control_');
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new ProtocolError('CORE_UNAVAILABLE')); }, 3000); timer.unref(); pending.set(id, { resolve, reject, timer });
    });
    try { await send({ type, id }); } catch (error) { const value = pending.get(id); pending.delete(id); clearTimeout(value?.timer); value?.reject(error); }
    return response;
  };
  return Object.freeze({
    stateDir: storage.dir,
    async attachNativePrompter(callback) {
      if (typeof callback !== 'function') throw new ProtocolError('INVALID_INPUT');
      if (nativePrompter) throw new ProtocolError('NATIVE_PROMPTER_BUSY');
      nativePrompter = callback;
      try { await nativeControl('native-attach'); } catch (error) { if (nativePrompter === callback) nativePrompter = undefined; throw error; }
      let detached = false;
      return async () => {
        if (detached) return; detached = true;
        if (nativePrompter === callback) nativePrompter = undefined;
        for (const controller of nativePrompts.values()) controller.abort();
        if (!closed) await nativeControl('native-detach');
      };
    },
    async dispatch(envelope, { actor } = {}) {
      validateRequest(envelope, { native: actor?.kind !== 'browser' });
      if (pending.size >= 32) throw new ProtocolError('REQUEST_LIMIT');
      const id = opaque('ipc_');
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new ProtocolError('CORE_UNAVAILABLE')); }, 30000); timer.unref();
        pending.set(id, { resolve, reject, timer });
      });
      try { await send({ type: 'dispatch', id, envelope, ...(actor ? { actor } : {}) }); } catch (error) { const value = pending.get(id); pending.delete(id); clearTimeout(value?.timer); value?.reject(error); }
      return response;
    },
    async *subscribe({ sessionId, afterSequence = 0, signal } = {}, { actor } = {}) {
      if (!/^ses_[a-f0-9]{32}$/.test(sessionId) || !Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new ProtocolError('INVALID_INPUT');
      if (subscriptions.size >= 16) throw new ProtocolError('SESSION_LIMIT');
      const id = opaque('sub_'), sub = { queue: [], bytes: 0, closed: false }; subscriptions.set(id, sub);
      const abort = () => { sub.closed = true; sub.wake?.(); void send({ type: 'unsubscribe', id }).catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      let cursor = afterSequence;
      try {
        await send({ type: 'subscribe', id, params: { sessionId, afterSequence }, ...(actor ? { actor } : {}) });
        if (signal?.aborted) abort();
        while (true) {
          while (!sub.queue.length && !sub.closed) await new Promise(resolve => { sub.wake = resolve; });
          if (sub.error) throw sub.error; if (!sub.queue.length) break;
          const entry = sub.queue.shift(); sub.bytes -= entry.bytes;
          if (entry.event.sessionId !== sessionId || entry.event.sequence !== cursor + 1) throw new ProtocolError('INVALID_CURSOR');
          cursor = entry.event.sequence; yield entry.event;
        }
      } finally { signal?.removeEventListener('abort', abort); subscriptions.delete(id); void send({ type: 'unsubscribe', id }).catch(() => {}); }
    },
    close() { stop(new ProtocolError('CORE_CLOSED')); },
  });
}
/** Attach/autostart the same host; closing this client never aborts an agent session. */
export async function createCoreClient(context = {}) {
  const storage = await createCoreStorage(context);
  try { return await connect(storage, context); } catch (error) {
    if (context.autostart === false || !['CORE_NOT_RUNNING', 'ENOENT', 'ECONNREFUSED'].includes(error?.code)) throw error;
  }
  const start = () => {
    const child = spawn(context.nodePath ?? process.execPath, [fileURLToPath(new URL('./host.mjs', import.meta.url)), '--serve', storage.dir], { detached: true, stdio: 'ignore', windowsHide: true, env: context.environment ?? process.env });
    child.on('error', () => {}); child.unref(); return child;
  };
  let child = start(), starts = 1;
  const started = Date.now();
  while (Date.now() - started < 5000) {
    await pause(50, context.signal);
    try { return await connect(storage, context); } catch (error) { if (!['CORE_NOT_RUNNING', 'ENOENT', 'ECONNREFUSED'].includes(error?.code)) throw error; }
    if (child.exitCode !== null && starts < 3) { child = start(); starts++; }
  }
  throw new ProtocolError('CORE_NOT_RUNNING');
}
