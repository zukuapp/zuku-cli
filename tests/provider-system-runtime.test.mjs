import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderRuntime } from '../lib/provider-system/index.mjs';

const OPENAI_KEY = 'sk-fixture-openai-' + 'x9'.repeat(12);
const ANTHROPIC_KEY = 'sk-ant-fixture-' + 'y8'.repeat(12);
const STAGE_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, model: { type: 'string', maxLength: 128 } }, required: ['ok', 'model'], additionalProperties: false };
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zuku-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Injected TEST DOUBLE for the protocol owner's ./adapters/index.mjs factory.
 * It performs no network I/O; it records what the core hands to adapters.
 */
function recordingAdapters({ models = [], fail, stageInference } = {}) {
  const calls = { create: [], list: 0, stage: [] };
  return {
    calls,
    listBuiltinDescriptors: () => [],
    createAdapter(descriptor, context) {
      calls.create.push({ descriptor, context });
      if (fail === 'create') throw Error(`remote said ${context.credentials?.apiKey}`);
      return {
        id: descriptor.id, capabilities: stageInference === undefined ? {} : { stageInference },
        async listModels() {
          calls.list++;
          if (fail === 'list') throw Error(`upstream 500 body ${context.credentials?.apiKey}`);
          return typeof models === 'function' ? models(descriptor) : models;
        },
        async validateAuth() { return { valid: true }; },
        async runStage(request) {
          calls.stage.push(request);
          return { provider: 'spoofed', stage: 'spoofed', output: { ok: true, model: request.model }, usage: { inputTokens: 3, outputTokens: 5, raw: 'header-x' }, experimental: false, unofficial: false };
        },
      };
    },
  };
}
const runtimeWith = (dir, extra = {}) => createProviderRuntime({ home: dir, environment: {}, experimental: undefined, legacyAuth: {}, adapters: null, ...extra });

test('discovery is dynamic, normalized, TTL-cached, refreshable and de-duplicated in flight', async t => {
  const dir = await home(t);
  let now = 1_000_000;
  const adapters = recordingAdapters({ models: [
    { id: 'gpt-a', name: 'GPT A', contextWindow: 128000, capabilities: { tools: true } },
    { id: 'gpt-b', contextWindow: -5, inputCost: 'free', name: 'bad\u0007name' },
    { id: '../escape' }, { id: 'other', provider: 'anthropic' }, { id: 'gpt-a' },
  ] });
  const runtime = await runtimeWith(dir, { adapters, environment: { OPENAI_API_KEY: OPENAI_KEY }, now: () => now });
  const [first, second] = await Promise.all([runtime.listModels({ provider: 'openai' }), runtime.listModels({ provider: 'openai' })]);
  assert.equal(adapters.calls.list, 1, 'concurrent lists share one discovery');
  assert.deepEqual(first.models.map(item => item.address), ['openai/gpt-a', 'openai/gpt-b']);
  assert.deepEqual(second.models.map(item => item.id), ['gpt-a', 'gpt-b']);
  const b = first.models[1];
  assert.deepEqual([b.name, b.contextWindow, b.inputCost, b.capabilities.vision], ['gpt-b', null, null, null]);
  assert.equal(first.models[0].capabilities.tools, true);
  assert.equal(first.discovery.status, 'fresh');
  assert.equal((await runtime.listModels({ provider: 'openai' })).discovery.status, 'cached');
  assert.equal(adapters.calls.list, 1);
  now += 16 * 60 * 1000;
  assert.equal((await runtime.listModels({ provider: 'openai' })).discovery.status, 'fresh');
  assert.equal(adapters.calls.list, 2);
  assert.equal((await runtime.listModels({ provider: 'openai', refresh: true })).discovery.status, 'fresh');
  assert.equal(adapters.calls.list, 3);
  const context = adapters.calls.create[0].context;
  assert.deepEqual(Object.keys(context).sort(), ['authMethod', 'fetch', 'signal']);
  assert.equal(Object.getOwnPropertyDescriptor(context, 'getCredentials').enumerable, false);
  assert.equal((await context.getCredentials()).apiKey, OPENAI_KEY);
  assert.equal(context.credentials.apiKey, OPENAI_KEY);
  assert.equal(JSON.stringify(adapters.calls.create[0].descriptor).includes(OPENAI_KEY), false, 'descriptor carries no secrets');
});

