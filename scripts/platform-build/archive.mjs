// Reproducible archives: sorted entries, fixed owner/mode/timestamp, stable gzip header.
// The same entry bytes and source timestamp always yield the same archive SHA-256.
import zlib from 'node:zlib';
import { zipSync, unzipSync } from 'fflate';
import { PlatformBuildError } from './matrix.mjs';
import { relativePath } from './fs-safety.mjs';

export const ARCHIVE_ROOT = 'zuku-studio';
const MAX_ENTRIES = 8192;
const MAX_EXPANDED = 768 * 1024 * 1024;
const fail = (code, message) => { throw new PlatformBuildError(code, message); };

export function sourceEpoch(value) {
  const epoch = Number(value);
  // Zip DOS timestamps start at 1980; keep tar and zip on the same rule.
  if (!Number.isSafeInteger(epoch) || epoch < 315532800 || epoch >= 4102444800) fail('EPOCH_INVALID', 'Source timestamp must be whole seconds between 1980 and 2100.');
  return epoch;
}

function normalizeEntries(entries) {
  const files = new Map();
  for (const entry of entries) {
    const name = relativePath(entry.path, 'archive entry');
    if (files.has(name)) fail('ARCHIVE_DUPLICATE', `Duplicate archive entry: ${name}`);
    if (!(entry.bytes instanceof Uint8Array)) fail('ARCHIVE_INVALID', 'Archive entries need bytes.');
    files.set(name, { bytes: entry.bytes, executable: Boolean(entry.executable) });
  }
  return [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function octal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  if (text.length > length - 1) fail('ARCHIVE_INVALID', 'Tar field overflow.');
  buffer.write(`${text}\0`, offset, length, 'ascii');
}

function tarHeader(name, { size, mode, mtime, directory }) {
  const header = Buffer.alloc(512);
  let prefix = '', base = name;
  if (Buffer.byteLength(name) > 100) {
    // First split (shortest prefix) that fits both ustar fields.
    let cut = -1;
    for (let i = name.indexOf('/'); i >= 0 && i < name.length - 1; i = name.indexOf('/', i + 1)) {
      if (Buffer.byteLength(name.slice(i + 1)) <= 100 && Buffer.byteLength(name.slice(0, i)) <= 155) { cut = i; break; }
    }
    if (cut < 0) fail('ARCHIVE_INVALID', `Archive path is too long: ${name}`);
    prefix = name.slice(0, cut); base = name.slice(cut + 1);
  }
  header.write(base, 0, 100, 'utf8');
  octal(header, 100, 8, mode); octal(header, 108, 8, 0); octal(header, 116, 8, 0);
  octal(header, 124, 12, size); octal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header.write(directory ? '5' : '0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0; for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

export function createTarGz(entries, epoch) {
  const mtime = sourceEpoch(epoch);
  const files = normalizeEntries(entries);
  const directories = new Set([ARCHIVE_ROOT]);
  for (const [name] of files) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(`${ARCHIVE_ROOT}/${parts.slice(0, i).join('/')}`);
  }
  const chunks = [];
  for (const directory of [...directories].sort()) chunks.push(tarHeader(`${directory}/`, { size: 0, mode: 0o755, mtime, directory: true }));
  for (const [name, { bytes, executable }] of files) {
    chunks.push(tarHeader(`${ARCHIVE_ROOT}/${name}`, { size: bytes.length, mode: executable ? 0o755 : 0o644, mtime }));
    chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    if (bytes.length % 512) chunks.push(Buffer.alloc(512 - (bytes.length % 512)));
  }
  chunks.push(Buffer.alloc(1024));
  const gz = zlib.gzipSync(Buffer.concat(chunks), { level: 9, memLevel: 9 });
  gz.writeUInt32LE(0, 4); // no gzip timestamp
  gz[9] = 255; // "unknown" OS so Linux and macOS hosts produce identical headers
  return gz;
}

// Walk the central directory (no comment, no zip64) and return each entry's header offsets.
function centralEntries(zip) {
  const end = zip.length - 22;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) fail('ARCHIVE_UNSAFE', 'Unsupported zip end record.');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50) fail('ARCHIVE_UNSAFE', 'Corrupt zip central directory.');
    const nameLength = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    if (local + 30 > offset || zip.readUInt32LE(local) !== 0x04034b50) fail('ARCHIVE_UNSAFE', 'Corrupt zip local header.');
    entries.push({ central: offset, local, name: zip.toString('utf8', offset + 46, offset + 46 + nameLength), externalAttributes: zip.readUInt32LE(offset + 38), madeBy: zip[offset + 5] });
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}

