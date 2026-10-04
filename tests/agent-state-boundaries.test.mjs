// State boundary regressions use private temporary files and injected adapters only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLock, loadReceipt, prepareState, RECEIPT_SCHEMA, runDir, saveReceipt, validateRunDir, writeAtomic } from '../lib/agent/state.mjs';
import { runGameAgent } from '../lib/agent/orchestrator.mjs';
import { mockRunner, scriptedProvider, tmp } from './agent-fixtures.test.mjs';

const ID = 'run_20261003120000_0123abcd';
const ID2 = 'run_20261003120000_0123abce';
const sink = { write() {} };
const posix = typeof process.getuid === 'function';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = path => lstat(path).then(() => true, () => false);
const rejectsUnsafe = promise => assert.rejects(promise, { code: 'AGENT_STATE_UNSAFE' });

async function tree(root) {
  const out = {};
  async function scan(dir, relative = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), key = join(relative, entry.name), stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('Fixture tree must contain real files only');
      if (stat.isDirectory()) await scan(path, key);
      else out[key] = digest(await readFile(path));
    }
  }
  await scan(root);
  return out;
}

async function privateState(t) {
  const cwd = await tmp(t);
  const state = await prepareState(cwd);
  const dir = await runDir(state, ID);
  await saveReceipt(dir, { schema: RECEIPT_SCHEMA, run_id: ID, state: 'packaged' });
  return { cwd, state, dir };
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  return pid;
}

const lockBytes = pid => JSON.stringify({ pid, run_id: ID, host: hostname(), started_at: '2026-10-03T12:00:00Z' });

test('state parent changed during playtest stops before outside thumbnail/receipt writes', { skip: process.platform === 'win32' }, async t => {
  const cwd = await tmp(t), outside = join(cwd, 'outside-runs'), provider = scriptedProvider(), runner = mockRunner();
  let before, moved = false;
  const playtest = { kind: 'mock', async run(input) {
    if (!moved) {
      const runs = join(cwd, '.zukujs', 'agent', 'runs');
      await rename(runs, outside); await symlink(outside, runs);
      before = await tree(outside); moved = true;
    }
    return runner.run(input);
  } };
  await rejectsUnsafe(runGameAgent({ request: 'Make a lane dodging game', name: 'state-boundary-game', mode: 'local' }, { cwd, provider, playtest, engine: null, interactive: false, quiet: true, stdout: sink, stderr: sink }));
  assert.equal(moved, true);
  assert.deepEqual(await tree(outside), before, 'outside receipt, lock and evidence bytes are preserved');
  assert.equal(provider.calls.length, 4, 'publish metadata stage never starts');
  assert.equal(runner.calls.length, 1);
});

test('every linked state directory component blocks receipt/evidence writes and subsequent locks/runs', { skip: process.platform === 'win32' }, async t => {
  for (const component of ['shared', 'agent', 'runs', 'run']) {
    const { cwd, state, dir } = await privateState(t);
    const source = { shared: dirname(state.agent), agent: state.agent, runs: state.runs, run: dir }[component];
    const outside = join(cwd, `outside-${component}`);
    await rename(source, outside); await symlink(outside, source);
    const before = await tree(outside);
    await rejectsUnsafe(writeAtomic(dir, 'thumbnail.png', Buffer.from('fixture evidence')));
    await rejectsUnsafe(saveReceipt(dir, { schema: RECEIPT_SCHEMA, run_id: ID, state: 'modified' }));
    await rejectsUnsafe(validateRunDir(dir));
    await assert.rejects(loadReceipt(state, ID), { code: 'AGENT_RESUME_INVALID' });
    if (component !== 'run') {
      await rejectsUnsafe(runDir(state, ID2));
      await rejectsUnsafe(acquireLock(state, ID2));
    }
    assert.deepEqual(await tree(outside), before, component);
  }
});

