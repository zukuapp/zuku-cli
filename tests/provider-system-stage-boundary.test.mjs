import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderRuntime } from '../lib/provider-system/index.mjs';
import { AdapterError } from '../lib/provider-system/adapters/errors.mjs';
import { CommandError } from '../lib/errors.mjs';

const KEY = 'fixture-stage-key-123456789';
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const request = extra => ({ stage: 'design', instructions: 'Return a validated game plan as JSON.', input: {}, outputSchema: SCHEMA, maxOutputBytes: 1000, ...extra });
async function fixture(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zuku-stage-boundary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return createProviderRuntime({ home: dir, environment: { OPENAI_API_KEY: KEY }, experimental: undefined, legacyAuth: {}, ...extra });
}
function factory(runStage, extra = {}) {
  return { listBuiltinDescriptors: () => [], createAdapter: (_descriptor, context) => ({
    capabilities: { stageInference: true }, listModels: async () => [{ id: 'model' }],
    runStage: input => runStage(input, context), ...extra,
  }) };
}

test('finite schema admission and async host checks happen before paid stage inference', async t => {
  let count = 0, admission = 0;
  const runtime = await fixture(t, { adapters: factory(async () => { count++; return { output: { ok: true } }; }),
    stageSchema: { admit: async () => { admission++; await Promise.resolve(); return false; } } });
  const client = await runtime.resolveStageProvider({ model: 'openai/model' });
  for (const schema of [undefined, { type: 'string', pattern: '(a|aa)+$' }, { $ref: 'https://untrusted.invalid/schema' }]) {
    await assert.rejects(client.runStage(request({ outputSchema: schema })), { code: 'STAGE_SCHEMA_REJECTED' });
  }
  assert.equal(admission, 0, 'a custom validator cannot bypass baseline finite schema admission');
  await assert.rejects(client.runStage(request()), { code: 'STAGE_SCHEMA_REJECTED' });
  assert.equal(admission, 1); assert.equal(count, 0);
});

test('wrong/oversized result and async output veto abort the same inference without finish events', async t => {
  for (const kind of ['schema', 'size', 'host']) {
    let inferenceSignal, count = 0;
    const seen = [];
    const runtime = await fixture(t, { adapters: factory(async input => {
      count++; inferenceSignal = input.signal;
      await input.onEvent({ type: 'finish', reason: 'completed' });
      return { output: kind === 'schema' ? { ok: 'wrong' } : kind === 'size' ? { ok: true, overflow: 'x'.repeat(1001) } : { ok: true } };
    }), stageSchema: { validate: async () => kind !== 'host' } });
    const client = await runtime.resolveStageProvider({ model: 'openai/model' });
    await assert.rejects(client.runStage(request({ onEvent: event => seen.push(event) })), { code: 'STAGE_OUTPUT_INVALID' });
    assert.equal(count, 1); assert.equal(inferenceSignal.aborted, true); assert.deepEqual(seen, []);
  }
});

test('genuine adapter auth/quota/native recovery codes preserve only recreated safe fields', async t => {
  for (const code of ['PROVIDER_AUTH_FAILED', 'PROVIDER_RATE_LIMITED', 'NATIVE_OUTCOME_UNCERTAIN', 'NATIVE_RESULT_EXPIRED']) {
    const error = new AdapterError(code, { status: 429 });
    error.message = KEY; error.stack = KEY; error.headers = { secret: KEY }; error.body = KEY;
    const runtime = await fixture(t, { adapters: factory(async () => { throw error; }) });
    const client = await runtime.resolveStageProvider({ model: 'openai/model' });
    const caught = await client.runStage(request()).catch(value => value);
    assert.ok(caught instanceof CommandError); assert.equal(caught.code, code); assert.equal(caught.status, 429);
    assert.ok(!JSON.stringify(caught).includes(KEY)); assert.ok(!caught.message.includes(KEY));
    assert.equal(Object.hasOwn(caught, 'headers'), false); assert.equal(Object.hasOwn(caught, 'body'), false);
  }
  const runtime = await fixture(t, { adapters: factory(async () => { throw { code: 'NATIVE_OUTCOME_UNCERTAIN', message: KEY, name: 'ZukuProviderAdapterError' }; }) });
  const client = await runtime.resolveStageProvider({ model: 'openai/model' });
  await assert.rejects(client.runStage(request()), { code: 'ADAPTER_INVALID' });
});

test('native admission binds protected account generation while same-account token rotation works', async t => {
  let generation = 'fixture-account-a', token = 'zuku_oa_' + 'a'.repeat(64), calls = 0, credentials;
  const runtime = await fixture(t, { environment: { ZUKU_ACCESS_TOKEN: 'legacy-is-ignored' }, adapters: null,
    readZukuToken: async () => { throw Error('legacy lookup forbidden'); },
    zukuAccountClient: { ensureFresh: async options => {
      assert.equal(options.requiredScope, 'games:generate');
      return { generation, accessToken: token, scopes: ['games:generate'] };
    } }, nativeZuku: (_descriptor, context) => {
      credentials = context;
      return { capabilities: { stageInference: true }, runStage: async () => { calls++; await context.getCredentials(); return { output: { ok: true } }; } };
    } });
  const client = await runtime.resolveStageProvider();
  token = 'zuku_oa_' + 'b'.repeat(64);
  assert.equal((await credentials.getCredentials()).accessToken, token);
  await client.runStage(request()); assert.equal(calls, 1);
  generation = 'fixture-account-b';
  await assert.rejects(client.runStage(request()), { code: 'AUTH_SESSION_CHANGED' });
  assert.equal(calls, 1);
});