test('discovery failures stay safe: fixed codes, stale cache, configured models still listed', async t => {
  const dir = await home(t);
  let now = 5_000_000;
  const good = recordingAdapters({ models: [{ id: 'cached-model' }] });
  const initial = await runtimeWith(dir, { adapters: good, now: () => now });
  await initial.authLogin('openai', { apiKey: OPENAI_KEY });
  await initial.listModels({ provider: 'openai' });
  now += 60 * 60 * 1000;
  const failing = recordingAdapters({ fail: 'list' });
  const runtime = await runtimeWith(dir, { adapters: failing, now: () => now });
  await runtime.configureProvider('openai', { addModels: [{ id: 'my-pinned', contextWindow: 4096 }] });
  const listing = await runtime.listModels({ provider: 'openai' });
  assert.equal(listing.discovery.status, 'stale'); assert.equal(listing.discovery.error, 'MODEL_DISCOVERY_FAILED');
  assert.deepEqual(listing.models.map(item => [item.id, item.source]), [['my-pinned', 'configured'], ['cached-model', 'discovered']]);
  assert.equal(JSON.stringify(listing).includes(OPENAI_KEY), false);
  const none = await runtimeWith(await home(t), { adapters: null });
  const unavailable = await none.listModels({ provider: 'groq' });
  assert.deepEqual([unavailable.models, unavailable.discovery.status, unavailable.discovery.error], [[], 'unavailable', 'AUTH_REQUIRED']);
  await assert.rejects(none.useModel('groq/llama-guess'), { code: 'MODEL_UNAVAILABLE' });
  await assert.rejects(none.modelInfo('groq/llama-guess'), { code: 'MODEL_UNAVAILABLE' });
});

test('default is zuku/auto; native stage inference is unavailable and NEVER falls back to an external provider', async t => {
  const dir = await home(t);
  const adapters = recordingAdapters({ stageInference: false });
  const runtime = await runtimeWith(dir, { adapters, environment: { OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY }, readZukuToken: async () => undefined });
  assert.equal(runtime.activeModel, 'zuku/auto');
  await assert.rejects(runtime.resolveStageProvider(), { code: 'NATIVE_STAGE_UNAVAILABLE' });
  assert.deepEqual(adapters.calls.create.map(call => call.descriptor.id), ['zuku']);
  assert.equal(adapters.calls.create[0].context.credentials.type, 'zuku-account');
  assert.equal(JSON.stringify(adapters.calls.create[0].context.credentials).includes(OPENAI_KEY), false);
  const noAdapters = await runtimeWith(await home(t), { adapters: null, environment: { OPENAI_API_KEY: OPENAI_KEY } });
  await assert.rejects(noAdapters.resolveStageProvider(), { code: 'NATIVE_STAGE_UNAVAILABLE' });
  const injected = await runtimeWith(await home(t), { adapters,
    zukuAccountClient: { ensureFresh: async () => ({ generation: 'fixture-native-account', accessToken: 'zuku_oa_' + 'a'.repeat(64), scopes: ['games:generate'] }) },
    nativeZuku: async () => ({ capabilities: { stageInference: false }, listModels: async () => [], runStage: async () => { throw Error('must not run'); } }) });
  await assert.rejects(injected.resolveStageProvider(), { code: 'NATIVE_STAGE_UNAVAILABLE' });
  await assert.rejects(injected.resolveStageProvider({ model: 'zuku/fast-guess' }), { code: 'MODEL_NOT_FOUND' });
});

