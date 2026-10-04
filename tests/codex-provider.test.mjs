import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, lstat, symlink, link, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createCodexOAuth, CODEX_ENDPOINTS, CODEX_SCOPES } from '../lib/providers/codex-oauth.mjs';
import { createCodexResponsesProvider, CODEX_RESPONSES_URL, validateStageSchema } from '../lib/providers/codex-responses.mjs';
import { ProviderError } from '../lib/provider-errors.mjs';
import loginCodex from '../commands/login-codex.mjs';
import { run } from '../index.mjs';

// Real signature verification against fixture JWKS; no live OpenAI credentials or calls.
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), alg: 'RS256', use: 'sig', kid: 'fixture-key' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = code => error => error instanceof ProviderError && error.code === code;
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zukujs-codex-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const storePath = path.join(dir, 'private', 'codex.json');
  const time = { ms: Date.now() };
  const state = { exchanges: 0, refreshes: 0, jwks: 0, urls: [], tokenOptions: {}, refreshOptions: {} };
  async function identity(client, nonce, overrides = {}) {
    const claims = { iss: 'https://auth.openai.com', aud: client, sub: 'fixture-subject', iat: Math.floor(time.ms / 1000), exp: Math.floor(time.ms / 1000) + 3600, nonce, ...overrides };
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).sign(privateKey);
  }
  async function fetchImpl(url, init) {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    if (url === CODEX_ENDPOINTS.jwks) { state.jwks++; return options.jwksResponse?.() || json({ keys: [jwk] }); }
    assert.equal(url, CODEX_ENDPOINTS.token);
    assert.equal(init.method, 'POST');
    const form = init.body;
    assert.ok(form instanceof URLSearchParams);
    assert.equal(form.get('resource'), CODEX_ENDPOINTS.resource);
    if (form.get('grant_type') === 'authorization_code') {
      state.exchanges++;
      const auth = state.urls.at(-1);
      assert.equal(form.get('client_id'), state.callbackClient || 'oaiapp_fixture');
      assert.equal(form.get('redirect_uri'), auth.searchParams.get('redirect_uri'));
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), auth.searchParams.get('code_challenge'));
      let idToken = await identity(form.get('client_id'), auth.searchParams.get('nonce'), options.claims || {});
      if (options.tamperSignature) { const pieces = idToken.split('.'); pieces[2] = (pieces[2][0] === 'A' ? 'B' : 'A') + pieces[2].slice(1); idToken = pieces.join('.'); }
      const data = { access_token: 'fixture-access-1', refresh_token: 'fixture-refresh-1', id_token: idToken, token_type: 'Bearer', expires_in: 3600, scope: CODEX_SCOPES.join(' '), ...state.tokenOptions };
      return options.tokenResponse?.(data) || json(data);
    }
    state.refreshes++;
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('scope'), null);
    assert.equal(form.get('client_id'), 'oaiapp_fixture');
    assert.equal(form.get('refresh_token'), 'fixture-refresh-1');
    if (options.refreshDelay) await new Promise(resolve => setTimeout(resolve, options.refreshDelay));
    return options.refreshResponse?.() || json({ access_token: 'fixture-access-2', refresh_token: 'fixture-refresh-2', token_type: 'Bearer', expires_in: 3600, scope: CODEX_SCOPES.join(' '), ...state.refreshOptions });
  }
  const oauth = createCodexOAuth({ storePath, fetchImpl, now: () => time.ms, authorizationTimeoutMs: options.timeoutMs || 1000, lockTimeoutMs: process.platform === 'win32' ? 30000 : 1000 });
  async function onAuthorizationUrl(value) {
    const auth = new URL(value); state.urls.push(auth);
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state'));
    callback.searchParams.set('code', 'fixture-code');
    const suppliedClient = options.callbackClient === undefined ? 'oaiapp_fixture' : options.callbackClient;
    if (suppliedClient !== null) { callback.searchParams.set('client_id', suppliedClient); state.callbackClient = suppliedClient; }
    await options.beforeCallback?.({ auth, callback, oauth, state });
    if (options.denied) { callback.searchParams.delete('code'); callback.searchParams.set('error', 'access_denied'); }
    const response = await fetch(callback, { redirect: 'error' });
    state.callbackStatus = response.status;
    await response.text();
  }
  return { dir, storePath, oauth, state, time, fetchImpl, identity, onAuthorizationUrl,
    login: extra => oauth.login({ experimental: true, onAuthorizationUrl, ...extra }) };
}

