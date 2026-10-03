import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, link, unlink, utimes, readlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import create from '../commands/create.mjs';
import validate from '../commands/validate.mjs';
import packageCmd from '../commands/package.mjs';
import { run } from '../index.mjs';
import { identity } from '../lib/identity.mjs';
import { normalizeManifest, validateManifest } from '../lib/manifest-reader.mjs';
import { toJumpDraft, JumpMetaError } from '../lib/jump-meta.mjs';
import { zipWriter } from '../lib/zip.mjs';
import { inspectZip, inspectZwf } from '../lib/vendor/zwf/format.mjs';

const schema = JSON.parse(await readFile(new URL('../lib/schemas/zukujs-project.schema.json', import.meta.url), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function tmp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zukujs-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function project(t, name = 'demo') {
  const dir = await tmp(t);
  const data = await create([name], { cwd: dir });
  return { dir, root: join(dir, name), data };
}
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
async function patchManifest(root, patch) {
  const manifest = await readJson(join(root, 'zukujs.json'));
  await writeFile(join(root, 'zukujs.json'), JSON.stringify(patch(manifest) ?? manifest));
}
async function rejectsWith(promise, code) {
  let caught;
  await assert.rejects(promise, error => { caught = error; return true; });
  assert.equal(caught.code, code, `expected ${code}, got ${caught.code}`);
  return caught;
}
async function invalid(root, diagCode, path) {
  const error = await rejectsWith(validate([root], { cwd: root }), 'PROJECT_INVALID');
  const codes = error.details.diagnostics.map(item => item.code);
  assert.ok(codes.includes(diagCode), `expected ${diagCode} in ${codes}`);
  if (path) assert.ok(error.details.diagnostics.some(item => item.code === diagCode && item.path === path), `path ${path}`);
  return error;
}
const noTemp = async dir => assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);

/** Minimal central-directory parser (independent of lib/zip.mjs and zwf). */
function centralEntries(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'EOCD present');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    const nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    entries.push({
      name: Buffer.from(zip.subarray(offset + 46, offset + 46 + nameLength)).toString('utf8'),
      method: view.getUint16(offset + 10, true), time: view.getUint16(offset + 12, true), date: view.getUint16(offset + 14, true),
    });
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}
const zwfZip = bytes => bytes.subarray(16 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true));

// ---------------------------------------------------------------- create
test('create writes the ZukuJS template with a schema-valid manifest', async t => {
  const { root, data } = await project(t);
  const expected = ['.gitignore', 'README.md', 'src/game.js', 'src/index.html', 'zukujs.json'];
  assert.deepEqual(data.files, expected);
  assert.deepEqual((await readdir(root, { recursive: true })).filter(name => name !== 'src').sort(), expected);
  const manifest = await readJson(join(root, 'zukujs.json'));
  assert.equal(manifest.schema, 'zukujs-project/1');
  assert.deepEqual(validateManifest(manifest), []);
  assert.match(await readFile(join(root, 'README.md'), 'utf8'), /ZukuJS/);
  assert.match(await readFile(join(root, 'src/index.html'), 'utf8'), /ZukuJS/);
  const ignore = (await readFile(join(root, '.gitignore'), 'utf8')).split('\n');
  assert.ok(ignore.includes('dist/') && ignore.includes('*.zwf'));
  const report = await validate([root], { cwd: root });
  assert.equal(report.valid, true);
  assert.equal(report.project.title, 'demo');
});

test('create refuses existing dir, file and dangling symlink without touching them', async t => {
  const dir = await tmp(t);
  await mkdir(join(dir, 'existing')); await writeFile(join(dir, 'existing/keep'), 'x');
  await writeFile(join(dir, 'file'), 'keep');
  await symlink(join(dir, 'missing-target'), join(dir, 'dangling'));
  for (const name of ['existing', 'file', 'dangling']) await rejectsWith(create([name], { cwd: dir }), 'PROJECT_EXISTS');
  assert.deepEqual(await readdir(join(dir, 'existing')), ['keep']);
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'keep');
  assert.equal(await readlink(join(dir, 'dangling')), join(dir, 'missing-target'));
  await assert.rejects(lstat(join(dir, 'missing-target')), { code: 'ENOENT' });
});

