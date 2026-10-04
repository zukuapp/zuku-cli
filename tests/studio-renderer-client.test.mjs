import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createStudioClient, createRequestId, validateParams, RENDERER_METHODS, StudioClientError } from '../studio/renderer/client.mjs';
import { previewRect, createPreviewController } from '../studio/renderer/preview.mjs';

const SID = 'ses_test0001';
const valid = sequence => ({ protocolVersion: 1, sessionId: SID, sequence, eventId: `evt_${sequence}`, time: '2026-10-04T01:02:03.004Z', type: 'agent.reasoning_status', data: { phase: 'testing' } });
function fakeBridge(handler = async () => ({ ok: true })) {
  const calls = [], subs = [];
  return { calls, subs, call: async (method, params) => { calls.push([method, params]); return handler(method, params); },
    subscribe(params, onMessage) { const sub = { params, onMessage, detached: 0 }; subs.push(sub); return () => { sub.detached++; }; } };
}

test('request IDs are crypto-random, schema-safe and unique', () => {
  const ids = new Set(Array.from({ length: 500 }, () => createRequestId('input')));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^input_[A-Za-z0-9_-]{24}$/);
  const fixed = createRequestId('req', { getRandomValues: array => array.fill(255) });
  assert.equal(fixed, 'req_________________________');
  assert.throws(() => createRequestId('req', {}), { code: 'CORE_UNAVAILABLE' });
  assert.throws(() => createRequestId('Bad!'), { code: 'CORE_UNAVAILABLE' });
});

