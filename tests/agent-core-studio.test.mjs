// Real stream pipes, loopback HTTP, Core native IPC, scoped files and private stores.
// The native user's choices and model output are fixtures, not GUI/live inference evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import create from '../commands/create.mjs';
import { createProviderRuntime } from '../lib/provider-system/index.mjs';
import { startCoreHost, createCoreClient, createAgentCore } from '../lib/agent-core/index.mjs';
import { createCoreStorage } from '../lib/agent-core/storage.mjs';
import { createStudioHostContext } from '../lib/studio-context.mjs';
import { createStudioStdio } from '../lib/studio-stdio.mjs';
import { createBrowserClient, ProtocolError } from '../lib/agent-protocol/index.mjs';
import { readProtectedStore } from '../lib/accounts/windows-protected-store.mjs';

let serial = 0;
const envelope = (method, params = {}) => ({ protocolVersion: 1, id: `studio_req_${++serial}`, method, params });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'zuku-studio-core-')); await create(['game'], { cwd: home }); const root = join(home, 'game');
  const provider = { model: 'fixture/game', authMethod: { id: 'api-key', official: true, experimental: false }, async runStage(request) {
    if (request.stage === 'scope.plan') return { output: { summary: 'Jump', design: { purpose: 'Player jump', architecture: 'Canvas game loop' }, verification_plan: ['validate', 'package'], steps: ['patch'] }, usage: {} };
    const original = await readFile(join(root, 'src/game.js'), 'utf8');
    return { output: { actions: [{ tool: 'patch_file', input_json: JSON.stringify({ path: 'src/game.js', expected_sha256: hash(original), edits: [{ old: original.slice(0, 20), new: `/* jump proof */\n${original.slice(0, 20)}` }] }) }], done: true }, usage: {} };
  } };
  const runtime = await createProviderRuntime({ home, stateDir: join(home, '.config/zukujs/providers'), environment: {} });
  const host = await startCoreHost({ stateDir: join(home, 'core'), coreOptions: { providerRuntime: { ...runtime, async resolveStageProvider() { return provider; } } } });
  const client = await createCoreClient({ stateDir: host.stateDir, autostart: false });
  const context = await createStudioHostContext({ coreClient: client });
  const input = new PassThrough(), output = new PassThrough(), messages = [], waiting = []; let buffer = '';
  output.on('data', chunk => {
    buffer += chunk.toString(); let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); messages.push(message);
      for (const waiter of [...waiting]) if (waiter.match(message)) { waiting.splice(waiting.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); }
    }
  });
  const waitMessage = match => {
    const found = messages.find(match); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => { const waiter = { match, resolve, timer: setTimeout(() => { waiting.splice(waiting.indexOf(waiter), 1); reject(new Error('native frame timeout')); }, 3000) }; waiting.push(waiter); });
  };
  const bridge = await createStudioStdio({ context, input, output, adapterOptions: { port: 0 } });
  t.after(async () => { input.end(); await bridge.close(); await host.close(); await rm(home, { recursive: true, force: true }); });
  const call = async (method, params = {}) => {
    const request = envelope(method, params); input.write(JSON.stringify(request) + '\n');
    const response = await waitMessage(message => message.id === request.id);
    if (response.error) throw new ProtocolError(response.error.code); return response.result;
  };
  const select = async () => {
    const request = envelope('native.projectChosen'); request.params = { requestId: request.id, localPath: root };
    input.write(JSON.stringify(request) + '\n'); const reply = await waitMessage(message => message.id === request.id); if (reply.error) throw new ProtocolError(reply.error.code); return reply.result;
  };
  return { home, host, root, bridge, call, input, messages, waitMessage, select };
}