test('own OSS registration uses issued client, pinned endpoints, PKCE/state/nonce and private store', async t => {
  const f = await fixture(t);
  const result = await f.login();
  assert.deepEqual(Object.keys(result).sort(), ['accountId', 'authenticated', 'experimental', 'provider', 'unofficial']);
  assert.equal(result.authenticated, true);
  const auth = f.state.urls[0];
  assert.equal(auth.origin + auth.pathname, CODEX_ENDPOINTS.authorize);
  assert.equal(auth.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(auth.searchParams.get('agent_name_hint'), 'zukujs');
  assert.match(auth.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(['state', 'nonce', 'code_challenge'].every(k => auth.searchParams.get(k).length >= 43));
  const redirect = new URL(auth.searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, '127.0.0.1'); assert.equal(redirect.pathname, '/auth/callback');
  assert.equal(auth.searchParams.get('id_token_hint'), null);
  assert.equal(f.state.exchanges, 1); assert.equal(f.state.jwks, 1);
  const status = await f.oauth.status({ experimental: true });
  assert.equal(status.experimentalAccepted, true); assert.equal(status.authenticated, true);
  assert.ok(!JSON.stringify(result).includes('fixture-access'));
  assert.ok(!JSON.stringify(status).includes('fixture-subject'));
  if (process.platform !== 'win32') {
    assert.equal((await lstat(path.dirname(f.storePath))).mode & 0o777, 0o700);
    assert.equal((await lstat(f.storePath)).mode & 0o777, 0o600);
  } else assert.ok(!(await readFile(f.storePath)).includes(Buffer.from('fixture-access')));
});

test('returning account uses issued client and stable host, verifies selected subject', async t => {
  const f = await fixture(t);
  const first = await f.login();
  await f.login({ accountId: first.accountId });
  assert.equal(f.state.urls[1].searchParams.get('client_id'), 'oaiapp_fixture');
  assert.equal(f.state.urls[1].searchParams.get('agent_name_hint'), null);
  assert.equal(f.state.urls[1].searchParams.get('ext_agent_host_id'), f.state.urls[0].searchParams.get('ext_agent_host_id'));
  assert.notEqual(f.state.urls[1].searchParams.get('state'), f.state.urls[0].searchParams.get('state'));
});

test('wrong state is rejected without consuming valid callback; denial exchanges no code', async t => {
  const f = await fixture(t, { beforeCallback: async ({ callback }) => {
    const wrong = new URL(callback); wrong.searchParams.set('state', 'forged');
    assert.equal((await fetch(wrong)).status, 400);
    const duplicate = new URL(callback); duplicate.searchParams.append('code', 'duplicate');
    assert.equal((await fetch(duplicate)).status, 400);
    const pathWrong = new URL(callback); pathWrong.pathname = '/other';
    assert.equal((await fetch(pathWrong)).status, 404);
  } });
  await f.login();
  const denied = await fixture(t, { denied: true });
  await assert.rejects(denied.login(), fail('CODEX_AUTH_DENIED'));
  assert.equal(denied.state.exchanges, 0);
});

for (const callbackClient of [null, 'dynamic_agent_client', 'bad client']) {
  test(`new registration rejects absent or invalid callback client: ${callbackClient ?? 'absent'}`, async t => {
    const f = await fixture(t, { callbackClient });
    await assert.rejects(f.login(), fail('CODEX_AUTH_RESPONSE_INVALID'));
    assert.equal(f.state.exchanges, 0);
  });
}

for (const [name, opts] of [
  ['signature', { tamperSignature: true }], ['nonce', { claims: { nonce: 'wrong' } }],
  ['audience', { claims: { aud: 'wrong-client' } }], ['issuer', { claims: { iss: 'https://evil.invalid' } }],
  ['expired', { claims: { exp: 1 } }], ['future issued', { claims: { iat: 9999999999 } }],
  ['multiple audience without authorized party', { claims: { aud: ['oaiapp_fixture', 'other'] } }],
]) {
  test(`OIDC rejects ${name} and never persists response credentials`, async t => {
    const f = await fixture(t, opts);
    await assert.rejects(f.login(), fail('CODEX_IDENTITY_INVALID'));
    assert.equal((await f.oauth.status({ experimental: true })).authenticated, false);
    assert.ok(!(await readFile(f.storePath)).includes(Buffer.from('fixture-access')));
  });
}

test('returning selected account cannot replace credentials with another signed subject/client', async t => {
  const opts = {}, f = await fixture(t, opts), first = await f.login();
  opts.claims = { sub: 'other-subject' };
  await assert.rejects(f.login({ accountId: first.accountId }), fail('CODEX_IDENTITY_INVALID'));
  assert.equal(await f.oauth.getAccessToken({ experimental: true }), 'fixture-access-1');
  opts.claims = {}; opts.callbackClient = 'oaiapp_other';
  const exchanges = f.state.exchanges;
  await assert.rejects(f.login({ accountId: first.accountId }), fail('CODEX_AUTH_RESPONSE_INVALID'));
  assert.equal(f.state.exchanges, exchanges);
});

test('returning callback may omit issued client without changing registration', async t => {
  const opts = {}, f = await fixture(t, opts), first = await f.login();
  opts.callbackClient = null;
  await f.login({ accountId: first.accountId });
  assert.equal(f.state.exchanges, 2);
});

test('missing plan scope and malformed/redirected token responses fail without raw errors', async t => {
  for (const [tokenOptions, tokenResponse, code] of [
    [{ scope: 'openid offline_access resource.invoke' }, undefined, 'CODEX_AUTH_DENIED'],
    [{ refresh_token: undefined }, undefined, 'CODEX_AUTH_RESPONSE_INVALID'],
    [{ token_type: 'not-bearer' }, undefined, 'CODEX_AUTH_RESPONSE_INVALID'],
    [{ expires_in: -1 }, undefined, 'CODEX_AUTH_RESPONSE_INVALID'],
    [{}, () => new Response('private-response', { status: 302, headers: { location: 'https://evil.invalid' } }), 'CODEX_AUTH_RESPONSE_INVALID'],
    [{}, () => new Response('private-response', { headers: { 'content-type': 'text/html' } }), 'CODEX_AUTH_RESPONSE_INVALID'],
  ]) {
    const f = await fixture(t, { tokenResponse }); f.state.tokenOptions = tokenOptions;
    await assert.rejects(f.login(), e => { assert.ok(!e.message.includes('private-response')); return fail(code)(e); });
  }
});

test('refresh rotation is serialized across instances and atomically replaces latest credentials', async t => {
  const f = await fixture(t, { refreshDelay: 30 }); await f.login(); f.time.ms += 3550000;
  const other = createCodexOAuth({ storePath: f.storePath, fetchImpl: f.fetchImpl, now: () => f.time.ms, lockTimeoutMs: process.platform === 'win32' ? 30000 : 1000 });
  assert.deepEqual(await Promise.all([f.oauth.getAccessToken({ experimental: true }), other.getAccessToken({ experimental: true })]), ['fixture-access-2', 'fixture-access-2']);
  assert.equal(f.state.refreshes, 1);
  if (process.platform !== 'win32') {
    const stored = JSON.parse(await readFile(f.storePath));
    assert.equal(stored.accounts[0].refreshToken, 'fixture-refresh-2');
    assert.equal(stored.accounts[0].accessToken, 'fixture-access-2');
    assert.equal((await readdir(path.dirname(f.storePath))).length, 1);
  }
});

test('failed refresh preserves old protected credentials and does not retry/fallback', async t => {
  const f = await fixture(t, { refreshResponse: () => json({ error: 'invalid_grant', secret: 'private-response' }, 400) });
  await f.login(); const before = await readFile(f.storePath); f.time.ms += 3550000;
  await assert.rejects(f.oauth.getAccessToken({ experimental: true }), e => { assert.ok(!JSON.stringify(e).includes('private-response')); return fail('CODEX_REAUTH_REQUIRED')(e); });
  assert.deepEqual(await readFile(f.storePath), before); assert.equal(f.state.refreshes, 1);
});

test('logout invalidates pending login instead of resurrecting deleted credentials', async t => {
  const f = await fixture(t, { beforeCallback: async ({ oauth }) => { await oauth.logout({ experimental: true }); } });
  await assert.rejects(f.login(), fail('CODEX_AUTH_SESSION_CHANGED'));
  assert.equal((await f.oauth.status({ experimental: true })).authenticated, false);
});

test('timeouts/cancellation close loopback and Experimental guard prevents all auth I/O', async t => {
  const f = await fixture(t, { timeoutMs: 30 });
  await assert.rejects(f.oauth.login({ experimental: true, onAuthorizationUrl: () => new Promise(() => {}) }), fail('CODEX_AUTH_TIMEOUT'));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.login({ signal: aborted.signal }), fail('CODEX_AUTH_CANCELLED'));
  for (const action of ['login', 'status', 'logout', 'getAccessToken']) await assert.rejects(f.oauth[action](), fail('CODEX_EXPERIMENTAL_REQUIRED'));
  assert.equal(f.state.exchanges, 0);
});

test('Unix credential store rejects broad permissions, file and ancestor symlinks, corrupt schema and unsafe locks', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await f.login();
  await chmod(f.storePath, 0o644);
  await assert.rejects(f.oauth.status({ experimental: true }), fail('CODEX_STORE_UNSAFE')); await chmod(f.storePath, 0o600);
  await chmod(path.dirname(f.storePath), 0o755);
  await assert.rejects(f.oauth.status({ experimental: true }), fail('CODEX_STORE_UNSAFE')); await chmod(path.dirname(f.storePath), 0o700);
  const hardAlias = path.join(f.dir, 'hardlink'); await link(f.storePath, hardAlias);
  await assert.rejects(f.oauth.status({ experimental: true }), fail('CODEX_STORE_UNSAFE')); await rm(hardAlias);
  const alias = path.join(f.dir, 'alias'); await symlink(path.dirname(f.storePath), alias);
  const viaLink = createCodexOAuth({ storePath: path.join(alias, 'codex.json'), fetchImpl: f.fetchImpl });
  await assert.rejects(viaLink.status({ experimental: true }), fail('CODEX_STORE_UNSAFE'));
  const copy = path.join(f.dir, 'copy'); await writeFile(copy, await readFile(f.storePath), { mode: 0o600 });
  await rm(f.storePath); await symlink(copy, f.storePath);
  await assert.rejects(f.oauth.status({ experimental: true }), fail('CODEX_STORE_UNSAFE'));
  await rm(f.storePath); await writeFile(f.storePath, '{"version":1}', { mode: 0o600 });
  await assert.rejects(f.oauth.status({ experimental: true }), fail('CODEX_STORE_INVALID'));
  await rm(f.storePath); await symlink(copy, `${f.storePath}.lock`);
  await assert.rejects(f.oauth.logout({ experimental: true }), fail('CODEX_STORE_UNSAFE'));
});

