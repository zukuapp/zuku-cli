import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const source = ['index.mjs'];
for (const dir of ['commands', 'lib', 'scripts']) {
  for (const file of await readdir(new URL(`../${dir}/`, import.meta.url))) if (file.endsWith('.mjs')) source.push(`${dir}/${file}`);
}
for (const file of source) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: new URL('../', import.meta.url), stdio: 'inherit' });
  if (result.status !== 0) { process.exitCode = 1; break; }
}
if (!process.exitCode) console.log(`Syntax verified: ${source.length} modules.`);