test('create rejects invalid names with INVALID_INPUT and writes nothing', async t => {
  const dir = await tmp(t);
  for (const name of ['../x', 'a/b', '.h', '', 'Abc', 'a'.repeat(65), '-x', 'a b']) {
    await rejectsWith(create([name], { cwd: dir }), 'INVALID_INPUT');
  }
  await rejectsWith(create([], { cwd: dir }), 'INVALID_INPUT');
  assert.deepEqual(await readdir(dir), []);
});

// ---------------------------------------------------------------- manifest
test('manifest field rules map to stable diagnostic codes', async t => {
  const { root } = await project(t);
  const original = await readJson(join(root, 'zukujs.json'));
  const cases = [
    [m => { m.schema = 'zukujs-project/2'; }, 'MANIFEST_CONST', 'zukujs.json#/schema'],
    [m => { delete m.version; }, 'MANIFEST_REQUIRED', 'zukujs.json#/version'],
    [m => { m.name = 'Bad_Name'; }, 'MANIFEST_PATTERN', 'zukujs.json#/name'],
    [m => { m.title = 'a'.repeat(99) + '\u{1F600}'; }, 'MANIFEST_LENGTH', 'zukujs.json#/title'],
    [m => { m.title = ' \t '; }, 'MANIFEST_BLANK', 'zukujs.json#/title'],
    [m => { m.title = 'a\u0001b'; }, 'MANIFEST_PATTERN', 'zukujs.json#/title'],
    [m => { m.version = '1.0'; }, 'MANIFEST_PATTERN', 'zukujs.json#/version'],
    [m => { m.version = '01.0.0'; }, 'MANIFEST_PATTERN', 'zukujs.json#/version'],
    [m => { m.description = '\u{1F600}'.repeat(501); }, 'MANIFEST_LENGTH', 'zukujs.json#/description'],
    [m => { m.tags = Array.from({ length: 11 }, (_, i) => `t${i}`); }, 'MANIFEST_LENGTH', 'zukujs.json#/tags'],
    [m => { m.tags = ['a', 'a']; }, 'MANIFEST_UNIQUE', 'zukujs.json#/tags'],
    [m => { m.age_rating = '19'; }, 'MANIFEST_ENUM', 'zukujs.json#/age_rating'],
    [m => { m.source = '../x'; }, 'MANIFEST_PATTERN', 'zukujs.json#/source'],
    [m => { m.source = 'a/b'; }, 'MANIFEST_PATTERN', 'zukujs.json#/source'],
    [m => { delete m.jump.platform.pc; }, 'MANIFEST_REQUIRED', 'zukujs.json#/jump/platform/pc'],
    [m => { m.jump.content_id = 'x'; }, 'MANIFEST_UNKNOWN_FIELD', 'zukujs.json#/jump/content_id'],
    [m => { m.extra = true; }, 'MANIFEST_UNKNOWN_FIELD', 'zukujs.json#/extra'],
    [m => { m.package.format = 'tar'; }, 'MANIFEST_ENUM', 'zukujs.json#/package/format'],
    [m => { m.package.exclude = ['../x']; }, 'MANIFEST_PATTERN', 'zukujs.json#/package/exclude/0'],
    [m => { m.package.exclude = ['/abs']; }, 'MANIFEST_PATTERN', 'zukujs.json#/package/exclude/0'],
    [m => { m.package.exclude = ['a', 'a']; }, 'MANIFEST_UNIQUE', 'zukujs.json#/package/exclude'],
  ];
  for (const [mutate, code, path] of cases) {
    const manifest = structuredClone(original); mutate(manifest);
    await writeFile(join(root, 'zukujs.json'), JSON.stringify(manifest));
    await invalid(root, code, path);
  }
  // Boundaries that must still pass: 100 code points of emoji = 200 UTF-16 units is too long for title,
  // but 500 emoji in description (code points) is fine.
  const ok = structuredClone(original); ok.description = '\u{1F600}'.repeat(500); ok.title = 'a'.repeat(100);
  assert.deepEqual(validateManifest(ok), []);
});

