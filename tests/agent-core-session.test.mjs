import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink, readdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { createAgentCore, startCoreHost, createCoreClient } from '../lib/agent-core/index.mjs';
import { createCoreStorage } from '../lib/agent-core/storage.mjs';
import { createJournal } from '../lib/agent-core/journal.mjs';
import { nativeAddress } from '../lib/agent-core/host.mjs';
import { ProtocolError } from '../lib/agent-protocol/index.mjs';
import create from '../commands/create.mjs';

const native = { kind: 'native', id: 'native_test' };
let number = 0;
const envelope = (method, params = {}) => ({ protocolVersion: 1, id: `req_${++number}`, method, params });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(core, method, params = {}, actor = native) { const response = await core.dispatch(envelope(method, params), actor); if (response.error) throw new ProtocolError(response.error.code); return response.result; }
async function wait(core, sessionId, expected = 'completed') {
  for (let attempt = 0; attempt < 200; attempt++) { const state = await call(core, 'session.get', { sessionId }); if (state.state === expected) return state; if (['failed', 'cancelled', 'needs_auth'].includes(state.state) && state.state !== expected) assert.fail(JSON.stringify(state)); await pause(10); }
  assert.fail(`session did not become ${expected}`);
}
// Fixture policy is injected only into this Core test. Dedicated scope tests cover actual classifier/tool rules.
const scope = {
  async classifyWorkspace({ cwd }) { const manifest = JSON.parse(await readFile(join(cwd, 'zukujs.json'), 'utf8')); const source = await readFile(join(cwd, 'src', 'game.js'), 'utf8'); return { classification: manifest.schema === 'zukujs-project/1' && source.length ? 'zukujs' : 'unknown' }; },
  admitGameRequest(request) { if (/ecommerce|accounting|manage.*server/i.test(request)) throw new ProtocolError('AGENT_REQUEST_OUT_OF_SCOPE'); return { admitted: true }; },
};
async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'zuku-core-')); await create(['my-game'], { cwd: base });
  const stateDir = join(base, 'core'), root = join(base, 'my-game');
  const provider = { model: 'fixture/game', authMethod: { id: 'official', official: true, experimental: false }, async runStage() { return { output: {} }; } };
  const core = await createAgentCore({ stateDir, scope, providerRuntime: { async resolveStageProvider() { return provider; } }, ...options });
  t.after(async () => { await core.close(); await rm(base, { recursive: true, force: true }); });
  const project = await call(core, 'project.grant', { localPath: root, purpose: 'game.maintain' });
  return { core, base, root, stateDir, project };
}

test('one accepted request performs one actual file change across two viewers and replay', async t => {
  let operations = 0;
  const { core, root, stateDir, project } = await fixture(t, { operationRunner: async ({ project }, context) => {
    operations++; await context.onEvent({ type: 'stage', stage: 'implementation', status: 'started' });
    await writeFile(join(project.path, 'src', 'dash.js'), 'export const DASH_SPEED = 16;\n');
    return { verified: true, status: 'completed' }; // A model-like assertion is never verification evidence.
  } });
  assert.equal(project.name, 'my-game'); assert.ok(!JSON.stringify(project).includes(root));
  const session = await call(core, 'session.create', { projectHandle: project.id });
  const browser = { kind: 'browser', id: 'browser_test', origin: 'https://ai.zuzunza.com', projectHandles: [project.id] };
  const params = { sessionId: session.id, requestId: 'input_one', operation: 'game.maintain', request: 'Add dash to my ZUKU game.' };
  const [first, duplicate] = await Promise.all([call(core, 'session.input', params), call(core, 'session.input', params, browser)]);
  assert.equal(first.requestId, duplicate.requestId); const done = await wait(core, session.id);
  assert.equal(operations, 1); assert.equal(done.result.verified, false);
  assert.match(await readFile(join(root, 'src', 'dash.js'), 'utf8'), /DASH_SPEED/);
  await assert.rejects(call(core, 'session.input', { ...params, request: 'different change' }), { code: 'REQUEST_CONFLICT' });
  const events = [];
  for await (const event of core.subscribe({ sessionId: session.id }, browser)) { events.push(event); if (event.type === 'agent.completed') break; }
  assert.deepEqual(events.map(event => event.sequence), events.map((_, i) => i + 1));
  assert.equal(events.at(-1).data.verified, false);
  const replay = core.subscribe({ sessionId: session.id, afterSequence: events.at(-1).sequence - 1 }, browser);
  assert.equal((await replay.next()).value.type, 'agent.completed'); await replay.return();
  const storage = await createCoreStorage({ stateDir });
  if (process.platform === 'win32') assert.equal(storage.windowsProtected, true);
  else assert.equal((await lstat(stateDir)).mode & 0o777, 0o700);
  const journal = await storage.read('journal', session.id); assert.ok(!journal.includes(root)); assert.ok(!journal.includes(params.request));
});

