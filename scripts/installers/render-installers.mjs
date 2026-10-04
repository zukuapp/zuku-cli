import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = path.dirname(fileURLToPath(import.meta.url));
export function validateContract(value) {
  if (value?.schema !== 'zukujs-installer/1') throw Error('Expected zukujs-installer/1.');
  const { cli, node } = value;
  if (!['@zuku/cli', '@zukujs/cli'].includes(cli?.name) || !/^\d+\.\d+\.\d+$/.test(cli.version ?? '')) throw Error('Invalid CLI identity.');
  const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
  if (!digest(cli.sha256)) throw Error('CLI SHA-256 must be complete.');
  const url = new URL(cli.url);
  if (url.protocol !== 'https:' || url.href !== cli.url || !['zuzunza.com', 'www.zuzunza.com'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9._/-]+$/.test(url.pathname) || !url.pathname.includes(cli.version) || !url.pathname.endsWith('.tgz')) throw Error('CLI URL must be a fixed versioned HTTPS site archive.');
  if (!/^22\.\d+\.\d+$/.test(node?.version ?? '')) throw Error('Node runtime must be a pinned Node.js 22 release.');
  if (!node.artifacts || typeof node.artifacts !== 'object' || Array.isArray(node.artifacts)) throw Error('Node artifact table is required.');
  const allowed = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win-x64', 'win-arm64'];
  for (const [platform, artifact] of Object.entries(node.artifacts)) {
    if (!allowed.includes(platform) || !digest(artifact.sha256)) throw Error('Invalid Node platform or checksum.');
    const ext = platform.startsWith('win-') ? 'zip' : 'tar.gz';
    if (artifact.url !== `https://nodejs.org/dist/v${node.version}/node-v${node.version}-${platform}.${ext}`) throw Error('Node URL must match the pinned official release.');
  }
  if (value.studio !== undefined) {
    const studio = value.studio;
    if (studio?.schema !== 'zukujs-studio-installer/1' || studio.repository !== 'zukuapp/zukujs-cli' || studio.tag !== `v${cli.version}` || studio.protocolVersion !== 1 || !studio.assets || typeof studio.assets !== 'object' || Array.isArray(studio.assets) || !Object.keys(studio.assets).length) throw Error('Complete compatible Studio asset metadata is required.');
    if (node.version !== '22.22.3') throw Error('Studio uses the single pinned managed Node.js 22.22.3 runtime.');
    for (const [platform, asset] of Object.entries(studio.assets)) {
      const record = asset?.record, format = platform.startsWith('win-') ? 'zip' : 'tar.gz';
      if (!allowed.includes(platform) || !node.artifacts[platform]) throw Error('Studio platform requires its verified managed Node archive.');
      if (record?.schema !== 'zuku-studio-native-asset-record/1' || record.product !== 'zuku-studio' || record.platform !== platform || record.version !== cli.version || record.format !== format || record.file !== `zuku-studio-${cli.version}-${platform}.${format}` || !digest(record.sha256) || !digest(record.manifestSHA256) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(record.gitCommit ?? '') || record.treeState !== 'clean' || !Number.isSafeInteger(record.size) || record.size < 1 || record.size > 512 * 1024 * 1024) throw Error('Studio needs the actual clean source-bound asset record.');
      if (asset.url !== `https://github.com/zukuapp/zukujs-cli/releases/download/v${cli.version}/${record.file}`) throw Error('Studio asset URL must use its fixed official GitHub release.');
    }
  }
  return value;
}
const shQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
export async function renderInstallers(contractPath, outputDirectory) {
  const contract = validateContract(JSON.parse(await fs.readFile(contractPath, 'utf8')));
  const substitutions = {
    CLI_NAME_SH: shQuote(contract.cli.name), CLI_VERSION_SH: shQuote(contract.cli.version), PACKAGE_URL_SH: shQuote(contract.cli.url),
    PACKAGE_SHA256_SH: shQuote(contract.cli.sha256), NODE_VERSION_SH: shQuote(contract.node.version),
    NODE_CASES_SH: Object.entries(contract.node.artifacts).filter(([platform]) => !platform.startsWith('win-')).map(([platform, a]) => `  ${platform}) NODE_URL=${shQuote(a.url)}; NODE_SHA256=${shQuote(a.sha256)} ;;`).join('\n'),
    STUDIO_ENABLED_SH: contract.studio ? '1' : '0',
    STUDIO_CASES_SH: Object.keys(contract.studio?.assets ?? {}).filter(platform => !platform.startsWith('win-')).map(platform => `  ${platform}) zuku_studio_available=1 ;;`).join('\n'),
    CONTRACT_JSON_SH: shQuote(JSON.stringify(contract)),
    NATIVE_HELPER_SH: await fs.readFile(path.join(base, 'native-helper.mjs'), 'utf8'),
    NATIVE_HELPER_PS: psQuote(Buffer.from(await fs.readFile(path.join(base, 'native-helper.mjs'), 'utf8')).toString('base64')),
    CONTRACT_JSON_PS: psQuote(JSON.stringify(contract)),
  };
  await fs.mkdir(outputDirectory, { recursive: true });
  for (const [input, output] of [['install.sh.in', 'install.sh'], ['install.ps1.in', 'install.ps1']]) {
    let text = await fs.readFile(path.join(base, 'templates', input), 'utf8');
    text = text.replace(/@@([A-Z0-9_]+)@@/g, (_, key) => {
      if (!Object.hasOwn(substitutions, key)) throw Error(`Unknown template field: ${key}`);
      return substitutions[key];
    });
    if (text.includes('@@')) throw Error('An unresolved template field remains.');
    await fs.writeFile(path.join(outputDirectory, output), text, { mode: output.endsWith('.sh') ? 0o755 : 0o644 });
  }
  return { version: contract.cli.version, outputDirectory, packageSHA256: contract.cli.sha256 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw Error('Usage: node render-installers.mjs CONTRACT.json OUTPUT_DIRECTORY');
  console.log(JSON.stringify(await renderInstallers(process.argv[2], process.argv[3])));
}
