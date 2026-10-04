// Real loopback HTTP transport tests for every HTTP wire adapter. Servers are
// local fixtures (no vendor calls, no credentials, no cost). Each test pins the
// adapter to the loopback fixture through the explicit context.testOrigin seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdapter, listBuiltinDescriptors } from '../lib/provider-system/adapters/index.mjs';

const KEY = 'fixture_only_key_9f3a71';
const SECRET_ECHO = 'fixture_private_echo_77';
const builtin = id => listBuiltinDescriptors().find(d => d.id === id);
// Private credential getter (canonical boundary): called per operation.
const apiKey = (key = KEY, headers) => ({ getCredentials: async () => ({ kind: 'api-key', apiKey: key, ...(headers ? { headers } : {}) }) });
const bearer = token => ({ getCredentials: async () => ({ kind: 'bearer', accessToken: token }) });
const enc = new TextEncoder();

async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const entry = { method: req.method, url: req.url, headers: req.headers };
    requests.push(entry);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    entry.body = Buffer.concat(chunks).toString('utf8');
    try { await handler(entry, res, req); } catch { res.destroy(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

/** Write text split at fixed byte sizes (splits UTF-8 sequences and CRLF pairs). */
async function writeSplit(res, text, size = 7, pause = 0) {
  const bytes = enc.encode(text);
  for (let i = 0; i < bytes.length; i += size) {
    if (!res.write(bytes.subarray(i, i + size))) await once(res, 'drain');
    if (pause) await delay(pause);
  }
}
const sse = events => events.map(e => (typeof e === 'string' ? `data: ${e}\r\n\r\n` : `${e.event ? `event: ${e.event}\r\n` : ''}data: ${JSON.stringify(e.data)}\r\n\r\n`)).join('');
const stream = (contentType, body, opts) => async (_req, res) => { res.writeHead(200, { 'content-type': contentType }); await writeSplit(res, body, opts?.size, opts?.pause); res.end(); };
const json = (status, value) => async (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
async function collect(iterable) { const out = []; for await (const e of iterable) out.push(e); return out; }
const text = events => events.filter(e => e.type === 'text-delta').map(e => e.text).join('');
const assertClean = (value, label = 'output') => {
  const s = typeof value === 'string' ? value : JSON.stringify(value) + String(value?.stack ?? '');
  for (const secret of [KEY, SECRET_ECHO]) assert.equal(s.includes(secret), false, `${label} leaked ${secret}`);
};
const toolReq = { model: 'gpt-test', system: 'sys', messages: [{ role: 'user', content: '안녕 🎮' }], tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] };

test('OpenAI Chat: split multibyte deltas, streamed tool-call arguments, usage, finish and request shape', async t => {
  const body = sse([
    { data: { choices: [{ index: 0, delta: { role: 'assistant', content: '게임 ' } }] } },
    { data: { choices: [{ index: 0, delta: { reasoning_content: '생각' } }] } },
    { data: { choices: [{ index: 0, delta: { content: '🎮시작' } }] } },
    { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a1', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] } },
    { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] } },
    { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"src/가.js"}' } }] } }] } },
    { data: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
    { data: { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } } },
    '[DONE]',
  ]);
  const fx = await fixture(t, stream('text/event-stream', body, { size: 5 }));
  const client = createAdapter({ ...builtin('openai'), apiType: 'openai-chat' }, { ...apiKey(), testOrigin: fx.origin });
  const events = await collect(client.stream({ ...toolReq, includeReasoning: true }));
  assert.equal(text(events), '게임 🎮시작');
  assert.deepEqual(events.filter(e => e.type === 'reasoning-delta').map(e => e.text), ['생각']);
  assert.deepEqual(events.filter(e => e.type === 'tool-call'), [{ type: 'tool-call', id: 'call_a1', name: 'read_file', arguments: { path: 'src/가.js' } }]);
  assert.deepEqual(events.find(e => e.type === 'usage').usage, { inputTokens: 11, outputTokens: 7, reasoningTokens: 2, cacheReadTokens: 3, totalTokens: 18 });
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'tool-calls' });
  assert.equal(fx.requests.length, 1);
  const [req] = fx.requests;
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  const sent = JSON.parse(req.body);
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  assert.deepEqual(sent.messages[0], { role: 'system', content: 'sys' });
  assert.equal(sent.tools[0].function.name, 'read_file');
  assert.equal(sent.tool_choice, 'auto');
});

