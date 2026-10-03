import { createHash } from 'node:crypto';
import { deflateSync } from 'fflate';

// Minimal deterministic ZIP (PKWARE APPNOTE 6.3) writer. Reading/admission is done by the
// vendored @zuku/zwf inspectZip. No ZIP64: zwf rejects it and caps archives at 500 MiB.
export const ZIP_MAX_ENTRIES = 0xffff;
const FIXED_DOS_TIME = 0; // 00:00:00
const FIXED_DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, the earliest DOS date
const UTF8_FLAG = 0x0800;
const RATIO_MIN_BYTES = 1024 ** 2, RATIO_MAX = 80; // zwf LIMITS.ratio
const FILE_MODE = 0o100644;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes, previous = 0) {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Deterministic writer: callers add entries in final order; timestamps, attributes
 * and compression settings are fixed so identical input yields identical bytes.
 * `write(buffer)` must append to the output and resolve when done.
 */
export function zipWriter(write, { maxBytes = Infinity } = {}) {
  const central = [];
  const hash = createHash('sha256');
  let offset = 0;
  const emit = async buffer => {
    if (offset + buffer.length > maxBytes) { const error = new RangeError('zip size limit'); error.zipLimit = true; throw error; }
    hash.update(buffer);
    await write(buffer);
    offset += buffer.length;
  };
  return {
    get bytes() { return offset; },
    async add(name, data) {
      if (central.length >= ZIP_MAX_ENTRIES) throw new RangeError('zip entry limit');
      const nameBytes = Buffer.from(name, 'utf8');
      const crc = crc32(data);
      // fflate (pinned 0.8.3, pure JS) gives identical raw DEFLATE bytes on every Node build.
      const deflated = deflateSync(data, { level: 9, mem: 8 });
      // Store instead of deflate when zwf's 80:1 expansion-ratio budget (members >= 1 MiB) would trip.
      const ratioOk = data.length < RATIO_MIN_BYTES || data.length <= Math.max(deflated.length, 1) * RATIO_MAX;
      const method = deflated.length < data.length && ratioOk ? 8 : 0;
      const payload = method === 8 ? deflated : data;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(UTF8_FLAG, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(FIXED_DOS_TIME, 10);
      local.writeUInt16LE(FIXED_DOS_DATE, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(payload.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      local.writeUInt16LE(0, 28);
      central.push({ nameBytes, crc, method, compressed: payload.length, size: data.length, offset });
      await emit(Buffer.concat([local, nameBytes]));
      await emit(payload);
    },
    async finish() {
      const start = offset;
      for (const entry of central) {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE((3 << 8) | 20, 4); // made by UNIX, spec 2.0
        header.writeUInt16LE(20, 6);
        header.writeUInt16LE(UTF8_FLAG, 8);
        header.writeUInt16LE(entry.method, 10);
        header.writeUInt16LE(FIXED_DOS_TIME, 12);
        header.writeUInt16LE(FIXED_DOS_DATE, 14);
        header.writeUInt32LE(entry.crc, 16);
        header.writeUInt32LE(entry.compressed, 20);
        header.writeUInt32LE(entry.size, 24);
        header.writeUInt16LE(entry.nameBytes.length, 28);
        // extra, comment, disk start, internal attributes stay 0
        header.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
        header.writeUInt32LE(entry.offset, 42);
        await emit(Buffer.concat([header, entry.nameBytes]));
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(central.length, 8);
      end.writeUInt16LE(central.length, 10);
      end.writeUInt32LE(offset - start, 12);
      end.writeUInt32LE(start, 16);
      await emit(end);
      return { bytes: offset, sha256: hash.digest('hex'), entries: central.length };
    },
  };
}
