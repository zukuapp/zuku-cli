// NATIVE sandbox tests: real bubblewrap processes when /usr/bin/bwrap is usable on Linux.
// They are skipped (never faked) elsewhere. Capability tests at the end use declared stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSandboxRunner, detectSandbox } from '../lib/agent/scope/index.mjs';
import { resolveForms } from '../lib/agent/scope/sandbox.mjs';

const native = await detectSandbox();
const skip = native.available ? false : `bwrap sandbox unavailable (${native.reason})`;

async function project(t, files) {
  const base = await mkdtemp(join(tmpdir(), 'zuku-scope-s-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'game');
  await mkdir(root);
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
  return { base, root };
}

test('native: passing node tests run inside bwrap; live output is streamed and redacted', { skip }, async t => {
  const { root } = await project(t, { 'tests/ok.test.mjs': "import test from 'node:test'; test('ok', () => { console.log('OPENAI_API_KEY=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA'); });\n" });
  const lines = [];
  const result = await createSandboxRunner({ root }).run('node-test', 'tests', { onOutput: line => lines.push(line) });
  assert.equal(result.sandbox, 'bwrap'); assert.equal(result.network, false);
  assert.equal(result.exit_code, 0); assert.equal(result.passed, true);
  assert.match(result.snapshot_digest, /^[0-9a-f]{64}$/);
  assert.ok(lines.length > 0 && lines.every(line => ['stdout', 'stderr'].includes(line.stream)));
  assert.doesNotMatch(JSON.stringify(lines) + result.stdout, /sk-proj-AAAA/);
});

test('native: failing tests are observed as failed', { skip }, async t => {
  const { root } = await project(t, { 'tests/bad.test.mjs': "import test from 'node:test'; import assert from 'node:assert'; test('bad', () => assert.equal(1, 2));\n" });
  const result = await createSandboxRunner({ root }).run('node-test', 'tests');
  assert.equal(result.passed, false); assert.notEqual(result.exit_code, 0);
});

test('native: no host secrets, env, home, private project files or network inside the sandbox', { skip }, async t => {
  const server = createServer(socket => socket.end('leak'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const { base, root } = await project(t, { '.env': 'ZUKU_TOKEN=supersecretvalue1234\n', '.git/config': '[core]', 'tests/iso.test.mjs': '' });
  const hostFile = join(base, 'host-secret.txt');
  await writeFile(hostFile, 'secret');
  await writeFile(join(root, 'tests/iso.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
test('isolation', async () => {
  assert.equal(process.env.ZUKU_SCOPE_HOST_SECRET, undefined);
  assert.equal(existsSync(${JSON.stringify(hostFile)}), false);
  assert.equal(existsSync('/root/.ssh'), false);
  assert.equal(existsSync('.env'), false);
  assert.equal(existsSync('.git'), false);
  assert.equal(process.env.HOME, '/tmp/home');
  assert.deepEqual(readdirSync('/tmp/home'), []);
  const outcome = await new Promise(resolve => { const s = connect(${port}, '127.0.0.1'); s.on('connect', () => resolve('connected')); s.on('error', () => resolve('blocked')); });
  assert.equal(outcome, 'blocked');
});
`);
  process.env.ZUKU_SCOPE_HOST_SECRET = 'host-env-secret';
  t.after(() => { delete process.env.ZUKU_SCOPE_HOST_SECRET; });
  const result = await createSandboxRunner({ root }).run('node-test', 'tests');
  assert.equal(result.passed, true, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /supersecretvalue1234|host-env-secret/);
});

test('native: writes stay in the disposable snapshot; timeouts kill the process tree', { skip }, async t => {
  const { root } = await project(t, { 'tests/write.test.mjs': "import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('w', () => { writeFileSync('src-created.txt', 'x'); });\n" });
  const result = await createSandboxRunner({ root }).run('node-test', 'tests');
  assert.equal(result.passed, true);
  await assert.rejects(readFile(join(root, 'src-created.txt')), { code: 'ENOENT' });
  const slow = await project(t, { 'tests/spin.test.mjs': "import test from 'node:test'; test('spin', () => { for(;;){} });\n" });
  const started = Date.now();
  const spun = await createSandboxRunner({ root: slow.root, timeoutMs: 1500 }).run('node-test', 'tests');
  assert.equal(spun.timed_out, true); assert.equal(spun.passed, false);
  assert.ok(Date.now() - started < 15000);
});

test('native: abort signal cancels a sandboxed run', { skip }, async t => {
  const { root } = await project(t, { 'tests/spin.test.mjs': "import test from 'node:test'; test('spin', () => { for(;;){} });\n" });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);
  await assert.rejects(createSandboxRunner({ root }).run('node-test', 'tests', { signal: controller.signal }), { code: 'COMMAND_CANCELLED' });
});

test('native: a malicious declared build script still cannot read host files or reach the network', { skip }, async t => {
  const { base, root } = await project(t, { 'scripts/build.mjs': '' });
  const hostFile = join(base, 'outside.txt');
  await writeFile(hostFile, 'outside');
  await writeFile(join(root, 'scripts/build.mjs'), `import { existsSync } from 'node:fs'; if (existsSync(${JSON.stringify(hostFile)})) process.exit(9); console.log('built');\n`);
  const result = await createSandboxRunner({ root, forms: [{ id: 'game-build', kind: 'build', file: 'scripts/build.mjs' }] }).run('game-build', 'build');
  assert.equal(result.exit_code, 0); assert.equal(result.passed, true); assert.match(result.stdout, /built/);
});

test('no unsandboxed fallback: unsupported platforms and failed probes make the capability unavailable', async t => {
  assert.deepEqual(await detectSandbox({ platform: 'darwin' }), { available: false, kind: null, reason: 'platform-unsupported' });
  assert.deepEqual(await detectSandbox({ platform: 'win32' }), { available: false, kind: null, reason: 'platform-unsupported' });
  assert.equal((await detectSandbox({ bwrapPath: '/nonexistent/bwrap' })).available, false);
  const { root } = await project(t, { 'tests/ok.test.mjs': "throw new Error('must never run');\n" });
  let spawned = false;
  const runner = createSandboxRunner({ root, detect: async () => ({ available: false, reason: 'platform-unsupported' }), spawnImpl: () => { spawned = true; throw new Error('no'); } });
  await assert.rejects(runner.run('node-test', 'tests'), { code: 'TOOL_UNAVAILABLE' });
  assert.equal(spawned, false);
});

test('command forms are host-declared: no eval/loader flags, private files or unknown ids', async t => {
  const { root } = await project(t, { 'scripts/build.mjs': '', '.secret/build.mjs': '', 'tests/a.test.mjs': '' });
  const forms = await resolveForms(root, [
    { id: 'game-build', kind: 'build', file: 'scripts/build.mjs', args: ['--mode', 'release'] },
    { id: 'evil-eval', kind: 'build', file: 'scripts/build.mjs', args: ['--eval', 'process.exit(0)'] },
    { id: 'evil-import', kind: 'build', file: 'scripts/build.mjs', args: ['--import=data:text/javascript,1'] },
    { id: 'evil-env', kind: 'build', file: 'scripts/build.mjs', args: ['--env-file=/root/.env'] },
    { id: 'private', kind: 'build', file: '.secret/build.mjs' },
    { id: 'escape', kind: 'build', file: '../x.mjs' },
    { id: 'Bad Id', kind: 'tests', file: 'scripts/build.mjs' },
  ]);
  assert.deepEqual([...forms.keys()].sort(), ['game-build', 'node-test']);
  assert.deepEqual(forms.get('game-build').argv, ['node', 'scripts/build.mjs', '--mode', 'release']);
  const runner = createSandboxRunner({ root, detect: async () => ({ available: true, kind: 'bwrap' }), spawnImpl: () => { throw new Error('no'); } });
  await assert.rejects(runner.run('evil-eval', 'build'), { code: 'TOOL_UNAVAILABLE' });
  await assert.rejects(runner.run('game-build', 'tests'), { code: 'TOOL_UNAVAILABLE' });
});
