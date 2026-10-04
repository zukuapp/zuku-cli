import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, chmod, symlink, truncate, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import upload, { runUpload } from '../commands/upload.mjs';
import { uploadClient, multipartFraming, MAX_MULTIPART_BYTES } from '../lib/upload-client.mjs';
import { inspectPackage, inspectZip, LIMITS } from '../lib/upload-package.mjs';
import { buildReceipt, writeReceipt, prepareReceiptDir } from '../lib/upload-receipt.mjs';
import { projectPackager } from '../lib/upload-project.mjs';
import { validateManifest, normalizeManifest } from '../lib/manifest-reader.mjs';
import { buildZip, buildZwf, playableZip, sha256Hex, PLAYABLE_HTML, PLAYABLE_JS } from './upload-fixtures.mjs';

const token = 'fixture_only_upload_token';
const privateValue = 'fixture_only_private_echo';
const SECRETS = [token, privateValue, 'usr_private_91', 'req_fixture_private', 'request_id', 'session='];
const ok = data => ({ success: true, data, meta: { request_id: 'req_fixture_private', version: 'v1' } });
const failure = (code, details) => ({ success: false, error: { code, message: `${token} ${privateValue}`, details }, meta: { request_id: 'req_fixture_private' } });
const ZWF = buildZwf(playableZip());
const WRAPPED_ZIP = buildZip([{ path: 'release/' }, { path: 'release/index.html', data: PLAYABLE_HTML }, { path: 'release/game.js', data: PLAYABLE_JS }]);
const pkgOf = (bytes, { zip = false, entry = 'index.html', count = 2 } = {}) => {
  const ext = zip ? 'zip' : 'zwf';
  const admission = zip ? (inspectZip(bytes).files.some(file => file.path.toLowerCase().endsWith('.wasm')) ? 'wasm' : 'html5') : 'zwf';
  return { bytes, ext, admission, name: `game.${ext}`, kind: zip ? 'archive' : 'zwf', mime: `application/${ext}`, sha: sha256Hex(bytes), size: bytes.length, entry, count };
};
const P = pkgOf(ZWF);
const UPLOAD_URL = '/uploads/2026-10/fx_upload_01.zwf';
const uploadReply = (p, patch = {}) => [201, ok({ upload: { url: `/uploads/2026-10/fx_upload_01.${p.ext}`, kind: p.kind, mime: p.mime, size: p.size, sha256: p.sha, original_name: p.name, owner: { id: 'usr_private_91', email: privateValue }, ...patch, package: { format: p.admission, entry_point: p.entry, scan: 'clean', file_count: p.count, ...patch.package } } })];
const draftReply = status => entry => [201, ok({ content: { id: 'cnt_fixture_01', author: { id: 'usr_private_91', email: privateValue }, jump: { status: status ?? JSON.parse(entry.body).jump.status } } })];
const allRequests = [];
const assertClean = (value, label) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${label} leaked ${secret}`);
};

/** Local fixture; requests are recorded on arrival (before the body ends) so hung requests still count. */
async function fixture(t, routes) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const entry = { method: req.method, path: req.url, headers: req.headers, raw: Buffer.alloc(0), body: '' };
    requests.push(entry); allRequests.push(entry);
    const chunks = [];
    try { for await (const chunk of req) chunks.push(chunk); } catch { return; }
    entry.raw = Buffer.concat(chunks); entry.body = entry.raw.toString('latin1');
    const route = routes[req.url.replace(/^\/api\/v1/, '')];
    const reply = typeof route === 'function' ? route(entry) : route;
    if (reply === 'hang') return;
    const [status, body, headers = {}] = reply ?? [404, failure('NOT_FOUND')];
    res.writeHead(status, { 'Content-Type': 'application/json', 'Set-Cookie': `session=${privateValue}; HttpOnly`, ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}/api/v1`, requests };
}
async function receipts(dir, sub = join('.zukujs', 'receipts')) {
  let names;
  try { names = await readdir(join(dir, sub)); } catch { return []; }
  return Promise.all(names.map(async name => {
    const text = await readFile(join(dir, sub, name), 'utf8');
    return { name, mode: (await lstat(join(dir, sub, name))).mode & 0o777, text, json: JSON.parse(text) };
  }));
}
async function workdir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zukujs-upload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** Run the command against a fresh fixture + temp cwd; resolves {result|error, requests, credentialCalls, receipts}. */
async function run(t, { pkg = P, bytes = pkg.bytes, name = pkg.name, args = [name], upload: up, contents, prepare, baseUrl, timeouts, context = {}, command = runUpload } = {}) {
  const dir = await workdir(t);
  if (bytes) await writeFile(join(dir, name), bytes);
  await prepare?.(dir);
  const f = await fixture(t, { '/uploads': up ?? uploadReply(pkg), '/contents': contents ?? draftReply() });
  const state = { credentialCalls: 0 };
  const outcome = await command(args, {
    cwd: dir, baseUrl: baseUrl ?? f.origin, credentials: async () => { state.credentialCalls++; return token; },
    clientFactory: (b, o) => uploadClient(b, { ...o, allowFixtureOrigin: true, timeouts: { upload: 3000, json: 3000, ...timeouts } }), ...context,
  }).then(result => ({ result }), error => ({ error }));
  if (outcome.error) assertClean(String(outcome.error.stack) + JSON.stringify(outcome.error), 'error');
  if (outcome.result) assertClean(outcome.result, 'output');
  const saved = await receipts(dir);
  for (const receipt of saved) { assertClean(receipt.text, 'receipt'); assert.equal(receipt.mode, 0o600); assert.equal(receipt.json.published, false); }
  return { ...outcome, dir, requests: f.requests, credentialCalls: state.credentialCalls, receipts: saved };
}
const failed = async (t, code, options, extra) => {
  const r = await run(t, options);
  assert.equal(r.result, undefined, `expected ${code}`); assert.equal(r.error.code, code);
  if (extra?.reason) assert.equal(r.error.reason, extra.reason);
  return r;
};