test('read-only run validation refuses a missing directory without recreating it', async t => {
  const { state } = await privateState(t), missing = join(state.runs, ID2);
  await rejectsUnsafe(validateRunDir(missing));
  await assert.rejects(loadReceipt(state, ID2), { code: 'AGENT_RESUME_INVALID' });
  assert.equal(await exists(missing), false);
});

test('stale hardlinked lock is rejected and both link names/bytes are preserved', async t => {
  const { cwd, state } = await privateState(t), outside = join(cwd, 'outside-lock.json');
  const bytes = lockBytes(await deadPid());
  await writeFile(outside, bytes, { mode: 0o600 }); await link(outside, state.lock);
  await rejectsUnsafe(acquireLock(state, ID2));
  assert.equal(await readFile(outside, 'utf8'), bytes);
  assert.equal(await readFile(state.lock, 'utf8'), bytes);
  assert.equal((await lstat(state.lock)).nlink, 2);
});

test('stale public-readable lock is rejected without reclaiming it', { skip: !posix }, async t => {
  const { state } = await privateState(t), bytes = lockBytes(await deadPid());
  await writeFile(state.lock, bytes, { mode: 0o600 }); await chmod(state.lock, 0o644);
  await rejectsUnsafe(acquireLock(state, ID2));
  assert.equal(await readFile(state.lock, 'utf8'), bytes);
  assert.equal((await lstat(state.lock)).mode & 0o777, 0o644);
});

test('private dead-process lock is reclaimed and owned lock is released', async t => {
  const { state } = await privateState(t);
  await writeFile(state.lock, lockBytes(await deadPid()), { mode: 0o600 });
  const lock = await acquireLock(state, ID2);
  assert.equal(JSON.parse(await readFile(state.lock, 'utf8')).run_id, ID2);
  await lock.release(); assert.equal(await exists(state.lock), false);
});

test('release preserves a replacement inode even when its run id and bytes match', async t => {
  const { cwd, state } = await privateState(t), lock = await acquireLock(state, ID);
  const bytes = await readFile(state.lock), original = join(cwd, 'original-lock.json');
  await rename(state.lock, original); await writeFile(state.lock, bytes, { mode: 0o600 });
  await lock.release();
  assert.deepEqual(await readFile(state.lock), bytes);
  assert.deepEqual(await readFile(original), bytes);
  assert.notEqual((await lstat(state.lock)).ino, (await lstat(original)).ino);
});

test('release preserves a lock that became hardlinked or public-readable', async t => {
  for (const linked of posix ? [true, false] : [true]) {
    const { cwd, state } = await privateState(t), lock = await acquireLock(state, ID), bytes = await readFile(state.lock);
    if (linked) await link(state.lock, join(cwd, 'lock-alias.json'));
    else await chmod(state.lock, 0o644);
    await lock.release();
    assert.deepEqual(await readFile(state.lock), bytes);
  }
});

test('oversized or secret-shaped existing lock data is refused before stale reclaim', async t => {
  for (const bytes of ['x'.repeat(4097), JSON.stringify({ ...JSON.parse(lockBytes(await deadPid())), token: 'Bearer ' + 'x'.repeat(40) })]) {
    const { state } = await privateState(t);
    await writeFile(state.lock, bytes, { mode: 0o600 });
    await rejectsUnsafe(acquireLock(state, ID2));
    assert.equal((await readFile(state.lock)).length, Buffer.byteLength(bytes));
  }
});

test('shared .zukujs permissions remain a user choice while writable parents/private child violations fail', { skip: !posix }, async t => {
  const { state } = await privateState(t), shared = dirname(state.agent);
  await chmod(shared, 0o755);
  const lock = await acquireLock(state, ID2); await lock.release();
  await chmod(shared, 0o777); await rejectsUnsafe(acquireLock(state, ID2));
  await chmod(shared, 0o755); await chmod(state.runs, 0o755);
  await rejectsUnsafe(acquireLock(state, ID2));
});