test('OpenAI Chat: tool round-trip messages are encoded with ids and JSON-string arguments', async t => {
  const fx = await fixture(t, stream('text/event-stream', sse([{ data: { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } }, '[DONE]'])));
  const client = createAdapter(builtin('openrouter'), { ...apiKey(), testOrigin: fx.origin });
  await collect(client.stream({ model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a' } }] }, { role: 'tool', toolCallId: 'call_1', content: 'data' }], tools: toolReq.tools }));
  const sent = JSON.parse(fx.requests[0].body);
  assert.equal(fx.requests[0].url, '/api/v1/chat/completions');
  assert.equal(sent.model, 'anthropic/claude-x', 'vendor slash preserved');
  assert.deepEqual(sent.messages[1], { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] });
  assert.deepEqual(sent.messages[2], { role: 'tool', tool_call_id: 'call_1', content: 'data' });
  assert.deepEqual(sent.usage, { include: true });
});

test('OpenAI Responses: typed events, function_call items, reasoning summary, store:false', async t => {
  const body = sse([
    { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1' } } },
    { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 0, delta: '계획' } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'msg_1', delta: '좋아요' } },
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_z', name: 'read_file', arguments: '' } } },
    { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' } },
    { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"b"}' } },
    { event: 'response.output_item.done', data: { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_z', name: 'read_file', arguments: '{"path":"b"}' } } },
    { event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 20, output_tokens: 9, total_tokens: 29, output_tokens_details: { reasoning_tokens: 4 } } } } },
  ]);
  const fx = await fixture(t, stream('text/event-stream', body, { size: 3 }));
  const client = createAdapter(builtin('openai'), { ...apiKey(), testOrigin: fx.origin });
  const events = await collect(client.stream({ ...toolReq, reasoning: 'low', includeReasoning: true }));
  assert.deepEqual(events.map(e => e.type), ['reasoning-delta', 'text-delta', 'tool-call', 'usage', 'finish']);
  assert.deepEqual(events[2], { type: 'tool-call', id: 'call_z', name: 'read_file', arguments: { path: 'b' } });
  assert.deepEqual(events[3].usage, { inputTokens: 20, outputTokens: 9, reasoningTokens: 4, totalTokens: 29 });
  assert.equal(events[4].reason, 'tool-calls');
  const sent = JSON.parse(fx.requests[0].body);
  assert.equal(fx.requests[0].url, '/v1/responses');
  assert.equal(sent.store, false);
  assert.equal(sent.instructions, 'sys');
  assert.deepEqual(sent.input[0], { role: 'user', content: [{ type: 'input_text', text: '안녕 🎮' }] });
  assert.deepEqual(sent.tools[0], { type: 'function', name: 'read_file', description: 'read', parameters: toolReq.tools[0].parameters, strict: false });
  assert.deepEqual(sent.reasoning, { effort: 'low', summary: 'auto' });
});

test('OpenAI Responses: incomplete → length, failed → fixed error without remote message', async t => {
  let mode = 'incomplete';
  const fx = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'incomplete') res.end(sse([{ data: { type: 'response.output_text.delta', delta: 'x' } }, { data: { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } } }]));
    else res.end(sse([{ data: { type: 'response.failed', response: { error: { code: 'server_error', message: SECRET_ECHO } } } }]));
  });
  const client = createAdapter(builtin('openai'), { ...apiKey(), testOrigin: fx.origin });
  assert.equal((await collect(client.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] }))).at(-1).reason, 'length');
  mode = 'failed';
  await assert.rejects(collect(client.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })), error => { assertClean(error); return error.code === 'PROVIDER_UNAVAILABLE'; });
});

test('Anthropic Messages: named events, input_json_delta, thinking, cache-inclusive usage, headers', async t => {
  const body = sse([
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '음' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'ping', data: { type: 'ping' } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '파일을 읽을게요' } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path": "s' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'cene.js"}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
  const fx = await fixture(t, stream('text/event-stream', body, { size: 4 }));
  const client = createAdapter(builtin('anthropic'), { ...apiKey(), testOrigin: fx.origin });
  const events = await collect(client.stream({ ...toolReq, model: 'claude-test', maxOutputTokens: 2048, includeReasoning: true }));
  assert.deepEqual(events.map(e => e.type), ['reasoning-delta', 'text-delta', 'tool-call', 'usage', 'finish']);
  assert.deepEqual(events[2].arguments, { path: 'scene.js' });
  assert.deepEqual(events[3].usage, { inputTokens: 17, outputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 2, totalTokens: 47 });
  assert.equal(events[4].reason, 'tool-calls');
  const req = fx.requests[0];
  assert.equal(req.url, '/v1/messages');
  assert.equal(req.headers['x-api-key'], KEY);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers.authorization, undefined);
  const sent = JSON.parse(req.body);
  assert.equal(sent.max_tokens, 2048);
  assert.equal(sent.system, 'sys');
  assert.deepEqual(sent.tools[0].input_schema, toolReq.tools[0].parameters);
});

test('Anthropic Messages: tool results merge into one user turn; stream error event is fixed', async t => {
  let mode = 'ok';
  const fx = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'ok') res.end(sse([{ data: { type: 'message_start', message: { usage: { input_tokens: 1 } } } }, { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } }, { data: { type: 'message_stop' } }]));
    else res.end(sse([{ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: SECRET_ECHO } } }]));
  });
  const client = createAdapter(builtin('anthropic'), { ...apiKey(), testOrigin: fx.origin });
  const events = await collect(client.stream({ model: 'c', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', toolCalls: [{ id: 't1', name: 'x', arguments: {} }, { id: 't2', name: 'y', arguments: { a: 1 } }] }, { role: 'tool', toolCallId: 't1', content: 'r1' }, { role: 'tool', toolCallId: 't2', content: 'r2' }] }));
  assert.equal(events.at(-1).reason, 'stop');
  const sent = JSON.parse(fx.requests[0].body);
  assert.equal(sent.messages.length, 3);
  assert.deepEqual(sent.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }, { type: 'tool_result', tool_use_id: 't2', content: 'r2' }] });
  mode = 'error';
  await assert.rejects(collect(client.stream({ model: 'c', messages: [{ role: 'user', content: 'q' }] })), e => { assertClean(e); return e.code === 'PROVIDER_UNAVAILABLE'; });
});

test('Gemini: streamGenerateContent?alt=sse, key in header not URL, thoughts, functionCall, usage', async t => {
  const body = sse([
    { data: { candidates: [{ content: { role: 'model', parts: [{ text: '생각중', thought: true }] } }] } },
    { data: { candidates: [{ content: { role: 'model', parts: [{ text: '좋아' }] } }] } },
    { data: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'main.ts' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 20 } } },
  ]);
  const fx = await fixture(t, stream('text/event-stream', body, { size: 6 }));
  const client = createAdapter(builtin('google'), { ...apiKey(), testOrigin: fx.origin });
  const events = await collect(client.stream({ ...toolReq, model: 'gemini-test', responseFormat: { type: 'json' }, includeReasoning: true }));
  assert.deepEqual(events.map(e => e.type), ['reasoning-delta', 'text-delta', 'tool-call', 'usage', 'finish']);
  assert.deepEqual(events[2], { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: { path: 'main.ts' } });
  assert.deepEqual(events[3].usage, { inputTokens: 12, outputTokens: 8, reasoningTokens: 3, totalTokens: 20 });
  assert.equal(events[4].reason, 'tool-calls');
  const req = fx.requests[0];
  assert.equal(req.url, '/v1beta/models/gemini-test:streamGenerateContent?alt=sse');
  assert.equal(req.url.includes(KEY), false);
  assert.equal(req.headers['x-goog-api-key'], KEY);
  const sent = JSON.parse(req.body);
  assert.deepEqual(sent.systemInstruction, { parts: [{ text: 'sys' }] });
  assert.deepEqual(sent.contents, [{ role: 'user', parts: [{ text: '안녕 🎮' }] }]);
  assert.equal(sent.generationConfig.responseMimeType, 'application/json');
  assert.equal(sent.tools[0].functionDeclarations[0].name, 'read_file');
});

