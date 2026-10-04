import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createProviderRuntime } from '../lib/provider-system/index.mjs';

const FIRST = 'fixture-first-key-123456789';
const SECOND = 'fixture-second-key-123456789';
const STAGE_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), 'zuku-auth-boundary-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const options = dir => ({ home: dir, environment: {}, experimental: undefined, legacyAuth: {} });
function adapters(hooks = {}) {
  const calls = [];
  return { calls, listBuiltinDescriptors: () => [], createAdapter(descriptor, context) {
    calls.push({ descriptor, context });
    return { capabilities: { stageInference: true },
      listModels: async () => hooks.list ? hooks.list(context) : [{ id: 'model' }],
      runStage: async request => hooks.stage ? hooks.stage(request, context) : { output: { ok: true } } };
  } };
}

test('auth login/logout rotate nonsecret catalog revision and stop previously admitted clients', async t => {
  const dir = await fixture(t), factory = adapters({ list: context => [{ id: context.credentials.apiKey === FIRST ? 'first' : 'second' }] });
  const runtime = await createProviderRuntime({ ...options(dir), adapters: factory });
  await runtime.authLogin('openai', { apiKey: FIRST });
  assert.equal((await runtime.listModels({ provider: 'openai' })).models[0].id, 'first');
  const client = await runtime.resolveStageProvider({ model: 'openai/first' });
  const before = JSON.parse(await readFile(join(dir, '.config/zukujs/providers/config.json'))).authRevisions.openai;
  await runtime.authLogin('openai', { apiKey: SECOND });
  assert.equal((await runtime.listModels({ provider: 'openai' })).models[0].id, 'second');
  await assert.rejects(client.runStage({ stage: 'design', input: {} }), { code: 'AUTH_SESSION_CHANGED' });
  const text = await readFile(join(dir, '.config/zukujs/providers/config.json'), 'utf8');
  assert.notEqual(JSON.parse(text).authRevisions.openai, before);
  assert.ok(!text.includes(FIRST) && !text.includes(SECOND));
  await runtime.authLogout('openai');
  const listing = await runtime.listModels({ provider: 'openai' });
  assert.deepEqual(listing.models, []);
  assert.equal(listing.discovery.error, 'AUTH_REQUIRED');
});

