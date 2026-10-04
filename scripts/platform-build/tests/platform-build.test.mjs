// Platform build helper tests. Every "binary" here is a SYNTHETIC FIXTURE file written by
// the test; no native shell is compiled, nothing is downloaded, signed or published.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLATFORMS, CI_RUNNERS, MANAGED_NODE_VERSION, SHARED_PAYLOAD, platformDescriptor, assertNativeHost, buildSteps, selfTestArguments, hostPlatformId, defaultArtifacts, placedPath } from '../matrix.mjs';
import { relativePath, collectArtifacts, sha256 } from '../fs-safety.mjs';
import { createTarGz, createZip, readTarGz, readZip, sourceEpoch } from '../archive.mjs';
import { createAsset, verifyAsset, verifySharedPayload, gitSource, parsePorcelain, canonical } from '../manifest.mjs';
import { main, plan, windowsProject } from '../cli.mjs';

const windows = process.platform === 'win32';
const EPOCH = 1790000000;
const code = expected => error => error.code === expected;
const hasGit = spawnSync('git', ['--version'], { shell: false }).status === 0;

async function temp(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zuku-platform-build-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function put(root, rel, text, mode = 0o644) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text, { mode });
}
function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8', shell: false,
    env: { ...process.env, GIT_AUTHOR_DATE: `@${EPOCH} +0000`, GIT_COMMITTER_DATE: `@${EPOCH} +0000` },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
// Synthetic checkout: the real package identity shape, the shared payload list and a fake native build output.
async function fixtureRepository(t, platformId) {
  const root = await temp(t), descriptor = platformDescriptor(platformId);
  await put(root, 'package.json', JSON.stringify({ name: '@zukujs/cli', version: '9.8.7', bin: { zuku: './index.mjs', zukujs: './index.mjs' } }));
  for (const rel of SHARED_PAYLOAD) await put(root, rel, `synthetic ${rel}\n`);
  await put(root, 'lib/studio-host.mjs', '// synthetic host placeholder\n');
  await put(root, `${descriptor.nativeDir}/source.c`, 'int main(void){return 0;}\n');
  for (const artifact of defaultArtifacts(descriptor)) {
    if (artifact === descriptor.defaultExecutable) await put(root, artifact, 'SYNTHETIC FIXTURE BINARY\n', 0o755);
    else if (descriptor.defaultExecutable.startsWith(`${artifact}/`)) {
      await put(root, descriptor.defaultExecutable, 'SYNTHETIC FIXTURE BINARY\n', 0o755);
      await put(root, `${artifact}/resources/readme.txt`, 'synthetic resource\n');
    } else await put(root, artifact, 'synthetic desktop entry\n');
  }
  await put(root, '.gitignore', 'build/\n');
  git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'fixture');
  return { root, descriptor };
}

