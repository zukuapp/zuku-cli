import test from 'node:test';
import assert from 'node:assert/strict';
import { lines, sse, sseJson, ndjson } from '../lib/provider-system/adapters/framing.mjs';
import { validateBaseUrl, rebaseForTest, joinUrl, buildHeaders, validModelId } from '../lib/provider-system/adapters/http.mjs';
import { normalizeRequest, ToolCalls } from '../lib/provider-system/adapters/request.mjs';
import { createAdapter, listBuiltinDescriptors, API_TYPES } from '../lib/provider-system/adapters/index.mjs';
import { projectSchema } from '../lib/provider-system/adapters/protocols/gemini.mjs';
import { parseStageText } from '../lib/provider-system/adapters/stage.mjs';

const enc = new TextEncoder();
async function* chunked(bytes, sizes) {
  let offset = 0;
  for (const size of sizes) { yield bytes.subarray(offset, offset + size); offset += size; }
  if (offset < bytes.length) yield bytes.subarray(offset);
}
async function collect(iterable) { const out = []; for await (const item of iterable) out.push(item); return out; }
async function rejects(promise, code) { await assert.rejects(promise, error => error.code === code); }

test('line splitter handles multibyte characters and CRLF split across every byte boundary', async () => {
  const text = '가나다\r\n🎮 game\rthird\nlast';
  const bytes = enc.encode(text);
  for (let cut = 1; cut < bytes.length; cut += 1) {
    assert.deepEqual(await collect(lines(chunked(bytes, [cut]))), ['가나다', '🎮 game', 'third', 'last'], `cut ${cut}`);
  }
  const single = await collect(lines(chunked(bytes, Array(bytes.length).fill(1))));
  assert.deepEqual(single, ['가나다', '🎮 game', 'third', 'last']);
});

test('line splitter rejects invalid UTF-8 and oversized lines', async () => {
  await rejects(collect(lines(chunked(new Uint8Array([0x61, 0xff, 0x0a]), [3]))), 'PROVIDER_RESPONSE_INVALID');
  await rejects(collect(lines(chunked(enc.encode('x'.repeat(5000)), [1000, 1000, 1000, 1000, 1000]), { maxLineBytes: 4096 })), 'PROVIDER_RESPONSE_TOO_LARGE');
});

test('SSE parser follows WHATWG field rules, multi-line data, comments, and [DONE]', async () => {
  const wire = ': keepalive\r\nevent: message_start\r\ndata: {"a":\r\ndata: 1}\r\n\r\nid: 7\nretry: 10\ndata:[DONE]\n\n';
  const events = await collect(sse(chunked(enc.encode(wire), [3, 5, 7, 11])));
  assert.deepEqual(events, [{ event: 'message_start', data: '{"a":\n1}' }, { event: 'message', data: '[DONE]' }]);
  const json = await collect(sseJson(chunked(enc.encode(wire), [2])));
  assert.deepEqual(json, [{ event: 'message_start', value: { a: 1 } }, { event: 'message', done: true }]);
  await rejects(collect(sseJson(chunked(enc.encode('data: {nope\n\n'), [4]))), 'PROVIDER_RESPONSE_INVALID');
  await rejects(collect(sse(chunked(enc.encode(`data: ${'y'.repeat(300)}\n`.repeat(20)), [100]), { maxEventBytes: 1000 })), 'PROVIDER_RESPONSE_TOO_LARGE');
});

test('NDJSON parser skips blank lines and rejects malformed objects', async () => {
  const wire = '{"a":"가"}\n\n{"b":2}\n';
  assert.deepEqual(await collect(ndjson(chunked(enc.encode(wire), [2]))), [{ a: '가' }, { b: 2 }]);
  await rejects(collect(ndjson(chunked(enc.encode('{"a":1}\n{bad}\n'), [3]))), 'PROVIDER_RESPONSE_INVALID');
});

