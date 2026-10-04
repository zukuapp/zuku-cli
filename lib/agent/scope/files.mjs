import { chmod, link, open, readdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { readManifest, validateManifest } from '../../manifest-reader.mjs';
import { ScopeError } from './errors.mjs';
import { PATH_LIMITS, deny, isPrivate, writable } from './paths.mjs';
import { boundText, looksLikeSecret } from './redact.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const textOf = bytes => { try { return decoder.decode(bytes); } catch { return undefined; } };
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
export const FILE_LIMITS = Object.freeze({ changedFiles: 64, searchFiles: 2000, searchBytes: 1024 * 1024, searchResults: 100, readChars: 65536 });
const SKIP_SEARCH = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);

/**
 * Change journal for one runtime. Every write records the original bytes (or absence) once,
 * so the run can be rolled back and reviewed. Overwrites need the caller's expected SHA-256
 * of the current bytes, i.e. the model must have read the exact version it replaces.
 *
 * write/patch take a host-only `{ beforeWrite }` hook (never part of model tool input). On a
 * path's first change in this journal it receives `{ path, original, original_sha256 }`, the
 * original being the inode-checked bytes that matched `expected` (null for a new file), and
 * runs before the temp file is created. If it throws, nothing in the project is written. The
 * final rename re-checks that the file still holds exactly those bytes.
 */
export class ChangeJournal {
  constructor(project, manifest) { this.project = project; this.manifest = manifest; this.changes = new Map(); }
  get count() { return this.changes.size; }

  async readText(path, { offset = 0, length = FILE_LIMITS.readChars } = {}) {
    const resolved = await this.project.resolve(path);
    if (!resolved.stat) throw new ScopeError('SCOPE_PATH_DENIED', { reason: 'not_found' });
    const { bytes } = await this.project.read(resolved);
    const text = textOf(bytes);
    if (text === undefined) return { path, sha256: sha256(bytes), bytes: bytes.length, binary: true };
    if (looksLikeSecret(text)) deny();
    const slice = text.slice(offset, offset + length);
    return { path, sha256: sha256(bytes), bytes: bytes.length, offset, content: slice, truncated: offset + slice.length < text.length };
  }