test('Studio native pipe and paired browser subscribe to one real scoped run and opaque project', async t => {
  const f = await fixture(t), project = await f.select();
  assert.match(project.id, /^project_[a-f0-9]{32}$/); assert.ok(!JSON.stringify(project).includes(f.root));
  await assert.rejects(f.call('project.grant', { localPath: f.root }), { code: 'NATIVE_PERMISSION_REQUIRED' });
  const browser = createBrowserClient({ baseUrl: f.bridge.adapter.origin, fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Origin: 'https://ai.zuzunza.com' } }) }); t.after(() => browser.close());
  await browser.challenge(); const prompt = await f.waitMessage(message => message.type === 'native.pairing');
  assert.equal(prompt.data.origin, 'https://ai.zuzunza.com');
  await f.call('native.pairingDecision', { requestId: prompt.data.requestId, allow: true });
  for (let i = 0; ; i++) { try { await browser.confirm(); break; } catch (error) { if (error.code !== 'PAIRING_PENDING' || i > 10) throw error; await pause(5); } }
  const session = await browser.call('session.create', { projectHandle: project.id });
  assert.equal((await f.call('native.subscribe', { subscriptionId: 'studio_sub', sessionId: session.id, afterSequence: 0 })).status, 'connected');
  await browser.call('session.input', { sessionId: session.id, requestId: 'jump_native_web', request: '게임 플레이어에 점프 기능 추가', operation: 'game.maintain' });
  const done = await f.waitMessage(message => message.type === 'native.subscription' && message.data.event?.type === 'agent.completed');
  assert.equal(done.data.event.data.verified, true); assert.match(await readFile(join(f.root, 'src/game.js'), 'utf8'), /jump proof/);
  const replay = browser.events({ sessionId: session.id, afterSequence: done.data.event.sequence - 1 });
  assert.deepEqual((await replay.next()).value, done.data.event); await replay.return();
  assert.equal((await f.call('native.unsubscribe', { subscriptionId: 'studio_sub' })).status, 'closed');
  assert.equal((await browser.call('session.get', { sessionId: session.id })).state, 'completed');
  assert.ok(!JSON.stringify(f.messages.filter(message => message.type === 'native.subscription')).includes(f.root));
});

test('native auth frames use the real Core store and readonly preview serves only immutable registered bytes', async t => {
  const f = await fixture(t), secret = 'private_fixture_provider_key_1234567890';
  const accepted = await f.call('auth.request', { providerId: 'openai' });
  const prompt = await f.waitMessage(message => message.type === 'native.auth');
  assert.equal(prompt.data.kind, 'secret'); assert.equal(prompt.data.experimental, false);
  await f.call('native.authResponse', { requestId: prompt.data.requestId, value: secret });
  let status; for (let i = 0; i < 100; i++) { status = await f.call('auth.list'); if (status.requests.find(job => job.authRequestId === accepted.authRequestId)?.status === 'completed') break; await pause(5); }
  assert.equal(status.auth.find(item => item.provider === 'openai').status, 'configured');
  assert.ok(!JSON.stringify(f.messages).includes(secret));
  const secretFile = join(f.home, '.config/zukujs/providers', process.platform === 'win32' ? 'secrets.dpapi' : 'secrets.json');
  const secretText = process.platform === 'win32' ? await readProtectedStore(secretFile) : await readFile(secretFile, 'utf8');
  assert.equal(JSON.parse(secretText).providers.openai.apiKey, secret);
  if (process.platform === 'win32') assert.ok(!(await readFile(secretFile)).includes(Buffer.from(secret)));
  const big = `/*${'asset fixture '.repeat(12000)}*/`;
  await writeFile(join(f.root, 'src/large.js'), big);
  const project = await f.select(), preview = await f.call('game.preview', { projectHandle: project.id });
  const resolved = await f.call('native.resolvePreview', { previewHandle: preview.previewHandle });
  assert.match(resolved.url, /^http:\/\/127\.0\.0\.1:[0-9]+\/p\/[a-f0-9]{32}\/$/);
  const index = await fetch(resolved.url); assert.equal(index.status, 200); assert.match(index.headers.get('content-security-policy'), /connect-src 'none'/); assert.match(await index.text(), /<!doctype html>/i);
  await writeFile(join(f.root, 'src/large.js'), '/* new version */');
  const original = await fetch(resolved.url + 'large.js'); assert.equal(original.status, 200); assert.equal(await original.text(), big);
  for (const path of ['secrets.json', '%252e%252e/private', '%2fetc%2fpasswd', 'large.js?secret=fixture']) assert.ok((await fetch(resolved.url + path)).status >= 400);
  assert.ok((await fetch(resolved.url, { method: 'POST', body: 'fixture' })).status >= 400);
  assert.ok(!JSON.stringify([preview, resolved]).includes(f.root));
  await f.call('game.preview', { projectHandle: project.id }); assert.equal((await fetch(resolved.url)).status, 409);
});

