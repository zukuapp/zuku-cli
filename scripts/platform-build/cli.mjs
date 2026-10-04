// ZUKU Studio native platform asset helper.
//   node scripts/platform-build/cli.mjs plan      --platform linux-x64
//   node scripts/platform-build/cli.mjs build     --platform linux-x64
//   node scripts/platform-build/cli.mjs self-test --platform linux-x64
//   node scripts/platform-build/cli.mjs package   --platform linux-x64 --out /abs/dir [--require-clean]
//   node scripts/platform-build/cli.mjs verify    --record /abs/x.asset.json | --out /abs/dir [--cli-root /abs/cli]
// Processes are spawned as executable + argv without a shell. Paths are finite,
// repository-relative and validated; nothing here publishes, signs or uploads.
import fs from 'node:fs/promises';
import { accessSync, constants, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PlatformBuildError, MANAGED_NODE_VERSION, platformDescriptor, assertNativeHost, buildSteps, selfTestArguments, requiredTools, assetBaseName, hostPlatformId, defaultArtifacts } from './matrix.mjs';
import { relativePath, within, collectArtifacts, hashRepositoryFiles, prepareOutputDirectory, writeExclusive } from './fs-safety.mjs';
import { createAsset, verifyAsset, canonical, readPackageVersion, MANIFEST_NAME } from './manifest.mjs';

export const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fail = (code, message) => { throw new PlatformBuildError(code, message); };

/** Resolve a tool from PATH to an absolute regular executable; Windows accepts only .exe. */
export function findTool(name, env = process.env, platform = process.platform) {
  const names = platform === 'win32' ? [`${name}.exe`] : [name];
  for (const directory of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const candidate of names) {
      const file = path.join(directory, candidate);
      try { if (statSync(file).isFile()) { if (platform !== 'win32') accessSync(file, constants.X_OK); return file; } } catch {}
    }
  }
  return null;
}