test('login command persists first opt-in, labels status/logout and emits no tokens', async t => {
  const f = await fixture(t), output = [], stderr = { write: text => output.push(text) };
  await assert.rejects(loginCodex([], { oauth: f.oauth, stderr, onAuthorizationUrl: f.onAuthorizationUrl }), fail('CODEX_EXPERIMENTAL_REQUIRED'));
  await loginCodex(['--experimental'], { experimental: true, oauth: f.oauth, stderr, onAuthorizationUrl: f.onAuthorizationUrl });
  await loginCodex([], { oauth: f.oauth, stderr, onAuthorizationUrl: f.onAuthorizationUrl });
  const status = await loginCodex(['status'], { oauth: f.oauth, stderr });
  assert.equal(status.experimental, true); assert.equal(status.unofficial, true);
  const loggedOut = await loginCodex(['logout'], { oauth: f.oauth, stderr }); assert.equal(loggedOut.authenticated, false);
  assert.ok(output.every(text => text.includes('Experimental')));
  assert.ok(!output.join('').includes('fixture-access'));
  assert.ok(!JSON.stringify(loggedOut).includes('fixture-refresh'));
  await assert.rejects(loginCodex(['--experimental', '--experimental'], { oauth: f.oauth, stderr }), fail('CODEX_INPUT_INVALID'));
});

