import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, join, sep } from 'node:path';
import { ScopeError } from './errors.mjs';

export const PATH_LIMITS = Object.freeze({ chars: 512, segments: 16, readBytes: 4 * 1024 * 1024, writeBytes: 256 * 1024 });
const OPEN_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// Never readable or writable by a model, whatever the provider: dot entries (.git, .env*,
// .zukujs agent state/receipts, .ssh, .npmrc, .config, .codex ...), key material,
// credential/provider stores and dependency trees. Matching is case-insensitive.
const PRIVATE_NAME = /^(?:node_modules|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials?(?:\..*)?|secrets?(?:\..*)?|auth\.json|tokens?\.json|providers?\.json|provider[-_]?(?:keys|auth|config)(?:\..*)?|keys?\.json|service[-_]account.*\.json|npmrc|netrc|pgpass|htpasswd|keychain.*|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|der|crt|cer|ovpn|env))$/i;
const WRITE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.json', '.css', '.html', '.htm', '.glsl', '.vert', '.frag', '.wgsl', '.wat', '.c', '.h', '.cc', '.cpp', '.hpp', '.rs', '.zig', '.md', '.txt', '.svg', '.csv', '.tsv', '.xml', '.toml', '.yml', '.yaml']);
const TRUSTED_DIRS = ['src', 'source', 'assets', 'shaders', 'tests', 'test', 'scripts', 'native', 'wasm', 'types', 'lib', 'packages', 'examples'];
const ROOT_FILES = /^(?:zukujs\.json|package\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|jsconfig\.json|(?:vite|rollup|esbuild|webpack)\.config\.(?:js|mjs|cjs|ts)|cargo\.toml|readme\.md|changelog\.md)$/i;
const LOCKFILES = /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|cargo\.lock)$/i;
const OUTPUT_DIRS = new Set(['dist', 'build', 'out', 'coverage']);

export const deny = () => { throw new ScopeError('SCOPE_PATH_DENIED'); };

/** Syntactic check of a model-supplied project-relative path. Returns its segments. */
export function splitRelative(path) {
  if (typeof path !== 'string' || !path || path.length > PATH_LIMITS.chars || /[\\\x00-\x1f\x7f:]/.test(path) || path.startsWith('/') || path.endsWith('/')) deny();
  const parts = path.split('/');
  if (parts.length > PATH_LIMITS.segments || parts.some(part => !part || part === '.' || part === '..' || part.length > 255)) deny();
  return parts;
}

/** Private paths: never read, written, searched, copied into a sandbox or shown to a model. */
export const isPrivate = parts => parts.some(part => part.startsWith('.') || PRIVATE_NAME.test(part));

/** Write admission by purpose: trusted source/config locations and game-relevant file types. */
export function writable(parts, manifest) {
  const name = parts.at(-1);
  if (LOCKFILES.test(name) || OUTPUT_DIRS.has(parts[0].toLowerCase())) return false;
  if (parts.length === 1) return ROOT_FILES.test(name);
  const trusted = TRUSTED_DIRS.includes(parts[0]) || (manifest?.source && parts[0] === manifest.source);
  return trusted && WRITE_EXT.has(extname(name).toLowerCase());
}

/** Project root pinned by dev/ino; every resolution re-checks it (no root rebinding). */
export class ProjectRoot {
  constructor(root, identity) { this.root = root; this.identity = identity; }
  static async open(path, expected) {
    let root, stat;
    try { root = await realpath(path); stat = await lstat(root); } catch { throw new ScopeError('SCOPE_WORKSPACE_UNSAFE'); }
    if (!stat.isDirectory() || (expected && (expected.dev !== stat.dev || expected.ino !== stat.ino))) throw new ScopeError('SCOPE_WORKSPACE_UNSAFE');
    return new ProjectRoot(root, { dev: stat.dev, ino: stat.ino });
  }
  async assertRoot() {
    const stat = await lstat(this.root).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) throw new ScopeError('SCOPE_WORKSPACE_UNSAFE');
  }
  /**
   * Resolves a relative path with an lstat walk from the pinned root: every parent must be a
   * real directory (no symlinks), the target must be absent or a regular single-link file.
   * With `create`, missing parents are created one segment at a time and re-checked.
   */
  async resolve(path, { create = false } = {}) {
    const parts = splitRelative(path);
    if (isPrivate(parts)) deny();
    await this.assertRoot();
    let current = this.root;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      let stat = await lstat(current).catch(error => (error?.code === 'ENOENT' ? undefined : deny()));
      if (!stat && create) {
        await mkdir(current, { mode: 0o755 }).catch(error => (error?.code === 'EEXIST' ? undefined : deny()));
        stat = await lstat(current).catch(deny);
      }
      if (!stat) return { abs: join(this.root, ...parts), parts, stat: undefined, missingParent: true };
      if (stat.isSymbolicLink() || !stat.isDirectory()) deny();
    }
    const abs = join(this.root, ...parts);
    if (!abs.startsWith(this.root + sep)) deny();
    const stat = await lstat(abs).catch(error => (['ENOENT', 'ENOTDIR'].includes(error?.code) ? undefined : deny()));
    if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)) deny();
    if ((await realpath(dirname(abs)).catch(deny)) !== dirname(abs)) deny();
    return { abs, parts, stat };
  }
  /** Resolves a project-relative directory (for search scoping); never follows links. */
  async resolveDirectory(path) {
    const parts = splitRelative(path);
    if (isPrivate(parts)) deny();
    await this.assertRoot();
    let current = this.root;
    for (const part of parts) {
      current = join(current, part);
      const stat = await lstat(current).catch(deny);
      if (stat.isSymbolicLink() || !stat.isDirectory()) deny();
    }
    return current;
  }
  /** Reads a resolved regular file; the opened inode must equal the walked one. */
  async read(resolved, max = PATH_LIMITS.readBytes) {
    if (!resolved.stat) deny();
    let handle;
    try {
      handle = await open(resolved.abs, OPEN_READ);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== resolved.stat.ino || stat.dev !== resolved.stat.dev) deny();
      if (stat.size > max) throw new ScopeError('SCOPE_LIMIT');
      const buffer = Buffer.alloc(stat.size);
      let total = 0;
      while (total < buffer.length) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total); if (!bytesRead) break; total += bytesRead; }
      if (total !== stat.size) throw new ScopeError('SCOPE_CONFLICT');
      return { bytes: buffer, mode: stat.mode & 0o777 };
    } catch (error) {
      if (error instanceof ScopeError) throw error;
      return deny();
    } finally { await handle?.close().catch(() => {}); }
  }
}
