// ZUKU modification: validate metadata and enforce output budgets while inflating.
import { Inflate } from 'fflate';

export const LIMITS = Object.freeze({ archive: 500 * 1024 ** 2, file: 128 * 1024 ** 2, total: 512 * 1024 ** 2, files: 8000, manifest: 2 * 1024 ** 2, ratio: 80, depth: 64 });
export const PROFILE = 'html5-sandbox/2';
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const extensions = new Set('html htm js mjs cjs css json xml txt map md png jpg jpeg gif webp svg ico bmp avif mp3 ogg oga wav m4a aac flac opus weba mp4 webm woff woff2 ttf otf eot wasm data bin pck unityweb gz br gltf glb obj mtl fnt atlas plist csv tsv glsl vert frag'.split(' '));
export class ZwfError extends Error { constructor(message) { super(message); this.name = 'ZwfError'; } }
const fail = (message) => { throw new ZwfError(message); };
const asBytes = (input) => input instanceof Uint8Array ? input : new Uint8Array(input);
export function safePath(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 1024 && !/[\\\x00-\x1f\x7f:%?#]/.test(name) && !name.startsWith('/') && name.split('/').length <= LIMITS.depth && !name.split('/').some((part) => !part || part === '.' || part === '..');
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function updateCrc(crc, bytes) {
  for (let index = 0; index < bytes.length; index++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[index]) & 255];
  return crc >>> 0;
}
export function crc32(bytes) {
  return (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}
export async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) => v.toString(16).padStart(2, '0')).join('');
}

function zipName(bytes) {
  try { return decoder.decode(bytes); } catch { fail('Invalid UTF-8 ZIP entry name'); }
}

function inspectExtra(bytes, start, length, nameBytes, name) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = start + length;
  while (start < end) {
    if (start + 4 > end) fail('Truncated ZIP extra field');
    const kind = view.getUint16(start, true), size = view.getUint16(start + 2, true);
    start += 4;
    if (start + size > end || kind === 1) fail('Truncated or unsupported ZIP64 extra field');
    if (kind === 0x7075 && (size < 5 || bytes[start] !== 1 || view.getUint32(start + 1, true) !== crc32(nameBytes) || zipName(bytes.subarray(start + 5, start + size)) !== name)) fail('Conflicting ZIP Unicode path');
    start += size;
  }
}

