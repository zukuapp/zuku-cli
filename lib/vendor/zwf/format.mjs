import { unzipSync } from 'fflate';

export const LIMITS = Object.freeze({ archive: 500 * 1024 ** 2, file: 128 * 1024 ** 2, total: 512 * 1024 ** 2, files: 8000, manifest: 2 * 1024 ** 2, ratio: 80 });
export const PROFILE = 'html5-sandbox/2';
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const extensions = new Set('html htm js mjs cjs css json xml txt map md png jpg jpeg gif webp svg ico bmp avif mp3 ogg oga wav m4a aac flac opus weba mp4 webm woff woff2 ttf otf eot wasm data bin pck unityweb gz br gltf glb obj mtl fnt atlas plist csv tsv glsl vert frag'.split(' '));
export class ZwfError extends Error { constructor(message) { super(message); this.name = 'ZwfError'; } }
const fail = (message) => { throw new ZwfError(message); };
const asBytes = (input) => input instanceof Uint8Array ? input : new Uint8Array(input);
export function safePath(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 1024 && !/[\\\x00-\x1f\x7f:%?#]/.test(name) && !name.startsWith('/') && !name.split('/').some((part) => !part || part === '.' || part === '..');
}
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) => v.toString(16).padStart(2, '0')).join('');
}

/** Inspect the central directory BEFORE decompression or allocating entry buffers. */
export function inspectZip(input) {
  const bytes = asBytes(input);
  if (bytes.length > LIMITS.archive || bytes.length < 22) fail('ZIP size is outside the supported limits');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) fail('ZIP central directory is missing');
  const count = view.getUint16(end + 10, true);
  const cdSize = view.getUint32(end + 12, true);
  const cdStart = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || !count || count > LIMITS.files || cdStart + cdSize !== end) fail('Split, ZIP64 or excessive ZIP directories are unsupported');
  let offset = cdStart, total = 0;
  const entries = [], names = new Set(), spans = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) fail('Invalid ZIP entry');
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true), mode = view.getUint32(offset + 38, true) >>> 16;
    if (offset + 46 + nameLength + extra + comment > end) fail('Truncated ZIP directory');
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const directory = name.endsWith('/'), path = directory ? name.slice(0, -1) : name;
    if (!safePath(path) || names.has(path.toLowerCase())) fail(`Unsafe or duplicate ZIP path: ${name}`);
    names.add(path.toLowerCase());
    if ((flags & 1) || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000 || view.getUint16(offset + 34, true)) fail(`Encrypted, linked or unsupported ZIP entry: ${name}`);
    if (size > LIMITS.file || (total += size) > LIMITS.total || (size >= 1024 ** 2 && size > Math.max(compressed, 1) * LIMITS.ratio)) fail('ZIP decompression limits exceeded');
    if (directory && size) fail('ZIP directory has data');
    if (!directory && !extensions.has(path.split('.').pop().toLowerCase())) fail(`Unsupported HTML5 package file: ${name}`);
    if (local + 30 > cdStart || view.getUint32(local, true) !== 0x04034b50) fail('Invalid ZIP local header');
    const localNameLength = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localNameLength + localExtra;
    if (view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name || start + compressed > cdStart) fail('ZIP headers disagree');
    spans.push([local, start + compressed]);
    entries.push({ path: name, size, crc: view.getUint32(offset + 16, true), directory });
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end) fail('ZIP directory length mismatch');
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) fail('Overlapping ZIP entries');
  const unpacked = unzipSync(bytes, { filter: (entry) => entry.originalSize <= LIMITS.file });
  for (const entry of entries) {
    const data = unpacked[entry.path];
    if (!data || data.length !== entry.size || crc32(data) !== entry.crc) fail(`Corrupt ZIP entry: ${entry.path}`);
    if (entry.directory) continue;
    if ((data[0] === 0x4d && data[1] === 0x5a) || (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46)) fail(`Executable payload: ${entry.path}`);
  }
  const files = entries.filter((entry) => !entry.directory);
  const paths = files.map((entry) => entry.path);
  const roots = paths.filter((path) => /^index\.html?$/i.test(path));
  const nested = paths.filter((path) => /^[^/]+\/index\.html?$/i.test(path));
  const entry = roots[0] ?? (nested.length === 1 ? nested[0] : null);
  if (!entry) fail('ZIP must contain index.html at the root or in one wrapper directory');
  return { entry, files, unpacked };
}

export async function compileZip(input, options = {}) {
  const zip = asBytes(input), archive = inspectZip(zip);
  const manifest = {
    format: 'zwf', version: 2, profile: PROFILE, entry_point: archive.entry,
    title: String(options.title ?? '').slice(0, 100),
    permissions: { network: 'package-only', storage: 'none' },
    zip_sha256: await sha256(zip),
    files: await Promise.all(archive.files.map(async (entry) => ({ path: entry.path, size: entry.size, sha256: await sha256(archive.unpacked[entry.path]) }))),
  };
  const json = encoder.encode(JSON.stringify(manifest));
  if (json.length > LIMITS.manifest) fail('ZWF manifest exceeds its limit');
  const result = new Uint8Array(16 + json.length + zip.length), view = new DataView(result.buffer);
  result.set(encoder.encode('ZWF2')); view.setUint16(4, 2, true); view.setUint32(8, json.length, true); view.setUint32(12, zip.length, true);
  result.set(json, 16); result.set(zip, 16 + json.length);
  return { bytes: result, manifest };
}

export async function inspectZwf(input) {
  const bytes = asBytes(input);
  if (bytes.length < 16 || decoder.decode(bytes.subarray(0, 4)) !== 'ZWF2') fail('Expected a ZWF2 HTML5 package');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const manifestSize = view.getUint32(8, true), zipSize = view.getUint32(12, true);
  if (view.getUint16(4, true) !== 2 || view.getUint16(6, true) !== 0 || manifestSize > LIMITS.manifest || zipSize > LIMITS.archive || 16 + manifestSize + zipSize !== bytes.length) fail('Invalid ZWF2 header or size');
  const manifest = JSON.parse(decoder.decode(bytes.subarray(16, 16 + manifestSize)));
  const zip = bytes.subarray(16 + manifestSize);
  if (manifest.format !== 'zwf' || manifest.version !== 2 || manifest.profile !== PROFILE || manifest.permissions?.network !== 'package-only' || manifest.permissions?.storage !== 'none' || !safePath(manifest.entry_point) || manifest.zip_sha256 !== await sha256(zip)) fail('Invalid ZWF2 manifest or payload digest');
  const archive = inspectZip(zip);
  if (archive.entry !== manifest.entry_point || !Array.isArray(manifest.files) || manifest.files.length !== archive.files.length) fail('ZWF2 manifest does not match the archive');
  for (let i = 0; i < archive.files.length; i++) {
    const entry = archive.files[i], declared = manifest.files[i];
    if (entry.path !== declared.path || entry.size !== declared.size || declared.sha256 !== await sha256(archive.unpacked[entry.path])) fail('ZWF2 member digest mismatch');
  }
  return { manifest, zip };
}
