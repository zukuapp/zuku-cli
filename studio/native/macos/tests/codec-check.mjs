// Runs the macOS shell's private admission codec on any OS with Node 22+.
// It assembles schema.mjs + native-codec.js exactly as ProtocolCodec.swift does and
// evaluates the result in an isolated vm context with no Node globals. This checks the
// shared JavaScript admission logic only; it does not build or run any macOS code.
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

const root = new URL('../../../../', import.meta.url);
const schema = readFileSync(new URL('lib/agent-protocol/schema.mjs', root), 'utf8');
const codecSource = readFileSync(new URL('studio/native/macos/Resources/native-codec.js', root), 'utf8');

// Mirror of ProtocolCodec.assemble(schema:codec:) — keep the two byte-for-byte equivalent.
export function assemble(schemaText, codecText) {
  if (/^import[ \t]/m.test(schemaText) || /^import[ \t]/m.test(codecText) || /^export[ \t]/m.test(codecText)) return null;
  const body = schemaText.replace(/^export[ \t]+/gm, '');
  return "(function(){'use strict';const TextEncoder=class{encode(value){let length=0;for(const c of String(value)){const n=c.codePointAt(0);length+=n<128?1:n<2048?2:n<65536?3:4;}return {length};}};\n"
    + body + '\n' + codecText + '\nreturn ZukuNativeCodec;})()';
}

const script = assemble(schema, codecSource);
assert.ok(script, 'schema/codec must have no import statements');
const codec = runInContext(script, createContext(Object.create(null)), { timeout: 2000 });
const json = value => JSON.stringify(value);
const renderer = (method, params, extra = {}) => codec.admitRenderer(json({ protocolVersion: 1, id: 'ui_0123', method, params, ...extra }));
let checks = 0;
const check = (label, fn) => { fn(); checks++; void label; };

