// Finite native build matrix for ZUKU Studio platform assets.
// Pure data and argv construction only: nothing here runs a process or reads input
// from a model, renderer or network. Every command is an executable plus an argv array.
import path from 'node:path';

export const PRODUCT = 'zuku-studio';
export const CLI_PACKAGE = '@zukujs/cli';
// The official installer pins this runtime; native assets never bring a second Node.
export const MANAGED_NODE_VERSION = '22.22.3';
export const INSTALL_MARKER_SCHEMA = 'zukujs-user-install/1';
export const MANIFEST_SCHEMA = 'zuku-studio-native-asset/1';
export const ASSET_RECORD_SCHEMA = 'zuku-studio-native-asset-record/1';
// Standard native GitHub-hosted labels verified against GitHub's runner reference.
// Keep .github/workflows/studio-platform.yml aligned; availability is not a test pass.
export const CI_RUNNERS = Object.freeze({
  'linux-x64': 'ubuntu-24.04',
  'linux-arm64': 'ubuntu-24.04-arm',
  'darwin-x64': 'macos-15-intel',
  'darwin-arm64': 'macos-15',
  'win-x64': 'windows-2025',
  'win-arm64': 'windows-11-arm',
});

// Files of the single npm payload the native shell loads at runtime. Their hashes are
// recorded so the installer can confirm a native asset matches the installed CLI.
export const SHARED_PAYLOAD = Object.freeze([
  'lib/agent-protocol/schema.mjs',
  'studio/native/bridge.js',
  'studio/renderer/index.html',
  'studio/renderer/main.mjs',
  'studio/renderer/index.mjs',
  'studio/renderer/app.mjs',
  'studio/renderer/client.mjs',
  'studio/renderer/state.mjs',
  'studio/renderer/dom.mjs',
  'studio/renderer/diff.mjs',
  'studio/renderer/preview.mjs',
  'studio/renderer/styles.css',
]);

const unixLayout = Object.freeze({
  installMarker: 'install.json',
  managedNode: 'runtime/bin/node',
  cliRoot: 'npm/lib/node_modules/@zukujs/cli',
});
const windowsLayout = Object.freeze({
  installMarker: 'install.json',
  managedNode: 'runtime/node.exe',
  cliRoot: 'npm/node_modules/@zukujs/cli',
});

// `placement` maps repository build outputs to install-relative archive paths.
//   relativeTo 'release'        → the installed release directory (holds install.json)
//   relativeTo 'release-parent' → its parent; the release directory must then be named
//                                 `releaseDirectoryName` (macOS Installation.swift contract)
// `ownerConfirmed` records whether the platform shell's own locator already reads that layout.
const placement = (relativeTo, ownerConfirmed, map, extra = {}) => Object.freeze({ relativeTo, ownerConfirmed, map: Object.freeze(map.map(([from, to]) => Object.freeze({ from, to }))), ...extra });

const linux = arch => Object.freeze({
  id: `linux-${arch}`, os: 'linux', arch, nativeDir: 'studio/native/linux', format: 'tar.gz', layout: unixLayout,
  // Its native locator verifies install.json, CLI identity and this release's managed Node.
  placement: placement('release', true, [
    ['studio/native/linux/build/zuku-studio', 'studio/linux/zuku-studio'],
    ['studio/native/linux/zuku-studio.desktop.in', 'studio/linux/zuku-studio.desktop.in'],
  ]),
  defaultExecutable: 'studio/native/linux/build/zuku-studio',
  selfTests: [['--self-test'], ['--stdio-test']],
});
const darwin = arch => Object.freeze({
  id: `darwin-${arch}`, os: 'darwin', arch, nativeDir: 'studio/native/macos', format: 'tar.gz', layout: unixLayout,
  placement: placement('release-parent', true, [[`studio/native/macos/build/${arch === 'x64' ? 'x86_64' : 'arm64'}/ZUKU Studio.app`, 'ZUKU Studio.app']], { releaseDirectoryName: 'zuku-runtime' }),
  defaultExecutable: `studio/native/macos/build/${arch === 'x64' ? 'x86_64' : 'arm64'}/ZUKU Studio.app/Contents/MacOS/ZukuStudio`,
  selfTests: [['--self-test'], ['--stdio-test']],
});
const windows = arch => Object.freeze({
  id: `win-${arch}`, os: 'win32', arch, nativeDir: 'studio/native/windows', format: 'zip', layout: windowsLayout,
  // InstallLocator.cs: <release>\studio\windows\ZukuStudio.exe
  placement: placement('release', true, [[`studio/native/windows/build/win-${arch}`, 'studio/windows']]),
  defaultExecutable: `studio/native/windows/build/win-${arch}/ZukuStudio.exe`,
  selfTests: [['--self-test'], ['--stdio-test']],
});
export const defaultArtifacts = descriptor => descriptor.placement.map.map(entry => entry.from);

/** Install-relative archive path for a repository artifact file, from the finite placement map. */
export function placedPath(descriptor, rel) {
  for (const { from, to } of descriptor.placement.map) {
    if (rel === from) return to;
    if (rel.startsWith(`${from}/`)) return `${to}${rel.slice(from.length)}`;
  }
  throw new PlatformBuildError('ARTIFACT_OUTSIDE', `Artifact is outside the ${descriptor.id} placement map: ${rel}`);
}

