// Unified CLI front doors over a REAL protected-IPC Agent Core in an isolated temporary HOME.
// FIXTURE LABELS: no live provider, account, paid API or browser is contacted. The custom
// `lab` endpoint (127.0.0.1:9) is configuration only and never receives a request; game work
// is the labelled `operationRunner` fixture injected into the isolated Core; entered secrets
// are fixture strings. Classification, grants, sessions, journals, auth jobs and the provider
// configuration/secret stores are the actual implementations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { run } from '../index.mjs';
import create from '../commands/create.mjs';
import provider from '../commands/provider.mjs';
import { startCoreHost, createCoreClient } from '../lib/agent-core/index.mjs';
import { ProtocolError } from '../lib/agent-protocol/index.mjs';
import { normalizeModelAddress, methodKind } from '../lib/cli-core-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const SECRET = 'fixture-unified-cli-key-' + 'z9'.repeat(16);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let serial = 0;
async function call(client, method, params = {}) {
  const response = await client.dispatch({ protocolVersion: 1, id: `test_${++serial}`, method, params });
  if (response.error) throw new ProtocolError(response.error.code);
  return response.result;
}
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path)); else if (entry.isFile()) out.push(await readFile(path, 'utf8'));
  }
  return out.join('\n');
}

async function fixture(t, coreOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), 'zuku-uni-'));
  const stateDir = join(home, '.config', 'zukujs', 'core');
  const host = await startCoreHost({ stateDir, home, environment: {}, coreOptions });
  const direct = await createCoreClient({ stateDir, autostart: false });
  t.after(async () => { direct.close(); await host.close(); await rm(home, { recursive: true, force: true }); });
  await create(['my-game'], { cwd: home });
  const game = join(home, 'my-game');
  async function cli(args, extra = {}) {
    let out = '', err = '';
    const stderr = extra.stderr ?? { isTTY: false, write(value) { err += value; extra.onErr?.(err); return true; } };
    const code = await run(args, { core: { stateDir, autostart: false }, cwd: home, stdin: Readable.from([]), stdout: { write(value) { out += value; return true; } }, ...extra, stderr });
    // Progress and prompts share stderr; the protocol error envelope is its last line.
    const parse = text => { try { return JSON.parse(text.trim().split('\n').at(-1)); } catch { return undefined; } };
    return { code, out, err: extra.stderr?.text ?? err, data: parse(out)?.data, error: parse(extra.stderr?.text ?? err)?.error };
  }
  return { home, stateDir, host, direct, game, cli };
}
const labProvider = cli => cli(['provider', 'add', '--id', 'lab', '--type', 'anthropic-messages', '--base-url', 'http://127.0.0.1:9/v1', '--model', 'game-model', '--non-interactive', '--json']);

test('provider/model/auth front doors are registered and mutate one versioned Core configuration', async t => {
  const { cli, direct, home } = await fixture(t);
  const before = (await call(direct, 'provider.list')).revision;
  const added = await labProvider(cli);
  assert.equal(added.code, 0, added.err);
  assert.equal(added.data.id, 'lab'); assert.equal(added.data.custom, true); assert.deepEqual(added.data.models, ['game-model']);
  // Legacy wire spelling is normalized; the original runtime persisted the canonical type.
  const config = JSON.parse(await readFile(join(home, '.config/zukujs/providers/config.json'), 'utf8'));
  assert.equal(config.providers.lab.apiType, 'anthropic');
  assert.ok((await call(direct, 'provider.list')).revision > before, 'Core revision advanced');
  assert.equal((await cli(['model', 'use', 'lab/game-model', '--json'])).code, 0);
  assert.deepEqual((await cli(['model', 'current', '--json'])).data, { provider: 'lab', model: 'lab/game-model' });
  const listing = await call(direct, 'provider.list');
  assert.deepEqual([listing.activeProvider, listing.activeModel], ['lab', 'lab/game-model']);
  const human = await cli(['auth', 'list']);
  assert.equal(human.code, 0); assert.match(human.out, /codex .*Codex OAuth \(exp!\)/); assert.doesNotMatch(human.out, /\x1b/);
  const json = await cli(['auth', 'list', '--json']);
  assert.ok(json.data.find(row => row.provider === 'codex').method.experimental); assert.doesNotMatch(json.out, /\x1b|\(exp!\)/);
  // Core's public projection drops `removed`/`activeReset` (documented gap); the state is authoritative.
  assert.equal((await cli(['provider', 'remove', 'lab', '--yes', '--json'])).code, 0);
  assert.deepEqual((await cli(['model', 'current', '--json'])).data, { provider: 'zuku', model: 'zuku/auto' });
});

