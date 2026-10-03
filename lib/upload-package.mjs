import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { UploadError } from './upload-errors.mjs';

/*
 * Built-in strict ZWF2/ZIP preflight for `upload`, mirroring the public MIT @zuku/zwf 0.1.0 validator
 * (https://github.com/zukuapp/zwf, src/format.mjs) and adding a few stricter checks (title rules, BOM,
 * Mach-O signatures, local header CRC/size agreement). Written from the public specification for
 * Node 18+ without dependencies. Hash integrity is not a publisher signature.
 * An injected public validator (the @zuku/zwf module) is additionally run when provided.
 */
const MiB = 1024 * 1024;
export const LIMITS = Object.freeze({ archiveBytes: 500 * MiB, fileBytes: 128 * MiB, totalBytes: 512 * MiB, entries: 8000, manifestBytes: 2 * MiB, ratio: 80 });
export const PROFILE = 'html5-sandbox/2';
const EXTENSIONS = new Set('html htm js mjs cjs css json xml txt map md png jpg jpeg gif webp svg ico bmp avif mp3 ogg oga wav m4a aac flac opus weba mp4 webm woff woff2 ttf otf eot wasm data bin pck unityweb gz br gltf glb obj mtl fnt atlas plist csv tsv glsl vert frag'.split(' '));
const HEX64 = /^[0-9a-f]{64}$/;
const fail = reason => { throw new UploadError('PACKAGE_INVALID', { reason, stage: 'validate' }); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const decode = (bytes, reason) => { try { return utf8.decode(bytes); } catch { return fail(reason); } };

/** Public safePath rules: relative, no `\\ : % ? #` or control characters, no empty/./.. segments, <=1024 units. */
export function safePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 1024 && !/[\\\u0000-\u001f\u007f:%?#]/.test(path)
    && !path.startsWith('/') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** Inspect a plain ZIP: returns {entry, files:[{path,size,sha256}], unpacked}. Throws PACKAGE_INVALID. */
export function inspectZip(zip) {
  if (!(zip instanceof Uint8Array)) fail('zip_not_bytes');
  const len = zip.length;
  if (len < 22) fail('zip_too_small');
  if (len > LIMITS.archiveBytes) fail('zip_too_large');
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = at => view.getUint16(at, true), u32 = at => view.getUint32(at, true);
  let end = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65557); i--) if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === len) { end = i; break; }
  if (end < 0) fail('zip_eocd_missing');
  // Readers that take the last EOCD signature must not see a different directory than we do.
  for (let i = end + 1; i + 4 <= len; i++) if (u32(i) === 0x06054b50) fail('zip_eocd_ambiguous');
  const count = u16(end + 10), cdSize = u32(end + 12), cdStart = u32(end + 16);
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== count) fail('zip_multidisk');
  if (count < 1 || count > LIMITS.entries) fail('zip_entry_count');
  if (cdStart + cdSize !== end) fail('zip_central_directory');
  // A ZIP64 end-of-central-directory locator directly before the EOCD is refused explicitly.
  if (end >= 20 && u32(end - 20) === 0x07064b50) fail('zip64_unsupported');
  const entries = [], folded = new Set(), spans = [];
  let pos = cdStart, total = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > end || u32(pos) !== 0x02014b50) fail('zip_central_header');
    const flags = u16(pos + 8), method = u16(pos + 10), crc = u32(pos + 16), csize = u32(pos + 20), size = u32(pos + 24);
    const nameLen = u16(pos + 28), extraLen = u16(pos + 30), commentLen = u16(pos + 32), external = u32(pos + 38), local = u32(pos + 42);
    if (pos + 46 + nameLen + extraLen + commentLen > end) fail('zip_central_header');
    if (u16(pos + 34) !== 0) fail('zip_multidisk');
    if (flags & 0x41) fail('zip_encrypted');
    if (method !== 0 && method !== 8) fail('zip_method');
    if (csize === 0xFFFFFFFF || size === 0xFFFFFFFF || local === 0xFFFFFFFF) fail('zip64_unsupported');
    if (((external >>> 16) & 0xF000) === 0xA000) fail('zip_symlink');
    const rawName = zip.subarray(pos + 46, pos + 46 + nameLen);
    // Non-ASCII names need the UTF-8 flag (otherwise readers decode CP437/Latin-1); a BOM is never allowed.
    if (!(flags & 0x0800) && rawName.some(byte => byte > 0x7F)) fail('zip_name_encoding');
    const name = decode(rawName, 'zip_name_encoding');
    if (name.includes('\uFEFF')) fail('zip_name_encoding');
    const dir = name.endsWith('/');
    const path = dir ? name.slice(0, -1) : name;
    if (!safePath(path)) fail('zip_unsafe_path');
    const key = path.toLowerCase();
    if (folded.has(key)) fail('zip_case_collision');
    folded.add(key);
    if (dir && (size !== 0 || csize !== 0)) fail('zip_directory_data');
    if (size > LIMITS.fileBytes) fail('zip_member_too_large');
    total += size;
    if (total > LIMITS.totalBytes) fail('zip_expanded_too_large');
    if (size >= MiB && size > Math.max(csize, 1) * LIMITS.ratio) fail('zip_ratio');
    if (!dir) { const ext = path.split('.').pop().toLowerCase(); if (!EXTENSIONS.has(ext)) fail('zip_asset_type'); }
    // Local header must agree with the central directory and lie wholly before it.
    if (local + 30 > cdStart || u32(local) !== 0x04034b50) fail('zip_local_header');
    const lNameLen = u16(local + 26), lExtraLen = u16(local + 28), start = local + 30 + lNameLen + lExtraLen;
    if (u16(local + 6) !== flags || u16(local + 8) !== method || lNameLen !== nameLen) fail('zip_header_conflict');
    if (start > cdStart || zip.subarray(local + 30, local + 30 + lNameLen).some((byte, i) => byte !== zip[pos + 46 + i])) fail('zip_header_conflict');
    if (!(flags & 0x08) && (u32(local + 14) !== crc || u32(local + 18) !== csize || u32(local + 22) !== size)) fail('zip_header_conflict');
    if (start + csize > cdStart) fail('zip_data_range');
    spans.push([local, start + csize]);
    entries.push({ path, dir, method, crc, csize, size, start });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (pos !== end) fail('zip_central_directory');
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) fail('zip_overlap');
  const files = [];
  for (const entry of entries) {
    if (entry.dir) continue;
    const raw = zip.subarray(entry.start, entry.start + entry.csize);
    let data;
    if (entry.method === 0) { if (entry.csize !== entry.size) fail('zip_stored_size'); data = raw; }
    else { try { data = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) + 1 }); } catch { fail('zip_inflate'); } }
    if (data.length !== entry.size || crc32(data) !== entry.crc) fail('zip_crc');
    const signature = data.subarray(0, 4);
    if ((data[0] === 0x4D && data[1] === 0x5A) || (signature.length === 4 && [0x7F454C46, 0xFEEDFACE, 0xFEEDFACF, 0xCEFAEDFE, 0xCFFAEDFE].includes(new DataView(signature.buffer, signature.byteOffset, 4).getUint32(0)))) fail('zip_native_executable');
    files.push({ path: entry.path, size: entry.size, sha256: sha256(data) });
  }
  const root = files.find(file => /^index\.html?$/i.test(file.path));
  let entry = root?.path;
  if (!entry) {
    const wrapped = files.filter(file => /^[^/]+\/index\.html?$/i.test(file.path));
    if (wrapped.length !== 1) fail('zip_entry_point');
    entry = wrapped[0].path;
  }
  return { entry, files, unpacked: total };
}