test('endpoint policy refuses userinfo, query, fragment, traversal, double version, endpoint suffix, plain http', () => {
  assert.equal(validateBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(validateBaseUrl('http://127.0.0.1:8000/v1', { allowLoopbackHttp: true }), 'http://127.0.0.1:8000/v1');
  assert.equal(validateBaseUrl('http://[::1]:8000', { allowLoopbackHttp: true }), 'http://[::1]:8000');
  for (const bad of [
    'https://user:pw@api.example.com/v1', 'https://api.example.com/v1?x=1', 'https://api.example.com/v1#f',
    'https://api.example.com/v1/../admin', 'https://api.example.com/a/%2e%2e/b', 'https://api.example.com/a%2fb',
    'https://api.example.com/v1/v1', 'https://api.example.com/v1/chat/completions', 'https://api.example.com//v1',
    'http://api.example.com/v1', 'http://127.0.0.1:8000/v1', 'http://10.0.0.5/v1', 'ftp://api.example.com',
    'https://api.example.com/v1\r\nx', 'https://api.example.com\\v1', 'javascript:alert(1)',
  ]) assert.throws(() => validateBaseUrl(bad, { allowLoopbackHttp: bad === 'http://127.0.0.1:8000/v1' ? false : true }), { code: 'ADAPTER_ENDPOINT_REJECTED' }, bad);
  assert.throws(() => rebaseForTest('https://api.openai.com/v1', 'http://192.168.1.2:80'), { code: 'ADAPTER_ENDPOINT_REJECTED' });
  assert.equal(rebaseForTest('https://api.openai.com/v1', 'http://127.0.0.1:9'), 'http://127.0.0.1:9/v1');
  assert.throws(() => joinUrl('https://a.example/v1', '/../x'), { code: 'ADAPTER_ENDPOINT_REJECTED' });
  assert.throws(() => joinUrl('https://a.example/v1', '//evil.example/x'), { code: 'ADAPTER_ENDPOINT_REJECTED' });
  assert.equal(joinUrl('https://a.example/v1', '/models', { pageToken: 'a&b=c' }), 'https://a.example/v1/models?pageToken=a%26b%3Dc');
});

test('header policy refuses CRLF, forbidden names and overriding protocol-managed headers', () => {
  const h = buildHeaders({ authorization: 'Bearer k' }, { 'x-title': 'zuku' });
  assert.equal(h.get('x-title'), 'zuku');
  assert.throws(() => buildHeaders({}, { 'x-a': 'v\r\nInjected: 1' }), { code: 'ADAPTER_HEADER_REJECTED' });
  assert.throws(() => buildHeaders({}, { 'bad name': 'v' }), { code: 'ADAPTER_HEADER_REJECTED' });
  assert.throws(() => buildHeaders({}, { host: 'evil' }), { code: 'ADAPTER_HEADER_REJECTED' });
  assert.throws(() => buildHeaders({}, { Cookie: 'a=b' }), { code: 'ADAPTER_HEADER_REJECTED' });
  assert.throws(() => buildHeaders({ authorization: 'Bearer k' }, { Authorization: 'Bearer other' }), { code: 'ADAPTER_HEADER_REJECTED' });
});

test('model IDs keep vendor slashes and reject traversal/control characters', () => {
  for (const id of ['gpt-5.5', 'openai/gpt-5.5', 'anthropic/claude-opus-4.7', 'llama3.2:latest', 'us.anthropic.claude-x-v1:0', 'claude@20250101']) assert.equal(validModelId(id), true, id);
  for (const id of ['', '../x', 'a//b', 'a/../b', 'a b', 'a\nb', '/a', 'x'.repeat(300)]) assert.equal(validModelId(id), false, id);
});

test('request normalization bounds and validates tool round-trips', () => {
  const ok = normalizeRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a' } }] }, { role: 'tool', toolCallId: 'call_1', content: 'x' }], tools: [{ name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] });
  assert.equal(ok.toolChoice, 'auto');
  assert.throws(() => normalizeRequest({ messages: [{ role: 'user', content: 'x' }] }), { code: 'ADAPTER_MODEL_REQUIRED' });
  assert.throws(() => normalizeRequest({ model: 'm', messages: [{ role: 'tool', toolCallId: 'nope', content: 'x' }] }), { code: 'ADAPTER_REQUEST_INVALID' });
  assert.throws(() => normalizeRequest({ model: 'm', messages: [{ role: 'system', content: 'x' }] }), { code: 'ADAPTER_REQUEST_INVALID' });
  assert.throws(() => normalizeRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'bad name' }] }), { code: 'ADAPTER_REQUEST_INVALID' });
  assert.throws(() => normalizeRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], toolChoice: 'required' }), { code: 'ADAPTER_REQUEST_INVALID' });
  assert.throws(() => normalizeRequest({ model: 'm', messages: Array(1025).fill({ role: 'user', content: 'x' }) }), { code: 'ADAPTER_REQUEST_INVALID' });
  assert.throws(() => normalizeRequest({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024 + 1) }] }), { code: 'ADAPTER_REQUEST_INVALID' });
});

