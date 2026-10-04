// Integration with the REAL Agent Core (lib/agent-core) using its default scope import
// (this module). The stage provider is a scripted MOCK; files, skills, validate/package and
// the journal are real. Verifies the purpose gate runs before provider resolution and that
// browser actors get the same tool policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import create from '../commands/create.mjs';
import { verifyScopedResult } from '../lib/agent/scope/index.mjs';

let core;
try { core = await import('../lib/agent-core/index.mjs'); } catch { core = undefined; }
const skip = core ? false : 'agent-core not present in this checkout';
const native = { kind: 'native', id: 'native_scope_test' };
let number = 0;
const envelope = (method, params = {}) => ({ protocolVersion: 1, id: `req_${++number}`, method, params });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(instance, method, params = {}, actor = native) {
  const response = await instance.dispatch(envelope(method, params), actor);
  if (response.error) throw Object.assign(new Error(response.error.code), { code: response.error.code });
  return response.result;
}
async function settle(instance, sessionId) {
  for (let i = 0; i < 400; i++) { const s = await call(instance, 'session.get', { sessionId }); if (!['running', 'idle'].includes(s.state)) return s; await pause(10); }
  assert.fail('session did not settle');
}
const PLAN = { summary: 'Add dash', design: { purpose: 'Player dash', architecture: 'game loop' }, verification_plan: [], steps: ['patch'] };

async function fixture(t, provider, extra = {}) {
  const base = await mkdtemp(join(tmpdir(), 'zuku-scope-core-'));
  await create(['my-game'], { cwd: base });
  const root = join(base, 'my-game');
  let resolves = 0;
  const instance = await core.createAgentCore({ stateDir: join(base, 'core'), providerRuntime: { async resolveStageProvider() { resolves++; return provider; } }, verifyResult: verifyScopedResult, agentContext: { sandbox: { capability: async () => ({ available: false, reason: 'test-stub' }), forms: async () => new Map(), run: async () => { throw new Error('unused'); } } }, ...extra });
  t.after(async () => { await instance.close(); await rm(base, { recursive: true, force: true }); });
  const project = await call(instance, 'project.grant', { localPath: root, purpose: 'game.maintain' });
  return { instance, root, project, resolves: () => resolves };
}

test('game.maintain runs the scoped loop through Agent Core and reports host-verified evidence', { skip }, async t => {
  let root;
  const provider = {
    model: 'fixture/game', authMethod: { id: 'api-key', official: true, experimental: false },
    async runStage(request) {
      if (request.stage === 'scope.plan') return { output: PLAN, usage: { inputTokens: 1, outputTokens: 1 } };
      const text = await readFile(join(root, 'src/game.js'), 'utf8');
      const sha = (await import('node:crypto')).createHash('sha256').update(text).digest('hex');
      return { output: { actions: [{ tool: 'patch_file', input_json: JSON.stringify({ path: 'src/game.js', expected_sha256: sha, edits: [{ old: text.slice(0, 20), new: `/* dash */\n${text.slice(0, 20)}` }] }) }], done: true }, usage: {} };
    },
  };
  const f = await fixture(t, provider); root = f.root;
  const session = await call(f.instance, 'session.create', { projectHandle: f.project.id });
  await call(f.instance, 'session.input', { sessionId: session.id, requestId: 'req_dash', operation: 'game.maintain', request: '플레이어 이동에 대시 기능 추가해줘' });
  const done = await settle(f.instance, session.id);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.result.verified, true);
  assert.match(done.result.runId, /^run_[0-9]{14}_[0-9a-f]{8}$/);
  assert.match(await readFile(join(root, 'src/game.js'), 'utf8'), /dash/);
  const events = [];
  for await (const event of f.instance.subscribe({ sessionId: session.id }, native)) { events.push(event); if (event.type === 'agent.completed') break; }
  assert.ok(events.some(e => e.type === 'agent.reasoning_status' && e.data.phase === 'editing'));
  assert.ok(events.some(e => e.type === 'tool.completed' && e.data.capability === 'project.patch'));
  assert.ok(!JSON.stringify(events).includes(root));
});

test('out-of-scope input is refused before provider resolution; browser tool calls get the same policy', { skip }, async t => {
  const f = await fixture(t, { model: 'fixture/game', authMethod: { id: 'api-key', official: true, experimental: false }, async runStage() { throw new Error('must not run'); } });
  await writeFile(join(f.root, '.env'), 'ZUKU_TOKEN=abcdefghijklmnop\n');
  const session = await call(f.instance, 'session.create', { projectHandle: f.project.id });
  await assert.rejects(call(f.instance, 'session.input', { sessionId: session.id, requestId: 'req_shop', operation: 'game.maintain', request: 'Build me a generic ecommerce website for my game players.' }), { code: 'AGENT_REQUEST_OUT_OF_SCOPE' });
  assert.equal(f.resolves(), 0);
  const browser = { kind: 'browser', id: 'browser_scope', origin: 'https://ai.zuzunza.com', projectHandles: [f.project.id] };
  const read = await call(f.instance, 'project.read', { projectHandle: f.project.id, path: 'src/game.js' }, browser);
  assert.match(read.sha256, /^[0-9a-f]{64}$/);
  // The protocol codec admits this name; the scope runtime is the layer that denies it.
  await assert.rejects(call(f.instance, 'project.read', { projectHandle: f.project.id, path: 'credentials.json' }, browser), { code: 'PERMISSION_REQUIRED' });
  await assert.rejects(call(f.instance, 'project.read', { projectHandle: f.project.id, path: 'src/server.pem' }, browser), { code: 'PERMISSION_REQUIRED' });
  await assert.rejects(call(f.instance, 'project.patch', { projectHandle: f.project.id, path: 'Makefile', content: 'all:\n', expectedSha256: '0'.repeat(64) }, browser), { code: 'PERMISSION_REQUIRED' });
});