test('real zuku and zukujs processes attach the same Core and see identical provider state', async t => {
  const { home } = await fixture(t);
  for (const alias of ['zuku', 'zukujs']) await symlink(join(root, 'index.mjs'), join(home, alias));
  const exec = promisify(execFile);
  const invoke = (alias, ...args) => exec(process.execPath, [join(home, alias), ...args], { cwd: home, timeout: 20000, env: { HOME: home, PATH: dirname(process.execPath), TERM: 'dumb', NO_COLOR: '1' } });
  const added = JSON.parse((await invoke('zuku', 'provider', 'add', '--id', 'lab', '--type', 'openai-chat', '--base-url', 'http://127.0.0.1:9/v1', '--model', 'game-model', '--json')).stdout);
  assert.equal(added.success, true);
  await invoke('zukujs', 'model', 'use', 'lab/game-model', '--json');
  const [a, b] = await Promise.all([invoke('zuku', 'model', 'current', '--json'), invoke('zukujs', 'model', 'current', '--json')]);
  assert.equal(a.stdout, b.stdout); assert.deepEqual(JSON.parse(a.stdout).data, { provider: 'lab', model: 'lab/game-model' });
  const [p, q] = await Promise.all([invoke('zuku', 'provider', 'show', 'lab', '--json'), invoke('zukujs', 'provider', 'show', 'lab', '--json')]);
  assert.equal(p.stdout, q.stdout);
});

test('--option is a finite vocabulary; Core-inexpressible or unpersisted options fail before any write', async t => {
  const { cli, home } = await fixture(t);
  const ok = await cli(['provider', 'configure', 'amazon-bedrock', '--option', 'region=us-east-1', '--json']);
  assert.equal(ok.code, 0, ok.err);
  const configPath = join(home, '.config/zukujs/providers/config.json');
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).providers['amazon-bedrock'].options.region, 'us-east-1');
  const snapshot = await readFile(configPath, 'utf8');
  for (const [args, code] of [
    [['google-vertex', '--option', 'project=my-project-01'], 'CORE_PROTOCOL_GAP'],
    [['google-vertex', '--project', 'my-project-01'], 'CORE_PROTOCOL_GAP'],
    [['openai', '--option', 'wire=chat'], 'PROVIDER_OPTION_UNSUPPORTED'],
    [['openai', '--option', 'allowLoopbackHttp=true'], 'PROVIDER_OPTION_UNSUPPORTED'],
    [['openai', '--option', 'bogus=1'], 'INVALID_INPUT'],
    [['amazon-bedrock', '--option', 'region=https://evil.example'], 'INVALID_INPUT'],
    [['amazon-bedrock', '--option', 'region=us-east-1', '--option', 'region=us-west-2'], 'INVALID_INPUT'],
    [['openai', '--option', `model=${'sk-proj-' + 'a'.repeat(30)}`], 'AUTH_SECRET_ARGUMENT'],
    [['openai', '--header-env', 'X-Org=ORG_ID'], 'CORE_PROTOCOL_GAP'],
  ]) {
    const result = await cli(['provider', 'configure', ...args, '--json']);
    assert.equal(result.error?.code, code, `${args.join(' ')} -> ${result.err}`);
    assert.ok(!result.err.includes('sk-proj-'), 'secret-shaped values are never echoed');
  }
  assert.equal(await readFile(configPath, 'utf8'), snapshot, 'rejected options wrote nothing');
});