test('cloud chain configuration uses canonical kind and never persists a catalog across account operations', async t => {
  let context, catalogs = 0;
  const runtime = await fixture(t, { environment: {}, adapters: { listBuiltinDescriptors: () => [], createAdapter: (_d, ctx) => {
    context = ctx; return { listModels: async () => [{ id: `account-model-${++catalogs}` }], runStage: async () => ({ output: { ok: true } }) };
  } } });
  await runtime.configureProvider('amazon-bedrock', { options: { region: 'us-east-1' } });
  await runtime.listModels({ provider: 'amazon-bedrock' });
  assert.deepEqual(await context.getCredentials(), { kind: 'cloud-chain', configuration: { chain: 'aws', region: 'us-east-1' } });
  await runtime.listModels({ provider: 'amazon-bedrock' });
  assert.equal(catalogs, 2, 'an implicit AWS chain account must be re-resolved rather than reuse another account catalog');
});

test('actual Codex adapter wraps scoped OAuth and streams the single original inference', async t => {
  let inferences = 0, tokens = 0;
  const seen = [], text = JSON.stringify({ ok: true });
  const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
  const oauth = { getAccessToken: async ({ experimental }) => { assert.equal(experimental, true); tokens++; return 'fixture-own-codex-access'; }, status: async () => ({ experimentalAccepted: true, authenticated: true }) };
  const runtime = await fixture(t, { codexOAuth: oauth, fetch: async (_url, init) => {
    inferences++; assert.equal(init.headers.authorization, 'Bearer fixture-own-codex-access');
    return new Response(event({ type: 'response.output_text.delta', delta: text }) + event({ type: 'response.completed', response: {
      status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 2, output_tokens: 4 },
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  await runtime.configureProvider('codex', { addModels: [{ id: 'fixture-model' }] });
  const client = await runtime.resolveStageProvider({ model: 'codex/fixture-model' });
  const result = await client.runStage(request({ onEvent: event => seen.push(event) }));
  assert.equal(inferences, 1); assert.equal(tokens, 1); assert.deepEqual(result.output, { ok: true });
  assert.deepEqual([result.experimental, result.unofficial], [true, true]);
  assert.equal(seen.filter(event => event.type === 'text-delta').map(event => event.text).join(''), text);
  assert.equal(seen.filter(event => event.type === 'finish').length, 1, 'CORE never synthesizes a duplicate finish');
});

test('Codex admitted client rejects an independently switched own OAuth account before network use', async t => {
  let active = 'a'.repeat(64), inferences = 0;
  const oauth = { status: async () => ({ authenticated: true, experimentalAccepted: true, accounts: [{ accountId: active, active: true }] }),
    getAccessToken: async () => 'fixture-own-codex-access' };
  const runtime = await fixture(t, { codexOAuth: oauth, fetch: async () => { inferences++; throw Error('must not fetch'); } });
  await runtime.configureProvider('codex', { addModels: [{ id: 'fixture-model' }] });
  const client = await runtime.resolveStageProvider({ model: 'codex/fixture-model' });
  active = 'b'.repeat(64);
  await assert.rejects(client.runStage(request()), { code: 'AUTH_SESSION_CHANGED' });
  assert.equal(inferences, 0);
});

test('Cloudflare config accepts only finite official routing IDs and constructs the actual gateway request', async t => {
  let requests = 0;
  const runtime = await fixture(t, { environment: { CLOUDFLARE_API_TOKEN: KEY }, fetch: async (url, init) => {
    requests++; assert.equal(url, 'https://gateway.ai.cloudflare.com/v1/' + 'a'.repeat(32) + '/fixture-gateway/compat/chat/completions');
    assert.equal(init.headers.get('cf-aig-authorization'), `Bearer ${KEY}`);
    const text = JSON.stringify({ ok: true });
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n'
      + 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n'
      + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  await runtime.configureProvider('cloudflare-ai-gateway', { addModels: [{ id: 'fixture-model' }] });
  await assert.rejects(runtime.resolveStageProvider({ model: 'cloudflare-ai-gateway/fixture-model' }), { code: 'PROVIDER_OPTION_REQUIRED' });
  for (const options of [{ accountId: '../escape' }, { accountId: 'A'.repeat(32) }, { gatewayId: 'unsafe/path' }, { gatewayId: 'x'.repeat(65) }]) {
    await assert.rejects(runtime.configureProvider('cloudflare-ai-gateway', { options }), { code: 'PROVIDER_CONFIG_INVALID' });
  }
  await assert.rejects(runtime.configureProvider('openai', { options: { accountId: 'a'.repeat(32) } }), { code: 'PROVIDER_CONFIG_INVALID' });
  await runtime.configureProvider('cloudflare-ai-gateway', { options: { accountId: 'a'.repeat(32), gatewayId: 'fixture-gateway' } });
  const client = await runtime.resolveStageProvider({ model: 'cloudflare-ai-gateway/fixture-model' });
  assert.deepEqual((await client.runStage(request())).output, { ok: true });
  assert.equal(requests, 1);
});