test('CLI renders actionable provider errors with Experimental metadata and no raw diagnostics', async () => {
  const stdout = [], stderr = [];
  const result = await run(['login', 'codex', '--json'], { stdout: { write: text => stdout.push(text) }, stderr: { write: text => stderr.push(text) }, loginCodex: () => { throw new ProviderError('CODEX_EXPERIMENTAL_REQUIRED'); } });
  assert.equal(result, 1); assert.equal(stdout.length, 0);
  const response = JSON.parse(stderr.join(''));
  assert.equal(response.error.code, 'CODEX_EXPERIMENTAL_REQUIRED');
  assert.equal(response.error.experimental, true); assert.equal(response.error.unofficial, true);
  assert.ok(!response.error.message.includes('COMMAND_FAILED'));
});

test('stored Experimental opt-in remains required for token use even with internal provider flag', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await f.login();
  const saved = JSON.parse(await readFile(f.storePath)); saved.experimentalAccepted = false; await writeFile(f.storePath, JSON.stringify(saved));
  await assert.rejects(f.oauth.getAccessToken({ experimental: true }), fail('CODEX_EXPERIMENTAL_REQUIRED'));
  assert.equal(f.state.refreshes, 0);
});

const schema = { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 30 }, score: { type: 'integer', minimum: 0, maximum: 10 } }, required: ['title', 'score'], additionalProperties: false };
const stage = { experimental: true, stage: 'plan', model: 'gpt-5.4', instructions: 'Return the game plan as JSON.', input: { prompt: 'fixture game' }, outputSchema: schema };
function event(data) { return `event: ${data.type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`; }
function completed(text, extra = {}) { return { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 2, output_tokens: 4, total_tokens: 6, secret: 'private' }, ...extra } }; }
function streamResponse(text, step = 7) {
  const bytes = Buffer.from(text); let index = 0;
  return new Response(new ReadableStream({ pull(controller) { if (index === bytes.length) return controller.close(); const end = Math.min(index + step, bytes.length); controller.enqueue(bytes.subarray(index, end)); index = end; } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
function provider(fetchImpl) { return createCodexResponsesProvider({ oauth: { getAccessToken: async ({ experimental }) => { assert.equal(experimental, true); return 'fixture-access'; } }, fetchImpl }); }

test('Responses sends supported JSON-only contract and parses split UTF-8 SSE with verified terminal output', async () => {
  const output = { title: '게임 🎮', score: 3 }, text = JSON.stringify(output);
  const p = provider(async (url, init) => {
    assert.equal(url, CODEX_RESPONSES_URL); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer fixture-access');
    const body = JSON.parse(init.body);
    assert.equal(body.store, false); assert.equal(body.stream, true);
    assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.text.format.strict, true);
    assert.ok(!Object.hasOwn(body, 'tools')); assert.ok(!Object.hasOwn(body, 'previous_response_id')); assert.ok(!Object.hasOwn(body, 'temperature'));
    assert.equal(body.input[0].role, 'user'); assert.deepEqual(JSON.parse(body.input[0].content[0].text), { stage: 'plan', input: stage.input });
    return streamResponse(': heartbeat\r\n\r\n' + event({ type: 'response.output_text.delta', delta: text.slice(0, 6) }) + event({ type: 'response.output_text.delta', delta: text.slice(6) }) + event(completed(text)), 1);
  });
  const result = await p.runStage(stage);
  assert.deepEqual(result.output, output); assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 4, total_tokens: 6 });
  assert.equal(result.experimental, true); assert.equal(result.unofficial, true);
  assert.ok(!JSON.stringify(result).includes('fixture-access'));
});

for (const [name, sse, code] of [
  ['DONE without completion', 'data: [DONE]\n\n', 'CODEX_RESPONSE_INVALID'],
  ['truncated stream', event({ type: 'response.output_text.delta', delta: '{' }), 'CODEX_RESPONSE_INVALID'],
  ['delta/final disagreement', event({ type: 'response.output_text.delta', delta: '{}' }) + event(completed('{"title":"ok","score":1}')), 'CODEX_RESPONSE_INVALID'],
  ['malformed JSON', event(completed('not-json')), 'CODEX_RESPONSE_INVALID'],
  ['schema extra property', event(completed('{"title":"ok","score":1,"shell":"evil"}')), 'CODEX_RESPONSE_INVALID'],
  ['schema numeric mismatch', event(completed('{"title":"ok","score":1.5}')), 'CODEX_RESPONSE_INVALID'],
  ['schema missing property', event(completed('{"title":"ok"}')), 'CODEX_RESPONSE_INVALID'],
  ['refusal', event(completed('', { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'private refusal' }] }] })), 'CODEX_RESPONSE_INVALID'],
  ['tool call', event(completed('', { output: [{ type: 'function_call', name: 'shell', arguments: 'evil' }] })), 'CODEX_RESPONSE_INVALID'],
  ['failed', event({ type: 'response.failed', response: { error: 'private failure' } }), 'CODEX_INFERENCE_FAILED'],
  ['incomplete', event({ type: 'response.incomplete' }), 'CODEX_INFERENCE_FAILED'],
]) test(`Responses rejects ${name}`, async () => {
  await assert.rejects(provider(async () => streamResponse(sse)).runStage(stage), e => { assert.ok(!e.message.includes('private')); return fail(code)(e); });
});

