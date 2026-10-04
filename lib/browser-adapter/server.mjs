import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { ADAPTER_PROTOCOL, ADAPTER_PORT, ADAPTER_ORIGIN, ADAPTER_LIMITS as L, ADAPTER_EVENT_TYPES } from './protocol.mjs';
import { createCoreTransport } from './core-transport.mjs';
import { ProtocolError, safeError } from '../agent-protocol/schema.mjs';

const ID = /^[A-Za-z0-9_-]{8,96}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,63}$/;
const NONCE = /^[a-f0-9]{64}$/;
const REQUEST = /^[A-Za-z0-9_-]{16,80}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const TYPES = new Set(ADAPTER_EVENT_TYPES);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const handle = prefix => prefix + randomBytes(16).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
class Failure extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
const fail = (code, status) => { throw new Failure(code, status); };
function shape(value, keys) { if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_INPUT'); }
function text(value, max, pattern) { if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || pattern && !pattern.test(value)) fail('INVALID_INPUT'); return value; }
function uniqueHeaders(req) {
  for (const header of ['host', 'origin', 'authorization', 'x-zuku-protocol', 'x-zuku-request-id', 'content-length']) {
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === header) count++;
    if (count > 1) fail('INVALID_HEADERS');
  }
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('JSON_REQUIRED', 415);
  if (Number(req.headers['content-length'] ?? 0) > L.bodyBytes) { req.resume(); fail('BODY_TOO_LARGE', 413); }
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > L.bodyBytes) fail('BODY_TOO_LARGE', 413); chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail('INVALID_JSON'); }
}
function eventData(value) {
  const safe = {};
  if (!record(value)) return safe;
  for (const key of ['content', 'text', 'status', 'stage', 'tool', 'stream', 'code', 'inputId', 'providerId', 'modelId', 'name', 'attempt', 'progress', 'published', 'contentId', 'runId', 'experimental']) {
    const entry = value[key];
    if (typeof entry === 'string' && entry.length <= 12000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(entry)) safe[key] = entry;
    else if (typeof entry === 'boolean' || typeof entry === 'number' && Number.isFinite(entry)) safe[key] = entry;
  }
  return safe;
}
const SAFE_CODES = new Set(['COMMAND_CANCELLED', 'LOGIN_REQUIRED', 'MODEL_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'AGENT_PROVIDER_UNAVAILABLE', 'AGENT_PROVIDER_FAILED', 'INVALID_INPUT', 'AGENT_REQUEST_OUT_OF_SCOPE', 'AGENT_GATE_FAILED', 'DEPLOY_QUOTA_EXCEEDED', 'CODEX_EXPERIMENTAL_REQUIRED', 'ZUKU_AUTH_UNAVAILABLE']);
const hostError = error => SAFE_CODES.has(error?.code) ? error.code : 'HOST_OPERATION_FAILED';

/**
 * Transport only. The native Studio composition supplies shared Agent Core callbacks;
 * this module never creates another agent, reads credentials, runs a shell, or accepts a path.
 * host: getHealth(), getProjects(), getProviders(), getModels({providerId,signal}),
 * createSession({projectId,providerId,modelId,signal}) -> {id},
 * input({sessionId,projectId,inputId,prompt,experimental,providerId,modelId,signal,onEvent}),
 * cancel({sessionId,signal}), authLogin/authLogout/useProvider/useModel(typed options).
 * approvePairing({challengeId,origin,expiresAt,signal}) -> true only after native user approval.
 * approveResume({sessionId,projectId,origin,expiresAt,signal}) -> true only after
 * a separate native approval to transfer this one session to the new pairing.
 */
export async function createBrowserAdapter({ host, approvePairing, approveResume, port = ADAPTER_PORT, allowedOrigins = [ADAPTER_ORIGIN], clock = Date.now } = {}) {
  const usesCore = typeof host?.dispatchCore === 'function' && typeof host?.subscribeCore === 'function';
  if (!host || ['getHealth', 'getProjects', 'getProviders', 'getModels', ...usesCore ? [] : ['createSession', 'input']].some(key => typeof host[key] !== 'function') || typeof approvePairing !== 'function') throw new Error('BROWSER_NATIVE_HOST_REQUIRED');
  if (!Number.isInteger(port) || port < 0 || port > 65535 || typeof clock !== 'function') throw new Error('BROWSER_ADAPTER_CONFIGURATION_INVALID');
  if (approveResume !== undefined && typeof approveResume !== 'function') throw new Error('BROWSER_ADAPTER_CONFIGURATION_INVALID');
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.length > 8 || allowedOrigins.some(origin => {
    try { const url = new URL(origin); return url.origin !== origin || url.username || url.password || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname); } catch { return true; }
  })) throw new Error('BROWSER_ORIGIN_CONFIGURATION_INVALID');
  const origins = new Set(allowedOrigins), instance = handle('adapter_');
  const shutdown = new AbortController(), tokens = new Map(), sessions = new Map(), replay = new Map();
  let challenge, address, active = 0, creating = 0, closed = false;
  const challenges = [], streams = new Set();
  const headers = origin => ({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Vary': 'Origin', ...(origins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}) });
  const json = (res, status, data, origin) => {
    const encoded = JSON.stringify(data);
    if (Buffer.byteLength(encoded) > L.responseBytes) fail('HOST_RESPONSE_TOO_LARGE', 502);
    if (!res.destroyed) res.writeHead(status, { ...headers(origin), 'Content-Type': 'application/json; charset=utf-8' }).end(encoded);
  };
  const expired = () => {
    for (const [key, value] of tokens) if (value.expiresAt <= clock()) tokens.delete(key);
    for (const [key, until] of replay) if (until <= clock()) replay.delete(key);
  };
  async function invoke(name, value) {
    if (typeof host[name] !== 'function') fail('OPERATION_UNAVAILABLE', 503);
    try { return await host[name](value); } catch (error) { fail(hostError(error), 502); }
  }
  const mutation = req => {
    const nonce = req.headers['x-zuku-request-id'];
    if (typeof nonce !== 'string' || !REQUEST.test(nonce)) fail('REQUEST_ID_REQUIRED');
    expired();
    if (replay.has(nonce)) fail('REQUEST_REPLAY', 409);
    if (replay.size >= L.requestIds) fail('REQUEST_LIMIT', 429);
    replay.set(nonce, clock() + L.tokenMs);
  };
  function authenticate(req) {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) fail('INVALID_TOKEN', 401);
    const key = digest(auth.slice(7)), token = tokens.get(key);
    if (!token) fail('INVALID_TOKEN', 401);
    if (token.expiresAt <= clock()) { tokens.delete(key); fail('TOKEN_EXPIRED', 401); }
    if (token.origin !== req.headers.origin) fail('INVALID_TOKEN', 401);
    return { ...token, key };
  }
  function stillAuthorized(token) {
    if (closed || !tokens.has(token.key) || token.expiresAt <= clock()) fail('INVALID_TOKEN', 401);
  }
  const coreTransport = typeof host.dispatchCore === 'function' && typeof host.subscribeCore === 'function'
    ? createCoreTransport({ host, shutdown, clock, authenticateAgain: stillAuthorized, streams, limits: L }) : null;
  async function projects() {
    const raw = await invoke('getProjects');
    const list = Array.isArray(raw) ? raw : raw?.projects;
    if (!Array.isArray(list) || list.length > 100) fail('HOST_RESPONSE_INVALID', 502);
    return list.map(value => ({ id: text(value?.id, 96, ID), name: text(value?.name, 120) }));
  }
  async function catalog() {
    const raw = await invoke('getProviders');
    if (!record(raw) || !Array.isArray(raw.providers) || raw.providers.length > 100) fail('HOST_RESPONSE_INVALID', 502);
    return {
      defaultProvider: text(raw.defaultProvider, 64, PROVIDER), defaultModel: text(raw.defaultModel, 200),
      providers: raw.providers.map(value => {
        if (!record(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.authMethods) || value.authMethods.length > 12) fail('HOST_RESPONSE_INVALID', 502);
        return { id: text(value.id, 64, PROVIDER), name: text(value.name, 100), enabled: value.enabled, authenticated: value.authenticated === true,
          authMethods: value.authMethods.map(method => {
            if (!record(method) || typeof method.official !== 'boolean' || typeof method.experimental !== 'boolean') fail('HOST_RESPONSE_INVALID', 502);
            return { id: text(method.id, 80), official: method.official, experimental: method.experimental };
          }) };
      }),
    };
  }
  async function provider(id, allowDisabled = false) {
    text(id, 64, PROVIDER);
    const entry = (await catalog()).providers.find(value => value.id === id);
    if (!entry || !allowDisabled && !entry.enabled) fail('INVALID_PROVIDER');
    return entry;
  }
  async function models(providerId) {
    await provider(providerId);
    const raw = await invoke('getModels', { providerId, signal: shutdown.signal });
    const list = Array.isArray(raw) ? raw : raw?.models;
    if (!Array.isArray(list) || list.length > 10000) fail('HOST_RESPONSE_INVALID', 502);
    return list.map(value => ({ id: text(value?.id, 200), name: text(value?.name ?? value?.displayName ?? value?.id, 200) }));
  }
  async function checkedModel(providerId, modelId) {
    text(modelId, 200);
    if (!(await models(providerId)).some(value => value.id === modelId || `${providerId}/${value.id}` === modelId)) fail('INVALID_MODEL');
  }
  function owned(id, token) {
    const session = sessions.get(id);
    if (!session || session.owner !== token.key) fail('SESSION_NOT_FOUND', 404);
    return session;
  }
  const sessionView = session => ({ id: session.id, projectId: session.projectId, providerId: session.providerId, modelId: session.modelId, active: !!session.active, lastSeq: session.seq, status: session.active ? 'running' : session.status });
  function invalidateResume(session, code = 'RESUME_CHANGED') {
    session.resume?.controller.abort(new Failure(code, code === 'INVALID_TOKEN' ? 401 : 409));
  }
  function beginOwnerOperation(session, token) {
    stillAuthorized(token); sameOwned(session, token);
    invalidateResume(session);
    session.ownerOperations++;
  }
  function sameOwned(session, token) {
    if (owned(session.id, token) !== session) fail('SESSION_NOT_FOUND', 404);
  }
  async function resumeSession(req, res, id, token, origin) {
    if (typeof approveResume !== 'function') fail('RESUME_UNAVAILABLE', 503);
    const value = await body(req); shape(value, ['projectId']); text(value.projectId, 96, ID);
    stillAuthorized(token);
    const session = sessions.get(id);
    if (!session || session.projectId !== value.projectId) fail('SESSION_NOT_FOUND', 404);
    if (!(await projects()).some(project => project.id === value.projectId)) fail('INVALID_PROJECT');
    stillAuthorized(token);
    if (sessions.get(id) !== session) fail('SESSION_NOT_FOUND', 404);
    if (session.resume || session.ownerOperations) fail('SESSION_BUSY', 409);
    const pending = { controller: new AbortController(), owner: session.owner, token: token.key, expiresAt: clock() + L.challengeMs };
    const signal = AbortSignal.any([pending.controller.signal, shutdown.signal, AbortSignal.timeout(L.challengeMs)]);
    const disconnected = () => { if (!res.writableEnded) pending.controller.abort(new Failure('RESUME_CANCELLED', 409)); };
    session.resume = pending; res.once('close', disconnected);
    if (res.destroyed) disconnected();
    const timer = setInterval(() => {
      if (clock() >= pending.expiresAt) pending.controller.abort(new Failure('RESUME_EXPIRED', 410));
      else if (!tokens.has(token.key) || token.expiresAt <= clock()) pending.controller.abort(new Failure('INVALID_TOKEN', 401));
    }, 100);
    timer.unref();
    let rejectApproval;
    const stopped = new Promise((_, reject) => { rejectApproval = () => reject(signal.reason instanceof Failure ? signal.reason : new Failure(signal.reason?.name === 'TimeoutError' ? 'RESUME_EXPIRED' : 'RESUME_CANCELLED', signal.reason?.name === 'TimeoutError' ? 410 : 409)); signal.addEventListener('abort', rejectApproval, { once: true }); if (signal.aborted) rejectApproval(); });
    try {
      const approval = Promise.resolve().then(() => { signal.throwIfAborted(); return approveResume({ sessionId: id, projectId: value.projectId, origin, expiresAt: pending.expiresAt, signal }); });
      if (await Promise.race([approval, stopped]) !== true) fail('RESUME_DENIED', 403);
      if (signal.aborted) fail('RESUME_CANCELLED', 409);
      if (clock() >= pending.expiresAt) fail('RESUME_EXPIRED', 410);
      stillAuthorized(token);
      if (!(await Promise.race([projects(), stopped])).some(project => project.id === value.projectId)) fail('INVALID_PROJECT');
      stillAuthorized(token);
      if (signal.aborted || clock() >= pending.expiresAt || sessions.get(id) !== session || session.resume !== pending || session.owner !== pending.owner || session.ownerOperations) fail('RESUME_CHANGED', 409);
      // Close every old-owner stream before changing authority. The native task,
      // event ring and input replay set remain the same objects.
      for (const stream of session.streams) stream.close();
      session.owner = token.key;
      return sessionView(session);
    } finally {
      clearInterval(timer); signal.removeEventListener('abort', rejectApproval); res.removeListener('close', disconnected);
      if (session.resume === pending) session.resume = null;
      pending.controller.abort();
    }
  }
  function push(session, type, data) {
    if (!TYPES.has(type)) return;
    const value = { protocolVersion: ADAPTER_PROTOCOL, seq: session.seq + 1, type, sessionId: session.id, data: eventData(data) };
    const line = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(line) > L.eventBytes) return;
    session.seq++;
    session.events.push({ seq: session.seq, line }); session.bytes += Buffer.byteLength(line);
    while (session.events.length > L.retainedEvents || session.bytes > L.retainedBytes) session.bytes -= Buffer.byteLength(session.events.shift().line);
    for (const stream of session.streams) stream.pump();
  }
  function subscribe(req, res, session, token, after, origin) {
    if (after < (session.events[0]?.seq ?? 1) - 1) fail('EVENTS_EXPIRED', 410);
    if (after > session.seq) fail('INVALID_SEQUENCE');
    if (session.streams.size >= L.streamsPerSession) fail('STREAM_LIMIT', 429);
    res.writeHead(200, { ...headers(origin), 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Zuku-Protocol': String(ADAPTER_PROTOCOL) });
    res.flushHeaders();
    let cursor = after, blocked = false, ended = false;
    const stream = { owner: token.key, close: () => { ended = true; res.end(); }, pump: () => {
      if (ended || blocked || res.destroyed) return;
      if (session.owner !== token.key || !tokens.has(token.key) || token.expiresAt <= clock()) { stream.close(); return; }
      if (cursor < (session.events[0]?.seq ?? 1) - 1) { res.end(); return; }
      for (const event of session.events) if (event.seq > cursor) { cursor = event.seq; if (!res.write(event.line)) { blocked = true; break; } }
    } };
    session.streams.add(stream); streams.add(stream);
    res.on('drain', () => { blocked = false; stream.pump(); });
    const heartbeat = setInterval(() => {
      if (session.owner !== token.key || !tokens.has(token.key) || token.expiresAt <= clock()) { stream.close(); return; }
      if (!blocked) blocked = !res.write('\n');
    }, L.heartbeatMs);
    heartbeat.unref();
    res.on('close', () => { clearInterval(heartbeat); session.streams.delete(stream); streams.delete(stream); });
    stream.pump();
  }
  async function handleRequest(req, res) {
    const origin = req.headers.origin;
    try {
      uniqueHeaders(req);
      if (req.headers.host !== address || !req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 2048) fail('HOST_REJECTED', 421);
      if (origin !== undefined && !origins.has(origin)) fail('ORIGIN_REJECTED', 403);
      const url = new URL(req.url, `http://${address}`), path = url.pathname;
      if (path.includes('%')) fail('INVALID_OPERATION', 404);
      if (req.method === 'OPTIONS') {
        if (!origins.has(origin)) fail('ORIGIN_REJECTED', 403);
        const method = req.headers['access-control-request-method'];
        const requested = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (!['GET', 'POST', 'DELETE'].includes(method) || requested.some(value => !['authorization', 'content-type', 'x-zuku-protocol', 'x-zuku-request-id'].includes(value))) fail('PREFLIGHT_REJECTED', 403);
        res.writeHead(204, { ...headers(origin), 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Zuku-Protocol, X-Zuku-Request-Id', 'Access-Control-Max-Age': '60' }).end(); return;
      }
      if (path === '/v1/health' && req.method === 'GET') {
        if (url.search) fail('INVALID_INPUT');
        const info = await invoke('getHealth');
        if (!record(info) || !['cliVersion', 'studioVersion', 'agentVersion'].every(key => typeof info[key] === 'string' && VERSION.test(info[key]))) fail('HOST_RESPONSE_INVALID', 503);
        json(res, 200, { product: 'zuku-browser-adapter', protocolVersion: ADAPTER_PROTOCOL, adapterInstanceId: instance, status: info.status === 'ready' ? 'ready' : 'not_running', cliVersion: info.cliVersion, studioVersion: info.studioVersion, agentVersion: info.agentVersion }, origin); return;
      }
      if (!origins.has(origin)) fail('ORIGIN_REJECTED', 403);
      if (req.headers['x-zuku-protocol'] !== String(ADAPTER_PROTOCOL)) fail('PROTOCOL_MISMATCH', 426);
      if (path === '/v1/pair/challenge' && req.method === 'POST') {
        mutation(req); const value = await body(req); shape(value, ['browserNonce']); text(value.browserNonce, 64, NONCE);
        if (url.search) fail('INVALID_INPUT');
        if (challenge && challenge.expiresAt > clock() && !challenge.consumed) fail('PAIRING_BUSY', 409);
        while (challenges.length && challenges[0] < clock() - 600000) challenges.shift();
        if (challenges.length >= 12) fail('PAIRING_LIMIT', 429);
        expired(); if (tokens.size >= L.tokens) fail('PAIRING_LIMIT', 429);
        challenge?.controller.abort();
        const controller = new AbortController();
        const pending = { id: handle('challenge_'), nonce: value.browserNonce, origin, expiresAt: clock() + L.challengeMs, approved: undefined, consumed: false, controller };
        const signal = AbortSignal.any([controller.signal, shutdown.signal, AbortSignal.timeout(L.challengeMs)]);
        challenge = pending; challenges.push(clock());
        Promise.resolve().then(() => approvePairing({ challengeId: pending.id, origin, expiresAt: pending.expiresAt, signal })).then(value => { if (challenge === pending && !signal.aborted) pending.approved = value === true; }, () => { pending.approved = false; });
        json(res, 200, { challengeId: pending.id, expiresAt: pending.expiresAt }, origin); return;
      }
      if (path === '/v1/pair/confirm' && req.method === 'POST') {
        mutation(req); const value = await body(req); shape(value, ['challengeId', 'browserNonce']); text(value.challengeId, 96, ID); text(value.browserNonce, 64, NONCE);
        if (url.search) fail('INVALID_INPUT');
        if (!challenge || challenge.id !== value.challengeId || challenge.nonce !== value.browserNonce || challenge.origin !== origin) fail('PAIRING_INVALID', 403);
        if (challenge.consumed) fail('PAIRING_REPLAY', 409);
        if (challenge.expiresAt <= clock()) { challenge.controller.abort(); fail('PAIRING_EXPIRED', 410); }
        if (challenge.approved === undefined) fail('PAIRING_PENDING', 409);
        if (!challenge.approved) fail('PAIRING_DENIED', 403);
        challenge.consumed = true; challenge.controller.abort();
        const token = randomBytes(32).toString('base64url'), expiresAt = clock() + L.tokenMs;
        const projectHandles = coreTransport ? (await projects()).map(project => project.id) : [];
        if (challenge.expiresAt <= clock() || closed) fail('PAIRING_EXPIRED', 410);
        tokens.set(digest(token), { origin, expiresAt, projectHandles });
        json(res, 200, { token, expiresAt, adapterInstanceId: instance }, origin); return;
      }
      const token = authenticate(req);
      if (req.method === 'POST' || req.method === 'DELETE') mutation(req);
      if (path === '/v1/pair/revoke' && req.method === 'POST') {
        const value = await body(req); shape(value, []); if (url.search) fail('INVALID_INPUT');
        for (const session of sessions.values()) if (session.resume && (session.resume.token === token.key || session.resume.owner === token.key)) invalidateResume(session, 'INVALID_TOKEN');
        tokens.delete(token.key); for (const stream of streams) if (stream.owner === token.key) stream.close();
        json(res, 200, { status: 'revoked' }, origin); return;
      }
      if (coreTransport && await coreTransport.handle({ req, res, url, token, readBody: body, json, headers })) return;
      if (path === '/v1/projects' && req.method === 'GET') { if (url.search) fail('INVALID_INPUT'); json(res, 200, { projects: await projects() }, origin); return; }
      if (path === '/v1/providers' && req.method === 'GET') { if (url.search) fail('INVALID_INPUT'); json(res, 200, await catalog(), origin); return; }
      if (path === '/v1/models' && req.method === 'GET') {
        if ([...url.searchParams.keys()].some(key => key !== 'provider') || url.searchParams.getAll('provider').length !== 1) fail('INVALID_INPUT');
        json(res, 200, { models: await models(url.searchParams.get('provider')) }, origin); return;
      }
      if (req.method === 'POST' && ['/v1/auth/login', '/v1/auth/logout', '/v1/providers/use', '/v1/models/use'].includes(path)) {
        if (url.search) fail('INVALID_INPUT');
        const value = await body(req); shape(value, path === '/v1/auth/login' ? ['providerId', 'experimental'] : path === '/v1/models/use' ? ['providerId', 'modelId'] : ['providerId']);
        const selected = await provider(value.providerId, path === '/v1/auth/logout');
        if (path === '/v1/auth/login') {
          if (typeof value.experimental !== 'boolean') fail('INVALID_INPUT');
          if (selected.authMethods.length && selected.authMethods.every(method => method.experimental) && value.experimental !== true) fail('EXPERIMENTAL_REQUIRED', 403);
        }
        if (path === '/v1/models/use') await checkedModel(value.providerId, value.modelId);
        const operation = { '/v1/auth/login': 'authLogin', '/v1/auth/logout': 'authLogout', '/v1/providers/use': 'useProvider', '/v1/models/use': 'useModel' }[path];
        stillAuthorized(token);
        await invoke(operation, { ...value, signal: shutdown.signal });
        json(res, 200, { status: 'completed', providerId: value.providerId, ...(value.modelId ? { modelId: value.modelId } : {}) }, origin); return;
      }
      if (path === '/v1/sessions' && req.method === 'POST') {
        if (url.search) fail('INVALID_INPUT');
        if (sessions.size + creating >= L.sessions) fail('SESSION_LIMIT', 429);
        creating++;
        try {
        const value = await body(req); shape(value, ['projectId', 'providerId', 'modelId']); text(value.projectId, 96, ID);
        if (!(await projects()).some(project => project.id === value.projectId)) fail('INVALID_PROJECT');
        const defaults = await catalog(); const providerId = value.providerId ?? defaults.defaultProvider, modelId = value.modelId ?? defaults.defaultModel;
        await checkedModel(providerId, modelId);
        stillAuthorized(token);
        const created = await invoke('createSession', { projectId: value.projectId, providerId, modelId, signal: shutdown.signal });
        const id = text(created?.id, 96, ID); if (sessions.has(id)) fail('SESSION_CONFLICT', 409);
        const session = { id, projectId: value.projectId, providerId, modelId, owner: token.key, seq: 0, bytes: 0, events: [], streams: new Set(), inputs: new Set(), active: null, status: 'ready', ownerOperations: 0, resume: null };
        sessions.set(id, session); push(session, 'session.created', { status: 'ready', providerId, modelId });
        json(res, 200, { id }, origin); return;
        } finally { creating--; }
      }
      const match = /^\/v1\/sessions\/([A-Za-z0-9_-]{8,96})(?:\/(input|events|cancel|resume))?$/.exec(path);
      if (!match) fail('UNKNOWN_OPERATION', 404);
      if (match[2] === 'resume' && req.method === 'POST') {
        if (url.search) fail('INVALID_INPUT');
        json(res, 200, await resumeSession(req, res, match[1], token, origin), origin); return;
      }
      const session = owned(match[1], token), operation = match[2];
      if (!operation && req.method === 'GET') { if (url.search) fail('INVALID_INPUT'); json(res, 200, sessionView(session), origin); return; }
      if (!operation && req.method === 'DELETE') {
        if (url.search || session.active) fail('SESSION_BUSY', 409);
        invalidateResume(session);
        push(session, 'session.closed', {}); for (const stream of session.streams) stream.close(); sessions.delete(session.id);
        json(res, 200, { status: 'closed' }, origin); return;
      }
      if (operation === 'events' && req.method === 'GET') {
        if ([...url.searchParams.keys()].some(key => key !== 'after') || url.searchParams.getAll('after').length > 1) fail('INVALID_SEQUENCE');
        const after = url.searchParams.get('after') ?? '0';
        if (!/^(?:0|[1-9][0-9]{0,15})$/.test(after) || !Number.isSafeInteger(Number(after))) fail('INVALID_SEQUENCE');
        subscribe(req, res, session, token, Number(after), origin); return;
      }
      if (operation === 'cancel' && req.method === 'POST') {
        beginOwnerOperation(session, token);
        try {
        if (url.search) fail('INVALID_INPUT'); const value = await body(req); shape(value, []);
        stillAuthorized(token); sameOwned(session, token);
        session.active?.abort();
        if (typeof host.cancel === 'function') await invoke('cancel', { sessionId: session.id, signal: shutdown.signal });
        json(res, 200, { status: 'cancelled' }, origin); return;
        } finally { session.ownerOperations--; }
      }
      if (operation === 'input' && req.method === 'POST') {
        beginOwnerOperation(session, token);
        try {
        if (url.search) fail('INVALID_INPUT'); const value = await body(req); shape(value, ['inputId', 'prompt', 'experimental']);
        text(value.inputId, 80, REQUEST); text(value.prompt, L.promptChars);
        if (!value.prompt.trim() || typeof value.experimental !== 'boolean') fail('INVALID_INPUT');
        if (session.inputs.has(value.inputId)) fail('INPUT_REPLAY', 409);
        if (session.inputs.size >= L.inputsPerSession) fail('INPUT_LIMIT', 429);
        if (session.active || active >= L.activeInputs) fail('SESSION_BUSY', 409);
        const selected = await provider(session.providerId);
        if (selected.authMethods.length && selected.authMethods.every(method => method.experimental) && !value.experimental) fail('EXPERIMENTAL_REQUIRED', 403);
        stillAuthorized(token);
        sameOwned(session, token);
        // Validation awaits host metadata. Recheck the reservation before dispatch.
        if (session.inputs.has(value.inputId)) fail('INPUT_REPLAY', 409);
        if (session.active || active >= L.activeInputs) fail('SESSION_BUSY', 409);
        const controller = new AbortController(); session.active = controller; session.status = 'running'; session.inputs.add(value.inputId); active++;
        const signal = AbortSignal.any([controller.signal, shutdown.signal, AbortSignal.timeout(L.inputMs)]);
        push(session, 'agent.started', { inputId: value.inputId });
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return host.input({ sessionId: session.id, projectId: session.projectId, providerId: session.providerId, modelId: session.modelId, ...value, signal,
          onEvent: event => {
            if (signal.aborted || !record(event)) return;
            if (event.type === 'stage') push(session, 'agent.reasoning_status', { stage: event.stage, status: event.status, attempt: event.attempt });
            else push(session, event.type, event.data ?? event);
          },
          });
        }).then(result => { session.status = signal.aborted ? 'cancelled' : 'completed'; push(session, signal.aborted ? 'agent.cancelled' : 'agent.completed', { status: session.status, published: result?.published === true }); }, error => { session.status = signal.aborted ? 'cancelled' : 'error'; push(session, signal.aborted ? 'agent.cancelled' : 'agent.error', { code: signal.aborted ? 'COMMAND_CANCELLED' : hostError(error) }); }).finally(() => { session.active = null; active--; });
        json(res, 202, { status: 'accepted', inputId: value.inputId, sessionId: session.id }, origin); return;
        } finally { session.ownerOperations--; }
      }
      fail('UNKNOWN_OPERATION', 404);
    } catch (error) {
      const publicCode = error instanceof Failure ? error.code : error instanceof ProtocolError ? safeError(error).code : safeError(error).code === 'CORE_OPERATION_FAILED' ? 'ADAPTER_FAILED' : safeError(error).code;
      const status = error instanceof Failure ? error.status : safeError(error).code !== 'CORE_OPERATION_FAILED' && Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : error instanceof ProtocolError ? 400 : 500;
      if (!res.headersSent) json(res, status, { code: publicCode, protocolVersion: ADAPTER_PROTOCOL }, origin); else res.end();
    }
  }
  const server = createServer((req, res) => { void handleRequest(req, res); });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 32; server.maxConnections = 64;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
  address = `127.0.0.1:${server.address().port}`;
  let closing;
  return Object.freeze({ origin: `http://${address}`, adapterInstanceId: instance, protocolVersion: ADAPTER_PROTOCOL,
    close() {
      if (closing) return closing;
      closed = true; shutdown.abort(); for (const session of sessions.values()) session.active?.abort(); for (const stream of streams) stream.close(); tokens.clear();
      closing = new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }); return closing;
    },
  });
}
