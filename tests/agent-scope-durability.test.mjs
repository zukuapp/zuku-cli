// Durability ordering of the scoped tool runtime on real temp projects and the real run
// store (.zukujs/agent): host journal transitions are awaited before any mutation or process
// launch, original bytes are persisted before the atomic replace, and sandbox build output
// is delivered in order, bounded, and flushed before completion. Native bwrap tests are
// skipped (never faked) where the sandbox is unavailable. Nothing here mocks the file system
// or the write/rename order; stub sandboxes are declared and only count invocations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import create from '../commands/create.mjs';
import { classifyWorkspace, admitGameRequest, createScopedToolRuntime, createSandboxRunner, detectSandbox } from '../lib/agent/scope/index.mjs';
import { createEventSink, NULL_SINK } from '../lib/agent/scope/events.mjs';
import { openRun, createRunStore } from '../lib/agent/scope/state.mjs';
import { SANDBOX_LIMITS } from '../lib/agent/scope/sandbox.mjs';
import { ScopeError } from '../lib/agent/scope/errors.mjs';

const unhandled = [];
process.on('unhandledRejection', error => unhandled.push(error));

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const native = await detectSandbox();
const skip = native.available ? false : `bwrap sandbox unavailable (${native.reason})`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const countingSandbox = () => {
  const counter = { runs: 0 };
  counter.sandbox = { capability: async () => ({ available: true, kind: 'stub', reason: null }), forms: async () => new Map([['emit', { id: 'emit', kind: 'build' }]]), run: async () => { counter.runs++; return { passed: true, exit_code: 0 }; } };
  return counter;
};

async function project(t, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zuku-scope-d-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await create(['demo'], { cwd: dir });
  const root = join(dir, 'demo');
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
  const classification = await classifyWorkspace({ cwd: root });
  const admission = admitGameRequest('Fix the player collision bug', classification);
  return { root, classification, admission };
}
async function withStore(t, root) {
  const run = await openRun(root);
  t.after(() => run.release());
  return { run, store: createRunStore(run.dir, run.runId) };
}
const tempsIn = async dir => (await readdir(dir)).filter(name => name.startsWith('.zuku-scope-'));

test('event sink: transitions await the host and propagate rejection; stage stays best effort', async () => {
  let resolved = false;
  const slow = createEventSink({ onEvent: async () => { await delay(20); resolved = true; } });
  await slow.emit('tool.started', { callId: 'call_1' });
  assert.equal(resolved, true, 'emit resolves only after the host callback settled');
  for (const onEvent of [() => { throw new Error('/abs/secret path'); }, async () => { throw new Error('disk full'); }]) {
    const sink = createEventSink({ onEvent });
    await assert.rejects(sink.emit('tool.requested', { callId: 'call_1' }), error => error.scopeCode === 'SCOPE_STATE_UNSAFE' && error.code === 'CORE_STATE_UNSAFE' && !/abs|disk/.test(error.message));
    assert.equal(sink.stage('architecture', 'started'), undefined);
  }
  // Transitions are never dropped by the event budget; only build.output is.
  const counted = [];
  const tiny = createEventSink({ onEvent: event => counted.push(event.type), limit: 1 });
  await tiny.emit('build.output', { text: 'a' }); await tiny.emit('build.output', { text: 'b' });
  await tiny.emit('build.completed', { exitCode: 0 });
  assert.deepEqual(counted, ['build.output', 'build.completed']);
  assert.equal(tiny.dropped, 1);
  assert.ok(NULL_SINK.emit('tool.started') instanceof Promise);
});

