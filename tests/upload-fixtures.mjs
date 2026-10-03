// Test-only builders for deterministic ZIP/ZWF2 packages (not a *.test.mjs file, so node --test skips it).
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { crc32 } from '../lib/upload-package.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const PLAYABLE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>ZukuJS fixture</title></head><body><button id="b">0</button><script src="game.js"></script></body></html>';
export const PLAYABLE_JS = "let s=0;document.getElementById('b').onclick=e=>{e.target.textContent=String(++s);};";

/** files: [{ path, data (string|Uint8Array), method?: 0|8, external?: number }] in central-directory order. */
export function buildZip(files, { comment = '' } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const data = Buffer.from(file.data ?? '');
    const method = file.method ?? (data.length ? 8 : 0);
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = file.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(file.flags ?? 0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(file.flags ?? 0x0800, 8); central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(file.external ?? ((file.path.endsWith('/') ? 0o40755 : 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const commentBytes = Buffer.from(comment);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(commentBytes.length, 20);
  return new Uint8Array(Buffer.concat([...locals, cd, end, commentBytes]));
}

/** ZWF2 = 16-byte header + manifest JSON + ZIP. `edit` may mutate the manifest to build invalid fixtures. */
export function buildZwf(zip, { title = 'ZukuJS fixture game', entry = 'index.html', edit, files } = {}) {
  const records = files ?? listFiles(zip);
  const manifest = { format: 'zwf', version: 2, profile: 'html5-sandbox/2', entry_point: entry, title, permissions: { network: 'package-only', storage: 'none' }, zip_sha256: sha(zip), files: records };
  edit?.(manifest);
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  const header = Buffer.alloc(16);
  header.write('ZWF2', 0, 'ascii'); header.writeUInt16LE(2, 4); header.writeUInt16LE(0, 6); header.writeUInt32LE(json.length, 8); header.writeUInt32LE(zip.length, 12);
  return new Uint8Array(Buffer.concat([header, json, zip]));
}
const fixtureFiles = new WeakMap();
export function playableZip(extra = []) {
  const files = [{ path: 'index.html', data: PLAYABLE_HTML }, { path: 'game.js', data: PLAYABLE_JS }, ...extra];
  const zip = buildZip(files);
  fixtureFiles.set(zip, files.filter(f => !f.path.endsWith('/')).map(f => ({ path: f.path, size: Buffer.byteLength(f.data), sha256: sha(Buffer.from(f.data)) })));
  return zip;
}
function listFiles(zip) {
  const known = fixtureFiles.get(zip);
  if (!known) throw new Error('pass files explicitly for zips not built by playableZip');
  return known;
}
export const sha256Hex = sha;
