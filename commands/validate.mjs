import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ProjectError } from '../lib/project-errors.mjs';
import { admit, buildArchive, inspectPackageFile, inspectProject } from '../lib/project-package.mjs';

export function parsePathArgs(args, flags = {}) {
  const options = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string' || arg === '') throw new ProjectError('INVALID_INPUT');
    if (arg === '--') { positional.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    const kind = flags[flag];
    if (!kind || Object.hasOwn(options, kind.key)) throw new ProjectError('INVALID_INPUT');
    if (kind.value) {
      const value = inline ?? args[++i];
      if (typeof value !== 'string' || value === '' || (kind.choices && !kind.choices.includes(value))) throw new ProjectError('INVALID_INPUT');
      options[kind.key] = value;
    } else if (inline !== undefined) throw new ProjectError('INVALID_INPUT');
    else options[kind.key] = true;
  }
  if (positional.length !== 1 || positional[0] === '' || positional[0].includes('\0')) throw new ProjectError('INVALID_INPUT');
  return { path: positional[0], options };
}

/** Classifies a user path without following a final symlink. */
export async function inspectTarget(path, cwd) {
  const target = resolve(cwd, path);
  let stat;
  try { stat = await lstat(target); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new ProjectError('PROJECT_NOT_FOUND');
    throw new ProjectError('COMMAND_FAILED');
  }
  if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) throw new ProjectError('PATH_UNSAFE');
  return { target, directory: stat.isDirectory() };
}

export const withFsErrors = async action => {
  try { return await action(); } catch (error) {
    if (error instanceof ProjectError) throw error;
    if (['ELOOP', 'ESPECIAL', 'ENXIO'].includes(error?.code)) throw new ProjectError('PATH_UNSAFE');
    if (error?.code === 'ENOENT') throw new ProjectError('PROJECT_CHANGED');
    throw new ProjectError('COMMAND_FAILED');
  }
};

/** Validates a project and admits its would-be archive with zwf; returns { report, project, result }. */
export async function checkProject(root, format) {
  const { report, files, project } = await inspectProject(root);
  if (!report.valid) throw new ProjectError('PROJECT_INVALID', report.diagnostics);
  const built = await buildArchive(root, project, files);
  if (built.changed) throw new ProjectError('PROJECT_CHANGED');
  if (built.diagnostics) throw new ProjectError('PROJECT_INVALID', built.diagnostics);
  const result = await admit(built.zip, project, format ?? project.format);
  if (result.diagnostics) throw new ProjectError('PROJECT_INVALID', result.diagnostics);
  return { report, project, result };
}

/** ZukuJS validate <path>: a project directory (zukujs.json + source dir) or a built .zip/.zwf package. */
export default async function validate(args = [], { cwd = process.cwd() } = {}) {
  const { path } = parsePathArgs(args);
  const { target, directory } = await inspectTarget(path, cwd);
  return withFsErrors(async () => {
    if (!directory) {
      const report = await inspectPackageFile(target);
      if (!report.valid) throw new ProjectError('PACKAGE_INVALID', report.diagnostics);
      return report;
    }
    const { report, result } = await checkProject(target);
    return { ...report, archive: { format: report.project.format, bytes: result.bytes.length, entry: result.entry, file_count: result.files } };
  });
}
