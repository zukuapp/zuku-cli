// Repository-contained, symlink-free file collection for native platform assets.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PlatformBuildError } from './matrix.mjs';

export const LIMITS = Object.freeze({ files: 4096, fileBytes: 256 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, depth: 24, pathBytes: 240 });
const fail = (code, message) => { throw new PlatformBuildError(code, message); };
const SEGMENT = /^(?!\.\.?$)[A-Za-z0-9_+@.][A-Za-z0-9 ._+@-]*$/;

export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/** Validate a repository- or archive-relative POSIX path from structured input. */
export function relativePath(value, label = 'path') {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > LIMITS.pathBytes) fail('PATH_INVALID', `${label} must be a short relative path.`);
  const segments = value.split('/');
  if (segments.length > LIMITS.depth || segments.some(s => !SEGMENT.test(s) || s.endsWith(' ') || s.endsWith('.'))) fail('PATH_INVALID', `${label} must be a normalized relative path without links, dot segments or option-like names.`);
  return value;
}

export function within(rel, base) {
  return rel === base || rel.startsWith(`${base}/`);
}

// lstat every component from the real repository root; no symlink, junction or non-directory parent.
export async function lstatChain(rootReal, rel) {
  let cursor = rootReal, info = null;
  for (const segment of relativePath(rel).split('/')) {
    cursor = path.join(cursor, segment);
    try { info = await fs.lstat(cursor); }
    catch (error) { if (error.code === 'ENOENT') fail('ARTIFACT_MISSING', `Expected artifact is missing: ${rel}`); throw error; }
    if (info.isSymbolicLink()) fail('ARTIFACT_LINK', `Symbolic links and junctions are rejected: ${rel}`);
    if (cursor !== path.join(rootReal, rel) && !info.isDirectory()) fail('ARTIFACT_INVALID', `A parent of ${rel} is not a directory.`);
  }
  return info;
}

async function readRegular(absolute, rel, expected) {
  // O_NONBLOCK: a FIFO swapped in after lstat cannot block the open.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK ?? 0);
  const handle = await fs.open(absolute, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.ino !== expected.ino || info.dev !== expected.dev) fail('ARTIFACT_CHANGED', `Artifact changed while being read: ${rel}`);
    if (info.nlink !== 1) fail('ARTIFACT_INVALID', `Hard-linked artifact files are rejected: ${rel}`);
    if (info.size > LIMITS.fileBytes) fail('ARTIFACT_TOO_LARGE', `Artifact exceeds the per-file limit: ${rel}`);
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) fail('ARTIFACT_CHANGED', `Artifact changed while being read: ${rel}`);
    return { bytes, mode: info.mode };
  } finally { await handle.close(); }
}

/**
 * Collect regular files under each artifact path (file or directory). Returns entries
 * sorted by path, each with the exact bytes that were hashed, so archive content and
 * manifest digests come from one read.
 */
export async function collectArtifacts(rootReal, artifacts, { base, executable: executablePath }) {
  const seen = new Map();
  let total = 0;
  const add = async (rel, info) => {
    if (seen.has(rel)) return;
    if (seen.size >= LIMITS.files) fail('ARTIFACT_TOO_MANY', 'Too many artifact files.');
    const { bytes, mode } = await readRegular(path.join(rootReal, rel), rel, info);
    total += bytes.length;
    if (total > LIMITS.totalBytes) fail('ARTIFACT_TOO_LARGE', 'Artifacts exceed the total size limit.');
    const executable = process.platform === 'win32' ? rel === executablePath : (mode & 0o111) !== 0;
    seen.set(rel, { path: rel, bytes, size: bytes.length, sha256: sha256(bytes), executable });
  };
  const walk = async (rel, depth) => {
    if (depth > LIMITS.depth) fail('ARTIFACT_INVALID', 'Artifact directory nesting is too deep.');
    const info = await lstatChain(rootReal, rel);
    if (info.isFile()) return add(rel, info);
    if (!info.isDirectory()) fail('ARTIFACT_INVALID', `Only regular files and directories are allowed: ${rel}`);
    const names = (await fs.readdir(path.join(rootReal, rel))).sort();
    for (const name of names) await walk(relativePath(`${rel}/${name}`, 'artifact entry'), depth + 1);
  };
  for (const rel of artifacts) {
    relativePath(rel, 'artifact');
    if (!within(rel, base) || rel === base) fail('ARTIFACT_OUTSIDE', `Artifact must be inside ${base}: ${rel}`);
    await walk(rel, 0);
  }
  if (!seen.size) fail('ARTIFACT_MISSING', 'No artifact files were produced.');
  if (!seen.has(executablePath)) fail('ARTIFACT_MISSING', `The declared executable is not among the artifacts: ${executablePath}`);
  if (process.platform !== 'win32' && !seen.get(executablePath).executable) fail('ARTIFACT_INVALID', 'The declared executable is not executable.');
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Hash finite repository files (source or shared payload) through the same safe reader. */
export async function hashRepositoryFiles(rootReal, files, { keepBytes = false } = {}) {
  if (files.length > LIMITS.files) fail('SOURCE_INVALID', 'Too many source files.');
  const result = [];
  for (const rel of [...files].sort()) {
    const info = await lstatChain(rootReal, rel);
    if (!info.isFile()) fail('SOURCE_INVALID', `Expected a regular file: ${rel}`);
    const { bytes } = await readRegular(path.join(rootReal, rel), rel, info);
    result.push({ path: rel, size: bytes.length, sha256: sha256(bytes), ...(keepBytes ? { bytes } : {}) });
  }
  return result;
}

/** Output files are created exclusively inside a real, non-linked output directory. */
export async function prepareOutputDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('OUTPUT_INVALID', 'Output directory must be absolute.');
  await fs.mkdir(directory, { recursive: true });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('OUTPUT_INVALID', 'Output directory must be a real directory.');
  return fs.realpath(directory);
}

export async function writeExclusive(directory, name, bytes) {
  relativePath(name, 'output name');
  if (name.includes('/')) fail('OUTPUT_INVALID', 'Output names must be plain file names.');
  await fs.writeFile(path.join(directory, name), bytes, { flag: 'wx', mode: 0o644 });
  return path.join(directory, name);
}