test('browser requires a native project grant and cannot inject actor/path/credential authority', async t => {
  const { core, project } = await fixture(t);
  const browser = { kind: 'browser', id: 'web', origin: 'https://ai.zuzunza.com', projectHandles: [] };
  await assert.rejects(call(core, 'session.create', { projectHandle: project.id }, browser), { code: 'PERMISSION_REQUIRED' });
  await assert.rejects(call(core, 'project.grant', { localPath: '/root' }, browser), { code: 'NATIVE_PERMISSION_REQUIRED' });
  const injected = await core.dispatch({ ...envelope('hello'), actor: native }, browser); assert.equal(injected.error.code, 'INVALID_INPUT');
  const out = await core.dispatch(envelope('exec', { command: 'cat /etc/shadow' }), native); assert.equal(out.error.code, 'INVALID_INPUT');
  assert.deepEqual((await call(core, 'project.list', {}, browser)).projects, []);
  await assert.rejects(call(core, 'project.list', {}, { ...browser, origin: 'https://ai.zuzunza.com.evil.test' }), { code: 'PERMISSION_REQUIRED' });
});

test('Windows case aliases resolve to the same approved project without creating another grant', { skip: process.platform !== 'win32' }, async t => {
  const { core, root, project } = await fixture(t);
  const identity = await lstat(root);
  assert.notEqual(identity.dev, 0); assert.notEqual(identity.ino, 0);
  const sameProject = await call(core, 'project.grant', { localPath: root.toUpperCase(), purpose: 'game.maintain' });
  assert.equal(sameProject.id, project.id);
  assert.equal((await call(core, 'project.list')).projects.length, 1);
});

test('purpose rejection occurs before provider resolution for all transports', async t => {
  let calls = 0;
  const { core, project } = await fixture(t, { providerRuntime: { async resolveStageProvider() { calls++; throw new Error('provider must not be consulted'); } } });
  const session = await call(core, 'session.create', { projectHandle: project.id });
  for (const actor of [native, { kind: 'browser', id: 'web', origin: 'https://ai.zuzunza.com', projectHandles: [project.id] }]) await assert.rejects(call(core, 'session.input', { sessionId: session.id, requestId: 'input_forbidden', operation: 'game.maintain', request: 'Build an ecommerce site.' }, actor), { code: 'AGENT_REQUEST_OUT_OF_SCOPE' });
  assert.equal(calls, 0);
});

test('disconnect only ends a subscription; explicit cancellation stops the shared operation', async t => {
  let stopped = false;
  const { core, project } = await fixture(t, { operationRunner: async (_, context) => {
    await new Promise(resolve => { context.signal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }); });
    return {};
  } });
  const session = await call(core, 'session.create', { projectHandle: project.id });
  await call(core, 'session.input', { sessionId: session.id, requestId: 'input_cancel', operation: 'game.maintain', request: 'Add dash to my ZUKU game.' });
  const controller = new AbortController(), subscription = core.subscribe({ sessionId: session.id, signal: controller.signal }, native);
  await subscription.next(); controller.abort(); await subscription.return();
  assert.equal(stopped, false); assert.equal((await call(core, 'session.get', { sessionId: session.id })).state, 'running');
  await assert.rejects(call(core, 'session.close', { sessionId: session.id }), { code: 'SESSION_BUSY' });
  await call(core, 'session.cancel', { sessionId: session.id, requestId: 'input_cancel' });
  await wait(core, session.id, 'cancelled'); assert.equal(stopped, true);
});

