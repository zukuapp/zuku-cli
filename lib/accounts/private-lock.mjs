import { open, lstat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { AccountError } from './errors.mjs';
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function safe(s) { if (!s.isFile() || s.nlink !== 1 || s.size > 1024 || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600) throw new AccountError('ZUKU_ACCOUNT_UNSAFE'); }
const dead = pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
/** Reclaim only an owned lock left by a dead process on this same host. */
export async function withPosixPrivateLock(path, operation, { signal } = {}) {
  if (!constants.O_NOFOLLOW || !process.getuid) throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || parent.mode & 0o022) throw new AccountError('ZUKU_ACCOUNT_UNSAFE');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
    let handle, owned;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() })); await handle.sync(); owned = await handle.stat(); safe(owned);
      if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
      return await operation();
    } catch (e) {
      if (e?.code !== 'EEXIST' || handle) throw e;
    } finally {
      if (handle) { await handle.close().catch(() => {}); try { const now = await lstat(path); safe(now); if (owned && same(owned, now)) await unlink(path); } catch { /* Never unlink a replacement lock. */ } }
    }
    let reader, s, holder;
    try {
      reader = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); s = await reader.stat(); safe(s);
      const bytes = Buffer.alloc(1025); const { bytesRead } = await reader.read(bytes, 0, bytes.length, 0); if (bytesRead > 1024 || bytesRead !== s.size) throw new AccountError('ZUKU_ACCOUNT_BUSY');
      holder = JSON.parse(bytes.subarray(0, bytesRead).toString());
    } catch { throw new AccountError('ZUKU_ACCOUNT_BUSY'); }
    finally { await reader?.close().catch(() => {}); }
    if (attempt || holder?.host !== hostname() || !Number.isSafeInteger(holder.pid) || holder.pid < 1 || holder.pid === process.pid || !dead(holder.pid)) throw new AccountError('ZUKU_ACCOUNT_BUSY');
    const current = await lstat(path); safe(current); if (!same(s, current)) throw new AccountError('ZUKU_ACCOUNT_BUSY');
    await unlink(path);
  }
  throw new AccountError('ZUKU_ACCOUNT_BUSY');
}