test('Responses refuses unsupported/invalid schema before requesting credentials', async () => {
  let calls = 0; const p = createCodexResponsesProvider({ oauth: { getAccessToken: () => { calls++; } } });
  for (const outputSchema of [
    { ...schema, additionalProperties: true }, { ...schema, required: ['title'] },
    { type: 'string', pattern: '^x' }, { type: 'string', properties: {} },
    { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 2 },
    { type: 'integer', minimum: 5, maximum: 2 }, { type: 'string', minLength: -1 },
  ]) await assert.rejects(p.runStage({ ...stage, outputSchema }), fail('CODEX_INPUT_INVALID'));
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(p.runStage({ ...stage, input: cyclic }), fail('CODEX_INPUT_INVALID'));
  await assert.rejects(p.runStage({ ...stage, experimental: false }), fail('CODEX_EXPERIMENTAL_REQUIRED'));
  assert.equal(calls, 0);
  assert.throws(() => validateStageSchema({ type: 'object', properties: {}, required: [], additionalProperties: false, '$ref': 'remote' }), fail('CODEX_INPUT_INVALID'));
});

test('Responses validates nested arrays/nullable fields and enum/const bounds', async () => {
  const outputSchema = { type: 'object', properties: { levels: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['one', 'two'] } }, optional: { type: ['string', 'null'] }, kind: { type: 'string', const: 'game' } }, required: ['levels', 'optional', 'kind'], additionalProperties: false };
  const output = { levels: ['one'], optional: null, kind: 'game' };
  assert.deepEqual((await provider(async () => streamResponse(event(completed(JSON.stringify(output))))).runStage({ ...stage, outputSchema })).output, output);
  for (const bad of [{ ...output, levels: [] }, { ...output, levels: ['invalid'] }, { ...output, kind: 'not-game' }]) await assert.rejects(provider(async () => streamResponse(event(completed(JSON.stringify(bad))))).runStage({ ...stage, outputSchema }), fail('CODEX_RESPONSE_INVALID'));
});