/** Inspect a ZWF2 container: header, manifest schema, zip_sha256 and per-file records. */
export function inspectZwf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) fail('zwf_header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'ZWF2' || view.getUint16(4, true) !== 2 || view.getUint16(6, true) !== 0) fail('zwf_header');
  const jsonLength = view.getUint32(8, true), zipLength = view.getUint32(12, true);
  if (jsonLength > LIMITS.manifestBytes || zipLength > LIMITS.archiveBytes || 16 + jsonLength + zipLength !== bytes.length) fail('zwf_lengths');
  const text = decode(bytes.subarray(16, 16 + jsonLength), 'zwf_manifest_encoding');
  if (text.charCodeAt(0) === 0xFEFF) fail('zwf_manifest_bom');
  let manifest;
  try { manifest = JSON.parse(text); } catch { fail('zwf_manifest_json'); }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) fail('zwf_manifest_json');
  const zip = bytes.subarray(16 + jsonLength);
  if (manifest.format !== 'zwf' || manifest.version !== 2 || manifest.profile !== PROFILE) fail('zwf_manifest_profile');
  if (manifest.permissions === null || typeof manifest.permissions !== 'object' || manifest.permissions.network !== 'package-only' || manifest.permissions.storage !== 'none') fail('zwf_manifest_permissions');
  if (!validTitle(manifest.title)) fail('zwf_manifest_title');
  if (typeof manifest.zip_sha256 !== 'string' || !HEX64.test(manifest.zip_sha256) || manifest.zip_sha256 !== sha256(zip)) fail('zwf_zip_sha256');
  if (!safePath(manifest.entry_point)) fail('zwf_entry_point');
  const inspected = inspectZip(zip);
  if (manifest.entry_point !== inspected.entry) fail('zwf_entry_point');
  if (!Array.isArray(manifest.files) || manifest.files.length !== inspected.files.length) fail('zwf_files');
  manifest.files.forEach((file, i) => {
    const actual = inspected.files[i];
    if (file === null || typeof file !== 'object' || file.path !== actual.path || file.size !== actual.size || file.sha256 !== actual.sha256) fail('zwf_files');
  });
  return { manifest, zip: inspected };
}
/** 1–100 Unicode characters, not whitespace-only, no control characters. */
export const validTitle = title => typeof title === 'string' && [...title].length >= 1 && [...title].length <= 100 && title.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(title);

