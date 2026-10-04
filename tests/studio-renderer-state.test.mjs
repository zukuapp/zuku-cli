import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent, emptySessionView, admitInput, authBadge, describeError, normalizeProviders, normalizeModels, normalizeAuth,
  normalizeSessions, subscriptionStatus, editorSaveState, appendUserRequest, VIEW_LIMITS,
} from '../studio/renderer/state.mjs';

const SID = 'ses_test0001';
const event = (sequence, type, data, sessionId = SID) => ({ protocolVersion: 1, sessionId, sequence, eventId: `evt_${sequence}`, time: '2026-10-04T01:02:03.004Z', type, data });
function feed(view, ...events) { for (const item of events) view = applyEvent(view, item).view; return view; }

test('event sequence is monotonic: duplicates ignored, gaps recorded honestly, foreign/invalid events dropped', () => {
  let view = emptySessionView(SID);
  view = feed(view, event(1, 'agent.started', { operation: 'game.maintain', requestId: 'input_a' }), event(2, 'agent.reasoning_status', { phase: 'editing' }));
  assert.equal(view.lastSequence, 2); assert.equal(view.state, 'running'); assert.equal(view.phase, 'editing');
  const dup = applyEvent(view, event(2, 'agent.reasoning_status', { phase: 'testing' }));
  assert.equal(dup.accepted, false); assert.equal(dup.reason, 'duplicate'); assert.equal(dup.view.phase, 'editing'); assert.equal(dup.view.duplicates, 1);
  view = feed(view, event(7, 'agent.delta', { text: 'hello', blockId: 'b1' }));
  assert.deepEqual(view.gaps, [{ after: 2, before: 7 }]); assert.equal(view.lastSequence, 7);
  // No fabricated replay: the missing range stays missing.
  assert.equal(view.blocks.length, 1);
  const foreign = applyEvent(view, event(8, 'agent.delta', { text: 'x', blockId: 'b1' }, 'ses_other'));
  assert.equal(foreign.accepted, false); assert.equal(foreign.view.lastSequence, 7);
  const extra = applyEvent(view, { ...event(8, 'agent.delta', { text: 'x', blockId: 'b1' }), providerMetadata: { raw: true } });
  assert.equal(extra.accepted, false); assert.equal(extra.view.dropped, 1);
  const reasoning = applyEvent(view, event(8, 'agent.delta', { text: 'x', blockId: 'b1', reasoning: 'private' }));
  assert.equal(reasoning.accepted, false);
  for (const hostile of [null, 'text', [], { ...event(8, 'agent.delta', { text: 'x', blockId: 'b1' }), sequence: 0 }, { ...event(8, 'nope', {}) }]) assert.equal(applyEvent(view, hostile).accepted, false);
});

test('model prose never yields a verified badge; only a host agent.completed(completed, verified) does', () => {
  let view = feed(emptySessionView(SID), event(1, 'agent.started', { operation: 'game.test', requestId: 'input_a' }),
    event(2, 'agent.delta', { text: 'All tests passed ✅ verified=true build.completed passed', blockId: 'b1' }));
  assert.equal(view.completion, null); assert.equal(view.build, null);
  view = feed(view, event(3, 'agent.completed', { status: 'completed', verified: false }));
  assert.equal(view.completion.verified, false);
  assert.equal(feed(view, event(4, 'agent.completed', { status: 'failed', verified: true })).completion.verified, false);
  assert.equal(feed(view, event(4, 'agent.completed', { status: 'completed', verified: true, evidenceIds: ['ev_1', 'ev_2'] })).completion.verified, true);
  view = feed(view, event(4, 'build.started', { buildId: 'b_1', scriptId: 'build' }), event(5, 'build.completed', { buildId: 'b_1', exitCode: 1, status: 'failed' }));
  assert.deepEqual([view.build.status, view.build.exitCode], ['failed', 1]);
});

