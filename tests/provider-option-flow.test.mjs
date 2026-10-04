// Isolated Core IPC and loopback providers only. No paid/live provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCoreHost, createCoreClient } from '../lib/agent-core/index.mjs';
import { run } from '../index.mjs';
import { validateRequest } from '../lib/agent-protocol/schema.mjs';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import create from '../commands/create.mjs';
import { createNativePrompter, requestAuth, openCore, createCoreProviderRuntime } from '../lib/cli-core-runtime.mjs';
import { normalizeConfig } from '../lib/provider-system/config-store.mjs';
import { createProviderRuntime } from '../lib/provider-system/runtime.mjs';
import { readProtectedStore } from '../lib/accounts/windows-protected-store.mjs';

const repo = new URL('../', import.meta.url);
const fixtureKey = 'fixture-process-only-key-123456';
const fixtureHeader = 'fixture-process-only-header-654321';

test('advanced provider fields round-trip through production CLI and Core instead of protocol gaps', async t => {
  const home = await mkdtemp(join(tmpdir(), 'zuku-option-flow-'));
  const stateDir = join(home, '.config/zukujs/core');
  const host = await startCoreHost({ home, stateDir, environment: {} });
  t.after(async () => { await host.close(); await rm(home, { recursive: true, force: true }); });
  const invoke = async args => {
    let out = '', err = '';
    const code = await run(args, { core: { stateDir, autostart: false }, stdout: { write(s) { out += s; } }, stderr: { write(s) { err += s; } } });
    assert.equal(code, 0, err);
    return JSON.parse(out).data;
  };
  const vertex = await invoke(['provider', 'configure', 'google-vertex', '--option', 'projectId=my-project-01', '--location', 'us-central1', '--option', 'maxOutputTokens=128', '--json']);
  assert.deepEqual(vertex.options, { project: 'my-project-01', location: 'us-central1', maxOutputTokens: 128 });
  const azure = await invoke(['provider', 'configure', 'azure', '--option', 'resourceName=zuku-fixture', '--option', 'deployment=game-deployment', '--option', 'apiVersion=preview', '--option', 'wire=chat', '--json']);
  assert.equal(azure.options.deployment, 'game-deployment');
  const bedrock = await invoke(['provider', 'configure', 'amazon-bedrock', '--region', 'us-east-1', '--option', 'profile=fixture', '--json']);
  assert.equal(bedrock.options.profile, 'fixture');
  await invoke(['provider', 'configure', 'openai', '--header-env', 'X-Org=ORG_ID', '--api-key-env', 'FIXTURE_API_KEY', '--json']);
  await invoke(['provider', 'configure', 'openai', '--clear-api-key-env', '--remove-header', 'X-Org', '--json']);
  const config = JSON.parse(await readFile(join(home, '.config/zukujs/providers/config.json'), 'utf8'));
  assert.deepEqual(config.providers['google-vertex'].options, vertex.options);
  assert.equal(config.providers.openai.apiKeyEnv, undefined);
  assert.equal(config.providers.openai.headers, undefined);
  await invoke(['provider', 'add', '--id', 'catalog-fixture', '--type', 'openai-chat', '--base-url', 'https://example.test', '--model', 'game-model', '--json']);
  const listing = await invoke(['model', 'list', '--provider', 'catalog-fixture', '--json']);
  assert.deepEqual(listing.discovery, { status: 'unsupported', fetchedAt: null });
  assert.equal(listing.models[0].inputCost, null); assert.equal(listing.models[0].outputCost, null);
  const info = await invoke(['model', 'info', 'catalog-fixture/game-model', '--json']);
  assert.deepEqual(info.discovery, listing.discovery);
});

