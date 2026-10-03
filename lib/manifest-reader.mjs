// ZukuJS local project manifest (zukujs.json), schema id "zukujs-project/1".
// CLI-side only: the service has no project manifest. It lives at the project root, outside
// the packaged `source` directory, so it is never shipped. Its fields map separately onto
// the ZWF2 compile options (toZwfCompileOptions) and the JUMP draft body (lib/jump-meta.mjs).
// Documented in lib/schemas/zukujs-project.schema.json. Parsing never executes code.

export const PROJECT_MANIFEST = 'zukujs.json';
export const PROJECT_SCHEMA = 'zukujs-project/1';
export const ENTRY_POINTS = Object.freeze(['index.html', 'index.htm']);
export const PACKAGE_FORMATS = Object.freeze(['zwf', 'zip']);
export const MANIFEST_MAX_BYTES = 64 * 1024;
// zwf compileZip keeps String(title).slice(0, 100); longer titles would be truncated silently.
export const TITLE_MAX = 100;
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SOURCE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export const AGE_RATINGS = Object.freeze(['all', '12', '15', '18']);
// Draft API limits (coordinator-verified /api/v1 contract): description <=500, tags <=10.
export const DESCRIPTION_MAX = 500;
export const TAGS_MAX = 10;
// Not specified by the service; local defaults pending confirmation.
export const GAME_ID_PATTERN = /^game_[A-Za-z0-9_-]{1,64}$/;
export const GENRE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const TAG_MAX = 30;
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const EXCLUDE_MAX = 256;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pointer = (base, key) => `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const diag = (code, path, message, severity = 'error') => ({ severity, code, path: `${PROJECT_MANIFEST}#${path}`, message });

function shape(value, path, required, properties, out) {
  if (!record(value)) { out.push(diag('MANIFEST_TYPE', path, '객체여야 합니다.')); return false; }
  for (const key of required) if (!Object.hasOwn(value, key)) out.push(diag('MANIFEST_REQUIRED', pointer(path, key), '필수 필드가 없습니다.'));
  for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) out.push(diag('MANIFEST_UNKNOWN_FIELD', pointer(path, key), '스키마에 없는 필드입니다.'));
  for (const [key, check] of Object.entries(properties)) if (Object.hasOwn(value, key)) check(value[key], pointer(path, key), out);
  return true;
}
const text = ({ min = 0, max, pattern, controls = false, codePoints = false, blank = true }) => (value, path, out) => {
  if (typeof value !== 'string') { out.push(diag('MANIFEST_TYPE', path, '문자열이어야 합니다.')); return; }
  const size = codePoints ? [...value].length : value.length;
  if (size < min || size > max) out.push(diag('MANIFEST_LENGTH', path, `길이는 ${min}~${max}자여야 합니다.`));
  if (!blank && value.length && !value.trim()) out.push(diag('MANIFEST_BLANK', path, '공백만으로 이루어질 수 없습니다.'));
  if (pattern && !pattern.test(value)) out.push(diag('MANIFEST_PATTERN', path, `형식은 ${pattern.source}이어야 합니다.`));
  if (!controls && /[\x00-\x1f\x7f]/.test(value)) out.push(diag('MANIFEST_PATTERN', path, '제어 문자를 포함할 수 없습니다.'));
};
const choice = values => (value, path, out) => { if (!values.includes(value)) out.push(diag('MANIFEST_ENUM', path, `${values.join(', ')} 중 하나여야 합니다.`)); };
const bool = (value, path, out) => { if (typeof value !== 'boolean') out.push(diag('MANIFEST_TYPE', path, 'boolean이어야 합니다.')); };
const list = (item, max) => (value, path, out) => {
  if (!Array.isArray(value)) { out.push(diag('MANIFEST_TYPE', path, '배열이어야 합니다.')); return; }
  if (value.length > max) out.push(diag('MANIFEST_LENGTH', path, `항목은 ${max}개 이하여야 합니다.`));
  if (new Set(value).size !== value.length) out.push(diag('MANIFEST_UNIQUE', path, '항목이 중복되었습니다.'));
  value.forEach((entry, index) => item(entry, pointer(path, index), out));
};
const constant = expected => (value, path, out) => { if (value !== expected) out.push(diag('MANIFEST_CONST', path, `${JSON.stringify(expected)}이어야 합니다.`)); };