test('matrix is finite, pins the official managed Node and builds only natively', () => {
  assert.deepEqual(Object.keys(PLATFORMS).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win-arm64', 'win-x64']);
  assert.equal(MANAGED_NODE_VERSION, '22.22.3');
  assert.throws(() => platformDescriptor('linux-x64;rm'), code('PLATFORM_UNKNOWN'));
  assert.throws(() => platformDescriptor('__proto__'), code('PLATFORM_UNKNOWN'));
  assert.throws(() => assertNativeHost(PLATFORMS['win-x64'], 'linux', 'x64'), code('HOST_MISMATCH'));
  assert.doesNotThrow(() => assertNativeHost(PLATFORMS['darwin-arm64'], 'darwin', 'arm64'));
  assert.equal(hostPlatformId('win32', 'x64'), 'win-x64');
  assert.equal(hostPlatformId('freebsd', 'x64'), null);
});

test('build steps are executable + argv arrays and refuse missing tools or projects', () => {
  const linux = buildSteps(PLATFORMS['linux-x64'], { tools: { make: '/usr/bin/make' }, nodeExecutable: '/opt/node/bin/node' });
  assert.deepEqual(linux.map(s => s.args.at(-1)), ['all', 'check']);
  for (const step of linux) { assert.ok(Array.isArray(step.args)); assert.ok(path.isAbsolute(step.executable)); }
  assert.throws(() => buildSteps(PLATFORMS['linux-x64'], { tools: { make: '/usr/bin/make' }, nodeExecutable: '/opt/x"; rm -rf /' }), code('NODE_MISSING'));
  assert.throws(() => buildSteps(PLATFORMS['linux-x64'], { tools: {}, nodeExecutable: '/opt/node' }), code('TOOL_MISSING'));
  assert.throws(() => buildSteps(PLATFORMS['win-x64'], { tools: { dotnet: 'C:\\dotnet\\dotnet.exe' } }), code('PROJECT_MISSING'));
  assert.throws(() => buildSteps(PLATFORMS['win-x64'], { tools: { dotnet: '/d' }, project: '../evil.csproj', cliVersion: '1.2.3' }), code('PROJECT_MISSING'));
  const project = 'studio/native/windows/src/ZukuStudio/ZukuStudio.csproj';
  assert.throws(() => buildSteps(PLATFORMS['win-x64'], { tools: { dotnet: '/d' }, project, cliVersion: '1.2;3' }), code('PACKAGE_INVALID'));
  const win = buildSteps(PLATFORMS['win-arm64'], { tools: { dotnet: '/d' }, project, cliVersion: '1.2.3' });
  assert.deepEqual(win[0].args.slice(0, 2), ['publish', project]);
  assert.ok(win[0].args.includes('win-arm64') && win[0].args.includes('-p:ZukuCliVersion=1.2.3'));
  assert.equal(win[0].args.at(-1), 'studio/native/windows/build/win-arm64');
  assert.equal(buildSteps(PLATFORMS['darwin-x64'], { tools: { bash: '/bin/bash' }, nodeExecutable: '/managed/node' })[0].args[0], 'studio/native/macos/build.sh');
});

test('six native build plans use the actual macOS architecture, sibling runtime and bundle executable', async () => {
  const script = await fs.readFile(new URL('../../../studio/native/macos/build.sh', import.meta.url), 'utf8');
  const plist = await fs.readFile(new URL('../../../studio/native/macos/Resources/Info.plist.in', import.meta.url), 'utf8');
  const locator = await fs.readFile(new URL('../../../studio/native/macos/Sources/Installation.swift', import.meta.url), 'utf8');
  assert.match(script, /--arch must be arm64 or x86_64/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>ZukuStudio<\/string>/);
  assert.match(locator, /runtimeDirectoryName = "zuku-runtime"/);
  for (const descriptor of Object.values(PLATFORMS)) {
    const steps = buildSteps(descriptor, { tools: { bash: '/bin/bash', make: '/usr/bin/make', dotnet: '/sdk/dotnet' }, nodeExecutable: '/managed/node', project: 'studio/native/windows/src/ZukuStudio/ZukuStudio.csproj', cliVersion: '0.3.0' });
    assert.ok(steps.length && steps.every(step => Array.isArray(step.args) && path.isAbsolute(step.executable)));
    if (descriptor.os !== 'darwin') continue;
    const arch = descriptor.arch === 'x64' ? 'x86_64' : 'arm64';
    assert.deepEqual(steps[0].args, ['studio/native/macos/build.sh', '--arch', arch, '--stage-runtime', '--node', '/managed/node']);
    assert.deepEqual(defaultArtifacts(descriptor), [`studio/native/macos/build/${arch}/ZUKU Studio.app`]);
    assert.equal(descriptor.defaultExecutable, `studio/native/macos/build/${arch}/ZUKU Studio.app/Contents/MacOS/ZukuStudio`);
    assert.equal(placedPath(descriptor, descriptor.defaultExecutable), 'ZUKU Studio.app/Contents/MacOS/ZukuStudio');
    assert.throws(() => placedPath(descriptor, `studio/native/macos/build/${arch}/zuku-runtime/runtime/bin/node`), code('ARTIFACT_OUTSIDE'));
  }
  assert.throws(() => buildSteps(PLATFORMS['darwin-arm64'], { tools: { bash: '/bin/bash' } }), code('NODE_MISSING'));
});

test('Windows stdio self-test reaches Program.Main test branch with an explicit synthetic peer', async () => {
  const rootReal = path.resolve('checkout with spaces'), nodeExecutable = path.join(rootReal, 'managed node.exe');
  const program = await fs.readFile(new URL('../../../studio/native/windows/src/ZukuStudio/Program.cs', import.meta.url), 'utf8');
  assert.match(program, /args is \["--stdio-test", "--node", var node, "--fixture", var fixture\]/);
  for (const id of ['win-x64', 'win-arm64']) {
    assert.deepEqual(selfTestArguments(PLATFORMS[id], { rootReal, nodeExecutable }), [
      ['--self-test'], ['--stdio-test', '--node', nodeExecutable, '--fixture', path.join(rootReal, 'studio/native/windows/tests/stdio-fixture.mjs')],
    ]);
    assert.throws(() => selfTestArguments(PLATFORMS[id], { rootReal, nodeExecutable: 'relative-node' }), code('NODE_MISSING'));
  }
  for (const id of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']) assert.deepEqual(selfTestArguments(PLATFORMS[id]), [['--self-test'], ['--stdio-test']]);
});

test('CI covers all six native runner labels and installs the selected native Node architecture', async () => {
  const workflow = await fs.readFile(new URL('../../../.github/workflows/studio-platform.yml', import.meta.url), 'utf8');
  const entries = [...workflow.matchAll(/- platform: ([a-z0-9-]+)\s+runner: ([a-z0-9.-]+)\s+arch: (x64|arm64)/g)].map(([, id, runner, arch]) => [id, runner, arch]);
  assert.equal(entries.length, 6);
  assert.deepEqual(Object.fromEntries(entries.map(([id, runner]) => [id, runner])), CI_RUNNERS);
  for (const [id, , arch] of entries) assert.equal(PLATFORMS[id].arch, arch);
  assert.match(workflow, /architecture: \$\{\{ matrix\.arch \}\}/);
  assert.match(workflow, /assertNativeHost\(platformDescriptor\(process\.argv\[1\]\)\)/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true|\$\{\{\s*secrets\./);
});

test('both Windows installer assets explicitly bundle .NET while preserving managed Node and placement', () => {
  for (const arch of ['x64', 'arm64']) {
    const descriptor = PLATFORMS[`win-${arch}`];
    const [step] = buildSteps(descriptor, { tools: { dotnet: '/sdk/dotnet' }, project: 'studio/native/windows/src/ZukuStudio/ZukuStudio.csproj', cliVersion: '0.3.0' });
    const flag = step.args.indexOf('--self-contained');
    assert.notEqual(flag, -1);
    assert.equal(step.args[flag + 1], 'true');
    assert.equal(step.args[step.args.indexOf('-r') + 1], `win-${arch}`);
    assert.equal(step.args.at(-1), `studio/native/windows/build/win-${arch}`);
    assert.equal(descriptor.layout.managedNode, 'runtime/node.exe');
    assert.equal(descriptor.layout.cliRoot, 'npm/node_modules/@zukujs/cli');
    assert.deepEqual(defaultArtifacts(descriptor), [`studio/native/windows/build/win-${arch}`]);
    assert.ok(!step.args.includes('false'));
  }
});

test('relative paths reject traversal, absolute, backslash, option-like and control input', () => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a/./b', 'a\\b', '-rf', 'a/-x', 'C:/x', 'a\nb', 'a/b ', 'a/b.', '..', '.']) assert.throws(() => relativePath(bad), code('PATH_INVALID'), bad);
  for (const good of ['studio/native/linux/build/zuku-studio', 'build/ZUKU Studio.app/Contents/Info.plist', 'a/.gitkeep']) assert.equal(relativePath(good), good);
});

test('tar.gz archives are reproducible, sorted and independent of input order', () => {
  const a = [{ path: 'b/two', bytes: Buffer.from('2'), executable: false }, { path: 'a/one', bytes: Buffer.from('1'), executable: true }];
  const first = createTarGz(a, EPOCH), second = createTarGz([...a].reverse(), EPOCH);
  assert.equal(sha256(first), sha256(second));
  assert.notEqual(sha256(first), sha256(createTarGz(a, EPOCH + 2)));
  assert.equal(first.readUInt32LE(4), 0); assert.equal(first[9], 255);
  const files = readTarGz(first);
  assert.deepEqual([...files.keys()], ['a/one', 'b/two']);
  assert.equal(files.get('a/one').mode, 0o755); assert.equal(files.get('b/two').mode, 0o644);
  assert.throws(() => createTarGz([...a, a[0]], EPOCH), code('ARCHIVE_DUPLICATE'));
  assert.throws(() => sourceEpoch('12'), code('EPOCH_INVALID'));
});

test('zip archives are reproducible across time zones, including DST gaps', () => {
  // 2026-03-08 02:30 UTC is a nonexistent local wall-clock time in America/Los_Angeles.
  const gap = Date.UTC(2026, 2, 8, 2, 30, 0) / 1000;
  const script = `import { createZip } from ${JSON.stringify(new URL('../archive.mjs', import.meta.url).href)}; import crypto from 'node:crypto';
    const z = e => crypto.createHash('sha256').update(createZip([{ path: 'x/ZukuStudio.exe', bytes: Buffer.from('fixture') }], e)).digest('hex');
    process.stdout.write(z(${EPOCH}) + z(${gap}));`;
  const hashes = ['UTC', 'Asia/Seoul', 'America/Los_Angeles'].map(TZ => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ }, shell: false });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  });
  assert.equal(new Set(hashes).size, 1);
  const files = readZip(createZip([{ path: 'x/ZukuStudio.exe', bytes: Buffer.from('fixture') }], EPOCH));
  assert.equal(Buffer.from(files.get('x/ZukuStudio.exe').bytes).toString(), 'fixture');
});

