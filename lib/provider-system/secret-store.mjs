import { join } from 'node:path';
import { ProviderError } from './errors.mjs';
import { validProviderId } from './address.mjs';
import { validateHeaderName, validHeaderValue } from './endpoint.mjs';
import { ensurePrivateDir, readPrivateFile, writePrivateFile, withLock } from './fs-safe.mjs';
import { CommandError } from '../errors.mjs';

const MAX_SECRET_FILE = 131072;
export const validSecret = value => typeof value === 'string' && /^[\x21-\x7e]{1,16384}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new ProviderError('SECRET_STORE_UNSAFE'); };

/**
 * Windows protection is delegated to the existing CurrentUser DPAPI + SID ACL
 * module's FILE API, which also owns ACL/link defenses and atomic writes.
 * Missing => fail closed (no plaintext fallback on Windows).
 */
export async function loadWindowsProtectedStore(importer = () => import('../accounts/windows-protected-store.mjs')) {
  let mod;
  try { mod = await importer(); } catch { throw new ProviderError('SECRET_STORE_UNAVAILABLE'); }
  for (const name of ['readProtectedStore', 'writeProtectedStore', 'withProtectedStoreLock']) {
    if (typeof mod?.[name] !== 'function') throw new ProviderError('SECRET_STORE_UNAVAILABLE');
  }
  return mod;
}

function normalize(raw) {
  if (!record(raw) || raw.version !== 1 || !record(raw.providers)) invalid();
  const providers = {};
  for (const [id, entry] of Object.entries(raw.providers)) {
    if (!validProviderId(id) || !record(entry)) invalid();
    const out = {};
    if (entry.apiKey !== undefined) { if (!validSecret(entry.apiKey)) invalid(); out.apiKey = entry.apiKey; }
    if (entry.headers !== undefined) {
      if (!record(entry.headers)) invalid();
      out.headers = {};
      for (const [name, value] of Object.entries(entry.headers)) { validateHeaderName(name); if (!validHeaderValue(value)) invalid(); out.headers[name] = value; }
    }
    if (Object.keys(out).length) providers[id] = out;
  }
  return { version: 1, providers };
}

/** Provider secrets, separate from public config. POSIX: 0600 file in a 0700 dir. Windows: DPAPI blob. */
export class SecretStore {
  #protectedStore;
  constructor({ dir, platform = process.platform, uid = process.getuid?.(), protectedStore }) {
    this.dir = dir; this.platform = platform; this.uid = uid;
    this.#protectedStore = protectedStore;
    this.file = join(dir, platform === 'win32' ? 'secrets.dpapi' : 'secrets.json');
  }
  async #protection() {
    if (this.platform !== 'win32') return undefined;
    if (!this.#protectedStore) this.#protectedStore = await loadWindowsProtectedStore();
    return this.#protectedStore;
  }
  async #read() {
    const protection = await this.#protection();
    if (this.platform !== 'win32' && typeof this.uid !== 'number') throw new ProviderError('SECRET_STORE_UNAVAILABLE');
    let bytes;
    try {
      if (protection) {
        const text = await protection.readProtectedStore(this.file);
        if (text === null) return { version: 1, providers: {} };
        if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SECRET_FILE) invalid();
        bytes = Buffer.from(text, 'utf8');
      } else bytes = await readPrivateFile(this.file, { maxBytes: MAX_SECRET_FILE, platform: this.platform, uid: this.uid, unsafeCode: 'SECRET_STORE_UNSAFE' });
    } catch (error) { if (error instanceof ProviderError) throw error; invalid(); }
    if (!bytes) return { version: 1, providers: {} };
    let plain;
    plain = bytes;
    try { return normalize(JSON.parse(plain.toString('utf8'))); } catch (error) { if (error instanceof ProviderError) throw error; invalid(); }
    finally { if (protection) plain?.fill(0); }
  }
  async #write(data) {
    const protection = await this.#protection();
    const plain = Buffer.from(JSON.stringify(normalize(data)), 'utf8');
    try {
      if (plain.length > MAX_SECRET_FILE) invalid();
      if (protection) await protection.writeProtectedStore(this.file, plain.toString('utf8'));
      else await writePrivateFile(this.file, plain, { platform: this.platform });
    } catch (error) { if (error instanceof ProviderError) throw error; invalid(); }
    finally { plain.fill(0); }
  }
  async get(id) { return (await this.#read()).providers[id]; }
  /** Status only: presence flags and header NAMES, never values. */
  async status() {
    const data = await this.#read();
    return Object.fromEntries(Object.entries(data.providers).map(([id, entry]) => [id, { apiKey: Boolean(entry.apiKey), headers: Object.keys(entry.headers ?? {}) }]));
  }
  async update(id, patch, { signal } = {}) {
    if (!validProviderId(id) || !record(patch)) throw new ProviderError('PROVIDER_CONFIG_INVALID');
    if (patch.apiKey !== undefined && patch.apiKey !== null && !validSecret(patch.apiKey)) throw new ProviderError('AUTH_SECRET_INVALID');
    const operation = async () => {
      const data = await this.#read();
      const entry = patch.clear === true ? {} : { ...(data.providers[id] ?? {}) };
      if (patch.apiKey === null) delete entry.apiKey; else if (patch.apiKey !== undefined) entry.apiKey = patch.apiKey;
      if (patch.headers) {
        entry.headers = { ...(entry.headers ?? {}) };
        for (const [name, value] of Object.entries(patch.headers)) {
          validateHeaderName(name);
          if (value === null) delete entry.headers[name];
          else if (!validHeaderValue(value)) throw new ProviderError('AUTH_SECRET_INVALID');
          else entry.headers[name] = value;
        }
        if (!Object.keys(entry.headers).length) delete entry.headers;
      }
      if (Object.keys(entry).length) data.providers[id] = entry; else delete data.providers[id];
      await this.#write(data);
    };
    if (this.platform === 'win32') {
      const protection = await this.#protection();
      try { return await protection.withProtectedStoreLock(this.file, operation, { signal }); }
      catch (error) {
        if (signal?.aborted || error?.code === 'COMMAND_CANCELLED') throw new CommandError('COMMAND_CANCELLED');
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(error?.code === 'ZUKU_ACCOUNT_BUSY' ? 'PROVIDER_CONFIG_LOCKED' : 'SECRET_STORE_UNSAFE');
      }
    }
    await ensurePrivateDir(this.dir, { platform: this.platform, uid: this.uid });
    return withLock(this.dir, operation, { signal });
  }
  async remove(id, options) { return this.update(id, { clear: true }, options); }
}