test('awaited order: requested/started are journaled before the edit, completed after the receipt', async t => {
  const { root, classification, admission } = await project(t);
  const { store } = await withStore(t, root);
  const file = join(root, 'src/game.js');
  const original = await readFile(file);
  const timeline = [];
  const onEvent = async event => {
    await delay(15);
    timeline.push({ type: event.type, onDisk: sha(readFileSync(file)), receipts: store.receipts.length });
  };
  const runtime = await createScopedToolRuntime({ classification, admission, onEvent, store, sandbox: countingSandbox().sandbox });
  const result = await runtime.execute({ tool: 'write_file', input: { path: 'src/game.js', content: '// v2\n', expected_sha256: sha(original) } });
  assert.equal(result.ok, true);
  assert.deepEqual(timeline.map(e => e.type), ['tool.requested', 'tool.started', 'tool.completed']);
  assert.equal(timeline[0].onDisk, sha(original));
  assert.equal(timeline[1].onDisk, sha(original), 'tool.started was accepted while the file was still original');
  assert.equal(timeline[2].onDisk, sha('// v2\n'));
  assert.equal(timeline[2].receipts, 1, 'tool.completed follows the durable receipt');
});

for (const blocked of ['tool.requested', 'tool.started']) {
  test(`a rejected ${blocked} journal append causes 0 edits and 0 commands`, async t => {
    const { root, classification, admission } = await project(t);
    const file = join(root, 'src/game.js');
    const original = await readFile(file);
    const seen = [];
    const onEvent = async event => { seen.push(event.type); if (event.type === blocked) throw new Error('journal append failed'); };
    const counter = countingSandbox();
    const runtime = await createScopedToolRuntime({ classification, admission, onEvent, sandbox: counter.sandbox });
    await assert.rejects(runtime.execute({ tool: 'write_file', input: { path: 'src/game.js', content: '// v2', expected_sha256: sha(original) } }), { scopeCode: 'SCOPE_STATE_UNSAFE' });
    await assert.rejects(runtime.execute({ tool: 'patch_file', input: { path: 'src/game.js', expected_sha256: sha(original), edits: [{ old: original.toString().slice(0, 10), new: 'X' }] } }), { scopeCode: 'SCOPE_STATE_UNSAFE' });
    await assert.rejects(runtime.execute({ tool: 'write_file', input: { path: 'src/new.js', content: '// new', expected_sha256: null } }), { scopeCode: 'SCOPE_STATE_UNSAFE' });
    // Agent Core direct host path (whole-file project.patch) and a host-declared build.
    await assert.rejects(runtime.execute('patch_file', { path: 'src/game.js', content: '// direct', expectedSha256: sha(original) }), { scopeCode: 'SCOPE_STATE_UNSAFE' });
    await assert.rejects(runtime.execute('run_build', { script_id: 'emit' }), { scopeCode: 'SCOPE_STATE_UNSAFE' });
    assert.deepEqual(await readFile(file), original);
    await assert.rejects(readFile(join(root, 'src/new.js')), { code: 'ENOENT' });
    assert.deepEqual(await tempsIn(join(root, 'src')), []);
    assert.equal(runtime.journal.count, 0);
    assert.equal(counter.runs, 0);
    assert.ok(!seen.includes('tool.completed') && !seen.includes('build.started'));
    if (blocked === 'tool.requested') assert.ok(!seen.includes('tool.started'));
  });
}

test('backup failure prevents the edit (real run store, removed run directory)', async t => {
  const { root, classification, admission } = await project(t);
  const { run, store } = await withStore(t, root);
  const file = join(root, 'src/game.js');
  const original = await readFile(file);
  const runtime = await createScopedToolRuntime({ classification, admission, store, sandbox: countingSandbox().sandbox });
  await rm(run.dir, { recursive: true });
  await assert.rejects(runtime.execute({ tool: 'write_file', input: { path: 'src/game.js', content: '// v2', expected_sha256: sha(original) } }), { scopeCode: 'SCOPE_STATE_UNSAFE' });
  await assert.rejects(runtime.execute('patch_file', { path: 'src/game.js', content: '// direct', expectedSha256: sha(original) }), { scopeCode: 'SCOPE_STATE_UNSAFE' });
  assert.deepEqual(await readFile(file), original);
  assert.deepEqual(await tempsIn(join(root, 'src')), []);
  assert.equal(runtime.journal.count, 0);
});