function unpackBudgeted(bytes, entries) {
  const unpacked = Object.create(null);
  let total = 0;
  for (const entry of entries) {
    let actual = 0, crc = 0xffffffff;
    const chunks = [];
    const consume = chunk => {
      actual += chunk.length;
      total += chunk.length;
      if (actual > entry.size || actual > LIMITS.file || total > LIMITS.total) fail(`Actual ZIP decompression budget exceeded: ${entry.path}`);
      crc = updateCrc(crc, chunk);
      chunks.push(chunk);
    };
    try {
      if (entry.method === 0) consume(bytes.subarray(entry.start, entry.start + entry.compressed));
      else {
        const inflater = new Inflate(consume);
        const end = entry.start + entry.compressed;
        if (!entry.compressed) fail(`Truncated DEFLATE stream: ${entry.path}`);
        for (let offset = entry.start; offset < end; offset += 1024) {
          const next = Math.min(offset + 1024, end);
          inflater.push(bytes.subarray(offset, next), next === end);
        }
        // fflate is version-pinned. Only the final partial byte may remain;
        // complete trailing bytes are not part of the declared DEFLATE stream.
        if (!inflater.s?.f || inflater.s.l || !(inflater.p instanceof Uint8Array) || inflater.p.length !== (inflater.s.p ? 1 : 0)) fail(`Truncated or trailing DEFLATE data: ${entry.path}`);
      }
    } catch (error) {
      if (error instanceof ZwfError) throw error;
      fail(`Corrupt ZIP compressed entry: ${entry.path}`);
    }
    if (actual !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail(`Corrupt ZIP entry: ${entry.path}`);
    let data;
    if (chunks.length === 1) data = chunks[0];
    else {
      data = new Uint8Array(actual);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    }
    if (!entry.directory && ((data[0] === 0x4d && data[1] === 0x5a) || (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46))) fail(`Executable payload: ${entry.path}`);
    unpacked[entry.path] = data;
  }
  return unpacked;
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
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    if (!(flags & 0x800) && nameBytes.some(byte => byte > 0x7f)) fail('Non-ASCII ZIP name requires the UTF-8 flag');
    const name = zipName(nameBytes);
    const directory = name.endsWith('/'), path = directory ? name.slice(0, -1) : name;
    const identity = path.normalize('NFC').toLowerCase();
    if (!safePath(path) || names.has(identity)) fail(`Unsafe or duplicate ZIP path: ${name}`);
    names.add(identity);
    const fileType = mode & 0xf000;
    if ((flags & ~0x080e) || ![0, 8].includes(method) || ![0, 0x8000, 0x4000].includes(fileType) || (fileType === 0x4000 && !directory) || (fileType === 0x8000 && directory) || view.getUint16(offset + 34, true) || view.getUint16(offset + 6, true) > 20) fail(`Encrypted, linked, special or unsupported ZIP entry: ${name}`);
    inspectExtra(bytes, offset + 46 + nameLength, extra, nameBytes, name);
    if (size > LIMITS.file || (total += size) > LIMITS.total || (size >= 1024 ** 2 && size > Math.max(compressed, 1) * LIMITS.ratio)) fail('ZIP decompression limits exceeded');
    if (directory && size) fail('ZIP directory has data');
    if (!directory && !extensions.has(path.split('.').pop().toLowerCase())) fail(`Unsupported HTML5 package file: ${name}`);
    if (local + 30 > cdStart || view.getUint32(local, true) !== 0x04034b50) fail('Invalid ZIP local header');
    const localNameLength = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localNameLength + localExtra;
    if (view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method || view.getUint16(local + 4, true) !== view.getUint16(offset + 6, true) || start > cdStart || zipName(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name || start + compressed > cdStart) fail('ZIP headers disagree');
    inspectExtra(bytes, local + 30 + localNameLength, localExtra, nameBytes, name);
    const crc = view.getUint32(offset + 16, true);
    let entryEnd = start + compressed;
    if (flags & 8) {
      for (const [field, expected] of [[14, crc], [18, compressed], [22, size]]) {
        const declared = view.getUint32(local + field, true);
        if (declared !== 0 && declared !== expected) fail('ZIP headers disagree on integrity metadata');
      }
      if (entryEnd + 12 > cdStart) fail('Truncated ZIP data descriptor');
      const candidates = view.getUint32(entryEnd, true) === 0x08074b50 ? [entryEnd + 4, entryEnd] : [entryEnd];
      const descriptor = candidates.find(at => at + 12 <= cdStart && view.getUint32(at, true) === crc && view.getUint32(at + 4, true) === compressed && view.getUint32(at + 8, true) === size);
      if (descriptor === undefined) fail('ZIP data descriptor integrity mismatch');
      entryEnd = descriptor + 12;
    } else if (view.getUint32(local + 14, true) !== crc || view.getUint32(local + 18, true) !== compressed || view.getUint32(local + 22, true) !== size) fail('ZIP headers disagree on integrity metadata');
    if (method === 0 && compressed !== size) fail('Stored ZIP entry sizes disagree');
    spans.push([local, entryEnd]);
    entries.push({ path: name, size, crc, directory, start, compressed, method });
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end) fail('ZIP directory length mismatch');
  spans.sort((a, b) => a[0] - b[0]);
  if (spans[0][0] !== 0 || spans.at(-1)[1] !== cdStart) fail('Unaccounted ZIP data');
  for (let i = 1; i < spans.length; i++) if (spans[i][0] !== spans[i - 1][1]) fail('Overlapping or gapped ZIP entries');
  const fileNames = new Set(entries.filter(entry => !entry.directory).map(entry => entry.path.normalize('NFC').toLowerCase()));
  for (const entry of entries) {
    const identity = (entry.directory ? entry.path.slice(0, -1) : entry.path).normalize('NFC').toLowerCase();
    const parts = identity.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      if (fileNames.has(parts.slice(0, depth).join('/'))) fail('ZIP file/directory path collision');
    }
  }
  const unpacked = unpackBudgeted(bytes, entries);
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
  let manifest;
  try { manifest = JSON.parse(decoder.decode(bytes.subarray(16, 16 + manifestSize))); }
  catch { fail('Invalid UTF-8 JSON ZWF2 manifest'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || typeof manifest.title !== 'string') fail('Invalid ZWF2 manifest object');
  const zip = bytes.subarray(16 + manifestSize);
  if (manifest.format !== 'zwf' || manifest.version !== 2 || manifest.profile !== PROFILE || manifest.permissions?.network !== 'package-only' || manifest.permissions?.storage !== 'none' || !safePath(manifest.entry_point) || manifest.zip_sha256 !== await sha256(zip)) fail('Invalid ZWF2 manifest or payload digest');
  const archive = inspectZip(zip);
  if (archive.entry !== manifest.entry_point || !Array.isArray(manifest.files) || manifest.files.length !== archive.files.length) fail('ZWF2 manifest does not match the archive');
  for (let i = 0; i < archive.files.length; i++) {
    const entry = archive.files[i], declared = manifest.files[i];
    if (!declared || typeof declared !== 'object' || entry.path !== declared.path || entry.size !== declared.size || declared.sha256 !== await sha256(archive.unpacked[entry.path])) fail('ZWF2 member digest mismatch');
  }
  return { manifest, zip };
}