test('explicitly injected provider context keeps the historical direct runtime and its full option set', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zuku-uni-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = { home: dir, environment: {}, stdin: Readable.from([]), stderr: { write() { return true; } }, providerContext: { adapters: null, experimental: undefined, legacyAuth: {} } };
  const added = await provider(['add', '--id', 'lab', '--type', 'anthropic-messages', '--base-url', 'https://llm.lab.test/v1', '--model', 'm1', '--option', 'model=m0'], ctx);
  assert.deepEqual(added.models, ['m0', 'm1']); assert.equal(added.apiType, 'anthropic');
  const vertex = await provider(['configure', 'google-vertex', '--option', 'project=my-project-01', '--location', 'us-central1'], ctx);
  assert.deepEqual(vertex.options, { project: 'my-project-01', location: 'us-central1' });
  const catalog = await provider(['configure', 'lab', '--type', 'openai-chat', '--option', 'catalog=openai'], ctx);
  assert.equal(catalog.options.catalog, 'openai');
  await assert.rejects(provider(['configure', 'openai', '--option', 'profile=default'], ctx), { code: 'PROVIDER_OPTION_UNSUPPORTED' });
});

test('auth login uses the native prompter: stdin secret is stored once and never appears in output or Core state', async t => {
  const { cli, home, stateDir, direct } = await fixture(t);
  const missing = await cli(['auth', 'login', '--provider', 'openai', '--json']);
  assert.equal(missing.error.code, 'AUTH_INPUT_REQUIRED');
  assert.deepEqual((await call(direct, 'auth.list')).requests, [], 'non-interactive input failed before any Core auth job');
  const result = await cli(['auth', 'login', '--provider', 'openai', '--api-key-stdin', '--json'], { stdin: Readable.from([`${SECRET}\n`]) });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual([result.data.status, result.data.storage, result.data.method.id], ['configured', 'secure-store', 'api-key']);
  assert.ok(!result.out.includes(SECRET) && !result.err.includes(SECRET));
  const secrets = JSON.parse(await readFile(join(home, '.config/zukujs/providers/secrets.json'), 'utf8'));
  assert.equal(secrets.providers.openai.apiKey, SECRET);
  assert.ok(!(await walk(stateDir)).includes(SECRET), 'Core journals/state never contain the secret');
  const jobs = (await call(direct, 'auth.list')).requests;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'completed'); assert.ok(!JSON.stringify(jobs).includes(SECRET));
  const listed = await cli(['auth', 'list', '--provider', 'openai', '--json']);
  assert.equal(listed.data[0].status, 'configured'); assert.ok(!listed.out.includes(SECRET));
  assert.equal((await cli(['auth', 'logout', '--provider', 'openai', '--json'])).code, 0);
  assert.equal((await cli(['auth', 'list', '--provider', 'openai', '--json'])).data[0].status, 'not-configured');
});

