import { open, lstat, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LIMITS, PROFILE, compileZip, inspectZip, inspectZwf, safePath } from './vendor/zwf/format.mjs';
import { MANIFEST_MAX_BYTES, PROJECT_MANIFEST, normalizeManifest, readManifest, toZwfCompileOptions, validateManifest } from './manifest-reader.mjs';
import { zipWriter } from './zip.mjs';

// The archive contract is @zuku/zwf (vendored, unmodified): inspectZip admits ZIPs,
// compileZip/inspectZwf produce and check ZWF2. Project files are only read as bytes;
// nothing under a project is imported, required or spawned.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const EXTENSIONS = new Set('html htm js mjs cjs css json xml txt map md png jpg jpeg gif webp svg ico bmp avif mp3 ogg oga wav m4a aac flac opus weba mp4 webm woff woff2 ttf otf eot wasm data bin pck unityweb gz br gltf glb obj mtl fnt atlas plist csv tsv glsl vert frag'.split(' '));
const ZWF_MAX_BYTES = 16 + LIMITS.manifest + LIMITS.archive;
export const PACKAGE_LIMITS = Object.freeze({ files: LIMITS.files, file_bytes: LIMITS.file, total_bytes: LIMITS.total, archive_bytes: LIMITS.archive, zwf_manifest_bytes: LIMITS.manifest });

const diag = (code, path, message, severity = 'error') => ({ severity, code, path, message });
export const hasErrors = diagnostics => diagnostics.some(item => item.severity === 'error');
const sortDiagnostics = list => list.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const upstream = (error, path = '') => diag('ZWF_REJECTED', path, error?.name === 'ZwfError' ? error.message : 'ZWF/ZIP 형식이 올바르지 않습니다.');

/** Opens a regular file without following symlinks; `expected` pins dev/ino/size from the walk. */
export async function readRegular(path, expected, maxBytes = LIMITS.file) {
  let handle;
  try {
    handle = await open(path, READ_FLAGS);
    const stat = await handle.stat();
    if (stat.isFile() && stat.size > maxBytes) return { tooLarge: true };
    if (!stat.isFile() || (expected && (stat.ino !== expected.ino || stat.dev !== expected.dev || stat.size !== expected.size))) return { changed: true };
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return total === stat.size ? { bytes: buffer.subarray(0, total) } : { changed: true };
  } catch (error) {
    if (['ELOOP', 'ENXIO', 'EMLINK'].includes(error?.code)) return { changed: true };
    throw error;
  } finally { await handle?.close(); }
}

/**
 * lstat walk. Symlinks, hard links and special files are errors; dot-entries are skipped
 * with a warning. File count and expanded bytes are bounded before anything is read.
 */
export async function collectProjectFiles(root, prefix = '', exclude = []) {
  const shown = name => prefix + name;
  const rootStat = await lstat(root);
  const directories = new Map([['', rootStat]]);
  const files = [], diagnostics = [];
  const pending = [''];
  let total = 0, count = 0;
  while (pending.length) {
    const relative = pending.pop();
    const dir = relative ? join(root, relative) : root;
    const entries = await readdir(dir, { withFileTypes: true });
    // A directory swapped for a link between lstat and readdir would list foreign files.
    const after = await lstat(dir);
    const before = directories.get(relative);
    if (after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev) { diagnostics.push(diag('PROJECT_CHANGED', shown(relative), '검사 중 디렉터리가 바뀌었습니다.')); return { files, diagnostics, truncated: true }; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (excludedBy(name, exclude)) continue;
      if (entry.name.startsWith('.')) { diagnostics.push(diag('HIDDEN_EXCLUDED', shown(name), '숨김 항목은 패키지에 포함하지 않습니다.', 'warning')); continue; }
      if (entry.name === 'node_modules') { diagnostics.push(diag('DEPENDENCIES_EXCLUDED', shown(name), '의존성 디렉터리는 패키지에 포함하지 않습니다.', 'warning')); continue; }
      if (!safePath(name)) { diagnostics.push(diag('PATH_UNSAFE', shown(name).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 256), '경로에 \\, 제어 문자, :, %, ?, # 를 쓸 수 없고 1024자 이하여야 합니다.')); continue; }
      const stat = await lstat(join(root, name));
      if (stat.isSymbolicLink()) diagnostics.push(diag('PATH_SYMLINK', shown(name), '심볼릭 링크는 허용되지 않습니다.'));
      else if (stat.isDirectory()) {
        files.push({ name, directory: true }); directories.set(name, stat); pending.push(name);
        if (directories.size > LIMITS.files) { diagnostics.push(diag('TOO_MANY_FILES', '', `디렉터리는 ${LIMITS.files}개 이하여야 합니다.`)); return { files, diagnostics, truncated: true }; }
      }
      else if (!stat.isFile()) diagnostics.push(diag('PATH_SPECIAL', shown(name), '일반 파일만 포함할 수 있습니다.'));
      else if (stat.nlink !== 1) diagnostics.push(diag('PATH_HARDLINK', shown(name), '하드 링크 파일은 허용되지 않습니다.'));
      else {
        files.push({ name, size: stat.size, dev: stat.dev, ino: stat.ino });
        total += stat.size;
        if (++count > LIMITS.files) { diagnostics.push(diag('TOO_MANY_FILES', '', `파일은 ${LIMITS.files}개 이하여야 합니다.`)); return { files, diagnostics, truncated: true }; }
        if (total > LIMITS.total) { diagnostics.push(diag('TOTAL_TOO_LARGE', '', `전체 크기는 ${LIMITS.total} bytes 이하여야 합니다.`)); return { files, diagnostics, truncated: true }; }
      }
    }
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return { files, diagnostics };
}