test('tool-call accumulator bounds argument bytes and requires JSON objects', () => {
  const t = new ToolCalls();
  t.start(0, { id: 'call_1', name: 'patch_file' });
  t.append(0, '{"pa'); t.append(0, 'th":"가"}');
  assert.deepEqual(t.finish(0), { type: 'tool-call', id: 'call_1', name: 'patch_file', arguments: { path: '가' } });
  assert.equal(t.finish(0), undefined, 'emitted once');
  const arr = new ToolCalls(); arr.start(1, { id: 'c', name: 'n' }); arr.append(1, '[1]');
  assert.throws(() => arr.finish(1), { code: 'PROVIDER_RESPONSE_INVALID' });
  const big = new ToolCalls(); big.start(0, { id: 'c', name: 'n' });
  assert.throws(() => big.append(0, 'x'.repeat(1024 * 1024 + 1)), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  assert.throws(() => new ToolCalls().append(9, 'x'), { code: 'PROVIDER_RESPONSE_INVALID' });
});

test('Gemini tool schema projection keeps declared intent only', () => {
  const projected = projectSchema({ type: 'object', additionalProperties: false, $schema: 'x', properties: { n: { type: ['integer', 'null'], enum: [1, 2] }, list: { type: 'array' } }, required: ['n', 'ghost'] });
  assert.deepEqual(projected, { type: 'object', properties: { n: { type: 'string', nullable: true, enum: ['1', '2'] }, list: { type: 'array', items: { type: 'string' } } }, required: ['n'] });
});

test('stage text parsing accepts fenced JSON only', () => {
  assert.deepEqual(parseStageText('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseStageText('  [1,2] '), [1, 2]);
  assert.throws(() => parseStageText('Here you go: {"a":1}'), { code: 'STAGE_OUTPUT_INVALID' });
});

test('built-in descriptors map to implemented factories, declare fixed env names, and mark only Codex experimental', () => {
  const all = listBuiltinDescriptors();
  assert.equal(new Set(all.map(d => d.id)).size, all.length);
  for (const d of all) {
    assert.ok(API_TYPES.includes(d.apiType), d.id);
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.capabilities));
    for (const m of d.authMethods) {
      assert.equal(m.experimental, d.id === 'codex', d.id);
      assert.equal(m.official, d.id !== 'codex', d.id);
      for (const env of m.env ?? []) assert.match(env, /^[A-Z][A-Z0-9_]+$/);
    }
  }
  assert.equal(all.find(d => d.id === 'zuku').enabled, true);
  assert.equal(all.filter(d => d.enabled).length, 1);
  const zuku = createAdapter(all.find(d => d.id === 'zuku'), {});
  assert.equal(zuku.capabilities.nativeInference, true);
  assert.equal(zuku.capabilities.stage, true);
  assert.equal(zuku.capabilities.tools, false);
  const codex = createAdapter(all.find(d => d.id === 'codex'), {});
  assert.deepEqual(codex.authMethods.map(m => m.experimental), [true]);
});

test('descriptor validation rejects embedded secrets, unknown types and endpoint overrides', () => {
  const openai = listBuiltinDescriptors().find(d => d.id === 'openai');
  assert.throws(() => createAdapter({ ...openai, options: { apiKey: 'sk-x' } }), { code: 'ADAPTER_INVALID_DESCRIPTOR' });
  assert.throws(() => createAdapter({ ...openai, options: { headers: { Authorization: 'Bearer x' } } }), { code: 'ADAPTER_HEADER_REJECTED' });
  assert.throws(() => createAdapter({ ...openai, baseUrl: 'https://evil.example/v1' }), { code: 'ADAPTER_ENDPOINT_REJECTED' });
  assert.throws(() => createAdapter({ ...openai, apiType: 'mystery' }), { code: 'ADAPTER_UNKNOWN_API_TYPE' });
  assert.throws(() => createAdapter({ ...openai, apiType: 'anthropic' }), { code: 'ADAPTER_INVALID_DESCRIPTOR' });
  assert.throws(() => createAdapter({ ...openai, apiType: 'anthropic-messages' }), { code: 'ADAPTER_UNKNOWN_API_TYPE' });
  assert.throws(() => createAdapter({ id: 'mine', apiType: 'openai-chat', baseUrl: 'https://x.example/v1', options: {} }), { code: 'ADAPTER_INVALID_DESCRIPTOR' }, 'custom must be explicit');
  assert.throws(() => createAdapter({ id: 'mine', apiType: 'gemini', baseUrl: 'https://x.example/v1', options: { custom: true } }), { code: 'ADAPTER_UNKNOWN_API_TYPE' });
  assert.throws(() => createAdapter({ id: 'mine', apiType: 'openai-chat', baseUrl: 'http://10.1.1.1/v1', options: { custom: true, allowLoopbackHttp: true } }), { code: 'ADAPTER_ENDPOINT_REJECTED' });
  assert.throws(() => createAdapter({ id: 'mine', apiType: 'openai-chat', baseUrl: 'http://127.0.0.1:8000/v1', options: { custom: true } }), { code: 'ADAPTER_ENDPOINT_REJECTED' }, 'loopback http needs explicit opt-in');
  const custom = createAdapter({ id: 'mine', apiType: 'openai-chat', baseUrl: 'http://127.0.0.1:8000/v1', options: { custom: true, allowLoopbackHttp: true } });
  assert.deepEqual(custom.authMethods.map(m => [m.official, m.experimental]), [[false, true]]);
  const ollama = listBuiltinDescriptors().find(d => d.id === 'ollama');
  assert.ok(createAdapter({ ...ollama, baseUrl: 'http://127.0.0.1:11500' }));
  assert.throws(() => createAdapter({ ...ollama, baseUrl: 'http://192.168.0.2:11434' }), { code: 'ADAPTER_ENDPOINT_REJECTED' });
  const azure = listBuiltinDescriptors().find(d => d.id === 'azure');
  assert.throws(() => createAdapter({ ...azure, baseUrl: 'https://evil.example/openai/v1' }), { code: 'ADAPTER_ENDPOINT_REJECTED' });
  assert.ok(createAdapter({ ...azure, options: { resourceName: 'my-res' } }));
  const cf = listBuiltinDescriptors().find(d => d.id === 'cloudflare-ai-gateway');
  assert.throws(() => createAdapter({ ...cf, options: { accountId: '../x' } }), { code: 'ADAPTER_INVALID_DESCRIPTOR' });
});

test('stage schema admission: bounded subset, no $ref/combinators/unsafe regex; output revalidation', async () => {
  const { admitSchema, validateValue, safePattern } = await import('../lib/provider-system/adapters/schema.mjs');
  const files = { type: 'object', additionalProperties: false, required: ['files'], properties: { files: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', required: ['path', 'content'], additionalProperties: false, properties: { path: { type: 'string', pattern: '^[A-Za-z0-9_./-]{1,200}$' }, content: { type: 'string', maxLength: 1_600_000 } } } }, notes: { type: ['string', 'null'] } } };
  assert.equal(admitSchema(files), files);
  for (const bad of [
    { $ref: '#/x' }, { oneOf: [{ type: 'string' }] }, { anyOf: [] }, { type: 'object', patternProperties: {} }, { type: 'string', pattern: '(a+)+$' },
    { type: 'string', pattern: '(\\w)\\1' }, { type: 'string', pattern: '(?=x)' }, { type: 'string', pattern: 'x'.repeat(300) }, { type: 'mystery' },
    { type: 'string', maxLength: -1 }, { type: 'object', properties: { a: { not: {} } } }, [],
  ]) assert.throws(() => admitSchema(bad), { code: 'ADAPTER_REQUEST_INVALID' }, JSON.stringify(bad));
  let deep = { type: 'string' };
  for (let i = 0; i < 30; i += 1) deep = { type: 'array', items: deep };
  assert.throws(() => admitSchema(deep), { code: 'ADAPTER_REQUEST_INVALID' });
  assert.equal(safePattern('^[a-z]{1,8}(-[a-z]{1,8})?$'), true);
  assert.equal(validateValue(files, { files: [{ path: 'src/main.js', content: 'x' }], notes: null }), true);
  assert.equal(validateValue(files, { files: [] }), false, 'minItems');
  assert.equal(validateValue(files, { files: [{ path: '../etc', content: 'x' }] }), true, 'pattern allows dots; host path policy is separate');
  assert.equal(validateValue(files, { files: [{ path: 'a b', content: 'x' }] }), false, 'pattern');
  assert.equal(validateValue(files, { files: [{ path: 'a', content: 'x', extra: 1 }] }), false, 'additionalProperties');
  assert.equal(validateValue(files, { files: [{ path: 'a' }] }), false, 'required');
  assert.equal(validateValue({ type: 'integer', minimum: 1 }, 1.5), false);
  assert.equal(validateValue({ enum: [{ a: 1 }] }, { a: 1 }), true);
  assert.equal(validateValue({ type: 'array', uniqueItems: true }, [1, 1]), false);
  assert.equal(validateValue({ type: 'string', maxLength: 2 }, '🎮🎮'), true, 'length counts code points');
});