test('internal deployment key reaches only draft creation; invalid keys cause no credential or HTTP access', async t => {
  const key = 'deployment_fixture:revision-01';
  const accepted = await run(t, { context: { idempotencyKey: key } });
  assert.ok(accepted.result);
  assert.equal(accepted.requests[0].headers['idempotency-key'], undefined);
  assert.equal(accepted.requests[1].headers['idempotency-key'], key);
  for (const invalid of ['short', 'x'.repeat(129), 'deployment\r\nInjected: yes', 'deployment/?query', {}, null]) {
    const denied = await failed(t, 'INVALID_INPUT', { context: { idempotencyKey: invalid } });
    assert.equal(denied.credentialCalls, 0);
    assert.equal(denied.requests.length, 0);
  }
});

test('verified draft upload for .zwf, plain .zip and wrapper-dir .zip: exact multipart, bearer only, draft-only body', async t => {
  const cases = [[P, []], [pkgOf(playableZip(), { zip: true }), ['--title', 'Zip Game']], [pkgOf(WRAPPED_ZIP, { zip: true, entry: 'release/index.html' }), ['--title', 'Wrapped Game']]];
  for (const [pkg, flags] of cases) {
    const r = await run(t, { pkg, args: [pkg.name, ...flags] });
    assert.ok(r.result, `upload of ${pkg.name}/${pkg.entry} failed: ${r.error?.code} ${r.error?.reason}`);
    assert.deepEqual(r.requests.map(q => `${q.method} ${q.path}`), ['POST /api/v1/uploads', 'POST /api/v1/contents']);
    for (const q of r.requests) {
      assert.equal(q.headers.authorization, `Bearer ${token}`); assert.equal(q.headers.cookie, undefined); assert.equal(q.headers['transfer-encoding'], undefined);
      assert.equal(Number(q.headers['content-length']), q.raw.length);
      assert.deepEqual(Object.keys(q.headers).filter(key => !['host', 'accept', 'authorization', 'connection', 'content-type', 'content-length'].includes(key)), []);
    }
    const [up, draft] = r.requests;
    const boundary = /^multipart\/form-data; boundary=([A-Za-z0-9-]+)$/.exec(up.headers['content-type'])[1];
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${pkg.name}"\r\nContent-Type: ${pkg.mime}\r\n\r\n`;
    assert.equal(up.body.split('Content-Disposition').length, 2);
    assert.ok(up.body.startsWith(head)); assert.ok(up.body.endsWith(`\r\n--${boundary}--\r\n`));
    assert.deepEqual(up.raw.subarray(head.length, up.raw.length - boundary.length - 8), Buffer.from(pkg.bytes));
    assert.equal(draft.headers['content-type'], 'application/json');
    const body = JSON.parse(draft.body);
    const url = `/uploads/2026-10/fx_upload_01.${pkg.ext}`;
    assert.equal(body.category, 'jump'); assert.equal(body.jump.status, 'draft'); assert.equal(body.publish_to_thread, false);
    assert.equal(body.media_url, url); assert.equal(body.jump.package.url, url);
    assert.deepEqual([body.jump.package.hash, body.jump.package.size_bytes, body.jump.package.format, body.jump.package.entry_point], [pkg.sha, pkg.size, pkg.ext, pkg.entry]);
    assert.equal(r.result.published, false); assert.equal(r.result.status, 'draft_created'); assert.deepEqual(r.result.content, { id: 'cnt_fixture_01', status: 'draft' });
    assert.deepEqual(r.result.upload, { url, verified: true }); assert.equal(r.result.package.sha256, pkg.sha); assert.equal(r.result.verification.performed, false);
    assert.equal(r.receipts.length, 1); assert.equal(r.result.receipt.path, `.zukujs/receipts/${r.receipts[0].name}`);
    assert.deepEqual([r.receipts[0].json.state, r.receipts[0].json.upload.url, r.receipts[0].json.draft.content_id, r.receipts[0].json.package.sha256], ['draft_created', url, 'cnt_fixture_01', pkg.sha]);
    assert.equal(r.credentialCalls, 1);
  }
});
test('directory input is packaged only through the injected core, then uploaded as a draft', async t => {
  let calls = 0;
  const core = { packageProject: async () => { calls++; return { bytes: ZWF, metadata: { title: 'Core Title', tags: ['arcade'] } }; } };
  const r = await run(t, { bytes: null, args: ['project'], prepare: dir => mkdir(join(dir, 'project')), context: { core } });
  assert.equal(r.result.status, 'draft_created'); assert.equal(calls, 1);
  assert.deepEqual([JSON.parse(r.requests[1].body).title, JSON.parse(r.requests[1].body).tags], ['Core Title', ['arcade']]);
});
test('server receipt execution format is html5/wasm for ZIP and zwf for ZWF2, with exact matching', async t => {
  const html = pkgOf(playableZip(), { zip: true });
  const wasm = pkgOf(playableZip([{ path: 'engine.WASM', data: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) }]), { zip: true, count: 3 });
  for (const pkg of [html, wasm]) {
    const result = await run(t, { pkg, args: ['game.zip', '--title', 'ZIP receipt format'] });
    assert.equal(result.error, undefined);
    assert.equal(result.result.package.format, 'zip');
    assert.equal(JSON.parse(result.requests[1].body).jump.package.format, 'zip');
  }
  for (const [pkg, format] of [[html, 'zip'], [html, 'wasm'], [wasm, 'html5'], [P, 'html5'], [P, 'arbitrary']]) {
    const r = await failed(t, 'UPLOAD_RECEIPT_MISMATCH', { pkg, args: [pkg.name, '--title', 'Strict receipt'], upload: uploadReply(pkg, { package: { format } }) });
    assert.deepEqual(r.requests.map(q => q.path), ['/api/v1/uploads']);
    assert.equal(r.receipts[0].json.state, 'upload_unverified');
  }
});
test('default directory upload accepts canonical core project metadata without an injected packager', async t => {
  const manifest = {
    schema: 'zukujs-project/1', name: 'cross-command', title: 'Core Metadata',
    version: `${'1'.repeat(60)}.0.0`, description: 'Core description\nwith lines', tags: ['a'.repeat(30), 'comma,tag'],
    jump: { game_id: `game_${'A'.repeat(64)}`, genre: '2d_arcade', platform: { pc: true, mobile: false, tablet: false } },
  };
  assert.deepEqual(validateManifest(manifest), []);
  let packaged;
  const r = await run(t, { command: upload, bytes: null, args: ['project'],
    prepare: async dir => {
      const root = join(dir, 'project');
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'zukujs.json'), JSON.stringify(manifest));
      await writeFile(join(root, 'src', 'index.html'), PLAYABLE_HTML);
      await writeFile(join(root, 'src', 'game.js'), PLAYABLE_JS);
      packaged = await projectPackager.packageProject(root);
      assert.deepEqual(packaged.metadata, normalizeManifest(manifest));
    }, upload: () => uploadReply(pkgOf(packaged.bytes)),
  });
  assert.equal(r.error, undefined);
  assert.equal(r.result.status, 'draft_created');
  const body = JSON.parse(r.requests[1].body);
  assert.deepEqual([body.jump.game_id, body.jump.genre, body.jump.package.version, body.tags, body.description],
    [manifest.jump.game_id, manifest.jump.genre, manifest.version, manifest.tags, manifest.description]);
  assert.equal(r.receipts[0].json.package.version, manifest.version);
});
test('no implicit publish: --verify adds one owner GET; a non-draft state is DRAFT_STATE_UNEXPECTED', async t => {
  const v = await run(t, { args: ['game.zwf', '--verify'], contents: draftReply(), upload: uploadReply(P) });
  assert.deepEqual(v.requests.map(q => `${q.method} ${q.path}`), ['POST /api/v1/uploads', 'POST /api/v1/contents', 'GET /api/v1/contents/cnt_fixture_01']);
  assert.equal(v.requests[2].raw.length, 0); assert.equal(v.result.verification.performed, true); assert.equal(v.result.published, false);
  const r = await failed(t, 'DRAFT_STATE_UNEXPECTED', { contents: draftReply('published') });
  assert.equal(r.requests.length, 2); assert.equal(r.receipts.length, 1);
  assert.deepEqual([r.receipts[0].json.state, r.receipts[0].json.draft.status, r.receipts[0].json.upload.url], ['draft_unexpected_state', 'published', UPLOAD_URL]);
  assert.equal(r.error.receipt.saved, true);
});
test('local rejection (schema/hash/size/path/metadata/args) reads no credentials and sends zero requests', async t => {
  const edit = fn => buildZwf(playableZip(), { edit: fn });
  const header = Buffer.from(ZWF); header.writeUInt32LE(LIMITS.archiveBytes + 1, 12);
  const sparse = async dir => { await writeFile(join(dir, 'game.zwf'), ''); await truncate(join(dir, 'game.zwf'), 600 * 1024 * 1024); };
  const cases = [
    ['PACKAGE_INVALID', { bytes: edit(m => { m.permissions.network = 'any'; }) }, 'zwf_manifest_permissions'],
    ['PACKAGE_INVALID', { bytes: edit(m => { m.profile = 'html5-sandbox/1'; }) }, 'zwf_manifest_profile'],
    ['PACKAGE_INVALID', { bytes: edit(m => { m.title = '   '; }) }, 'zwf_manifest_title'],
    ['PACKAGE_INVALID', { bytes: edit(m => { m.files[1].size += 1; }) }, 'zwf_files'],
    ['PACKAGE_INVALID', { bytes: edit(m => { m.files.pop(); }) }, 'zwf_files'],
    ['PACKAGE_INVALID', { bytes: edit(m => { m.zip_sha256 = '0'.repeat(64); }) }, 'zwf_zip_sha256'],
    ['PACKAGE_INVALID', { bytes: new Uint8Array(header) }, 'zwf_lengths'],
    ['PACKAGE_INVALID', { bytes: buildZip([{ path: 'index.html', data: PLAYABLE_HTML, crc: 0xdeadbeef }]), name: 'game.zip' }, 'zip_crc'],
    ['PACKAGE_INVALID', { bytes: playableZip([{ path: '../x.html', data: 'x' }]), name: 'game.zip' }, 'zip_unsafe_path'],
    ['PACKAGE_INVALID', { bytes: playableZip([{ path: 'INDEX.HTML', data: 'x' }]), name: 'game.zip' }, 'zip_case_collision'],
    ['PACKAGE_INVALID', { bytes: playableZip([{ path: 'link.js', data: 'index.html', external: (0o120777 << 16) >>> 0 }]), name: 'game.zip' }, 'zip_symlink'],
    ['PACKAGE_INVALID', { bytes: playableZip([{ path: 'secret.js', data: 'x', flags: 0x0801 }]), name: 'game.zip' }, 'zip_encrypted'],
    ['PACKAGE_INVALID', { bytes: playableZip([{ path: 'setup.exe', data: 'x' }]), name: 'game.zip' }, 'zip_asset_type'],
    ['PACKAGE_INVALID', { bytes: playableZip([{ path: 'core.wasm', data: Buffer.from([0x4d, 0x5a, 0x90, 0, 3]) }]), name: 'game.zip' }, 'zip_native_executable'],
    ['PACKAGE_INVALID', { bytes: playableZip([{ path: 'native.bin', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]) }]), name: 'game.zip' }, 'zip_native_executable'],
    ['UPLOAD_INPUT_TOO_LARGE', { bytes: null, prepare: sparse }],
    ['UPLOAD_INPUT_UNSAFE', { bytes: null, prepare: async dir => { await writeFile(join(dir, 'real.zwf'), ZWF); await symlink('real.zwf', join(dir, 'game.zwf')); } }],
    ['UPLOAD_INPUT_UNSAFE', { bytes: null }],
    ['UPLOAD_PACKAGER_UNAVAILABLE', { bytes: null, args: ['project'], prepare: dir => mkdir(join(dir, 'project')), context: { core: {} } }],
    ['UPLOAD_METADATA_INVALID', { args: ['game.zwf', '--title', ' \t '] }, 'title'],
    ['UPLOAD_METADATA_INVALID', { args: ['game.zwf', ...Array.from({ length: 11 }, (_, i) => ['--tag', `t${i}`]).flat()] }, 'tags'],
    ['UPLOAD_METADATA_INVALID', { args: ['game.zwf', '--age-rating', '21'] }, 'age_rating'],
    ['UPLOAD_METADATA_INVALID', { args: ['game.zwf', '--platform', 'console'] }, 'platform'],
    ['UPLOAD_METADATA_INVALID', { args: ['game.zwf', '--tag', 'a'.repeat(31)] }, 'tags'],
    ['UPLOAD_METADATA_INVALID', { args: ['game.zwf', '--game-id', 'game_' + 'A'.repeat(65)] }, 'game_id'],
    ['UPLOAD_METADATA_INVALID', { args: ['game.zwf', '--version', '1.0.0-beta'] }, 'version'],
    ['UPLOAD_METADATA_INVALID', { args: ['game.zwf', '--version', '1'.repeat(61) + '.0.0'] }, 'version'],
    ['UPLOAD_METADATA_INVALID', { bytes: playableZip(), name: 'game.zip' }, 'title'],
    ['INVALID_INPUT', { args: ['game.zwf', '--publish'] }],
    ['INVALID_INPUT', { args: ['game.zwf', '--title'] }],
    ['INVALID_INPUT', { args: ['game.zwf', '--verify', '--verify'] }],
    ['INVALID_INPUT', { args: [] }],
  ];
  for (const [code, options, reason] of cases) {
    const r = await failed(t, code, options, { reason });
    assert.equal(r.credentialCalls, 0, `${code}/${reason} read credentials`); assert.equal(r.requests.length, 0); assert.equal(r.receipts.length, 0);
  }
});
test('size bounds: multipart framing and inspectPackage refuse oversize bytes before any request', async () => {
  const overhead = multipartFraming(0, { filename: 'game.zwf', mediaType: 'application/zwf' }).contentLength;
  assert.equal(multipartFraming(10, { filename: 'game.zwf', mediaType: 'application/zwf' }).contentLength, overhead + 10);
  for (const [filename, mediaType] of [['evil.zwf', 'application/zwf'], ['game.zwf', 'text/html'], ['game.zwf"; x="', 'application/zwf']]) assert.throws(() => multipartFraming(1, { filename, mediaType }), { code: 'INVALID_INPUT' });
  const fake = length => new (class extends Uint8Array { get length() { return length; } })(1);
  let calls = 0;
  const client = uploadClient('http://127.0.0.1:9/api/v1', { accessToken: token, allowFixtureOrigin: true, requestImpl: () => { calls++; throw Error(token); } });
  await assert.rejects(client.uploadPackage({ bytes: fake(MAX_MULTIPART_BYTES - overhead + 1), filename: 'game.zwf', mediaType: 'application/zwf' }), { code: 'UPLOAD_INPUT_TOO_LARGE' });
  await assert.rejects(client.uploadPackage({ bytes: new Uint8Array(0), filename: 'game.zwf', mediaType: 'application/zwf' }), { code: 'INVALID_INPUT' });
  await assert.rejects(inspectPackage(fake(LIMITS.archiveBytes + 16 + LIMITS.manifestBytes + 1)), { code: 'PACKAGE_INVALID', reason: 'package_too_large' });
  assert.equal(calls, 0);
});
test('API origin: only canonical https or explicit 127.0.0.1 fixture; never credentialed/query/foreign', async t => {
  for (const [origin, allowFixtureOrigin] of [['https://evil.example/api/v1', true], ['http://127.0.0.1:1234/api/v1', false], ['https://user:pass@www.zuzunza.com/api/v1', false], ['https://www.zuzunza.com/api/v1?x=1', false], ['https://www.zuzunza.com/api/v1#x', false], ['http://www.zuzunza.com/api/v1', false], ['https://www.zuzunza.com.evil.example/api/v1', false], ['http://localhost:1234/api/v1', true], ['http://127.0.0.1:1234/api/v1/', true], ['http://127.0.0.1:1234/api/v2', true], ['http://u:p@127.0.0.1:1234/api/v1', true], ['not a url', true]]) {
    assert.throws(() => uploadClient(origin, { accessToken: token, allowFixtureOrigin }), { code: 'API_ORIGIN_REJECTED' }, origin);
  }
  assert.throws(() => uploadClient(undefined, { accessToken: `${token}\r\nX: y` }), { code: 'UNAUTHORIZED' });
  const r = await failed(t, 'API_ORIGIN_REJECTED', { context: { clientFactory: uploadClient } });
  assert.equal(r.requests.length, 0);
});
test('server upload receipt mismatches (url/hash/size/scan/count/kind) stop before any draft request', async t => {
  const patches = [{ url: 'https://evil.example/uploads/2026-10/x.zwf' }, { url: '/api/v1/uploads/..' }, { url: '/uploads/2026-10/../../x.zwf' }, { url: '/uploads/2026-10/x.zip' }, { url: `${UPLOAD_URL}?token=1` },
    { sha256: 'f'.repeat(64) }, { sha256: P.sha.toUpperCase() }, { size: P.size + 1 }, { size: String(P.size) }, { kind: 'archive' }, { mime: 'application/zip' },
    { package: { scan: 'pending' } }, { package: { file_count: 3 } }, { package: { entry_point: 'other.html' } }, { package: { format: 'zip' } }];
  for (const patch of patches) {
    const r = await failed(t, 'UPLOAD_RECEIPT_MISMATCH', { upload: uploadReply(P, patch) });
    assert.deepEqual(r.requests.map(q => q.path), ['/api/v1/uploads'], JSON.stringify(patch));
    assert.equal(r.receipts.length, 1); assert.equal(r.receipts[0].json.state, 'upload_unverified'); assert.equal(r.receipts[0].json.upload.verified, false);
    // A well-formed /uploads path of the wrong format is kept (marked unverified); anything else is dropped.
    if (patch.url) assert.equal(r.receipts[0].json.upload.url, patch.url === '/uploads/2026-10/x.zip' ? patch.url : null);
  }
  const same = await run(t, { upload: entry => uploadReply(P, { url: `http://${entry.headers.host}${UPLOAD_URL}` }) });
  assert.equal(same.result.upload.url, UPLOAD_URL); assert.equal(JSON.parse(same.requests[1].body).media_url, UPLOAD_URL);
});
test('redirects are never followed; ambiguous upload redirect saves upload_outcome_unknown', async t => {
  const r = await failed(t, 'API_REDIRECT_REJECTED', { upload: [307, '', { Location: 'https://evil.example/api/v1/uploads' }] });
  assert.equal(r.requests.length, 1); assert.equal(r.error.httpStatus, 307);
  assert.deepEqual([r.receipts.length, r.receipts[0].json.state, r.receipts[0].json.error.code, r.receipts[0].json.upload], [1, 'upload_outcome_unknown', 'API_REDIRECT_REJECTED', null]);
  const d = await failed(t, 'API_REDIRECT_REJECTED', { contents: [302, '', { Location: '/api/v1/contents/cnt_x/publish' }] });
  assert.equal(d.requests.length, 2); assert.equal(d.receipts[0].json.state, 'draft_outcome_unknown'); assert.equal(d.receipts[0].json.upload.url, UPLOAD_URL);
});
test('upload ok + draft 422 VALIDATION_ERROR: fields only, draft_rejected receipt keeps upload.url, no echo', async t => {
  const r = await failed(t, 'VALIDATION_ERROR', { contents: [422, failure('VALIDATION_ERROR', [{ field: 'title', message: token }, { field: token }, { field: privateValue }, { field: `${privateValue}!` }])] });
  assert.equal(r.requests.length, 2); assert.equal(r.error.httpStatus, 422); assert.deepEqual(r.error.fields, ['title']);
  const json = r.error.toJSON();
  assert.deepEqual([json.http_status, json.fields, json.receipt.saved], [422, ['title'], true]);
  assert.deepEqual([r.receipts[0].json.state, r.receipts[0].json.upload.url, r.receipts[0].json.upload.verified, r.receipts[0].json.error.code, r.receipts[0].json.error.http_status, r.receipts[0].json.draft], ['draft_rejected', UPLOAD_URL, true, 'VALIDATION_ERROR', 422, null]);
});
test('remote draft and owner status tokens are excluded from receipts and output', async t => {
  const unexpected = await failed(t, 'DRAFT_STATE_UNEXPECTED', { contents: draftReply(token) });
  assert.equal(unexpected.receipts[0].json.draft.status, null);
  const dir = await workdir(t);
  await writeFile(join(dir, 'game.zwf'), ZWF);
  const f = await fixture(t, { '/uploads': uploadReply(P), '/contents': draftReply(), '/contents/cnt_fixture_01': [200, ok({ content: { id: 'cnt_fixture_01', jump: { status: token } } })] });
  const result = await runUpload(['game.zwf', '--verify'], { cwd: dir, baseUrl: f.origin, credentials: async () => token, clientFactory: (b, o) => uploadClient(b, { ...o, allowFixtureOrigin: true }) });
  assertClean(result, 'verified status output');
  assert.deepEqual(result.verification, { performed: true, owner_visible: true, status: null });
});
test('ambiguous timeouts are never retried; connection refused is API_UNAVAILABLE with no receipt', async t => {
  const u = await failed(t, 'UPLOAD_OUTCOME_UNKNOWN', { upload: 'hang', timeouts: { upload: 200 } });
  await delay(100);
  assert.equal(u.requests.length, 1); assert.equal(u.receipts[0].json.state, 'upload_outcome_unknown'); assert.equal(u.receipts[0].json.upload, null);
  const d = await failed(t, 'DRAFT_OUTCOME_UNKNOWN', { contents: 'hang', timeouts: { json: 200 } });
  await delay(100);
  assert.deepEqual(d.requests.map(q => q.path), ['/api/v1/uploads', '/api/v1/contents']);
  assert.deepEqual([d.receipts[0].json.state, d.receipts[0].json.upload.url], ['draft_outcome_unknown', UPLOAD_URL]);
  const closed = createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
  const port = closed.address().port; closed.close(); await once(closed, 'close');
  const c = await failed(t, 'API_UNAVAILABLE', { baseUrl: `http://127.0.0.1:${port}/api/v1` });
  assert.equal(c.receipts.length, 0); assert.equal(c.error.receipt, undefined); assert.equal(c.credentialCalls, 1);
});
test('definite upload rejections map to public codes, write no receipt and never echo unknown codes', async t => {
  for (const [status, body, code] of [[413, failure('PAYLOAD_TOO_LARGE'), 'PAYLOAD_TOO_LARGE'], [401, failure(privateValue), 'UNAUTHORIZED'], [413, failure(privateValue), 'PAYLOAD_TOO_LARGE'], [429, failure('NOPE_' + privateValue), 'RATE_LIMITED'], [400, failure('UNSAFE_PACKAGE'), 'UNSAFE_PACKAGE']]) {
    const r = await failed(t, code, { upload: [status, body] });
    assert.equal(r.requests.length, 1); assert.equal(r.receipts.length, 0); assert.equal(r.error.httpStatus, status); assert.equal(r.error.receipt, undefined);
  }
  const html = await failed(t, 'API_RESPONSE_INVALID', { upload: [502, `<html>${privateValue}</html>`] });
  assert.equal(html.requests.length, 1); assert.equal(html.receipts[0].json.state, 'upload_outcome_unknown');
});
test('5xx/408 do not prove a mutation failed: receipts record outcome unknown and nothing is retried', async t => {
  for (const [status, body, code] of [[503, failure('UPLOAD_UNAVAILABLE'), 'UPLOAD_UNAVAILABLE'], [500, failure(privateValue), 'API_REQUEST_FAILED'], [408, failure(privateValue), 'API_REQUEST_FAILED']]) {
    const u = await failed(t, code, { upload: [status, body] });
    assert.equal(u.requests.length, 1); assert.deepEqual([u.receipts[0].json.state, u.receipts[0].json.error.http_status], ['upload_outcome_unknown', status]);
  }
  const d = await failed(t, 'INTERNAL_ERROR', { contents: [500, failure('INTERNAL_ERROR')] });
  assert.equal(d.requests.length, 2); assert.deepEqual([d.receipts[0].json.state, d.receipts[0].json.upload.url], ['draft_outcome_unknown', UPLOAD_URL]);
});
test('receipt location safety is checked before credentials/network; receipts are exclusive 0600 files', async t => {
  const outside = await workdir(t);
  const unsafe = [
    ['link', dir => symlink(outside, join(dir, 'link'))],
    ['link/new', dir => symlink(outside, join(dir, 'link'))],
    ['alias/sub', async dir => { await mkdir(join(dir, 'real', 'sub'), { recursive: true, mode: 0o700 }); await symlink(join(dir, 'real'), join(dir, 'alias')); }],
    ['open', async dir => { await mkdir(join(dir, 'open')); await chmod(join(dir, 'open'), 0o777); }],
    ['file', dir => writeFile(join(dir, 'file'), 'x')],
    [`bad\0dir`, async () => {}],
  ];
  for (const [receiptDir, prepare] of unsafe) {
    const r = await failed(t, 'UPLOAD_RECEIPT_UNSAFE', { args: ['game.zwf', '--receipt-dir', receiptDir], prepare });
    assert.equal(r.credentialCalls, 0); assert.equal(r.requests.length, 0);
  }
  assert.deepEqual(await readdir(outside), []);
  const custom = await run(t, { args: ['game.zwf', '--receipt-dir', 'out/receipts'] });
  assert.equal(custom.result.receipt.path.startsWith('out/receipts/'), true);
  assert.equal((await lstat(join(custom.dir, 'out', 'receipts'))).mode & 0o777, 0o700);
  const dir = await workdir(t), target = await prepareReceiptDir('r', { cwd: dir });
  const receipt = buildReceipt({ state: 'draft_created', apiOrigin: 'https://evil.example/x', pkg: { format: 'zwf', size: 1, sha256: P.sha, token }, upload: { url: 'https://evil.example/uploads/2026-10/x.zwf', verified: true }, error: { code: `bad ${token}` }, cliVersion: token + '!' });
  assertClean(receipt, 'built receipt');
  assert.deepEqual([receipt.api_origin, receipt.upload.url, receipt.error.code, receipt.published], [null, null, null, false]);
  assert.throws(() => buildReceipt({ state: 'published' }), { code: 'COMMAND_FAILED' });
  const a = await writeReceipt(target, receipt, { cwd: dir }), b = await writeReceipt(target, receipt, { cwd: dir });
  assert.notEqual(a, b); assert.deepEqual((await readdir(target)).length, 2);
  for (const file of [a, b]) assert.equal((await lstat(join(dir, file))).mode & 0o777, 0o600);
  await symlink(target, join(dir, 'alias'));
  for (const [path, options] of [[join(dir, 'alias'), {}], ['r', {}], [target, { uid: process.getuid() + 1 }]]) await assert.rejects(writeReceipt(path, receipt, { cwd: dir, ...options }), { code: 'UPLOAD_RECEIPT_UNSAFE' });
  assert.equal((await readdir(target)).length, 2);
});
test('default export validates input with optional context and never echoes an unsafe path', async () => {
  await assert.rejects(upload([]), { code: 'INVALID_INPUT' });
  await assert.rejects(upload(['/root/private/' + token]), error => error.code === 'UPLOAD_INPUT_UNSAFE' && !String(error.stack).includes(token));
  await assert.rejects(upload([], {}), { code: 'INVALID_INPUT' });
});
test('cancellation: pre-aborted does nothing; abort while waiting or mid-body is COMMAND_CANCELLED with no retry', async t => {
  const pre = new AbortController(); pre.abort();
  const p = await failed(t, 'COMMAND_CANCELLED', { context: { signal: pre.signal } });
  assert.equal(p.credentialCalls, 0); assert.equal(p.requests.length, 0);
  const waiting = new AbortController();
  const w = await failed(t, 'COMMAND_CANCELLED', { context: { signal: waiting.signal }, upload: () => { waiting.abort(); return 'hang'; } });
  await delay(100);
  assert.equal(w.requests.length, 1); assert.equal(w.receipts[0].json.state, 'upload_outcome_unknown');
  const body = new AbortController();
  let progress = 0;
  const m = await failed(t, 'COMMAND_CANCELLED', { context: { signal: body.signal, onProgress: () => { progress++; body.abort(); } } });
  await delay(100);
  assert.equal(progress >= 1, true); assert.equal(m.requests.length <= 1, true); assert.equal(m.requests.some(q => q.path.endsWith('/contents')), false);
});
test('injected public validator must agree with the built-in inspection', async t => {
  const agree = { inspectZwf: async () => ({ manifest: { entry_point: 'index.html', files: [{}, {}] }, zip: new Uint8Array(1) }), inspectZip: () => ({ entry: 'index.html', files: [{}, {}] }) };
  const r = await run(t, { context: { validator: agree } });
  assert.equal(r.result.package.validator, 'zukujs-builtin+@zuku/zwf');
  for (const [validator, reason] of [[{ inspectZwf: async () => ({ manifest: { entry_point: 'other.html', files: [{}, {}] }, zip: new Uint8Array(1) }) }, 'validator_disagreement'], [{ inspectZwf: async () => { throw Error(token); } }, 'public_validator_rejected']]) {
    const bad = await failed(t, 'PACKAGE_INVALID', { context: { validator } }, { reason });
    assert.equal(bad.credentialCalls, 0); assert.equal(bad.requests.length, 0);
  }
  assert.equal((await inspectPackage(WRAPPED_ZIP, { validator: { inspectZip: () => ({ entry: 'release/index.html', files: [{}, {}] }) } })).entry_point, 'release/index.html');
});
test('public @zuku/zwf inspectZwf shape ({manifest, zip: Uint8Array}) is accepted for a valid .zwf', async () => {
  const publicShape = { inspectZwf: async bytes => ({ manifest: { entry_point: 'index.html', files: [{}, {}] }, zip: bytes.subarray(16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true)) }), inspectZip: () => ({ entry: 'index.html', files: [{}, {}] }) };
  assert.equal((await inspectPackage(ZWF, { validator: publicShape })).validator, 'zukujs-builtin+@zuku/zwf');
});
test('ZIP names/EOCD that other readers interpret differently are rejected', async () => {
  const cases = [
    [buildZip([{ path: 'index.html', data: PLAYABLE_HTML }, { path: '\uFEFFindex.html', data: 'x' }]), 'zip_name_encoding'],
    [buildZip([{ path: 'index.html', data: PLAYABLE_HTML }, { path: '\u00e9.js', data: 'x', flags: 0 }]), 'zip_name_encoding'],
    [buildZip([{ path: 'index.html', data: PLAYABLE_HTML }], { comment: 'PK\u0005\u0006 fake' }), 'zip_eocd_ambiguous'],
  ];
  for (const [bytes, reason] of cases) await assert.rejects(inspectPackage(bytes), { code: 'PACKAGE_INVALID', reason });
  assert.equal((await inspectPackage(buildZip([{ path: 'index.html', data: PLAYABLE_HTML }, { path: '\u00e9.js', data: 'x' }]))).file_count, 2);
});
test('across every scenario only uploads/contents endpoints were called and nothing was published', () => {
  assert.ok(allRequests.length > 20);
  assert.equal(allRequests.some(q => /publish/i.test(q.path)), false);
  for (const q of allRequests) assert.match(`${q.method} ${q.path}`, /^(POST \/api\/v1\/uploads|POST \/api\/v1\/contents|GET \/api\/v1\/contents\/cnt_[A-Za-z0-9_-]+)$/);
});