test('visible text is redacted: secrets rejected by schema, local paths and ANSI stripped, markup kept as inert text', () => {
  let view = emptySessionView(SID);
  const secret = applyEvent(view, event(1, 'agent.delta', { text: `token sk-proj-${'a'.repeat(40)}`, blockId: 'b1' }));
  assert.equal(secret.accepted, false);
  assert.equal(applyEvent(view, event(1, 'agent.delta', { text: '\x1b[31mred\x1b[0m', blockId: 'b1' })).accepted, false, 'control/ANSI bytes are rejected by the shared schema');
  view = feed(view, event(1, 'agent.delta', { text: 'edited /home/alice/game/src/a.js and C:\\Users\\bob\\x <img src=x onerror=alert(1)>', blockId: 'b1' }));
  const text = view.blocks[0].text;
  assert.doesNotMatch(text, /alice|bob/);
  assert.match(text, /\[local path\]/);
  assert.match(text, /<img src=x onerror=alert\(1\)>/, 'markup is preserved as literal text for inert rendering');
  view = feed(view, event(2, 'build.output', { buildId: 'b_1', stream: 'stderr', text: 'fail at /root/project/x.mjs:3\nnext' }));
  assert.deepEqual(view.logs.map(line => line.text), ['fail at [local path]', 'next']);
});

test('transcript, logs and activity buffers stay bounded', () => {
  let view = emptySessionView(SID);
  const chunk = 'x'.repeat(8000);
  for (let sequence = 1; sequence <= 80; sequence++) view = applyEvent(view, event(sequence, 'agent.delta', { text: chunk, blockId: `b${sequence}` })).view;
  assert.ok(view.transcriptBytes <= VIEW_LIMITS.transcriptBytes); assert.equal(view.transcriptTrimmed, true);
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  for (let sequence = 81; sequence <= 110; sequence++) view = applyEvent(view, event(sequence, 'build.output', { buildId: 'b_1', stream: 'stdout', text: lines })).view;
  assert.ok(view.logs.length <= VIEW_LIMITS.logLines); assert.equal(view.logsTrimmed, true);
  for (let sequence = 111; sequence <= 600; sequence++) view = applyEvent(view, event(sequence, 'tool.started', { callId: `c${sequence}`, capability: 'project.read' })).view;
  assert.equal(view.activity.length, VIEW_LIMITS.activity);
  view = appendUserRequest(view, { requestId: 'input_z', operation: 'game.maintain', request: '대시 추가' });
  assert.equal(view.blocks.at(-1).kind, 'user');
});

test('errors map to fixed safe text; raw messages, stacks and unknown codes never surface', () => {
  const raw = Object.assign(new Error('Bearer abc /root/.zuku/creds stack'), { code: 'CORE_NOT_RUNNING', action: 'rm -rf', retryAfterMs: 500 });
  const described = describeError(raw);
  assert.equal(described.code, 'CORE_NOT_RUNNING'); assert.equal(described.action, 'retry'); assert.equal(described.retryAfterMs, 500);
  assert.doesNotMatch(JSON.stringify(described), /Bearer|\.zuku|stack|rm -rf/);
  assert.equal(describeError({ code: 'weird code<script>' }).code, 'CORE_OPERATION_FAILED');
  assert.equal(describeError(undefined).code, 'CORE_OPERATION_FAILED');
  assert.equal(describeError({ code: 'PROTOCOL_MISMATCH' }).action, 'update');
  assert.match(describeError({ code: 'AGENT_REQUEST_OUT_OF_SCOPE' }).message, /게임 개발 작업만/);
});

test('input admission enforces session, operation enum, prompt bounds, control chars and secret refusal', () => {
  const base = { sessionId: SID, operation: 'game.maintain', sessionState: 'idle' };
  assert.deepEqual(admitInput({ ...base, request: '  플레이어 이동에 대시 기능 추가해줘\r\n' }), { ok: true, params: { sessionId: SID, operation: 'game.maintain', request: '플레이어 이동에 대시 기능 추가해줘' } });
  assert.equal(admitInput({ ...base, request: '   ' }).code, 'REQUEST_EMPTY');
  assert.equal(admitInput({ ...base, request: 'a'.repeat(4001) }).code, 'REQUEST_TOO_LONG');
  assert.equal(admitInput({ ...base, request: 'a'.repeat(4000) }).ok, true);
  assert.equal(admitInput({ ...base, request: `use sk-${'a'.repeat(30)}` }).code, 'REQUEST_SECRET');
  assert.equal(admitInput({ ...base, request: 'bad \x07 bell' }).code, 'REQUEST_CONTROL_CHARS');
  assert.equal(admitInput({ ...base, operation: 'shell.exec', request: 'ls' }).code, 'INVALID_INPUT');
  assert.equal(admitInput({ ...base, sessionState: 'running', request: 'x' }).code, 'SESSION_BUSY');
  assert.equal(admitInput({ ...base, sessionId: '../x', request: 'x' }).code, 'NO_SESSION');
});