// The desktop app is the single src/<Name>/<Name>.csproj declaring <OutputType>WinExe; library
// and test projects (e.g. ZukuStudio.Core) are compiled through its references.
export async function windowsProject(rootReal, descriptor) {
  const src = `${descriptor.nativeDir}/src`, found = [];
  let directories = [];
  try { directories = (await fs.readdir(path.join(rootReal, src), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of directories) {
    const rel = relativePath(`${src}/${name}/${name}.csproj`, 'project');
    let text;
    try { const info = await fs.lstat(path.join(rootReal, rel)); if (!info.isFile()) continue; text = await fs.readFile(path.join(rootReal, rel), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (/<OutputType>\s*WinExe\s*<\/OutputType>/.test(text)) found.push(rel);
  }
  if (found.length !== 1) fail('PROJECT_MISSING', `Expected exactly one WinExe project at ${src}/<Name>/<Name>.csproj, found ${found.length}.`);
  return found[0];
}

async function nativeSourcePresent(rootReal, descriptor) {
  try { if ((await fs.lstat(path.join(rootReal, descriptor.nativeDir))).isDirectory()) return; } catch {}
  fail('SOURCE_MISSING', `${descriptor.nativeDir} is not present in this checkout.`);
}

export async function plan(platform, options = {}) {
  const descriptor = platformDescriptor(platform);
  const rootReal = await fs.realpath(options.root ?? REPOSITORY);
  const tools = Object.fromEntries(requiredTools(descriptor).map(name => [name, findTool(name)]));
  const missing = Object.entries(tools).filter(([, value]) => !value).map(([name]) => name);
  let steps = null, problem = null;
  try {
    const project = descriptor.os === 'win32' ? await windowsProject(rootReal, descriptor) : undefined;
    const cliVersion = await readPackageVersion(rootReal);
    steps = buildSteps(descriptor, { tools, nodeExecutable: options.nodeExecutable ?? process.execPath, project, cliVersion });
  } catch (error) { if (!(error instanceof PlatformBuildError)) throw error; problem = `${error.code}: ${error.message}`; }
  return { platform: descriptor.id, host: hostPlatformId(), native: hostPlatformId() === descriptor.id, missingTools: missing, steps, problem };
}

function run(step, rootReal, timeout) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const result = spawnSync(step.executable, step.args, { cwd: rootReal, env, shell: false, stdio: 'inherit', timeout, windowsHide: true });
  if (result.error) fail('STEP_FAILED', `${step.label} could not start: ${result.error.code ?? result.error.message}`);
  if (result.status !== 0) fail('STEP_FAILED', `${step.label} failed with exit status ${result.status ?? result.signal}.`);
}

export async function build(platform, options = {}) {
  const descriptor = platformDescriptor(platform);
  assertNativeHost(descriptor);
  const rootReal = await fs.realpath(options.root ?? REPOSITORY);
  await nativeSourcePresent(rootReal, descriptor);
  const result = await plan(platform, { ...options, root: rootReal });
  if (result.missingTools.length) fail('TOOL_MISSING', `Missing build tools for ${platform}: ${result.missingTools.join(', ')}. No binary was produced.`);
  if (!result.steps) fail('BUILD_UNAVAILABLE', result.problem);
  for (const step of result.steps) run(step, rootReal, 20 * 60 * 1000);
  return result.steps.map(step => step.label);
}

function executablePath(descriptor, value) {
  const rel = relativePath(value ?? descriptor.defaultExecutable, 'executable');
  if (!within(rel, descriptor.nativeDir)) fail('ARTIFACT_OUTSIDE', `Executable must be inside ${descriptor.nativeDir}.`);
  return rel;
}

export async function selfTest(platform, options = {}) {
  const descriptor = platformDescriptor(platform);
  assertNativeHost(descriptor);
  const rootReal = await fs.realpath(options.root ?? REPOSITORY);
  const rel = executablePath(descriptor, options.executable);
  const [file] = await collectArtifacts(rootReal, [rel], { base: descriptor.nativeDir, executable: rel });
  const absolute = path.join(rootReal, ...file.path.split('/'));
  if (descriptor.os === 'win32') await hashRepositoryFiles(rootReal, [`${descriptor.nativeDir}/tests/stdio-fixture.mjs`]);
  const ran = [];
  for (const args of selfTestArguments(descriptor, { rootReal, nodeExecutable: options.nodeExecutable ?? process.execPath })) {
    const label = `${path.basename(rel)} ${args[0]}`;
    run({ label, executable: absolute, args }, rootReal, 2 * 60 * 1000);
    ran.push(args[0]);
  }
  return ran;
}

export async function packageAsset(platform, options = {}) {
  const descriptor = platformDescriptor(platform);
  assertNativeHost(descriptor);
  const rootReal = await fs.realpath(options.root ?? REPOSITORY);
  // Release candidates are packaged by the pinned runtime so its bundled zlib bytes match.
  if (options.requireClean && process.version !== `v${MANAGED_NODE_VERSION}`) fail('NODE_MISMATCH', `--require-clean packaging needs Node ${MANAGED_NODE_VERSION} (running ${process.version}).`);
  const executable = executablePath(descriptor, options.executable);
  const artifacts = (options.artifacts?.length ? options.artifacts : defaultArtifacts(descriptor)).map(value => relativePath(value, 'artifact'));
  const files = await collectArtifacts(rootReal, artifacts, { base: descriptor.nativeDir, executable });
  const asset = await createAsset({ rootReal, platform, files, executable, epoch: options.sourceDateEpoch, requireClean: options.requireClean });
  const out = await prepareOutputDirectory(options.out);
  const base = assetBaseName(asset.manifest.version, descriptor.id);
  await writeExclusive(out, asset.record.file, asset.archive);
  await writeExclusive(out, `${base}.${MANIFEST_NAME}`, asset.manifestBytes);
  await writeExclusive(out, `${base}.asset.json`, Buffer.from(canonical(asset.record)));
  return asset.record;
}

async function soleRecord(directory) {
  if (!path.isAbsolute(directory ?? '')) fail('VERIFY_FAILED', '--record or --out must be an absolute path.');
  const records = (await fs.readdir(directory)).filter(name => name.endsWith('.asset.json'));
  if (records.length !== 1) fail('VERIFY_FAILED', `Expected exactly one .asset.json in the output directory, found ${records.length}.`);
  return path.join(directory, records[0]);
}

export async function verify(recordFile, options = {}) {
  if (recordFile === undefined && options.out !== undefined) recordFile = await soleRecord(options.out);
  if (!path.isAbsolute(recordFile ?? '')) fail('VERIFY_FAILED', '--record must be an absolute path.');
  const record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
  relativePath(record.file, 'record file');
  if (record.file.includes('/')) fail('VERIFY_FAILED', 'Record file must be a plain name.');
  const archive = await fs.readFile(path.join(path.dirname(recordFile), record.file));
  const manifest = await verifyAsset(record, archive, { cliRoot: options.cliRoot });
  return { verified: true, platform: manifest.platform.id, version: manifest.version, gitCommit: manifest.source.gitCommit, treeState: manifest.source.treeState, sha256: record.sha256, sharedPayloadChecked: Boolean(options.cliRoot) };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: {
    platform: { type: 'string' }, out: { type: 'string' }, record: { type: 'string' }, 'cli-root': { type: 'string' },
    artifact: { type: 'string', multiple: true }, executable: { type: 'string' }, 'node-executable': { type: 'string' },
    'source-date-epoch': { type: 'string' }, 'require-clean': { type: 'boolean' },
  } });
  const nodeExecutable = values['node-executable'];
  if (nodeExecutable !== undefined && !path.isAbsolute(nodeExecutable)) fail('NODE_MISSING', '--node-executable must be absolute.');
  const options = { nodeExecutable, executable: values.executable, artifacts: values.artifact, out: values.out, sourceDateEpoch: values['source-date-epoch'], requireClean: values['require-clean'], cliRoot: values['cli-root'] };
  if (options.cliRoot !== undefined && !path.isAbsolute(options.cliRoot)) fail('VERIFY_FAILED', '--cli-root must be absolute.');
  switch (command) {
    case 'plan': return plan(values.platform, options);
    case 'build': return { built: await build(values.platform, options) };
    case 'self-test': return { selfTests: await selfTest(values.platform, options) };
    case 'package': return packageAsset(values.platform, options);
    case 'verify': return verify(values.record, options);
    default: fail('USAGE', 'Usage: cli.mjs plan|build|self-test|package|verify --platform ID ...');
  }
}

const invokedDirectly = () => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};
if (invokedDirectly()) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch (error) {
    console.error(`zuku-studio platform build: ${error.code ?? 'ERROR'}: ${error.message}`);
    process.exitCode = 1;
  }
}