function rawTar(name, type, linkname = '') {
  const h = Buffer.alloc(512);
  h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write('00000000000\0', 124); h.write('00000000000\0', 136); h.fill(0x20, 148, 156); h.write(type, 156);
  h.write(linkname, 157); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b; h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return zlib.gzipSync(Buffer.concat([h, Buffer.alloc(1024)]));
}
test('archive reader rejects links, traversal and foreign roots', () => {
  assert.throws(() => readTarGz(rawTar('zuku-studio/evil', '2', '/etc/passwd')), code('ARCHIVE_UNSAFE'));
  assert.throws(() => readTarGz(rawTar('zuku-studio/../evil', '0')), code('PATH_INVALID'));
  assert.throws(() => readTarGz(rawTar('other/file', '0')), code('ARCHIVE_UNSAFE'));
});

test('artifact collection rejects missing, outside, hard-linked and symlinked artifacts', async t => {
  const root = await temp(t), base = 'studio/native/linux';
  await put(root, `${base}/build/zuku-studio`, 'SYNTHETIC FIXTURE BINARY', 0o755);
  await put(root, 'outside.bin', 'x');
  const opts = { base, executable: `${base}/build/zuku-studio` };
  const files = await collectArtifacts(root, [`${base}/build`], opts);
  assert.deepEqual(files.map(f => f.path), [`${base}/build/zuku-studio`]);
  assert.equal(files[0].sha256, sha256(Buffer.from('SYNTHETIC FIXTURE BINARY')));
  await assert.rejects(collectArtifacts(root, [`${base}/build/missing`], opts), code('ARTIFACT_MISSING'));
  await assert.rejects(collectArtifacts(root, ['outside.bin'], opts), code('ARTIFACT_OUTSIDE'));
  await assert.rejects(collectArtifacts(root, [`${base}/../outside.bin`], opts), code('PATH_INVALID'));
  await fs.link(path.join(root, 'outside.bin'), path.join(root, base, 'build', 'hard'));
  await assert.rejects(collectArtifacts(root, [`${base}/build`], opts), code('ARTIFACT_INVALID'));
  await fs.rm(path.join(root, base, 'build', 'hard'));
  if (!windows) {
    await fs.symlink(path.join(root, 'outside.bin'), path.join(root, base, 'build', 'link'));
    await assert.rejects(collectArtifacts(root, [`${base}/build`], opts), code('ARTIFACT_LINK'));
    await fs.rm(path.join(root, base, 'build', 'link'));
    await fs.rename(path.join(root, base, 'build'), path.join(root, 'real-build'));
    await fs.symlink(path.join(root, 'real-build'), path.join(root, base, 'build'));
    await assert.rejects(collectArtifacts(root, [`${base}/build/zuku-studio`], opts), code('ARTIFACT_LINK'));
  }
});