test('Gemini: functionResponse uses the tool name; safety finish maps to content-filter', async t => {
  const fx = await fixture(t, stream('text/event-stream', sse([{ data: { candidates: [{ finishReason: 'SAFETY' }] } }])));
  const client = createAdapter(builtin('google'), { ...apiKey(), testOrigin: fx.origin });
  const events = await collect(client.stream({ model: 'g', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { p: 1 } }] }, { role: 'tool', toolCallId: 'c1', content: 'out' }] }));
  assert.deepEqual(events, [{ type: 'finish', reason: 'content-filter' }]);
  const sent = JSON.parse(fx.requests[0].body);
  assert.deepEqual(sent.contents[1], { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { p: 1 } } }] });
  assert.deepEqual(sent.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: 'out' } } }] });
});

test('Ollama: NDJSON chat with thinking, object tool arguments, done statistics; /api/tags catalog', async t => {
  const lines = [
    { message: { role: 'assistant', content: '', thinking: '흠' }, done: false },
    { message: { role: 'assistant', content: '읽어볼게요' }, done: false },
    { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'game.js' } } }] }, done: false },
    { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 6 },
  ].map(l => JSON.stringify(l)).join('\n') + '\n';
  const fx = await fixture(t, async (req, res) => {
    if (req.url === '/api/tags') return json(200, { models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }, { name: 'qwen3:8b', model: 'qwen3:8b' }] })(req, res);
    return stream('application/x-ndjson', lines, { size: 9 })(req, res);
  });
  const client = createAdapter(builtin('ollama'), { testOrigin: fx.origin });
  const events = await collect(client.stream({ ...toolReq, model: 'llama3.2:latest', reasoning: 'high', includeReasoning: true }));
  assert.deepEqual(events.map(e => e.type), ['reasoning-delta', 'text-delta', 'tool-call', 'usage', 'finish']);
  assert.deepEqual(events[2], { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: { path: 'game.js' } });
  assert.deepEqual(events[3].usage, { inputTokens: 30, outputTokens: 6, totalTokens: 36 });
  assert.equal(events[4].reason, 'tool-calls');
  const sent = JSON.parse(fx.requests[0].body);
  assert.equal(fx.requests[0].url, '/api/chat');
  assert.equal(sent.think, 'high');
  assert.equal(fx.requests[0].headers.authorization, undefined, 'local server gets no key');
  const models = await client.listModels();
  assert.deepEqual(models.map(m => m.address), ['ollama/llama3.2:latest', 'ollama/qwen3:8b']);
  assert.deepEqual(models[0].capabilities, { tools: null, vision: null, reasoning: null });
  await assert.rejects(collect(client.stream({ ...toolReq, model: 'x', toolChoice: 'required' })), { code: 'ADAPTER_UNSUPPORTED' });
});

test('Ollama: in-stream error line becomes a fixed error', async t => {
  const fx = await fixture(t, stream('application/x-ndjson', `${JSON.stringify({ error: `model not found ${SECRET_ECHO}` })}\n`));
  const client = createAdapter(builtin('ollama'), { testOrigin: fx.origin });
  await assert.rejects(collect(client.stream({ model: 'x', messages: [{ role: 'user', content: 'q' }] })), e => { assertClean(e); return e.code === 'PROVIDER_STREAM_ERROR'; });
});

test('HTTP errors map to fixed codes, bodies/keys never leak, and nothing is retried', async t => {
  const cases = [[401, 'PROVIDER_AUTH_FAILED'], [403, 'PROVIDER_FORBIDDEN'], [404, 'PROVIDER_NOT_FOUND'], [429, 'PROVIDER_RATE_LIMITED'], [500, 'PROVIDER_UNAVAILABLE'], [503, 'PROVIDER_UNAVAILABLE'], [400, 'PROVIDER_BAD_REQUEST']];
  let status = 401;
  const fx = await fixture(t, async (req, res) => { res.writeHead(status, { 'content-type': 'application/json', 'x-echo': SECRET_ECHO }); res.end(JSON.stringify({ error: { message: `${SECRET_ECHO} ${KEY}` } })); });
  const client = createAdapter(builtin('deepseek'), { ...apiKey(), testOrigin: fx.origin });
  for (const [code, expected] of cases) {
    status = code;
    const before = fx.requests.length;
    await assert.rejects(collect(client.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })), e => { assertClean(e, String(code)); assertClean(JSON.stringify(e.toJSON())); return e.code === expected && e.status === code; });
    assert.equal(fx.requests.length - before, 1, `no retry on ${code}`);
  }
});

test('context-overflow responses are classified locally without echoing the body', async t => {
  const fx = await fixture(t, json(400, { error: { code: 'context_length_exceeded', message: `This model's maximum context length ${SECRET_ECHO}` } }));
  const client = createAdapter(builtin('groq'), { ...apiKey(), testOrigin: fx.origin });
  await assert.rejects(collect(client.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })), e => { assertClean(e); return e.code === 'PROVIDER_CONTEXT_OVERFLOW'; });
});

