import { constants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { ProtocolError } from '../agent-protocol/index.mjs';

const MAX_BINARY = 512 * 1024 * 1024;
const fail = code => { throw new ProtocolError(code); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const trustedOwner = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid() || stat.uid === 0;
const binaryHeader = bytes => process.platform === 'win32' ? bytes[0] === 0x4d && bytes[1] === 0x5a
  : process.platform === 'darwin' ? ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(bytes.subarray(0, 4).toString('hex'))
  : bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));

/** Native consent binds one regular executable's bytes and identity, never shell/argv/env. */
async function fingerprint(localPath) {
  if (typeof localPath !== 'string' || !isAbsolute(localPath) || localPath.length > 1024 || /[\x00-\x1f\x7f]/.test(localPath)) fail('BROWSER_EXECUTABLE_UNSAFE');
  const path = resolve(localPath); let current = parse(path).root, handle;
  try {
    const parts = path.slice(current.length).split(/[\\/]/).filter(Boolean);
    for (const part of parts.slice(0, -1)) {
      current = join(current, part); const stat = await lstat(current);
      const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
      if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedOwner(stat) || process.platform !== 'win32' && (stat.mode & 0o022) && !stickyRoot) fail('BROWSER_EXECUTABLE_UNSAFE');
    }
    const before = await lstat(path);
    const safeFile = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size >= 4 && stat.size <= MAX_BINARY && trustedOwner(stat) && (process.platform === 'win32' || (stat.mode & 0o022) === 0);
    if (!safeFile(before)) fail('BROWSER_EXECUTABLE_UNSAFE');
    const canonical = await realpath(path);
    if (process.platform !== 'win32' && canonical !== path) fail('BROWSER_EXECUTABLE_UNSAFE');
    await access(canonical, constants.X_OK);
    handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat(); if (!safeFile(opened) || !same(opened, before)) fail('BROWSER_EXECUTABLE_UNSAFE');
    const buffer = Buffer.alloc(64 * 1024), digest = createHash('sha256'); let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      if (!offset && !binaryHeader(buffer.subarray(0, bytesRead))) fail('BROWSER_EXECUTABLE_UNSAFE');
      offset += bytesRead; if (offset > MAX_BINARY) fail('BROWSER_EXECUTABLE_UNSAFE');
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat(), final = await lstat(canonical);
    if (!safeFile(after) || !safeFile(final) || !same(opened, after) || !same(after, final) || offset !== after.size || await realpath(path) !== canonical) fail('BROWSER_EXECUTABLE_UNSAFE');
    return { path: canonical, dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, sha256: digest.digest('hex') };
  } catch (error) { throw error instanceof ProtocolError ? error : new ProtocolError('BROWSER_EXECUTABLE_UNSAFE'); }
  finally { await handle?.close(); }
}

export async function createBrowserRegistry({ storage, projects }) {
  const saved = await storage.readJSON('browsers', 512 * 1024) ?? { schema: 'zuku-browser-registry/1', browsers: [] };
  if (saved.schema !== 'zuku-browser-registry/1' || !Array.isArray(saved.browsers) || saved.browsers.length > 32) fail('CORE_STATE_UNSAFE');
  const entries = new Map();
  for (const entry of saved.browsers) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.projectHandle !== 'string' || typeof entry.sha256 !== 'string' || Object.keys(entry).some(key => !['id', 'projectHandle', 'path', 'dev', 'ino', 'size', 'mtimeMs', 'sha256'].includes(key)) || !/^browser_[a-f0-9]{32}$/.test(entry.id) || !/^project_[a-f0-9]{32}$/.test(entry.projectHandle) || typeof entry.path !== 'string' || !isAbsolute(entry.path) || ![entry.dev, entry.ino, entry.size].every(Number.isSafeInteger) || entry.size < 4 || entry.size > MAX_BINARY || !Number.isFinite(entry.mtimeMs) || !/^[a-f0-9]{64}$/.test(entry.sha256) || entries.has(entry.id)) fail('CORE_STATE_UNSAFE');
    entries.set(entry.id, entry);
  }
  const save = () => storage.writeJSON('browsers', { schema: saved.schema, browsers: [...entries.values()] });
  const view = entry => ({ browserHandle: entry.id, projectHandle: entry.projectHandle, sha256: entry.sha256 });
  return Object.freeze({
    async grant({ projectHandle, localPath }, actor) {
      if (actor.kind !== 'native') fail('NATIVE_PERMISSION_REQUIRED');
      await projects.get(projectHandle, actor);
      const identity = await fingerprint(localPath); await projects.get(projectHandle, actor);
      const existing = [...entries.values()].find(entry => entry.projectHandle === projectHandle && entry.path === identity.path && same(entry, identity) && entry.sha256 === identity.sha256);
      if (existing) return view(existing);
      const superseded = [...entries.values()].filter(entry => entry.projectHandle === projectHandle && entry.path === identity.path);
      if (entries.size - superseded.length >= 32) fail('BROWSER_GRANT_LIMIT');
      for (const entry of superseded) entries.delete(entry.id);
      const entry = { id: `browser_${randomBytes(16).toString('hex')}`, projectHandle, ...identity };
      entries.set(entry.id, entry);
      try { await save(); } catch (error) { entries.delete(entry.id); for (const previous of superseded) entries.set(previous.id, previous); throw error; }
      return view(entry);
    },
    async get(browserHandle, projectHandle, actor) {
      if (actor.kind !== 'native') fail('NATIVE_PERMISSION_REQUIRED');
      const entry = entries.get(browserHandle); if (!entry) fail('BROWSER_GRANT_NOT_FOUND');
      if (entry.projectHandle !== projectHandle) fail('PERMISSION_REQUIRED');
      await projects.get(projectHandle, actor);
      const current = await fingerprint(entry.path).catch(() => fail('BROWSER_EXECUTABLE_CHANGED'));
      if (!same(current, entry) || current.sha256 !== entry.sha256) fail('BROWSER_EXECUTABLE_CHANGED');
      return { ...entry };
    },
  });
}