for (const platformId of Object.keys(PLATFORMS)) {
  test(`manifest binds git commit, sources, payload and bytes reproducibly (${platformId}, synthetic fixture)`, { skip: !hasGit && 'git is required' }, async t => {
    const { root, descriptor } = await fixtureRepository(t, platformId);
    const collect = () => collectArtifacts(root, defaultArtifacts(descriptor), { base: descriptor.nativeDir, executable: descriptor.defaultExecutable });
    const files = await collect();
    // Nested .NET/Xcode-style outputs are neither sources nor modifications (bound via artifact bytes).
    await put(root, `${descriptor.nativeDir}/src/App/bin/Release/x.dll`, 'synthetic output');
    await put(root, `${descriptor.nativeDir}/src/App/obj/project.assets.json`, '{}');
    const one = await createAsset({ rootReal: root, platform: platformId, files, executable: descriptor.defaultExecutable, requireClean: true });
    const two = await createAsset({ rootReal: root, platform: platformId, files: await collect(), executable: descriptor.defaultExecutable, requireClean: true });
    assert.equal(one.record.sha256, two.record.sha256);
    const head = git(root, 'rev-parse', 'HEAD').trim();
    assert.equal(one.manifest.source.gitCommit, head);
    assert.equal(one.manifest.source.treeState, 'clean');
    assert.equal(one.manifest.archiveTimestamp, EPOCH);
    assert.equal(one.manifest.node.version, '22.22.3'); assert.equal(one.manifest.node.bundled, false);
    assert.equal(one.manifest.version, '9.8.7');
    assert.deepEqual(one.manifest.publication, { released: false, signed: false, notarized: false });
    assert.ok(!path.isAbsolute(one.manifest.launcher.managedNode) && !one.manifest.launcher.host.includes('..'));
    assert.equal(one.record.file, `zuku-studio-9.8.7-${platformId}.${descriptor.format}`);
    assert.deepEqual(one.manifest.source.nativeSources.map(s => s.path), [`${descriptor.nativeDir}/source.c`].concat(descriptor.os === 'linux' ? ['studio/native/linux/zuku-studio.desktop.in'] : []).sort());
    assert.equal(one.manifest.launcher.requiresManagedNode, true);
    assert.equal(one.manifest.placement.relativeTo, descriptor.placement.relativeTo);
    const manifest = await verifyAsset(one.record, one.archive, { cliRoot: root });
    assert.equal(manifest.executable, placedPath(descriptor, descriptor.defaultExecutable));
    assert.equal(manifest.executable, { linux: 'studio/linux/zuku-studio', darwin: 'ZUKU Studio.app/Contents/MacOS/ZukuStudio', win32: 'studio/windows/ZukuStudio.exe' }[descriptor.os]);
    assert.ok(!JSON.stringify(manifest).includes(root), 'manifest must not leak build machine paths');

    const tampered = Buffer.from(one.archive); tampered[tampered.length - 30] ^= 1;
    await assert.rejects(verifyAsset(one.record, tampered), code('VERIFY_FAILED'));
    await assert.rejects(verifyAsset({ ...one.record, platform: platformId === 'linux-arm64' ? 'linux-x64' : 'linux-arm64' }, one.archive), /VERIFY_FAILED|mismatch/);

    // A record re-signed over a manifest with a trimmed payload allowlist is still rejected.
    const trimmed = { ...one.manifest, sharedPayload: [] }, trimmedBytes = Buffer.from(canonical(trimmed));
    const { createArchive } = await import('../archive.mjs');
    const forged = createArchive(descriptor.format, [{ path: 'source-manifest.json', bytes: trimmedBytes }, ...files.map((f, i) => ({ path: one.manifest.artifacts[i].path, bytes: f.bytes, executable: f.executable }))], EPOCH);
    await assert.rejects(verifyAsset({ ...one.record, size: forged.length, sha256: sha256(forged), manifestSHA256: sha256(trimmedBytes) }, forged), code('VERIFY_FAILED'));

    await fs.rename(path.join(root, 'lib/studio-host.mjs'), path.join(root, 'host.bak'));
    await assert.rejects(verifySharedPayload(root, manifest), /studio-host/);
    await fs.rename(path.join(root, 'host.bak'), path.join(root, 'lib/studio-host.mjs'));
    await put(root, SHARED_PAYLOAD[0], 'changed payload\n');
    await assert.rejects(verifySharedPayload(root, manifest), code('VERIFY_FAILED'));
    await assert.rejects(createAsset({ rootReal: root, platform: platformId, files, executable: descriptor.defaultExecutable, requireClean: true }), code('SOURCE_MODIFIED'));
    const dirty = await createAsset({ rootReal: root, platform: platformId, files, executable: descriptor.defaultExecutable });
    assert.equal(dirty.manifest.source.treeState, 'modified');
    assert.deepEqual(dirty.manifest.source.modifiedPaths, [SHARED_PAYLOAD[0]]);

    // Untracked or ignored non-output files beside the sources also count as modifications.
    git(root, 'checkout', '--', SHARED_PAYLOAD[0]);
    await put(root, `${descriptor.nativeDir}/generated.h`, '#define LOCAL 1\n');
    await put(root, `${descriptor.nativeDir}/debug.log`, 'ignored but bound\n');
    await fs.appendFile(path.join(root, '.gitignore'), '*.log\n');
    const extra = await createAsset({ rootReal: root, platform: platformId, files, executable: descriptor.defaultExecutable });
    assert.deepEqual(extra.manifest.source.modifiedPaths, [`${descriptor.nativeDir}/debug.log`, `${descriptor.nativeDir}/generated.h`]);
    assert.ok(!extra.manifest.source.nativeSources.some(s => s.path.endsWith('generated.h')), 'only tracked sources are hashed');
  });
}