test('manifest file-level failures: BOM, bad JSON, size, missing, symlink, source', async t => {
  const { root, dir } = await project(t);
  const text = await readFile(join(root, 'zukujs.json'));
  const file = join(root, 'zukujs.json');
  await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), text])); await invalid(root, 'MANIFEST_ENCODING');
  await writeFile(file, '{"schema":'); await invalid(root, 'MANIFEST_JSON');
  await writeFile(file, ' '.repeat(64 * 1024) + text); await invalid(root, 'MANIFEST_TOO_LARGE');
  await unlink(file); await invalid(root, 'MANIFEST_MISSING');
  await writeFile(join(dir, 'real.json'), text); await symlink(join(dir, 'real.json'), file);
  await invalid(root, 'PATH_UNSAFE', 'zukujs.json');
  await unlink(file); await writeFile(file, text);
  assert.equal((await validate([root], { cwd: root })).valid, true);
  await rm(join(root, 'src'), { recursive: true }); await invalid(root, 'SOURCE_MISSING', 'src');
  await mkdir(join(dir, 'elsewhere')); await writeFile(join(dir, 'elsewhere/index.html'), '<p>x</p>');
  await symlink(join(dir, 'elsewhere'), join(root, 'src')); await invalid(root, 'PATH_UNSAFE', 'src');
});