test('finite game patterns validate real stage IDs and reject arbitrary regex/schema bypasses', async () => {
  const outputSchema = { type: 'object', properties: { source: { type: 'string', maxLength: 130, pattern: '^src/[A-Za-z0-9_][A-Za-z0-9_/-]{0,120}\\.(js|mjs)$' }, hash: { type: 'string', maxLength: 64, pattern: '^[0-9a-f]{64}$' } }, required: ['source', 'hash'], additionalProperties: false };
  const value = { source: 'src/game.js', hash: 'a'.repeat(64) };
  assert.deepEqual((await provider(async () => streamResponse(event(completed(JSON.stringify(value))))).runStage({ ...stage, outputSchema })).output, value);
  for (const bad of [{ ...value, source: '../secret.js' }, { ...value, hash: 'not-a-hash' }]) await assert.rejects(provider(async () => streamResponse(event(completed(JSON.stringify(bad))))).runStage({ ...stage, outputSchema }), fail('CODEX_RESPONSE_INVALID'));
  const unsafe = structuredClone(outputSchema); unsafe.properties.source.pattern = '^(a+)+$';
  await assert.rejects(provider(() => { throw new Error('must not fetch'); }).runStage({ ...stage, outputSchema: unsafe }), fail('CODEX_INPUT_INVALID'));
});

test('stage byte budget supports bounded implementation output and refuses caller expansion above hard cap', async () => {
  const outputSchema = { type: 'object', properties: { source: { type: 'string', maxLength: 1000000 } }, required: ['source'], additionalProperties: false };
  const text = JSON.stringify({ source: 'a'.repeat(600000) });
  const p = provider(async () => streamResponse(event(completed(text)), 65536));
  assert.equal((await p.runStage({ ...stage, outputSchema, maxOutputBytes: 1600000 })).output.source.length, 600000);
  await assert.rejects(p.runStage({ ...stage, outputSchema }), fail('CODEX_RESPONSE_LIMIT'));
  for (const maxOutputBytes of [0, -1, 2 * 1024 * 1024 + 1, 1.5]) await assert.rejects(p.runStage({ ...stage, outputSchema, maxOutputBytes }), fail('CODEX_INPUT_INVALID'));
});

