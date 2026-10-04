import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createProviderRuntime, renderProviderOutput } from '../lib/provider-system/index.mjs';
import { askSecret, readSecretFromStdin, isInteractive } from '../lib/provider-system/prompt.mjs';
import { parseArgs } from '../lib/provider-system/args.mjs';
import provider from '../commands/provider.mjs';
import model from '../commands/model.mjs';
import auth from '../commands/auth.mjs';

const SECRET = 'sk-fixture-cli-' + 'q7'.repeat(12);
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zuku-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const sink = () => { const out = { text: '', isTTY: false, write(chunk) { out.text += chunk; return true; } }; return out; };
const ctx = (dir, extra = {}) => ({ home: dir, environment: {}, stdin: Readable.from([]), stderr: sink(), providerContext: { adapters: null, experimental: undefined, legacyAuth: {} }, ...extra });
function fakeTty() {
  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.rawModes = [];
  stdin.setRawMode = mode => { stdin.rawModes.push(mode); return stdin; };
  const stderr = new PassThrough();
  stderr.isTTY = true; stderr.text = '';
  stderr.on('data', chunk => { stderr.text += chunk; });
  return { stdin, stderr };
}

test('non-TTY commands are deterministic: no prompts, missing input fails fast with fixed codes', async t => {
  const dir = await home(t);
  const c = ctx(dir);
  await assert.rejects(provider(['add'], c), { code: 'INVALID_INPUT' });
  await assert.rejects(provider(['use'], c), { code: 'INVALID_INPUT' });
  await assert.rejects(provider(['configure', 'openai'], c), { code: 'INVALID_INPUT' });
  await assert.rejects(model(['use'], c), { code: 'INVALID_INPUT' });
  await assert.rejects(auth(['login', '--provider', 'openai'], c), { code: 'AUTH_INPUT_REQUIRED' });
  await assert.rejects(auth(['login', '--provider', 'openai', '--api-key-stdin', '--header', 'X-A'], c), { code: 'INVALID_INPUT' });
  await provider(['add', '--id', 'lab', '--type', 'anthropic', '--base-url', 'https://llm.lab.test/v1', '--model', 'lab/model-1', '--model', 'model-2', '--api-key-env', 'LAB_KEY'], c);
  await assert.rejects(provider(['remove', 'lab'], c), { code: 'INVALID_INPUT' });
  assert.equal(c.stderr.text, '', 'nothing was prompted on stderr');
  for (const args of [['frobnicate'], ['list', '--bogus'], ['use', 'a', 'b']]) await assert.rejects(provider(args, c), { code: 'INVALID_INPUT' });
  await assert.rejects(model(['use', 'lab/missing'], c), error => ['MODEL_NOT_FOUND', 'MODEL_UNAVAILABLE'].includes(error.code));
  assert.deepEqual(await model(['use', 'lab/lab/model-1'], c), { provider: 'lab', model: 'lab/lab/model-1' });
  const info = await model(['info', 'lab/lab/model-1'], c);
  assert.deepEqual([info.contextWindow, info.maxOutputTokens, info.inputCost, info.capabilities.tools], [null, null, null, null]);
  assert.deepEqual(await provider(['remove', 'lab', '--yes'], c), { removed: 'lab', activeReset: true, active: { provider: 'zuku', model: 'zuku/auto' } });
  assert.equal((await auth(['login', '--provider', 'ollama'], c)).status, 'not-required');
});

test('env references store only the variable NAME; header secrets are refs in config', async t => {
  const dir = await home(t);
  const c = ctx(dir, { environment: { MY_LAB_KEY: SECRET } });
  const result = await auth(['login', '--provider', 'groq', '--api-key-env', 'MY_LAB_KEY'], c);
  assert.deepEqual([result.status, result.envVar], ['environment', 'MY_LAB_KEY']);
  const runtime = await createProviderRuntime({ home: dir, environment: { MY_LAB_KEY: SECRET }, adapters: null, experimental: undefined, legacyAuth: {} });
  const row = (await runtime.listProviders()).find(item => item.id === 'groq');
  assert.deepEqual([row.apiKeyEnv, row.auth.status, JSON.stringify(row).includes(SECRET)], ['MY_LAB_KEY', 'environment', false]);
  await assert.rejects(auth(['login', '--provider', 'groq', '--api-key-env', 'lower-case'], c), { code: 'PROVIDER_CONFIG_INVALID' });
  await assert.rejects(auth(['login', '--provider', 'google-vertex', '--api-key-env', 'X'], c), { code: 'AUTH_METHOD_UNSUPPORTED' });
});