test('real CLI processes, native secret sideband and killed/restarted Core preserve options into actual HTTP payload', { timeout: 30000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'zuku-provider-process-'));
  const stateDir = join(home, '.config/zukujs/core');
  const requests = [];
  let holdNext = false;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'game-model' }] })); return; }
    if (holdNext) { holdNext = false; return; } // A real in-flight HTTP request, terminated by the killed host.
    res.setHeader('content-type', 'text/event-stream');
    if (req.url.includes('streamGenerateContent')) res.end('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"message":"fixture"}' }] }, finishReason: 'STOP' }] }) + '\n\n');
    else res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"message":"fixture"}' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  await create(['my-game'], { cwd: home });
  const script = `
    import { startCoreHost } from ${JSON.stringify(new URL('lib/agent-core/index.mjs', repo).href)};
    import { createAdapter, listBuiltinDescriptors } from ${JSON.stringify(new URL('lib/provider-system/adapters/index.mjs', repo).href)};
    const home=process.argv[1], stateDir=process.argv[2], origin=process.argv[3];
    const host=await startCoreHost({home,stateDir,environment:{ORG_ID:'fixture-org'},coreOptions:{
      providerContext:{adapters:{listBuiltinDescriptors,createAdapter:(descriptor,context)=>createAdapter(descriptor,{...context,getCredentials:context.getCredentials,testOrigin:origin,googleAuth:{getAccessToken:async()=> 'fixture-google-access-token'}})}},
      operationRunner:async({provider},context)=>{
        try { await provider.runStage({stage:'design',instructions:'Return a fixture game design.',input:{game:true},outputSchema:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false},maxOutputBytes:1024,signal:context.signal}); } catch(error) { process.stderr.write('fixture_code='+error.code+'\\n'); throw error; }
        return {status:'completed'};
      }
    }});
    process.stdout.write('ready\\n');
    process.on('SIGTERM',async()=>{await host.close();process.exit(0)});
  `;
  let child, client, childDiagnostic = '';
  const start = async () => {
    child = spawn(process.execPath, ['--input-type=module', '-e', script, home, stateDir, origin], { stdio: ['ignore', 'pipe', 'pipe'], env: { HOME: home, PATH: process.env.PATH } });
    let err = ''; child.stderr.on('data', chunk => { err += chunk; childDiagnostic += chunk; });
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw new Error(`Fixture Core exited ${code}: ${err}`); })]);
    client = await createCoreClient({ stateDir, autostart: false });
  };
  t.after(async () => { client?.close(); if (child?.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const cli = async args => {
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('index.mjs', repo)), ...args, '--json'], { cwd: join(home, 'my-game'), env: { HOME: home, PATH: process.env.PATH, NO_COLOR: '1' }, timeout: 20000 }).catch(error => { error.message += childDiagnostic; throw error; });
    assert.ok(!result.stdout.includes(fixtureKey) && !result.stderr.includes(fixtureKey));
    return JSON.parse(result.stdout).data;
  };
  await start();
  await cli(['provider', 'add', '--id', 'fixture', '--type', 'openai-chat', '--base-url', `${origin}/v1`, '--model', 'game-model', '--header-env', 'X-Org=ORG_ID', '--header-secret', 'X-Signed', '--option', 'catalog=openai', '--option', 'outputTokens=64']);
  const core = await openCore({ coreClient: client });
  await requestAuth(core, { providerId: 'fixture', methodId: 'custom-api-key', experimental: true, headerNames: ['X-Signed'], includeApiKey: true, prompter: createNativePrompter({ stderr: { write() {} }, secret: async prompt => prompt.headerName ? fixtureHeader : fixtureKey }), intervalMs: 10 });
  await cli(['provider', 'configure', 'azure', '--option', 'resourceName=zuku-fixture', '--option', 'deployment=game-deployment', '--option', 'apiVersion=preview', '--option', 'wire=chat', '--option', 'maxOutputTokens=32']);
  await cli(['provider', 'configure', 'cloudflare-ai-gateway', '--option', 'accountId=' + 'a'.repeat(32), '--option', 'gatewayId=zuku-fixture', '--model', 'game-model', '--option', 'maxOutputTokens=16']);
  await cli(['provider', 'configure', 'google-vertex', '--option', 'projectId=my-project-01', '--location', 'us-central1', '--model', 'game-model', '--option', 'maxOutputTokens=8', '--header-env', 'X-Org=ORG_ID']);
  for (const [providerId, max] of [['deepinfra', 4], ['venice', 3], ['perplexity', 2]]) await cli(['provider', 'configure', providerId, '--model', 'game-model', '--option', `maxOutputTokens=${max}`]);
  for (const providerId of ['azure', 'cloudflare-ai-gateway', 'deepinfra', 'venice', 'perplexity']) await requestAuth(core, { providerId, methodId: 'api-key', prompter: createNativePrompter({ stderr: { write() {} }, secret: async () => fixtureKey }), intervalMs: 10 });
  const oldPid = child.pid;
  client.close(); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await start(); assert.notEqual(child.pid, oldPid);
  const listing = await cli(['provider', 'show', 'fixture']);
  assert.deepEqual(listing.options, { catalog: 'openai', maxOutputTokens: 64 });
  assert.equal(listing.auth.status, 'configured');
  for (const providerId of ['fixture', 'azure', 'cloudflare-ai-gateway', 'google-vertex', 'deepinfra', 'venice', 'perplexity']) {
    await cli(['provider', 'use', providerId]);
    const result = await cli(['agent', 'Add a jump mechanic to my ZUKU game', ...(providerId === 'fixture' ? ['--experimental'] : [])]);
    assert.equal(result.status, 'completed'); assert.equal(result.verified, false, 'mock inference is not a verified game');
  }
  const posts = requests.filter(request => request.body);
  assert.equal(posts.length, 7, 'exactly one inference per explicit provider, no replay/fallback');
  assert.deepEqual(posts.map(p => p.body.max_tokens ?? p.body.max_completion_tokens ?? p.body.generationConfig?.maxOutputTokens), [64, 32, 16, 8, 4, 3, 2]);
  assert.equal(posts[0].headers['x-org'], 'fixture-org'); assert.equal(posts[0].headers['x-signed'], fixtureHeader); assert.equal(posts[0].headers.authorization, `Bearer ${fixtureKey}`);
  assert.equal(posts[1].url, '/openai/v1/chat/completions?api-version=preview'); assert.equal(posts[1].body.model, 'game-deployment'); assert.equal(posts[1].headers['api-key'], fixtureKey);
  assert.equal(posts[2].url, `/v1/${'a'.repeat(32)}/zuku-fixture/compat/chat/completions`); assert.equal(posts[2].headers['cf-aig-authorization'], `Bearer ${fixtureKey}`);
  assert.equal(posts[3].url, '/v1/projects/my-project-01/locations/us-central1/publishers/google/models/game-model:streamGenerateContent?alt=sse'); assert.equal(posts[3].headers['x-goog-user-project'], 'my-project-01'); assert.equal(posts[3].headers['x-org'], 'fixture-org');
  assert.deepEqual(posts.slice(4).map(post => post.url), ['/v1/openai/chat/completions', '/api/v1/chat/completions', '/v1/sonar']);
  const config = await readFile(join(home, '.config/zukujs/providers/config.json'), 'utf8');
  assert.ok(!config.includes(fixtureKey) && !config.includes(fixtureHeader));
  const secretDir = join(home, '.config/zukujs/providers');
  const secretFile = process.platform === 'win32' ? join(secretDir, 'secrets.dpapi') : join(secretDir, 'secrets.json');
  const protectedText = process.platform === 'win32' ? await readProtectedStore(secretFile) : await readFile(secretFile, 'utf8');
  assert.equal(protectedText.includes(fixtureHeader), true);

  // Crash during inference: the durable request digest survives and reconnect
  // never restarts the uncertain model call or changes the selected provider.
  let currentCore = await openCore({ coreClient: client });
  const project = (await currentCore.call('project.list')).projects[0];
  const session = await currentCore.call('session.create', { projectHandle: project.projectHandle, modelAddress: 'fixture/game-model' });
  const input = { sessionId: session.sessionId, requestId: 'fixture_crash_input', operation: 'game.maintain', request: 'Add a jump mechanic to my ZUKU game', modelAddress: 'fixture/game-model', experimental: true };
  holdNext = true;
  const before = requests.filter(request => request.body).length;
  await currentCore.call('session.input', input);
  for (let tries = 0; requests.filter(request => request.body).length === before && tries < 200; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(requests.filter(request => request.body).length, before + 1);
  client.close(); const crashed = once(child, 'exit'); child.kill('SIGKILL'); await crashed;
  await start(); currentCore = await openCore({ coreClient: client });
  assert.equal((await currentCore.call('session.get', { sessionId: session.sessionId })).state, 'interrupted');
  assert.equal((await currentCore.call('session.input', input)).state, 'interrupted');
  await assert.rejects(currentCore.call('session.input', { ...input, request: 'Add a different jump to my ZUKU game' }), { code: 'REQUEST_CONFLICT' });
  const replay = [];
  for await (const event of client.subscribe({ sessionId: session.sessionId })) { replay.push(event); if (event.type === 'agent.error') break; }
  assert.equal(replay.at(-1).data.state, 'interrupted');
  assert.deepEqual(replay.map(event => event.sequence), replay.map((_, index) => index + 1));
  assert.equal(requests.filter(request => request.body).length, before + 1, 'replay and digest conflict dispatch zero new inferences');
});