test('hidden-entry Ctrl-C cancels the Core auth job before persistence; Codex needs explicit opt-in', async t => {
  const { cli, home, direct } = await fixture(t);
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  const stderr = new PassThrough(); stderr.isTTY = true; stderr.text = '';
  stderr.on('data', chunk => { stderr.text += chunk; if (stderr.text.includes('표시되지 않습니다') && !stderr.sent) { stderr.sent = true; stdin.write('partial-secret\u0003'); } });
  const cancelled = await cli(['auth', 'login', '--provider', 'anthropic', '--json'], { stdin, stderr });
  assert.equal(cancelled.code, 130, stderr.text); assert.equal(cancelled.error.code, 'COMMAND_CANCELLED');
  const job = (await call(direct, 'auth.list')).requests.at(-1);
  assert.equal(job.status, 'cancelled');
  await assert.rejects(readFile(join(home, '.config/zukujs/providers/secrets.json')), { code: 'ENOENT' });
  assert.ok(!stderr.text.includes('partial-secret'));
  const codex = await cli(['auth', 'login', '--provider', 'codex', '--json']);
  assert.equal(codex.error.code, 'AUTH_EXPERIMENTAL_OPT_IN');
  assert.equal((await cli(['auth', 'login', '--provider', 'openai', '--api-key-stdin', '--verify', '--json'], { stdin: Readable.from([`${SECRET}\n`]) })).error.code, 'CORE_PROTOCOL_GAP');
  await assert.rejects(readFile(join(home, '.config/zukujs/providers/secrets.json')), { code: 'ENOENT' });
});

test('agent runs through grant/session/input and follows the Core journal; no fallback, explicit opt-in', async t => {
  const calls = [];
  // FIXTURE: replaces only the model-driven game work inside the isolated Core.
  const { cli, direct, game } = await fixture(t, { operationRunner: async ({ params, project, provider: selected }) => { calls.push({ operation: params.operation, model: selected?.model, path: project.path }); return { status: 'completed' }; } });
  const noAccount = await cli(['agent', 'add a dash move to my game', '--json'], { cwd: game });
  // The runtime's ZUKU_LOGIN_REQUIRED is outside Core's safe-code allowlist (documented gap).
  assert.equal(noAccount.code, 1); assert.ok(['AUTH_REQUIRED', 'CORE_OPERATION_FAILED'].includes(noAccount.error.code), noAccount.err);
  assert.equal(calls.length, 0, 'native zuku/auto without a ZUKU login never falls back to another provider');
  assert.equal((await labProvider(cli)).code, 0);
  assert.equal((await cli(['model', 'use', 'lab/game-model', '--json'])).code, 0);
  const optIn = await cli(['agent', 'add a dash move to my game', '--json'], { cwd: game });
  assert.equal(optIn.error.code, 'AUTH_EXPERIMENTAL_OPT_IN');
  const done = await cli(['agent', 'add a dash move to my game', '--experimental', '--json'], { cwd: game });
  assert.equal(done.code, 0, done.err);
  assert.equal(done.data.status, 'completed'); assert.equal(done.data.verified, false); assert.equal(done.data.operation, 'game.maintain');
  assert.match(done.err, /▶ game\.maintain · lab\/game-model \(exp!\)/);
  assert.deepEqual(calls.map(item => [item.operation, item.model, item.path]), [['game.maintain', 'lab/game-model', game]]);
  // A second front door reuses the same Core session history instead of a private store.
  const again = await cli(['chat', 'fix the dash cooldown in my game', '--experimental', '--json'], { cwd: game });
  assert.equal(again.code, 0, again.err); assert.equal(again.data.sessionId, done.data.sessionId);
  const sessions = (await call(direct, 'session.list')).sessions;
  assert.equal(sessions.length, 1); assert.equal(sessions[0].state, 'completed');
  const scope = await cli(['chat', 'build an ecommerce checkout site', '--experimental', '--json'], { cwd: game });
  assert.equal(scope.error.code, 'AGENT_REQUEST_OUT_OF_SCOPE'); assert.equal(calls.length, 2);
  assert.equal((await cli(['agent', 'make a game', '--browser', '/usr/bin/chromium', '--json'], { cwd: game })).error.code, 'CORE_PROTOCOL_GAP');
  // init grants an empty folder for game.init and forwards the game name to Core.
  const fresh = join(dirname(game), 'fresh'); await mkdir(fresh);
  const created = await cli(['init', 'create a jumping game', '--name', 'jumper', '--experimental', '--json'], { cwd: fresh });
  assert.equal(created.code, 0, created.err); assert.equal(created.data.operation, 'game.init');
  assert.deepEqual(calls.at(-1), { operation: 'game.init', model: 'lab/game-model', path: fresh });
});

