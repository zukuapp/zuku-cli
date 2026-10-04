import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { ProviderError, requireExperimental, checkCancelled, providerMetadata } from '../provider-errors.mjs';

// Reviewed Kilo MIT flow patterns; protocol is OpenAI's current OSS dynamic registration.
export const CODEX_ENDPOINTS = Object.freeze({
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  jwks: 'https://auth.openai.com/.well-known/jwks.json',
  resource: 'https://api.openai.com/v1',
});
export const CODEX_SCOPES = Object.freeze(['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']);
const MAX_STORE = 2 * 1024 * 1024;
const MAX_JSON = 512 * 1024;
const safeString = (v, max = 32768) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[\x21-\x7e]+$/.test(v);
const clientId = v => safeString(v, 512) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v) && v !== 'dynamic_agent_client';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const idFor = (client, subject) => createHash('sha256').update(JSON.stringify([client, subject])).digest('hex');
const owner = st => typeof process.getuid === 'function' && st.uid === process.getuid();
const privateMode = (st, mode) => (st.mode & 0o777) === mode;
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  checkCancelled(signal);
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new ProviderError('CODEX_AUTH_CANCELLED')); }
  signal?.addEventListener('abort', abort, { once: true });
});

async function readResponse(response, limit = MAX_JSON) {
  if (!response.body) throw new ProviderError('CODEX_AUTH_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new ProviderError('CODEX_AUTH_RESPONSE_INVALID');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('CODEX_AUTH_RESPONSE_INVALID');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function validateStore(store) {
  if (!store || store.version !== 1 || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(store.hostId)
    || typeof store.experimentalAccepted !== 'boolean'
    || !Number.isSafeInteger(store.authEpoch) || store.authEpoch < 0 || !Array.isArray(store.accounts) || store.accounts.length > 16
    || !(store.activeAccount === null || /^[a-f0-9]{64}$/.test(store.activeAccount))) throw new ProviderError('CODEX_STORE_INVALID');
  const seen = new Set();
  for (const a of store.accounts) {
    if (!a || !clientId(a.clientId) || typeof a.subject !== 'string' || !a.subject || a.subject.length > 512
      || a.id !== idFor(a.clientId, a.subject) || seen.has(a.id) || a.issuer !== 'https://auth.openai.com'
      || ![a.accessToken, a.refreshToken, a.idToken].every(v => safeString(v))
      || !Number.isSafeInteger(a.expiresAt) || a.expiresAt <= 0 || !Array.isArray(a.scopes) || a.scopes.length > 64
      || !a.scopes.every(v => typeof v === 'string' && /^[A-Za-z0-9._:-]+$/.test(v))
      || !['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'].every(s => a.scopes.includes(s))) throw new ProviderError('CODEX_STORE_INVALID');
    seen.add(a.id);
  }
  if (store.activeAccount !== null && !seen.has(store.activeAccount)) throw new ProviderError('CODEX_STORE_INVALID');
  return store;
}

export function createCodexOAuth({ storePath = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ZukuJS', 'codex-oauth.dpapi') : path.join(homedir(), '.config', 'zukujs', 'codex-oauth.json'), fetchImpl = globalThis.fetch,
  now = Date.now, authorizationTimeoutMs = 300000, requestTimeoutMs = 20000, lockTimeoutMs = 30000 } = {}) {
  storePath = path.resolve(storePath);
  if (process.platform !== 'win32' && (typeof process.getuid !== 'function' || !constants.O_NOFOLLOW)) throw new ProviderError('CODEX_PLATFORM_UNSUPPORTED');
  const directory = path.dirname(storePath);
  let cachedJwks;
  let jwksAt = 0;
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || ![authorizationTimeoutMs, requestTimeoutMs, lockTimeoutMs].every(v => Number.isSafeInteger(v) && v > 0)) throw new ProviderError('CODEX_INPUT_INVALID');
  async function windows(action) {
    try { return await action(await import('../accounts/windows-protected-store.mjs')); }
    catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(error?.code === 'ZUKU_ACCOUNT_BUSY' ? 'CODEX_STORE_LOCKED' : error?.code === 'COMMAND_CANCELLED' ? 'CODEX_AUTH_CANCELLED' : 'CODEX_STORE_UNSAFE');
    }
  }

  async function ensureDirectory() {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const st = await lstat(directory);
      if (!st.isDirectory() || st.isSymbolicLink() || !owner(st) || !privateMode(st, 0o700) || await realpath(directory) !== directory) throw new ProviderError('CODEX_STORE_UNSAFE');
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('CODEX_STORE_UNSAFE');
    }
  }

  async function readStore() {
    if (process.platform === 'win32') {
      const content = await windows(adapter => adapter.readProtectedStore(storePath));
      if (content === null) return null;
      try { return validateStore(JSON.parse(content)); }
      catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError('CODEX_STORE_INVALID'); }
    }
    let file;
    try {
      const parent = await lstat(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink() || !owner(parent) || !privateMode(parent, 0o700) || await realpath(directory) !== directory) throw new ProviderError('CODEX_STORE_UNSAFE');
      const st = await lstat(storePath);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || !owner(st) || !privateMode(st, 0o600) || st.size > MAX_STORE) throw new ProviderError('CODEX_STORE_UNSAFE');
      file = await open(storePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const opened = await file.stat();
      if (!opened.isFile() || opened.nlink !== 1 || !owner(opened) || !privateMode(opened, 0o600) || opened.size > MAX_STORE) throw new ProviderError('CODEX_STORE_UNSAFE');
      return validateStore(JSON.parse(await file.readFile('utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('CODEX_STORE_INVALID');
    } finally { await file?.close(); }
  }

  async function writeStore(store) {
    validateStore(store);
    const content = JSON.stringify(store);
    if (Buffer.byteLength(content) > MAX_STORE) throw new ProviderError('CODEX_STORE_INVALID');
    if (process.platform === 'win32') { await windows(adapter => adapter.writeProtectedStore(storePath, content)); return; }
    const temp = `${storePath}.${randomUUID()}.tmp`;
    let file;
    try {
      // Refuse an unsafe existing destination rather than silently replacing it.
      await readStore();
      file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
      await file.writeFile(content);
      await file.sync();
      await file.close(); file = undefined;
      await rename(temp, storePath);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('CODEX_STORE_UNSAFE');
    } finally { await file?.close(); await unlink(temp).catch(() => {}); }
  }

  async function locked(fn, signal) {
    checkCancelled(signal);
    if (process.platform === 'win32') return windows(adapter => adapter.withProtectedStoreLock(storePath, fn, { signal, timeoutMs: lockTimeoutMs }));
    await ensureDirectory();
    const lockPath = `${storePath}.lock`;
    const until = Date.now() + lockTimeoutMs;
    let lock;
    while (!lock) {
      checkCancelled(signal);
      try {
        lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
        await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } catch (error) {
        if (error?.code !== 'EEXIST') throw new ProviderError('CODEX_STORE_UNSAFE');
        const st = await lstat(lockPath).catch(() => null);
        if (st && (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || !owner(st) || !privateMode(st, 0o600))) throw new ProviderError('CODEX_STORE_UNSAFE');
        if (Date.now() >= until) throw new ProviderError('CODEX_STORE_LOCKED');
        await sleep(50, signal);
      }
    }
    try { return await fn(); }
    finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
  }

  async function request(url, init, signal, refresh = false) {
    checkCancelled(signal);
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs) });
    } catch {
      checkCancelled(signal);
      throw new ProviderError('CODEX_NETWORK_ERROR');
    }
    if (response.url && response.url !== url || response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError('CODEX_AUTH_RESPONSE_INVALID');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(response.status === 429 ? 'CODEX_RATE_LIMITED' : refresh && [400, 401, 403].includes(response.status) ? 'CODEX_REAUTH_REQUIRED' : 'CODEX_AUTH_DENIED');
    }
    const mime = (response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    if (mime !== 'application/json' && !(url === CODEX_ENDPOINTS.jwks && mime === 'application/jwk-set+json')) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError('CODEX_AUTH_RESPONSE_INVALID');
    }
    return readResponse(response);
  }

  async function verifyIdentity(token, client, nonce, subject, signal) {
    if (!safeString(token)) throw new ProviderError('CODEX_IDENTITY_INVALID');
    async function keys(force = false) {
      if (force || !cachedJwks || now() - jwksAt > 300000) {
        const data = await request(CODEX_ENDPOINTS.jwks, { method: 'GET' }, signal);
        if (!Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 64) throw new ProviderError('CODEX_IDENTITY_INVALID');
        cachedJwks = createLocalJWKSet(data); jwksAt = now();
      }
      return cachedJwks;
    }
    try {
      const options = { issuer: 'https://auth.openai.com', audience: client, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'iat', 'exp'], currentDate: new Date(now()), clockTolerance: 5 };
      let verified;
      try { verified = await jwtVerify(token, await keys(), options); }
      catch (error) { if (error?.code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error; verified = await jwtVerify(token, await keys(true), options); }
      const p = verified.payload;
      if (typeof p.sub !== 'string' || !p.sub || p.sub.length > 512 || !Number.isSafeInteger(p.iat) || p.iat > Math.floor(now() / 1000) + 5
        || p.azp !== undefined && p.azp !== client || Array.isArray(p.aud) && p.aud.length > 1 && p.azp !== client
        || nonce !== undefined && !same(p.nonce, nonce) || subject !== undefined && p.sub !== subject) throw new ProviderError('CODEX_IDENTITY_INVALID');
      return p.sub;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('CODEX_IDENTITY_INVALID');
    }
  }

  function validateTokens(data, refresh = false) {
    if (!data || !safeString(data.access_token) || !safeString(data.refresh_token) || !refresh && !safeString(data.id_token)
      || data.id_token !== undefined && !safeString(data.id_token) || String(data.token_type).toLowerCase() !== 'bearer'
      || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400 || typeof data.scope !== 'string' || data.scope.length > 2048)
      throw new ProviderError('CODEX_AUTH_RESPONSE_INVALID');
    const scopes = [...new Set(data.scope.trim().split(/\s+/))];
    if (!scopes.every(s => /^[A-Za-z0-9._:-]+$/.test(s)) || !['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'].every(s => scopes.includes(s))) throw new ProviderError('CODEX_AUTH_DENIED');
    return scopes;
  }

  async function login({ experimental, onAuthorizationUrl, signal, accountId } = {}) {
    requireExperimental(experimental); checkCancelled(signal);
    if (typeof onAuthorizationUrl !== 'function' || accountId !== undefined && !/^[a-f0-9]{64}$/.test(accountId)) throw new ProviderError('CODEX_INPUT_INVALID');
    const initial = await locked(async () => {
      const store = await readStore() || { version: 1, hostId: `urn:uuid:${randomUUID()}`, authEpoch: 0, activeAccount: null, accounts: [] };
      store.experimentalAccepted = true;
      if (accountId && !store.accounts.some(a => a.id === accountId)) throw new ProviderError('CODEX_INPUT_INVALID');
      await writeStore(store); return store;
    }, signal);
    const selected = accountId ? initial.accounts.find(a => a.id === accountId) : undefined;
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let redirectUri;
    let callbackClient;
    let handling = false;
    let complete;
    let fail;
    const callback = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    // Avoid an unhandled rejection while the authorization URL callback is awaited.
    callback.catch(() => {});
    const server = createServer((req, res) => {
      const reply = (status, text) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(text); };
      if (!redirectUri || req.method !== 'GET' || req.headers.host !== new URL(redirectUri).host || (req.url || '').length > 8192) return reply(400, 'Invalid callback');
      let url;
      try { url = new URL(req.url, redirectUri); } catch { return reply(400, 'Invalid callback'); }
      if (url.origin !== new URL(redirectUri).origin) return reply(400, 'Invalid callback');
      if (url.pathname !== '/auth/callback') return reply(404, 'Not found');
      if (handling) return reply(409, 'Callback already handled');
      if (['state', 'code', 'client_id', 'error', 'scope'].some(k => url.searchParams.getAll(k).length > 1) || !same(url.searchParams.get('state'), state)) return reply(400, 'Invalid callback');
      handling = true;
      if (url.searchParams.has('error')) { reply(400, 'Authorization denied'); fail(new ProviderError('CODEX_AUTH_DENIED')); return; }
      const issued = url.searchParams.get('client_id') || selected?.clientId;
      const code = url.searchParams.get('code');
      if (!clientId(issued) || selected && issued !== selected.clientId || !safeString(code, 4096)) { reply(400, 'Invalid callback'); fail(new ProviderError('CODEX_AUTH_RESPONSE_INVALID')); return; }
      callbackClient = issued;
      reply(200, 'Authorization received. Return to the Experimental ZukuJS CLI for verification.');
      complete(code);
    });
    const aborted = () => fail(new ProviderError('CODEX_AUTH_CANCELLED'));
    let timer;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const url = new URL(CODEX_ENDPOINTS.authorize);
      const params = { client_id: selected?.clientId || 'dynamic_agent_client', ext_agent_host_id: initial.hostId, response_type: 'code', redirect_uri: redirectUri,
        scope: CODEX_SCOPES.join(' '), resource: CODEX_ENDPOINTS.resource, state, nonce, code_challenge: challenge, code_challenge_method: 'S256' };
      if (!selected) params.agent_name_hint = 'zukujs';
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      timer = setTimeout(() => fail(new ProviderError('CODEX_AUTH_TIMEOUT')), authorizationTimeoutMs);
      signal?.addEventListener('abort', aborted, { once: true }); checkCancelled(signal);
      await Promise.race([Promise.resolve().then(() => onAuthorizationUrl(url.href)), callback]);
      const code = await callback;
      const data = await request(CODEX_ENDPOINTS.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: callbackClient, code, code_verifier: verifier, redirect_uri: redirectUri, resource: CODEX_ENDPOINTS.resource }) }, signal);
      const scopes = validateTokens(data);
      const subject = await verifyIdentity(data.id_token, callbackClient, nonce, selected?.subject, signal);
      const id = idFor(callbackClient, subject);
      const record = { id, issuer: 'https://auth.openai.com', clientId: callbackClient, subject, accessToken: data.access_token, refreshToken: data.refresh_token,
        idToken: data.id_token, scopes, expiresAt: now() + data.expires_in * 1000 };
      await locked(async () => {
        const fresh = await readStore();
        if (!fresh || fresh.authEpoch !== initial.authEpoch || selected && !fresh.accounts.some(a => a.id === selected.id)) throw new ProviderError('CODEX_AUTH_SESSION_CHANGED');
        fresh.accounts = fresh.accounts.filter(a => a.id !== id); fresh.accounts.push(record); fresh.activeAccount = id; fresh.authEpoch++;
        await writeStore(fresh);
      }, signal);
      return { ...providerMetadata, authenticated: true, accountId: id };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('CODEX_NETWORK_ERROR');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }

  async function status({ experimental } = {}) {
    requireExperimental(experimental);
    const store = await readStore();
    const active = store?.accounts.find(a => a.id === store.activeAccount);
    return { ...providerMetadata, experimentalAccepted: store?.experimentalAccepted === true, authenticated: Boolean(active), refreshRequired: Boolean(active && active.expiresAt <= now() + 60000),
      accounts: (store?.accounts || []).map(a => ({ accountId: a.id, active: a.id === store.activeAccount })) };
  }

  async function logout({ experimental, accountId, signal } = {}) {
    requireExperimental(experimental);
    if (accountId !== undefined && !/^[a-f0-9]{64}$/.test(accountId)) throw new ProviderError('CODEX_INPUT_INVALID');
    return locked(async () => {
      const store = await readStore();
      if (!store) return { ...providerMetadata, authenticated: false, removed: false };
      const id = accountId || store.activeAccount;
      const count = store.accounts.length;
      store.accounts = store.accounts.filter(a => a.id !== id); if (store.activeAccount === id) store.activeAccount = null;
      store.authEpoch++; await writeStore(store);
      return { ...providerMetadata, authenticated: Boolean(store.activeAccount), removed: count !== store.accounts.length, localOnly: true };
    }, signal);
  }

  async function getAccessToken({ experimental, signal } = {}) {
    requireExperimental(experimental);
    return locked(async () => {
      const store = await readStore(); const a = store?.accounts.find(a => a.id === store.activeAccount);
      if (!a) throw new ProviderError('CODEX_AUTH_REQUIRED');
      if (store.experimentalAccepted !== true) throw new ProviderError('CODEX_EXPERIMENTAL_REQUIRED');
      if (a.expiresAt > now() + 60000) return a.accessToken;
      const data = await request(CODEX_ENDPOINTS.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: a.refreshToken, resource: CODEX_ENDPOINTS.resource }) }, signal, true);
      const scopes = validateTokens(data, true);
      if (data.id_token) await verifyIdentity(data.id_token, a.clientId, undefined, a.subject, signal);
      a.accessToken = data.access_token; a.refreshToken = data.refresh_token; a.scopes = scopes; a.expiresAt = now() + data.expires_in * 1000;
      if (data.id_token) a.idToken = data.id_token;
      await writeStore(store); return a.accessToken;
    }, signal);
  }

  return Object.freeze({ login, status, logout, getAccessToken });
}
