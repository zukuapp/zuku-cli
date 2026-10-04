// source-manifest.json: binds a native platform asset to the git commit, the native
// source bytes, the shared npm payload it loads and the exact artifact bytes it ships.
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  PRODUCT, CLI_PACKAGES, cliRootForPackage, MANAGED_NODE_VERSION, INSTALL_MARKER_SCHEMA, MANIFEST_SCHEMA, ASSET_RECORD_SCHEMA,
  SHARED_PAYLOAD, PlatformBuildError, platformDescriptor, archiveName, placedPath,
} from './matrix.mjs';
import { sha256, relativePath, hashRepositoryFiles } from './fs-safety.mjs';
import { createArchive, readArchive, sourceEpoch } from './archive.mjs';

export const MANIFEST_NAME = 'source-manifest.json';
const fail = (code, message) => { throw new PlatformBuildError(code, message); };
export const canonical = value => `${JSON.stringify(value, null, 2)}\n`;

function git(root, args, allowed = [0]) {
  const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: root, encoding: 'utf8', shell: false, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (!allowed.includes(result.status)) fail('GIT_UNAVAILABLE', 'The source commit could not be read with git; manifests are only created from a git checkout.');
  return result.stdout;
}

// Build outputs at any depth are bound by artifact hashes, not by git.
const outputExcludes = nativeDir => ['build', 'bin', 'obj'].map(name => `:(exclude,glob)${nativeDir}/**/${name}/**`);

/** Porcelain v1 -z: "XY path\0", and for renames/copies an extra "origPath\0" token. */
export function parsePorcelain(text) {
  const tokens = text.split('\0'), paths = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    paths.push(token.slice(3));
    if (token[0] === 'R' || token[0] === 'C') paths.push(tokens[++i]);
  }
  return [...new Set(paths.filter(Boolean))].sort();
}

export function gitSource(root, nativeDir, boundPaths) {
  const commit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(commit)) fail('GIT_UNAVAILABLE', 'Unexpected git commit identifier.');
  // CRLF working copies would hash differently from the LF bytes of the single npm payload.
  if (process.platform === 'win32' && git(root, ['config', '--get', 'core.autocrlf'], [0, 1]).trim() === 'true') fail('SOURCE_EOL', 'core.autocrlf=true rewrites line endings; check out with core.autocrlf=false.');
  const commitTime = sourceEpoch(git(root, ['log', '-1', '--format=%ct', commit]).trim());
  const pathspec = ['--', ...boundPaths, ...outputExcludes(nativeDir)];
  // Untracked and ignored (non-output) files count as modifications: they could feed a build.
  // Ignored output directories are reported as one "dir/" entry that pathspec excludes miss.
  const output = new RegExp(`^${nativeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:.+/)?(?:build|bin|obj)(?:/|$)`);
  const modified = parsePorcelain(git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '-z', ...pathspec])).filter(rel => !output.test(rel));
  const tracked = git(root, ['ls-files', '-z', '--', nativeDir, ...outputExcludes(nativeDir)]).split('\0').filter(Boolean).map(rel => relativePath(rel, 'source file'));
  return { commit, commitTime, modified, tracked };
}

async function readPackage(rootReal) {
  const [entry] = await hashRepositoryFiles(rootReal, ['package.json'], { keepBytes: true });
  const pkg = JSON.parse(Buffer.from(entry.bytes).toString('utf8'));
  if (!CLI_PACKAGES.includes(pkg.name) || !/^\d+\.\d+\.\d+$/.test(pkg.version ?? '') || pkg.bin?.zuku !== './index.mjs' || pkg.bin?.zukujs !== './index.mjs') fail('PACKAGE_INVALID', 'package.json is not the single CLI payload with zuku and zukujs aliases.');
  return { name: pkg.name, version: pkg.version, sha256: entry.sha256 };
}
export const readPackageVersion = async rootReal => (await readPackage(rootReal)).version;

/**
 * Create the manifest, archive and external asset record for collected artifact files.
 * `files` come from collectArtifacts so the hashed bytes are exactly the archived bytes.
 */
