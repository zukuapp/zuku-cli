import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readGameCover, validateCover, uploadGameCover } from '../lib/game-cover.mjs';
import { buildDraftBody } from '../commands/upload.mjs';
import { multipartFraming } from '../lib/upload-client.mjs';

// Authored 1x1 RGBA PNG, with independently computed zlib/CRC golden bytes.
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const sha256 = '4ff6ab670a58c14270e034e2090d9a432caa263a14e0a25785386b0c12f880b5';
const hash = value => createHash('sha256').update(value).digest('hex');
async function screenshot(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'zukujs-cover-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = join(cwd, '.zukujs', 'agent'); await mkdir(dir, { recursive: true });
  const path = join(dir, 'thumbnail.png'); await writeFile(path, bytes, { mode: 0o600 });
  return { cwd, dir, thumbnail: { path, sha256 } };
}
test('screenshot pixels and all PNG bytes are bounded, checksummed and hash-bound', () => {
  assert.deepEqual(validateCover(bytes, sha256), { width: 1, height: 1, size: bytes.length, sha256 });
  for (const value of [Buffer.concat([bytes, Buffer.from('extra')]), Buffer.from(bytes), Buffer.alloc(20 * 1024 * 1024 + 1)]) {
    if (value.length === bytes.length) value[45] ^= 1;
    assert.throws(() => validateCover(value, hash(value)), { code: 'COVER_INVALID' });
  }
  assert.throws(() => validateCover(bytes, '0'.repeat(64)), { code: 'COVER_INVALID' });
  const trailing = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAFElEQVR4nGP4z8DwHwAFAAH/aWdub3JlZCR+FOMAAAAASUVORK5CYII=', 'base64');
  assert.throws(() => validateCover(trailing, hash(trailing)), { code: 'COVER_INVALID' });
});
test('only a complete ordinary screenshot inside agent state is admitted', async t => {
  const f = await screenshot(t);
  assert.equal((await readGameCover(f.thumbnail, f)).sha256, sha256);
  const outside = join(f.cwd, 'outside.png'); await writeFile(outside, bytes);
  await assert.rejects(readGameCover({ ...f.thumbnail, path: outside }, f), { code: 'COVER_INVALID' });
  const linked = join(f.dir, 'link.png'); await symlink(outside, linked);
  await assert.rejects(readGameCover({ ...f.thumbnail, path: linked }, f), { code: 'COVER_INVALID' });
  await link(f.thumbnail.path, join(f.dir, 'hardlink.png'));
  await assert.rejects(readGameCover(f.thumbnail, f), { code: 'COVER_INVALID' });
  await rm(f.dir, { recursive: true });
  const external = join(f.cwd, 'external'); await mkdir(external);
  const externalPNG = join(external, 'thumbnail.png'); await writeFile(externalPNG, bytes);
  await symlink(external, f.dir);
  await assert.rejects(readGameCover({ ...f.thumbnail, path: externalPNG }, f), { code: 'COVER_INVALID' });
});
test('cover upload checks the server image receipt and never replays an unknown mutation', async t => {
  const f = await screenshot(t); let calls = 0;
  const upload = { url: '/uploads/2026-10/cover.png', kind: 'image', mime: 'image/png', size: bytes.length, sha256 };
  const context = { ...f, accessToken: 'zuku_oa_' + 'a'.repeat(64), clientFactory: async () => ({ uploadPackage: async request => { calls++; assert.equal(request.filename, 'cover.png'); assert.ok(request.bytes.equals(bytes)); return { status: 201, envelope: { success: true, data: { upload } } }; } }) };
  const result = await uploadGameCover(f.thumbnail, context); assert.equal(result.verified, true); assert.equal(calls, 1);
  upload.sha256 = '0'.repeat(64);
  await assert.rejects(uploadGameCover(f.thumbnail, context), { code: 'COVER_OUTCOME_UNKNOWN' }); assert.equal(calls, 2);
  context.clientFactory = async () => ({ uploadPackage: async () => { calls++; throw Object.assign(new Error('private value'), { ambiguous: true }); } });
  await assert.rejects(uploadGameCover(f.thumbnail, context), error => error.code === 'COVER_OUTCOME_UNKNOWN' && !String(error).includes('private value')); assert.equal(calls, 3);
  context.clientFactory = async () => ({ uploadPackage: async () => { calls++; return { status: 503, envelope: { success: false } }; } });
  await assert.rejects(uploadGameCover(f.thumbnail, context), { code: 'COVER_OUTCOME_UNKNOWN' }); assert.equal(calls, 4);
});
test('thumbnail draft metadata is internal, bounded and admitted before requests', () => {
  const meta = {}, pkg = {}, upload = { url: '/uploads/2026-10/game.zip' };
  assert.equal(buildDraftBody(meta, pkg, upload, '/uploads/2026-10/cover.png').thumbnail_url, '/uploads/2026-10/cover.png');
  for (const value of ['https://evil.example/cover.png', '/uploads/../secret.png', '/uploads/2026-10/cover.png?token=private', 'private']) assert.throws(() => buildDraftBody(meta, pkg, upload, value), { code: 'UPLOAD_METADATA_INVALID' });
  assert.throws(() => multipartFraming(10, { filename: 'cover.png', mediaType: 'application/zip' }), { code: 'INVALID_INPUT' });
});
