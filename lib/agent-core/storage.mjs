import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve, parse } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { providerStateDir } from '../provider-system/fs-safe.mjs';
import { ProtocolError } from '../agent-protocol/index.mjs';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unsafe = () => { throw new ProtocolError('CORE_STATE_UNSAFE'); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

export function coreStateDir(context = {}) {
  if (context.stateDir !== undefined) {
    if (typeof context.stateDir !== 'string' || !parse(context.stateDir).root) unsafe();
    return resolve(context.stateDir);
  }
  return join(dirname(providerStateDir(context)), 'core');
}
async function checkParents(path, platform) {
  const target = resolve(path); let current = parse(target).root;
  for (const part of target.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
  }
  if (platform !== 'win32' && await realpath(target) !== target) unsafe();
}
/** Private directories/files are rechecked around each I/O, including ancestor identities. */
export async function createCoreStorage(context = {}) {
  const dir = coreStateDir(context), platform = context.platform ?? process.platform, uid = process.getuid?.();
  let protection;
  if (platform === 'win32') {
    const backend = context.protectedStore ?? await import('../accounts/windows-protected-store.mjs');
    const methods = ['readProtectedStore', 'writeProtectedStore', 'removeProtectedStore'];
    if (!methods.every(key => typeof backend[key] === 'function')) unsafe();
    // Core state failures have one transport-independent safe code. The account
    // peer's private diagnostic metadata must not become a Core protocol error.
    protection = Object.fromEntries(methods.map(key => [key, async (...args) => {
      try { return await backend[key](...args); }
      catch { unsafe(); }
    }]));
  } else if (typeof uid !== 'number' || !NOFOLLOW) unsafe();
  const ensure = async target => {
    const parent = dirname(target);
    try { await checkParents(parent, platform); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await ensure(parent); await checkParents(parent, platform);
    }
    if (protection) {
      // The existing helper creates/checks a SID-only protected directory and encrypted file.
      await protection.writeProtectedStore(join(target, 'directory.dpapi'), 'zuku-agent-core/1');
    } else {
      try { await mkdir(target, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') unsafe(); }
      const stat = await lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) unsafe();
    }
    await checkParents(target, platform);
    return target;
  };
  await ensure(dir); await ensure(join(dir, 'journals'));
  const guard = async target => {
    await checkParents(dirname(target), platform);
    const root = await lstat(dir), parent = await lstat(dirname(target));
    if (root.isSymbolicLink() || parent.isSymbolicLink() || !root.isDirectory() || !parent.isDirectory()) unsafe();
    if (!protection && (root.uid !== uid || parent.uid !== uid || (root.mode & 0o077) || (parent.mode & 0o077))) unsafe();
    if (protection) {
      if (await protection.readProtectedStore(join(dir, 'directory.dpapi')) !== 'zuku-agent-core/1') unsafe();
      if (dirname(target) !== dir && await protection.readProtectedStore(join(dirname(target), 'directory.dpapi')) !== 'zuku-agent-core/1') unsafe();
    }
    return { root, parent };
  };
  const verify = async (target, before) => {
    const after = await guard(target);
    if (!identity(before.root, after.root) || !identity(before.parent, after.parent)) unsafe();
  };
  const file = stat => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !protection && (stat.uid !== uid || (stat.mode & 0o077))) unsafe();
  };
  const read = async (target, maxBytes = 2 * 1024 * 1024) => {
    const before = await guard(target);
    if (protection) {
      const value = await protection.readProtectedStore(target);
      await verify(target, before);
      if (value === null) return undefined;
      if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) unsafe();
      return value;
    }
    let handle;
    try {
      const expected = await lstat(target); file(expected);
      handle = await open(target, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
      const stat = await handle.stat(); file(stat);
      if (!identity(stat, expected) || stat.size > maxBytes) unsafe();
      const output = Buffer.alloc(maxBytes + 1); let count = 0;
      while (count < output.length) {
        const { bytesRead } = await handle.read(output, count, output.length - count, count);
        if (!bytesRead) break; count += bytesRead;
      }
      const after = await handle.stat(); file(after);
      if (count > maxBytes || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || count !== after.size) unsafe();
      await verify(target, before); const current = await lstat(target); file(current);
      if (!identity(current, after)) unsafe();
      return new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, count));
    } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error instanceof ProtocolError ? error : new ProtocolError('CORE_STATE_UNSAFE'); }
    finally { await handle?.close().catch(() => {}); }
  };
  const write = async (target, text) => {
    const before = await guard(target);
    if (protection) { await protection.writeProtectedStore(target, text); await verify(target, before); return; }
    const temp = `${target}.${randomBytes(12).toString('hex')}.tmp`; let handle;
    try {
      const existing = await lstat(target).catch(error => { if (error?.code !== 'ENOENT') throw error; });
      if (existing) file(existing);
      handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
      await handle.writeFile(text); await handle.sync(); await handle.close(); handle = undefined;
      await verify(target, before);
      const current = await lstat(target).catch(error => { if (error?.code !== 'ENOENT') throw error; });
      if (current) { file(current); if (!existing || !identity(current, existing)) unsafe(); }
      await rename(temp, target);
      let parent;
      try { parent = await open(dirname(target), constants.O_RDONLY | NOFOLLOW); await parent.sync(); } finally { await parent?.close(); }
      await verify(target, before);
    } catch (error) { throw error instanceof ProtocolError ? error : new ProtocolError('CORE_STATE_UNSAFE'); }
    finally { await handle?.close().catch(() => {}); await unlink(temp).catch(() => {}); }
  };
  const getPath = (scope, value) => {
    if (!name(value) || !['state', 'journal'].includes(scope)) unsafe();
    return join(scope === 'journal' ? join(dir, 'journals') : dir, `${value}.${protection ? 'dpapi' : scope === 'journal' ? 'ndjson' : 'json'}`);
  };
  return Object.freeze({
    dir, platform, windowsProtected: Boolean(protection), guard,
    async read(scope, value, maxBytes) { return read(getPath(scope, value), maxBytes); },
    async write(scope, value, text) { return write(getPath(scope, value), text); },
    async appendJournal(value, text, maxBytes) {
      const target = getPath('journal', value);
      if (protection) { const existing = await read(target, maxBytes) ?? ''; return write(target, existing + text); }
      const before = await guard(target); let handle;
      try {
        const previous = await lstat(target).catch(error => { if (error?.code !== 'ENOENT') throw error; }); if (previous) file(previous);
        handle = await open(target, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | NOFOLLOW, 0o600);
        const stat = await handle.stat(); file(stat);
        if (previous && !identity(stat, previous) || stat.size + Buffer.byteLength(text) > maxBytes) unsafe();
        await handle.writeFile(text); await handle.sync();
        const after = await handle.stat(); file(after);
        if (after.size !== stat.size + Buffer.byteLength(text)) unsafe();
        await verify(target, before); const current = await lstat(target); file(current); if (!identity(current, after)) unsafe();
      } catch (error) { throw error instanceof ProtocolError ? error : new ProtocolError('CORE_STATE_UNSAFE'); }
      finally { await handle?.close().catch(() => {}); }
    },
    async readJSON(value, maxBytes) { const text = await read(getPath('state', value), maxBytes); if (text === undefined) return undefined; try { return JSON.parse(text); } catch { unsafe(); } },
    async writeJSON(value, data) { return write(getPath('state', value), JSON.stringify(data) + '\n'); },
    async remove(scope, value) { const target = getPath(scope, value); await guard(target); if (protection) await protection.removeProtectedStore(target); else { const stat = await lstat(target).catch(() => undefined); if (stat) { file(stat); await unlink(target); } } },
    async listJournals() { await guard(join(dir, 'journals', 'placeholder')); return (await readdir(join(dir, 'journals'))).filter(entry => /^ses_[a-f0-9]{32}\.(?:ndjson|dpapi)$/.test(entry)).map(entry => entry.split('.')[0]); },
    async acquireOwner() {
      const lock = join(dir, 'host.lock'), nonce = randomBytes(16).toString('hex'); let held;
      for (let attempt = 0; attempt < 2; attempt++) {
        await guard(lock);
        let handle;
        try {
          handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
          await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, host: hostname() }) + '\n'); await handle.sync(); held = await handle.stat(); await handle.close();
          break;
        } catch (error) {
          await handle?.close().catch(() => {});
          if (error?.code !== 'EEXIST') unsafe();
          // Windows inherits the already verified SID-only directory ACL. Lock has no secret.
          const stat = await lstat(lock); file(stat);
          let existing; const h = await open(lock, constants.O_RDONLY | NOFOLLOW);
          try { const raw = await h.readFile('utf8'); if (Buffer.byteLength(raw) > 4096) unsafe(); existing = JSON.parse(raw); } finally { await h.close(); }
          if (attempt || existing.host !== hostname() || !Number.isSafeInteger(existing.pid) || existing.pid < 1 || alive(existing.pid)) throw new ProtocolError('CORE_ALREADY_RUNNING');
          const current = await lstat(lock); if (!identity(current, stat)) unsafe(); await unlink(lock);
        }
      }
      if (!held) unsafe();
      return async () => {
        const current = await lstat(lock).catch(() => undefined);
        if (current && identity(current, held)) { await guard(lock); await unlink(lock); }
      };
    },
  });
}