test('schema JSON and code accept exactly the same keys and shapes', async () => {
  assert.deepEqual(schema.required, ['schema', 'name', 'title', 'version']);
  const full = {
    schema: 'zukujs-project/1', name: 'full', title: 'Full', version: '1.2.3', description: 'd', tags: ['x'], age_rating: '12',
    source: 'src', entry: 'index.htm',
    jump: { game_id: 'game_full', genre: 'arcade', platform: { pc: true, mobile: false, tablet: true } },
    package: { format: 'zip', exclude: ['tools'] },
  };
  assert.deepEqual(Object.keys(full).sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(Object.keys(full.jump).sort(), Object.keys(schema.properties.jump.properties).sort());
  assert.deepEqual(Object.keys(full.jump.platform).sort(), Object.keys(schema.properties.jump.properties.platform.properties).sort());
  assert.deepEqual(Object.keys(full.package).sort(), Object.keys(schema.properties.package.properties).sort());
  assert.deepEqual(validateManifest(full), []);
  for (const key of Object.keys(schema.properties)) {
    const copy = structuredClone(full); delete copy[key];
    const codes = validateManifest(copy).map(item => item.code);
    assert.deepEqual(codes, schema.required.includes(key) ? ['MANIFEST_REQUIRED'] : [], key);
  }
  const levels = [[m => m, ''], [m => m.jump, '/jump'], [m => m.jump.platform, '/jump/platform'], [m => m.package, '/package']];
  for (const [at, path] of levels) {
    const copy = structuredClone(full); at(copy).zz_extra = 1;
    assert.deepEqual(validateManifest(copy).map(item => [item.code, item.path]), [['MANIFEST_UNKNOWN_FIELD', `zukujs.json#${path}/zz_extra`]]);
  }
  // Schema regexes agree with the code on representative samples.
  const samples = {
    name: ['a', '0-x', 'a'.repeat(64), 'a'.repeat(65), 'A', '-a', 'a b', 'a.b'],
    version: ['0.0.0', '10.2.33', '1.0', '01.0.0', '1.0.0-rc', 'v1.0.0'],
    source: ['src', 'Src_1', '_a', '-a', 'a/b', '..', 'a.b'],
    title: ['Ok', ' x ', '   ', 'a\u0001', 'a\nb', 'a\u007f'],
  };
  for (const [field, values] of Object.entries(samples)) {
    const pattern = new RegExp(schema.properties[field].pattern, 'u');
    for (const value of values) {
      const schemaOk = pattern.test(value) && value.length <= (schema.properties[field].maxLength ?? Infinity);
      const codeOk = validateManifest({ ...full, [field]: value }).length === 0;
      assert.equal(codeOk, schemaOk, `${field}=${JSON.stringify(value)}`);
    }
  }
  const exclude = new RegExp(schema.properties.package.properties.exclude.items.pattern, 'u');
  for (const value of ['a', 'a/b.txt', '../x', '/abs', 'a//b', 'a/', './a', 'a/..', 'a:b', 'a%b', 'a\\b', 'a?b', 'a#b', '.hidden']) {
    assert.equal(validateManifest({ ...full, package: { exclude: [value] } }).length === 0, exclude.test(value), `exclude=${value}`);
  }
});

// ---------------------------------------------------------------- source rules
test('source tree rejects links, special files, collisions, unsafe names and executables', async t => {
  const cases = [
    ['symlink file', async (root, dir) => { await writeFile(join(dir, 'outside.js'), ''); await symlink(join(dir, 'outside.js'), join(root, 'src/link.js')); }, 'PATH_SYMLINK', 'src/link.js'],
    ['symlink dir', async (root, dir) => { await mkdir(join(dir, 'outdir')); await symlink(join(dir, 'outdir'), join(root, 'src/lib')); }, 'PATH_SYMLINK', 'src/lib'],
    ['hard link', async (root, dir) => { await link(join(root, 'src/game.js'), join(dir, 'game-copy.js')); }, 'PATH_HARDLINK', 'src/game.js'],
    ['case collision', async root => { await writeFile(join(root, 'src/A.js'), ''); await writeFile(join(root, 'src/a.js'), ''); }, 'PATH_CASE_COLLISION', undefined],
    ['percent', async root => { await writeFile(join(root, 'src/a%20.js'), ''); }, 'PATH_UNSAFE', 'src/a%20.js'],
    ['colon', async root => { await writeFile(join(root, 'src/a:b.js'), ''); }, 'PATH_UNSAFE', 'src/a:b.js'],
    ['extension', async root => { await writeFile(join(root, 'src/tool.exe'), 'x'); }, 'FILE_TYPE_UNSUPPORTED', 'src/tool.exe'],
    ['entry missing', async root => { await unlink(join(root, 'src/index.html')); }, 'ENTRY_MISSING', 'src/index.html'],
    ['entry ambiguous', async root => { await writeFile(join(root, 'src/index.htm'), '<p>'); }, 'ENTRY_AMBIGUOUS', undefined],
    ['executable', async root => { await writeFile(join(root, 'src/x.txt'), 'MZ\x90\x00 not really'); }, 'EXECUTABLE_PAYLOAD', 'src/x.txt'],
  ];
  for (const [label, setup, code, path] of cases) {
    await t.test(label, async t2 => {
      const { root, dir } = await project(t2);
      await setup(root, dir);
      await invalid(root, code, path);
      await rejectsWith(packageCmd([root], { cwd: root }), 'PROJECT_INVALID');
      await assert.rejects(readdir(join(root, 'dist')), { code: 'ENOENT' });
    });
  }
});

test('FIFO in source is PATH_SPECIAL and is never opened', { timeout: 5000 }, async t => {
  const { root } = await project(t);
  const made = spawnSync('mkfifo', [join(root, 'src/pipe.js')]);
  if (made.status !== 0) { t.skip('mkfifo unavailable'); return; }
  await invalid(root, 'PATH_SPECIAL', 'src/pipe.js');
});

test('package.exclude fixes unsupported files and hides links inside excluded dirs', async t => {
  const { root, dir } = await project(t);
  await mkdir(join(root, 'src/tools'));
  await writeFile(join(root, 'src/tools/tool.exe'), 'x');
  await symlink(dir, join(root, 'src/tools/escape'));
  await invalid(root, 'FILE_TYPE_UNSUPPORTED', 'src/tools/tool.exe');
  await patchManifest(root, m => { m.package.exclude = ['tools']; });
  assert.equal((await validate([root], { cwd: root })).valid, true);
  const out = await packageCmd([root, '--format', 'zip'], { cwd: root });
  assert.deepEqual(centralEntries(await readFile(out.path)).map(e => e.name), ['game.js', 'index.html']);
});

test('hidden entries and node_modules are skipped with warnings and never archived', async t => {
  const { root } = await project(t);
  await writeFile(join(root, 'src/.secret.txt'), 'token');
  await mkdir(join(root, 'src/node_modules')); await writeFile(join(root, 'src/node_modules/dep.js'), '');
  const report = await validate([root], { cwd: root });
  assert.equal(report.valid, true);
  const warnings = report.diagnostics.filter(item => item.severity === 'warning').map(item => [item.code, item.path]);
  assert.deepEqual(warnings.sort(), [['DEPENDENCIES_EXCLUDED', 'src/node_modules'], ['HIDDEN_EXCLUDED', 'src/.secret.txt']]);
  const out = await packageCmd([root, '--format', 'zip'], { cwd: root });
  assert.deepEqual(centralEntries(await readFile(out.path)).map(e => e.name), ['game.js', 'index.html']);
});

test('2 MiB of zeros is stored (not deflated) so the zwf ratio rule admits it', async t => {
  const { root } = await project(t);
  await writeFile(join(root, 'src/zeros.bin'), Buffer.alloc(2 * 1024 ** 2));
  const out = await packageCmd([root], { cwd: root });
  const bytes = await readFile(out.path);
  await inspectZwf(bytes);
  assert.equal(centralEntries(zwfZip(bytes)).find(e => e.name === 'zeros.bin').method, 0);
});

test('project path that is a symlink or missing is rejected', async t => {
  const { root, dir } = await project(t);
  await symlink(root, join(dir, 'alias'));
  await rejectsWith(validate([join(dir, 'alias')], { cwd: dir }), 'PATH_UNSAFE');
  await rejectsWith(packageCmd([join(dir, 'alias')], { cwd: dir }), 'PATH_UNSAFE');
  await rejectsWith(validate([join(dir, 'nope')], { cwd: dir }), 'PROJECT_NOT_FOUND');
});

// ---------------------------------------------------------------- package
test('package writes a deterministic, verified ZWF2 to dist/ by default', async t => {
  const { root, dir } = await project(t);
  const out = await packageCmd([root], { cwd: dir });
  assert.equal(out.path, join(root, 'dist/demo-0.1.0.zwf'));
  assert.equal(out.format, 'zwf');
  const bytes = await readFile(out.path);
  assert.equal(out.bytes, bytes.length); assert.equal(out.sha256, sha(bytes));
  const { manifest } = await inspectZwf(bytes);
  assert.equal(manifest.title, 'demo'); assert.equal(manifest.entry_point, 'index.html');
  const entries = centralEntries(zwfZip(bytes));
  assert.deepEqual(entries.map(e => e.name), ['game.js', 'index.html']);
  for (const entry of entries) { assert.equal(entry.date, (0 << 9) | (1 << 5) | 1); assert.equal(entry.time, 0); }
  assert.equal(entries.some(e => /zukujs\.json|README\.md|gitignore/.test(e.name)), false);
  const report = await validate([out.path], { cwd: dir });
  assert.equal(report.valid, true); assert.equal(report.kind, 'zwf'); assert.equal(report.sha256, out.sha256);
  await noTemp(join(root, 'dist'));

  // Determinism across outputs and after mtime changes.
  const a = await packageCmd([root, '-o', join(dir, 'a.zwf')], { cwd: dir });
  await utimes(join(root, 'src/game.js'), new Date('2001-02-03'), new Date('2001-02-03'));
  const b = await packageCmd([root, `--output=${join(dir, 'b.zwf')}`], { cwd: dir });
  assert.equal(a.sha256, out.sha256); assert.equal(b.sha256, out.sha256);
  assert.deepEqual(await readFile(join(dir, 'b.zwf')), bytes);
});

test('package --format zip writes an inspectZip-valid deterministic ZIP', async t => {
  const { root, dir } = await project(t);
  const out = await packageCmd([root, '--format', 'zip'], { cwd: dir });
  assert.equal(out.path, join(root, 'dist/demo-0.1.0.zip'));
  const bytes = await readFile(out.path);
  assert.equal(out.sha256, sha(bytes)); assert.equal(out.bytes, bytes.length);
  assert.equal(inspectZip(bytes).entry, 'index.html');
  const entries = centralEntries(bytes);
  assert.deepEqual(entries.map(e => e.name), ['game.js', 'index.html']);
  assert.ok(entries.every(e => e.date === 0x21 && e.time === 0));
  const report = await validate([out.path], { cwd: dir });
  assert.equal(report.kind, 'zip'); assert.equal(report.valid, true);
  const again = await packageCmd([root, '--format=zip', '-o', join(dir, 'again.zip')], { cwd: dir });
  assert.equal(again.sha256, out.sha256);
});

test('package never overwrites without --force and never follows output links', async t => {
  const { root, dir } = await project(t);
  const target = join(dir, 'out.zwf');
  await writeFile(target, 'old');
  await rejectsWith(packageCmd([root, '-o', target], { cwd: dir }), 'OUTPUT_EXISTS');
  assert.equal(await readFile(target, 'utf8'), 'old');
  const forced = await packageCmd([root, '-o', target, '--force'], { cwd: dir });
  assert.equal(sha(await readFile(target)), forced.sha256);
  await noTemp(dir);

  await writeFile(join(dir, 'victim.zwf'), 'victim');
  await symlink(join(dir, 'victim.zwf'), join(dir, 'link.zwf'));
  for (const extra of [[], ['--force']]) await rejectsWith(packageCmd([root, '-o', join(dir, 'link.zwf'), ...extra], { cwd: dir }), 'PATH_UNSAFE');
  assert.equal(await readFile(join(dir, 'victim.zwf'), 'utf8'), 'victim');
  assert.equal((await lstat(join(dir, 'link.zwf'))).isSymbolicLink(), true);
});

test('package rejects a symlinked dist and invalid output locations', async t => {
  const { root, dir } = await project(t);
  await mkdir(join(dir, 'elsewhere'));
  await symlink(join(dir, 'elsewhere'), join(root, 'dist'));
  await rejectsWith(packageCmd([root], { cwd: dir }), 'PATH_UNSAFE');
  assert.deepEqual(await readdir(join(dir, 'elsewhere')), []);
  await rejectsWith(packageCmd([root, '-o', join(root, 'src/out.zwf')], { cwd: dir }), 'OUTPUT_INVALID');
  await rejectsWith(packageCmd([root, '-o', join(dir, 'out.zip')], { cwd: dir }), 'OUTPUT_INVALID');
  await rejectsWith(packageCmd([root, '--format', 'zip', '-o', join(dir, 'out.zwf')], { cwd: dir }), 'OUTPUT_INVALID');
  await rejectsWith(packageCmd([root, '-o', join(dir, 'missing/out.zwf')], { cwd: dir }), 'OUTPUT_INVALID');
  assert.deepEqual((await readdir(join(root, 'src'))).sort(), ['game.js', 'index.html']);
  assert.deepEqual((await readdir(dir)).sort(), ['demo', 'elsewhere']);
});

test('package argument and project errors leave no output or temp files', async t => {
  const { root, dir } = await project(t);
  for (const args of [[root, '--bogus'], [root, '--format', 'tar'], [root, '--force', '--force'], [root, '--format'], [root, '--force=yes'], [], [root, root]]) {
    await rejectsWith(packageCmd(args, { cwd: dir }), 'INVALID_INPUT');
  }
  await rejectsWith(packageCmd([join(root, 'zukujs.json')], { cwd: dir }), 'INVALID_INPUT');
  await unlink(join(root, 'src/index.html'));
  const error = await rejectsWith(packageCmd([root], { cwd: dir }), 'PROJECT_INVALID');
  assert.ok(error.details.diagnostics.some(item => item.code === 'ENTRY_MISSING'));
  await assert.rejects(readdir(join(root, 'dist')), { code: 'ENOENT' });
  await noTemp(root); await noTemp(dir);
});

test('package honours an already-aborted signal: COMMAND_CANCELLED, nothing committed', async t => {
  const { root, dir } = await project(t);
  const controller = new AbortController(); controller.abort();
  await rejectsWith(packageCmd([root], { cwd: dir, signal: controller.signal }), 'COMMAND_CANCELLED');
  const dist = await readdir(join(root, 'dist')).catch(() => []);
  assert.deepEqual(dist, []);
  await noTemp(root);
});

// ---------------------------------------------------------------- validate built files
test('validate rejects corrupted, truncated, unsafe and non-package files', async t => {
  const { root, dir } = await project(t);
  const zwf = await readFile((await packageCmd([root], { cwd: dir })).path);
  const zip = await readFile((await packageCmd([root, '--format', 'zip'], { cwd: dir })).path);
  const flipped = Buffer.from(zwf); flipped[zwf.length - zwfZip(zwf).length + 40] ^= 0xff;
  await writeFile(join(dir, 'flipped.zwf'), flipped);
  const error = await rejectsWith(validate([join(dir, 'flipped.zwf')], { cwd: dir }), 'PACKAGE_INVALID');
  assert.equal(error.details.diagnostics[0].code, 'ZWF_REJECTED');
  await writeFile(join(dir, 'truncated.zip'), zip.subarray(0, zip.length - 10));
  await rejectsWith(validate([join(dir, 'truncated.zip')], { cwd: dir }), 'PACKAGE_INVALID');
  const chunks = [];
  const writer = zipWriter(async buffer => { chunks.push(buffer); });
  await writer.add('../evil.txt', Buffer.from('evil')); await writer.add('index.html', Buffer.from('<p>'));
  await writer.finish();
  await writeFile(join(dir, 'evil.zip'), Buffer.concat(chunks));
  await rejectsWith(validate([join(dir, 'evil.zip')], { cwd: dir }), 'PACKAGE_INVALID');
  await writeFile(join(dir, 'plain.zip'), 'just some text, not a zip at all');
  await rejectsWith(validate([join(dir, 'plain.zip')], { cwd: dir }), 'PACKAGE_INVALID');
  await symlink(join(root, 'dist/demo-0.1.0.zip'), join(dir, 'link.zip'));
  await rejectsWith(validate([join(dir, 'link.zip')], { cwd: dir }), 'PATH_UNSAFE');
});

// ---------------------------------------------------------------- jump-meta
test('toJumpDraft maps a created project + receipt to a JUMP draft body', async t => {
  const { root } = await project(t);
  const proj = normalizeManifest(await readJson(join(root, 'zukujs.json')));
  const receipt = { url: '/uploads/2026-10/abc123.zwf', format: 'zwf', entry_point: 'index.html', size: 1234, sha256: 'a'.repeat(64) };
  const body = toJumpDraft(proj, receipt);
  assert.equal(body.category, 'jump'); assert.equal(body.type, 'game');
  assert.equal(body.title, 'demo'); assert.equal(body.publish_to_thread, false);
  assert.equal(body.jump.status, 'draft');
  assert.deepEqual(body.jump.mobile_optimized, { certified: false, level: null });
  assert.deepEqual(body.jump.package, { format: 'zwf', entry_point: 'index.html', size_bytes: 1234, hash: 'a'.repeat(64), version: '0.1.0', url: receipt.url });
  assert.equal(body.media_url, body.jump.package.url);
  assert.equal(body.jump.game_id, 'game_demo');
  assert.deepEqual(body.jump.platform, { pc: true, mobile: true, tablet: true });
  assert.equal(JSON.stringify(body).includes('content_id'), false);
  assert.equal('id' in body, false);
  const bad = [
    [{ url: 'https://evil/x.zwf' }, 'upload.url'], [{ url: '/api/v1/uploads/..' }, 'upload.url'], [{ url: '/uploads/../x.zwf' }, 'upload.url'],
    [{ format: 'zip' }, 'upload.format'], [{ url: '/uploads/2026-10/abc.zip' }, 'upload.format'],
    [{ entry_point: 'index.htm' }, 'upload.entry_point'], [{ sha256: 'A'.repeat(64) }, 'upload.sha256'], [{ sha256: 'abc' }, 'upload.sha256'],
    [{ size: 0 }, 'upload.size'], [{ size: -1 }, 'upload.size'], [{ size: 1.5 }, 'upload.size'],
  ];
  for (const [patch, field] of bad) assert.throws(() => toJumpDraft(proj, { ...receipt, ...patch }), error => error instanceof JumpMetaError && error.field === field, JSON.stringify(patch));
  assert.throws(() => toJumpDraft({ ...proj, title: 'a'.repeat(101) }, receipt), { field: 'title' });
  assert.throws(() => toJumpDraft({ ...proj, description: 'x'.repeat(501) }, receipt), { field: 'description' });
});

// ---------------------------------------------------------------- envelope via run()
async function capture(args) {
  let out = '', err = '';
  const exit = await run(args, { stdout: { write: x => { out += x; } }, stderr: { write: x => { err += x; } } });
  return { exit, out, err };
}

test('run() error envelopes: stderr only, stable meta, exit codes, no temp paths', async t => {
  const { root, dir } = await project(t);
  await writeFile(join(root, 'src/x.txt'), 'MZ');
  const cases = [
    [['validate', join(dir, 'missing'), '--json'], 'PROJECT_NOT_FOUND', 1],
    [['package', root, '--bogus', '--json'], 'INVALID_INPUT', 2],
    [['create', '../x', '--json'], 'INVALID_INPUT', 2],
    [['package', root, '--json'], 'PROJECT_INVALID', 1],
  ];
  for (const [args, code, exit] of cases) {
    const result = await capture(args);
    assert.equal(result.exit, exit, code); assert.equal(result.out, '');
    const body = JSON.parse(result.err);
    assert.equal(body.success, false); assert.equal(body.error.code, code);
    assert.deepEqual(body.meta, { runtime: identity.version, protocol: identity.command_protocol });
    assert.equal(result.err.includes(dir), false); assert.equal(result.err.includes(tmpdir() + '/'), false);
    if (code === 'PROJECT_INVALID') assert.deepEqual(body.error.details.diagnostics.map(d => [d.code, d.path]), [['EXECUTABLE_PAYLOAD', 'src/x.txt']]);
  }
  const plain = await capture(['validate', join(dir, 'missing')]);
  assert.equal(plain.out, ''); assert.match(plain.err, /^PROJECT_NOT_FOUND: /);
});

test('run() validate --json returns command data', { todo: 'requires index.mjs to return command data' }, async t => {
  const { root } = await project(t);
  const result = await capture(['validate', root, '--json']);
  assert.equal(result.exit, 0);
  assert.equal(JSON.parse(result.out).data?.valid, true);
});

// ---------------------------------------------------------------- no execution
test('validate and package never execute project code', async t => {
  const { root, dir } = await project(t);
  const marker = join(dir, 'executed.marker');
  const payload = `try { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); } catch {}\n`;
  await writeFile(join(root, 'src/game.js'), payload);
  await writeFile(join(root, 'src/run.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
  await writeFile(join(root, 'src/run.cjs'), payload);
  assert.equal((await validate([root], { cwd: dir })).valid, true);
  await packageCmd([root], { cwd: dir });
  await packageCmd([root, '--format', 'zip'], { cwd: dir });
  await validate([join(root, 'dist/demo-0.1.0.zwf')], { cwd: dir });
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
});