export async function createAsset({ rootReal, platform, files, executable, epoch, requireClean = false }) {
  const descriptor = platformDescriptor(platform);
  relativePath(executable, 'executable');
  const vcs = gitSource(rootReal, descriptor.nativeDir, [descriptor.nativeDir, ...SHARED_PAYLOAD, 'package.json']);
  if (requireClean && vcs.modified.length) fail('SOURCE_MODIFIED', `Bound sources differ from commit ${vcs.commit}: ${vcs.modified.slice(0, 8).join(', ')}`);
  const pkg = await readPackage(rootReal);
  // Tracked native sources only; a tracked file deleted in the working tree is reported by lstat.
  const sourceFiles = await hashRepositoryFiles(rootReal, vcs.tracked);
  const shared = await hashRepositoryFiles(rootReal, SHARED_PAYLOAD);
  const layout = { ...descriptor.layout, cliRoot: cliRootForPackage(pkg.name, descriptor.os) };
  const manifest = {
    schema: MANIFEST_SCHEMA,
    product: PRODUCT,
    protocolVersion: 1,
    version: pkg.version,
    platform: { id: descriptor.id, os: descriptor.os, arch: descriptor.arch },
    cli: { name: pkg.name, version: pkg.version, packageJsonSHA256: pkg.sha256, aliases: ['zuku', 'zukujs'] },
    source: {
      gitCommit: vcs.commit,
      commitTime: vcs.commitTime,
      treeState: vcs.modified.length ? 'modified' : 'clean',
      modifiedPaths: vcs.modified.slice(0, 64),
      nativeDir: descriptor.nativeDir,
      nativeSourcesSHA256: sha256(canonical(sourceFiles)),
      nativeSources: sourceFiles,
    },
    sharedPayload: shared,
    node: { version: MANAGED_NODE_VERSION, bundled: false, owner: 'official-installer' },
    launcher: {
      relativeTo: 'installed-release-directory',
      installMarker: layout.installMarker,
      installMarkerSchema: INSTALL_MARKER_SCHEMA,
      // Studio accepts only the release's own managed runtime: install.json `node` must equal it.
      managedNode: layout.managedNode,
      requiresManagedNode: true,
      cliPackageJson: `${layout.cliRoot}/package.json`,
      cliEntry: `${layout.cliRoot}/index.mjs`,
      host: `${layout.cliRoot}/lib/studio-host.mjs`,
      hostArgs: ['--stdio'],
    },
    placement: {
      relativeTo: descriptor.placement.relativeTo,
      ...(descriptor.placement.releaseDirectoryName ? { releaseDirectoryName: descriptor.placement.releaseDirectoryName } : {}),
      ownerConfirmed: descriptor.placement.ownerConfirmed,
    },
    executable: placedPath(descriptor, executable),
    artifacts: files.map(file => ({ path: placedPath(descriptor, file.path), size: file.size, sha256: file.sha256, executable: file.executable })),
    archiveTimestamp: sourceEpoch(epoch ?? vcs.commitTime),
    publication: { released: false, signed: false, notarized: false },
  };
  const manifestBytes = Buffer.from(canonical(manifest));
  const entries = [{ path: MANIFEST_NAME, bytes: manifestBytes }, ...files.map((file, i) => ({ path: manifest.artifacts[i].path, bytes: file.bytes, executable: file.executable }))];
  if (entries.some((entry, i) => i && entry.path === MANIFEST_NAME)) fail('ARTIFACT_INVALID', `An artifact may not be named ${MANIFEST_NAME}.`);
  const archive = createArchive(descriptor.format, entries, manifest.archiveTimestamp);
  const record = {
    schema: ASSET_RECORD_SCHEMA,
    product: PRODUCT,
    version: manifest.version,
    platform: descriptor.id,
    file: archiveName(manifest.version, descriptor),
    format: descriptor.format,
    size: archive.length,
    sha256: sha256(archive),
    manifestSHA256: sha256(manifestBytes),
    gitCommit: vcs.commit,
    treeState: manifest.source.treeState,
  };
  return { manifest, manifestBytes, archive, record };
}

