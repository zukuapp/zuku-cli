// Authentication uses real protected IPC and the real provider SecretStore in an isolated home.
// User decisions and entered key values are fixtures; no service login, live key or paid API is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, lstat, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startCoreHost, createCoreClient } from '../lib/agent-core/index.mjs';
import { ProtocolError, createBrowserClient } from '../lib/agent-protocol/index.mjs';
import { nativeAuthorizationUrl } from '../lib/agent-core/native-auth.mjs';
import { createBrowserAdapter } from '../lib/browser-adapter/server.mjs';
import { createCoreStorage } from '../lib/agent-core/storage.mjs';
import { readProtectedStore } from '../lib/accounts/windows-protected-store.mjs';

let serial = 0;
const envelope = (method, params = {}) => ({ protocolVersion: 1, id: `auth_req_${++serial}`, method, params });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const windows = process.platform === 'win32';
const storeText = file => windows ? readProtectedStore(file) : readFile(file, 'utf8');
async function call(client, method, params = {}, actor) {
  const response = await client.dispatch(envelope(method, params), actor ? { actor } : {});
  if (response.error) throw new ProtocolError(response.error.code); return response.result;
}
async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'zuku-core-auth-'));
  const providerDir = join(home, '.config', 'zukujs', 'providers');
  const host = await startCoreHost({ stateDir: join(home, 'core'), home, environment: {}, providerContext: { stateDir: providerDir }, ...options });
  const native = await createCoreClient({ stateDir: host.stateDir, autostart: false });
  const bridge = await createCoreClient({ stateDir: host.stateDir, autostart: false });
  const secretsPath = join(providerDir, windows ? 'secrets.dpapi' : 'secrets.json');
  t.after(async () => { native.close(); bridge.close(); await host.close(); await rm(home, { recursive: true, force: true }); });
  return { home, host, native, bridge, secretsPath };
}
async function waitAuth(client, requestId, actor) {
  for (let i = 0; i < 150; i++) {
    const state = await call(client, 'auth.list', {}, actor);
    const job = state.requests.find(item => item.authRequestId === requestId);
    if (job && job.status !== 'running') return { job, state };
    await pause(5);
  }
  assert.fail('authentication did not finish');
}
async function fileContents(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await fileContents(path));
    else if (entry.isFile()) out.push(await readFile(path, 'utf8'));
  }
  return out.join('\n');
}

test('actual paired browser requests auth while only native IPC receives secret input', async t => {
  const { host, home, native, bridge, secretsPath } = await fixture(t);
  const secret = 'fixture_private_openai_key_01234567890123456789', prompts = [];
  const detach = await native.attachNativePrompter(async request => {
    prompts.push(request);
    if (request.kind === 'decision') return { approved: true };
    assert.equal(request.kind, 'secret'); assert.equal(request.providerId, 'openai');
    return { value: secret };
  });
  const adapter = await createBrowserAdapter({ port: 0, approvePairing: async () => true, host: {
    getHealth: () => ({ status: 'ready', cliVersion: '0.3.0' }), getProjects: () => [],
    getProviders: () => ({ providers: [] }), getModels: () => [],
    createSession() { throw new Error('adapter session authority is unused'); }, input() { throw new Error('adapter agent is unused'); },
    dispatchCore: (request, actor) => bridge.dispatch(request, { actor }),
    subscribeCore: (params, actor) => bridge.subscribe(params, { actor }),
  } });
  const browser = createBrowserClient({ baseUrl: adapter.origin, fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Origin: 'https://ai.zuzunza.com' } }) });
  t.after(async () => { browser.close(); await adapter.close(); await detach(); });
  await browser.challenge();
  for (let i = 0; ; i++) { try { await browser.confirm(); break; } catch (error) { if (error.code !== 'PAIRING_PENDING' || i > 10) throw error; await pause(5); } }
  const accepted = await browser.call('auth.request', { providerId: 'openai', methodId: 'api-key' });
  assert.equal(accepted.accepted, true); assert.match(accepted.authRequestId, /^auth_[a-f0-9]{32}$/);
  let status;
  for (let i = 0; i < 100; i++) { status = await browser.call('auth.list'); if (status.requests[0]?.status === 'completed') break; await pause(5); }
  assert.equal(status.requests[0].status, 'completed');
  assert.equal(status.auth.find(item => item.provider === 'openai').status, 'configured');
  assert.deepEqual(prompts.map(item => item.kind), ['decision', 'secret']);
  assert.ok(prompts.every(item => item.official === true && item.experimental === false));
  assert.ok(!JSON.stringify([accepted, status]).includes(secret));
  assert.ok(!JSON.stringify(prompts).includes(secret));
  assert.ok(!await fileContents(host.stateDir).then(text => text.includes(secret)));
  assert.equal(JSON.parse(await storeText(secretsPath)).providers.openai.apiKey, secret);
  if (windows) assert.ok(!(await readFile(secretsPath)).includes(Buffer.from(secret)));
  else {
    assert.equal((await lstat(secretsPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(home, '.config/zukujs/providers'))).mode & 0o777, 0o700);
  }
  await browser.call('auth.logout', { providerId: 'openai' });
  for (let i = 0; i < 100; i++) { status = await browser.call('auth.list'); if (status.auth.find(item => item.provider === 'openai').status === 'not-configured') break; await pause(5); }
  assert.equal(status.auth.find(item => item.provider === 'openai').status, 'not-configured');
  assert.equal(prompts.at(-1).purpose, 'logout');
});

