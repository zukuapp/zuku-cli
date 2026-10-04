// Executable bytes below are labelled identity fixtures and are NEVER executed.
// Actual Chromium is tested separately behind the established non-root opt-in gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAgentCore, startCoreHost } from '../lib/agent-core/index.mjs';
import { ProtocolError, validateRequest } from '../lib/agent-protocol/index.mjs';
import create from '../commands/create.mjs';
import { createBrowserPlaytest } from '../lib/agent/playtest.mjs';
import { grantBrowser } from '../lib/cli-core-runtime.mjs';
import { createCoreStorage } from '../lib/agent-core/storage.mjs';
const native = { kind: 'native', id: 'fixture_native' };
let serial = 0;
const call = async (core, method, params = {}, actor = native) => { const response = await core.dispatch({ protocolVersion: 1, id: `fixture_${++serial}`, method, params }, actor); if (response.error) throw new ProtocolError(response.error.code); return response.result; };
async function fixture(t, extra = {}) {
  const base = await mkdtemp(join(tmpdir(), 'zuku-browser-grant-'));
  await create(['game-a'], { cwd: base }); await create(['game-b'], { cwd: base });
  const binary = join(base, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
  const bytes = Buffer.alloc(64); bytes.set(process.platform === 'win32' ? [0x4d,0x5a] : process.platform === 'darwin' ? [0xcf,0xfa,0xed,0xfe] : [0x7f,0x45,0x4c,0x46]);
  await writeFile(binary, bytes, { mode: 0o700 });
  const stateDir = join(base, '.config/zukujs/core'); let providerResolutions = 0;
  const options = { stateDir, environment: {}, providerRuntime: { async resolveStageProvider() { providerResolutions++; return { model: 'fixture/game', authMethod: { id: 'fixture', official: true, experimental: false } }; } }, operationRunner: async () => ({ status: 'completed' }), ...extra };
  let core = await createAgentCore(options);
  t.after(async () => { await core.close(); await rm(base, { recursive: true, force: true }); });
  const a = await call(core, 'project.grant', { localPath: join(base, 'game-a'), purpose: 'game.maintain' });
  const b = await call(core, 'project.grant', { localPath: join(base, 'game-b'), purpose: 'game.maintain' });
  return { base, stateDir, binary, a, b, get core() { return core; }, get providerResolutions() { return providerResolutions; }, async restart() { await core.close(); core = await createAgentCore(options); } };
}

test('native browser approval is project-scoped, opaque, fingerprinted and survives Core restart', async t => {
  const f = await fixture(t);
  const granted = await call(f.core, 'browser.grant', { projectHandle: f.a.id, localPath: f.binary });
  assert.match(granted.browserHandle, /^browser_[a-f0-9]{32}$/);
  assert.equal(granted.projectHandle, f.a.id); assert.match(granted.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(granted).includes(f.binary), 'private executable path never projected');
  await f.restart();
  const session = await call(f.core, 'session.create', { projectHandle: f.a.id });
  const input = { sessionId: session.id, requestId: 'use_native_browser', operation: 'game.maintain', request: 'Improve the game controls.', browserHandle: granted.browserHandle };
  assert.equal((await call(f.core, 'session.input', input)).accepted, true);
  const other = await call(f.core, 'session.create', { projectHandle: f.b.id });
  await assert.rejects(call(f.core, 'session.input', { ...input, sessionId: other.id, requestId: 'cross_project' }), { code: 'PERMISSION_REQUIRED' });
});

test('paired browser cannot mint or use a native executable grant; raw paths and extra launch fields stay closed', async t => {
  const f = await fixture(t), actor = { kind: 'browser', id: 'fixture_browser', origin: 'https://ai.zuzunza.com', projectHandles: [f.a.id] };
  await assert.rejects(call(f.core, 'browser.grant', { projectHandle: f.a.id, localPath: f.binary }, actor), { code: 'NATIVE_PERMISSION_REQUIRED' });
  const grant = await call(f.core, 'browser.grant', { projectHandle: f.a.id, localPath: f.binary });
  const session = await call(f.core, 'session.create', { projectHandle: f.a.id });
  const input = { sessionId: session.id, requestId: 'browser_attempt', operation: 'game.maintain', request: 'Improve the game controls.' };
  assert.throws(() => validateRequest({ protocolVersion: 1, id: 'renderer_fixture', method: 'session.input', params: { ...input, browserHandle: grant.browserHandle } }), { code: 'NATIVE_PERMISSION_REQUIRED' });
  const manifest = JSON.parse(await readFile(new URL('../studio/native/windows/src/ZukuStudio.Core/protocol-manifest.json', import.meta.url)));
  assert.ok(!manifest.rendererMethods['session.input'].optional.includes('browserHandle'));
  assert.ok(manifest.nativePrivate.includes('browser.grant'));
  await assert.rejects(call(f.core, 'session.input', { ...input, browserHandle: grant.browserHandle }, actor), { code: 'NATIVE_PERMISSION_REQUIRED' });
  for (const extra of [{ browser: f.binary }, { browserPath: f.binary }, { executable: f.binary }, { argv: ['--no-sandbox'] }, { environment: {} }]) await assert.rejects(call(f.core, 'session.input', { ...input, ...extra }), { code: 'INVALID_INPUT' });
  assert.equal(f.providerResolutions, 0);
});

test('changed, linked, writable or non-binary executables fail before provider resolution', async t => {
  const f = await fixture(t);
  const grant = await call(f.core, 'browser.grant', { projectHandle: f.a.id, localPath: f.binary });
  const session = await call(f.core, 'session.create', { projectHandle: f.a.id });
  await writeFile(f.binary, 'changed binary');
  await assert.rejects(call(f.core, 'session.input', { sessionId: session.id, requestId: 'changed_browser', operation: 'game.maintain', request: 'Improve the game controls.', browserHandle: grant.browserHandle }), { code: 'BROWSER_EXECUTABLE_CHANGED' });
  assert.equal(f.providerResolutions, 0);
  await assert.rejects(call(f.core, 'browser.grant', { projectHandle: f.a.id, localPath: f.binary }), { code: 'BROWSER_EXECUTABLE_UNSAFE' });
  const linked = join(f.base, 'linked-browser'); await symlink(f.binary, linked);
  await assert.rejects(call(f.core, 'browser.grant', { projectHandle: f.a.id, localPath: linked }), { code: 'BROWSER_EXECUTABLE_UNSAFE' });
  if (process.platform !== 'win32') { await chmod(f.binary, 0o777); await assert.rejects(call(f.core, 'browser.grant', { projectHandle: f.a.id, localPath: f.binary }), { code: 'BROWSER_EXECUTABLE_UNSAFE' }); }
});


test('real production CLI grants the selected executable once and carries only its opaque handle', async t => {
  const calls = []; let selectedKind;
  const f = await fixture(t, { operationRunner: async (_, context) => { selectedKind = context.playtest.kind; return { status: 'completed' }; } });
  const host = await startCoreHost({ stateDir: f.stateDir, core: { ...f.core, dispatch(envelope, actor) { calls.push(structuredClone(envelope)); return f.core.dispatch(envelope, actor); } } });
  try {
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../index.mjs', import.meta.url)), 'agent', 'Create a ZUKU game', '--name', 'fixture-created-game', '--browser', f.binary, '--json'], { cwd: f.base, env: { HOME: f.base, PATH: dirname(process.execPath), NO_COLOR: '1' }, timeout: 20_000 });
    assert.equal(JSON.parse(result.stdout).success, true); assert.equal(selectedKind, 'browser');
    assert.equal(calls.filter(call => call.method === 'browser.grant').length, 1);
    const input = calls.find(call => call.method === 'session.input');
    assert.match(input.params.browserHandle, /^browser_[a-f0-9]{32}$/);
    assert.ok(!JSON.stringify(input).includes(f.binary)); assert.ok(!result.stdout.includes(f.binary));
  } finally { await host.close(); }
});

// Real Core and CLI processes; only the model is scripted. No external API, publish or
// fake browser runner is used. Existing non-root/sandbox policy is unchanged.
const LIVE = process.env.ZUKUJS_LIVE_BROWSER === '1' && process.getuid?.() !== 0 && process.env.ZUKUJS_TEST_CHROMIUM;
(LIVE ? test : test.skip)('LIVE production --browser: CLI → Core → real playtest/package → restart/resume → existing-game smoke', { timeout: 180_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'zuku-cli-browser-live-'));
  const stateDir = join(home, '.config/zukujs/core'); let child, stdout = '', stderr = '';
  const hostUrl = new URL('../lib/agent-core/host.mjs', import.meta.url).href;
  const fixtureUrl = new URL('./agent-fixtures.test.mjs', import.meta.url).href;
  const source = String.raw`import { startCoreHost } from ${JSON.stringify(hostUrl)};
    import { scriptedProvider } from ${JSON.stringify(fixtureUrl)};
    import { readFile } from 'node:fs/promises'; import { createHash } from 'node:crypto';
    const stages = scriptedProvider();
    const provider = { model: 'fixture/game', authMethod: { id: 'fixture', official: true, experimental: false }, async runStage(request) {
      if (request.stage === 'scope.plan') return { stage: request.stage, output: { summary: 'Add a fixture comment to the game source', design: { purpose: 'Maintain the existing game', architecture: 'Existing canvas game' }, verification_plan: ['validate','package','observed browser smoke'], steps: ['patch source'] } };
      if (request.stage === 'scope.act') { const text = await readFile(process.env.FIXTURE_GAME_SOURCE, 'utf8'); return { stage: request.stage, output: { actions: [{ tool: 'patch_file', input_json: JSON.stringify({ path: 'src/main.js', expected_sha256: createHash('sha256').update(text).digest('hex'), edits: [{ old: text.slice(0,30), new: '/* native browser fixture */\n'+text.slice(0,30) }] }) }], done: true } }; }
      return stages.runStage(request);
    } };
    const host = await startCoreHost({ home: process.env.HOME, environment: {}, coreOptions: { providerRuntime: { resolveStageProvider: async () => provider }, agentContext: { engine: null } } });
    process.stdout.write(JSON.stringify({ ready: true, pid: process.pid })+'\n');
    process.on('SIGTERM', async () => { await host.close(); process.exit(0); });`;
  const env = { HOME: home, PATH: dirname(process.execPath), FIXTURE_GAME_SOURCE: join(home, 'actual-game/src/main.js'), NO_COLOR: '1' };
  const start = async () => {
    stdout = ''; stderr = '';
    child = spawn(process.execPath, ['--input-type=module', '--eval', source], { env, stdio: ['ignore','pipe','pipe'] });
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    for (let tries = 0; !stdout.includes('"ready":true') && tries < 300; tries++) { if (child.exitCode !== null) assert.fail(stderr); await new Promise(resolve => setTimeout(resolve,10)); }
    assert.ok(stdout.includes('"ready":true'), stderr); return child.pid;
  };
  const stop = async signal => { if (child && child.exitCode === null) { const exit = once(child,'exit'); child.kill(signal); await exit; } };
  t.after(async () => { await stop('SIGTERM'); await rm(home,{recursive:true,force:true}); });
  const invoke = async (args, cwd = home) => {
    const result = await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../index.mjs',import.meta.url)),...args,'--browser',process.env.ZUKUJS_TEST_CHROMIUM,'--json'],{cwd,env,timeout:120_000,maxBuffer:128*1024});
    const response = JSON.parse(result.stdout); assert.equal(response.success,true,result.stderr); return response.data;
  };
  const originalPid = await start();
  const created = await invoke(['init','Create a three lane dodging ZUKU game','--name','actual-game']);
  assert.equal(created.verified,true); assert.equal(created.published,false); assert.equal(created.usage.modelCalls,5);
  const registry = JSON.parse(await readFile(join(stateDir,'browsers.json'),'utf8'));
  assert.equal(registry.browsers.length,1); assert.match(registry.browsers[0].sha256,/^[a-f0-9]{64}$/);
  const { prepareState, loadReceipt } = await import('../lib/agent/state.mjs');
  const { receipt } = await loadReceipt(await prepareState(home),created.runId);
  assert.equal(receipt.playtest.runner,'chromium-sandboxed'); assert.equal(receipt.playtest.browser.sandbox,true);
  const packageBefore = await readFile(receipt.package.path);
  await stop('SIGKILL'); assert.notEqual(await start(),originalPid);
  const resumed = await invoke(['agent','--resume',created.runId]);
  assert.equal(resumed.runId,created.runId); assert.equal(resumed.verified,true);
  assert.deepEqual(await readFile(receipt.package.path),packageBefore);
  assert.equal(JSON.parse(await readFile(join(stateDir,'browsers.json'),'utf8')).browsers.length,1,'unchanged explicit selection reuses native grant after restart');
  const maintained = await invoke(['agent','Add a comment to this ZUKU game source'],join(home,'actual-game'));
  assert.equal(maintained.verified,true); assert.equal(maintained.published,false);
  assert.match(await readFile(env.FIXTURE_GAME_SOURCE,'utf8'),/native browser fixture/);
});


