// Real loopback HTTP + authenticated native IPC + actual scope/file/package verification.
// The provider and native pairing approval are explicit fixtures, not live inference or GUI evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import create from '../commands/create.mjs';
import { startCoreHost, createCoreClient } from '../lib/agent-core/index.mjs';
import { createBrowserClient } from '../lib/agent-protocol/index.mjs';
import { createBrowserAdapter } from '../lib/browser-adapter/server.mjs';

let number = 0;
const envelope = (method, params = {}) => ({ protocolVersion: 1, id: `native_req_${++number}`, method, params });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('paired browser and native CLI view one actual maintenance run with early stream and reconnect', async t => {
  const base = await mkdtemp(join(tmpdir(), 'zuku-core-web-')); await create(['my-game'], { cwd: base }); const root = join(base, 'my-game');
  let release, modelCalls = 0; const gate = new Promise(resolve => { release = resolve; });
  const provider = { model: 'fixture/game', authMethod: { id: 'api-key', official: true, experimental: false },
    async runStage(request) {
      modelCalls++;
      if (request.stage === 'scope.plan') {
        await request.onEvent({ type: 'text-delta', text: 'Visible game development progress. '.repeat(150) });
        await gate;
        return { output: { summary: 'Add dash', design: { purpose: 'Player dash', architecture: 'Canvas game loop' }, verification_plan: ['validate', 'package'], steps: ['patch'] }, usage: {} };
      }
      const original = await readFile(join(root, 'src/game.js'), 'utf8'), sha = createHash('sha256').update(original).digest('hex');
      return { output: { actions: [{ tool: 'patch_file', input_json: JSON.stringify({ path: 'src/game.js', expected_sha256: sha, edits: [{ old: original.slice(0, 20), new: `/* tested dash */\n${original.slice(0, 20)}` }] }) }], done: true }, usage: {} };
    },
  };
  const host = await startCoreHost({ stateDir: join(base, 'core'), coreOptions: { providerRuntime: { async resolveStageProvider() { return provider; } } } });
  const native = await createCoreClient({ stateDir: host.stateDir, autostart: false });
  const callNative = async (method, params = {}) => { const response = await native.dispatch(envelope(method, params)); if (response.error) throw Object.assign(new Error(response.error.code), response.error); return response.result; };
  const approved = await callNative('project.grant', { localPath: root, purpose: 'game.maintain' });
  const legacyUnused = () => { throw new Error('legacy adapter-owned agent must not be used'); };
  const adapter = await createBrowserAdapter({ port: 0, approvePairing: async () => true, host: {
    getHealth: async () => ({ cliVersion: '0.3.0', studioVersion: '0.3.0', agentVersion: '0.3.0', status: 'ready' }),
    getProjects: async () => (await callNative('project.list')).projects,
    getProviders: async () => ({ defaultProvider: 'fixture', defaultModel: 'fixture/game', providers: [{ id: 'fixture', name: 'Scripted fixture', enabled: true, authenticated: true, authMethods: [{ id: 'api-key', official: true, experimental: false }] }] }),
    getModels: async () => [{ id: 'game', name: 'Fixture' }], createSession: legacyUnused, input: legacyUnused,
    dispatchCore: (request, actor) => native.dispatch(request, { actor }),
    subscribeCore: (params, actor) => native.subscribe(params, { actor }),
  } });
  const browser = createBrowserClient({ baseUrl: adapter.origin, fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Origin: 'https://ai.zuzunza.com' } }) });
  t.after(async () => { release(); browser.close(); await adapter.close(); native.close(); await host.close(); await rm(base, { recursive: true, force: true }); });
  assert.equal((await browser.health()).status, 'ready');
  await browser.challenge();
  for (let i = 0; ; i++) { try { await browser.confirm(); break; } catch (error) { if (error.code !== 'PAIRING_PENDING' || i > 10) throw error; await pause(5); } }
  const session = await browser.call('session.create', { projectHandle: approved.id });
  const stream = browser.events({ sessionId: session.id }); assert.equal((await stream.next()).value.type, 'session.created');
  await browser.call('session.input', { sessionId: session.id, requestId: 'web_input_dash', operation: 'game.maintain', request: '플레이어 이동에 대시 기능 추가해줘' });
  let visible;
  while (true) { const event = (await stream.next()).value; if (event.type === 'agent.delta') { visible = event; break; } }
  assert.match(visible.data.text, /Visible game development/); assert.equal((await callNative('session.get', { sessionId: session.id })).state, 'running');
  await stream.return(); // closes the browser connection only
  assert.equal((await callNative('session.get', { sessionId: session.id })).state, 'running');
  release(); const resumed = browser.events({ sessionId: session.id, afterSequence: visible.sequence }); const events = [];
  for await (const event of resumed) { events.push(event); if (event.type === 'agent.completed') break; }
  assert.equal(events[0].sequence, visible.sequence + 1); assert.equal(events.at(-1).data.verified, true);
  assert.equal(modelCalls, 2); assert.equal((await callNative('session.get', { sessionId: session.id })).result.verified, true);
  assert.match(await readFile(join(root, 'src/game.js'), 'utf8'), /tested dash/);
  assert.ok(events.some(event => event.type === 'tool.completed' && event.data.capability === 'project.patch'));
  assert.ok(!JSON.stringify(events).includes(root));
  const replay = await browser.call('session.input', { sessionId: session.id, requestId: 'web_input_dash', operation: 'game.maintain', request: '플레이어 이동에 대시 기능 추가해줘' });
  assert.equal(replay.requestId, 'web_input_dash'); assert.equal(modelCalls, 2);
});