test('failed durable tool-start journal delivery prevents an actual shared-scope patch', async t => {
  const home = await mkdtemp(join(tmpdir(), 'zuku-core-durable-')); await create(['game'], { cwd: home }); const root = join(home, 'game'), original = await readFile(join(root, 'src/game.js'), 'utf8');
  const storage = await createCoreStorage({ stateDir: join(home, 'core') });
  const guarded = { ...storage, async appendJournal(name, line, bound) { if (JSON.parse(line).type === 'tool.started') throw new ProtocolError('CORE_STATE_UNSAFE'); return storage.appendJournal(name, line, bound); } };
  const provider = { model: 'fixture/game', async runStage(request) {
    if (request.stage === 'scope.plan') return { output: { summary: 'Jump', design: { purpose: 'Player jump', architecture: 'Canvas' }, verification_plan: ['validate'], steps: ['patch'] } };
    return { output: { actions: [{ tool: 'patch_file', input_json: JSON.stringify({ path: 'src/game.js', expected_sha256: hash(original), edits: [{ old: original.slice(0, 20), new: `/* cannot commit */${original.slice(0, 20)}` }] }) }], done: true } };
  } };
  const core = await createAgentCore({ storage: guarded, providerRuntime: { async resolveStageProvider() { return provider; } } });
  t.after(async () => { await core.close(); await rm(home, { recursive: true, force: true }); });
  const call = async (method, params = {}) => { const reply = await core.dispatch(envelope(method, params), { kind: 'native', id: 'durable_native' }); if (reply.error) throw new ProtocolError(reply.error.code); return reply.result; };
  const project = await call('project.grant', { localPath: root, purpose: 'game.maintain' }), session = await call('session.create', { projectHandle: project.id });
  await call('session.input', { sessionId: session.id, requestId: 'durable_denied', request: '게임 점프 기능 추가', operation: 'game.maintain' });
  let result; for (let i = 0; i < 100; i++) { result = await call('session.get', { sessionId: session.id }); if (result.state !== 'running') break; await pause(5); }
  assert.equal(result.state, 'failed'); assert.equal(result.result.code, 'CORE_STATE_UNSAFE');
  assert.equal(await readFile(join(root, 'src/game.js'), 'utf8'), original);
  for await (const event of core.subscribe({ sessionId: session.id }, { kind: 'native', id: 'durable_native' })) if (event.type === 'agent.error') break;
  const journal = await storage.read('journal', session.id);
  assert.match(journal, /tool.requested/); assert.ok(!journal.includes('tool.completed')); assert.ok(!journal.includes('agent.completed'));
});

test('separate Studio process uses actual inherited pipes and detaches from an existing shared host', async t => {
  const home = await mkdtemp(join(tmpdir(), 'zuku-studio-process-')); await create(['game'], { cwd: home });
  const host = await startCoreHost({ stateDir: join(home, 'core'), home, environment: {}, providerContext: { stateDir: join(home, '.config/zukujs/providers') } });
  const code = `import {createStudioHostContext} from ${JSON.stringify(new URL('../lib/studio-context.mjs', import.meta.url).href)}; import {startStudioHost} from ${JSON.stringify(new URL('../lib/studio-host.mjs', import.meta.url).href)}; const context=await createStudioHostContext({stateDir:process.argv[1],autostart:false}); const bridge=await startStudioHost(context,{adapterOptions:{port:0}}); await bridge.done;`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, host.stateDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let bytes = '', stderr = '', ready; const startup = new Promise(resolve => { ready = resolve; });
  child.stdout.on('data', chunk => { bytes += chunk.toString(); if (bytes.includes('host.ready')) ready(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const stopped = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await stopped; await host.close(); await rm(home, { recursive: true, force: true }); });
  const startupTimeoutMs = process.platform === 'win32' ? (process.arch === 'arm64' ? 60000 : 30000) : 3000;
  let startupTimer;
  try {
    await Promise.race([startup, new Promise((_, reject) => {
      startupTimer = setTimeout(() => reject(new Error('Studio process did not start')), startupTimeoutMs);
    })]);
  } finally { clearTimeout(startupTimer); }
  const request = envelope('hello'); child.stdin.write(JSON.stringify(request) + '\n');
  for (let i = 0; i < 100 && !bytes.includes(request.id); i++) await pause(5);
  const reply = bytes.trim().split('\n').map(line => JSON.parse(line)).find(message => message.id === request.id);
  assert.equal(reply.result.product, 'zuku-agent-core'); assert.equal(reply.result.status, 'ready');
  child.stdin.end(); assert.deepEqual(await stopped, { code: 0, signal: null }); assert.equal(stderr, '');
  const client = await createCoreClient({ stateDir: host.stateDir, autostart: false });
  assert.equal((await client.dispatch(envelope('hello'))).result.status, 'ready'); client.close();
});