test('selected provider/model binds runStage; credentials scoped; secrets in model input are refused', async t => {
  const dir = await home(t);
  const adapters = recordingAdapters({ models: [{ id: 'gpt-stage' }] });
  const runtime = await runtimeWith(dir, { adapters, environment: { OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY } });
  await runtime.useModel('openai/gpt-stage');
  const client = await runtime.resolveStageProvider();
  assert.deepEqual([client.provider, client.model, client.modelId, client.experimental, client.unofficial], ['openai', 'openai/gpt-stage', 'gpt-stage', false, false]);
  const result = await client.runStage({ stage: 'design', instructions: 'Make a ZUKU game plan', input: { brief: 'jump game' }, outputSchema: STAGE_SCHEMA, maxOutputBytes: 1000 });
  assert.deepEqual(result, { provider: 'openai', stage: 'design', model: 'openai/gpt-stage', output: { ok: true, model: 'gpt-stage' }, usage: { inputTokens: 3, outputTokens: 5 }, experimental: false, unofficial: false });
  const sent = adapters.calls.stage.at(-1);
  assert.equal(sent.model, 'gpt-stage');
  assert.equal(JSON.stringify(sent).includes(OPENAI_KEY), false);
  for (const call of adapters.calls.create) assert.equal(JSON.stringify(call.context.credentials).includes(ANTHROPIC_KEY), false, 'only the selected provider credential is resolved');
  const before = adapters.calls.stage.length;
  await assert.rejects(client.runStage({ stage: 'design', instructions: `use key ${OPENAI_KEY}`, input: {} }), { code: 'CREDENTIAL_IN_MODEL_INPUT' });
  assert.equal(adapters.calls.stage.length, before);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(client.runStage({ stage: 'design', input: {}, signal: aborted.signal }), { code: 'COMMAND_CANCELLED' });
  await runtime.setEnabled('anthropic', false);
  await assert.rejects(runtime.resolveStageProvider({ model: 'anthropic/claude-x' }), { code: 'PROVIDER_DISABLED' });
  await assert.rejects(runtime.setEnabled('openai', false), { code: 'PROVIDER_ACTIVE' });
});

test('experimental status derives from auth metadata: Codex is (exp!) even if the adapter claims otherwise', async t => {
  const dir = await home(t);
  const adapters = recordingAdapters({ models: [{ id: 'gpt-codex' }] });
  const runtime = await runtimeWith(dir, { adapters, experimental: { CODEX_AUTH_METHOD: { id: 'codex-oauth', name: 'Codex OAuth', official: true, experimental: false } } });
  const codex = (await runtime.listProviders()).find(row => row.id === 'codex');
  assert.deepEqual(codex.authMethods.map(item => [item.official, item.experimental]), [[false, true]]);
  await runtime.configureProvider('codex', { addModels: [{ id: 'gpt-codex' }] });
  await runtime.useModel('codex/gpt-codex');
  const client = await runtime.resolveStageProvider();
  assert.deepEqual([client.experimental, client.unofficial], [true, true]);
  const result = await client.runStage({ stage: 'build', input: {}, outputSchema: STAGE_SCHEMA, maxOutputBytes: 1000 });
  assert.deepEqual([result.experimental, result.unofficial], [true, true]);
  await assert.rejects(runtime.authLogin('codex'), { code: 'AUTH_EXPERIMENTAL_OPT_IN' });
  const official = (await runtime.listProviders()).filter(row => ['openai', 'anthropic', 'amazon-bedrock', 'google-vertex', 'ollama', 'zuku'].includes(row.id));
  for (const row of official) assert.equal(row.authMethods.some(item => item.experimental), false, row.id);
});