test('redirects are refused, not followed', async t => {
  const target = await fixture(t, json(200, { data: [{ id: 'leak' }] }));
  const fx = await fixture(t, async (req, res) => { res.writeHead(307, { location: `${target.origin}/v1/models` }); res.end(); });
  const client = createAdapter(builtin('xai'), { ...apiKey(), testOrigin: fx.origin });
  await assert.rejects(client.listModels(), { code: 'PROVIDER_REDIRECT_REJECTED' });
  await assert.rejects(collect(client.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })), { code: 'PROVIDER_REDIRECT_REJECTED' });
  assert.equal(target.requests.length, 0, 'key never sent to redirect target');
});

test('credential getter: missing/invalid fail before network; called per operation so rotation applies', async t => {
  const fx = await fixture(t, json(200, { data: [] }));
  const noCreds = createAdapter(builtin('groq'), { testOrigin: fx.origin });
  await assert.rejects(collect(noCreds.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })), { code: 'ADAPTER_CREDENTIALS_MISSING' });
  await assert.rejects(noCreds.listModels(), { code: 'ADAPTER_CREDENTIALS_MISSING' });
  const none = createAdapter(builtin('groq'), { getCredentials: async () => ({ kind: 'none' }), testOrigin: fx.origin });
  await assert.rejects(none.listModels(), { code: 'ADAPTER_CREDENTIALS_MISSING' });
  const broken = createAdapter(builtin('groq'), { getCredentials: async () => { throw new Error(`${KEY} store path /home/someone`); }, testOrigin: fx.origin });
  await assert.rejects(broken.listModels(), e => { assertClean(e); return e.code === 'ADAPTER_CREDENTIALS_MISSING'; });
  const crlf = createAdapter(builtin('groq'), { ...apiKey('bad key\r\nx'), testOrigin: fx.origin });
  await assert.rejects(crlf.listModels(), { code: 'ADAPTER_CREDENTIALS_INVALID' });
  const chain = createAdapter(builtin('groq'), { getCredentials: async () => ({ kind: 'cloud-chain', configuration: {} }), testOrigin: fx.origin });
  await assert.rejects(chain.listModels(), { code: 'ADAPTER_CREDENTIALS_INVALID' });
  assert.equal(fx.requests.length, 0, 'no request without a valid credential');
  let n = 0;
  const signals = [];
  const rotating = createAdapter(builtin('groq'), { getCredentials: async ({ signal }) => { signals.push(signal); return { kind: 'api-key', apiKey: `${KEY}_${++n}` }; }, testOrigin: fx.origin });
  assert.equal(JSON.stringify(rotating).includes(KEY), false, 'client exposes no credential');
  assert.equal(Object.keys(rotating).includes('getCredentials'), false);
  const controller = new AbortController();
  await rotating.listModels({ signal: controller.signal });
  await rotating.listModels();
  assert.deepEqual(fx.requests.map(r => r.headers.authorization), [`Bearer ${KEY}_1`, `Bearer ${KEY}_2`]);
  assert.equal(signals[0], controller.signal, 'operation signal reaches the getter');
});

test('reasoning text stays private by default: one text-free reasoning-status per segment', async t => {
  const fx = await fixture(t, stream('text/event-stream', sse([
    { data: { choices: [{ delta: { reasoning_content: `${SECRET_ECHO} step 1` } }] } },
    { data: { choices: [{ delta: { reasoning_content: 'step 2' } }] } },
    { data: { choices: [{ delta: { content: 'answer' } }] } },
    { data: { choices: [{ delta: { reasoning_content: 'again' } }] } },
    { data: { choices: [{ delta: {}, finish_reason: 'stop' }] } }, '[DONE]'])));
  const client = createAdapter(builtin('deepseek'), { ...apiKey(), testOrigin: fx.origin });
  const events = await collect(client.stream({ model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'q' }] }));
  assert.deepEqual(events, [{ type: 'reasoning-status', status: 'reasoning' }, { type: 'text-delta', text: 'answer' }, { type: 'reasoning-status', status: 'reasoning' }, { type: 'finish', reason: 'stop' }]);
  assertClean(events);
});

test('cancellation aborts the in-flight stream, and breaking iteration closes the connection', async t => {
  let closed = 0;
  const fx = await fixture(t, async (req, res, raw) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    raw.socket.on('close', () => { closed += 1; });
    for (let i = 0; i < 200; i += 1) {
      if (res.destroyed) return;
      res.write(sse([{ data: { choices: [{ delta: { content: `t${i} ` } }] } }]));
      await delay(10);
    }
    res.end();
  });
  const controller = new AbortController();
  const client = createAdapter(builtin('cerebras'), { ...apiKey(), testOrigin: fx.origin });
  const seen = [];
  await assert.rejects((async () => {
    for await (const e of client.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }], signal: controller.signal })) {
      seen.push(e);
      if (seen.length === 3) controller.abort();
    }
  })(), { code: 'COMMAND_CANCELLED' });
  assert.ok(seen.length >= 3 && seen.length < 10);
  for await (const e of client.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })) { if (e.type === 'text-delta') break; }
  for (let i = 0; i < 50 && closed < 2; i += 1) await delay(20);
  assert.equal(closed, 2, 'both server sockets closed after abort/break');
  assert.equal(fx.requests.length, 2);
});

test('first-byte and idle timeouts end the stream with PROVIDER_TIMEOUT', async t => {
  const fx = await fixture(t, async (req, res) => {
    if (req.url.endsWith('/slow-start/chat/completions')) { await delay(400); res.writeHead(200); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse([{ data: { choices: [{ delta: { content: 'a' } }] } }]));
    await delay(600);
    res.end();
  });
  const client = createAdapter(builtin('sambanova'), { ...apiKey(), testOrigin: fx.origin, timeouts: { idleMs: 150, firstByteMs: 2000 } });
  const got = [];
  await assert.rejects((async () => { for await (const e of client.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })) got.push(e); })(), { code: 'PROVIDER_TIMEOUT' });
  assert.equal(got.length, 1);
  const custom = createAdapter({ id: 'slow', apiType: 'openai-chat', baseUrl: `${fx.origin}/slow-start`, options: { custom: true, allowLoopbackHttp: true } }, { timeouts: { firstByteMs: 150 } });
  await assert.rejects(collect(custom.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })), { code: 'PROVIDER_TIMEOUT' });
});