test('studio starts the local browser adapter on the same Core and Ctrl-C only closes it', async t => {
  const { cli, direct } = await fixture(t);
  const controller = new AbortController();
  let origin; const ready = new Promise(resolve => { origin = resolve; });
  const pending = cli(['studio', '--port', '0', '--json'], { signal: controller.signal, onErr: text => { const match = /(http:\/\/127\.0\.0\.1:\d+)\n/.exec(text); if (match) origin(match[1]); } });
  const base = await ready;
  const health = await (await fetch(`${base}/v1/health`)).json();
  assert.equal(health.protocolVersion, 1);
  controller.abort();
  const stopped = await pending;
  assert.equal(stopped.code, 0, stopped.err); assert.equal(stopped.data.frontend, 'https://ai.zuzunza.com');
  assert.equal((await call(direct, 'hello')).status, 'ready', 'Core keeps running after the adapter closes');
});

test('Ctrl-C sends an explicit session.cancel; detaching a client never cancels the Core session', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const begun = new Promise(resolve => { started = resolve; });
  const { cli, direct, game, stateDir } = await fixture(t, { operationRunner: async (input, context) => {
    started();
    await Promise.race([gate, new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }))]);
    if (context.signal.aborted) throw new ProtocolError('COMMAND_CANCELLED');
    return { status: 'completed' };
  } });
  await labProvider(cli); await cli(['model', 'use', 'lab/game-model', '--json']);
  const controller = new AbortController();
  const pending = cli(['test', '--json'], { cwd: game, signal: controller.signal });
  await begun; controller.abort();
  const result = await pending;
  assert.equal(result.code, 130); assert.equal(result.error.code, 'COMMAND_CANCELLED');
  const [session] = (await call(direct, 'session.list')).sessions;
  assert.equal(session.state, 'cancelled');
  const events = [];
  for await (const event of direct.subscribe({ sessionId: session.sessionId })) { events.push(event.type); if (event.type === 'agent.cancelled') break; }
  assert.ok(events.includes('agent.cancelled'));
  // Detach: the CLI's own client closes mid-run; Core keeps running and completes.
  started = () => {}; let begun2; const second = new Promise(resolve => { begun2 = resolve; }); started = begun2;
  const client = await createCoreClient({ stateDir, autostart: false });
  const detached = cli(['test', '--json'], { cwd: game, core: undefined, coreClient: client });
  await second; client.close();
  assert.notEqual((await detached).code, 0);
  for (let i = 0; i < 50 && (await call(direct, 'session.get', { sessionId: session.sessionId })).state !== 'running'; i++) await pause(10);
  assert.equal((await call(direct, 'session.get', { sessionId: session.sessionId })).state, 'running', 'closing a client did not cancel');
  release();
  for (let i = 0; i < 200 && (await call(direct, 'session.get', { sessionId: session.sessionId })).state === 'running'; i++) await pause(10);
  assert.equal((await call(direct, 'session.get', { sessionId: session.sessionId })).state, 'completed');
});

test('build keeps installed-framework precedence; only an actual ZUKU game falls back to Core game.build', async t => {
  const calls = [];
  const { cli, direct, game, home } = await fixture(t, { operationRunner: async ({ params }) => { calls.push(params.operation); return { status: 'completed' }; } });
  await labProvider(cli); await cli(['model', 'use', 'lab/game-model', '--json']);
  const built = await cli(['build', '--json'], { cwd: game });
  assert.equal(built.code, 0, built.err); assert.deepEqual(calls, ['game.build']);
  const plain = join(home, 'plain'); await mkdir(plain);
  const projects = (await call(direct, 'project.list')).projects.length;
  const missing = await cli(['build', '--json'], { cwd: plain });
  assert.equal(missing.error.code, 'FRAMEWORK_UNAVAILABLE');
  assert.equal((await call(direct, 'project.list')).projects.length, projects, 'non-game folders are not granted');
  const pkg = join(game, 'node_modules', 'zukujs'); await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'zukujs', type: 'module', bin: { zukujs: './bin.mjs' } }));
  await writeFile(join(pkg, 'bin.mjs'), 'process.exitCode = 7;');
  assert.equal((await cli(['build', '--json'], { cwd: game })).code, 7); assert.deepEqual(calls, ['game.build']);
});

