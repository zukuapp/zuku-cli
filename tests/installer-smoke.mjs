// CI-only fixture transport. Production renderer URLs and checks are unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (!argv[index + 1]) throw Error(name + ' needs a path');
  return path.resolve(argv[index + 1]);
}
const cliRoot = option('--cli-root', path.resolve(import.meta.dirname, '..'));
const rendererPath = option('--renderer', path.join(cliRoot, 'scripts/installers/render-installers.mjs'));
const skipBootstrap = argv.includes('--skip-bootstrap');
const requireBootstrap = argv.includes('--require-bootstrap');
const officialRuntimeArchive = option('--official-runtime-archive', undefined);
const runtimeHashIndex = argv.indexOf('--official-runtime-sha256');
const officialRuntimeSHA = runtimeHashIndex >= 0 ? argv[runtimeHashIndex + 1] : undefined;
const windows = process.platform === 'win32';
const ps = windows ? 'pwsh' : null;
// macOS /var -> /private/var is a system alias. Use its canonical path in fixtures;
// the installer still rejects links anywhere in an actual installation path.
const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zukujs-installer-ci-')));
const resultFile = path.join(cliRoot, '.codex/installer-smoke-results.json');
const proof = { os: process.platform, arch: process.arch, node: process.version, checks: [], productionRequests: 0, officialNodeDownload: 'not exercised by this fixture test; root verifies official release URLs/checksums separately', syntheticBootstrap: 'not run', officialRuntimeBootstrap: 'not run', status: 'running' };
const skillNames = ['game-design', 'game-architecture', 'game-implementation', 'game-playtest', 'game-publish'];
const aliases = ['zuku', 'zukujs'];
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const shQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function run(executable, args, options = {}) {
  const child = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  assert.equal(child.status, 0, (child.stderr || child.stdout || child.error?.message || '').slice(-6000));
  return child.stdout;
}
function runPS(code, options = {}) { return run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + code], options); }
function check(name, extra = {}) { proof.checks.push({ name, passed: true, ...extra }); }
async function checksumFiles(files) {
  const result = {};
  for (const file of files) {
    try { result[file] = hash(await fs.readFile(file)); }
    catch (error) { if (error.code === 'ENOENT') result[file] = null; else throw error; }
  }
  return result;
}