test('only typed core methods with shared-schema-valid params reach the bridge', () => {
  for (const method of ['project.grant', 'preview.read', 'provider.add', 'provider.remove', 'exec', 'studio.open', '__proto__']) assert.throws(() => validateParams(method, {}), { code: 'METHOD_NOT_ALLOWED' });
  assert.ok(!RENDERER_METHODS.includes('project.grant'));
  for (const path of ['../secret', '/etc/passwd', 'C:\\x', '.env', 'src/../../x', 'node_modules/a.js', 'credentials/key']) assert.throws(() => validateParams('project.read', { projectHandle: 'prj_a', path }), { code: 'INVALID_INPUT' });
  assert.deepEqual(validateParams('project.read', { projectHandle: 'prj_a', path: 'src/player.mjs' }), { projectHandle: 'prj_a', path: 'src/player.mjs' });
  assert.throws(() => validateParams('project.patch', { projectHandle: 'prj_a', path: 'a.js', content: 'x', expectedSha256: 'nothex' }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateParams('session.input', { sessionId: SID, requestId: 'input_a', operation: 'shell', request: 'ls' }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateParams('session.input', { sessionId: SID, requestId: 'input_a', operation: 'game.maintain', request: 'x', localPath: '/home' }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateParams('provider.configure', { providerId: 'openai', patch: { apiKey: 'sk-x' } }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateParams('auth.request', { providerId: 'openai', methodId: 'api-key', accessToken: 'x' }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateParams('provider.enable', { providerId: 'openai' }, { native: false }), { code: 'NATIVE_PERMISSION_REQUIRED' });
  assert.doesNotThrow(() => validateParams('provider.enable', { providerId: 'openai' }));
  assert.doesNotThrow(() => validateParams('model.use', { modelAddress: 'openrouter/anthropic/claude-x' }));
});

test('client unwraps results and replaces raw bridge errors with safe codes', async () => {
  const bridge = fakeBridge(async method => {
    if (method === 'hello') return { protocolVersion: 1 };
    throw Object.assign(new Error('refresh_token=abcdefghijkl at /root/.zuku/x'), { code: 'AUTH_REQUIRED', action: 'login', stack: 'secret stack' });
  });
  const client = createStudioClient(bridge);
  assert.deepEqual(await client.call('hello', {}), { protocolVersion: 1 });
  await assert.rejects(client.call('auth.list', {}), error => error instanceof StudioClientError && error.code === 'AUTH_REQUIRED' && error.action === 'login' && error.message === 'AUTH_REQUIRED' && !/token|root/.test(JSON.stringify(error)));
  await assert.rejects(createStudioClient(fakeBridge(async () => { throw { error: { code: 'lowercase bad' } }; })).call('hello', {}), { code: 'CORE_OPERATION_FAILED' });
  await assert.rejects(client.call('project.grant', { localPath: '/x' }), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(bridge.calls.length, 2, 'rejected calls never reach the bridge');
  assert.throws(() => createStudioClient(null), { code: 'BRIDGE_UNAVAILABLE' });
  assert.throws(() => createStudioClient({ call() {} }), { code: 'BRIDGE_UNAVAILABLE' });
  const timers = [];
  const hanging = createStudioClient(fakeBridge(() => new Promise(() => {})), { setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer() {} });
  const pending = hanging.call('hello', {});
  timers[0]();
  await assert.rejects(pending, { code: 'CORE_TIMEOUT' });
});

test('subscription validates events, relays status, and detaching never cancels agent work', () => {
  const bridge = fakeBridge(); const client = createStudioClient(bridge);
  const events = [], statuses = [];
  const stop = client.subscribe({ sessionId: SID, afterSequence: 41 }, event => events.push(event), status => statuses.push(status));
  assert.deepEqual(bridge.subs[0].params, { sessionId: SID, afterSequence: 41 });
  const send = bridge.subs[0].onMessage;
  send(valid(42)); send({ ...valid(43), data: { phase: 'thinking hard' } }); send({ kind: 'status', state: 'disconnected' });
  assert.equal(events.length, 1);
  assert.deepEqual(statuses.map(status => status.state), ['dropped', 'disconnected']);
  stop(); stop();
  assert.equal(bridge.subs[0].detached, 1);
  send(valid(44));
  assert.equal(events.length, 1, 'events after detach are ignored');
  assert.equal(bridge.calls.length, 0, 'detach issues no session.cancel');
  assert.throws(() => client.subscribe({ sessionId: SID, afterSequence: -1 }, () => {}), { code: 'INVALID_CURSOR' });
  assert.throws(() => client.subscribe({ sessionId: '../x', afterSequence: 0 }, () => {}), { code: 'INVALID_CURSOR' });
});

test('preview rect is finite, integer and clamped to the viewport', () => {
  const viewport = { width: 1280, height: 800 };
  assert.deepEqual(previewRect({ left: 260.4, top: 90.6, width: 700.2, height: 400 }, viewport), { x: 260, y: 91, width: 701, height: 400 });
  assert.deepEqual(previewRect({ left: -50, top: 700, width: 400, height: 400 }, viewport), { x: 0, y: 700, width: 350, height: 100 });
  for (const rect of [{ left: NaN, top: 0, width: 10, height: 10 }, { left: 0, top: 0, width: Infinity, height: 100 }, { left: 0, top: 0, width: 10, height: 100 }, { left: 2000, top: 0, width: 100, height: 100 }, null]) assert.equal(previewRect(rect, viewport), null);
  assert.equal(previewRect({ left: 0, top: 0, width: 100, height: 100 }, { width: 0, height: 100 }), null);
});

test('preview controller posts only approved handles, re-posts after resize and clears on failure', async () => {
  const listeners = new Map(), frames = [];
  const win = { innerWidth: 1200, innerHeight: 800, requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  let box = { left: 300, top: 100, width: 600, height: 340 };
  const element = { isConnected: true, getClientRects: () => [1], getBoundingClientRect: () => box };
  const shown = [], changes = []; let hidden = 0, failNext = false;
  const nativeActions = { async showPreview(value) { if (failNext) throw new Error('revoked /root/x'); shown.push(value); }, async hidePreview() { hidden++; } };
  const controller = createPreviewController({ nativeActions, getElement: () => element, win, onChange: change => changes.push(change.status) });
  const run = async () => { while (frames.length) await frames.shift()(); await new Promise(resolve => setImmediate(resolve)); };
  assert.equal(controller.show('https://evil.example/'), false);
  await run();
  assert.equal(shown.length, 0);
  controller.show('pvw_demo1'); await run();
  assert.deepEqual(shown, [{ previewHandle: 'pvw_demo1', rect: { x: 300, y: 100, width: 600, height: 340 } }]);
  controller.refresh(); await run();
  assert.equal(shown.length, 1, 'unchanged rect is not re-sent');
  box = { left: 240, top: 80, width: 500, height: 300 }; listeners.get('resize')(); await run();
  assert.deepEqual(shown.at(-1).rect, { x: 240, y: 80, width: 500, height: 300 });
  element.getClientRects = () => []; controller.refresh(); await run();
  assert.equal(hidden, 1, 'hidden preview area hides the native view');
  element.getClientRects = () => [1]; failNext = true; controller.refresh(); await run();
  assert.equal(changes.at(-1), 'unavailable');
  failNext = false; controller.refresh(); await run();
  assert.equal(shown.length, 2, 'a failed handle is cleared, not retried');
  controller.show('pvw_demo2'); await run();
  await controller.destroy();
  assert.equal(listeners.size, 0);
  assert.ok(hidden >= 2);
});

test('renderer source has no HTML sinks, network, storage, Node imports or external URLs', async () => {
  const dir = new URL('../studio/renderer/', import.meta.url);
  const files = (await readdir(dir)).filter(name => /\.(?:mjs|html|css)$/.test(name));
  assert.ok(files.includes('app.mjs') && files.includes('index.html') && files.includes('styles.css'));
  for (const name of files) {
    const source = await readFile(new URL(name, dir), 'utf8');
    for (const banned of [/innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcdoc/, /\beval\s*\(|new Function\s*\(/, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/, /localStorage|sessionStorage|indexedDB|document\.cookie/, /from ['"]node:|require\s*\(|process\.env/, /url\s*\(|@import/, /\bwindow\.open\s*\(|location\.(?:href|assign|replace)/]) assert.doesNotMatch(source, banned, `${name} matches ${banned}`);
    const urls = source.match(/https?:\/\/[^\s'")]+/g) ?? [];
    assert.deepEqual(urls.filter(url => url !== 'http://www.w3.org/2000/svg'), [], `${name} references external URLs`);
    for (const [, spec] of source.matchAll(/(?:import|from)\s*['"]([^'"]+)['"]/g)) assert.match(spec, /^(?:\.\/[a-z-]+\.mjs|\.\.\/\.\.\/lib\/agent-protocol\/schema\.mjs)$/, `${name} imports ${spec}`);
  }
  const html = await readFile(new URL('index.html', dir), 'utf8');
  assert.match(html, /default-src 'none'/); assert.match(html, /connect-src 'none'/); assert.match(html, /frame-src 'none'/);
});