test('version-1 persisted aliases migrate without losing state; option types and scope remain closed', () => {
  const config = normalizeConfig({ version: 1, providers: { 'google-vertex': { options: { projectId: 'my-project-01', location: 'global' } }, fixture: { custom: true, name: 'Fixture', apiType: 'anthropic-messages', baseUrl: 'https://example.test', options: { defaultMaxOutputTokens: 128 } } } });
  assert.deepEqual(config.providers['google-vertex'].options, { project: 'my-project-01', location: 'global' });
  assert.equal(config.providers.fixture.apiType, 'anthropic'); assert.equal(config.providers.fixture.options.maxOutputTokens, 128);
  assert.equal(normalizeConfig({ version: 1, providers: { 'amazon-bedrock': { options: { region: 'eusc-de-east-1' } } } }).providers['amazon-bedrock'].options.region, 'eusc-de-east-1');
  for (const options of [{ maxOutputTokens: '128' }, { maxOutputTokens: 0 }, { maxOutputTokens: 1000001 }, { profile: 'default' }, { resourceName: 'bad/path' }, { project: 'my-project-01', projectId: 'my-project-01' }]) assert.throws(() => normalizeConfig({ version: 1, providers: { openai: { options } } }), { code: 'PROVIDER_CONFIG_INVALID' });
});