test('older Core rejects explicit browser selection before attempting a native executable grant', async () => {
  const calls = [], oldCore = { async call(method) { calls.push(method); return { capabilities: [] }; } };
  await assert.rejects(grantBrowser(oldCore, { projectHandle: 'project_'+'a'.repeat(32), localPath: '/fixture/chrome' }), { code: 'CORE_PROTOCOL_GAP' });
  assert.deepEqual(calls,['hello']);
});

test('an executable change after preparation is rechecked immediately before launch and preserves the safe error', async () => {
  let validations = 0, launches = 0;
  const runner = createBrowserPlaytest({ uid: 1000, browserPath: process.execPath,
    validateBrowser: async () => { if (++validations === 3) throw new ProtocolError('BROWSER_EXECUTABLE_CHANGED'); },
    loadPlaywright: async () => ({ chromium: { launch: async () => { launches++; throw new Error('must never launch'); } } }),
  });
  await runner.prepare();
  await assert.rejects(runner.run({ snapshot: { entry: 'index.html', files: new Map([['index.html',Buffer.from('<canvas></canvas>')]]) } }), { code: 'BROWSER_EXECUTABLE_CHANGED' });
  assert.equal(validations,3); assert.equal(launches,0);
});


test('corrupt private browser identity metadata is rejected and does not leave the Core owner lock held', async t => {
  const f = await fixture(t); await call(f.core,'browser.grant',{projectHandle:f.a.id,localPath:f.binary});
  const storage = await createCoreStorage({stateDir:f.stateDir});
  const state = await storage.readJSON('browsers'); const id = state.browsers[0].id;
  state.browsers[0].id = [id]; await storage.writeJSON('browsers',state);
  await assert.rejects(f.restart(),{code:'CORE_STATE_UNSAFE'});
  state.browsers[0].id = id; await storage.writeJSON('browsers',state); await f.restart();
  assert.equal((await call(f.core,'hello')).status,'ready');
});