test('native prompter ownership rejects another client and secret replies from another connection', async t => {
  const { host, native, bridge, secretsPath } = await fixture(t);
  let seen; const seenPrompt = new Promise(resolve => { seen = resolve; });
  const detach = await native.attachNativePrompter(request => { seen(request); return new Promise(() => {}); });
  await assert.rejects(bridge.attachNativePrompter(() => ({ value: 'attacker' })), { code: 'NATIVE_PROMPTER_BUSY' });
  const accepted = await call(bridge, 'auth.request', { providerId: 'openai' });
  const prompt = await seenPrompt;
  const record = await (await createCoreStorage({ stateDir: host.stateDir })).readJSON('connection');
  const socket = createConnection(record.address); t.after(() => socket.destroy());
  const incoming = [], waiting = [];
  let buffer = '';
  socket.on('data', chunk => { buffer += chunk.toString(); let index; while ((index = buffer.indexOf('\n')) >= 0) { const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); if (waiting.length) waiting.shift()(message); else incoming.push(message); } });
  const next = () => incoming.length ? Promise.resolve(incoming.shift()) : new Promise(resolve => waiting.push(resolve));
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(JSON.stringify({ type: 'authenticate', protocolVersion: 1, token: record.token, clientId: 'auth_other_native' }) + '\n');
  assert.equal((await next()).type, 'authenticated');
  socket.write(JSON.stringify({ type: 'native-reply', id: prompt.id, reply: { value: 'attacker' } }) + '\n');
  assert.equal((await next()).error.code, 'PERMISSION_REQUIRED');
  await detach();
  const { job } = await waitAuth(bridge, accepted.authRequestId);
  assert.equal(job.status, 'cancelled'); assert.equal(job.code, 'COMMAND_CANCELLED');
  await assert.rejects(readFile(secretsPath), { code: 'ENOENT' });
  await assert.rejects(call(bridge, 'auth.request', { providerId: 'openai' }), { code: 'NATIVE_PERMISSION_REQUIRED' });
});

test('native prompt cancellation never writes an entered credential', async t => {
  // Cancellation and disconnect must not race the separate short expiry fixture on slow IPC.
  const { native, bridge, secretsPath } = await fixture(t);
  const detach = await native.attachNativePrompter(() => ({ cancelled: true }));
  const accepted = await call(bridge, 'auth.request', { providerId: 'openai' });
  const { job } = await waitAuth(bridge, accepted.authRequestId);
  assert.equal(job.status, 'cancelled'); assert.equal(job.code, 'COMMAND_CANCELLED');
  await assert.rejects(readFile(secretsPath), { code: 'ENOENT' }); await detach();
});

test('native prompt expiry never writes an entered credential', async t => {
  const { native, bridge, secretsPath } = await fixture(t, { nativePromptTimeoutMs: 35 });
  const detach = await native.attachNativePrompter(() => new Promise(() => {}));
  const accepted = await call(bridge, 'auth.request', { providerId: 'openai' });
  const timedOut = (await waitAuth(bridge, accepted.authRequestId)).job;
  assert.equal(timedOut.status, 'failed'); assert.equal(timedOut.code, 'AUTH_PROMPT_TIMEOUT');
  await assert.rejects(readFile(secretsPath), { code: 'ENOENT' }); await detach();
});

test('native prompt disconnect never writes an entered credential', async t => {
  const { native, bridge, secretsPath } = await fixture(t);
  let observed; const seen = new Promise(resolve => { observed = resolve; });
  await native.attachNativePrompter(request => { observed(request); return new Promise(() => {}); });
  const accepted = await call(bridge, 'auth.request', { providerId: 'openai' }); await seen; native.close();
  const { job } = await waitAuth(bridge, accepted.authRequestId);
  assert.equal(job.status, 'cancelled'); assert.equal(job.code, 'COMMAND_CANCELLED');
  await assert.rejects(readFile(secretsPath), { code: 'ENOENT' });
});

test('multiple native secret headers commit atomically and cancellation never writes the collected key', async t => {
  const { native, bridge, secretsPath, host } = await fixture(t);
  await call(native, 'provider.configure', { providerId: 'openai', patch: { headers: { 'X-First': { source: 'secret' }, 'X-Second': { source: 'secret' } } } });
  const entered = 'fixture_atomic_private_key_123456789', prompts = [];
  const detach = await native.attachNativePrompter(prompt => {
    prompts.push(prompt);
    return prompt.headerName === 'X-Second' ? { cancelled: true } : { value: entered };
  });
  const accepted = await call(bridge, 'auth.request', { providerId: 'openai', headerNames: ['X-First', 'X-Second'], includeApiKey: true });
  const { job, state } = await waitAuth(bridge, accepted.authRequestId);
  assert.equal(job.status, 'cancelled'); assert.equal(job.code, 'COMMAND_CANCELLED');
  assert.deepEqual(prompts.map(prompt => prompt.headerName ?? 'apiKey'), ['apiKey', 'X-First', 'X-Second']);
  assert.ok(!JSON.stringify([prompts, state]).includes(entered));
  assert.ok(!await fileContents(host.stateDir).then(text => text.includes(entered)));
  await assert.rejects(readFile(secretsPath), { code: 'ENOENT' });
  await detach();
});