test('git source binding fails honestly outside a git checkout', async t => {
  const root = await temp(t);
  assert.throws(() => gitSource(root, 'studio/native/linux', ['.']), code('GIT_UNAVAILABLE'));
});

test('porcelain parsing keeps both rename paths intact', () => {
  assert.deepEqual(parsePorcelain('R  new/name.c\0old/name.c\0 M lib/x.mjs\0?? studio/a b.c\0'), ['lib/x.mjs', 'new/name.c', 'old/name.c', 'studio/a b.c']);
});

test('tar long names use a fitting ustar split and round-trip', () => {
  const name = `${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(60)}/x`;
  const files = readTarGz(createTarGz([{ path: name, bytes: Buffer.from('long') }], EPOCH));
  assert.equal(Buffer.from(files.get(name).bytes).toString(), 'long');
  assert.throws(() => createTarGz([{ path: `${'d'.repeat(101)}/x`, bytes: Buffer.from('') }], EPOCH), code('ARCHIVE_INVALID'));
});

test('zip reader rejects Unix symlink entries', () => {
  const zip = createZip([{ path: 'studio/windows/link', bytes: Buffer.from('/etc/passwd') }], EPOCH);
  // Mark the entry as made by Unix with S_IFLNK external attributes.
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip[central + 5] = 3; zip.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
  assert.throws(() => readZip(zip), code('ARCHIVE_UNSAFE'));
});