test('endpoint, option and adapter errors are validated by core before/around the factory without leaks', async t => {
  const dir = await home(t);
  const adapters = recordingAdapters({ fail: 'create' });
  const runtime = await runtimeWith(dir, { adapters, environment: { OPENAI_API_KEY: OPENAI_KEY } });
  await assert.rejects(runtime.configureProvider('openai', { baseUrl: 'https://evil.test/v1' }), { code: 'PROVIDER_ENDPOINT_FIXED' });
  await assert.rejects(runtime.configureProvider('azure', { baseUrl: 'https://evil.test/openai/v1' }), { code: 'PROVIDER_ENDPOINT_REJECTED' });
  await assert.rejects(runtime.configureProvider('azure', { baseUrl: 'http://127.0.0.1:1/openai/v1' }), { code: 'PROVIDER_ENDPOINT_REJECTED' });
  await runtime.configureProvider('azure', { baseUrl: 'https://my-res.openai.azure.com/openai/v1' });
  await assert.rejects(runtime.configureProvider('amazon-bedrock', { options: { region: 'us-east-1; rm -rf' } }), { code: 'PROVIDER_CONFIG_INVALID' });
  await assert.rejects(runtime.configureProvider('openai', { options: { region: 'us-east-1' } }), { code: 'PROVIDER_CONFIG_INVALID' });
  await runtime.configureProvider('amazon-bedrock', { addModels: [{ id: 'anthropic.claude-v2:1' }] });
  const before = adapters.calls.create.length;
  await assert.rejects(runtime.resolveStageProvider({ model: 'amazon-bedrock/anthropic.claude-v2:1' }), { code: 'PROVIDER_OPTION_REQUIRED' });
  assert.equal(adapters.calls.create.length, before, 'factory not reached without required region');
  await runtime.configureProvider('amazon-bedrock', { options: { region: 'us-east-1' } });
  const error = await runtime.resolveStageProvider({ model: 'amazon-bedrock/anthropic.claude-v2:1' }).catch(caught => caught);
  assert.equal(error.code, 'ADAPTER_UNAVAILABLE');
  assert.equal(adapters.calls.create.at(-1).context.credentials.type, 'cloud-chain');
  const listing = await runtime.listModels({ provider: 'openai' });
  assert.equal(JSON.stringify(listing).includes(OPENAI_KEY), false);
  assert.equal(listing.discovery.error, 'ADAPTER_UNAVAILABLE');
  await mkdir(join(dir, '.config', 'zukujs', 'providers'), { recursive: true });
  await writeFile(join(dir, '.config', 'zukujs', 'providers', 'config.json'), JSON.stringify({ version: 1, providers: { bad: { custom: true, name: 'Bad', apiType: 'openai-chat', baseUrl: 'https://u:p@evil.test/v1' } } }), { mode: 0o600 });
  await assert.rejects(runtimeWith(dir, { adapters }), { code: 'PROVIDER_ENDPOINT_REJECTED' });
});

test('custom provider headers resolve from secure store/env only and reach only that adapter', async t => {
  const dir = await home(t);
  const adapters = recordingAdapters({ models: [{ id: 'm1' }] });
  const runtime = await runtimeWith(dir, { adapters, environment: { ORG_HEADER: 'org-123' } });
  await runtime.addProvider({ id: 'local-ai', name: 'Local AI', apiType: 'openai-responses', baseUrl: 'http://127.0.0.1:8000/v1', model: 'm1', headers: { 'X-Org': { source: 'env', env: 'ORG_HEADER' }, 'X-Signed': { source: 'secret' } } });
  await assert.rejects(runtime.useModel('local-ai/m1').then(() => runtime.resolveStageProvider()), { code: 'AUTH_REQUIRED' });
  await runtime.authLogin('local-ai', { headers: { 'X-Signed': 'sig-value-123456' } });
  const client = await runtime.resolveStageProvider();
  assert.deepEqual([client.experimental, client.unofficial], [true, true], 'unknown custom endpoint authentication is experimental and unofficial');
  const context = adapters.calls.create.at(-1).context;
  assert.deepEqual({ ...context.credentials.headers }, { 'X-Org': 'org-123', 'X-Signed': 'sig-value-123456' });
  assert.deepEqual(adapters.calls.create.at(-1).descriptor.options.headerNames, ['X-Org', 'X-Signed']);
  await assert.rejects(runtime.authLogin('local-ai', { headers: { 'X-Unknown': 'v' } }), { code: 'AUTH_SECRET_INVALID' });
  await assert.rejects(client.runStage({ stage: 'x', input: 'sig-value-123456' }), { code: 'CREDENTIAL_IN_MODEL_INPUT' });
  const removed = await runtime.removeProvider('local-ai');
  assert.deepEqual([removed.activeReset, removed.active.model], [true, 'zuku/auto']);
  await assert.rejects(runtime.removeProvider('openai'), { code: 'PROVIDER_BUILTIN_PROTECTED' });
});