test('truncated streams and oversized streams fail closed', async t => {
  let mode = 'truncated';
  const fx = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'truncated') return res.end(sse([{ data: { choices: [{ delta: { content: 'partial' } }] } }]));
    if (mode === 'args') return res.end(sse([{ data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read_file', arguments: 'x'.repeat(1024 * 1024 + 10) } }] } }] } }]));
    return res.end(sse([{ data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read_file', arguments: '{"a":' } }] }, finish_reason: 'tool_calls' }] } }, '[DONE]']));
  });
  const client = createAdapter(builtin('togetherai'), { ...apiKey(), testOrigin: fx.origin });
  await assert.rejects(collect(client.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })), { code: 'PROVIDER_STREAM_ERROR' });
  mode = 'args';
  await assert.rejects(collect(client.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  mode = 'badjson';
  await assert.rejects(collect(client.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })), { code: 'PROVIDER_RESPONSE_INVALID' });
});

test('interleaved tool calls, duplicate IDs, refusal and length terminal outcomes', async t => {
  let mode = 'interleaved';
  const fx = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'interleaved') return res.end(sse([
      { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"path":' } }, { index: 1, id: 'call_b', function: { name: 'search_project', arguments: '{"q":' } }] } }] } },
      { data: { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"jump"}' } }, { index: 0, function: { arguments: '"a.js"}' } }] } }] } },
      { data: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } }, '[DONE]']));
    if (mode === 'duplicate') return res.end(sse([
      { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_same', function: { name: 'read_file', arguments: '{}' } }, { index: 1, id: 'call_same', function: { name: 'read_file', arguments: '{}' } }] } }] } },
      { data: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } }, '[DONE]']));
    if (mode === 'refusal') return res.end(sse([{ data: { type: 'message_start', message: { usage: { input_tokens: 3 } } } }, { data: { type: 'message_delta', delta: { stop_reason: 'refusal' } } }, { data: { type: 'message_stop' } }]));
    if (mode === 'nostop') return res.end(sse([{ data: { type: 'message_start', message: { usage: { input_tokens: 3 } } } }, { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } }]));
    return res.end(sse([{ data: { choices: [{ delta: { content: '{"files":' }, finish_reason: 'length' }] } }, '[DONE]']));
  });
  const chat = createAdapter(builtin('xai'), { ...apiKey(), testOrigin: fx.origin });
  const tools = [{ name: 'read_file', parameters: { type: 'object' } }, { name: 'search_project', parameters: { type: 'object' } }];
  const events = await collect(chat.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }], tools }));
  assert.deepEqual(events.filter(e => e.type === 'tool-call'), [{ type: 'tool-call', id: 'call_a', name: 'read_file', arguments: { path: 'a.js' } }, { type: 'tool-call', id: 'call_b', name: 'search_project', arguments: { q: 'jump' } }]);
  mode = 'duplicate';
  await assert.rejects(collect(chat.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }], tools })), { code: 'PROVIDER_RESPONSE_INVALID' });
  mode = 'length';
  assert.equal((await collect(chat.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] }))).at(-1).reason, 'length');
  const anthropic = createAdapter(builtin('anthropic'), { ...apiKey(), testOrigin: fx.origin });
  mode = 'refusal';
  assert.equal((await collect(anthropic.stream({ model: 'c', messages: [{ role: 'user', content: 'q' }] }))).at(-1).reason, 'content-filter');
  await assert.rejects(anthropic.runStage({ stage: 'design', model: 'c', instructions: 'x', input: {}, outputSchema: { type: 'object' }, maxOutputBytes: 100 }), { code: 'PROVIDER_CONTENT_FILTERED' });
  mode = 'nostop';
  await assert.rejects(collect(anthropic.stream({ model: 'c', messages: [{ role: 'user', content: 'q' }] })), { code: 'PROVIDER_STREAM_ERROR' });
  await assert.rejects(anthropic.runStage({ stage: 'design', model: 'c', instructions: 'x', input: {}, outputSchema: { type: 'object' }, maxOutputBytes: 100 }), { code: 'PROVIDER_STREAM_ERROR' }, 'truncated stream never becomes stage JSON');
});