/** Verify an archive against its external record; optionally against an installed CLI root. */
export async function verifyAsset(record, archive, { cliRoot } = {}) {
  const descriptor = platformDescriptor(record?.platform);
  if (record.schema !== ASSET_RECORD_SCHEMA || record.product !== PRODUCT || record.format !== descriptor.format) fail('VERIFY_FAILED', 'Asset record identity mismatch.');
  if (record.file !== archiveName(record.version, descriptor)) fail('VERIFY_FAILED', 'Asset record file name mismatch.');
  if (archive.length !== record.size || sha256(archive) !== record.sha256) fail('VERIFY_FAILED', 'Archive size or SHA-256 mismatch.');
  const files = readArchive(descriptor.format, archive);
  const manifestEntry = files.get(MANIFEST_NAME);
  if (!manifestEntry || sha256(manifestEntry.bytes) !== record.manifestSHA256) fail('VERIFY_FAILED', 'Manifest missing or modified.');
  const manifest = JSON.parse(Buffer.from(manifestEntry.bytes).toString('utf8'));
  if (manifest.schema !== MANIFEST_SCHEMA || manifest.protocolVersion !== 1 || manifest.platform?.id !== descriptor.id || manifest.version !== record.version || manifest.source?.gitCommit !== record.gitCommit || manifest.source.treeState !== record.treeState) fail('VERIFY_FAILED', 'Manifest does not match the asset record or protocol.');
  if (!CLI_PACKAGES.includes(manifest.cli?.name) || manifest.cli.version !== manifest.version || !Array.isArray(manifest.cli.aliases) || manifest.cli.aliases.join('\n') !== 'zuku\nzukujs') fail('VERIFY_FAILED', 'Manifest CLI identity mismatch.');
  if (manifest.node?.version !== MANAGED_NODE_VERSION || manifest.node?.bundled !== false || manifest.launcher?.managedNode !== descriptor.layout.managedNode || manifest.launcher?.host !== `${cliRootForPackage(manifest.cli.name, descriptor.os)}/lib/studio-host.mjs`) fail('VERIFY_FAILED', 'Manifest must reference the single installer-managed Node runtime and shared host.');
  if (!Array.isArray(manifest.sharedPayload) || manifest.sharedPayload.map(entry => entry?.path).join('\n') !== [...SHARED_PAYLOAD].sort().join('\n')) fail('VERIFY_FAILED', 'Manifest shared payload list is not the expected allowlist.');
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) fail('VERIFY_FAILED', 'Manifest lists no artifacts.');
  const listed = new Set([MANIFEST_NAME]);
  for (const artifact of manifest.artifacts) {
    const entry = files.get(relativePath(artifact.path, 'manifest artifact'));
    if (!entry || entry.bytes.length !== artifact.size || sha256(entry.bytes) !== artifact.sha256) fail('VERIFY_FAILED', `Artifact mismatch: ${artifact.path}`);
    if (entry.mode !== null && Boolean(entry.mode & 0o111) !== artifact.executable) fail('VERIFY_FAILED', `Artifact mode mismatch: ${artifact.path}`);
    listed.add(artifact.path);
  }
  if (files.size !== listed.size) fail('VERIFY_FAILED', 'Archive contains files not listed in the manifest.');
  if (!manifest.artifacts.some(a => a.path === manifest.executable)) fail('VERIFY_FAILED', 'Manifest executable is not shipped.');
  if (cliRoot) await verifySharedPayload(cliRoot, manifest);
  return manifest;
}

/** Confirm an installed or checked-out CLI package carries the exact payload this asset expects. */
export async function verifySharedPayload(cliRoot, manifest) {
  const rootReal = await fs.realpath(cliRoot);
  const [entry] = await hashRepositoryFiles(rootReal, ['package.json'], { keepBytes: true });
  const pkg = JSON.parse(Buffer.from(entry.bytes).toString('utf8'));
  if (!CLI_PACKAGES.includes(pkg.name) || pkg.name !== manifest.cli.name || pkg.version !== manifest.cli.version || pkg.bin?.zuku !== './index.mjs' || pkg.bin?.zukujs !== './index.mjs') fail('VERIFY_FAILED', 'Installed CLI identity/version does not match the native asset.');
  // The shared typed stdio host the shell launches must ship in the same package.
  await hashRepositoryFiles(rootReal, ['lib/studio-host.mjs']).catch(() => fail('VERIFY_FAILED', 'The CLI package does not contain lib/studio-host.mjs.'));
  const actual = await hashRepositoryFiles(rootReal, manifest.sharedPayload.map(entry => entry.path))
    .catch(error => fail('VERIFY_FAILED', `The CLI package lacks the shared Studio payload (${error.message}).`));
  const expected = new Map(manifest.sharedPayload.map(entry => [entry.path, entry.sha256]));
  for (const entry of actual) if (expected.get(entry.path) !== entry.sha256) fail('VERIFY_FAILED', `Shared payload differs: ${entry.path}`);
  return true;
}
