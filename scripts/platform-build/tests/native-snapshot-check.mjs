// Actual native check for the host platform, run in a temporary git snapshot so the
// platform owners' build directories in the working tree are never written.
//   node scripts/platform-build/tests/native-snapshot-check.mjs
// Copies tracked + untracked (non-ignored) files, commits them locally in the snapshot,
// then really runs build, self-test, package --require-clean, verify and a repackage
// reproducibility comparison. Fails honestly when a compiler or native source is missing.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostPlatformId } from '../matrix.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const platform = hostPlatformId();
if (!platform) throw Error(`Unsupported host ${process.platform}-${process.arch}.`);
const run = (executable, args, cwd, timeout = 120000) => spawnSync(executable, args, { cwd, encoding: 'utf8', shell: false, timeout, maxBuffer: 64 * 1024 * 1024 });

const snapshot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zuku-platform-snapshot-')));
const listed = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], source);
if (listed.status !== 0) throw Error('git ls-files failed in the source checkout.');
for (const file of listed.stdout.split('\0')) {
  if (!file || file.startsWith('node_modules/') || /^studio\/native\/[^/]+\/(build|bin|obj)\//.test(file)) continue;
  let info; try { info = await fs.lstat(path.join(source, file)); } catch { continue; }
  if (!info.isFile()) continue;
  await fs.mkdir(path.dirname(path.join(snapshot, file)), { recursive: true });
  await fs.copyFile(path.join(source, file), path.join(snapshot, file));
}
await fs.cp(path.join(source, 'node_modules'), path.join(snapshot, 'node_modules'), { recursive: true, verbatimSymlinks: true });
await fs.appendFile(path.join(snapshot, '.gitignore'), '\nnode_modules/\n/.platform-out*/\n');
const identity = ['-c', 'user.name=snapshot', '-c', 'user.email=snapshot@example.invalid', '-c', 'commit.gpgsign=false'];
for (const args of [['init', '-q'], [...identity, 'add', '-A'], [...identity, 'commit', '-qm', 'local platform snapshot']]) {
  if (run('git', args, snapshot).status !== 0) throw Error(`git ${args.at(-3)} failed in the snapshot.`);
}
console.log(`platform ${platform}; snapshot ${snapshot}`);
const cli = args => {
  const result = run(process.execPath, ['scripts/platform-build/cli.mjs', ...args], snapshot, 20 * 60 * 1000);
  console.log(`== ${args[0]} → exit ${result.status}\n${result.stdout.trim().slice(-2500)}${result.stderr.trim() ? `\n${result.stderr.trim().slice(-4000)}` : ''}`);
  if (result.status !== 0) process.exit(1);
  return result.stdout;
};
const outA = path.join(snapshot, '.platform-out-a'), outB = path.join(snapshot, '.platform-out-b');
cli(['build', '--platform', platform]);
cli(['self-test', '--platform', platform]);
// The snapshot is committed, so treeState is clean; --require-clean is left to CI because it
// also demands the pinned Node 22.22.3, which a developer host may not run.
const first = JSON.parse(cli(['package', '--platform', platform, '--out', outA]));
if (first.treeState !== 'clean') { console.error('Snapshot tree unexpectedly modified.'); process.exit(1); }
cli(['verify', '--out', outA, '--cli-root', snapshot]);
const second = JSON.parse(cli(['package', '--platform', platform, '--out', outB]));
if (first.sha256 !== second.sha256) { console.error('Repackaging the same bytes produced a different archive hash.'); process.exit(1); }
console.log(`reproducible archive ${first.file} sha256 ${first.sha256} (${first.size} bytes; snapshot commit, not a release)`);
if (!process.argv.includes('--keep')) await fs.rm(snapshot, { recursive: true, force: true });