test('Windows desktop project discovery accepts exactly one WinExe project under src', async t => {
  const root = await temp(t), descriptor = PLATFORMS['win-x64'];
  await put(root, 'studio/native/windows/src/ZukuStudio.Core/ZukuStudio.Core.csproj', '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
  await assert.rejects(windowsProject(root, descriptor), code('PROJECT_MISSING'));
  await put(root, 'studio/native/windows/src/ZukuStudio/ZukuStudio.csproj', '<Project><PropertyGroup><OutputType>WinExe</OutputType></PropertyGroup></Project>');
  assert.equal(await windowsProject(root, descriptor), 'studio/native/windows/src/ZukuStudio/ZukuStudio.csproj');
  await put(root, 'studio/native/windows/src/Other/Other.csproj', '<Project><PropertyGroup><OutputType>WinExe</OutputType></PropertyGroup></Project>');
  await assert.rejects(windowsProject(root, descriptor), code('PROJECT_MISSING'));
});

test('placement maps only declared outputs to install-relative paths', () => {
  assert.equal(placedPath(PLATFORMS['win-arm64'], 'studio/native/windows/build/win-arm64/runtimes/x.dll'), 'studio/windows/runtimes/x.dll');
  assert.throws(() => placedPath(PLATFORMS['win-arm64'], 'studio/native/windows/src/secret.txt'), code('ARTIFACT_OUTSIDE'));
  assert.equal(PLATFORMS['darwin-arm64'].placement.releaseDirectoryName, 'zuku-runtime');
  assert.equal(PLATFORMS['linux-x64'].placement.ownerConfirmed, true);
});

test('CLI rejects unknown options and non-native packaging; plan reports structured steps', async () => {
  await assert.rejects(main(['package', '--platform', 'linux-x64', '--shell', 'x']), /Unknown option/);
  await assert.rejects(main(['explode']), code('USAGE'));
  const other = hostPlatformId() === 'win-x64' ? 'linux-x64' : 'win-x64';
  await assert.rejects(main(['package', '--platform', other, '--out', os.tmpdir()]), code('HOST_MISMATCH'));
  await assert.rejects(main(['verify', '--record', 'relative.json']), code('VERIFY_FAILED'));
  const host = hostPlatformId();
  if (host) {
    const result = await plan(host, { root: fileURLToPath(new URL('../../../', import.meta.url)) });
    assert.equal(result.native, true);
    assert.ok(Array.isArray(result.missingTools));
  }
});
