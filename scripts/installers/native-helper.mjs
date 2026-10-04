// Embedded by the official installer. Native archive verification is delegated to
// the same source-bound platform verifier bundled in the one CLI package.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const fail = message => { throw Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const assetFor = (contract, platform) => {
  const asset = contract.studio?.assets?.[platform];
  if (!asset || contract.studio.schema !== 'zukujs-studio-installer/1' || contract.studio.repository !== 'zukuapp/zukujs-cli' || contract.studio.tag !== `v${contract.cli.version}` || contract.studio.protocolVersion !== 1 || asset.url !== `https://github.com/zukuapp/zukujs-cli/releases/download/v${contract.cli.version}/${asset.record.file}`) fail('No fixed verified Studio asset is available for this platform.');
  return asset;
};
const redirectUrl = (value, first) => {
  let url; try { url = new URL(value); } catch { fail('Invalid Studio download location.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail('Invalid Studio download location.');
  if (first ? url.hostname !== 'github.com' : !['release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(url.hostname)) fail('Studio download left the official release transport.');
  return url;
};

/** Manual finite HTTPS redirects accommodate GitHub's signed release CDN only. */
export async function downloadNative(contract, platform, output, { fetchImpl = globalThis.fetch } = {}) {
  const asset = assetFor(contract, platform); let url = redirectUrl(asset.url, true), response;
  const signal = AbortSignal.timeout(600000);
  for (let count = 0; count <= 3; count++) {
    response = await fetchImpl(url.href, { redirect: 'manual', credentials: 'omit', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || count === 3) fail('Studio download redirect limit exceeded.');
      url = redirectUrl(new URL(location, url).href, false); continue;
    }
    if (response.status !== 200) { await response.body?.cancel(); fail('The fixed Studio release asset is unavailable.'); }
    break;
  }
  const size = asset.record.size;
  if (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== size) { await response.body?.cancel(); fail('Studio archive size mismatch.'); }
  const file = await fs.open(output, 'wx', 0o600), sha = createHash('sha256'); let bytes = 0;
  try {
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > size) fail('Studio archive size limit exceeded.'); sha.update(chunk); await file.write(chunk); }
    if (bytes !== size || sha.digest('hex') !== asset.record.sha256) fail('Studio archive checksum mismatch.'); await file.sync();
  } catch (error) { await fs.unlink(output).catch(() => {}); throw error; }
  finally { await file.close(); }
}

const safeRelative = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\:\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
export async function installNative(contract, platform, { archiveFile, cliRoot, containerDir, runtimeDir }) {
  const asset = assetFor(contract, platform);
  if (asset.record.treeState !== 'clean') fail('Studio requires an asset bound to clean public source.');
  const verifier = await import(pathToFileURL(path.join(cliRoot, 'scripts/platform-build/manifest.mjs')));
  const reader = await import(pathToFileURL(path.join(cliRoot, 'scripts/platform-build/archive.mjs')));
  const archive = await fs.readFile(archiveFile);
  const manifest = await verifier.verifyAsset(asset.record, archive, { cliRoot });
  if (manifest.product !== 'zuku-studio' || manifest.protocolVersion !== 1 || manifest.source?.treeState !== 'clean' || !['@zuku/cli', '@zukujs/cli'].includes(manifest.cli?.name) || manifest.cli.name !== contract.cli.name || manifest.cli.version !== contract.cli.version || manifest.node?.version !== contract.node.version || manifest.launcher?.installMarkerSchema !== 'zukujs-user-install/1' || manifest.launcher.requiresManagedNode !== true || manifest.launcher.hostArgs?.join('\n') !== '--stdio' || manifest.placement?.ownerConfirmed !== true) fail('Studio asset installation protocol/layout mismatch.');
  const parentLayout = platform.startsWith('darwin-');
  if (manifest.placement.relativeTo !== (parentLayout ? 'release-parent' : 'release') || parentLayout && (manifest.placement.releaseDirectoryName !== 'zuku-runtime' || runtimeDir !== path.join(containerDir, 'zuku-runtime'))) fail('Studio release placement mismatch.');
  const managedNode = platform.startsWith('win-') ? 'runtime/node.exe' : 'runtime/bin/node';
  if (manifest.launcher.managedNode !== managedNode) fail('Studio must use this release\'s one managed runtime.');
  const nativePrefix = parentLayout ? 'ZUKU Studio.app/' : platform.startsWith('win-') ? 'studio/windows/' : 'studio/linux/';
  const nativeExecutable = parentLayout ? `${nativePrefix}Contents/MacOS/ZUKU Studio` : `${nativePrefix}${platform.startsWith('win-') ? 'ZukuStudio.exe' : 'zuku-studio'}`;
  if (manifest.executable !== nativeExecutable || manifest.artifacts.some(entry => !safeRelative(entry.path) || !entry.path.startsWith(nativePrefix))) fail('Studio artifacts must stay inside the finite native placement.');
  const files = reader.readArchive(asset.record.format, archive); let total = 0;
  for (const [relative, entry] of files) {
    if (!safeRelative(relative) || (total += entry.bytes.length) > 768 * 1024 * 1024) fail('Unsafe Studio archive path or size.');
    const target = path.join(containerDir, ...relative.split('/'));
    // Only a new private staging tree is accepted. Links, collisions and pre-existing files fail.
    let cursor = containerDir;
    const base = await fs.lstat(cursor); if (!base.isDirectory() || base.isSymbolicLink()) fail('Unsafe Studio staging directory.');
    for (const component of relative.split('/').slice(0, -1)) {
      cursor = path.join(cursor, component);
      let stat; try { stat = await fs.lstat(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; await fs.mkdir(cursor, { mode: 0o700 }); stat = await fs.lstat(cursor); }
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Unsafe Studio staging directory.');
    }
    await fs.writeFile(target, entry.bytes, { flag: 'wx', mode: relative === 'source-manifest.json' ? 0o600 : manifest.artifacts.find(item => item.path === relative)?.executable ? 0o755 : 0o644 });
  }
  const marker = JSON.parse(await fs.readFile(path.join(runtimeDir, 'install.json'), 'utf8'));
  marker.studio = { protocolVersion: 1, platform, relativeTo: manifest.placement.relativeTo, executable: manifest.executable, sha256: asset.record.sha256, manifestSHA256: asset.record.manifestSHA256, gitCommit: manifest.source.gitCommit };
  await fs.writeFile(path.join(runtimeDir, 'install.json'), JSON.stringify(marker) + '\n', { mode: 0o600 });
  return marker.studio;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, contractFile, platform, ...args] = process.argv.slice(2), contract = JSON.parse(await fs.readFile(contractFile, 'utf8'));
    if (mode === 'download' && args.length === 1) await downloadNative(contract, platform, args[0]);
    else if (mode === 'install' && args.length === 4) await installNative(contract, platform, { archiveFile: args[0], cliRoot: args[1], containerDir: args[2], runtimeDir: args[3] });
    else fail('Invalid native installer invocation.');
  } catch { process.stderr.write('ZukuJS installer: verified Studio asset download/installation failed. Existing release preserved.\n'); process.exitCode = 1; }
}