test('legacy ZUKU/Codex logins are delegated to the original commands; Codex needs explicit --experimental', async t => {
  const dir = await home(t);
  const calls = [];
  const legacyAuth = { login: async (name, args) => { calls.push([name, args]); return { connected: true }; }, status: async name => name === 'zuku' ? 'configured' : 'not-configured', logout: async name => { calls.push(['logout', name]); } };
  const c = ctx(dir, { providerContext: { adapters: null, experimental: undefined, legacyAuth } });
  assert.equal((await auth(['login'], c)).method.id, 'game-cli-device');
  await auth(['login', '--provider', 'zuku', '--no-browser'], c);
  await assert.rejects(auth(['login', '--provider', 'codex'], c), { code: 'AUTH_EXPERIMENTAL_OPT_IN' });
  const codex = await auth(['login', '--provider', 'codex', '--experimental'], c);
  assert.deepEqual([codex.method.official, codex.method.experimental], [false, true]);
  await auth(['logout', '--provider', 'codex'], c);
  assert.deepEqual(calls, [['zuku', []], ['zuku', ['--no-browser']], ['codex', ['--experimental']], ['logout', 'codex']]);
  const rows = await auth(['list'], c);
  assert.deepEqual(rows.filter(row => ['zuku', 'codex'].includes(row.provider)).map(row => row.status), ['configured', 'not-configured']);
  await assert.rejects(auth(['login', '--provider', 'zuku', '--api-key-stdin'], c), { code: 'INVALID_INPUT' });
  const missing = ctx(dir);
  await assert.rejects(auth(['logout'], missing), { code: 'AUTH_DELEGATE_UNAVAILABLE' });
});

test('interactive TTY: hidden secret entry never echoes, Ctrl-C cancels and terminal mode is restored', async t => {
  const dir = await home(t);
  const tty = fakeTty();
  const pending = auth(['login', '--provider', 'anthropic'], ctx(dir, tty));
  setImmediate(() => tty.stdin.write(`${SECRET}\r`));
  const result = await pending;
  assert.equal(result.status, 'configured');
  assert.equal(tty.stderr.text.includes(SECRET), false);
  assert.match(tty.stderr.text, /API Key/);
  assert.deepEqual(tty.stdin.rawModes, [true, false]);
  const cancel = fakeTty();
  const cancelled = askSecret({ ...cancel, interactive: true }, 'key: ');
  setImmediate(() => cancel.stdin.write('abc\u0003'));
  await assert.rejects(cancelled, { code: 'COMMAND_CANCELLED' });
  assert.deepEqual(cancel.stdin.rawModes, [true, false]);
  assert.equal(isInteractive({ stdin: { isTTY: true }, stderr: { isTTY: false } }), false);
});

test('interactive provider add follows the finite guided flow', async t => {
  const dir = await home(t);
  const tty = fakeTty();
  const pending = provider(['add'], ctx(dir, tty));
  const answers = ['1', 'Local AI', 'local-ai', 'http://localhost:8000/v1', 'my-model', 'n'];
  const feed = () => { const next = answers.shift(); if (next !== undefined) tty.stdin.write(next + '\n'); };
  const timer = setInterval(feed, 15);
  t.after(() => clearInterval(timer));
  const row = await pending;
  assert.deepEqual([row.id, row.name, row.apiType, row.baseUrl, row.defaultModel], ['local-ai', 'Local AI', 'openai-chat', 'http://localhost:8000/v1', 'my-model']);
  assert.match(tty.stderr.text, /Provider type:/);
});