test('backup budget exhaustion is an observation and the file is untouched', async t => {
  const { root, classification, admission } = await project(t);
  const { store } = await withStore(t, root);
  const limited = Object.create(store, { backup: { value: async () => { throw new ScopeError('SCOPE_LIMIT'); } } });
  const file = join(root, 'src/game.js');
  const original = await readFile(file);
  const runtime = await createScopedToolRuntime({ classification, admission, store: limited, sandbox: countingSandbox().sandbox });
  const result = await runtime.execute({ tool: 'write_file', input: { path: 'src/game.js', content: '// v2', expected_sha256: sha(original) } });
  assert.equal(result.ok, false); assert.equal(result.observation.error, 'SCOPE_LIMIT');
  assert.deepEqual(await readFile(file), original);
});

test('the original is persisted in the run directory before the rename; it survives a failed receipt', async t => {
  const { root, classification, admission } = await project(t);
  const { run, store } = await withStore(t, root);
  const file = join(root, 'src/game.js');
  const original = await readFile(file);
  const observed = [];
  // Observes the real store from outside: when backup() resolves, the backup file must be on
  // disk with the original bytes while the project file is still unchanged.
  const watched = Object.create(store, {
    backup: { value: async bytes => {
      const saved = await store.backup(bytes);
      observed.push({ backup: await readFile(join(run.dir, saved.name)), project: await readFile(file), temps: await tempsIn(join(root, 'src')) });
      return saved;
    } },
    // Simulates the crash window: the edit is placed, then the receipt append fails.
    receipt: { value: async () => { throw new ScopeError('SCOPE_STATE_UNSAFE'); } },
  });
  const runtime = await createScopedToolRuntime({ classification, admission, store: watched, sandbox: countingSandbox().sandbox });
  await assert.rejects(runtime.execute({ tool: 'write_file', input: { path: 'src/game.js', content: '// v2\n', expected_sha256: sha(original) } }), { scopeCode: 'SCOPE_STATE_UNSAFE' });
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].backup, original);
  assert.deepEqual(observed[0].project, original, 'backup completed before any project write');
  assert.deepEqual(observed[0].temps, [], 'no temp file existed yet');
  // After the edit with no receipt, the backup is still there and matches the original hash.
  assert.equal(await readFile(file, 'utf8'), '// v2\n');
  const backups = (await readdir(run.dir)).filter(name => /^backup-\d{3}\.bin$/.test(name));
  assert.deepEqual(backups, ['backup-001.bin']);
  assert.equal(sha(await readFile(join(run.dir, backups[0]))), sha(original));
  // Rollback restores from the journal; the second edit of the same path makes no new backup.
  assert.deepEqual((await runtime.journal.rollback()).restored, ['src/game.js']);
  assert.deepEqual(await readFile(file), original);
  assert.deepEqual(await tempsIn(join(root, 'src')), []);
});

test('created files need no backup; repeated edits of one path back it up once', async t => {
  const { root, classification, admission } = await project(t);
  const { run, store } = await withStore(t, root);
  const runtime = await createScopedToolRuntime({ classification, admission, store, sandbox: countingSandbox().sandbox });
  const original = await readFile(join(root, 'src/game.js'));
  assert.equal((await runtime.execute({ tool: 'write_file', input: { path: 'src/extra.js', content: '// a', expected_sha256: null } })).ok, true);
  assert.equal((await runtime.execute({ tool: 'write_file', input: { path: 'src/game.js', content: '// 1', expected_sha256: sha(original) } })).ok, true);
  assert.equal((await runtime.execute({ tool: 'write_file', input: { path: 'src/game.js', content: '// 2', expected_sha256: sha('// 1') } })).ok, true);
  const backups = (await readdir(run.dir)).filter(name => name.startsWith('backup-'));
  assert.deepEqual(backups, ['backup-001.bin']);
  assert.deepEqual(await readFile(join(run.dir, 'backup-001.bin')), original);
});

const EMIT = n => `for (let i = 0; i < ${n}; i++) console.log('line-' + i);\n`;
const HANG = "console.log('first'); setTimeout(() => console.log('late'), 60000);\n";