/**
 * Validate a complete local package and describe it for upload. Detection is by content, never by
 * extension: ZWF2 magic → zwf, otherwise ZIP. `validator` may be the public @zuku/zwf module; when
 * given, its inspection must agree with the built-in one.
 */
export async function inspectPackage(bytes, { validator } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1) fail('package_empty');
  if (bytes.length > LIMITS.archiveBytes + 16 + LIMITS.manifestBytes) fail('package_too_large');
  const isZwf = bytes.length >= 4 && bytes[0] === 0x5A && bytes[1] === 0x57 && bytes[2] === 0x46 && bytes[3] === 0x32;
  let entry, fileCount, title, admissionFormat;
  if (isZwf) {
    const { manifest, zip } = inspectZwf(bytes);
    entry = zip.entry; fileCount = zip.files.length; title = manifest.title; admissionFormat = 'zwf';
  } else {
    const zip = inspectZip(bytes);
    entry = zip.entry; fileCount = zip.files.length;
    // The service reports ZIP execution format, separately from the zip container format.
    admissionFormat = zip.files.some(file => file.path.toLowerCase().endsWith('.wasm')) ? 'wasm' : 'html5';
  }
  let validatorName = 'zukujs-builtin';
  if (validator) {
    try {
      // Public inspectZwf returns {manifest, zip: <raw ZIP bytes>}; inspectZip returns {entry, files}.
      let externalEntry, externalCount;
      if (isZwf) { const result = await validator.inspectZwf(bytes); externalEntry = result?.manifest?.entry_point; externalCount = result?.manifest?.files?.length; }
      else { const result = await validator.inspectZip(bytes); externalEntry = result?.entry; externalCount = result?.files?.length; }
      if (externalEntry !== entry || externalCount !== fileCount) fail('validator_disagreement');
    } catch (error) { if (error instanceof UploadError) throw error; fail('public_validator_rejected'); }
    validatorName = 'zukujs-builtin+@zuku/zwf';
  }
  return {
    format: isZwf ? 'zwf' : 'zip', kind: isZwf ? 'zwf' : 'archive', mediaType: isZwf ? 'application/zwf' : 'application/zip',
    filename: isZwf ? 'game.zwf' : 'game.zip', admission_format: admissionFormat, entry_point: entry, file_count: fileCount, title,
    size: bytes.length, sha256: sha256(bytes), validator: validatorName,
  };
}