const excludedBy = (name, exclude) => exclude.find(item => name === item || name.startsWith(`${item}/`));

async function readProjectManifest(root, diagnostics) {
  let stat;
  try { stat = await lstat(join(root, PROJECT_MANIFEST)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (!stat) { diagnostics.push(diag('MANIFEST_MISSING', PROJECT_MANIFEST, `프로젝트 루트에 ${PROJECT_MANIFEST}이 필요합니다.`)); return; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) { diagnostics.push(diag('PATH_UNSAFE', PROJECT_MANIFEST, '매니페스트는 링크가 아닌 일반 파일이어야 합니다.')); return; }
  const manifestFile = { size: stat.size, dev: stat.dev, ino: stat.ino };
  const read = await readRegular(join(root, PROJECT_MANIFEST), manifestFile, MANIFEST_MAX_BYTES);
  if (read.tooLarge) { diagnostics.push(diag('MANIFEST_TOO_LARGE', PROJECT_MANIFEST, `${MANIFEST_MAX_BYTES} bytes 이하여야 합니다.`)); return; }
  if (read.changed) { diagnostics.push(diag('PROJECT_CHANGED', PROJECT_MANIFEST, '검사 중 파일이 바뀌었습니다.')); return; }
  const parsed = readManifest(read.bytes);
  diagnostics.push(...parsed.diagnostics);
  if (parsed.manifest === undefined) return;
  const problems = validateManifest(parsed.manifest);
  diagnostics.push(...problems);
  return problems.length ? undefined : normalizeManifest(parsed.manifest);
}

/** Validates a project (zukujs.json + its `source` directory) and selects exactly the files `package` ships. */
export async function inspectProject(root) {
  const diagnostics = [];
  const report = { kind: 'directory', valid: false, project: null, diagnostics };
  const project = await readProjectManifest(root, diagnostics);
  let walked = [], truncated = false;
  if (project) {
    let stat;
    try { stat = await lstat(join(root, project.source)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (!stat) diagnostics.push(diag('SOURCE_MISSING', project.source, '소스 디렉터리가 없습니다.'));
    else if (stat.isSymbolicLink() || !stat.isDirectory()) diagnostics.push(diag('PATH_UNSAFE', project.source, '소스는 링크가 아닌 디렉터리여야 합니다.'));
    else {
      const result = await collectProjectFiles(join(root, project.source), `${project.source}/`, project.exclude);
      ({ files: walked, truncated } = result);
      diagnostics.push(...result.diagnostics);
    }
  }
  const at = name => `${project?.source}/${name}`;
  const exclude = project?.exclude ?? [];
  if (project && !truncated) {
    for (const item of exclude) {
      const exists = await lstat(join(root, project.source, item)).then(() => true, () => false);
      if (!exists) diagnostics.push(diag('EXCLUDE_UNUSED', at(item), '일치하는 경로가 없습니다.', 'warning'));
    }
  }
  const files = walked.filter(file => !file.directory);
  const seen = new Map();
  for (const file of walked) {
    const key = file.name.toLowerCase();
    if (seen.has(key)) diagnostics.push(diag('PATH_CASE_COLLISION', at(file.name), `${at(seen.get(key))}와 대소문자만 다릅니다.`));
    else seen.set(key, file.name);
  }
  for (const file of files) {
    if (!EXTENSIONS.has(file.name.split('.').pop().toLowerCase())) diagnostics.push(diag('FILE_TYPE_UNSUPPORTED', at(file.name), 'ZWF2 HTML5 허용 확장자가 아닙니다. package.exclude로 제외할 수 있습니다.'));
    if (file.size > LIMITS.file) diagnostics.push(diag('FILE_TOO_LARGE', at(file.name), `파일은 ${LIMITS.file} bytes 이하여야 합니다.`));
  }
  if (project && !truncated) {
    const roots = files.map(file => file.name).filter(name => /^index\.html?$/i.test(name));
    if (!roots.includes(project.entry)) diagnostics.push(diag('ENTRY_MISSING', at(project.entry), `소스 루트에 진입점 ${project.entry}이 필요합니다.`));
    else if (roots.length > 1) diagnostics.push(diag('ENTRY_AMBIGUOUS', at(project.entry), '소스 루트에는 index.html 또는 index.htm 중 하나만 둘 수 있습니다.'));
  }
  if (project && !files.length && !truncated) diagnostics.push(diag('PROJECT_EMPTY', '', '패키지에 넣을 파일이 없습니다.'));
  report.file_count = files.length;
  report.total_bytes = files.reduce((sum, file) => sum + file.size, 0);
  report.limits = PACKAGE_LIMITS;
  if (project) report.project = { name: project.name, title: project.title, version: project.version, source: project.source, entry: project.entry, format: project.format, game_id: project.game_id };
  report.valid = !hasErrors(diagnostics);
  sortDiagnostics(diagnostics);
  return { report, files, project };
}

const executable = bytes => (bytes[0] === 0x4d && bytes[1] === 0x5a) || (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46);

/** Deterministic ZIP of the selected files (already sorted by UTF-8 bytes). */
export async function buildArchive(root, project, files) {
  root = join(root, project.source);
  const chunks = [], diagnostics = [];
  const writer = zipWriter(async buffer => { chunks.push(buffer); }, { maxBytes: LIMITS.archive });
  try {
    for (const file of files) {
      const read = await readRegular(join(root, file.name), file);
      if (!read.bytes) return { changed: true };
      // Same native-executable signatures zwf inspectZip rejects; reported with the member path.
      if (executable(read.bytes)) { diagnostics.push(diag('EXECUTABLE_PAYLOAD', `${project.source}/${file.name}`, '네이티브 실행 파일(MZ/ELF)은 포함할 수 없습니다.')); continue; }
      if (!diagnostics.length) await writer.add(file.name, read.bytes);
    }
    if (diagnostics.length) return { diagnostics };
    await writer.finish();
  } catch (error) {
    if (error?.zipLimit) return { diagnostics: [diag('ARCHIVE_TOO_LARGE', '', `압축 파일은 ${LIMITS.archive} bytes 이하여야 합니다.`)] };
    throw error;
  }
  return { zip: Buffer.concat(chunks) };
}

/**
 * Real zwf admission: compileZip runs inspectZip itself, so each format decompresses once here.
 * `package` additionally re-inspects the written file with inspectZwf/inspectZip.
 */
export async function admit(zip, project, format) {
  try {
    let result;
    if (format === 'zip') {
      const archive = inspectZip(zip);
      result = { bytes: zip, entry: archive.entry, files: archive.files.length };
    } else {
      const { bytes, manifest } = await compileZip(zip, toZwfCompileOptions(project));
      result = { bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), entry: manifest.entry_point, files: manifest.files.length, profile: manifest.profile };
    }
    if (result.entry !== project.entry) return { diagnostics: [diag('ENTRY_MISMATCH', `${project.source}/${result.entry}`, 'zwf가 선택한 진입점이 프로젝트 entry와 다릅니다.')] };
    return result;
  } catch (error) { return { diagnostics: [upstream(error)] }; }
}

/** Validates a built .zip or .zwf with the vendored zwf inspectors. */
export async function inspectPackageFile(path) {
  const read = await readRegular(path, undefined, ZWF_MAX_BYTES);
  if (read.tooLarge) return { kind: 'unknown', valid: false, limits: PACKAGE_LIMITS, diagnostics: [diag('ARCHIVE_TOO_LARGE', '', `패키지는 ${ZWF_MAX_BYTES} bytes 이하여야 합니다.`)] };
  if (read.changed) { const error = new Error('unsafe'); error.code = 'ESPECIAL'; throw error; }
  const bytes = read.bytes;
  const zwf = bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'ZWF2';
  const report = { kind: zwf ? 'zwf' : 'zip', valid: false, bytes: bytes.length, sha256: sha256(bytes), limits: PACKAGE_LIMITS, diagnostics: [] };
  try {
    if (zwf) {
      const { manifest } = await inspectZwf(bytes);
      Object.assign(report, { entry: manifest.entry_point, title: manifest.title, profile: manifest.profile, file_count: manifest.files.length, total_bytes: manifest.files.reduce((sum, file) => sum + file.size, 0) });
    } else {
      const archive = inspectZip(bytes);
      Object.assign(report, { entry: archive.entry, profile: PROFILE, file_count: archive.files.length, total_bytes: archive.files.reduce((sum, file) => sum + file.size, 0) });
    }
    report.valid = true;
  } catch (error) { report.diagnostics.push(upstream(error)); }
  return report;
}

export { sha256 };