check('core forward', () => {
  const out = renderer('project.list', {});
  assert.equal(out.kind, 'forward'); assert.equal(out.method, 'project.list'); assert.equal(out.params, '{}');
  const input = renderer('session.input', { sessionId: 'session_1', requestId: 'input_1', operation: 'game.maintain', request: '플레이어 대시 추가', experimental: false });
  assert.equal(input.kind, 'forward');
});
check('private methods refused', () => {
  for (const method of ['project.grant', 'native.projectChosen', 'native.resolvePreview', 'native.pairingDecision', 'native.authResponse', 'preview.read', 'studio.open'])
    assert.deepEqual({ ...renderer(method, { requestId: 'x', allow: true }) }, { kind: 'reject', id: 'ui_0123', code: 'NATIVE_PERMISSION_REQUIRED' });
  assert.equal(renderer('pair.decide', {}).code, 'METHOD_NOT_ALLOWED');
});
check('secret fields refused', () => {
  assert.equal(renderer('auth.request', { providerId: 'codex', experimental: true, apiKey: 'x' }).kind, 'reject');
  assert.equal(renderer('session.input', { sessionId: 's', requestId: 'r', operation: 'game.maintain', request: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123' }).kind, 'reject');
  assert.equal(renderer('session.input', { sessionId: 's', requestId: 'r', operation: 'game.maintain', request: 'x', command: 'cat /etc/passwd' }).kind, 'reject');
});
check('envelope shape', () => {
  assert.equal(codec.admitRenderer('[]'), null);
  assert.equal(codec.admitRenderer('{'), null);
  assert.equal(codec.admitRenderer(json({ protocolVersion: 1, id: 'bad id', method: 'hello', params: {} })), null);
  assert.equal(codec.admitRenderer(json({ protocolVersion: 1, id: 'ui_1', method: 'hello', params: {}, extra: 1 })), null);
  assert.equal(renderer('hello', {}, { protocolVersion: 2 }).code, 'PROTOCOL_MISMATCH');
  assert.equal(codec.admitRenderer('x'.repeat(65537)), null);
});
check('native methods', () => {
  assert.equal(renderer('native.pickProject', {}).kind, 'pickProject');
  assert.equal(renderer('native.pickProject', { localPath: '/etc' }).kind, 'reject');
  assert.equal(renderer('native.previewHide', {}).kind, 'previewHide');
  const show = renderer('native.previewShow', { previewHandle: 'preview_1', rect: { x: 0, y: 10, width: 320, height: 240 } });
  assert.equal(show.kind, 'previewShow'); assert.equal(show.width, 320);
  assert.equal(renderer('native.previewShow', { previewHandle: 'preview_1', rect: { x: 0, y: 0, width: 8, height: 240 } }).kind, 'reject');
  assert.equal(renderer('native.previewShow', { previewHandle: 'preview_1', url: 'http://evil', rect: { x: 0, y: 0, width: 80, height: 80 } }).kind, 'reject');
  const sub = renderer('native.subscribe', { subscriptionId: 'sub_1', sessionId: 'session_1', afterSequence: 4 });
  assert.equal(sub.kind, 'forward'); assert.deepEqual(JSON.parse(sub.params), { subscriptionId: 'sub_1', sessionId: 'session_1', afterSequence: 4 });
  assert.equal(renderer('native.subscribe', { subscriptionId: 'sub_1', sessionId: 'session_1', afterSequence: -1 }).kind, 'reject');
  assert.equal(renderer('native.unsubscribe', { subscriptionId: 'sub_1' }).kind, 'forward');
});
check('host responses projected', () => {
  const out = codec.admitHost(json({ protocolVersion: 1, id: 'ui_1', result: { projectHandle: 'project_1', name: 'Game', path: '/Users/me/game', apiKey: 'synthetic-secret', url: 'http://127.0.0.1:4000/p/0123456789abcdef0123456789abcdef/' } }));
  assert.equal(out.kind, 'response'); assert.equal(out.errorCode, null);
  assert.doesNotMatch(out.result, /synthetic-secret|\/Users|127\.0\.0\.1/);
  assert.equal(out.previewURL, 'http://127.0.0.1:4000/p/0123456789abcdef0123456789abcdef/');
  assert.equal(codec.admitHost(json({ protocolVersion: 1, id: 'ui_1', error: { code: 'lower', message: '/secret' } })).errorCode, 'CORE_OPERATION_FAILED');
  assert.equal(codec.admitHost(json({ protocolVersion: 1, id: 'ui_1', error: { code: 'SESSION_BUSY' } })).errorCode, 'SESSION_BUSY');
  assert.equal(codec.admitHost(json({ protocolVersion: 2, id: 'ui_1', result: {} })), null);
  assert.equal(codec.admitHost('not json'), null);
});
check('preview URL', () => {
  const ok = 'http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/';
  assert.equal(codec.previewURL(ok), ok);
  for (const bad of ['https://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/', 'http://localhost:45678/p/0123456789abcdef0123456789abcdef/', ok + '?t=1', ok + '#x', 'http://u@127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/', 'http://127.0.0.1:99999/p/0123456789abcdef0123456789abcdef/', 'http://127.0.0.1:45678/p/0123456789ABCDEF0123456789abcdef/', 'http://127.0.0.1:45678/private', 'file:///etc/passwd'])
    assert.equal(codec.previewURL(bad), null, bad);
});
check('subscriptions', () => {
  const event = { protocolVersion: 1, sessionId: 'session_1', sequence: 3, eventId: 'event_3', time: '2026-10-04T00:00:00.000Z', type: 'agent.delta', data: { text: 'hi', blockId: 'b1' } };
  const out = codec.admitHost(json({ protocolVersion: 1, type: 'native.subscription', data: { subscriptionId: 'sub_1', event } }));
  assert.equal(out.kind, 'deliver'); assert.deepEqual(JSON.parse(out.message).data.event, event);
  assert.equal(codec.admitHost(json({ protocolVersion: 1, type: 'native.subscription', data: { subscriptionId: 'sub_1', event: { ...event, type: 'shell.exec' } } })).kind, 'ignored');
  const status = codec.admitHost(json({ protocolVersion: 1, type: 'native.subscription', data: { subscriptionId: 'sub_1', status: { kind: 'status', state: 'cursor_expired', minimumSequence: 9, extra: 'x' } } }));
  assert.equal(status.kind, 'ignored');
  const status2 = codec.admitHost(json({ protocolVersion: 1, type: 'native.subscription', data: { subscriptionId: 'sub_1', status: { kind: 'status', state: 'cursor_expired', minimumSequence: 9 } } }));
  assert.deepEqual(JSON.parse(status2.message).data.status, { kind: 'status', state: 'cursor_expired', minimumSequence: 9 });
});
check('prompts', () => {
  const pairing = { requestId: 'pair_1', challengeId: 'challenge_1', origin: 'https://ai.zuzunza.com', purpose: 'browser.connect', expiresAt: 1 };
  assert.equal(codec.admitHost(json({ protocolVersion: 1, type: 'native.pairing', data: pairing })).kind, 'pairing');
  assert.equal(codec.admitHost(json({ protocolVersion: 1, type: 'native.pairing', data: { ...pairing, origin: 'https://evil.example' } })).kind, 'pairingInvalid');
  const auth = { requestId: 'auth_1', providerId: 'codex', methodId: 'chatgpt', question: 'Paste the code', expiresAt: 1, official: false, experimental: true };
  const admitted = codec.admitHost(json({ protocolVersion: 1, type: 'native.auth', data: auth }));
  assert.equal(admitted.kind, 'auth'); assert.equal(admitted.experimental, true);
  assert.equal(codec.admitHost(json({ protocolVersion: 1, type: 'native.auth', data: { ...auth, experimental: undefined, official: undefined } })).experimental, false, 'no badge without metadata');
  assert.equal(codec.admitHost(json({ protocolVersion: 1, type: 'native.auth', data: { ...auth, question: 'a‮b' } })).kind, 'authInvalid');
  assert.equal(codec.admitHost(json({ protocolVersion: 1, type: 'native.auth', data: { ...auth, html: '<b>' } })).kind, 'authInvalid');
  assert.equal(codec.admitHost(json({ protocolVersion: 1, type: 'native.authClosed', data: { requestId: 'auth_1' } })).kind, 'promptClosed');
  assert.equal(codec.admitHost(json({ protocolVersion: 1, type: 'native.unknown', data: {} })).kind, 'ignored');
});
console.log(`macOS native codec: ${checks} check groups passed (shared schema in isolated vm; no macOS build).`);
