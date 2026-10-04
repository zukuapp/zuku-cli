import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { renderInstallers, validateContract } from '../render-installers.mjs';
import { installNative, downloadNative } from '../native-helper.mjs';
import { createArchive } from '../../platform-build/archive.mjs';
import { SHARED_PAYLOAD } from '../../platform-build/matrix.mjs';

const cli = path.resolve(import.meta.dirname, '../../..'), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'zuku-native-installer-'));
test.after(() => fs.rm(work, { recursive: true, force: true }));
const version = '0.3.0', platform = 'linux-x64', commit = 'a'.repeat(40);
const packageRoot = path.join(work, 'package'); await fs.mkdir(packageRoot);
const pkg = { name: '@zukujs/cli', version, type: 'module', bin: { zuku: './index.mjs', zukujs: './index.mjs' }, bundledDependencies: ['fflate'], dependencies: { fflate: '0.8.3' } };
await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(pkg));
await fs.writeFile(path.join(packageRoot, 'index.mjs'), 'console.log("ZukuJS 0.3.0 installer fixture");\n');
await fs.mkdir(path.join(packageRoot, 'lib'), { recursive: true }); await fs.copyFile(path.join(cli, 'lib/studio-host.mjs'), path.join(packageRoot, 'lib/studio-host.mjs'));
await fs.cp(path.join(cli, 'scripts/platform-build'), path.join(packageRoot, 'scripts/platform-build'), { recursive: true });
await fs.cp(path.join(cli, 'node_modules/fflate'), path.join(packageRoot, 'node_modules/fflate'), { recursive: true });
const shared = [];
for (const relative of SHARED_PAYLOAD) {
  const bytes = await fs.readFile(path.join(cli, relative)); await fs.mkdir(path.dirname(path.join(packageRoot, relative)), { recursive: true }); await fs.writeFile(path.join(packageRoot, relative), bytes);
  shared.push({ path: relative, size: bytes.length, sha256: sha(bytes) });
}
shared.sort((a, b) => a.path < b.path ? -1 : 1);
const binary = Buffer.from('#!/bin/sh\nprintf "native installer fixture\\n"\n'), nativePath = 'studio/linux/zuku-studio';
const manifest = { schema: 'zuku-studio-native-asset/1', product: 'zuku-studio', protocolVersion: 1, version, platform: { id: platform, os: 'linux', arch: 'x64' }, cli: { name: pkg.name, version, aliases: ['zuku', 'zukujs'] }, source: { gitCommit: commit, treeState: 'clean' }, sharedPayload: shared, node: { version: '22.22.3', bundled: false }, launcher: { managedNode: 'runtime/bin/node', requiresManagedNode: true, installMarkerSchema: 'zukujs-user-install/1', host: 'npm/lib/node_modules/@zukujs/cli/lib/studio-host.mjs', hostArgs: ['--stdio'] }, placement: { relativeTo: 'release', ownerConfirmed: true }, executable: nativePath, artifacts: [{ path: nativePath, size: binary.length, sha256: sha(binary), executable: true }] };
const nativeAsset = value => {
  const target = value.platform.id, format = target.startsWith('win-') ? 'zip' : 'tar.gz';
  const bytes = Buffer.from(JSON.stringify(value) + '\n'), archive = createArchive(format, [{ path: 'source-manifest.json', bytes }, { path: value.artifacts[0].path, bytes: binary, executable: true }], 1780000000);
  return { archive, record: { schema: 'zuku-studio-native-asset-record/1', product: 'zuku-studio', version, platform: target, file: `zuku-studio-${version}-${target}.${format}`, format, size: archive.length, sha256: sha(archive), manifestSHA256: sha(bytes), gitCommit: commit, treeState: 'clean' } };
};
const native = nativeAsset(manifest), nativeFile = path.join(work, 'native.tar.gz'); await fs.writeFile(nativeFile, native.archive);
const npm = path.join(path.dirname(process.execPath), 'npm');
const packed = spawnSync(npm, ['pack', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--pack-destination', work, '--json'], { cwd: packageRoot, encoding: 'utf8' }); assert.equal(packed.status, 0, packed.stderr);
const cliFile = path.join(work, JSON.parse(packed.stdout)[0].filename);
const runtimeRoot = path.join(work, 'node-v22.22.3-linux-x64'); await fs.mkdir(path.join(runtimeRoot, 'bin'), { recursive: true });
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
await fs.writeFile(path.join(runtimeRoot, 'bin/node'), `#!/bin/bash\nif [[ "\${1:-}" == --version ]]; then echo v22.22.3; else exec ${quote(process.execPath)} "$@"; fi\n`, { mode: 0o755 });
await fs.writeFile(path.join(runtimeRoot, 'bin/npm'), `#!/bin/bash\nexec ${quote(npm)} "$@"\n`, { mode: 0o755 });
const runtimeFile = path.join(work, 'runtime.tar.gz'); assert.equal(spawnSync('tar', ['-czf', runtimeFile, '-C', work, path.basename(runtimeRoot)]).status, 0);
const contract = { schema: 'zukujs-installer/1', cli: { name: pkg.name, version, url: `https://zuzunza.com/downloads/zukujs/cli/${version}/zukujs-cli-${version}.tgz`, sha256: sha(await fs.readFile(cliFile)) }, node: { version: '22.22.3', artifacts: { [platform]: { url: 'https://nodejs.org/dist/v22.22.3/node-v22.22.3-linux-x64.tar.gz', sha256: sha(await fs.readFile(runtimeFile)) } } }, studio: { schema: 'zukujs-studio-installer/1', repository: 'zukuapp/zukujs-cli', tag: `v${version}`, protocolVersion: 1, assets: { [platform]: { url: `https://github.com/zukuapp/zukujs-cli/releases/download/v${version}/${native.record.file}`, record: native.record } } } };

test('complete fixed Studio contract rejects missing, foreign, dirty or incompatible assets', () => {
  validateContract(contract);
  for (const mutate of [c => { delete c.studio.assets[platform].record.manifestSHA256; }, c => { c.studio.protocolVersion = 2; }, c => { c.studio.assets[platform].url = 'https://evil.example/native.tar.gz'; }, c => { c.studio.assets[platform].record.treeState = 'modified'; }, c => { c.studio.assets[platform].record.platform = 'linux-arm64'; }, c => { delete c.node.artifacts[platform]; }, c => { c.studio.tag = 'latest'; }]) { const c = structuredClone(contract); mutate(c); assert.throws(() => validateContract(c)); }
});

test('native downloader permits only fixed asset and bounded official CDN redirect; verifies bytes', async () => {
  const target = path.join(work, 'download-verified.tar.gz'), visited = [];
  await downloadNative(contract, platform, target, { fetchImpl: async (url, options) => { visited.push(url); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit'); return visited.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture?sig=fixture' } }) : new Response(native.archive); } });
  assert.equal(sha(await fs.readFile(target)), native.record.sha256); assert.equal(visited.length, 2);
  await assert.rejects(downloadNative(contract, platform, path.join(work, 'redirect-denied'), { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/blob' } }) }), /official release transport/);
  await assert.rejects(downloadNative(contract, platform, path.join(work, 'tamper-denied'), { fetchImpl: async () => new Response(Buffer.alloc(native.record.size)) }), /checksum/);
  await assert.rejects(fs.stat(path.join(work, 'tamper-denied')), { code: 'ENOENT' });
});

test('actual native archive extraction verifies protocol, shared source, placement and collision', async () => {
  const stage = path.join(work, 'stage'); await fs.mkdir(stage); await fs.writeFile(path.join(stage, 'install.json'), JSON.stringify({ schema: 'zukujs-user-install/1', version, sha256: contract.cli.sha256, node: path.join(stage, 'runtime/bin/node') }));
  const result = await installNative(contract, platform, { archiveFile: nativeFile, cliRoot: packageRoot, containerDir: stage, runtimeDir: stage });
  assert.equal(result.executable, nativePath); assert.deepEqual(await fs.readFile(path.join(stage, nativePath)), binary);
  await assert.rejects(installNative(contract, platform, { archiveFile: nativeFile, cliRoot: packageRoot, containerDir: stage, runtimeDir: stage }), { code: 'EEXIST' });
  for (const mutate of [m => { m.protocolVersion = 2; }, m => { m.launcher.managedNode = '/usr/bin/node'; }, m => { m.placement.ownerConfirmed = false; }, m => { m.sharedPayload[0].sha256 = 'b'.repeat(64); }, m => { m.source.treeState = 'modified'; }, m => { m.executable = m.artifacts[0].path = 'npm/malicious.js'; }]) {
    const value = structuredClone(manifest); mutate(value); const bad = nativeAsset(value), c = structuredClone(contract); c.studio.assets[platform].record = bad.record;
    const file = path.join(work, `bad-${crypto.randomBytes(4).toString('hex')}.tgz`); await fs.writeFile(file, bad.archive);
    const fresh = path.join(work, `negative-${crypto.randomBytes(4).toString('hex')}`); await fs.mkdir(fresh);
    await assert.rejects(installNative(c, platform, { archiveFile: file, cliRoot: packageRoot, containerDir: fresh, runtimeDir: fresh })); assert.deepEqual(await fs.readdir(fresh), []);
  }
  if (process.platform !== 'win32') {
    const fresh = path.join(work, 'linked-stage'), outside = path.join(work, 'outside'); await fs.mkdir(fresh); await fs.mkdir(outside); await fs.symlink(outside, path.join(fresh, 'studio'));
    await assert.rejects(installNative(contract, platform, { archiveFile: nativeFile, cliRoot: packageRoot, containerDir: fresh, runtimeDir: fresh }), /Unsafe Studio staging/); assert.deepEqual(await fs.readdir(outside), []);
  }
});

test('rendered full Bash install and second-alias rollback preserve both aliases and full release', async () => {
  const contractFile = path.join(work, 'contract.json'), rendered = path.join(work, 'rendered'); await fs.writeFile(contractFile, JSON.stringify(contract)); await renderInstallers(contractFile, rendered);
  const script = path.join(rendered, 'install.sh'); let source = await fs.readFile(script, 'utf8'); assert.equal(spawnSync('bash', ['-n', script]).status, 0);
  const mapping = `case "$url" in ${quote(contract.cli.url)}) cp -- ${quote(cliFile)} "$output";; ${quote(contract.node.artifacts[platform].url)}) cp -- ${quote(runtimeFile)} "$output";; *) exit 88;; esac`;
  source = source.replace(/zuku_download\(\) \{[\s\S]*?\n\}/, `zuku_download() { local url=$1 output=$2; ${mapping}; }`);
  source = source.replace('NODE_OPTIONS=\'\' "$zuku_node" "$zuku_work/native-helper.mjs" download "$zuku_work/contract.json" "$zuku_platform" "$zuku_work/studio.archive"', `cp -- ${quote(nativeFile)} "$zuku_work/studio.archive"`);
  await fs.writeFile(script, source);
  const prefix = path.join(work, 'full 설치 prefix'), home = path.join(work, 'isolated-home'); await fs.mkdir(home);
  const run = (file, args = []) => spawnSync('bash', [file, '--prefix', prefix, ...args], { env: { ...process.env, HOME: home, NODE_OPTIONS: '' }, encoding: 'utf8' });
  assert.notEqual(run(script, ['--no-node']).status, 0); assert.equal(await fs.stat(prefix).then(() => true, () => false), false);
  const installed = run(script); assert.equal(installed.status, 0, installed.stderr);
  const launchers = ['zuku', 'zukujs'].map(alias => path.join(prefix, 'bin', alias)), before = await Promise.all(launchers.map(file => fs.readFile(file)));
  assert.deepEqual(before[0], before[1]); assert.match(before[0].toString(), /runtime\/bin\/node/);
  const release = path.join(prefix, 'releases', `cli-${version}-${contract.cli.sha256.slice(0, 12)}`), markerBefore = await fs.readFile(path.join(release, 'install.json'));
  const marker = JSON.parse(markerBefore); assert.equal(marker.studio.executable, nativePath); assert.equal(marker.node, path.join(release, 'runtime/bin/node'));
  assert.deepEqual(await fs.readFile(path.join(release, nativePath)), binary);
  for (const launcher of launchers) assert.equal(spawnSync(launcher, ['--help'], { encoding: 'utf8' }).status, 0);
  const broken = path.join(rendered, 'broken.sh'); await fs.writeFile(broken, source.replace('mv -f -- "${zuku_temp_launchers[$zuku_index]}" "${zuku_launchers[$zuku_index]}"', 'if [[ $zuku_index -eq 1 ]]; then exit 77; fi\n  mv -f -- "${zuku_temp_launchers[$zuku_index]}" "${zuku_launchers[$zuku_index]}"'));
  assert.equal(run(broken).status, 77);
  assert.deepEqual(await Promise.all(launchers.map(file => fs.readFile(file))), before); assert.deepEqual(await fs.readFile(path.join(release, 'install.json')), markerBefore); assert.deepEqual(await fs.readFile(path.join(release, nativePath)), binary);
  assert.equal(await fs.stat(path.join(prefix, '.install-lock')).then(() => true, () => false), false);
});

test('synthetic macOS layout upgrades the legacy CLI marker and restores the adjacent app/runtime', async () => {
  const macPlatform = 'darwin-x64', appExecutable = 'ZUKU Studio.app/Contents/MacOS/ZUKU Studio';
  const value = structuredClone(manifest); value.platform = { id: macPlatform, os: 'darwin', arch: 'x64' }; value.placement = { relativeTo: 'release-parent', ownerConfirmed: true, releaseDirectoryName: 'zuku-runtime' }; value.executable = value.artifacts[0].path = appExecutable;
  const asset = nativeAsset(value), archiveFile = path.join(work, 'mac-studio.tar.gz'); await fs.writeFile(archiveFile, asset.archive);
  const full = structuredClone(contract); full.node.artifacts = { [macPlatform]: { url: 'https://nodejs.org/dist/v22.22.3/node-v22.22.3-darwin-x64.tar.gz', sha256: contract.node.artifacts[platform].sha256 } }; full.studio.assets = { [macPlatform]: { url: `https://github.com/zukuapp/zukujs-cli/releases/download/v${version}/${asset.record.file}`, record: asset.record } };
  const legacy = structuredClone(full); delete legacy.studio;
  const fakeBin = path.join(work, 'mac-fixture-bin'); await fs.mkdir(fakeBin); await fs.writeFile(path.join(fakeBin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo x86_64;; *) exit 77;; esac\n', { mode: 0o755 });
  const prefix = path.join(work, 'macOS 기존 설치'), home = path.join(work, 'mac-fixture-home'); await fs.mkdir(home);
  const run = file => spawnSync('bash', [file, '--prefix', prefix], { env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, NODE_OPTIONS: '' }, encoding: 'utf8' });
  const render = async (name, data) => {
    const input = path.join(work, `${name}.json`), output = path.join(work, name); await fs.writeFile(input, JSON.stringify(data)); await renderInstallers(input, output);
    const script = path.join(output, 'install.sh'); let source = await fs.readFile(script, 'utf8');
    const mapping = `case "$url" in ${quote(contract.cli.url)}) cp -- ${quote(cliFile)} "$output";; ${quote(full.node.artifacts[macPlatform].url)}) cp -- ${quote(runtimeFile)} "$output";; *) exit 88;; esac`;
    source = source.replace(/zuku_download\(\) \{[\s\S]*?\n\}/, `zuku_download() { local url=$1 output=$2; ${mapping}; }`);
    source = source.replace('NODE_OPTIONS=\'\' "$zuku_node" "$zuku_work/native-helper.mjs" download "$zuku_work/contract.json" "$zuku_platform" "$zuku_work/studio.archive"', `cp -- ${quote(archiveFile)} "$zuku_work/studio.archive"`);
    await fs.writeFile(script, source); return { script, source, output };
  };
  const old = await render('mac-legacy', legacy), oldResult = run(old.script); assert.equal(oldResult.status, 0, oldResult.stderr);
  const release = path.join(prefix, 'releases', `cli-${version}-${contract.cli.sha256.slice(0, 12)}`); assert.equal(JSON.parse(await fs.readFile(path.join(release, 'install.json'))).schema, 'zukujs-user-install/1');
  const rendered = await render('mac-full', full), upgraded = run(rendered.script); assert.equal(upgraded.status, 0, upgraded.stderr);
  const runtime = path.join(release, 'zuku-runtime'), markerBefore = await fs.readFile(path.join(runtime, 'install.json')), marker = JSON.parse(markerBefore);
  assert.equal(marker.node, path.join(runtime, 'runtime/bin/node')); assert.equal(marker.studio.relativeTo, 'release-parent'); assert.equal(marker.studio.executable, appExecutable); assert.deepEqual(await fs.readFile(path.join(release, appExecutable)), binary);
  const launchers = ['zuku', 'zukujs'].map(alias => path.join(prefix, 'bin', alias)), before = await Promise.all(launchers.map(file => fs.readFile(file)));
  assert.deepEqual(before[0], before[1]); assert.match(before[0].toString(), /zuku-runtime\/runtime\/bin\/node/);
  const broken = path.join(rendered.output, 'broken.sh'); await fs.writeFile(broken, rendered.source.replace('mv -f -- "${zuku_temp_launchers[$zuku_index]}" "${zuku_launchers[$zuku_index]}"', 'if [[ $zuku_index -eq 1 ]]; then exit 77; fi\n  mv -f -- "${zuku_temp_launchers[$zuku_index]}" "${zuku_launchers[$zuku_index]}"'));
  assert.equal(run(broken).status, 77); assert.deepEqual(await Promise.all(launchers.map(file => fs.readFile(file))), before); assert.deepEqual(await fs.readFile(path.join(runtime, 'install.json')), markerBefore); assert.deepEqual(await fs.readFile(path.join(release, appExecutable)), binary);
  // Both old aliases continue to resolve their one shared entrypoint after an explicit CLI-only reinstall.
  const downgraded = run(old.script); assert.equal(downgraded.status, 0, downgraded.stderr); assert.equal(JSON.parse(await fs.readFile(path.join(release, 'install.json'))).schema, 'zukujs-user-install/1');
  for (const launcher of launchers) assert.equal(spawnSync(launcher, ['--help'], { encoding: 'utf8' }).status, 0);
});
