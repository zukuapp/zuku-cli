import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const source = ['index.mjs'];
async function collect(dir) {
  for (const entry of await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
    if (entry.isDirectory()) await collect(`${dir}/${entry.name}`);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) source.push(`${dir}/${entry.name}`);
  }
}
for (const dir of ['commands', 'lib', 'scripts']) {
  await collect(dir);
}
for (const file of source) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: new URL('../', import.meta.url), stdio: 'inherit' });
  if (result.status !== 0) { process.exitCode = 1; break; }
}
if (!process.exitCode) console.log(`Syntax verified: ${source.length} modules.`);