test('raw reasoning, secrets and model verification claims never enter journal or public history', async t => {
  const secret = `sk-${'z'.repeat(35)}`;
  const { core, project, stateDir, root } = await fixture(t, { operationRunner: async (_, context) => {
    await context.provider.runStage({ stage: 'design' });
    await context.onEvent({ type: 'reasoning-delta', text: 'PRIVATE_REASONING_SENTINEL' });
    await context.onEvent({ type: 'agent.completed', data: { status: 'completed', verified: true } });
    await context.onEvent({ type: 'build.output', data: { buildId: 'build_test', stream: 'stderr', text: `${root}/private ${secret}` } });
    return { verified: true, privateThought: 'PRIVATE_REASONING_SENTINEL', token: secret };
  }, providerRuntime: { async resolveStageProvider() { return { model: 'fixture/game', authMethod: { id: 'official', official: true, experimental: false }, async runStage({ onEvent }) { await onEvent({ type: 'reasoning-delta', text: 'PRIVATE_REASONING_SENTINEL' }); await onEvent({ type: 'text-delta', text: 'Visible text ' }); await onEvent({ type: 'text-delta', text: secret.slice(0, 6) }); await onEvent({ type: 'text-delta', text: secret.slice(6) }); await onEvent({ type: 'finish' }); return { output: {} }; } }; } } });
  const session = await call(core, 'session.create', { projectHandle: project.id });
  await call(core, 'session.input', { sessionId: session.id, requestId: 'input_private', operation: 'game.maintain', request: 'Add dash to my ZUKU game.' });
  const done = await wait(core, session.id); assert.equal(done.result.verified, false);
  // A terminal in-memory state precedes the final durable journal append.
  for await (const event of core.subscribe({ sessionId: session.id }, native)) if (event.type === 'agent.completed') break;
  const journal = await (await createCoreStorage({ stateDir })).read('journal', session.id);
  for (const value of [secret, 'PRIVATE_REASONING_SENTINEL', root]) assert.ok(!journal.includes(value));
  assert.match(journal, /redacted/);
});

test('project replacement and symlinked state roots fail closed before a tool operation', async t => {
  const { core, base, root, project } = await fixture(t);
  const outside = join(base, 'outside'); await mkdir(outside); await rm(root, { recursive: true }); await symlink(outside, root, 'dir');
  await assert.rejects(call(core, 'session.create', { projectHandle: project.id }), { code: 'PROJECT_CHANGED' });
  await symlink(outside, join(base, 'symlink-core'), 'dir');
  await assert.rejects(createAgentCore({ stateDir: join(base, 'symlink-core'), scope }), { code: 'CORE_STATE_UNSAFE' });
});

test('durable reconnect preserves cursor and interrupted sessions never replay a mutation', async t => {
  const { core, project, stateDir } = await fixture(t, { operationRunner: async () => ({}) });
  const session = await call(core, 'session.create', { projectHandle: project.id });
  await core.close();
  const storage = await createCoreStorage({ stateDir }); const metadata = await storage.readJSON('sessions'); metadata.sessions[0].state = 'running'; metadata.sessions[0].requestId = 'input_crashed'; metadata.sessions[0].requests = [{ id: 'input_crashed', digest: createHash('sha256').update('crashed request').digest('hex') }]; await storage.writeJSON('sessions', metadata);
  let operations = 0;
  const restarted = await createAgentCore({ stateDir, scope, operationRunner: async () => { operations++; return {}; } });
  t.after(() => restarted.close());
  const seen = await call(restarted, 'session.get', { sessionId: session.id }); assert.equal(seen.state, 'interrupted'); assert.equal(operations, 0); assert.equal(seen.sequence, 2);
  const replay = restarted.subscribe({ sessionId: session.id, afterSequence: 1 }, native); assert.equal((await replay.next()).value.data.state, 'interrupted'); await replay.return();
  await restarted.close();
});

