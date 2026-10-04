import { constants } from 'node:fs';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { prepareReceiptDir } from '../upload-receipt.mjs';
import { checkedBase, validDeploymentKey } from './client.mjs';
import { AccountError } from './errors.mjs';
import { withPosixPrivateLock } from './private-lock.mjs';

export const newDeploymentKey = () => `zuku-cli.${randomBytes(24).toString('hex')}`;
const keys = ['schema', 'api_base', 'owner_id', 'idempotency_key', 'package_sha256', 'size_bytes', 'content_id', 'state', 'created_at'];
export function validOperation(v) {
  return v && typeof v === 'object' && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)) && v.schema === 'zukujs-deployment/2' && typeof v.api_base === 'string' && /^usr_[1-9][0-9]*$/.test(v.owner_id) && validDeploymentKey(v.idempotency_key) && /^[a-f0-9]{64}$/.test(v.package_sha256) && Number.isSafeInteger(v.size_bytes) && v.size_bytes > 0 && v.size_bytes <= 100 * 1024 * 1024 && (v.content_id === null || /^cnt_[A-Za-z0-9_-]{1,128}$/.test(v.content_id)) && ['prepared', 'draft', 'publishing', 'published', 'rejected', 'unknown'].includes(v.state) && typeof v.created_at === 'string' && Number.isFinite(Date.parse(v.created_at));
}
const filename = dir => join(dir, process.platform === 'win32' ? 'deploy-operation.dpapi' : 'deploy-operation.json');
function fileSafe(s) { if (!s.isFile() || s.nlink !== 1 || s.size > 16384 || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600) throw new AccountError('DEPLOY_RECEIPT_UNSAFE'); }
export async function loadDeploymentOperation(dir, context = {}) {
  const safe = await prepareReceiptDir(dir, { cwd: context.cwd });
  let raw, handle;
  try {
    if (process.platform === 'win32') { const { readProtectedStore } = await import('./windows-protected-store.mjs'); raw = await readProtectedStore(filename(safe)); if (raw === null) return undefined; }
    else {
      handle = await open(filename(safe), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat(); fileSafe(before);
      const bytes = Buffer.alloc(16385); let length = 0;
      while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length); if (!bytesRead) break; length += bytesRead; }
      const after = await handle.stat(); fileSafe(after);
      if (length !== after.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new AccountError('DEPLOY_RECEIPT_UNSAFE');
      raw = bytes.subarray(0, length).toString('utf8');
    }
    if (Buffer.byteLength(raw) > 16384) throw new AccountError('DEPLOY_RECEIPT_UNSAFE');
    let v; try { v = JSON.parse(raw); } catch { throw new AccountError('DEPLOY_RECEIPT_UNSAFE'); }
    if (!validOperation(v) || checkedBase(v.api_base, context.allowFixtureOrigin) !== v.api_base) throw new AccountError('DEPLOY_RECEIPT_UNSAFE');
    return v;
  } catch (e) { if (e?.code === 'ENOENT') return undefined; if (e instanceof AccountError) throw e; throw new AccountError('DEPLOY_RECEIPT_UNSAFE'); }
  finally { await handle?.close().catch(() => {}); }
}
export async function saveDeploymentOperation(dir, value, context = {}) {
  if (!validOperation(value)) throw new AccountError('DEPLOY_RECEIPT_UNSAFE');
  const safe = await prepareReceiptDir(dir, { cwd: context.cwd });
  if (process.platform === 'win32') { const { writeProtectedStore } = await import('./windows-protected-store.mjs'); await writeProtectedStore(filename(safe), JSON.stringify(value)); return; }
  let temporary, handle;
  try {
    try { fileSafe(await lstat(filename(safe))); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    temporary = join(safe, `.deployment-${randomBytes(16).toString('hex')}`);
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, filename(safe)); temporary = undefined;
    const parent = await open(safe, constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); }
  } catch (e) { if (e instanceof AccountError) throw e; throw new AccountError('DEPLOY_RECEIPT_UNSAFE'); }
  finally { await handle?.close().catch(() => {}); if (temporary) await unlink(temporary).catch(() => {}); }
}
export async function withDeploymentLock(dir, operation, context = {}) {
  if (context.signal?.aborted) throw new AccountError('COMMAND_CANCELLED', { definite: true });
  const safe = await prepareReceiptDir(dir, { cwd: context.cwd });
  if (process.platform === 'win32') { const { withProtectedStoreLock } = await import('./windows-protected-store.mjs'); return withProtectedStoreLock(filename(safe), operation, { signal: context.signal }); }
  return withPosixPrivateLock(resolve(safe, '.deployment.lock'), operation, context);
}