test('all five actual agent stage schemas and signed skill instructions fit the Responses contract', async () => {
  const [{ STAGES, stageInstructions }, { loadSkillPack, skillReceipt }] = await Promise.all([import('../lib/agent/stages.mjs'), import('../lib/agent/skills.mjs')]);
  const pack = await loadSkillPack();
  const patterns = {
    '^[a-z0-9][a-z0-9_-]{0,31}$': 'action', '^[a-z][a-z -]{0,39}$': 'move',
    '^[a-z][a-z0-9_]{0,31}$': 'move', '^[a-z][a-z0-9-]{0,39}$': 'hud',
    '^[a-z][a-z0-9_]{0,39}$': 'asset', '^[0-9a-f]{64}$': 'a'.repeat(64),
    '^(|assets/[a-z0-9][a-z0-9_/-]{0,100}\\.(svg|json|txt))$': '',
    '^src/[A-Za-z0-9_][A-Za-z0-9_/-]{0,120}\\.(js|mjs)$': 'src/game.js',
    '^[a-z][A-Za-z0-9_]{0,39}$': 'score', '^[a-z0-9][a-z0-9 _-]{0,29}$': 'game',
  };
  function example(s) {
    if (s.enum) return s.enum[0];
    if (s.type === 'object') return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, example(v)]));
    if (s.type === 'array') return Array.from({ length: s.minItems ?? 0 }, () => example(s.items));
    if (s.type === 'string') return s.pattern ? patterns[s.pattern] : 'x'.repeat(s.minLength ?? 1);
    if (s.type === 'boolean') return false;
    return s.minimum ?? 0;
  }
  assert.equal(Object.keys(STAGES).length, 5);
  for (const [name, definition] of Object.entries(STAGES)) {
    const skill = pack.get(definition.skill), instructions = stageInstructions(name, skill), output = example(definition.schema);
    output.skill_receipt = skillReceipt(skill);
    assert.ok(instructions.includes(skill.body)); assert.ok(instructions.length <= 65536);
    const p = provider(async (_url, init) => { assert.deepEqual(JSON.parse(init.body).text.format.schema, definition.schema); return streamResponse(event(completed(JSON.stringify(output)))); });
    const result = await p.runStage({ ...stage, stage: name, instructions, input: { request: 'fixture game' }, outputSchema: definition.schema, maxOutputBytes: definition.maxBytes });
    assert.equal(result.stage, name); assert.deepEqual(result.output.skill_receipt, skillReceipt(skill));
  }
});

for (const [status, code] of [[401, 'CODEX_REAUTH_REQUIRED'], [403, 'CODEX_REAUTH_REQUIRED'], [429, 'CODEX_RATE_LIMITED'], [500, 'CODEX_INFERENCE_FAILED'], [302, 'CODEX_RESPONSE_INVALID']]) test(`Responses HTTP ${status} fails once without revealing body or paid fallback`, async () => {
  let calls = 0;
  await assert.rejects(provider(async () => { calls++; return new Response('private-body', { status }); }).runStage(stage), e => { assert.ok(!e.message.includes('private-body')); return fail(code)(e); });
  assert.equal(calls, 1);
});