test('run serves Core preview snapshots on loopback until Ctrl-C; doctor reports one shared runtime', async t => {
  const { cli, game } = await fixture(t);
  const once = await cli(['run', '--once', '--json'], { cwd: game });
  assert.equal(once.code, 0, once.err); assert.match(once.data.previewHandle, /^preview_[a-f0-9]{32}$/);
  const controller = new AbortController();
  let url; const ready = new Promise(resolve => { url = resolve; });
  const serving = cli(['run', '--json'], { cwd: game, signal: controller.signal, onErr: text => { const match = /(http:\/\/127\.0\.0\.1:\d+\/p\/[a-f0-9]{32}\/)/.exec(text); if (match) url(match[1]); } });
  const response = await fetch(await ready);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(await response.text(), /<html|<!doctype/i);
  controller.abort();
  const stopped = await serving;
  assert.equal(stopped.code, 0); assert.equal(stopped.data.stopped, true);
  const doctor = await cli(['doctor', '--no-start', '--json'], { cwd: game });
  assert.equal(doctor.code, 0);
  assert.deepEqual([doctor.data.core.status, doctor.data.provider.model, doctor.data.workspace.zuku_game, doctor.data.frontend.remote_cloud_execution], ['ready', 'zuku/auto', true, 'unspecified']);
  assert.deepEqual(doctor.data.cli.aliases, ['zuku', 'zukujs']);
});

test('help, completion and bare prompts keep original routing with the corrected frontend wording', async () => {
  let out = '';
  const io = { stdout: { write(value) { out += value; return true; } }, stderr: { write() { return true; } } };
  assert.equal(await run(['--help'], io), 0);
  assert.match(out, /zukujs provider/); assert.match(out, /zukujs doctor/); assert.match(out, /원격 클라우드 실행은 정해지지 않았습니다/);
  assert.doesNotMatch(out, /웹·클라우드 제공은 미정/); assert.match(out, /6시간/);
  out = ''; assert.equal(await run(['completion', 'bash'], io), 0); assert.match(out, /provider model auth/);
  for (const [args, expected] of [[['make a jump game'], ['make a jump game']], [['점프게임'], ['점프게임']], [['--name', 'jumper', 'make a game'], ['--name', 'jumper', 'make a game']]]) {
    let seen; assert.equal(await run(args, { ...io, agent: async values => { seen = values; return {}; } }), 0); assert.deepEqual(seen, expected);
  }
  assert.equal(await run(['unregistered-native', '--json'], io), 2);
});

test('model addresses normalize to provider/model with native zuku/auto and no implicit provider', () => {
  assert.equal(normalizeModelAddress('auto'), 'zuku/auto');
  assert.equal(normalizeModelAddress('openrouter/vendor/model'), 'openrouter/vendor/model');
  assert.equal(normalizeModelAddress('gpt-test', { provider: 'openai' }), 'openai/gpt-test');
  assert.throws(() => normalizeModelAddress('gpt-test'), { code: 'MODEL_ADDRESS_INVALID' });
  assert.throws(() => normalizeModelAddress('other/x', { provider: 'openai' }), { code: 'INVALID_INPUT' });
  assert.deepEqual(['api-key', 'codex-oauth', 'game-cli-device', 'environment', 'local'].map(id => methodKind({ id })), ['secret', 'delegate', 'delegate', 'environment', 'passive']);
});