test('old in-flight discovery cannot repopulate the catalog after account switch', async t => {
  const dir = await fixture(t); let started, release;
  const waiting = new Promise(resolve => { started = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const factory = adapters({ list: async context => {
    if (context.credentials.apiKey === FIRST) { started(); await barrier; return [{ id: 'old-account' }]; }
    return [{ id: 'new-account' }];
  } });
  const runtime = await createProviderRuntime({ ...options(dir), adapters: factory });
  await runtime.authLogin('openai', { apiKey: FIRST });
  const previous = runtime.listModels({ provider: 'openai' });
  await waiting;
  await runtime.authLogin('openai', { apiKey: SECOND });
  release();
  assert.equal((await previous).discovery.error, 'AUTH_SESSION_CHANGED');
  assert.deepEqual((await previous).models, []);
  assert.equal((await runtime.listModels({ provider: 'openai' })).models[0].id, 'new-account');
  assert.equal((await runtime.listModels({ provider: 'openai' })).discovery.status, 'cached');
});

test('environment accounts never reuse another runtime catalog and changed env rejects old getter', async t => {
  const dir = await fixture(t), environment = { OPENAI_API_KEY: FIRST };
  const first = await createProviderRuntime({ ...options(dir), environment, adapters: adapters({ list: () => [{ id: 'first-env' }] }) });
  await first.listModels({ provider: 'openai' });
  const client = await first.resolveStageProvider({ model: 'openai/first-env' });
  environment.OPENAI_API_KEY = SECOND;
  await assert.rejects(client.runStage({ stage: 'design', input: {} }), { code: 'AUTH_SESSION_CHANGED' });
  const second = await createProviderRuntime({ ...options(dir), environment, adapters: adapters({ list: () => [{ id: 'second-env' }] }) });
  const listing = await second.listModels({ provider: 'openai' });
  assert.equal(listing.models[0].id, 'second-env'); assert.equal(listing.discovery.status, 'fresh');
});

test('header reference changes and provider removal/re-add invalidate the same-ID catalog', async t => {
  const dir = await fixture(t); let queried = 0;
  const runtime = await createProviderRuntime({ ...options(dir), environment: { ORG_A: 'org-a-fixture', ORG_B: 'org-b-fixture' }, adapters: adapters({ list: () => [{ id: `catalog-${++queried}` }] }) });
  await runtime.addProvider({ id: 'local-ai', apiType: 'openai-chat', baseUrl: 'http://127.0.0.1:8000/v1', headers: { 'X-Org': { source: 'env', env: 'ORG_A' } } });
  await runtime.listModels({ provider: 'local-ai' });
  await runtime.configureProvider('local-ai', { headers: { 'X-Org': { source: 'env', env: 'ORG_B' } } });
  assert.equal((await runtime.listModels({ provider: 'local-ai' })).models[0].id, 'catalog-2');
  await runtime.removeProvider('local-ai');
  await runtime.addProvider({ id: 'local-ai', apiType: 'openai-chat', baseUrl: 'http://127.0.0.1:8000/v1' });
  assert.equal((await runtime.listModels({ provider: 'local-ai' })).models[0].id, 'catalog-3');
});

test('native token getter forwards only explicit home and uses the real private credential type', async t => {
  const dir = await fixture(t);
  for (const explicit of [false, true]) {
    let seen, native, refresh;
    const runtime = await createProviderRuntime({ stateDir: join(dir, String(explicit)), platform: 'win32', environment: {}, adapters: null, experimental: undefined, legacyAuth: {},
      ...(explicit ? { home: dir } : {}), zukuAccountClientFactory: opts => { seen = opts; return { ensureFresh: async options => { refresh = options; return { accessToken: 'zuku_oa_' + 'c'.repeat(64), generation: 'fixture-own-account', scopes: ['games:generate'] }; } }; },
      nativeZuku: (_descriptor, context) => { native = context; return { capabilities: { stageInference: true }, runStage: async () => ({ output: {} }) }; } });
    await runtime.resolveStageProvider();
    const credential = await native.getInternalCredentials();
    assert.equal(credential.type, 'zuku-account'); assert.equal(await credential.getAccessToken(), 'zuku_oa_' + 'c'.repeat(64));
    assert.equal(refresh.requiredScope, 'games:generate');
    assert.equal(Object.hasOwn(seen, 'home'), explicit);
    if (explicit) assert.equal(seen.home, dir);
  }
});

test('Codex factory scopes only own store/fetch options and persisted opt-in permits repeat login', async t => {
  const dir = await fixture(t);
  for (const explicit of [false, true]) {
    let factoryOptions, loggedContext, loggedArgs;
    const own = { getAccessToken: async () => 'fixture-own-codex', status: async () => ({ experimentalAccepted: true, authenticated: true }) };
    const factory = adapters();
    const fetch = () => { throw Error('no network in fixture'); };
    const runtime = await createProviderRuntime({ stateDir: join(dir, String(explicit)), environment: {}, fetch, adapters: factory, experimental: undefined,
      ...(explicit ? { home: dir } : {}), codexOAuthFactory: opts => { factoryOptions = opts; return own; },
      legacyAuth: { login: async (_id, args, ctx) => { loggedArgs = args; loggedContext = ctx; return {}; } } });
    await runtime.configureProvider('codex', { addModels: [{ id: 'model' }] });
    await runtime.resolveStageProvider({ model: 'codex/model' });
    const credential = await factory.calls.at(-1).context.getInternalCredentials();
    assert.equal(credential.type, 'codex-oauth');
    assert.equal(await credential.getAccessToken(), 'fixture-own-codex');
    assert.equal(await credential.getOAuthClient(), own);
    assert.equal(factoryOptions.fetchImpl, fetch);
    assert.equal(Object.hasOwn(factoryOptions, 'home'), false);
    assert.equal(Object.hasOwn(factoryOptions, 'storePath'), explicit);
    if (explicit) assert.equal(factoryOptions.storePath, join(dir, '.config/zukujs', process.platform === 'win32' ? 'codex-oauth.dpapi' : 'codex-oauth.json'));
    await runtime.authLogin('codex');
    assert.deepEqual(loggedArgs, []); assert.equal(loggedContext.oauth, own);
  }
});

test('core same-inference observer discards reasoning and redacts split credentials', async t => {
  const dir = await fixture(t), seen = []; let inferenceCount = 0;
  const factory = adapters({ stage: async request => {
    inferenceCount++;
    await request.onEvent({ type: 'reasoning-delta', text: 'PRIVATE_REASONING_SENTINEL' });
    await request.onEvent({ type: 'text-delta', text: 'visible ' + FIRST.slice(0, 10) });
    await request.onEvent({ type: 'text-delta', text: FIRST.slice(10) + ' end' });
    await request.onEvent({ type: 'usage', usage: { inputTokens: 1, raw: 'PRIVATE_SENTINEL' } });
    await request.onEvent({ type: 'finish', reason: 'completed' });
    return { output: { ok: true } };
  } });
  const runtime = await createProviderRuntime({ ...options(dir), environment: { OPENAI_API_KEY: FIRST }, adapters: factory });
  const client = await runtime.resolveStageProvider({ model: 'openai/model' });
  await client.runStage({ stage: 'design', input: {}, outputSchema: STAGE_SCHEMA, maxOutputBytes: 1000, onEvent: async event => { seen.push(event); } });
  assert.equal(inferenceCount, 1);
  assert.equal(seen.filter(event => event.type === 'text-delta').map(event => event.text).join(''), 'visible [REDACTED] end');
  assert.ok(!JSON.stringify(seen).includes(FIRST) && !JSON.stringify(seen).includes('PRIVATE_'));
});

test('actual Windows provider DPAPI API and native default LOCALAPPDATA bridge', { skip: process.platform !== 'win32' }, async t => {
  const dir = await fixture(t), appData = join(dir, 'isolated-local-app-data');
  const program = String.raw`
    import assert from 'node:assert/strict';
    import { lstat, readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { createProviderRuntime } from './lib/provider-system/index.mjs';
    import { saveZukuAccount, removeZukuAccount } from './lib/accounts/store.mjs';
    import { GAME_SCOPES, NATIVE_GAME_SCOPE } from './lib/accounts/client.mjs';
    const account = join(process.env.LOCALAPPDATA, 'ZukuJS', 'account.dpapi');
    const secretFile = join(process.env.LOCALAPPDATA, 'ZukuJS', 'providers', 'secrets.dpapi');
    await assert.rejects(lstat(account), { code: 'ENOENT' });
    await assert.rejects(lstat(secretFile), { code: 'ENOENT' });
    let native;
    const runtime = await createProviderRuntime({ environment: { LOCALAPPDATA: process.env.LOCALAPPDATA }, experimental: undefined, adapters: null,
      nativeZuku: (_d, ctx) => { native = ctx; return { capabilities: { stageInference: true }, runStage: async () => ({ output: {} }) }; } });
    // Provider selection writes public configuration before secret onboarding.
    // Its directory must already satisfy the same Windows SID-only boundary.
    await runtime.useProvider('openai');
    const key = 'fixture-own-provider-key-123456789';
    await runtime.authLogin('openai', { apiKey: key });
    assert.ok(!(await readFile(secretFile)).includes(Buffer.from(key)));
    assert.equal((await runtime.authList()).find(row => row.provider === 'openai').status, 'configured');
    const access = 'zuku_oa_' + 'a'.repeat(64);
    await saveZukuAccount({ access_token: access, refresh_token: 'zuku_or_' + 'b'.repeat(64), scope: [...GAME_SCOPES, NATIVE_GAME_SCOPE].join(' '), expires_at: Date.now() + 3600000 });
    await runtime.useProvider('zuku');
    await runtime.resolveStageProvider();
    assert.equal((await native.getCredentials()).accessToken, access);
    await runtime.authLogout('openai');
    assert.ok(!(await readFile(secretFile)).includes(Buffer.from(key)));
    await removeZukuAccount();
    await assert.rejects(native.getCredentials(), { code: 'ZUKU_LOGIN_REQUIRED' });
    console.log('actual-windows-provider-bridge PASS');
  `;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', program], { cwd: new URL('../', import.meta.url), env: { ...process.env, LOCALAPPDATA: appData }, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('Windows provider fixture timeout')); }, 90000);
    child.stdout.on('data', data => { output += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 && output.trim() === 'actual-windows-provider-bridge PASS' ? resolve() : reject(Error('Actual Windows provider bridge regression failed')); });
  });
});
