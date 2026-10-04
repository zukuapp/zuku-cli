import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../index.mjs';
import { frameworkEntry } from '../lib/framework-command.mjs';

async function fixture(t, { name = 'zukujs', bin = './bin.mjs', source } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'zukujs-dispatch-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const pkg = join(cwd, 'node_modules/zukujs');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, type: 'module', bin: { zukujs: bin } }));
  await writeFile(join(pkg, 'bin.mjs'), source ?? `process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+'\\n'); process.stderr.write('framework diagnostic\\n'); process.exitCode=7;`);
  return { cwd, pkg };
}

async function capture(args, options) {
  let out = '', err = '';
  const exit = await run(args, { stdout: { write: value => { out += value; } }, stderr: { write: value => { err += value; } }, ...options });
  return { out, err, exit };
}

test('framework delegation preserves native arguments, working directory, streams and exit status', async t => {
  const { cwd } = await fixture(t);
  const result = await capture(['build', '--json', '--profile', 'a b'], { cwd });
  assert.equal(result.exit, 7);
  assert.deepEqual(JSON.parse(result.out), { args: ['build', '--json', '--profile', 'a b'], cwd: await realpath(cwd) });
  assert.equal(result.err, 'framework diagnostic\n');
});

test('local game commands and unknown commands do not execute an installed framework', async t => {
  const { cwd } = await fixture(t);
  const created = await capture(['create', 'local-game', '--json'], { cwd });
  assert.equal(created.exit, 0);
  assert.equal(JSON.parse(created.out).success, true);
  const unknown = await capture(['unregistered-native', '--json'], { cwd });
  assert.equal(unknown.exit, 2);
  assert.equal(JSON.parse(unknown.err).error.code, 'UNKNOWN_COMMAND');
  assert.equal(unknown.out, '');
});

test('missing framework produces a useful safe error while standalone CLI remains usable', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'zukujs-no-framework-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const native = await capture(['dev', '--json'], { cwd });
  assert.equal(native.exit, 1);
  assert.equal(JSON.parse(native.err).error.code, 'FRAMEWORK_UNAVAILABLE');
  assert.equal(native.err.includes(cwd), false);
  assert.equal((await capture(['version', '--json'], { cwd })).exit, 0);
});

test('framework package identity and bin containment reject aliases, escapes and links to the CLI', async t => {
  const wrong = await fixture(t, { name: '@zukujs/cli' });
  await assert.rejects(frameworkEntry(wrong.cwd), { code: 'FRAMEWORK_UNAVAILABLE' });
  const escaped = await fixture(t, { bin: '../../outside.mjs' });
  await writeFile(join(escaped.cwd, 'outside.mjs'), 'throw Error("must not execute")');
  await assert.rejects(frameworkEntry(escaped.cwd), { code: 'FRAMEWORK_UNAVAILABLE' });
  const linked = await fixture(t, { bin: './cli-link.mjs' });
  await symlink(new URL('../index.mjs', import.meta.url), join(linked.pkg, 'cli-link.mjs'));
  await assert.rejects(frameworkEntry(linked.cwd), { code: 'FRAMEWORK_UNAVAILABLE' });
});

test('framework cancellation propagates to the child and returns exit 130', async t => {
  const { cwd } = await fixture(t, { source: `process.stdout.write('ready\\n'); setInterval(()=>{},1000);` });
  const controller = new AbortController();
  let out = '';
  const result = await run(['dev'], { cwd, signal: controller.signal, stdout: { write(value) { out += value; if (out.includes('ready')) controller.abort(); } }, stderr: { write() {} } });
  assert.equal(result, 130);
  assert.equal(out, 'ready\n');
});