// fflate encodes DOS time with local-time getters (time-zone and DST dependent), so the
// fields are rewritten from UTC afterwards. Header timestamps are outside every CRC.
function dosStamp(epoch) {
  const d = new Date(epoch * 1000);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export function createZip(entries, epoch) {
  const { time, date } = dosStamp(sourceEpoch(epoch));
  const placeholder = new Date(2000, 0, 1, 12, 0, 0);
  const tree = {};
  for (const [name, { bytes }] of normalizeEntries(entries)) tree[`${ARCHIVE_ROOT}/${name}`] = [bytes, { level: 9, mtime: placeholder, os: 0, attrs: 0 }];
  const zip = Buffer.from(zipSync(tree, { level: 9, mtime: placeholder, os: 0, attrs: 0 }));
  for (const entry of centralEntries(zip)) {
    zip.writeUInt16LE(time, entry.central + 12); zip.writeUInt16LE(date, entry.central + 14);
    zip.writeUInt16LE(time, entry.local + 10); zip.writeUInt16LE(date, entry.local + 12);
  }
  return zip;
}

export const createArchive = (format, entries, epoch) => format === 'zip' ? createZip(entries, epoch) : format === 'tar.gz' ? createTarGz(entries, epoch) : fail('ARCHIVE_INVALID', 'Unsupported archive format.');

const entryName = raw => {
  if (!raw.startsWith(`${ARCHIVE_ROOT}/`)) fail('ARCHIVE_UNSAFE', 'Archive entry escapes the asset root.');
  return relativePath(raw.slice(ARCHIVE_ROOT.length + 1), 'archive entry');
};

/** Strict reader used by verification: only regular files and directories under the root. */
export function readTarGz(bytes) {
  const tar = zlib.gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED });
  const files = new Map();
  let offset = 0, count = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    if (++count > MAX_ENTRIES) fail('ARCHIVE_UNSAFE', 'Too many archive entries.');
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (parseInt(header.toString('ascii', 148, 155), 8) !== sum || header.toString('ascii', 257, 263) !== 'ustar\0') fail('ARCHIVE_UNSAFE', 'Corrupt tar header.');
    const field = (start, length) => header.toString('utf8', start, start + length).replace(/\0.*$/s, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = parseInt(field(124, 12), 8), type = String.fromCharCode(header[156]);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) fail('ARCHIVE_UNSAFE', 'Corrupt tar entry size.');
    if (type === '5') { if (name !== `${ARCHIVE_ROOT}/`) entryName(name.replace(/\/$/, '')); }
    else if (type === '0') {
      const rel = entryName(name);
      if (files.has(rel)) fail('ARCHIVE_UNSAFE', `Duplicate archive entry: ${rel}`);
      files.set(rel, { bytes: tar.subarray(offset + 512, offset + 512 + size), mode: parseInt(field(100, 8), 8) });
    } else fail('ARCHIVE_UNSAFE', 'Archive contains a link or special entry.');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

export function readZip(bytes) {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  for (const entry of centralEntries(zip)) {
    const type = (entry.externalAttributes >>> 16) & 0o170000;
    // Unix-made entries may only be regular files or directories; never links or devices.
    if (entry.madeBy === 3 && type && type !== 0o100000 && type !== 0o040000) fail('ARCHIVE_UNSAFE', 'Archive contains a link or special entry.');
    if (entry.name === `${ARCHIVE_ROOT}/`) continue;
    if (entry.name.endsWith('/')) entryName(entry.name.slice(0, -1));
    else entryName(entry.name);
  }
  let count = 0;
  const raw = unzipSync(bytes, { filter: info => {
    if (++count > MAX_ENTRIES || info.originalSize > MAX_EXPANDED) fail('ARCHIVE_UNSAFE', 'Archive is too large.');
    return true;
  } });
  const names = Object.keys(raw);
  if (names.length !== count) fail('ARCHIVE_UNSAFE', 'Duplicate archive entry.');
  const files = new Map();
  for (const name of names) if (!name.endsWith('/')) files.set(entryName(name), { bytes: raw[name], mode: null });
  return files;
}

export const readArchive = (format, bytes) => format === 'zip' ? readZip(bytes) : readTarGz(bytes);