test('catalogs: OpenAI-style, bare-array, OpenRouter metadata, Mistral capabilities; no fabricated caps', async t => {
  const fx = await fixture(t, async (req, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, {})(req, res);
    if (req.url === '/api/v1/models') return json(200, { data: [{ id: 'openai/gpt-x', name: 'GPT X', context_length: 400000, pricing: { prompt: '0.00000125', completion: '0.00001' }, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text', 'image'] } }, { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } }] })(req, res);
    if (req.url === '/v1/models' && req.headers['x-provider'] === 'together') return json(200, [{ id: 'meta/llama' }, { id: '../bad' }])(req, res);
    if (req.url === '/v1/models' && req.headers['x-provider'] === 'mistral') return json(200, { data: [{ id: 'mistral-large-latest', max_context_length: 131072, capabilities: { completion_chat: true, function_calling: true, vision: false, reasoning: false } }, { id: 'mistral-embed', capabilities: { completion_chat: false } }] })(req, res);
    return json(200, { object: 'list', data: [{ id: 'gpt-5.5', object: 'model', owned_by: 'openai' }] })(req, res);
  });
  const ctx = h => ({ ...apiKey(KEY, h), testOrigin: fx.origin });
  const or = await createAdapter(builtin('openrouter'), ctx()).listModels();
  assert.deepEqual(or[0], { id: 'openai/gpt-x', address: 'openrouter/openai/gpt-x', name: 'GPT X', provider: 'openrouter', capabilities: { tools: true, vision: true, reasoning: true }, contextWindow: 400000, maxOutputTokens: 128000, source: 'remote', inputCost: 1.25, outputCost: 10 });
  assert.equal(or[1].inputCost, undefined, 'variable pricing not invented');
  const openai = await createAdapter(builtin('openai'), ctx()).listModels();
  assert.deepEqual(openai, [{ id: 'gpt-5.5', address: 'openai/gpt-5.5', name: 'gpt-5.5', provider: 'openai', capabilities: { tools: null, vision: null, reasoning: null }, contextWindow: null, maxOutputTokens: null, source: 'remote' }]);
  const together = await createAdapter(builtin('togetherai'), ctx({ 'x-provider': 'together' })).listModels();
  assert.deepEqual(together.map(m => m.id), ['meta/llama']);
  const mistral = await createAdapter(builtin('mistral'), ctx({ 'x-provider': 'mistral' })).listModels();
  assert.deepEqual(mistral.map(m => [m.id, m.capabilities.tools, m.contextWindow]), [['mistral-large-latest', true, 131072]]);
  const none = createAdapter(builtin('fireworks'), ctx());
  assert.equal(none.capabilities.modelDiscovery, false);
  assert.deepEqual(await none.listModels(), [], 'no catalog → no fabricated models');
  assert.deepEqual(await none.validateAuth(), { ok: null, reason: 'no-read-endpoint' });
  assert.deepEqual(await createAdapter(builtin('openai'), ctx()).validateAuth(), { ok: true });
  assert.deepEqual(await createAdapter(builtin('openai'), { ...apiKey('wrong_key_value'), testOrigin: fx.origin }).validateAuth(), { ok: false, code: 'PROVIDER_AUTH_FAILED' });
});

test('catalogs: Anthropic after_id paging and Gemini pageToken paging with generateContent filter', async t => {
  const fx = await fixture(t, async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/v1/models') {
      if (!url.searchParams.get('after_id')) return json(200, { data: [{ id: 'claude-a', display_name: 'Claude A', max_input_tokens: 200000, max_tokens: 64000, capabilities: { image_input: { supported: true }, thinking: { supported: true } } }], has_more: true, last_id: 'claude-a' })(req, res);
      return json(200, { data: [{ id: 'claude-b', display_name: 'Claude B', max_input_tokens: null, max_tokens: null }], has_more: false, last_id: 'claude-b' })(req, res);
    }
    if (url.pathname === '/v1beta/models') {
      if (!url.searchParams.get('pageToken')) return json(200, { models: [{ name: 'models/gemini-x', displayName: 'Gemini X', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'], thinking: true }], nextPageToken: 'p2' })(req, res);
      return json(200, { models: [{ name: 'models/embedding-1', supportedGenerationMethods: ['embedContent'] }] })(req, res);
    }
    return json(404, {})(req, res);
  });
  const anthropic = await createAdapter(builtin('anthropic'), { ...apiKey(), testOrigin: fx.origin }).listModels();
  assert.deepEqual(anthropic.map(m => [m.address, m.capabilities.vision, m.capabilities.reasoning, m.capabilities.tools, m.contextWindow, m.maxOutputTokens]), [['anthropic/claude-a', true, true, null, 200000, 64000], ['anthropic/claude-b', null, null, null, null, null]]);
  assert.match(fx.requests[1].url, /after_id=claude-a/);
  const gemini = await createAdapter(builtin('google'), { ...apiKey(), testOrigin: fx.origin }).listModels();
  assert.deepEqual(gemini.map(m => [m.address, m.contextWindow, m.maxOutputTokens, m.capabilities.reasoning]), [['google/gemini-x', 1048576, 65536, true]]);
});

test('Azure OpenAI v1: api-key header, deployment as model, optional api-version, chat or responses wire', async t => {
  const fx = await fixture(t, stream('text/event-stream', sse([{ data: { type: 'response.output_text.delta', delta: 'hi' } }, { data: { type: 'response.completed', response: {} } }])));
  const client = createAdapter({ ...builtin('azure'), options: { resourceName: 'my-res', apiVersion: 'preview' } }, { ...apiKey(), testOrigin: fx.origin });
  const events = await collect(client.stream({ model: 'my-deployment', messages: [{ role: 'user', content: 'q' }] }));
  assert.equal(text(events), 'hi');
  const req = fx.requests[0];
  assert.equal(req.url, '/openai/v1/responses?api-version=preview');
  assert.equal(req.headers['api-key'], KEY);
  assert.equal(req.headers.authorization, undefined);
  assert.equal(JSON.parse(req.body).model, 'my-deployment');
  assert.deepEqual(await client.listModels(), [], 'deployments are user-configured');
  const chatFx = await fixture(t, stream('text/event-stream', sse([{ data: { choices: [{ delta: { content: 'c' }, finish_reason: 'stop' }] } }, '[DONE]'])));
  const chat = createAdapter({ ...builtin('azure'), options: { resourceName: 'my-res', wire: 'chat' }, models: ['dep-a'] }, { ...apiKey(), testOrigin: chatFx.origin });
  await collect(chat.stream({ model: 'dep-a', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 50 }));
  assert.equal(chatFx.requests[0].url, '/openai/v1/chat/completions');
  assert.equal(JSON.parse(chatFx.requests[0].body).max_completion_tokens, 50);
  assert.deepEqual((await chat.listModels()).map(m => [m.address, m.source]), [['azure/dep-a', 'configured']]);
});

test('custom endpoints: OpenAI Chat, OpenAI Responses and Anthropic-compatible shapes on explicit loopback', async t => {
  const fx = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url === '/llm/v1/chat/completions') return res.end(sse([{ data: { choices: [{ delta: { content: 'chat' }, finish_reason: 'stop' }] } }, '[DONE]']));
    if (req.url === '/llm/v1/responses') return res.end(sse([{ data: { type: 'response.output_text.delta', delta: 'resp' } }, { data: { type: 'response.completed', response: {} } }]));
    if (req.url === '/anth/v1/messages') return res.end(sse([{ data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'anth' } } }, { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } }, { data: { type: 'message_stop' } }]));
    res.end();
  });
  const make = (apiType, path, extra = {}) => createAdapter({ id: `local-${apiType}`, name: 'Local AI', apiType, baseUrl: `${fx.origin}${path}`, models: ['my-model'], options: { custom: true, allowLoopbackHttp: true, headers: { 'x-team': 'games' }, ...extra } }, { ...apiKey(KEY, { 'x-secret-header': SECRET_ECHO }) });
  const chat = make('openai-chat', '/llm/v1');
  assert.equal(text(await collect(chat.stream({ messages: [{ role: 'user', content: 'q' }], model: 'my-model' }))), 'chat');
  assert.equal(text(await collect(make('openai-responses', '/llm/v1').stream({ messages: [{ role: 'user', content: 'q' }], model: 'my-model' }))), 'resp');
  assert.equal(text(await collect(make('anthropic', '/anth/v1').stream({ messages: [{ role: 'user', content: 'q' }], model: 'my-model' }))), 'anth');
  assert.equal(fx.requests[0].headers['x-team'], 'games');
  assert.equal(fx.requests[0].headers['x-secret-header'], SECRET_ECHO);
  assert.equal(fx.requests[2].headers['x-api-key'], KEY);
  assert.deepEqual((await chat.listModels()).map(m => m.address), ['local-openai-chat/my-model']);
  assert.equal(chat.authMethods[0].experimental, true);
  const noModel = make('openai-chat', '/llm/v1');
  await assert.rejects(collect(noModel.stream({ messages: [{ role: 'user', content: 'q' }] })), { code: 'ADAPTER_MODEL_REQUIRED' });
  const withDefault = make('openai-chat', '/llm/v1', { defaultModel: 'my-model' });
  assert.equal(text(await collect(withDefault.stream({ messages: [{ role: 'user', content: 'q' }] }))), 'chat');
});