test('actual native IPC shares the same session between two authenticated clients', async t => {
  const base = await mkdtemp(join(tmpdir(), 'zuku-ipc-')); await create(['my-game'], { cwd: base });
  let operations = 0;
  const host = await startCoreHost({ stateDir: join(base, 'core'), coreOptions: { scope, providerRuntime: { async resolveStageProvider() { return { model: 'fixture/game', authMethod: { id: 'official', official: true, experimental: false }, runStage() {} }; } }, operationRunner: async () => { operations++; await pause(30); return {}; } } });
  const first = await createCoreClient({ stateDir: host.stateDir, autostart: false }); const second = await createCoreClient({ stateDir: host.stateDir, autostart: false });
  t.after(async () => { first.close(); second.close(); await host.close(); await rm(base, { recursive: true, force: true }); });
  const project = (await first.dispatch(envelope('project.grant', { localPath: join(base, 'my-game'), purpose: 'game.maintain' }))).result;
  const session = (await first.dispatch(envelope('session.create', { projectHandle: project.id }))).result;
  const input = envelope('session.input', { sessionId: session.id, requestId: 'input_ipc', operation: 'game.maintain', request: 'Add dash to this ZUKU game.' });
  await first.dispatch(input); const observed = [];
  for await (const event of second.subscribe({ sessionId: session.id })) { observed.push(event); if (event.type === 'agent.completed') break; }
  assert.equal(operations, 1); assert.equal(observed.at(-1).type, 'agent.completed');
  first.close(); const response = await second.dispatch(envelope('session.get', { sessionId: session.id })); assert.equal(response.result.state, 'completed');
  if (process.platform === 'win32') assert.match(nativeAddress(host.stateDir), /^\\\\\.\\pipe\\zukujs-core-[a-f0-9]{32}$/);
  else assert.equal((await lstat(join(host.stateDir, 'agent.sock'))).mode & 0o777, 0o600);
});

test('bounded journal drops a slow subscriber and reports expired cursors without cancelling host', async t => {
  const base = await mkdtemp(join(tmpdir(), 'zuku-journal-')), storage = await createCoreStorage({ stateDir: join(base, 'core') });
  const journal = await createJournal({ storage, sessionId: `ses_${'a'.repeat(32)}`, maxEvents: 3, maxBytes: 10000, subscriberBytes: 1024 });
  t.after(async () => { await journal.close(); await rm(base, { recursive: true, force: true }); });
  const slow = journal.subscribe();
  for (let i = 0; i < 8; i++) await journal.append('agent.delta', { text: 'x'.repeat(500), blockId: 'block_test' });
  await assert.rejects(slow.next(), { code: 'SLOW_SUBSCRIBER' });
  assert.equal(journal.sequence, 8); assert.equal(journal.minimumSequence, 6);
  assert.throws(() => journal.subscribe({ afterSequence: 0 }), { code: 'CURSOR_EXPIRED' });
  const healthy = journal.subscribe({ afterSequence: 7 }); assert.equal((await healthy.next()).value.sequence, 8); await healthy.return();
  const durable = await storage.read('journal', `ses_${'a'.repeat(32)}`); assert.equal(durable.trim().split('\n').length, 3);
});

test('native IPC rejects unknown authentication and browser authority escalation', async t => {
  const base = await mkdtemp(join(tmpdir(), 'zuku-ipc-auth-')); await create(['my-game'], { cwd: base });
  const host = await startCoreHost({ stateDir: join(base, 'core'), coreOptions: { scope } });
  const client = await createCoreClient({ stateDir: host.stateDir, autostart: false });
  t.after(async () => { client.close(); await host.close(); await rm(base, { recursive: true, force: true }); });
  const denied = await new Promise((resolve, reject) => {
    const socket = createConnection(nativeAddress(host.stateDir)); let data = '';
    socket.on('error', reject); socket.on('connect', () => socket.write(JSON.stringify({ type: 'authenticate', protocolVersion: 1, clientId: 'foreign_client', token: 'x'.repeat(43) }) + '\n'));
    socket.on('data', chunk => { data += chunk; if (data.includes('\n')) { socket.destroy(); resolve(JSON.parse(data.trim())); } });
  });
  assert.equal(denied.error.code, 'CORE_AUTH_REQUIRED');
  const project = (await client.dispatch(envelope('project.grant', { localPath: join(base, 'my-game') }))).result;
  const browser = { kind: 'browser', id: 'approved_web', origin: 'https://ai.zuzunza.com', projectHandles: [] };
  const response = await client.dispatch(envelope('session.create', { projectHandle: project.id }), { actor: browser }); assert.equal(response.error.code, 'PERMISSION_REQUIRED');
  await assert.rejects(client.dispatch(envelope('hello'), { actor: { kind: 'native', id: 'spoofed_native' } }), { code: 'PERMISSION_REQUIRED' });
});

