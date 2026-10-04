// runScopedGameAgent end-to-end. Most tests use a scripted MOCK stage provider (no model
// inference, no network); files, the real hash-locked skill pack, built-in validate/package,
// receipts and the shared .zukujs/agent lock are real. One test drives the stages through the
// REAL shared provider registry + openai-chat adapter against a loopback HTTP server (live
// local transport, scripted model text). Sandbox forms use native bwrap when available.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import create from '../commands/create.mjs';
import { runScopedGameAgent, verifyScopedResult, detectSandbox, admitStageSchema, SCOPE_STAGES, SCOPE_REJECTED_MESSAGE } from '../lib/agent/scope/index.mjs';
import { admitStageSchema as sharedAdmit } from '../lib/provider-system/stage-schema.mjs';
import { prepareState, acquireLock } from '../lib/agent/state.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const PLAN = { summary: 'Fix the player speed', design: { purpose: 'Player moves at the intended speed', architecture: 'Single canvas loop in src/game.js' }, verification_plan: ['zuku validate', 'zuku package'], steps: ['read', 'patch'] };
const stubSandbox = { capability: async () => ({ available: false, reason: 'test-stub' }), forms: async () => new Map(), run: async () => { throw new Error('unused'); } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function project(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zuku-scope-l-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await create(['demo'], { cwd: dir });
  return join(dir, 'demo');
}
// Scripts write actions as { tool, input }; the wire form carries input_json (a JSON string).
const encode = output => (output && Array.isArray(output.actions) ? { ...output, actions: output.actions.map(a => ('input' in a ? { tool: a.tool, input_json: JSON.stringify(a.input) } : a)) } : output);
/** MOCK provider: returns scripted outputs; records every stage request it receives. */
function scripted(script, { authMethod, claim = {} } = {}) {
  const calls = [];
  return {
    calls, ...(authMethod ? { authMethod } : {}),
    async runStage(request) {
      calls.push(JSON.parse(JSON.stringify({ stage: request.stage, instructions: request.instructions, input: request.input, outputSchema: request.outputSchema, maxOutputBytes: request.maxOutputBytes })));
      const output = encode(await script(request, calls.length));
      return { provider: 'mock', stage: request.stage, output, usage: { inputTokens: 10, outputTokens: 5 }, experimental: false, unofficial: false, ...claim };
    },
  };
}
const happyScript = root => async (request, n) => {
  if (request.stage === 'scope.plan') return PLAN;
  const last = request.input.observations.at(-1);
  if (n === 2) return { actions: [{ tool: 'read_file', input: { path: 'src/game.js' } }], done: false };
  if (n === 3) {
    const text = await readFile(join(root, 'src/game.js'), 'utf8');
    return { actions: [{ tool: 'patch_file', input: { path: 'src/game.js', expected_sha256: last.observation.sha256, edits: [{ old: text.slice(0, 30), new: `/* speed fix */\n${text.slice(0, 30)}` }] } }], done: true };
  }
  return { actions: [], done: true };
};
const happy = (root, options) => scripted(happyScript(root), options);
const base = extra => ({ sandbox: stubSandbox, quiet: true, ...extra });

test('scope stages are admitted by the shared provider stage-schema contract (1,600,000-byte act)', () => {
  for (const [name, stage] of Object.entries(SCOPE_STAGES)) {
    assert.equal(admitStageSchema(stage.wire), true, name);
    assert.equal(sharedAdmit(stage.wire), true, name);
    assert.doesNotMatch(JSON.stringify(stage.wire), /pattern|multiline|oneOf|anyOf|\$ref/);
  }
  assert.equal(SCOPE_STAGES['scope.plan'].maxBytes, 98_304);
  assert.equal(SCOPE_STAGES['scope.act'].maxBytes, 1_600_000);
});

test('rejected purposes stop before skills, provider, lock or state', async t => {
  const root = await project(t);
  const provider = scripted(() => { throw new Error('must not be called'); });
  let resolved = false, skills = false;
  await assert.rejects(runScopedGameAgent({ request: 'Build me a generic ecommerce website.' }, base({ cwd: root, provider, resolveProvider: () => { resolved = true; }, loadSkills: () => { skills = true; } })), error => error.code === 'AGENT_REQUEST_OUT_OF_SCOPE' && error.message === SCOPE_REJECTED_MESSAGE);
  assert.equal(provider.calls.length, 0); assert.equal(resolved, false); assert.equal(skills, false);
  await assert.rejects(readdir(join(root, '.zukujs')), { code: 'ENOENT' });
});

test('new-game and resume requests return handled:false for the existing pipeline', async t => {
  const empty = await mkdtemp(join(tmpdir(), 'zuku-scope-l-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const provider = scripted(() => { throw new Error('no'); });
  assert.deepEqual(await runScopedGameAgent({ request: 'Create a new runner game' }, base({ cwd: empty, provider })), { handled: false, route: 'new-game', intent: 'create', classification: 'unknown' });
  const root = await project(t);
  assert.equal((await runScopedGameAgent({ request: 'anything', name: 'other-game' }, base({ cwd: root, provider }))).handled, false);
  assert.equal((await runScopedGameAgent({ request: 'fix', resume: 'run_20261004000000_abcdef12' }, base({ cwd: root, provider }))).route, 'resume');
  assert.equal(provider.calls.length, 0);
});

test('inspect -> plan -> read -> patch -> host verify succeeds with receipts, diff, real skills and phases', async t => {
  const root = await project(t);
  const provider = happy(root);
  const events = [];
  const result = await runScopedGameAgent({ request: 'Fix the player speed in the game loop', mode: 'local' }, base({ cwd: root, provider, onEvent: event => events.push(event) }));
  assert.equal(result.handled, true); assert.equal(result.verified, true); assert.match(result.run_id, /^run_[0-9]{14}_[0-9a-f]{8}$/);
  assert.deepEqual(result.checks.map(c => c.id), ['zuku:validate', 'zuku:package']);
  assert.match(result.package.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.changes.map(c => c.path), ['src/game.js']);
  assert.deepEqual(result.usage, { input_tokens: 30, output_tokens: 15, total_tokens: 45, model_calls: 3 });
  assert.match(await readFile(join(root, 'src/game.js'), 'utf8'), /speed fix/);
  const dir = join(root, result.state_dir);
  const receipts = JSON.parse(await readFile(join(dir, 'scope-receipts.json'), 'utf8'));
  assert.ok(receipts.some(r => r.tool === 'verify' && r.status === 'passed' && r.executed_by === 'host'));
  assert.ok(receipts.every((r, i) => (i === 0 ? r.prev === null : r.prev === receipts[i - 1].digest)));
  assert.match(await readFile(join(dir, 'changes.diff'), 'utf8'), /\+\/\* speed fix \*\//);
  const state = JSON.parse(await readFile(join(dir, 'scope-run.json'), 'utf8'));
  assert.equal(state.schema, 'zuku.scope.run/1'); assert.equal(state.skills.length, 5); assert.equal(state.status, 'verified');
  assert.ok(provider.calls[0].instructions.includes('Mandatory skill game-playtest'));
  assert.equal(provider.calls[0].maxOutputBytes, 98_304); assert.equal(provider.calls[1].maxOutputBytes, 1_600_000);
  await assert.rejects(readFile(join(root, '.zukujs/agent/run.lock')), { code: 'ENOENT' });
  // Agent Core event vocabulary: phases + tool events; no model text, no absolute paths.
  assert.deepEqual([...new Set(events.filter(e => e.type === 'stage').map(e => e.stage))], ['architecture', 'implementation', 'validate']);
  assert.ok(events.some(e => e.type === 'tool.completed' && e.data.capability === 'project.patch' && e.data.path === 'src/game.js'));
  const text = JSON.stringify(events);
  assert.ok(!text.includes(root) && !text.includes(PLAN.design.architecture) && !text.includes('speed fix'));
  const evidence = await verifyScopedResult(result, {});
  assert.equal(evidence.verified, true); assert.deepEqual(evidence.evidenceIds, [result.run_id]);
  assert.equal(await verifyScopedResult({ ...result }, {}), undefined, 'copies/forgeries are not evidence');
  await writeFile(join(root, 'src/game.js'), '// changed later\n');
  assert.equal(await verifyScopedResult(result, {}), undefined, 'evidence is bound to current source');
});

test('model cannot declare tests passed: extra claim fields are schema violations and the run fails closed', async t => {
  const root = await project(t);
  const original = await readFile(join(root, 'src/game.js'), 'utf8');
  const provider = scripted(async request => (request.stage === 'scope.plan' ? PLAN : { actions: [], done: true, tests_passed: true, verified: true }));
  await assert.rejects(runScopedGameAgent({ request: 'fix the player bug' }, base({ cwd: root, provider })), { code: 'AGENT_GATE_FAILED' });
  assert.equal(provider.calls.length, 3); // plan + act + one bounded schema re-ask
  assert.equal(await readFile(join(root, 'src/game.js'), 'utf8'), original);
});

test('failed host verification triggers bounded repair, then rollback with preserved diff', async t => {
  const root = await project(t);
  const original = await readFile(join(root, 'src/game.js'), 'utf8');
  let runs = 0;
  const failingTests = { capability: async () => ({ available: true, kind: 'stub' }), forms: async () => new Map([['node-test', { id: 'node-test', kind: 'tests' }]]), run: async () => { runs++; return { passed: false, exit_code: 1, stdout: 'not ok 1' }; } };
  const provider = scripted(async (request, n) => {
    if (request.stage === 'scope.plan') return PLAN;
    const exists = await readFile(join(root, 'src/extra.js'), 'utf8').catch(() => null);
    return { actions: [{ tool: 'write_file', input: { path: 'src/extra.js', content: `// attempt ${n}\n`, expected_sha256: exists === null ? null : sha(exists) } }], done: true };
  });
  await assert.rejects(runScopedGameAgent({ request: 'fix the failing game tests' }, base({ cwd: root, provider, sandbox: failingTests })), { code: 'AGENT_GATE_FAILED' });
  assert.equal(runs, 4); // initial verification + 3 repairs, then stop
  await assert.rejects(readFile(join(root, 'src/extra.js')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'src/game.js'), 'utf8'), original);
  const [run] = await readdir(join(root, '.zukujs/agent/runs'));
  const state = JSON.parse(await readFile(join(root, '.zukujs/agent/runs', run, 'scope-run.json'), 'utf8'));
  assert.equal(state.verified, false); assert.equal(state.status, 'failed');
  assert.match(await readFile(join(root, '.zukujs/agent/runs', run, 'changes.diff'), 'utf8'), /src\/extra\.js/);
});

test('finite progress: repeated identical calls and never-done models stop', async t => {
  const root = await project(t);
  const loop = scripted(async request => (request.stage === 'scope.plan' ? PLAN : { actions: [{ tool: 'read_file', input: { path: 'src/game.js' } }], done: false }));
  await assert.rejects(runScopedGameAgent({ request: 'fix the player' }, base({ cwd: root, provider: loop })), { code: 'REQUEST_LIMIT' });
  let n = 0;
  const idle = scripted(async request => (request.stage === 'scope.plan' ? PLAN : { actions: [{ tool: 'search_project', input: { query: `q${n++}` } }], done: false }));
  await assert.rejects(runScopedGameAgent({ request: 'fix the player' }, base({ cwd: root, provider: idle, limits: { turns: 5 } })), { code: 'AGENT_GATE_FAILED' });
  assert.equal(idle.calls.length, 6);
});

test('secrets never reach the provider; private and secret files are denied as observations', async t => {
  const root = await project(t);
  await writeFile(join(root, '.env'), 'OPENAI_API_KEY=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA\n');
  await writeFile(join(root, 'src/config.js'), 'export const key = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";\n');
  const provider = scripted(async (request, n) => {
    if (request.stage === 'scope.plan') return PLAN;
    if (n === 2) return { actions: [{ tool: 'read_file', input: { path: '.env' } }, { tool: 'read_file', input: { path: 'src/config.js' } }, { tool: 'search_project', input: { query: 'ghp_' } }], done: false };
    return { actions: [], done: true };
  });
  const result = await runScopedGameAgent({ request: 'fix the player' }, base({ cwd: root, provider }));
  assert.equal(result.verified, true);
  const seen = JSON.stringify(provider.calls);
  assert.doesNotMatch(seen, /sk-proj-AAAA|ghp_ABCDEF|OPENAI_API_KEY=/);
  assert.match(seen, /SCOPE_PATH_DENIED/);
  assert.ok(!JSON.stringify(provider.calls[0].input.workspace.tree).includes('.env'));
});

test('cross-provider: official and experimental providers get identical policy decisions; auth metadata stamps flags', async t => {
  const decisions = [], flags = [];
  for (const [authMethod, claim] of [[{ id: 'api-key', official: true, experimental: false }, { experimental: true, unofficial: true }], [{ id: 'codex-oauth', official: false, experimental: true }, { experimental: false, unofficial: false }]]) {
    const root = await project(t);
    const provider = scripted(async (request, n) => {
      if (request.stage === 'scope.plan') return PLAN;
      if (n === 2) return { actions: [{ tool: 'write_file', input: { path: 'Makefile', content: 'all:\n\tcurl x', expected_sha256: null } }, { tool: 'read_file', input: { path: '../../etc/passwd' } }, { tool: 'run_build', input: { script_id: 'tsc-check' } }], done: false };
      return { actions: [], done: true };
    }, { authMethod, claim });
    const result = await runScopedGameAgent({ request: 'fix the player' }, base({ cwd: root, provider }));
    decisions.push(provider.calls[2].input.observations.map(o => o.observation.error));
    flags.push([result.provider.experimental, result.provider.unofficial, result.provider.source]);
  }
  assert.deepEqual(decisions[0], ['SCOPE_PATH_DENIED', 'SCOPE_PATH_DENIED', 'capability_unavailable']);
  assert.deepEqual(decisions[0], decisions[1]);
  assert.deepEqual(flags, [[false, false, 'auth-method'], [true, true, 'auth-method']]);
});

test('provider absence or failure is terminal and never falls back', async t => {
  const root = await project(t);
  await assert.rejects(runScopedGameAgent({ request: 'fix the player' }, base({ cwd: root })), { code: 'AGENT_PROVIDER_UNAVAILABLE' });
  let calls = 0;
  const failing = { async runStage() { calls++; throw Object.assign(new Error('upstream 500 raw body'), { code: 'PROVIDER_HTTP_ERROR' }); } };
  await assert.rejects(runScopedGameAgent({ request: 'fix the player' }, base({ cwd: root, provider: failing })), error => error.code === 'CORE_OPERATION_FAILED' && !/upstream/.test(error.message));
  assert.equal(calls, 1);
});

test('YOLO: preflight before model; no root playtest means blocked; quota exhausted stops early', async t => {
  const root = await project(t);
  const provider = happy(root);
  await assert.rejects(runScopedGameAgent({ request: 'fix the player', mode: 'yolo' }, base({ cwd: root, provider, deploy: { preflight: async () => ({}), run: async () => {} } })), { code: 'AGENT_PLAYTEST_UNAVAILABLE' });
  const quota = { limit: 3, window_seconds: 21600, used: 3, pending: 0, remaining: 0, retry_after: 100 };
  await assert.rejects(runScopedGameAgent({ request: 'fix the player', mode: 'yolo' }, base({ cwd: root, provider, playtest: async () => ({ passed: true, thumbnail: PNG }), deploy: { preflight: async () => quota, run: async () => {} } })), { code: 'DEPLOY_QUOTA_EXCEEDED' });
  await assert.rejects(runScopedGameAgent({ request: 'fix the player', mode: 'yolo' }, base({ cwd: root, provider, playtest: async () => ({ passed: true, thumbnail: PNG }), deploy: { preflight: async () => ({ bogus: true }), run: async () => {} } })), { code: 'AGENT_DEPLOY_UNAVAILABLE' });
  assert.equal(provider.calls.length, 0);
});

test('YOLO: exactly one publish bound to the verified package and a real PNG thumbnail; unknown outcome is never replayed', async t => {
  const root = await project(t);
  const quota = { limit: 3, window_seconds: 21600, used: 0, pending: 0, remaining: 3 };
  const runs = [];
  const playtest = async ({ snapshot }) => ({ passed: snapshot.files.size > 0, thumbnail: PNG, observations: ['canvas rendered'] });
  const result = await runScopedGameAgent({ request: 'fix the player', mode: 'yolo' }, base({ cwd: root, provider: happy(root), playtest, deploy: { preflight: async () => quota, run: async (path, options) => { runs.push({ path, options, bytes: await readFile(path) }); return { status: 'published', content_id: 'game_123' }; } } }));
  assert.equal(result.published, true); assert.equal(runs.length, 1);
  assert.equal(result.publish.content_id, 'game_123');
  assert.equal(runs[0].options.package_sha256, result.package.sha256);
  assert.equal(sha(runs[0].bytes), result.package.sha256);
  assert.equal(runs[0].options.thumbnail.content_type, 'image/png'); assert.equal(sha(await readFile(runs[0].options.thumbnail.path)), sha(PNG));
  assert.ok(result.checks.some(c => c.id === 'zuku:playtest' && c.passed));
  const root2 = await project(t);
  let attempts = 0;
  await assert.rejects(runScopedGameAgent({ request: 'fix the player', mode: 'yolo' }, base({ cwd: root2, provider: happy(root2), playtest, deploy: { preflight: async () => quota, run: async () => { attempts++; throw new Error('socket hang up'); } } })), { code: 'AGENT_PUBLISH_OUTCOME_UNKNOWN' });
  assert.equal(attempts, 1);
  assert.match(await readFile(join(root2, 'src/game.js'), 'utf8'), /speed fix/, 'sent files are kept after an unknown outcome');
});

test('YOLO: a thumbnail that is not a real PNG or a failed playtest never publishes', async t => {
  const quota = { limit: 3, window_seconds: 21600, used: 0, pending: 0, remaining: 3 };
  for (const playtest of [async () => ({ passed: true, thumbnail: Buffer.from('not a png') }), async () => ({ passed: false, thumbnail: PNG })]) {
    const root = await project(t);
    let published = 0;
    await assert.rejects(runScopedGameAgent({ request: 'fix the player', mode: 'yolo' }, base({ cwd: root, provider: happy(root), playtest, deploy: { preflight: async () => quota, run: async () => { published++; } } })), error => ['AGENT_PLAYTEST_UNAVAILABLE', 'AGENT_GATE_FAILED'].includes(error.code));
    assert.equal(published, 0);
  }
});

test('source changed during verification blocks verification and publish; external edits are not rolled back', async t => {
  const root = await project(t);
  const quota = { limit: 3, window_seconds: 21600, used: 0, pending: 0, remaining: 3 };
  let published = 0, edits = 0;
  const playtest = async () => { await writeFile(join(root, 'src/game.js'), `// changed behind the agent ${++edits}\n`); return { passed: true, thumbnail: PNG }; };
  await assert.rejects(runScopedGameAgent({ request: 'fix the player', mode: 'yolo' }, base({ cwd: root, provider: happy(root), playtest, deploy: { preflight: async () => quota, run: async () => { published++; } } })), { code: 'AGENT_GATE_FAILED' });
  assert.equal(published, 0);
  assert.equal(await readFile(join(root, 'src/game.js'), 'utf8'), `// changed behind the agent ${edits}\n`);
});

test('concurrent runs share the legacy .zukujs/agent/run.lock; cancellation releases it', async t => {
  const root = await project(t);
  const state = await prepareState(root);
  const lock = await acquireLock(state, 'run_20261004000000_aaaaaaaa');
  await assert.rejects(runScopedGameAgent({ request: 'fix the player' }, base({ cwd: root, provider: happy(root) })), { code: 'SESSION_BUSY' });
  await lock.release();
  const controller = new AbortController();
  const provider = scripted(async () => { controller.abort(); return PLAN; });
  await assert.rejects(runScopedGameAgent({ request: 'fix the player' }, base({ cwd: root, provider, signal: controller.signal })), { code: 'COMMAND_CANCELLED' });
  await assert.rejects(readFile(join(root, '.zukujs/agent/run.lock')), { code: 'ENOENT' });
});

test('act output above 512 KiB is accepted within the 1.6 MB stage limit', async t => {
  const root = await project(t);
  const big = i => `// ${'x'.repeat(250_000)} ${i}\n`;
  const provider = scripted(async (request, n) => {
    if (request.stage === 'scope.plan') return PLAN;
    if (n === 2) return { actions: [1, 2, 3].map(i => ({ tool: 'write_file', input: { path: `src/chunk${i}.js`, content: big(i), expected_sha256: null } })), done: true };
    return { actions: [], done: true };
  });
  const result = await runScopedGameAgent({ request: 'add level chunks to the game' }, base({ cwd: root, provider }));
  assert.equal(result.changes.length, 3);
});

test('LIVE local transport: real provider registry + openai-chat adapter over loopback HTTP', async t => {
  const root = await project(t);
  const outputs = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
      const parsed = JSON.parse(body);
      const stage = JSON.parse(parsed.messages.at(-1).content).stage;
      const n = outputs.length + 1;
      const output = encode(await happyScript(root)({ stage, input: JSON.parse(parsed.messages.at(-1).content).input }, n));
      outputs.push({ stage, auth: req.headers.authorization ?? null });
      const text = JSON.stringify(output);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Split mid-UTF-8/JSON across frames to exercise the real stream decoder.
      for (let i = 0; i < text.length; i += 37) res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text.slice(i, i + 37) }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const home = await mkdtemp(join(tmpdir(), 'zuku-scope-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let runtime;
  try {
    const { createProviderRuntime } = await import('../lib/provider-system/index.mjs');
    runtime = await createProviderRuntime({ home, environment: { LOCAL_GAME_KEY: 'local-fixture-key-0123456789' } });
    await runtime.addProvider({ id: 'localgame', name: 'Local Game LLM', apiType: 'openai-chat', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'game-model', apiKeyEnv: 'LOCAL_GAME_KEY' });
    await runtime.useModel('localgame/game-model');
  } catch (error) { t.skip(`provider registry setup unavailable in this checkout (${error?.code ?? 'error'})`); return; }
  const result = await runScopedGameAgent({ request: 'Fix the player speed in the game loop', model: 'localgame/game-model' }, base({ cwd: root, resolveProvider: options => runtime.resolveStageProvider(options) }));
  assert.equal(result.verified, true);
  assert.deepEqual(outputs.map(o => o.stage), ['scope.plan', 'scope.act', 'scope.act']);
  assert.ok(result.usage.total_tokens > 0);
  assert.match(await readFile(join(root, 'src/game.js'), 'utf8'), /speed fix/);
});

const native = await detectSandbox();
test('native: real bwrap test form participates in host verification with live build events', { skip: native.available ? false : `bwrap unavailable (${native.reason})` }, async t => {
  const root = await project(t);
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'tests/speed.test.mjs'), "import test from 'node:test'; import assert from 'node:assert'; import { readFileSync } from 'node:fs'; test('speed fix present', () => assert.match(readFileSync('src/game.js', 'utf8'), /speed fix/));\n");
  const events = [];
  const result = await runScopedGameAgent({ request: 'fix the player speed' }, { cwd: root, provider: happy(root), quiet: true, onEvent: e => events.push(e) });
  assert.equal(result.verified, true);
  assert.deepEqual(result.checks, [{ id: 'zuku:validate', passed: true }, { id: 'zuku:package', passed: true }, { id: 'tests:node-test', passed: true }]);
  const build = events.filter(e => e.type.startsWith('build.'));
  assert.equal(build[0].type, 'build.started'); assert.equal(build.at(-1).type, 'build.completed'); assert.equal(build.at(-1).data.status, 'passed');
  assert.ok(build.some(e => e.type === 'build.output' && /speed fix present/.test(e.data.text)));
});