test('bounded stdin secret input and strict argv parsing', async () => {
  assert.equal(await readSecretFromStdin({ stdin: Readable.from([SECRET + '\n']) }), SECRET);
  await assert.rejects(readSecretFromStdin({ stdin: Readable.from(['a'.repeat(20000)]) }), { code: 'AUTH_SECRET_INVALID' });
  await assert.rejects(readSecretFromStdin({ stdin: Readable.from(['two\nlines\n']) }), { code: 'AUTH_SECRET_INVALID' });
  const never = new PassThrough();
  await assert.rejects(readSecretFromStdin({ stdin: never }, { timeoutMs: 50 }), { code: 'AUTH_INPUT_REQUIRED' });
  await assert.rejects(readSecretFromStdin({ stdin: { isTTY: true } }), { code: 'AUTH_INPUT_REQUIRED' });
  assert.deepEqual(parseArgs(['--model', 'a', '--model=b', '--refresh'], { flags: { '--model': 'list', '--refresh': 'boolean' } }), { _: [], model: ['a', 'b'], refresh: true });
  for (const args of [['--refresh', '--refresh'], ['--model'], ['-x'], ['a\u0000']]) assert.throws(() => parseArgs(args, { flags: { '--model': 'list', '--refresh': 'boolean' }, positionals: 1 }));
});

test('render: (exp!) is derived from metadata, orange only on ANSI TTY; NO_COLOR/dumb/pipe are plain', async t => {
  const dir = await home(t);
  const runtime = await createProviderRuntime({ home: dir, environment: {}, adapters: null, experimental: undefined, legacyAuth: {} });
  await runtime.addProvider({ id: 'compat', name: 'Compat', apiType: 'openai-chat', baseUrl: 'https://compat.test/v1', model: 'm' });
  const rows = await runtime.listProviders();
  const tty = { isTTY: true };
  const colored = renderProviderOutput('provider.list', rows, { stream: tty, environment: {} });
  assert.match(colored, /^● ZUKU AI/m);
  assert.match(colored, /Codex OAuth \x1b\[38;5;208m\(exp!\)\x1b\[0m/);
  assert.match(colored, /Custom Endpoint API Key \x1b\[38;5;208m\(exp!\)\x1b\[0m/);
  assert.equal(colored.replace(/\x1b\[38;5;208m\(exp!\)\x1b\[0m/g, '').includes('\x1b'), false, 'only (exp!) is coloured');
  for (const options of [{ stream: tty, environment: { NO_COLOR: '' } }, { stream: tty, environment: { TERM: 'dumb' } }, { stream: { isTTY: false }, environment: {} }]) {
    const plain = renderProviderOutput('provider.list', rows, options);
    assert.equal(plain.includes('\x1b'), false); assert.match(plain, /Codex OAuth \(exp!\)/);
  }
  const detail = renderProviderOutput('provider.show', rows.find(row => row.id === 'openai'), { color: false });
  assert.doesNotMatch(detail, /exp!/);
  assert.match(detail, /API Key\n/);
  const renamed = { ...rows.find(row => row.id === 'openai'), authMethods: [{ id: 'x', name: 'Experimental-sounding Name', official: true, experimental: false }] };
  assert.doesNotMatch(renderProviderOutput('provider.show', renamed, { color: false }), /exp!/, 'no string matching');
  const viaRoot = renderProviderOutput('auth.list', await runtime.authList(), { color: true, experimental: { renderAuthMethod: method => `<${method.id}:${method.experimental}>` } });
  assert.match(viaRoot, /<codex-oauth:true>/);
  assert.equal(JSON.stringify(rows).includes('\x1b'), false, 'JSON data never carries ANSI');
});

test('the real adapter seam: if ./adapters is installed, a live loopback custom endpoint round-trips models', async t => {
  const adapterUrl = new URL('../lib/provider-system/adapters/index.mjs', import.meta.url);
  try { await access(adapterUrl); } catch { t.skip('protocol adapters are owned by another module and absent from this snapshot'); return; }
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const seen = [];
  const server = createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'live-model', object: 'model' }] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const dir = await home(t);
  const runtime = await createProviderRuntime({ home: dir, environment: { LIVE_KEY: SECRET }, experimental: undefined, legacyAuth: {} });
  await runtime.addProvider({ id: 'live', name: 'Live', apiType: 'openai-chat', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'LIVE_KEY' });
  assert.deepEqual((await runtime.listModels({ provider: 'live', refresh: true })).models, []);
  assert.equal(seen.length, 0, 'custom endpoints do not imply a model catalog');
  await runtime.configureProvider('live', { options: { catalog: 'openai' } });
  const listing = await runtime.listModels({ provider: 'live', refresh: true });
  assert.ok(listing.models.some(item => item.address === 'live/live-model'), JSON.stringify(listing.discovery));
  assert.ok(seen.some(item => item.url === '/v1/models' && item.auth === `Bearer ${SECRET}`));
});