test('native client autostarts a real separate shared host and disconnect leaves it available', async t => {
  const base = await mkdtemp(join(tmpdir(), 'zuku-core-auto-')), stateDir = join(base, 'core');
  let first, second, pid;
  t.after(async () => {
    first?.close(); second?.close();
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    // connection.json is removed before the host finishes its journal/lock cleanup.
    // Wait for the actual fixture process to exit before removing its private files.
    for (let i = 0; pid && i < 500; i++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      await pause(10);
    }
    await rm(base, { recursive: true, force: true });
  });
  first = await createCoreClient({ stateDir });
  const storage = await createCoreStorage({ stateDir });
  const connection = await storage.readJSON('connection'); pid = connection.pid;
  assert.notEqual(pid, process.pid); assert.equal(connection.token.length, 43);
  const hello = await first.dispatch(envelope('hello')); assert.equal(hello.result.product, 'zuku-agent-core');
  first.close(); second = await createCoreClient({ stateDir, autostart: false });
  assert.equal((await second.dispatch(envelope('hello'))).result.status, 'ready');
  assert.equal((await storage.readJSON('connection')).pid, pid);
});

test('actual shared scope runtime reads and patches approved game bytes with durable receipts', async t => {
  const { core, project, root } = await fixture(t, { scope: undefined });
  const file = await call(core, 'project.read', { projectHandle: project.id, path: 'src/game.js' });
  assert.equal(file.sha256, createHash('sha256').update(await readFile(join(root, 'src', 'game.js'))).digest('hex'));
  assert.ok(file.content.length > 100);
  const content = file.content + '\n// ZUKU dash speed: 16\n';
  const result = await call(core, 'project.patch', { projectHandle: project.id, path: 'src/game.js', content, expectedSha256: file.sha256 });
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(await readFile(join(root, 'src', 'game.js'), 'utf8'), content);
  await assert.rejects(call(core, 'project.patch', { projectHandle: project.id, path: 'src/game.js', content: 'stale mutation', expectedSha256: file.sha256 }), { code: 'REQUEST_CONFLICT' });
  assert.equal(await readFile(join(root, 'src', 'game.js'), 'utf8'), content);
  const runIds = await readdir(join(root, '.zukujs', 'agent', 'runs'));
  const journals = await Promise.all(runIds.map(id => readFile(join(root, '.zukujs', 'agent', 'runs', id, 'scope-receipts.json'), 'utf8').catch(() => '')));
  assert.ok(journals.some(text => text.includes('"executed_by":"host"') && text.includes('write_file')));
  await writeFile(join(root, 'src', 'private.json'), '{"access_token":"sensitive-local-credential"}');
  await assert.rejects(call(core, 'project.read', { projectHandle: project.id, path: '.zukujs/agent/run.lock' }), { code: 'INVALID_INPUT' });
  const outside = join(root, '..', 'outside.txt'); await writeFile(outside, 'OUTSIDE_SENTINEL'); await link(outside, join(root, 'src', 'linked.txt'));
  await assert.rejects(call(core, 'project.read', { projectHandle: project.id, path: 'src/linked.txt' }), { code: 'PERMISSION_REQUIRED' });
});

test('explicit rejected admission object stops native grant and input before provider use', async t => {
  let rejected = false, providerCalls = 0;
  const policy = { ...scope, admitGameRequest() { return { admitted: !rejected, route: rejected ? 'reject' : 'scoped' }; } };
  const { core, project, root } = await fixture(t, { scope: policy, providerRuntime: { async resolveStageProvider() { providerCalls++; return {}; } } });
  const session = await call(core, 'session.create', { projectHandle: project.id }); rejected = true;
  await assert.rejects(call(core, 'session.input', { sessionId: session.id, requestId: 'input_reject_object', operation: 'game.maintain', request: 'Add dash to ZUKU game.' }), { code: 'AGENT_REQUEST_OUT_OF_SCOPE' });
  await assert.rejects(call(core, 'project.grant', { localPath: root }), { code: 'AGENT_REQUEST_OUT_OF_SCOPE' });
  assert.equal(providerCalls, 0);
});
