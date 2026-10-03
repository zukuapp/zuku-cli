import { open, lstat, link, mkdir, rename, unlink, realpath, stat as statPath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { ProjectError } from '../lib/project-errors.mjs';
import { inspectPackageFile, sha256 } from '../lib/project-package.mjs';
import { checkProject, inspectTarget, parsePathArgs, withFsErrors } from './validate.mjs';

const FLAGS = {
  '--output': { key: 'output', value: true }, '-o': { key: 'output', value: true },
  '--format': { key: 'format', value: true, choices: ['zwf', 'zip'] }, '--force': { key: 'force' },
};
// Identity-based containment: walk up from `dir` comparing dev/ino, so bind mounts,
// symlinked parents and case-insensitive spellings cannot hide the source directory.
async function within(dir, ancestor) {
  const target = await lstat(ancestor);
  for (let current = dir; ; current = dirname(current)) {
    const stat = await lstat(current);
    if (stat.dev === target.dev && stat.ino === target.ino) return true;
    if (dirname(current) === current) return false;
  }
}

// Default output: <project>/dist/<name>-<version>.<format> (dist/ is created if absent, never followed if a link).
async function outputTarget(root, project, format, options, cwd) {
  let output;
  if (options.output) output = resolve(cwd, options.output);
  else {
    const dist = join(root, 'dist');
    try { await mkdir(dist, { mode: 0o755 }); } catch (error) { if (error?.code !== 'EEXIST') throw new ProjectError('OUTPUT_INVALID'); }
    const stat = await lstat(dist);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ProjectError('PATH_UNSAFE');
    output = join(dist, `${project.name}-${project.version}.${format}`);
  }
  if (!output.toLowerCase().endsWith(`.${format}`) || basename(output).startsWith('.')) throw new ProjectError('OUTPUT_INVALID');
  let parent;
  try { parent = await realpath(dirname(output)); } catch { throw new ProjectError('OUTPUT_INVALID'); }
  // Outputs must never land in the packaged source tree.
  if (!(await statPath(parent)).isDirectory() || await within(parent, join(root, project.source))) throw new ProjectError('OUTPUT_INVALID');
  const path = join(parent, basename(output));
  const existing = await lstat(path).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error; });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new ProjectError('PATH_UNSAFE');
  if (existing && !options.force) throw new ProjectError('OUTPUT_EXISTS');
  return path;
}

/** ZukuJS package <path> [--format zwf|zip] [--output <file>] [--force]: deterministic ZWF2 or ZIP. */
export default async function packageCmd(args = [], { cwd = process.cwd(), signal } = {}) {
  const { path, options } = parsePathArgs(args, FLAGS);
  const { target: root, directory } = await inspectTarget(path, cwd);
  if (!directory) throw new ProjectError('INVALID_INPUT');
  // Until index.mjs passes its abort signal, also watch SIGINT/SIGTERM for the whole command
  // so an interrupted run never commits an output file.
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  const stopped = () => interrupted || Boolean(signal?.aborted);
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    return await withFsErrors(() => write(root, options, cwd, stopped));
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}

async function write(root, options, cwd, stopped) {
  const { report, project, result } = await checkProject(root, options.format, stopped);
  if (stopped()) throw new ProjectError('COMMAND_CANCELLED');
  const format = options.format ?? project.format;
  const output = await outputTarget(root, project, format, options, cwd);
  const temp = join(dirname(output), `.${basename(output)}.${randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try { handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644); }
  catch { throw new ProjectError('OUTPUT_INVALID'); }
  let kept = false;
  try {
    await handle.writeFile(result.bytes);
    await handle.sync();
    await handle.close();
    // Re-read the written bytes with the same inspectors `validate` uses.
    const check = await inspectPackageFile(temp);
    const digest = sha256(result.bytes);
    if (!check.valid || check.kind !== format || check.sha256 !== digest) throw new ProjectError('PACKAGE_INVALID', check.diagnostics);
    if (stopped()) throw new ProjectError('COMMAND_CANCELLED');
    if (options.force) { await rename(temp, output); kept = true; }
    else {
      // link() refuses an existing destination atomically; rename() would replace it.
      // Without hard-link support there is no atomic no-overwrite path, so require --force.
      try { await link(temp, output); kept = true; } catch (error) {
        if (error?.code === 'EEXIST') throw new ProjectError('OUTPUT_EXISTS');
        if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(error?.code)) throw new ProjectError('OUTPUT_LINK_UNSUPPORTED');
        throw error;
      }
      await unlink(temp).catch(() => {});
    }
    return {
      path: output, format, bytes: result.bytes.length, sha256: digest, deterministic: true,
      entry: result.entry, file_count: result.files, ...(format === 'zwf' ? { profile: result.profile } : {}),
      project: report.project, diagnostics: report.diagnostics,
    };
  } finally {
    await handle.close().catch(() => {});
    if (!kept) await unlink(temp).catch(() => {});
  }
}