test('runStage: JSON collection, fenced output, schema in instructions, host validator, bounds, official flags', async t => {
  let reply = '```json\n{"files":[{"path":"src/main.js"}]}\n```';
  let finish = 'stop';
  const fx = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const half = Math.floor(reply.length / 2);
    res.end(sse([{ data: { choices: [{ delta: { content: reply.slice(0, half) } }] } }, { data: { choices: [{ delta: { content: reply.slice(half) }, finish_reason: finish }] } }, { data: { choices: [], usage: { prompt_tokens: 5, completion_tokens: 4 } } }, '[DONE]']));
  });
  const validated = [];
  const client = createAdapter({ ...builtin('openai'), apiType: 'openai-chat' }, { ...apiKey(), testOrigin: fx.origin, validateStageOutput: (stage, output) => { validated.push([stage, output]); return true; } });
  const schema = { type: 'object', required: ['files'], properties: { files: { type: 'array' } } };
  const stageRequest = { stage: 'design', model: 'gpt-5.5', instructions: 'Design the game.', input: { prompt: '점프 게임' }, outputSchema: schema, maxOutputBytes: 4096 };
  const result = await client.runStage(stageRequest);
  assert.deepEqual(result, { provider: 'openai', stage: 'design', output: { files: [{ path: 'src/main.js' }] }, usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 }, experimental: false, unofficial: false });
  assert.deepEqual(validated, [['design', { files: [{ path: 'src/main.js' }] }]]);
  const sent = JSON.parse(fx.requests[0].body);
  assert.match(sent.messages[0].content, /Design the game\.[\s\S]*"required":\["files"\]/);
  assert.deepEqual(JSON.parse(sent.messages[1].content), { stage: 'design', input: { prompt: '점프 게임' } });
  assert.deepEqual(sent.response_format, { type: 'json_schema', json_schema: { name: 'output', schema, strict: false } });
  assert.equal(sent.tools, undefined, 'stages never offer tools');
  reply = 'Sure! {"files":[]}';
  await assert.rejects(client.runStage(stageRequest), { code: 'STAGE_OUTPUT_INVALID' });
  reply = JSON.stringify({ blob: 'x'.repeat(5000) });
  await assert.rejects(client.runStage(stageRequest), { code: 'STAGE_OUTPUT_TOO_LARGE' });
  reply = '{"files":[]}'; finish = 'length';
  await assert.rejects(client.runStage(stageRequest), { code: 'STAGE_INCOMPLETE' });
  finish = 'stop';
  const rejecting = createAdapter({ ...builtin('openai'), apiType: 'openai-chat' }, { ...apiKey(), testOrigin: fx.origin, validateStageOutput: () => false });
  await assert.rejects(rejecting.runStage(stageRequest), { code: 'STAGE_OUTPUT_INVALID' });
  await assert.rejects(client.runStage({ ...stageRequest, maxOutputBytes: 10 * 1024 * 1024 }), { code: 'ADAPTER_REQUEST_INVALID' });
  await assert.rejects(client.runStage({ ...stageRequest, model: undefined }), { code: 'ADAPTER_MODEL_REQUIRED' });
});