// Exclusions are exact package-relative paths (a directory excludes its subtree); no globs.
export const safeRelativePath = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !/[\\\x00-\x1f\x7f:%?#]/.test(value) && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..');
const relativePath = (value, path, out) => { if (!safeRelativePath(value)) out.push(diag('MANIFEST_PATTERN', path, '안전한 상대 경로여야 합니다.')); };

const PROPERTIES = Object.freeze({
  schema: constant(PROJECT_SCHEMA),
  name: text({ min: 1, max: 64, pattern: NAME_PATTERN }),
  // UTF-16 length <= 100 also satisfies the API's 1-100 Unicode characters, and zwf never truncates.
  title: text({ min: 1, max: TITLE_MAX, blank: false }),
  version: text({ min: 5, max: 64, pattern: VERSION_PATTERN }),
  description: text({ max: DESCRIPTION_MAX, controls: true, codePoints: true }),
  tags: list(text({ min: 1, max: TAG_MAX, codePoints: true, blank: false }), TAGS_MAX),
  age_rating: choice(AGE_RATINGS),
  source: text({ min: 1, max: 64, pattern: SOURCE_PATTERN }),
  entry: choice(ENTRY_POINTS),
  jump: (value, path, out) => shape(value, path, [], {
    game_id: text({ min: 6, max: 69, pattern: GAME_ID_PATTERN }),
    genre: text({ min: 1, max: 32, pattern: GENRE_PATTERN }),
    platform: (inner, innerPath, innerOut) => shape(inner, innerPath, ['pc'], { pc: bool, mobile: bool, tablet: bool }, innerOut),
  }, out),
  package: (value, path, out) => shape(value, path, [], { format: choice(PACKAGE_FORMATS), exclude: list(relativePath, EXCLUDE_MAX) }, out),
});

/** Parses zukujs.json bytes. Returns { manifest?, diagnostics }. */
export function readManifest(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('manifest bytes required');
  if (bytes.length > MANIFEST_MAX_BYTES) return { diagnostics: [diag('MANIFEST_TOO_LARGE', '', `${MANIFEST_MAX_BYTES} bytes 이하여야 합니다.`)] };
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return { diagnostics: [diag('MANIFEST_ENCODING', '', 'UTF-8이어야 합니다.')] }; }
  if (source.startsWith('﻿')) return { diagnostics: [diag('MANIFEST_ENCODING', '', 'BOM 없는 UTF-8이어야 합니다.')] };
  try { return { manifest: JSON.parse(source), diagnostics: [] }; }
  catch { return { diagnostics: [diag('MANIFEST_JSON', '', '올바른 JSON이 아닙니다.')] }; }
}

/** Validates a parsed manifest against zukujs-project/1; returns diagnostics (empty = valid). */
export function validateManifest(manifest) {
  const out = [];
  shape(manifest, '', ['schema', 'name', 'title', 'version'], PROPERTIES, out);
  return out;
}

/** Applies schema defaults to a valid manifest. */
export function normalizeManifest(manifest) {
  return Object.freeze({
    name: manifest.name, title: manifest.title, version: manifest.version,
    description: manifest.description ?? '',
    tags: Object.freeze([...(manifest.tags ?? [])]),
    age_rating: manifest.age_rating ?? 'all',
    source: manifest.source ?? 'src',
    entry: manifest.entry ?? 'index.html',
    game_id: manifest.jump?.game_id ?? `game_${manifest.name.replace(/-/g, '_')}`,
    genre: manifest.jump?.genre ?? null,
    platform: Object.freeze({ pc: manifest.jump?.platform?.pc ?? true, mobile: manifest.jump?.platform?.mobile ?? false, tablet: manifest.jump?.platform?.tablet ?? false }),
    format: manifest.package?.format ?? 'zwf',
    exclude: Object.freeze([...(manifest.package?.exclude ?? [])]),
  });
}

/** The only project field @zuku/zwf compileZip consumes. JUMP draft mapping: lib/jump-meta.mjs. */
export const toZwfCompileOptions = project => ({ title: project.title });