test('changing a secret header reference while its native prompt is pending rejects persistence', async t => {
  const { native, bridge, secretsPath } = await fixture(t);
  await call(native, 'provider.configure', { providerId: 'openai', patch: { headers: { 'X-First': { source: 'secret' } } } });
  let observed, answer;
  const seen = new Promise(resolve => { observed = resolve; });
  await native.attachNativePrompter(prompt => { observed(prompt); return new Promise(resolve => { answer = resolve; }); });
  const accepted = await call(bridge, 'auth.request', { providerId: 'openai', headerNames: ['X-First'] });
  assert.equal((await seen).headerName, 'X-First');
  await call(native, 'provider.configure', { providerId: 'openai', patch: { headers: { 'X-First': { source: 'env', env: 'FIXTURE_HEADER' } } } });
  answer({ value: 'fixture_changed_header_123456789' });
  const { job } = await waitAuth(bridge, accepted.authRequestId);
  assert.equal(job.status, 'failed'); assert.equal(job.code, 'AUTH_SECRET_INVALID');
  await assert.rejects(readFile(secretsPath), { code: 'ENOENT' });
});

test('unofficial auth requires explicit opt-in and private URLs reject wrong service or credential data', async t => {
  const { native, bridge } = await fixture(t);
  let prompts = 0; await native.attachNativePrompter(() => { prompts++; return { cancelled: true }; });
  await assert.rejects(call(bridge, 'auth.request', { providerId: 'codex' }), { code: 'AUTH_EXPERIMENTAL_OPT_IN' });
  await assert.rejects(call(bridge, 'auth.request', { providerId: 'openai', methodId: 'codex-oauth' }), { code: 'AUTH_METHOD_UNSUPPORTED' });
  const browser = { kind: 'browser', id: 'paired_fixture', origin: 'https://ai.zuzunza.com', projectHandles: [] };
  await assert.rejects(bridge.dispatch(envelope('auth.request', { providerId: 'openai', apiKey: 'credential' }), { actor: browser }), { code: 'INVALID_INPUT' });
  assert.equal(prompts, 0);
  const code = 'ABCD-1234-EFAB';
  assert.equal(nativeAuthorizationUrl('zuku', `https://www.zuzunza.com/oauth/device?user_code=${code}`), `https://www.zuzunza.com/oauth/device?user_code=${code}`);
  assert.match(nativeAuthorizationUrl('codex', 'https://auth.openai.com/api/accounts/authorize?agent_name_hint=zukujs&response_type=code'), /agent_name_hint=zukujs/);
  for (const url of ['https://evil.example/oauth/device', 'https://www.zuzunza.com/oauth/device?access_token=private', 'https://www.zuzunza.com/oauth/device?user_code=bad', 'https://www.zuzunza.com.evil.example/oauth/device']) assert.throws(() => nativeAuthorizationUrl('zuku', url), { code: 'INVALID_INPUT' });
  assert.throws(() => nativeAuthorizationUrl('codex', 'https://auth.openai.com/api/accounts/authorize?id_token_hint=private'), { code: 'INVALID_INPUT' });
});

test('actual experimental Codex OAuth opens its own callback flow and keeps authorization private', async t => {
  const { native, bridge, home, host } = await fixture(t);
  let authorization;
  await native.attachNativePrompter(request => {
    authorization = request;
    assert.equal(request.kind, 'authorization-url'); assert.equal(request.official, false); assert.equal(request.experimental, true);
    return { cancelled: true };
  });
  const accepted = await call(bridge, 'auth.request', { providerId: 'codex', experimental: true });
  const { job, state } = await waitAuth(bridge, accepted.authRequestId);
  assert.equal(job.status, 'cancelled'); assert.equal(job.code, 'COMMAND_CANCELLED');
  const url = new URL(authorization.url);
  assert.equal(url.origin, 'https://auth.openai.com'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(new URL(url.searchParams.get('redirect_uri')).hostname, '127.0.0.1');
  const own = JSON.parse(await storeText(join(home, '.config/zukujs', windows ? 'codex-oauth.dpapi' : 'codex-oauth.json')));
  assert.equal(own.experimentalAccepted, true); assert.deepEqual(own.accounts, []);
  assert.ok(!JSON.stringify([accepted, state]).includes(url.searchParams.get('state')));
  assert.ok(!await fileContents(host.stateDir).then(text => text.includes(url.href)));
  await assert.rejects(readFile(join(home, '.codex/auth.json')), { code: 'ENOENT' });
});