test('runStage: implementation-sized output (>512 KiB, ≤1,600,000 bytes) streams through; cap enforced mid-stream', async t => {
  const content = 'const level = 1;\n'.repeat(80_000); // ~1.36 MB
  const payload = JSON.stringify({ files: [{ path: 'src/game.js', content }] });
  let sentChunks = 0;
  const fx = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < payload.length; i += 16_000) {
      if (res.destroyed) return;
      sentChunks += 1;
      if (!res.write(sse([{ data: { type: 'response.output_text.delta', delta: payload.slice(i, i + 16_000) } }]))) await once(res, 'drain');
      await delay(2);
    }
    res.end(sse([{ data: { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 400000 } } } }]));
  });
  const schema = { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string', maxLength: 1_600_000 } } } } } };
  const client = createAdapter(builtin('openai'), { ...apiKey(), testOrigin: fx.origin });
  const request = { stage: 'implementation', model: 'gpt-5.5', instructions: 'Implement the game.', input: { plan: 'x' }, outputSchema: schema, maxOutputBytes: 1_600_000 };
  assert.ok(Buffer.byteLength(payload) > 512 * 1024 && Buffer.byteLength(payload) <= 1_600_000);
  const result = await client.runStage(request);
  assert.equal(result.output.files[0].content.length, content.length);
  assert.equal(JSON.parse(fx.requests[0].body).text.format.type, 'json_schema');
  const total = sentChunks;
  sentChunks = 0;
  await assert.rejects(client.runStage({ ...request, maxOutputBytes: 600_000 }), { code: 'STAGE_OUTPUT_TOO_LARGE' });
  assert.ok(sentChunks < total, 'request cancelled once the cap was exceeded');
  await assert.rejects(client.runStage({ ...request, outputSchema: { $ref: '#/definitions/x' } }), { code: 'ADAPTER_REQUEST_INVALID' });
  await assert.rejects(client.runStage({ ...request, outputSchema: { type: 'object', required: ['other'] } }), { code: 'STAGE_OUTPUT_INVALID' });
  const hostRejectsSchema = createAdapter(builtin('openai'), { ...apiKey(), testOrigin: fx.origin, validateStageSchema: () => false });
  const before = fx.requests.length;
  await assert.rejects(hostRejectsSchema.runStage(request), { code: 'ADAPTER_REQUEST_INVALID' });
  assert.equal(fx.requests.length, before, 'schema refusal precedes the network');
});

test('ZUKU native: scoped OAuth catalog follows the server-owned contract and available models', async t => {
  const { NATIVE_CONTRACT, NATIVE_CONTRACT_SHA, NATIVE_PACK_SHA } = await import('../lib/provider-system/adapters/zuku-stage.mjs');
  const token = `zuku_oa_${'a'.repeat(64)}`;
  const fx = await fixture(t, async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, {success:false})(req,res);
    return json(200,{success:true,data:{provider:'zuku',contract_version:NATIVE_CONTRACT,contract_sha256:NATIVE_CONTRACT_SHA,skill_pack_sha256:NATIVE_PACK_SHA,billing:{pool:'aist',unit:'tokens',paid_checkout:false},models:[{id:'zuku/game-coder',name:'Game coder',available:true},{id:'unavailable',available:false}],default_model:'auto'}})(req,res);
  });
  const client=createAdapter(builtin('zuku'),{...bearer(token),testOrigin:fx.origin});
  const models=await client.listModels();
  assert.deepEqual(models.map(m=>[m.address,m.source]),[['zuku/auto','remote'],['zuku/game-coder','remote']]);
  assertClean(models);assert.equal(fx.requests[0].url,'/api/v1/oauth/game-agent/models');
  await assert.rejects(collect(client.stream({model:'auto',messages:[{role:'user',content:'game'}]})),{code:'ADAPTER_NATIVE_UNAVAILABLE'});
  await assert.rejects(createAdapter(builtin('zuku'),{...bearer(`${KEY}_user_jwt`),testOrigin:fx.origin}).listModels(),{code:'ADAPTER_CREDENTIALS_INVALID'});
  await assert.rejects(createAdapter(builtin('zuku'),{testOrigin:fx.origin}).listModels(),{code:'ADAPTER_CREDENTIALS_MISSING'});
  assert.equal(fx.requests.length,1,'legacy USER JWT and unsupported stream never dispatch');
  assert.equal(client.capabilities.tools,false);assert.equal(client.capabilities.streaming,false);
});

test('Codex experimental wrapper: real constructor shapes, opt-in only, always experimental/unofficial', async () => {
  const calls = [];
  const codexModules = {
    createCodexOAuth: options => { calls.push(['oauth', options]); return { status: async opts => ({ authenticated: true, opts }) }; },
    createCodexResponsesProvider: options => {
      calls.push(['provider', Object.keys(options)]);
      return { runStage: async r => { calls.push(['run', r.model, r.stage]); return { output: { a: 1 }, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, extra: 'x' }, experimental: false, unofficial: false }; } };
    },
  };
  const client = createAdapter(builtin('codex'), { codexModules, ...apiKey() });
  const result = await client.runStage({ stage: 'code', model: 'gpt-5.5-codex', instructions: 'x', input: {}, outputSchema: {}, maxOutputBytes: 10 });
  assert.deepEqual(result, { provider: 'codex', stage: 'code', output: { a: 1 }, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, experimental: true, unofficial: true });
  assert.deepEqual(calls.slice(0, 3), [['oauth', {}], ['provider', ['oauth']], ['run', 'gpt-5.5-codex', 'code']], 'default store path preserved; no generic credentials passed');
  assert.deepEqual(await client.validateAuth(), { ok: true });
  assert.equal(client.capabilities.streaming, false);
  await assert.rejects(collect(client.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })), { code: 'ADAPTER_UNSUPPORTED' });
  const isolated = createAdapter(builtin('codex'), { codexModules, codexStorePath: '/tmp/isolated-fixture/codex-oauth.json' });
  await isolated.runStage({ stage: 'code', model: 'm' });
  assert.deepEqual(calls.filter(c => c[0] === 'oauth').at(-1), ['oauth', { storePath: '/tmp/isolated-fixture/codex-oauth.json' }]);
  const missing = createAdapter(builtin('codex'), {});
  await assert.rejects(missing.runStage({ stage: 'code', model: 'm' }), { code: 'ADAPTER_CODEX_UNAVAILABLE' });
  await assert.rejects(client.runStage({ stage: 'code' }), { code: 'ADAPTER_MODEL_REQUIRED' });
});