async function buildRuntime(t, script, { onEvent, sinkTimeoutMs } = {}) {
  const { root, classification, admission } = await project(t, { 'tools/emit.mjs': script });
  const forms = [{ id: 'emit', kind: 'build', file: 'tools/emit.mjs' }];
  let spawned = 0;
  const spawnImpl = (...args) => { spawned++; return spawn(...args); };
  const sandbox = createSandboxRunner({ root: classification.root, forms, spawnImpl, ...(sinkTimeoutMs ? { sinkTimeoutMs } : {}) });
  const runtime = await createScopedToolRuntime({ classification, admission, onEvent, sandbox, forms });
  return { runtime, spawned: () => spawned, root };
}

test('native: a rejected build.started launches no process', { skip }, async t => {
  const { runtime, spawned } = await buildRuntime(t, EMIT(3), { onEvent: async event => { if (event.type === 'build.started') throw new Error('journal down'); } });
  await assert.rejects(runtime.execute('run_build', { script_id: 'emit' }), { scopeCode: 'SCOPE_STATE_UNSAFE' });
  assert.equal(spawned(), 0);
});

test('native: build output is delivered in order, bounded, and flushed before build.completed', { skip }, async t => {
  const events = [];
  const onEvent = async event => { if (event.type === 'build.output') await new Promise(setImmediate); events.push(event); };
  const { runtime } = await buildRuntime(t, EMIT(SANDBOX_LIMITS.outputLines + 500), { onEvent });
  const result = await runtime.execute('run_build', { script_id: 'emit' });
  assert.equal(result.status, 'passed');
  const types = events.map(e => e.type);
  assert.equal(types.indexOf('build.started'), types.indexOf('tool.started') + 1);
  assert.equal(types.at(-2), 'build.completed', 'every output line was accepted before completion');
  assert.equal(types.at(-1), 'tool.completed');
  const lines = events.filter(e => e.type === 'build.output' && e.data.stream === 'stdout').map(e => e.data.text);
  assert.ok(lines.length > 100 && lines.length <= SANDBOX_LIMITS.outputLines, String(lines.length));
  assert.deepEqual(lines, lines.map((_, i) => `line-${i}`), 'ordered, no gaps');
});

test('native: a rejected build.output kills the process and fails the tool', { skip }, async t => {
  const seen = [];
  const onEvent = async event => { seen.push(event.type); if (event.type === 'build.output') throw new Error('journal down'); };
  const { runtime } = await buildRuntime(t, HANG, { onEvent });
  const started = Date.now();
  await assert.rejects(runtime.execute('run_build', { script_id: 'emit' }), { scopeCode: 'SCOPE_STATE_UNSAFE' });
  assert.ok(Date.now() - started < 20_000, 'child was killed instead of running to its 60s timer');
  assert.ok(seen.includes('build.completed'), 'the observed exit is still journaled');
  assert.ok(!seen.includes('tool.completed'));
});

test('native: a build.output delivery past its deadline kills the process', { skip }, async t => {
  const onEvent = event => (event.type === 'build.output' ? new Promise(() => {}) : undefined);
  const { runtime } = await buildRuntime(t, HANG, { onEvent, sinkTimeoutMs: 300 });
  const started = Date.now();
  await assert.rejects(runtime.execute('run_build', { script_id: 'emit' }), { scopeCode: 'SCOPE_STATE_UNSAFE' });
  assert.ok(Date.now() - started < 20_000);
});

test('native: host verification surfaces a journal failure instead of a failed check', { skip }, async t => {
  const { runtime } = await buildRuntime(t, EMIT(2), { onEvent: async event => { if (event.type === 'build.output') throw new Error('journal down'); } });
  await assert.rejects(runtime.verify(), { scopeCode: 'SCOPE_STATE_UNSAFE' });
});

test('no unhandled promise rejections were raised by any delivery path', async () => {
  await delay(50);
  assert.deepEqual(unhandled, []);
});