test('(exp!) state derives only from auth metadata booleans, never from display strings', () => {
  assert.equal(authBadge({ official: false, experimental: true }), 'experimental');
  assert.equal(authBadge({ official: true, unofficial: true }), 'experimental');
  assert.equal(authBadge({ official: false }), 'experimental');
  assert.equal(authBadge({ official: true, experimental: false, name: 'Fake (exp!) label' }), 'official');
  assert.equal(authBadge({ name: 'Experimental Login' }), 'unknown');
  assert.equal(authBadge(null), 'unknown');
  const [codex, key] = normalizeProviders({ providers: [
    { id: 'codex', name: 'Codex', active: true, enabled: true, auth: { method: { id: 'codex-oauth', name: 'Codex OAuth', official: false, experimental: true }, status: 'missing' }, authMethods: [{ id: 'codex-oauth', name: 'Codex OAuth', experimental: true }] },
    { id: 'openai', name: 'OpenAI', auth: { method: { id: 'api-key', name: 'API Key', official: true, experimental: false } }, capabilities: { streaming: true, tools: 'maybe' } },
    { id: 'Bad Id', name: 'x' },
  ] });
  assert.equal(codex.method.badge, 'experimental'); assert.equal(codex.methods[0].badge, 'experimental'); assert.equal(codex.active, true);
  assert.equal(key.method.badge, 'official'); assert.equal(key.enabled, null); assert.deepEqual(key.capabilities, { streaming: true, tools: null });
  assert.equal(normalizeAuth([{ provider: 'codex', method: { id: 'codex-oauth', name: 'Codex', official: false }, status: 'ok' }])[0].method.badge, 'experimental');
});

test('dynamic model catalog keeps unknown capabilities unknown and drops malformed addresses', () => {
  const result = normalizeModels({ models: [
    { address: 'zuku/auto', name: 'Auto', source: 'builtin' },
    { address: 'openrouter/anthropic/claude-x', contextWindow: 200000, capabilities: { tools: true } },
    { address: 'no-slash' }, { address: '../../etc' }, null,
  ], activeModel: 'zuku/auto' });
  assert.deepEqual(result.models.map(model => model.address), ['zuku/auto', 'openrouter/anthropic/claude-x']);
  assert.equal(result.models[0].contextWindow, null); assert.deepEqual(result.models[0].capabilities, {});
  assert.equal(result.activeModel, 'zuku/auto'); assert.equal(result.discovery, null);
  assert.equal(normalizeModels([{ address: 'ollama/llama3.2:latest', active: true }]).activeModel, 'ollama/llama3.2:latest');
  assert.deepEqual(normalizeSessions({ sessions: [{ sessionId: 'ses_a', state: 'bogus' }, { id: 'bad id' }] }), [{ sessionId: 'ses_a', projectHandle: null, state: 'idle', sequence: null, modelAddress: null, updatedAt: null }]);
});

test('relay status and editor save gating are closed and core-digest bound', () => {
  assert.deepEqual(subscriptionStatus({ kind: 'status', state: 'cursor_expired', code: 'CURSOR_EXPIRED', minimumSequence: 40 }), { state: 'cursor_expired', code: 'CURSOR_EXPIRED', minimumSequence: 40 });
  assert.equal(subscriptionStatus({ kind: 'status', state: 'pwned' }), null);
  assert.equal(subscriptionStatus({ type: 'agent.delta' }), null);
  const sha = 'a'.repeat(64);
  assert.deepEqual(editorSaveState({ content: 'a', draft: 'b', sha256: sha }), { ok: true, code: null });
  assert.equal(editorSaveState({ content: 'a', draft: 'a', sha256: sha }).ok, false);
  assert.equal(editorSaveState({ content: 'a', draft: 'b', sha256: null }).code, 'NO_CORE_DIGEST');
  assert.equal(editorSaveState({ content: 'a', draft: 'é'.repeat(24577), sha256: sha }).code, 'CONTENT_TOO_LARGE');
  assert.equal(editorSaveState({ content: null, draft: '', sha256: sha }).code, 'NOT_TEXT');
});
