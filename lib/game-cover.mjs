import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import { CommandError } from './errors.mjs';
import { uploadClient } from './upload-client.mjs';
import { DEFAULT_BASE_URL } from './api-client.mjs';
import { readZukuAccessToken } from './accounts/store.mjs';
import { oauthAccessToken } from './accounts/client.mjs';

const LIMIT = 20 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const URL_PATH = /^\/uploads\/[0-9]{4}-[0-9]{2}\/[A-Za-z0-9_-]{1,128}\.png$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const table = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; };
export class CoverError extends CommandError {
  constructor(code) {
    super('COMMAND_FAILED');
    const messages = { COVER_INVALID: '브라우저 화면 캡처의 PNG·해시·경로 검증에 실패했습니다.', COVER_RECEIPT_INVALID: '썸네일 업로드의 서버 응답을 확인하지 못했습니다.', COVER_OUTCOME_UNKNOWN: '썸네일 업로드 결과가 불명확합니다. 자동으로 다시 업로드하지 않았습니다.' };
    if (Object.hasOwn(messages, code)) { this.code = code; this.message = messages[code]; }
  }
}

/** Decode bounded screenshot pixels, validate chunk checksums and reject trailing/metadata data. */
export function validateCover(bytes, expectedHash) {
  const fail = () => { throw new CoverError('COVER_INVALID'); };
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT || bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG) || !/^[a-f0-9]{64}$/.test(expectedHash ?? '') || hash(bytes) !== expectedHash) fail();
  let offset = 8, width, height, channels, ended = false, seenData = false;
  const compressed = [];
  for (let count = 0; offset < bytes.length && count < 4096; count++) {
    if (offset + 12 > bytes.length) fail();
    const size = bytes.readUInt32BE(offset), end = offset + size + 12;
    if (size > LIMIT || end > bytes.length) fail();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail();
    const data = bytes.subarray(offset + 8, end - 4);
    if (type === 'IHDR' && count === 0 && size === 13) {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (!width || !height || width > 4096 || height > 4096 || width * height > 8388608 || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) fail();
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT' && width && !ended) { seenData = true; compressed.push(data); }
    else if (type === 'IEND' && size === 0 && seenData && end === bytes.length) ended = true;
    else fail();
    offset = end;
  }
  if (!ended || offset !== bytes.length) fail();
  const row = width * channels + 1, expected = height * row;
  let pixels;
  const stream = Buffer.concat(compressed);
  try {
    const inflated = inflateSync(stream, { maxOutputLength: expected, info: true });
    if (inflated.engine.bytesWritten !== stream.length) fail();
    pixels = inflated.buffer;
  } catch { fail(); }
  if (pixels.length !== expected) fail();
  for (let index = 0; index < pixels.length; index += row) if (pixels[index] > 4) fail();
  return { width, height, size: bytes.length, sha256: expectedHash };
}

/** Admit only the coordinator's screenshot file inside its private project state directory. */
export async function readGameCover(thumbnail, { cwd = process.cwd(), thumbnailDirectory = resolve(cwd, '.zukujs', 'agent') } = {}) {
  if (!thumbnail || typeof thumbnail.path !== 'string' || !isAbsolute(thumbnail.path)) throw new CoverError('COVER_INVALID');
  let handle;
  try {
    const workspace = await realpath(cwd), declaredBase = resolve(thumbnailDirectory);
    const baseRelative = relative(workspace, declaredBase);
    if (isAbsolute(baseRelative) || baseRelative === '..' || baseRelative.startsWith(`..${sep}`)) throw new CoverError('COVER_INVALID');
    // Inspect the declared state path before resolving it. Resolving a symlink
    // first would mistakenly admit an external screenshot directory.
    for (let cursor = declaredBase; ; cursor = dirname(cursor)) {
      const stat = await lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoverError('COVER_INVALID');
      if (cursor === workspace) break;
    }
    const base = await realpath(declaredBase), file = resolve(thumbnail.path), rel = relative(base, file);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new CoverError('COVER_INVALID');
    for (let cursor = dirname(file); ; cursor = dirname(cursor)) {
      const stat = await lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoverError('COVER_INVALID');
      if (cursor === base) break;
    }
    const named = await lstat(file);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > LIMIT) throw new CoverError('COVER_INVALID');
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (stat.dev !== named.dev || stat.ino !== named.ino || stat.size !== named.size || stat.nlink !== 1) throw new CoverError('COVER_INVALID');
    const buffer = Buffer.alloc(stat.size + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new CoverError('COVER_INVALID');
    const bytes = buffer.subarray(0, bytesRead), meta = validateCover(bytes, thumbnail.sha256);
    return { bytes, ...meta };
  } catch (error) { if (error instanceof CoverError) throw error; throw new CoverError('COVER_INVALID'); }
  finally { await handle?.close(); }
}

export async function uploadGameCover(thumbnail, context = {}) {
  const cover = await readGameCover(thumbnail, context);
  if (context.signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
  const token = context.accessToken ?? await (context.zukuCredentials ?? readZukuAccessToken)({ ...context.accountStoreOptions, signal: context.signal });
  if (!oauthAccessToken(token)) throw new CommandError('UNAUTHORIZED');
  const baseUrl = context.baseUrl ?? DEFAULT_BASE_URL;
  const client = await (context.clientFactory ?? uploadClient)(baseUrl, { accessToken: token, signal: context.signal });
  let result;
  try { result = await client.uploadPackage({ bytes: cover.bytes, filename: 'cover.png', mediaType: 'image/png' }); }
  catch (error) { if (error?.ambiguous) throw new CoverError('COVER_OUTCOME_UNKNOWN'); throw error; }
  if (result.status >= 400 && result.status < 500 && result.status !== 408 && result.envelope?.success === false) throw client.apiFailure(result.status, result.envelope, 'upload');
  const uploaded = result.status === 201 && result.envelope?.success === true ? result.envelope.data?.upload : undefined;
  if (!uploaded || uploaded.kind !== 'image' || uploaded.mime !== 'image/png' || uploaded.size !== cover.size || uploaded.sha256 !== cover.sha256 || !URL_PATH.test(uploaded.url ?? '') || uploaded.package != null) throw new CoverError('COVER_OUTCOME_UNKNOWN');
  return { url: uploaded.url, verified: true, width: cover.width, height: cover.height, size_bytes: cover.size, sha256: cover.sha256 };
}
