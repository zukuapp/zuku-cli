import { open, mkdir, lstat, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_BASE_URL } from '../api-client.mjs';
import { accountClient, canonicalGameScopes, ZUKU_CLIENT_ID, oauthAccessToken, oauthRefreshToken, readTokens } from './client.mjs';
import { AccountError } from './errors.mjs';
import { withPosixPrivateLock } from './private-lock.mjs';

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const baseKeys = ['version', 'client_id', 'api_base', 'generation', 'state'];
const tokenKeys = ['access_token', 'refresh_token', 'scope', 'expires_at'];
const generation = () => randomBytes(32).toString('hex');
const heldLocks = new AsyncLocalStorage();
function windowsPath(options = {}) {
  const base = options.home ? join(options.home, '.config', 'zukujs') : join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ZukuJS');
  if (!isAbsolute(base)) throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
  return join(base, 'account.dpapi');
}
function settings({ home = homedir(), uid = process.getuid?.() } = {}) {
  if (typeof home !== 'string' || !isAbsolute(home) || typeof uid !== 'number' || !constants.O_NOFOLLOW) throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
  return { home, uid, directory: join(home, '.config', 'zukujs') };
}
function tokenValue(v) { return exact(v, tokenKeys) && oauthAccessToken(v.access_token) && oauthRefreshToken(v.refresh_token) && v.scope === canonicalGameScopes(v.scope) && Number.isSafeInteger(v.expires_at) && v.expires_at > 0; }
function valid(v) {
  if (!record(v) || v.version !== 2 || v.client_id !== ZUKU_CLIENT_ID || v.api_base !== DEFAULT_BASE_URL || !/^[a-f0-9]{64}$/.test(v.generation ?? '')) return false;
  if (v.state === 'logged_out') return exact(v, baseKeys);
  if (v.state !== 'connected' || !exact(v, [...baseKeys, ...tokenKeys])) return false;
  return tokenValue(Object.fromEntries(tokenKeys.map(k => [k, v[k]])));
}
// Old own-store credentials are recognized only so a fresh explicit login can
// replace them. They are never transmitted to the canonical service.
function legacy(v) {
  return exact(v, ['version', 'client_id', 'api_base', ...tokenKeys]) && v.version === 1 && v.client_id === 'zukujs-cli' && v.api_base === DEFAULT_BASE_URL && /^zk_oat_[a-f0-9]{64}$/.test(v.access_token ?? '') && /^zk_ort_[a-f0-9]{64}$/.test(v.refresh_token ?? '') && v.scope === 'games:read games:write games:publish' && Number.isSafeInteger(v.expires_at);
}
async function directory(options, create = false) {
  const { home, uid, directory } = settings(options);
  for (const [path, mode] of [[home, undefined], [join(home, '.config'), 0o700], [directory, 0o700]]) {
    if (create && mode !== undefined) await mkdir(path, { mode }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const s = await lstat(path);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid || (s.mode & 0o022) !== 0 || (path === directory && (s.mode & 0o777) !== 0o700)) throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
  }
  return { home, uid, directory };
}
async function readRecord(options = {}) {
  let handle, raw;
  try {
    if (process.platform === 'win32') {
      // Missing OAuth state is not a credential read. Keep unauthenticated status
      // fast and avoid starting a protected peer until an own record exists.
      // Present records still require the peer's SID/path/link/DPAPI checks.
      await lstat(windowsPath(options));
      const { readProtectedStore } = await import('./windows-protected-store.mjs');
      raw = await readProtectedStore(windowsPath(options));
      if (raw === null) return undefined;
    } else {
      // Legacy upload users may have a 0755 ZukuJS directory but no OAuth record.
      // Absence is not a credential read: keep that existing upload path working.
      // A present OAuth record still requires every private-directory/file check.
      await lstat(join(settings(options).directory, 'account.json'));
      const { uid, directory: dir } = await directory(options);
      handle = await open(join(dir, 'account.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = await handle.stat();
      if (!s.isFile() || s.uid !== uid || (s.mode & 0o777) !== 0o600 || s.nlink !== 1 || s.size > 8192) throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
      const bytes = Buffer.alloc(8193); let length = 0;
      while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length); if (!bytesRead) break; length += bytesRead; }
      const after = await handle.stat();
      if (length > 8192 || s.size !== after.size || s.mtimeMs !== after.mtimeMs || length !== after.size) throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
      raw = bytes.subarray(0, length).toString('utf8');
    }
    if (Buffer.byteLength(raw) > 8192) throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
    let v; try { v = JSON.parse(raw); } catch { throw new AccountError('ZUKU_ACCOUNT_UNSAFE'); }
    if (valid(v)) return v;
    if (legacy(v)) return { state: 'legacy', generation: 'legacy:' + createHash('sha256').update(raw).digest('hex') };
    throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
  } catch (e) { if (e?.code === 'ENOENT') return undefined; if (e instanceof AccountError) throw e; throw new AccountError('ZUKU_ACCOUNT_UNSAFE'); }
  finally { await handle?.close().catch(() => {}); }
}
export async function loadZukuAccount(options = {}) {
  const value = await readRecord(options);
  if (value?.state === 'legacy') throw new AccountError('ZUKU_ACCOUNT_MIGRATION_REQUIRED');
  return value?.state === 'connected' ? value : undefined;
}
export async function captureZukuAccountGeneration(options = {}) { return (await readRecord(options))?.generation ?? null; }
async function writeRecord(value, options) {
  if (options.signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
  if (!valid(value)) throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
  if (process.platform === 'win32') {
    const { writeProtectedStore } = await import('./windows-protected-store.mjs');
    await writeProtectedStore(windowsPath(options), JSON.stringify(value)); return;
  }
  let temporary, handle;
  try {
    const { uid, directory: dir } = await directory(options, true); const target = join(dir, 'account.json');
    try { const s = await lstat(target); if (!s.isFile() || s.isSymbolicLink() || s.uid !== uid || s.nlink !== 1 || (s.mode & 0o777) !== 0o600) throw new AccountError('ZUKU_ACCOUNT_UNSAFE'); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    temporary = join(dir, `.account-${randomBytes(16).toString('hex')}`);
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = undefined;
    if (options.signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
    await rename(temporary, target); temporary = undefined;
    const parent = await open(dir, constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); }
  } catch (e) { if (e instanceof AccountError) throw e; throw new AccountError('ZUKU_ACCOUNT_UNSAFE'); }
  finally { await handle?.close().catch(() => {}); if (temporary) await unlink(temporary).catch(() => {}); }
}
async function withLock(operation, options = {}, refresh = false) {
  if (options.signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
  const path = process.platform === 'win32' ? windowsPath(options) + (refresh ? '.refresh' : '') : join((await directory(options, true)).directory, refresh ? '.account.refresh.lock' : '.account.lock');
  if (heldLocks.getStore()?.has(path)) return operation();
  const invoke = () => heldLocks.run(new Set([...(heldLocks.getStore() ?? []), path]), async () => { if (options.signal?.aborted) throw new AccountError('COMMAND_CANCELLED'); return operation(); });
  if (process.platform === 'win32') {
    const { withProtectedStoreLock } = await import('./windows-protected-store.mjs');
    return withProtectedStoreLock(path, invoke, { signal: options.signal, timeoutMs: options.timeoutMs });
  }
  return withPosixPrivateLock(path, invoke, options);
}
export const withZukuAccountLock = (operation, options = {}) => withLock(operation, options);
/** New login changes generation. Refresh can only update the captured generation. */
export async function saveZukuAccount(tokens, options = {}) {
  if (!tokenValue(tokens)) throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
  return withZukuAccountLock(async () => {
    const before = await readRecord(options);
    if (Object.hasOwn(options, 'expectedGeneration') && (before?.generation ?? null) !== options.expectedGeneration) throw new AccountError('ZUKU_ACCOUNT_CHANGED');
    const g = options.preserveGeneration === true ? before?.generation : generation();
    if (!g || before?.state === 'legacy' && options.preserveGeneration === true) throw new AccountError('ZUKU_ACCOUNT_CHANGED');
    await writeRecord({ version: 2, client_id: ZUKU_CLIENT_ID, api_base: DEFAULT_BASE_URL, generation: g, state: 'connected', ...tokens }, options);
  }, options);
}
/** A separate refresh lease serializes rotation, while logout remains available. */
export async function readZukuAccessToken(options = {}) {
  if (options.signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
  const now = options.now ?? Date.now; const factory = options.accountClientFactory ?? accountClient;
  const account = await loadZukuAccount(options);
  if (!account) return undefined;
  if (account.expires_at > now() + 30000) return account.access_token;
  return withLock(async () => {
    const current = await loadZukuAccount(options);
    if (!current || current.generation !== account.generation) throw new AccountError('ZUKU_ACCOUNT_CHANGED');
    if (current.expires_at > now() + 30000) return current.access_token;
    const client = await factory(options.baseUrl ?? DEFAULT_BASE_URL, { signal: options.signal });
    if (options.signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
    let tokens;
    try { tokens = readTokens(await client.refresh(current.refresh_token), now(), current.scope); }
    catch (error) {
      // A lost rotating-refresh response cannot safely be replayed. Retire
      // only this generation; a concurrent new login is never overwritten.
      await withZukuAccountLock(async () => {
        const latest = await readRecord(options);
        if (latest?.generation === current.generation) await writeRecord({ version: 2, client_id: ZUKU_CLIENT_ID, api_base: DEFAULT_BASE_URL, generation: generation(), state: 'logged_out' }, { ...options, signal: undefined });
      }, { ...options, signal: undefined });
      throw new AccountError(options.signal?.aborted ? 'COMMAND_CANCELLED' : 'ZUKU_ACCOUNT_EXPIRED');
    }
    await saveZukuAccount(tokens, { ...options, expectedGeneration: current.generation, preserveGeneration: true });
    return tokens.access_token;
  }, options, true);
}
/** Durable token-free tombstones prevent delayed refresh/login from resurrecting logout. */
export async function removeZukuAccount(options = {}) {
  return withZukuAccountLock(async () => {
    await readRecord(options);
    await writeRecord({ version: 2, client_id: ZUKU_CLIENT_ID, api_base: DEFAULT_BASE_URL, generation: generation(), state: 'logged_out' }, options);
  }, options);
}
