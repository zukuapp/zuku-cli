import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CommandError } from './errors.mjs';

export const validAccessToken = token => typeof token === 'string' && /^[A-Za-z0-9._~+/=-]{1,8192}$/.test(token);

/** Read user-owned credentials only; no service keys, writes, refresh or cookie storage. */
export async function readAccessToken({ environment = process.env, home = homedir(), uid = process.getuid?.() } = {}) {
  if (Object.hasOwn(environment, 'ZUKU_ACCESS_TOKEN')) {
    if (!validAccessToken(environment.ZUKU_ACCESS_TOKEN)) throw new CommandError('CREDENTIALS_INVALID');
    return environment.ZUKU_ACCESS_TOKEN;
  }
  const file = environment.ZUKU_CREDENTIALS_FILE ?? join(home, '.config', 'zuku', 'credentials.json');
  if (typeof uid !== 'number' || !constants.O_NOFOLLOW) {
    if (environment.ZUKU_CREDENTIALS_FILE === undefined) return undefined;
    throw new CommandError('CREDENTIALS_UNSAFE');
  }
  if (typeof file !== 'string' || !isAbsolute(file)) throw new CommandError('CREDENTIALS_UNSAFE');
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 16384) throw new CommandError('CREDENTIALS_UNSAFE');
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw new CommandError('CREDENTIALS_UNSAFE');
    let data;
    try { data = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); } catch { throw new CommandError('CREDENTIALS_INVALID'); }
    if (!data || Array.isArray(data) || Object.keys(data).length !== 1 || !validAccessToken(data.access_token)) throw new CommandError('CREDENTIALS_INVALID');
    return data.access_token;
  } catch (error) {
    if (error?.code === 'ENOENT' && environment.ZUKU_CREDENTIALS_FILE === undefined) return undefined;
    if (error instanceof CommandError) throw error;
    throw new CommandError('CREDENTIALS_UNSAFE');
  } finally { await handle?.close(); }
}