  async write(path, content, expected, { beforeWrite } = {}) {
    const resolvedParts = (await this.project.resolve(path)).parts;
    if (!writable(resolvedParts, this.manifest)) deny();
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > PATH_LIMITS.writeBytes) throw new ScopeError('SCOPE_LIMIT');
    if (looksLikeSecret(content)) deny();
    await this.admitSpecial(resolvedParts, content, expected);
    if (!this.changes.has(path) && this.changes.size >= FILE_LIMITS.changedFiles) throw new ScopeError('SCOPE_LIMIT');
    const resolved = await this.project.resolve(path, { create: true });
    let original, mode = 0o644;
    if (resolved.stat) {
      if (typeof expected !== 'string') throw new ScopeError('SCOPE_CONFLICT');
      const current = await this.project.read(resolved);
      // Files holding credential material are never replaced (nor read) through the agent.
      if (looksLikeSecret(textOf(current.bytes))) deny();
      if (sha256(current.bytes) !== expected) throw new ScopeError('SCOPE_CONFLICT');
      original = current.bytes; mode = current.mode & 0o755;
    } else if (expected !== null) throw new ScopeError('SCOPE_CONFLICT');
    if (!this.changes.has(path) && typeof beforeWrite === 'function') await beforeWrite(Object.freeze({ path, original: original ?? null, original_sha256: original ? sha256(original) : null }));
    const temp = join(dirname(resolved.abs), `.zuku-scope-${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(temp, CREATE, 0o600).catch(deny);
    let placed = false;
    try {
      await handle.writeFile(bytes); await handle.sync(); await handle.close();
      await chmod(temp, mode);
      if (resolved.stat) {
        // Re-check the precondition immediately before the atomic replace.
        const again = await this.project.resolve(path);
        if (!again.stat || again.stat.ino !== resolved.stat.ino || sha256((await this.project.read(again)).bytes) !== expected) throw new ScopeError('SCOPE_CONFLICT');
        await rename(temp, resolved.abs); placed = true;
      } else {
        // link() never replaces an existing file: a file created concurrently is a conflict.
        await link(temp, resolved.abs).catch(error => { throw error?.code === 'EEXIST' ? new ScopeError('SCOPE_CONFLICT') : new ScopeError('SCOPE_PATH_DENIED'); });
        placed = true;
        await unlink(temp).catch(() => {});
      }
    } finally {
      await handle.close().catch(() => {});
      if (!placed) await unlink(temp).catch(() => {});
    }
    const entry = this.changes.get(path) ?? { path, original: original ?? null, original_sha256: original ? sha256(original) : null };
    entry.current = bytes; entry.current_sha256 = sha256(bytes);
    this.changes.set(path, entry);
    return { path, sha256: entry.current_sha256, beforeSha256: original ? sha256(original) : null, bytes: bytes.length, created: !original };
  }

  async patch(path, expected, edits, hooks) {
    const resolved = await this.project.resolve(path);
    if (!resolved.stat) throw new ScopeError('SCOPE_PATH_DENIED', { reason: 'not_found' });
    const { bytes } = await this.project.read(resolved);
    if (sha256(bytes) !== expected) throw new ScopeError('SCOPE_CONFLICT');
    let text = textOf(bytes);
    if (text === undefined) deny();
    for (const edit of edits) {
      const first = text.indexOf(edit.old);
      // Exact, unique anchors only (no fuzzy matching): ambiguous edits are rejected.
      if (first < 0 || text.indexOf(edit.old, first + 1) >= 0) return { path, applied: false, reason: first < 0 ? 'old_text_not_found' : 'old_text_not_unique' };
      text = text.slice(0, first) + edit.new + text.slice(first + edit.old.length);
    }
    return { ...(await this.write(path, text, expected, hooks)), applied: true };
  }

  async admitSpecial(parts, content, expected) {
    const name = parts.join('/');
    if (name === 'zukujs.json') {
      const parsed = readManifest(Buffer.from(content, 'utf8'));
      if (parsed.manifest === undefined || validateManifest(parsed.manifest).length) deny();
    }
    if (name === 'package.json') {
      // Script/bin/lifecycle entries are host-trusted command definitions; a model may not change them.
      let next; try { next = JSON.parse(content); } catch { deny(); }
      let before = {};
      if (expected) { try { before = JSON.parse((await this.project.read(await this.project.resolve(name))).bytes.toString('utf8')); } catch { deny(); } }
      for (const field of ['scripts', 'bin', 'main', 'exports', 'imports', 'type', 'workspaces', 'gypfile', 'config']) {
        if (JSON.stringify(next?.[field] ?? null) !== JSON.stringify(before?.[field] ?? null)) deny();
      }
    }
  }

  async search(query, base) {
    const matches = [];
    let files = 0, truncated = false;
    const pending = [];
    if (base) {
      const file = await this.project.resolve(base).catch(() => undefined);
      if (file?.stat) { await scanFile(this, base, file, query, matches); return { matches, truncated }; }
      await this.project.resolveDirectory(base);
      pending.push(base);
    } else pending.push('');
    while (pending.length && matches.length < FILE_LIMITS.searchResults) {
      const rel = pending.shift();
      let list;
      try { list = await readdir(rel ? join(this.project.root, rel) : this.project.root, { withFileTypes: true }); } catch { continue; }
      list.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const entry of list) {
        // Dirent types are lstat-based: symlinks are never descended or read.
        if (SKIP_SEARCH.has(entry.name)) continue;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (isPrivate(path.split('/'))) continue;
        if (entry.isDirectory()) { pending.push(path); continue; }
        if (!entry.isFile()) continue;
        if (++files > FILE_LIMITS.searchFiles) { truncated = true; pending.length = 0; break; }
        const resolved = await this.project.resolve(path).catch(() => undefined);
        if (resolved?.stat && resolved.stat.size <= FILE_LIMITS.searchBytes) await scanFile(this, path, resolved, query, matches);
        if (matches.length >= FILE_LIMITS.searchResults) { truncated = true; break; }
      }
    }
    return { matches, truncated };
  }

  async inspectAsset(path) {
    const resolved = await this.project.resolve(path);
    if (!resolved.stat) throw new ScopeError('SCOPE_PATH_DENIED', { reason: 'not_found' });
    const { bytes } = await this.project.read(resolved, 64 * 1024 * 1024);
    if (looksLikeSecret(textOf(bytes))) deny();
    return { path, bytes: bytes.length, sha256: sha256(bytes), ...assetInfo(bytes, extname(path).toLowerCase()) };
  }

  /** Restores every changed file whose current bytes are still ours; returns conflicts. */
  async rollback() {
    const restored = [], conflicts = [];
    for (const entry of [...this.changes.values()].reverse()) {
      try {
        const resolved = await this.project.resolve(entry.path);
        if (!resolved.stat || sha256((await this.project.read(resolved)).bytes) !== entry.current_sha256) { conflicts.push(entry.path); continue; }
        if (entry.original === null) await unlink(resolved.abs);
        else {
          const temp = join(dirname(resolved.abs), `.zuku-scope-${randomBytes(6).toString('hex')}.tmp`);
          const handle = await open(temp, CREATE, 0o644);
          try { await handle.writeFile(entry.original); await handle.sync(); } finally { await handle.close(); }
          await rename(temp, resolved.abs);
        }
        restored.push(entry.path);
      } catch { conflicts.push(entry.path); }
    }
    return { restored, conflicts };
  }

  /** Reviewable unified diff of every change in this run (bounded). */
  diff() {
    return [...this.changes.values()].map(entry => unifiedDiff(entry.path, entry.original ? textOf(entry.original) : '', textOf(entry.current), entry.original === null)).join('');
  }
  summary() { return [...this.changes.values()].map(entry => ({ path: entry.path, original_sha256: entry.original_sha256, current_sha256: entry.current_sha256 })); }
}

async function scanFile(journal, path, resolved, query, matches) {
  let read; try { read = await journal.project.read(resolved, FILE_LIMITS.searchBytes); } catch { return; }
  const text = textOf(read.bytes);
  if (text === undefined || looksLikeSecret(text) || !text.includes(query)) return;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && matches.length < FILE_LIMITS.searchResults; i++) {
    if (lines[i].includes(query)) matches.push({ path, line: i + 1, text: boundText(lines[i], 200).text });
  }
}

export function assetInfo(b, ext) {
  const u32 = (o, le = false) => (o + 4 <= b.length ? (le ? b.readUInt32LE(o) : b.readUInt32BE(o)) : 0);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', width: u32(16), height: u32(20) };
  if (b.length >= 10 && b.subarray(0, 3).toString('latin1') === 'GIF') return { type: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = b.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X') return { type: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8L') { const v = u32(21, true); return { type: 'image/webp', width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8 ') return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    return { type: 'image/webp' };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1], size = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + size;
    }
    return { type: 'image/jpeg' };
  }
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') return { type: 'audio/wav' };
  if (b.length >= 4 && b.subarray(0, 4).toString('latin1') === 'OggS') return { type: 'audio/ogg' };
  if (b.length >= 3 && (b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) return { type: 'audio/mpeg' };
  if (b.length >= 8 && b.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) return { type: 'application/wasm', wasm_version: u32(4, true) };
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'glTF') return { type: 'model/gltf-binary' };
  if (ext === '.svg' && /<svg[\s>]/.test(b.subarray(0, 4096).toString('utf8'))) return { type: 'image/svg+xml' };
  return { type: 'application/octet-stream' };
}

// Bounded LCS-based unified diff (whole-file hunk). Large files fall back to a summary.
export function unifiedDiff(path, before, after, created) {
  const header = `--- ${created ? '/dev/null' : `a/${path}`}\n+++ b/${path}\n`;
  if (before === undefined || after === undefined) return `${header}Binary or non-UTF-8 content changed\n`;
  const a = before ? before.split('\n') : [], b = after.split('\n');
  if (a.length * b.length > 4_000_000) return `${header}@@ large change: ${a.length} -> ${b.length} lines (see backups) @@\n`;
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lines = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push(` ${a[i]}`); i++; j++; }
    else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) lines.push(`+${b[j++]}`);
    else lines.push(`-${a[i++]}`);
  }
  return `${header}@@ -1,${a.length} +1,${b.length} @@\n${lines.join('\n')}\n`;
}
