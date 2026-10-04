import { open, mkdir, lstat, rename, unlink, chmod, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderError, cancelled } from './errors.mjs';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Shared state for BOTH `zuku` and `zukujs`: the existing ZukuJS roots
 * (~/.config/zukujs, %LOCALAPPDATA%\ZukuJS). Invocation name is never consulted.
 */
export function providerStateDir({ stateDir, home = homedir(), platform = process.platform, environment = process.env } = {}) {
  if (stateDir !== undefined) {
    if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new ProviderError('PROVIDER_CONFIG_UNSAFE');
    return stateDir;
  }
  if (platform === 'win32') {
    const base = environment.LOCALAPPDATA;
    if (typeof base !== 'string' || !isAbsolute(base)) throw new ProviderError('PROVIDER_CONFIG_UNSAFE');
    return join(base, 'ZukuJS', 'providers');
  }
  if (typeof home !== 'string' || !isAbsolute(home)) throw new ProviderError('PROVIDER_CONFIG_UNSAFE');
  return join(home, '.config', 'zukujs', 'providers');
}

function checkOwner(stat, { uid, platform }) {
  if (platform === 'win32' || typeof uid !== 'number') return true;
  return stat.uid === uid;
}

/** Create (0700) or verify a private directory owned by the current user; never follows a symlinked leaf. */
export async function ensurePrivateDir(dir, options = {}) {
  const { platform = process.platform, uid = process.getuid?.() } = options;
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  try { await mkdir(dir, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw new ProviderError('PROVIDER_CONFIG_UNSAFE'); }
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !checkOwner(stat, { uid, platform })) throw new ProviderError('PROVIDER_CONFIG_UNSAFE');
  if (platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    // Only our own provider directory is tightened; foreign-owned paths were rejected above.
    await chmod(dir, 0o700);
    if (((await lstat(dir)).mode & 0o077) !== 0) throw new ProviderError('PROVIDER_CONFIG_UNSAFE');
  }
  return dir;
}

/** Read a private regular file: no symlink/hardlink, owner-only, bounded. Missing => undefined. */
export async function readPrivateFile(file, { maxBytes = 262144, platform = process.platform, uid = process.getuid?.(), unsafeCode = 'PROVIDER_CONFIG_UNSAFE' } = {}) {
  let handle, before;
  try {
    if (platform === 'win32' || !NOFOLLOW) {
      before = await lstat(file);
      if (before.isSymbolicLink()) throw new ProviderError(unsafeCode);
    }
    handle = await open(file, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    // nlink 0: file was atomically replaced after open (benign, stale read); >1: hard link.
    if (!stat.isFile() || stat.nlink > 1 || stat.size > maxBytes || !checkOwner(stat, { uid, platform })) throw new ProviderError(unsafeCode);
    if (before && (before.ino !== stat.ino || before.dev !== stat.dev)) throw new ProviderError(unsafeCode);
    if (platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new ProviderError(unsafeCode);
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new ProviderError(unsafeCode);
    return buffer.subarray(0, size);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(unsafeCode);
  } finally { await handle?.close(); }
}

/** Atomic owner-only write: exclusive temp file (0600) + fsync + rename (+ dir fsync on POSIX). */
export async function writePrivateFile(file, data, { platform = process.platform } = {}) {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temp, file);
    if (platform !== 'win32') {
      let dir;
      try { dir = await open(dirname(file), constants.O_RDONLY); await dir.sync(); } catch { /* directory fsync is best-effort on some filesystems */ } finally { await dir?.close(); }
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('PROVIDER_CONFIG_UNSAFE');
  }
}

/**
 * Cross-process exclusive lock (O_EXCL lock file inside the private directory).
 * Bounded wait; stale locks (holder crashed) are broken after `staleMs`.
 */
export async function withLock(dir, fn, { signal, timeoutMs = 10000, staleMs = 30000 } = {}) {
  const lock = join(dir, '.lock');
  const nonce = randomBytes(12).toString('hex');
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw cancelled();
    let handle;
    try {
      handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
      await handle.writeFile(`${process.pid} ${nonce}\n`);
      await handle.close(); handle = undefined;
      break;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== 'EEXIST') throw new ProviderError('PROVIDER_CONFIG_UNSAFE');
      try {
        const stat = await lstat(lock);
        if (Date.now() - stat.mtimeMs > staleMs) {
          const stale = `${lock}.stale.${nonce}`;
          await rename(lock, stale).then(() => unlink(stale)).catch(() => {});
          continue;
        }
      } catch { continue; }
      if (Date.now() - started > timeoutMs) throw new ProviderError('PROVIDER_CONFIG_LOCKED');
      try { await delay(10 + Math.min(attempt, 10) * 5 + Math.floor(Math.random() * 10), undefined, { signal }); } catch { throw cancelled(); }
    }
  }
  try { return await fn(); }
  finally {
    try { if ((await readFile(lock, 'utf8')).includes(nonce)) await unlink(lock); } catch { /* lock already gone */ }
  }
}

export async function removePrivateFile(file) {
  try { await unlink(file); } catch (error) { if (error?.code !== 'ENOENT') throw new ProviderError('PROVIDER_CONFIG_UNSAFE'); }
}
