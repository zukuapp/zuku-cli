import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRequest, validateEvent, projectPublicResult, safeError, createAgentClient, createBrowserClient } from '../lib/agent-protocol/index.mjs';

const req = (method = 'session.input', params = { sessionId: 'ses_example', requestId: 'input_example', operation: 'game.maintain', request: 'Add dash to my ZUKU game.' }) => ({ protocolVersion: 1, id: 'req_example', method, params });
const event = (type = 'agent.delta', data = { text: 'Adding dash.', blockId: 'block_example' }) => ({ protocolVersion: 1, sessionId: 'ses_example', sequence: 1, eventId: 'evt_example', time: '2026-10-04T00:00:00.000Z', type, data });

test('closed versioned schemas deny arbitrary execution, prototype pollution and hidden authority', () => {
  assert.equal(validateRequest(req()).method, 'session.input');
  for (const value of [req('exec', {}), { ...req(), actor: { kind: 'native' } }, req('session.input', { ...req().params, shell: 'curl evil' }), JSON.parse('{"protocolVersion":1,"id":"req_example","method":"hello","params":{"__proto__":{"native":true}}}')]) assert.throws(() => validateRequest(value));
  assert.throws(() => validateRequest(req('project.grant', { localPath: '/tmp/game' })), { code: 'NATIVE_PERMISSION_REQUIRED' });
  assert.doesNotThrow(() => validateRequest(req('project.grant', { localPath: '/tmp/game' }), { native: true }));
  assert.throws(() => validateRequest({ ...req(), protocolVersion: 2 }), { code: 'PROTOCOL_MISMATCH' });
  assert.throws(() => validateRequest(req('provider.configure', { providerId: 'openai', patch: { apiKey: 'secret' } }), { native: true }));
  assert.throws(() => validateRequest(req('project.patch', { projectHandle: 'project_example', path: '../secret', expectedSha256: 'a'.repeat(64), content: 'x' }), { native: true }));
  assert.throws(() => validateRequest(req('session.input', { ...req().params, request: 'x'.repeat(4001) })));
});

test('only fixed host phase events, bounded text and relative evidence paths are valid', () => {
  assert.doesNotThrow(() => validateEvent(event()));
  assert.doesNotThrow(() => validateEvent(event('agent.reasoning_status', { phase: 'testing' })));
  for (const value of [event('reasoning-delta', { text: 'private thoughts' }), event('agent.reasoning_status', { phase: 'my private thoughts' }), event('agent.delta', { text: 'x', blockId: 'b', credentials: {} }), event('agent.delta', { text: 'x'.repeat(8193), blockId: 'b' }), event('tool.completed', { callId: 'c', capability: 'project.patch', path: '/etc/passwd' })]) assert.throws(() => validateEvent(value));
  assert.throws(() => validateEvent(event('agent.delta', { text: `sk-${'z'.repeat(30)}`, blockId: 'b' })));
});

test('public projection strips provider keys, raw exceptions and local paths', () => {
  const output = projectPublicResult({ id: 'a', token: 'secret', stack: 'private', providerMetadata: {}, path: '/root/private', content: 'open /root/private/file', authMethods: [{ id: 'official', official: true, experimental: false, apiKey: 'secret' }] });
  assert.equal(output.path, undefined); assert.equal(output.token, undefined); assert.equal(output.stack, undefined); assert.equal(output.providerMetadata, undefined);
  assert.equal(output.authMethods[0].apiKey, undefined); assert.ok(!output.content.includes('/root/private'));
  assert.deepEqual(safeError({ code: 'secret token /root/path', message: 'credentials', stack: 'trace' }), { code: 'CORE_OPERATION_FAILED' });
});

test('typed frontend client validates actual responses and sequential events', async () => {
  const seen = [];
  const client = createAgentClient({ dispatch: async request => { seen.push(request); return { protocolVersion: 1, id: request.id, result: { status: 'ready' } }; }, subscribe: async function* () { yield event(); } });
  assert.deepEqual(await client.call('hello'), { status: 'ready' });
  assert.equal(seen.length, 1); assert.equal((await client.events({}).next()).value.sequence, 1);
  const bad = createAgentClient({ dispatch: async request => ({ protocolVersion: 2, id: request.id, result: {} }), subscribe: async function* () {} });
  await assert.rejects(bad.call('hello'), { code: 'PROTOCOL_MISMATCH' });
});

test('browser-safe protocol module graph contains no Node/core/auth import', async () => {
  for (const file of ['index.mjs', 'schema.mjs', 'client.mjs']) {
    const source = await readFile(new URL(`../lib/agent-protocol/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*['"](?:node:|\.\.\/agent-core|\.\.\/provider|\.\.\/accounts)/);
  }
});

test('browser client keeps pairing credential in memory and sends no cloud cookie', async () => {
  const calls = []; let nonce;
  const client = createBrowserClient({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/health')) return Response.json({ protocolVersion: 1, status: 'ready' });
    if (url.endsWith('/challenge')) { nonce = JSON.parse(init.body).browserNonce; return Response.json({ challengeId: 'challenge_example', expiresAt: Date.now() + 60000 }); }
    if (url.endsWith('/confirm')) { assert.equal(JSON.parse(init.body).browserNonce, nonce); return Response.json({ token: 'x'.repeat(43), expiresAt: Date.now() + 60000 }); }
    const envelope = JSON.parse(init.body); return Response.json({ protocolVersion: 1, id: envelope.id, result: { projects: [] } });
  } });
  await assert.rejects(client.call('project.list'), { code: 'PERMISSION_REQUIRED' });
  await client.health(); await client.challenge(); assert.deepEqual((await client.confirm()).status, 'connected');
  assert.deepEqual(await client.call('project.list'), { projects: [] });
  for (const call of calls) { assert.equal(call.init.credentials, 'omit'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.targetAddressSpace, 'loopback'); assert.ok(!call.url.includes('xxxx')); }
  assert.equal(calls.at(-1).init.headers.Authorization, `Bearer ${'x'.repeat(43)}`);
  assert.notEqual(calls.at(-1).init.headers['X-Zuku-Request-Id'], calls.at(-2).init.headers['X-Zuku-Request-Id']);
  client.close(); await assert.rejects(client.health(), { code: 'CORE_CLOSED' });
  assert.throws(() => createBrowserClient({ baseUrl: 'http://evil.test' }));
  const unavailable = createBrowserClient({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(unavailable.health(), { code: 'CORE_UNAVAILABLE' });
});
