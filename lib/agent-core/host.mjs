import { createServer } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createAgentCore } from './index.mjs';
import { createCoreStorage } from './storage.mjs';
import { ProtocolError, safeError } from '../agent-protocol/index.mjs';
import { validateActor } from './projects.mjs';
import { validateNativePrompt, validateNativeReply } from './native-auth.mjs';

export function nativeAddress(dir, platform = process.platform) {
  if (platform === 'win32') return `\\\\.\\pipe\\zukujs-core-${createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0, 32)}`;
  const path = join(dir, 'agent.sock');
  if (Buffer.byteLength(path) > 103) throw new ProtocolError('CORE_UNAVAILABLE');
  return path;
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const eq = (left, right) => typeof left === 'string' && typeof right === 'string' && /^[A-Za-z0-9_-]{43}$/.test(left) && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** User-protected native IPC. Its authentication key is never a browser pairing token. */
export async function startCoreHost(context = {}) {
  const storage = await createCoreStorage(context), address = nativeAddress(storage.dir, context.platform);
  let prompter;
  const promptTimeoutMs = Math.max(1, Math.min(120000, context.nativePromptTimeoutMs ?? 120000));
  const openNativePromptSession = () => {
    const owner = prompter;
    if (!owner || owner.socket.destroyed) throw new ProtocolError('NATIVE_PERMISSION_REQUIRED');
    if (owner.sessions.size >= 4) throw new ProtocolError('AUTH_BUSY');
    const controller = new AbortController(); owner.sessions.add(controller);
    let ended = false;
    return Object.freeze({ signal: controller.signal,
      async request(fields, { signal } = {}) {
        if (ended || controller.signal.aborted || signal?.aborted || prompter !== owner) throw new ProtocolError('COMMAND_CANCELLED');
        if (owner.prompts.size >= 4) throw new ProtocolError('AUTH_BUSY');
        const prompt = validateNativePrompt({ ...fields, id: `prompt_${randomBytes(16).toString('hex')}`, expiresAt: Date.now() + promptTimeoutMs });
        let settled = false, timer, entry;
        const response = new Promise((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); owner.prompts.delete(prompt.id); controller.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); };
          const finish = (error, reply) => { if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(reply); };
          const abort = () => finish(new ProtocolError('COMMAND_CANCELLED'));
          entry = { prompt, finish }; owner.prompts.set(prompt.id, entry);
          controller.signal.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => finish(new ProtocolError('AUTH_PROMPT_TIMEOUT')), promptTimeoutMs); timer.unref();
        });
        response.catch(() => {}); // An abort can arrive while the bounded socket write is still pending.
        try { await owner.send({ type: 'native-prompt', prompt }); } catch { entry.finish(new ProtocolError('COMMAND_CANCELLED')); }
        return response;
      },
      close() { if (ended) return; ended = true; controller.abort(); owner.sessions.delete(controller); },
    });
  };
  const core = context.core ?? await createAgentCore({ ...context, ...(context.coreOptions ?? {}), storage, openNativePromptSession });
  if (core.stateDir !== storage.dir) throw new ProtocolError('CORE_STATE_UNSAFE');
  const token = randomBytes(32).toString('base64url'), instance = `core_${randomBytes(16).toString('hex')}`;
  const clients = new Set(); let socketIdentity, closing, closed = false;
  if ((context.platform ?? process.platform) !== 'win32') {
    try {
      const existing = await lstat(address);
      if (!existing.isSocket() || existing.isSymbolicLink() || existing.uid !== process.getuid?.() || (existing.mode & 0o077)) throw new ProtocolError('CORE_STATE_UNSAFE');
      // createAgentCore already acquired exclusive ownership or rejected an active host.
      await storage.guard(address); await unlink(address);
    } catch (error) { if (error?.code !== 'ENOENT') { await core.close(); throw error; } }
  }
  const server = createServer(socket => {
    if (closed || clients.size >= 32) { socket.destroy(); return; }
    clients.add(socket); socket.setNoDelay(true);
    const subscriptions = new Map(); let authenticated = false, actor, buffer = '', inflight = 0, writes = Promise.resolve();
    const timer = setTimeout(() => { if (!authenticated) socket.destroy(); }, 3000); timer.unref();
    const send = value => {
      const line = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(line) > 300000) { socket.destroy(); return Promise.reject(new ProtocolError('BODY_TOO_LARGE')); }
      const work = writes.then(() => new Promise((resolve, reject) => {
        if (socket.destroyed) { reject(new ProtocolError('CORE_NOT_RUNNING')); return; }
        if (socket.write(line)) { resolve(); return; }
        let timeout;
        const cleanup = () => { clearTimeout(timeout); socket.off('drain', drain); socket.off('close', stop); socket.off('error', stop); };
        const drain = () => { cleanup(); resolve(); };
        const stop = () => { cleanup(); reject(new ProtocolError('CORE_NOT_RUNNING')); };
        socket.once('drain', drain); socket.once('close', stop); socket.once('error', stop);
        timeout = setTimeout(() => { socket.destroy(); stop(); }, 5000); timeout.unref();
      }));
      writes = work.catch(() => {}); return work;
    };
    const authenticatedActor = proposed => {
      if (proposed === undefined) return actor;
      // Only an authenticated native connection may forward a separately constructed browser actor.
      if (!shape(proposed, ['kind', 'id', 'origin', 'projectHandles']) || proposed.kind !== 'browser') throw new ProtocolError('PERMISSION_REQUIRED');
      validateActor(proposed); return { ...proposed, projectHandles: [...proposed.projectHandles] };
    };
    const nativeOwner = { socket, send, prompts: new Map(), sessions: new Set() };
    const detachPrompter = () => {
      if (prompter === nativeOwner) prompter = undefined;
      for (const controller of nativeOwner.sessions) controller.abort();
      nativeOwner.sessions.clear();
      for (const entry of nativeOwner.prompts.values()) entry.finish(new ProtocolError('COMMAND_CANCELLED'));
    };
    const processMessage = async message => {
      if (!authenticated) {
        if (!shape(message, ['type', 'protocolVersion', 'token', 'clientId']) || message.type !== 'authenticate' || message.protocolVersion !== 1 || !id(message.clientId) || !eq(message.token, token)) { await send({ type: 'rejected', error: { code: 'CORE_AUTH_REQUIRED' } }); socket.destroy(); return; }
        authenticated = true; clearTimeout(timer); actor = { kind: 'native', id: message.clientId };
        await send({ type: 'authenticated', protocolVersion: 1, instance }); return;
      }
      if (message?.type === 'native-attach' || message?.type === 'native-detach') {
        if (!id(message.id) || !shape(message, ['type', 'id'])) throw new ProtocolError('INVALID_INPUT');
        if (message.type === 'native-attach') {
          if (prompter && prompter !== nativeOwner) throw new ProtocolError('NATIVE_PROMPTER_BUSY');
          prompter = nativeOwner; await send({ type: 'native-attached', id: message.id });
        } else { detachPrompter(); await send({ type: 'native-detached', id: message.id }); }
        return;
      }
      if (message?.type === 'native-reply') {
        if (!id(message.id) || !shape(message, ['type', 'id', 'reply'])) throw new ProtocolError('INVALID_INPUT');
        const entry = nativeOwner.prompts.get(message.id);
        if (!entry || prompter !== nativeOwner) throw new ProtocolError('PERMISSION_REQUIRED');
        const reply = validateNativeReply(entry.prompt, message.reply); entry.finish(undefined, reply); return;
      }
      if (!id(message?.id) || !shape(message, ['type', 'id', 'envelope', 'params', 'actor'])) throw new ProtocolError('INVALID_INPUT');
      if (message.type === 'dispatch') {
        if (message.params !== undefined) throw new ProtocolError('INVALID_INPUT');
        await send({ type: 'response', id: message.id, envelope: await core.dispatch(message.envelope, authenticatedActor(message.actor)) }); return;
      }
      if (message.type === 'unsubscribe') { subscriptions.get(message.id)?.abort(); await send({ type: 'unsubscribed', id: message.id }); return; }
      if (message.type !== 'subscribe' || message.envelope !== undefined || !shape(message.params, ['sessionId', 'afterSequence']) || !id(message.params.sessionId) || !Number.isSafeInteger(message.params.afterSequence) || message.params.afterSequence < 0 || subscriptions.has(message.id) || subscriptions.size >= 16) throw new ProtocolError('INVALID_INPUT');
      const controller = new AbortController(), subscriberActor = authenticatedActor(message.actor);
      subscriptions.set(message.id, controller);
      await send({ type: 'subscribed', id: message.id });
      void (async () => {
        try {
          for await (const event of core.subscribe({ ...message.params, signal: controller.signal }, subscriberActor)) await send({ type: 'event', id: message.id, event });
          await send({ type: 'ended', id: message.id });
        } catch (error) { await send({ type: 'stream-error', id: message.id, error: safeError(error) }).catch(() => {}); }
        finally { subscriptions.delete(message.id); }
      })();
    };
    socket.on('data', chunk => {
      // Native transport is UTF-8 JSON; decoding is incremental across byte boundaries.
      try { buffer += decoder.decode(chunk, { stream: true }); } catch { socket.destroy(); return; }
      if (Buffer.byteLength(buffer) > 131072) { socket.destroy(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line || ++inflight > 32) { socket.destroy(); return; }
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        Promise.resolve().then(() => processMessage(message)).catch(error => send({ type: 'transport-error', id: id(message?.id) ? message.id : 'invalid', error: safeError(error) }).catch(() => {})).finally(() => { inflight--; });
      }
    });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); clients.delete(socket); detachPrompter(); for (const controller of subscriptions.values()) controller.abort(); });
  });
  server.maxConnections = 32;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
    server.on('error', () => {});
    if ((context.platform ?? process.platform) !== 'win32') { await chmod(address, 0o600); socketIdentity = await lstat(address); }
    await storage.writeJSON('connection', { schema: 'zuku-core-ipc/1', protocolVersion: 1, pid: process.pid, address, token, instance });
  } catch (error) { server.close(); await core.close(); throw error instanceof ProtocolError ? error : new ProtocolError('CORE_UNAVAILABLE'); }
  return Object.freeze({ core, stateDir: storage.dir, instance,
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        for (const socket of clients) socket.destroy(); await new Promise(resolve => server.close(resolve));
        const record = await storage.readJSON('connection').catch(() => undefined);
        if (record?.instance === instance) await storage.remove('state', 'connection');
        await core.close();
        if (socketIdentity) { const current = await lstat(address).catch(() => undefined); if (current && same(current, socketIdentity)) await unlink(address).catch(() => {}); }
      })(); return closing;
    },
  });
}

// This machine entrypoint carries typed IPC only. Human CLI output is never parsed.
if (process.argv[1] && resolveEntry(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--serve') {
  const stateDir = process.argv[3];
  try {
    const host = await startCoreHost({ stateDir });
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await host.close().catch(() => {}); process.exitCode = 0; };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (error) { process.exitCode = error?.code === 'CORE_ALREADY_RUNNING' ? 0 : 1; }
}
function resolveEntry(path) { return resolve(path); }