export const PLATFORMS = Object.freeze(Object.fromEntries(
  [linux('x64'), linux('arm64'), darwin('x64'), darwin('arm64'), windows('x64'), windows('arm64')].map(p => [p.id, p]),
));

export class PlatformBuildError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new PlatformBuildError(code, message); };

export function platformDescriptor(id) {
  if (typeof id !== 'string' || !Object.hasOwn(PLATFORMS, id)) fail('PLATFORM_UNKNOWN', `Unknown platform; expected one of ${Object.keys(PLATFORMS).join(', ')}.`);
  return PLATFORMS[id];
}

export function hostPlatformId(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'win' : platform;
  const id = `${os}-${arch}`;
  return Object.hasOwn(PLATFORMS, id) ? id : null;
}

// Native shells are only built on their own OS and architecture; no cross-build claims.
export function assertNativeHost(descriptor, platform = process.platform, arch = process.arch) {
  if (descriptor.os !== platform || descriptor.arch !== arch) fail('HOST_MISMATCH', `${descriptor.id} must be built on its own operating system and architecture (host is ${platform}-${arch}).`);
}

export const assetBaseName = (version, platformId) => `${PRODUCT}-${version}-${platformId}`;
export const archiveName = (version, descriptor) => `${assetBaseName(version, descriptor.id)}.${descriptor.format}`;

/**
 * Build steps for one platform. `tools` maps a logical tool name to an absolute
 * executable path that the caller resolved; `project` lists finite repository-relative
 * project files the recipe needs (Windows: exactly one WinExe .csproj under src/).
 */
export function buildSteps(descriptor, { tools, nodeExecutable, project, cliVersion } = {}) {
  const need = name => {
    const value = tools?.[name];
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail('TOOL_MISSING', `${name} is required to build ${descriptor.id} but was not found.`);
    return value;
  };
  if (descriptor.os === 'linux') {
    // The Makefile embeds this value in a compiler define, so only plain path characters pass.
    if (typeof nodeExecutable !== 'string' || !path.isAbsolute(nodeExecutable) || !/^[A-Za-z0-9/._+-]+$/.test(nodeExecutable)) fail('NODE_MISSING', 'An absolute Node executable path without spaces or quoting characters is required by the Linux Makefile.');
    const make = need('make');
    const vars = [`NODE_EXECUTABLE=${nodeExecutable}`];
    return [
      { label: 'compile', executable: make, args: ['-C', descriptor.nativeDir, ...vars, 'all'] },
      { label: 'make-check', executable: make, args: ['-C', descriptor.nativeDir, ...vars, 'check'] },
    ];
  }
  if (descriptor.os === 'darwin') {
    if (typeof nodeExecutable !== 'string' || !path.isAbsolute(nodeExecutable)) fail('NODE_MISSING', 'An absolute managed Node executable is required for macOS stdio staging.');
    // build.sh/Installation.swift require a single architecture and a sibling zuku-runtime.
    // Only the app bundle is mapped into the native asset; the staged Node is a test copy.
    return [{ label: 'compile', executable: need('bash'), args: [`${descriptor.nativeDir}/build.sh`, '--arch', descriptor.arch === 'x64' ? 'x86_64' : 'arm64', '--stage-runtime', '--node', nodeExecutable] }];
  }
  if (typeof project !== 'string' || !project.startsWith(`${descriptor.nativeDir}/src/`) || !project.endsWith('.csproj')) fail('PROJECT_MISSING', `Exactly one WinExe .csproj under ${descriptor.nativeDir}/src is required.`);
  // Directory.Build.props compiles ZukuCliVersion into the shell; the locator requires it exactly.
  if (typeof cliVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(cliVersion)) fail('PACKAGE_INVALID', 'The CLI version from package.json is required for the Windows shell.');
  // Official Windows assets include .NET/WPF, so a fresh PC needs no .NET installation.
  // WebView2 Evergreen remains separate; the one Agent Core still uses managed Node.
  return [{
    label: 'compile', executable: need('dotnet'),
    args: ['publish', project, '--nologo', '-c', 'Release', '-r', `win-${descriptor.arch}`, '--self-contained', 'true', `-p:ZukuCliVersion=${cliVersion}`, '-o', descriptor.placement.map[0].from],
  }];
}

/** Exact native test argv; Windows Program.Main requires the explicit synthetic peer. */
export function selfTestArguments(descriptor, { rootReal, nodeExecutable } = {}) {
  return descriptor.selfTests.map(args => {
    if (descriptor.os !== 'win32' || args[0] !== '--stdio-test') return [...args];
    if (typeof rootReal !== 'string' || !path.isAbsolute(rootReal) || typeof nodeExecutable !== 'string' || !path.isAbsolute(nodeExecutable)) fail('NODE_MISSING', 'Windows stdio tests require the checkout and managed Node absolute paths.');
    return ['--stdio-test', '--node', nodeExecutable, '--fixture', path.join(rootReal, descriptor.nativeDir, 'tests', 'stdio-fixture.mjs')];
  });
}

export const requiredTools = descriptor => descriptor.os === 'linux' ? ['make', 'cc', 'pkg-config'] : descriptor.os === 'darwin' ? ['bash', 'xcrun'] : ['dotnet'];