test('Responses enforces output/stream bounds and cancellation', async () => {
  await assert.rejects(provider(async () => streamResponse(event({ type: 'response.output_text.delta', delta: 'x'.repeat(512 * 1024 + 1) }), 65536)).runStage(stage), fail('CODEX_RESPONSE_LIMIT'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider(() => { throw new Error('must not fetch'); }).runStage({ ...stage, signal: controller.signal }), fail('CODEX_AUTH_CANCELLED'));
  await assert.rejects(provider(async () => new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream-evil' } })).runStage(stage), fail('CODEX_RESPONSE_INVALID'));
});

test('actual same-inference callbacks arrive before terminal, discard reasoning and normalize observed usage', async () => {
  const text = JSON.stringify({ title: '게임 🎮', score: 3 }), seen = [];
  let calls = 0, terminalSent = false;
  const p = provider(async () => {
    calls++;
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(Buffer.from(event({ type: 'response.reasoning_text.delta', delta: 'PRIVATE_REASONING_SENTINEL' }) + event({ type: 'response.output_text.delta', delta: text })));
      await new Promise(resolve => setTimeout(resolve, 30));
      terminalSent = true; controller.enqueue(Buffer.from(event(completed(text)))); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const result = await p.runStage({ ...stage, onEvent: async value => { if (value.type === 'text-delta') assert.equal(terminalSent, false); seen.push(value); } });
  assert.equal(calls, 1); assert.deepEqual(result.output, { title: '게임 🎮', score: 3 });
  assert.equal(seen.filter(value => value.type === 'text-delta').map(value => value.text).join(''), text);
  assert.deepEqual(seen.at(-2), { type: 'usage', usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 } });
  assert.deepEqual(seen.at(-1), { type: 'finish', reason: 'completed' });
  assert.ok(!JSON.stringify(seen).includes('PRIVATE_'));
});

test('stage observer never invents deltas from a final-only response and normalizes the alias once', async () => {
  const text = JSON.stringify({ title: 'done', score: 1 }), onlyFinal = [];
  await provider(async () => streamResponse(event(completed(text)))).runStage({ ...stage, onEvent: value => onlyFinal.push(value) });
  assert.equal(onlyFinal.some(value => value.type === 'text-delta'), false);
  const seen = [], callback = value => seen.push(value);
  await provider(async () => streamResponse(event({ type: 'response.output_text.delta', delta: text }) + event(completed(text)))).runStage({ ...stage, onEvent: callback, onDelta: callback });
  assert.equal(seen.filter(value => value.type === 'text-delta').length, 1);
  await assert.rejects(provider(() => { throw Error('must not fetch'); }).runStage({ ...stage, onEvent: callback, onDelta() {} }), fail('CODEX_INPUT_INVALID'));
});

test('known bearer is redacted across split deltas and a credential-bearing final result is rejected', async () => {
  const text = JSON.stringify({ title: 'fixture-access', score: 1 }), seen = [];
  const split = text.indexOf('fixture-access') + 7;
  await assert.rejects(provider(async () => streamResponse(event({ type: 'response.output_text.delta', delta: text.slice(0, split) }) + event({ type: 'response.output_text.delta', delta: text.slice(split) }) + event(completed(text)), 1)).runStage({ ...stage, onEvent: value => seen.push(value) }), fail('CODEX_RESPONSE_INVALID'));
  const visible = seen.filter(value => value.type === 'text-delta').map(value => value.text).join('');
  assert.ok(visible.includes('[REDACTED]')); assert.ok(!visible.includes('fixture-access'));
  assert.equal(seen.some(value => value.type === 'finish'), false);
});

for (const hung of [false, true]) test(`observer ${hung ? 'deadline' : 'failure'} aborts one inference with fixed safe error`, async () => {
  let requestSignal, cancelled = false, count = 0;
  const p = createCodexResponsesProvider({ oauth: { getAccessToken: async () => 'fixture-access' }, eventTimeoutMs: 15,
    fetchImpl: async (_url, init) => {
      count++; requestSignal = init.signal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(event({ type: 'response.output_text.delta', delta: '{' }))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
  await assert.rejects(p.runStage({ ...stage, onEvent: () => hung ? new Promise(() => {}) : Promise.reject(Error('private-token-sentinel')) }), error => {
    assert.ok(!error.message.includes('private-token-sentinel') && !error.stack.includes('private-token-sentinel'));
    return fail('CODEX_RESPONSE_INVALID')(error);
  });
  assert.equal(count, 1); assert.equal(cancelled, true); assert.equal(requestSignal.aborted, true);
});

test('cancelling a pending private callback or a silent reader stops inference without another request', async () => {
  for (const callback of [true, false]) {
    const controller = new AbortController(); let cancelled = false;
    const p = provider(async () => new Response(new ReadableStream({ start(stream) {
      if (callback) stream.enqueue(Buffer.from(event({ type: 'response.output_text.delta', delta: '{' })));
    }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
    const timer = setTimeout(() => controller.abort(), 15);
    try { await assert.rejects(p.runStage({ ...stage, signal: controller.signal, ...(callback ? { onEvent: () => new Promise(() => {}) } : {}) }), fail('CODEX_AUTH_CANCELLED')); }
    finally { clearTimeout(timer); }
    assert.equal(cancelled, true);
  }
});