try {
  assert.equal(Boolean(officialRuntimeArchive), Boolean(officialRuntimeSHA), 'Provide both an official runtime archive path and its independently verified SHA-256.');
  if (officialRuntimeArchive) {
    assert.match(officialRuntimeSHA, /^[a-f0-9]{64}$/);
    assert.equal(skipBootstrap, false, 'An official runtime archive cannot be combined with --skip-bootstrap.');
  }
  const { renderInstallers } = await import(pathToFileURL(rendererPath));
  const manifest = JSON.parse(await fs.readFile(path.join(cliRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@zukujs/cli');
  for (const alias of aliases) assert.equal(manifest.bin[alias], './index.mjs', 'Both aliases must point to one existing runtime.');
  assert.ok(manifest.files.every(name => typeof name === 'string'), 'The package file allowlist contains a non-string.');
  const bundled = manifest.bundledDependencies ?? manifest.bundleDependencies ?? [];
  for (const name of ['fflate', 'jose', 'playwright-core']) assert.ok(bundled.includes(name), name + ' must be bundled.');
  const npmCli = windows
    ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    : await fs.realpath(path.join(path.dirname(process.execPath), 'npm'));
  const packOutput = run(process.execPath, [npmCli, 'pack', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--update-notifier=false', '--cache', path.join(work, 'pack-cache'), '--pack-destination', work, '--json'], { cwd: cliRoot });
  const packed = JSON.parse(packOutput)[0];
  assert.ok(!packed.files.some(file => /^scripts\/(install[.](sh|ps1)|installers\/)/.test(file.path)), 'Installer files would introduce a package checksum self-reference.');
  for (const name of skillNames) assert.ok(packed.files.some(file => file.path === 'skills/' + name + '/SKILL.md'), 'Mandatory bundled skill is missing: ' + name);
  const archive = path.join(work, packed.filename);
  const archiveSHA = hash(await fs.readFile(archive));
  proof.cliVersion = manifest.version;
  proof.archiveSHA256 = archiveSHA;
  check('fresh versioned tarball includes all required bundled dependencies');

  const dummyHome = path.join(work, 'fixture-home');
  const adminBin = path.join(work, 'admin-bin');
  await fs.mkdir(dummyHome); await fs.mkdir(adminBin);
  const fakeAdmin = path.join(adminBin, windows ? 'zuku.cmd' : 'zuku');
  await fs.writeFile(fakeAdmin, windows ? '@echo off\r\necho original-admin-zuku\r\n' : '#!/bin/sh\nprintf original-admin-zuku\\n\n', { mode: 0o755 });
  const fixtureProfile = path.join(dummyHome, windows ? 'profile.ps1' : '.bashrc');
  await fs.writeFile(fixtureProfile, '# installer must preserve this profile\n');
  const realProfiles = windows
    ? JSON.parse(runPS('@($PROFILE.AllUsersAllHosts,$PROFILE.AllUsersCurrentHost,$PROFILE.CurrentUserAllHosts,$PROFILE.CurrentUserCurrentHost) | ConvertTo-Json -Compress'))
    : ['.profile', '.bashrc', '.bash_profile', '.zshrc', '.zprofile'].map(name => path.join(os.homedir(), name));
  const protectedFiles = [fakeAdmin, fixtureProfile, ...realProfiles];
  const protectedBefore = await checksumFiles(protectedFiles);
  const env = { ...process.env, PATH: adminBin + path.delimiter + path.dirname(process.execPath) + path.delimiter + process.env.PATH, HOME: dummyHome, USERPROFILE: dummyHome, NODE_OPTIONS: '' };
  for (const name of ['ZUKU_ACCESS_TOKEN', 'ZUKUJS_ACCESS_TOKEN', 'ZUKU_CREDENTIALS_FILE', 'ZUKUJS_CREDENTIALS_FILE']) delete env[name];
  const platform = (windows ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux') + '-' + process.arch;
  const cliUrl = 'https://zuzunza.com/downloads/zukujs/cli/' + manifest.version + '/zukujs-cli-' + manifest.version + '.tgz';
  const nodeVersion = '22.22.3';
  const contract = { schema: 'zukujs-installer/1', cli: { name: manifest.name, version: manifest.version, url: cliUrl, sha256: archiveSHA }, node: { version: nodeVersion, artifacts: {} } };

  async function fixtureInstaller(name, { runtimeArchive, forceRuntime = false, corruptArchive, failSecondLauncher = false } = {}) {
    const current = structuredClone(contract);
    let runtimeURL;
    if (runtimeArchive) {
      const ext = windows ? 'zip' : 'tar.gz';
      runtimeURL = 'https://nodejs.org/dist/v' + nodeVersion + '/node-v' + nodeVersion + '-' + platform + '.' + ext;
      current.node.artifacts[platform] = { url: runtimeURL, sha256: hash(await fs.readFile(runtimeArchive)) };
    }
    const directory = path.join(work, name);
    const contractFile = path.join(work, name + '.json');
    await fs.writeFile(contractFile, JSON.stringify(current));
    await renderInstallers(contractFile, directory);
    const script = path.join(directory, windows ? 'install.ps1' : 'install.sh');
    let source = await fs.readFile(script, 'utf8');
    const mappings = new Map([[cliUrl, corruptArchive ?? archive]]);
    if (runtimeURL) mappings.set(runtimeURL, runtimeArchive);
    if (windows) {
      const transport = 'switch -Exact ($Url) { ' + [...mappings].map(([url, file]) => psQuote(url) + ' { [IO.File]::Copy(' + psQuote(file) + ', $Output, $true); break }').join(' ') + " default { throw 'Fixture attempted an unknown URL' } }";
      const original = 'Invoke-WebRequest -Uri $Url -OutFile $Output -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 600';
      assert.equal(source.split(original).length, 2, 'Fixture transport boundary changed.');
      source = source.replace(original, transport);
      if (forceRuntime) {
        const originalNode = 'Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1';
        assert.equal(source.split(originalNode).length, 2);
        source = source.replace(originalNode, '$null');
      }
      if (failSecondLauncher) {
        const boundary = '[IO.File]::Move($tempLaunchers[$alias], $launcher)';
        assert.equal(source.split(boundary).length, 2);
        source = source.replace(boundary, "if ($alias -eq 'zukujs') { throw 'Fixture failure during second alias replacement' }; " + boundary);
      }
      source = '# CI FIXTURE ONLY. Download transport replaced; never publish.\n' + source;
    } else {
      const start = source.indexOf('zuku_download() {');
      const end = source.indexOf('\nzuku_verify_sha()', start);
      assert.ok(start >= 0 && end > start, 'Fixture transport boundary changed.');
      const transport = 'zuku_download() {\n  case "$1" in\n' + [...mappings].map(([url, file]) => '    ' + shQuote(url) + ') cp -- ' + shQuote(file) + ' "$2" ;;').join('\n') + '\n    *) zuku_fail "Fixture attempted an unknown URL" ;;\n  esac\n}\n';
      source = source.slice(0, start) + transport + source.slice(end);
      if (forceRuntime) {
        const originalNode = 'zuku_candidate=$(command -v node || true)';
        assert.equal(source.split(originalNode).length, 2);
        source = source.replace(originalNode, "zuku_candidate=''");
      }
      if (failSecondLauncher) {
        const boundary = 'mv -f -- "${zuku_temp_launchers[$zuku_index]}" "${zuku_launchers[$zuku_index]}"';
        assert.equal(source.split(boundary).length, 2);
        source = source.replace(boundary, '[[ $zuku_index -ne 1 ]] || zuku_fail "Fixture failure during second alias replacement"\n  ' + boundary);
      }
      source = source.replace('# Generated from', '# CI FIXTURE ONLY: file transport. Never publish.\n# Generated from');
    }
    await fs.writeFile(script, source);
    if (windows) runPS('$tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseFile(' + psQuote(script) + ',[ref]$tokens,[ref]$errors); if ($errors.Count -ne 0) { throw ($errors | Out-String) }');
    else run('bash', ['-n', script]);
    return script;
  }
  function install(script, prefix) {
    if (windows) return runPS('& ' + psQuote(script) + ' -Prefix ' + psQuote(prefix), { env });
    return run('bash', [script, '--prefix', prefix], { env });
  }
  function command(prefix, args, cwd, alias = 'zuku') {
    const launcher = path.join(prefix, 'bin', windows ? alias + '.cmd' : alias);
    if (windows) return runPS('& ' + psQuote(launcher) + ' ' + args.map(psQuote).join(' ') + '; if ($LASTEXITCODE -ne 0) { throw "Installed CLI command failed" }', { env, cwd });
    return run(launcher, args, { env, cwd });
  }
  const projectBase = path.join(work, 'projects 설치 with spaces');
  await fs.mkdir(projectBase);
  async function validateInstalled(prefix, name) {
    let commonVersion;
    for (const alias of aliases) {
      const version = JSON.parse(command(prefix, ['--version', '--json'], work, alias)).data;
      assert.equal(version.cli_version, manifest.version);
      if (commonVersion) assert.deepEqual(version, commonVersion); else commonVersion = version;
      const projectName = name + '-' + alias;
      const create = JSON.parse(command(prefix, ['create', projectName, '--json'], projectBase, alias));
      assert.equal(create.success, true);
      const project = path.join(projectBase, projectName);
      const validation = JSON.parse(command(prefix, ['validate', project, '--json'], work, alias));
      assert.equal(validation.success, true);
      for (const shell of ['bash', 'zsh', 'fish']) {
        const completion = JSON.parse(command(prefix, ['completion', shell, '--json'], work, alias));
        assert.equal(completion.success, true);
        assert.ok(completion.data.script.includes('zuku') && completion.data.script.includes('zukujs'));
      }
    }
    const markerRoot = path.join(prefix, 'releases', 'cli-' + manifest.version + '-' + archiveSHA.slice(0, 12));
    const installation = JSON.parse(await fs.readFile(path.join(markerRoot, 'install.json'), 'utf8'));
    assert.equal(run(installation.node, ['--version'], {env}).trim(), process.version, 'Installed launcher must use the selected test runtime.');
    const packageRoot = path.join(markerRoot, 'npm', ...(windows ? [] : ['lib']), 'node_modules/@zukujs/cli');
    const require = createRequire(path.join(packageRoot, 'package.json'));
    for (const dependency of ['fflate', 'jose', 'playwright-core']) {
      const resolved = require.resolve(dependency);
      assert.ok(resolved.startsWith(packageRoot + path.sep), dependency + ' must resolve from the installed offline bundle.');
      const module = await import(pathToFileURL(resolved));
      if (dependency === 'fflate') assert.equal(typeof module.zipSync, 'function');
      if (dependency === 'jose') assert.equal(typeof module.SignJWT, 'function');
      if (dependency === 'playwright-core') assert.ok(module.chromium ?? module.default?.chromium);
    }
    check('both aliases share version/create/validate/completion and bundled imports', { case: name, installedNode: process.version });
    const { loadSkillPack } = await import(pathToFileURL(path.join(packageRoot, 'lib/agent/skills.mjs')));
    const skillPack = await loadSkillPack();
    assert.deepEqual(skillPack.receipts().map(receipt => receipt.name), skillNames);
    assert.ok(skillPack.receipts().every(receipt => /^[a-f0-9]{64}$/.test(receipt.sha256)));
    check('all five installed mandatory skills pass pinned SHA validation', { case: name, packSHA256: skillPack.sha256 });
  }

  const prefix = path.join(work, 'user 설치 with spaces % [x]');
  const installer = await fixtureInstaller('existing-node');
  check(windows ? 'actual PowerShell parser accepts fixture installer' : 'native Bash syntax accepts fixture installer');
  install(installer, prefix);
  await validateInstalled(prefix, 'installer-smoke-game');
  const launchers = aliases.map(alias => path.join(prefix, 'bin', windows ? alias + '.cmd' : alias));
  const launcherBefore = await Promise.all(launchers.map(launcher => fs.readFile(launcher)));
  assert.deepEqual(launcherBefore[0], launcherBefore[1], 'Aliases must launch the same index with the same runtime.');
  install(installer, prefix);
  assert.deepEqual(await Promise.all(launchers.map(launcher => fs.readFile(launcher))), launcherBefore);
  assert.deepEqual(await checksumFiles(protectedFiles), protectedBefore);
  check('reinstall preserves both aliases, independent admin zuku and all profiles');
  const corrupt = path.join(work, 'corrupt.tgz'); await fs.writeFile(corrupt, 'wrong archive bytes');
  const tamperedInstaller = await fixtureInstaller('tampered', { corruptArchive: corrupt });
  const tamperRun = windows
    ? spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', tamperedInstaller, '-Prefix', prefix], { env, encoding: 'utf8' })
    : spawnSync('bash', [tamperedInstaller, '--prefix', prefix], { env, encoding: 'utf8' });
  assert.notEqual(tamperRun.status, 0);
  assert.deepEqual(await Promise.all(launchers.map(launcher => fs.readFile(launcher))), launcherBefore);
  for (const alias of aliases) command(prefix, ['--version'], work, alias);
  check('tampered archive fails SHA validation and preserves working installation');

  for (const index of [0, 1]) {
    await fs.writeFile(launchers[index], 'foreign existing command\n');
    const attempt = windows
      ? spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', installer, '-Prefix', prefix], { env, encoding: 'utf8' })
      : spawnSync('bash', [installer, '--prefix', prefix], { env, encoding: 'utf8' });
    assert.notEqual(attempt.status, 0);
    assert.equal(await fs.readFile(launchers[index], 'utf8'), 'foreign existing command\n');
    assert.deepEqual(await fs.readFile(launchers[1 - index]), launcherBefore[1 - index]);
    await fs.writeFile(launchers[index], launcherBefore[index]);
  }
  check('foreign existing zuku or zukujs in the user prefix aborts without overwriting either command');

  for (const launcher of launchers) await fs.appendFile(launcher, windows ? 'rem original rollback witness\r\n' : '# original rollback witness\n');
  const rollbackBefore = await Promise.all(launchers.map(launcher => fs.readFile(launcher)));
  const marker = path.join(prefix, 'releases', 'cli-' + manifest.version + '-' + archiveSHA.slice(0, 12), 'install.json');
  const markerBefore = await fs.readFile(marker);
  const failingInstaller = await fixtureInstaller('dual-alias-rollback', { failSecondLauncher: true });
  const dualAttempt = windows
    ? spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', failingInstaller, '-Prefix', prefix], { env, encoding: 'utf8' })
    : spawnSync('bash', [failingInstaller, '--prefix', prefix], { env, encoding: 'utf8' });
  assert.notEqual(dualAttempt.status, 0);
  assert.deepEqual(await Promise.all(launchers.map(launcher => fs.readFile(launcher))), rollbackBefore);
  assert.deepEqual(await fs.readFile(marker), markerBefore);
  for (const alias of aliases) command(prefix, ['--version'], work, alias);
  assert.equal((await fs.readdir(prefix)).some(name => name.startsWith('.install-')), false);
  assert.equal((await fs.readdir(path.join(prefix, 'bin'))).some(name => name.startsWith('.zukujs-')), false);
  assert.deepEqual(await checksumFiles(protectedFiles), protectedBefore);
  check('failure during second alias replacement restores both working launchers and release');

  if (!skipBootstrap && process.versions.node === nodeVersion) {
    const directoryName = 'node-v' + nodeVersion + '-' + platform;
    const runtimeRoot = path.join(work, directoryName);
    const npmSource = path.dirname(path.dirname(npmCli));
    let runtimeArchive = officialRuntimeArchive;
    if (officialRuntimeArchive) {
      assert.equal(hash(await fs.readFile(officialRuntimeArchive)), officialRuntimeSHA, 'Provided official runtime archive does not match its independently verified SHA-256.');
      proof.officialRuntimeSHA256 = officialRuntimeSHA;
      check('provided official runtime archive matches independently verified SHA-256');
    } else if (windows) {
      await fs.mkdir(runtimeRoot);
      await fs.copyFile(process.execPath, path.join(runtimeRoot, 'node.exe'));
      await fs.cp(npmSource, path.join(runtimeRoot, 'node_modules/npm'), { recursive: true, dereference: true });
    } else {
      await fs.mkdir(path.join(runtimeRoot, 'bin'), { recursive: true });
      await fs.copyFile(process.execPath, path.join(runtimeRoot, 'bin/node'));
      await fs.chmod(path.join(runtimeRoot, 'bin/node'), 0o755);
      await fs.cp(npmSource, path.join(runtimeRoot, 'lib/node_modules/npm'), { recursive: true, dereference: true });
      await fs.symlink('../lib/node_modules/npm/bin/npm-cli.js', path.join(runtimeRoot, 'bin/npm'));
    }
    if (!officialRuntimeArchive) {
      runtimeArchive = path.join(work, windows ? 'synthetic-node.zip' : 'synthetic-node.tar.gz');
      if (windows) runPS('Compress-Archive -LiteralPath ' + psQuote(runtimeRoot) + ' -DestinationPath ' + psQuote(runtimeArchive) + ' -CompressionLevel Fastest');
      else run('tar', ['-czf', runtimeArchive, '-C', work, directoryName]);
    }
    const bootstrapInstaller = await fixtureInstaller(officialRuntimeArchive ? 'official-bootstrap' : 'synthetic-bootstrap', { runtimeArchive, forceRuntime: true });
    const bootstrapPrefix = path.join(work, 'bootstrap 설치 with spaces');
    install(bootstrapInstaller, bootstrapPrefix);
    await validateInstalled(bootstrapPrefix, 'installer-bootstrap-game');
    assert.deepEqual(await checksumFiles(protectedFiles), protectedBefore);
    if (officialRuntimeArchive) {
      proof.officialRuntimeBootstrap = 'passed using the independently verified official Node.js ' + nodeVersion + ' distribution archive';
      proof.officialNodeDownload = 'provided archive was downloaded and checked against official SHASUMS before this test; fixture transport itself makes no network requests';
      proof.syntheticBootstrap = 'not run: independently verified official archive used instead';
      check('checksum-verified official pinned runtime bootstrap and final launcher');
    } else {
      proof.syntheticBootstrap = 'passed using an archive assembled from CI Node.js ' + nodeVersion + '; not the official distribution archive';
      check('checksum-verified synthetic runtime bootstrap and final launcher');
    }
  } else {
    proof.syntheticBootstrap = 'not run: requires CI Node.js ' + nodeVersion + ' and no --skip-bootstrap flag';
    assert.equal(requireBootstrap, false, 'CI must exercise the synthetic bootstrap with the pinned Node.js version.');
    assert.equal(Boolean(officialRuntimeArchive), false, 'Official runtime bootstrap requires executing this helper with pinned Node.js ' + nodeVersion + '.');
  }
  proof.status = 'passed';
} catch (error) {
  proof.status = 'failed';
  proof.failure = String(error.message).replaceAll(work, '<temporary workspace>').slice(-6000);
  throw error;
} finally {
  await fs.mkdir(path.dirname(resultFile), { recursive: true });
  await fs.writeFile(resultFile, JSON.stringify(proof, null, 2) + '\n');
  await fs.rm(work, { recursive: true, force: true });
  console.log(JSON.stringify({ status: proof.status, os: proof.os, checks: proof.checks.length, syntheticBootstrap: proof.syntheticBootstrap, officialRuntimeBootstrap: proof.officialRuntimeBootstrap, officialNodeDownload: proof.officialNodeDownload }));
}