test('adapter-only catalog registrations retain declared vendor environment references without secret projection', async t => {
  const home = await mkdtemp(join(tmpdir(), 'zuku-adapter-catalog-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const environment = { DEEPINFRA_API_KEY: fixtureKey, VENICE_API_KEY: fixtureKey, PERPLEXITY_API_KEY: fixtureKey };
  const runtime = await createProviderRuntime({ home, environment });
  const rows = await runtime.listProviders();
  for (const [id, envVar] of [['deepinfra', 'DEEPINFRA_API_KEY'], ['venice', 'VENICE_API_KEY'], ['perplexity', 'PERPLEXITY_API_KEY']]) {
    assert.deepEqual(runtime.providers.get(id).env, [envVar]);
    assert.equal(rows.find(row => row.id === id).auth.status, 'environment');
    assert.equal(rows.find(row => row.id === id).auth.envVar, envVar);
  }
  assert.ok(!JSON.stringify(rows).includes(fixtureKey));
});

test('provider RPC accepts canonical and legacy Anthropic aliases and only typed header references', () => {
  const envelope = config => ({ protocolVersion: 1, id: 'fixture', method: 'provider.add', params: { config } });
  for (const apiType of ['anthropic', 'anthropic-messages']) assert.doesNotThrow(() => validateRequest(envelope({ id: 'fixture', apiType, baseUrl: 'https://example.test', headers: { 'X-Org': { source: 'env', env: 'ORG_ID' }, 'X-Signed': { source: 'secret' } } }), { native: true }));
  for (const headers of [{ 'X-Key': 'raw-secret' }, { 'X-Key': { source: 'secret', value: 'raw-secret' } }, { Host: { source: 'env', env: 'HOST_NAME' } }]) assert.throws(() => validateRequest(envelope({ id: 'fixture', apiType: 'anthropic', baseUrl: 'https://example.test', headers }), { native: true }));
  for (const headerNames of [[null], [1], ['X-Key', 'x-key']]) {
    const request = { protocolVersion: 1, id: 'fixture', method: 'auth.request', params: { providerId: 'fixture', headerNames } };
    assert.throws(() => validateRequest(request, { native: true }), { code: 'INVALID_INPUT' });
  }
});

test('older Core capability negotiation rejects advanced patches before mutation and keeps legacy configuration', async () => {
  const calls = [];
  const core = { async call(method, params) { calls.push({ method, params }); return method === 'hello' ? { capabilities: [] } : { providers: [{ id: 'google-vertex' }] }; } };
  const runtime = await createCoreProviderRuntime(core);
  for (const patch of [{ options: { project: 'my-project-01' } }, { headers: { 'X-Key': { source: 'secret' } } }, { apiKeyEnv: null }]) assert.throws(() => runtime.configureProvider('google-vertex', patch), { code: 'CORE_PROTOCOL_GAP' });
  assert.equal(calls.filter(call => call.method === 'provider.configure').length, 0);
  await runtime.configureProvider('google-vertex', { options: { location: 'us-central1' } });
  assert.deepEqual(calls.find(call => call.method === 'provider.configure').params.patch, { options: { location: 'us-central1' } });
  await assert.rejects(requestAuth(core, { providerId: 'google-vertex', verify: true }), { code: 'CORE_PROTOCOL_GAP' });
  assert.equal(calls.filter(call => call.method === 'auth.request').length, 0);
});
