import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

// Identity copied from the public fork's zukujs-version.json; the package name
// and next bin remain those declared in its packages/next/package.json.
const FORK_IDENTITY = Object.freeze({ name: 'ZukuJS', version: '27.0.0', upstream: '16.4.0-canary.58', command_protocol: 'zuku-command/1' });
async function nextFixture(t, { identity = FORK_IDENTITY, version = '16.4.0-canary.58', bin = './dist/bin/next.mjs', source } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'zukujs-next-consumer-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const pkg = join(cwd, 'node_modules/next');
  await mkdir(join(pkg, 'dist/bin'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'next', version, type: 'module', bin: { next: bin }, ...(identity ? { zukujs: identity } : {}) }));
  await writeFile(join(pkg, 'dist/bin/next.mjs'), source ?? `process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+'\\n'); process.stderr.write('native next diagnostic\\n'); process.exitCode=7;`);
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

test('marked Next-compatible fork resolves its native next bin without renaming either CLI alias', async t => {
  const { cwd, pkg } = await nextFixture(t);
  assert.equal(await frameworkEntry(cwd), await realpath(join(pkg, 'dist/bin/next.mjs')));
  for (const command of ['dev', 'build', 'start']) {
    const result = await capture([command, '--json', '--port', '3210', 'a b'], { cwd });
    assert.equal(result.exit, 7);
    assert.deepEqual(JSON.parse(result.out), { args: [command, '--json', '--port', '3210', 'a b'], cwd: await realpath(cwd) });
    assert.equal(result.err, 'native next diagnostic\n');
  }
});

test('both installed CLI aliases delegate from a clean marked-fork consumer', async t => {
  const { cwd } = await nextFixture(t, { source: `process.stdout.write(JSON.stringify(process.argv.slice(2)));` });
  const cliPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(cliPackage.bin, { zuku: './index.mjs', zukujs: './index.mjs' });
  const binDirectory = join(cwd, 'node_modules/.bin');
  await mkdir(binDirectory, { recursive: true });
  for (const alias of Object.keys(cliPackage.bin)) {
    const executable = join(binDirectory, alias);
    await symlink(new URL('../index.mjs', import.meta.url), executable);
    const result = await promisify(execFile)(process.execPath, [executable, 'dev', '--port', '4321'], { cwd });
    assert.deepEqual(JSON.parse(result.stdout), ['dev', '--port', '4321']);
    assert.equal(result.stderr, '');
  }
});

test('the public three-field identity projection is sufficient for a marked native fork', async t => {
  const { name, version, command_protocol } = FORK_IDENTITY;
  const { cwd, pkg } = await nextFixture(t, { identity: { name, version, command_protocol } });
  assert.equal(await frameworkEntry(cwd), await realpath(join(pkg, 'dist/bin/next.mjs')));
});

test('vanilla Next, broken identities and mismatched upstream versions are never promoted', async t => {
  for (const options of [
    { identity: null },
    { identity: { version: '27.0.0' } },
    { identity: { ...FORK_IDENTITY, name: 'Next.js' } },
    { identity: { ...FORK_IDENTITY, version: 'not-a-version' } },
    { identity: { ...FORK_IDENTITY, command_protocol: 'unknown/1' } },
    { version: '16.3.5' },
  ]) {
    const { cwd } = await nextFixture(t, options);
    await assert.rejects(frameworkEntry(cwd), { code: 'FRAMEWORK_UNAVAILABLE' });
    const result = await capture(['dev', '--json'], { cwd });
    assert.equal(result.exit, 1);
    assert.equal(JSON.parse(result.err).error.code, 'FRAMEWORK_UNAVAILABLE');
    assert.equal(result.out, '');
  }
});

test('marked native next bins retain containment and CLI recursion rejection', async t => {
  const escaped = await nextFixture(t, { bin: '../../outside.mjs' });
  await writeFile(join(escaped.cwd, 'outside.mjs'), 'throw Error("must not execute")');
  await assert.rejects(frameworkEntry(escaped.cwd), { code: 'FRAMEWORK_UNAVAILABLE' });
  const linked = await nextFixture(t, { bin: './dist/bin/cli-link.mjs' });
  await symlink(new URL('../index.mjs', import.meta.url), join(linked.pkg, 'dist/bin/cli-link.mjs'));
  await assert.rejects(frameworkEntry(linked.cwd), { code: 'FRAMEWORK_UNAVAILABLE' });
});

test('marked Next-compatible fork receives cancellation and returns exit 130', async t => {
  const { cwd } = await nextFixture(t, { source: `process.stdout.write('ready\\n'); setInterval(()=>{},1000);` });
  const controller = new AbortController();
  const result = await run(['dev'], { cwd, signal: controller.signal, stdout: { write(value) { if (value.includes('ready')) controller.abort(); } }, stderr: { write() {} } });
  assert.equal(result, 130);
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
