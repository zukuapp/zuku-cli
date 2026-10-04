import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createBrowserAdapter } from '../lib/browser-adapter/server.mjs';
import { ADAPTER_ORIGIN as ORIGIN, ADAPTER_LIMITS as L } from '../lib/browser-adapter/protocol.mjs';

const nonce = () => randomBytes(32).toString('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture({ approve = () => true, approveResume, input, clock = Date.now } = {}) {
  const calls = [], operations = [];
  let serial = 0;
  const host = {
    getHealth: async () => ({ status: 'ready', cliVersion: '0.3.0', studioVersion: '0.3.0', agentVersion: '0.3.0', home: '/private-home', apiKey: 'should-not-leak' }),
    getProjects: async () => [{ id: 'project_game1', name: 'My Game', root: '/private-home/game' }],
    getProviders: async () => ({ defaultProvider: 'zuku', defaultModel: 'zuku/auto', apiKey: 'should-not-leak', providers: [
      { id: 'zuku', name: 'ZUKU AI', enabled: true, authenticated: true, authMethods: [{ id: 'device', official: true, experimental: false }], authorization: 'should-not-leak' },
      { id: 'codex', name: 'Codex', enabled: true, authenticated: true, authMethods: [{ id: 'experimental', official: false, experimental: true }] },
    ] }),
    getModels: async ({ providerId }) => ({ models: [{ id: providerId === 'zuku' ? 'auto' : 'code-model', name: 'Model', apiKey: 'should-not-leak' }] }),
    createSession: async args => { calls.push({ type: 'create', args }); return { id: `session_game${++serial}` }; },
    input: input ?? (async args => { calls.push({ type: 'input', args }); args.onEvent({ type: 'agent.delta', data: { content: 'game change', apiKey: 'should-not-leak' } }); return { published: false }; }),
    cancel: async args => calls.push({ type: 'cancel', args }),
    authLogin: async args => { operations.push(['login', args]); return { access_token: 'should-not-leak' }; },
    authLogout: async args => operations.push(['logout', args]),
    useProvider: async args => operations.push(['provider', args]),
    useModel: async args => operations.push(['model', args]),
  };
  const approvalCalls = [], resumeCalls = [];
  const adapter = await createBrowserAdapter({ host, port: 0, clock, approvePairing: args => { approvalCalls.push(args); return approve(args); }, ...(approveResume ? { approveResume: args => { resumeCalls.push(args); return approveResume(args); } } : {}) });
  let token;
  async function call(path, { value, origin = ORIGIN, bearer = token, headers = {}, method = value === undefined ? 'GET' : 'POST' } = {}) {
    const response = await fetch(adapter.origin + path, { method, headers: { Origin: origin, 'X-Zuku-Protocol': '1', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(value !== undefined ? { 'Content-Type': 'application/json', 'X-Zuku-Request-Id': nonce() } : {}), ...headers }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function challenge() { const browserNonce = nonce(); const start = await call('/v1/pair/challenge', { value: { browserNonce } }); assert.equal(start.status, 200); return { browserNonce, challengeId: start.data.challengeId }; }
  async function pair() { const value = await challenge(); await pause(0); const confirmed = await call('/v1/pair/confirm', { value }); assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data)); token = confirmed.data.token; return confirmed.data; }
  const session = async (providerId = 'zuku', modelId = 'auto') => { const result = await call('/v1/sessions', { value: { projectId: 'project_game1', providerId, modelId } }); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.id; };
  return { adapter, call, pair, challenge, session, host, calls, operations, approvalCalls, resumeCalls, setToken: value => { token = value; } };
}
async function rawStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject); req.end();
  });
}
async function getEvents(f, id, token, count, after = 0) {
  const controller = new AbortController();
  const response = await fetch(`${f.adapter.origin}/v1/sessions/${id}/events?after=${after}`, { headers: { Origin: ORIGIN, 'X-Zuku-Protocol': '1', Authorization: `Bearer ${token}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), events = []; let pending = '';
  try {
    while (events.length < count) {
      const result = await reader.read(); assert.equal(result.done, false);
      pending += new TextDecoder().decode(result.value);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (line) events.push(JSON.parse(line)); }
    }
    return events;
  } finally { controller.abort(); await reader.cancel().catch(() => {}); }
}

test('native composition required; only loopback binding and minimal health metadata', async () => {
  await assert.rejects(createBrowserAdapter(), /NATIVE_HOST/);
  const f = await fixture();
  try {
    assert.match(f.adapter.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await f.call('/v1/health');
    assert.equal(health.data.product, 'zuku-browser-adapter');
    assert.equal(health.data.protocolVersion, 1);
    assert.equal(health.data.adapterInstanceId, f.adapter.adapterInstanceId);
    assert.doesNotMatch(JSON.stringify(health.data), /private-home|should-not-leak/);
    assert.equal((await f.call('/v1/projects')).status, 401);
    assert.equal((await f.call('/v1/health', { origin: 'https://evil.example' })).status, 403);
    const badHost = await rawStatus(f.adapter.origin + '/v1/health', { Host: 'evil.example' }); assert.equal(badHost, 421);
    const raw = await rawStatus(f.adapter.origin + '/v1/health', ['Host', 'evil.example', 'Host', new URL(f.adapter.origin).host]);
    assert.equal(raw, 400);
  } finally { await f.adapter.close(); }
});

test('CORS preflight uses exact Origin and restricts headers; protocol mismatch rejected', async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.adapter.origin + '/v1/sessions', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-zuku-protocol,x-zuku-request-id' } });
    assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
    assert.equal((await f.call('/v1/projects', { headers: { 'X-Zuku-Protocol': '0' } })).status, 426);
    const invalid = await fetch(f.adapter.origin + '/v1/sessions', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' } }); assert.equal(invalid.status, 403);
  } finally { await f.adapter.close(); }
});

test('pairing waits for visible native approval, nonce matches, consumes once, denies explicitly', async () => {
  const approval = deferred(); const f = await fixture({ approve: () => approval.promise });
  try {
    const value = await f.challenge();
    assert.equal((await f.call('/v1/pair/confirm', { value })).data.code, 'PAIRING_PENDING');
    assert.equal((await f.call('/v1/pair/challenge', { value: { browserNonce: nonce() } })).data.code, 'PAIRING_BUSY');
    assert.equal((await f.call('/v1/pair/confirm', { value: { ...value, browserNonce: nonce() } })).status, 403);
    assert.equal('browserNonce' in f.approvalCalls[0], false);
    approval.resolve(true); await pause(0);
    const confirmed = await f.call('/v1/pair/confirm', { value }); assert.equal(confirmed.status, 200);
    assert.equal((await f.call('/v1/pair/confirm', { value })).data.code, 'PAIRING_REPLAY');
    assert.ok(confirmed.data.expiresAt <= Date.now() + L.tokenMs);
  } finally { await f.adapter.close(); }
  const denied = await fixture({ approve: () => false });
  try { const value = await denied.challenge(); await pause(0); assert.equal((await denied.call('/v1/pair/confirm', { value })).data.code, 'PAIRING_DENIED'); }
  finally { await denied.adapter.close(); }
});

test('expired challenge/token and mutation request replay fail closed', async () => {
  let now = Date.now(); const f = await fixture({ clock: () => now });
  try {
    const value = await f.challenge(); now += L.challengeMs + 1;
    assert.equal((await f.call('/v1/pair/confirm', { value })).data.code, 'PAIRING_EXPIRED');
    assert.equal(f.approvalCalls[0].signal.aborted, true);
    await f.pair(); const requestId = nonce();
    const create = { value: { projectId: 'project_game1', providerId: 'zuku', modelId: 'auto' }, headers: { 'X-Zuku-Request-Id': requestId } };
    assert.equal((await f.call('/v1/sessions', create)).status, 200);
    assert.equal((await f.call('/v1/sessions', create)).data.code, 'REQUEST_REPLAY');
    assert.equal(f.calls.filter(call => call.type === 'create').length, 1);
    now += L.tokenMs + 1;
    assert.equal((await f.call('/v1/projects')).data.code, 'TOKEN_EXPIRED');
  } finally { await f.adapter.close(); }
});

test('opaque projects/catalogs expose no paths/secrets, and typed config/auth operations reject unknown authority', async () => {
  const f = await fixture();
  try {
    await f.pair();
    for (const path of ['/v1/projects', '/v1/providers', '/v1/models?provider=zuku']) assert.doesNotMatch(JSON.stringify((await f.call(path)).data), /private-home|should-not-leak/);
    assert.equal((await f.call('/v1/sessions', { value: { projectId: 'project_game1', cwd: '/etc' } })).status, 400);
    assert.equal((await f.call('/v1/sessions', { value: { projectId: 'project_unknown', providerId: 'zuku', modelId: 'auto' } })).status, 400);
    assert.equal((await f.call('/v1/auth/login', { value: { providerId: 'codex', experimental: false } })).status, 403);
    assert.equal((await f.call('/v1/auth/login', { value: { providerId: 'codex', experimental: true } })).status, 200);
    assert.equal((await f.call('/v1/providers/use', { value: { providerId: 'unknown' } })).status, 400);
    assert.equal((await f.call('/v1/models/use', { value: { providerId: 'zuku', modelId: 'unregistered' } })).status, 400);
    assert.equal((await f.call('/v1/models/use', { value: { providerId: 'zuku', modelId: 'zuku/auto' } })).status, 200);
    assert.equal((await f.call('/v1/auth/logout', { value: { providerId: 'zuku' } })).status, 200);
    assert.equal((await f.call('/v1/exec', { value: { command: 'arbitrary' } })).status, 404);
    assert.equal((await f.call('/v1/models?provider=zuku&provider=codex')).status, 400);
    assert.deepEqual(f.operations.map(operation => operation[0]), ['login', 'model', 'logout']);
  } finally { await f.adapter.close(); }
});

test('live typed stream reconnects in sequence without creating another task; no raw errors/secrets forwarded', async () => {
  const release = deferred(); let ran = 0;
  const f = await fixture({ input: async args => { ran++; args.onEvent({ type: 'stage', stage: 'implementation', status: 'started' }); args.onEvent({ type: 'agent.delta', data: { content: 'game patch', apiKey: 'should-not-leak' } }); await release.promise; return { published: false }; } });
  try {
    const paired = await f.pair(), id = await f.session();
    const inputId = nonce();
    assert.equal((await f.call(`/v1/sessions/${id}/input`, { value: { inputId, prompt: '게임 대시 동작 추가', experimental: false } })).status, 202);
    const first = await getEvents(f, id, paired.token, 4);
    assert.deepEqual(first.map(event => event.seq), [1, 2, 3, 4]);
    assert.ok(first.every(event => event.protocolVersion === 1 && event.sessionId === id && typeof event.data === 'object'));
    assert.doesNotMatch(JSON.stringify(first), /should-not-leak/);
    assert.equal((await f.call(`/v1/sessions/${id}/input`, { value: { inputId, prompt: 'repeat', experimental: false } })).data.code, 'INPUT_REPLAY');
    release.resolve(); await pause(0);
    const next = await getEvents(f, id, paired.token, 1, 4); assert.equal(next[0].type, 'agent.completed'); assert.equal(next[0].seq, 5);
    assert.equal(ran, 1);
  } finally { release.resolve(); await f.adapter.close(); }
});

test('cancel aborts shared host signal; revoke closes streams without cancelling a local task', async () => {
  const started = deferred(), stopped = deferred(); let hostSignal;
  const f = await fixture({ input: async args => { hostSignal = args.signal; started.resolve(); await new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true })); stopped.resolve(); } });
  try {
    const paired = await f.pair(), id = await f.session();
    await f.call(`/v1/sessions/${id}/input`, { value: { inputId: nonce(), prompt: '게임 테스트', experimental: false } }); await started.promise;
    const response = await fetch(`${f.adapter.origin}/v1/sessions/${id}/events?after=2`, { headers: { Origin: ORIGIN, 'X-Zuku-Protocol': '1', Authorization: `Bearer ${paired.token}` } });
    const reader = response.body.getReader();
    assert.equal((await f.call('/v1/pair/revoke', { value: {} })).status, 200);
    assert.equal((await reader.read()).done, true); assert.equal(hostSignal.aborted, false);
    assert.equal((await f.call('/v1/projects')).status, 401);
    await f.adapter.close(); await stopped.promise; assert.equal(hostSignal.aborted, true);
  } finally { await f.adapter.close(); }
  const cancelHost = await fixture({ input: async args => { await new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true })); } });
  try {
    const paired = await cancelHost.pair(), id = await cancelHost.session();
    await cancelHost.call(`/v1/sessions/${id}/input`, { value: { inputId: nonce(), prompt: '게임 빌드', experimental: false } }); await pause(0);
    assert.equal((await cancelHost.call(`/v1/sessions/${id}/cancel`, { value: {} })).status, 200); await pause(0);
    const events = await getEvents(cancelHost, id, paired.token, 3); assert.equal(events.at(-1).type, 'agent.cancelled');
  } finally { await cancelHost.adapter.close(); }
});

test('retained event ring is bounded and expired replay cursor returns 410', async () => {
  const f = await fixture({ input: async args => { for (let i = 0; i < 400; i++) args.onEvent({ type: 'build.output', data: { content: String(i), stream: 'stdout' } }); } });
  try {
    await f.pair(); const id = await f.session();
    await f.call(`/v1/sessions/${id}/input`, { value: { inputId: nonce(), prompt: '게임 빌드 검증', experimental: false } }); await pause(0);
    const expired = await f.call(`/v1/sessions/${id}/events?after=0`); assert.equal(expired.status, 410); assert.equal(expired.data.code, 'EVENTS_EXPIRED');
  } finally { await f.adapter.close(); }
});

test('concurrent input validation reserves one task and input replay never invokes the host twice', async () => {
  const gate = deferred(), started = deferred(), release = deferred(); let ran = 0;
  const f = await fixture({ input: async () => { ran++; started.resolve(); await release.promise; } });
  try {
    await f.pair(); const id = await f.session();
    const catalog = f.host.getProviders; f.host.getProviders = async () => { await gate.promise; return catalog(); };
    const input = { inputId: nonce(), prompt: '게임 점프 동작 테스트', experimental: false };
    const one = f.call(`/v1/sessions/${id}/input`, { value: input });
    const two = f.call(`/v1/sessions/${id}/input`, { value: input });
    await pause(10); gate.resolve();
    const responses = await Promise.all([one, two]);
    assert.deepEqual(responses.map(value => value.status).sort(), [202, 409]);
    assert.equal(responses.find(value => value.status === 409).data.code, 'INPUT_REPLAY');
    await started.promise; assert.equal(ran, 1);
  } finally { gate.resolve(); release.resolve(); await f.adapter.close(); }
});

test('authorization is rechecked after metadata awaits and other pairing cannot access a session', async () => {
  const gate = deferred(); let ran = 0;
  const f = await fixture({ input: async () => { ran++; } });
  try {
    await f.pair(); const id = await f.session();
    const catalog = f.host.getProviders; f.host.getProviders = async () => { await gate.promise; return catalog(); };
    const request = f.call(`/v1/sessions/${id}/input`, { value: { inputId: nonce(), prompt: '게임 구현', experimental: false } });
    await pause(10); await f.call('/v1/pair/revoke', { value: {} }); gate.resolve();
    assert.equal((await request).status, 401); assert.equal(ran, 0);
    f.host.getProviders = catalog; await f.pair();
    assert.equal((await f.call(`/v1/sessions/${id}`)).status, 404);
  } finally { gate.resolve(); await f.adapter.close(); }
});

test('bounded request/response and stream authority reject unsupported inputs without host execution', async () => {
  const f = await fixture({ input: async () => { throw Object.assign(new Error('should-not-leak private-home'), { access_token: 'should-not-leak' }); } });
  try {
    const paired = await f.pair(), id = await f.session();
    assert.equal((await f.call('/v1/pair/challenge', { value: { browserNonce: 'x'.repeat(L.bodyBytes) } })).status, 413);
    assert.equal((await f.call(`/v1/sessions/${id}/input`, { value: { inputId: nonce(), prompt: 'x'.repeat(L.promptChars + 1), experimental: false } })).status, 400);
    assert.equal((await f.call(`/v1/sessions/${id}/events?after=0&token=${paired.token}`)).status, 400);
    assert.equal((await f.call(`/v1/sessions/${id}/events?after=99999`)).status, 400);
    const holders = [];
    for (let i = 0; i < L.streamsPerSession; i++) {
      const controller = new AbortController();
      const response = await fetch(`${f.adapter.origin}/v1/sessions/${id}/events?after=1`, { headers: { Origin: ORIGIN, 'X-Zuku-Protocol': '1', Authorization: `Bearer ${paired.token}` }, signal: controller.signal });
      assert.equal(response.status, 200); holders.push({ controller, response });
    }
    assert.equal((await f.call(`/v1/sessions/${id}/events?after=1`)).status, 429);
    for (const { controller, response } of holders) { controller.abort(); await response.body.cancel().catch(() => {}); }
    await pause(0);
    await f.call(`/v1/sessions/${id}/input`, { value: { inputId: nonce(), prompt: '게임 테스트 오류', experimental: false } }); await pause(0);
    const events = await getEvents(f, id, paired.token, 3);
    assert.equal(events.at(-1).type, 'agent.error'); assert.equal(events.at(-1).data.code, 'HOST_OPERATION_FAILED');
    assert.doesNotMatch(JSON.stringify(events), /should-not-leak|private-home/);
    f.host.getModels = async () => ({ models: Array.from({ length: 1000 }, (_, i) => ({ id: `${i}${'a'.repeat(190)}`, name: 'N'.repeat(200) })) });
    assert.equal((await f.call('/v1/models?provider=zuku')).data.code, 'HOST_RESPONSE_TOO_LARGE');
  } finally { await f.adapter.close(); }
});

test('expired pairing resumes the same live task only after native approval and replays the existing cursor', async () => {
  let now = Date.now(), ran = 0;
  const release = deferred(), approval = deferred(), prompted = deferred();
  const f = await fixture({ clock: () => now, approveResume: args => { prompted.resolve(args); return approval.promise; }, input: async args => {
    ran++; args.onEvent({ type: 'agent.delta', data: { content: 'before disconnect' } }); await release.promise;
    args.onEvent({ type: 'agent.delta', data: { content: 'continued native task' } }); return { published: false };
  } });
  try {
    const old = await f.pair(), id = await f.session(), inputId = nonce();
    await f.call(`/v1/sessions/${id}/input`, { value: { inputId, prompt: '게임 장기 작업', experimental: false } });
    const before = await getEvents(f, id, old.token, 3); // Drops the HTTP stream, not the native task.
    assert.equal(before.at(-1).seq, 3); assert.equal(ran, 1);
    now += L.tokenMs + 1; assert.equal((await f.call(`/v1/sessions/${id}`)).status, 401);
    const fresh = await f.pair();
    assert.equal((await f.call(`/v1/sessions/${id}`)).status, 404);
    const pending = f.call(`/v1/sessions/${id}/resume`, { value: { projectId: 'project_game1' } });
    const native = await prompted.promise;
    assert.deepEqual(Object.keys(native).sort(), ['expiresAt', 'origin', 'projectId', 'sessionId', 'signal']);
    assert.equal(native.sessionId, id); assert.equal(native.projectId, 'project_game1'); assert.equal(native.origin, ORIGIN);
    assert.equal(native.expiresAt, now + 120000);
    assert.equal((await f.call(`/v1/sessions/${id}`)).status, 404);
    approval.resolve(true); const resumed = await pending;
    assert.equal(resumed.status, 200);
    assert.deepEqual(resumed.data, { id, projectId: 'project_game1', providerId: 'zuku', modelId: 'auto', active: true, lastSeq: 3, status: 'running' });
    assert.doesNotMatch(JSON.stringify(resumed.data), /private-home|should-not-leak|token|owner|events/);
    assert.equal((await f.call(`/v1/sessions/${id}/input`, { value: { inputId, prompt: 'repeat', experimental: false } })).data.code, 'INPUT_REPLAY');
    release.resolve(); await pause(0);
    const continued = await getEvents(f, id, fresh.token, 2, 3);
    assert.deepEqual(continued.map(event => [event.seq, event.type]), [[4, 'agent.delta'], [5, 'agent.completed']]);
    assert.equal(ran, 1); assert.equal(f.calls.filter(call => call.type === 'create').length, 1);
    const view = await f.call(`/v1/sessions/${id}`); assert.equal(view.data.lastSeq, 5); assert.equal(view.data.status, 'completed');
  } finally { approval.resolve(false); release.resolve(); await f.adapter.close(); }
});

test('missing or denied native resume never discloses or mutates another pairing session', async () => {
  for (const [approveResume, expectedStatus] of [[undefined, 503], [() => false, 403], [() => { throw Error('private-home should-not-leak'); }, 500]]) {
    const f = await fixture({ approveResume });
    try {
      const old = await f.pair(), id = await f.session(); await f.pair();
      for (const [path, options] of [
        [`/v1/sessions/${id}`, {}], [`/v1/sessions/${id}/events`, {}],
        [`/v1/sessions/${id}/cancel`, { value: {} }], [`/v1/sessions/${id}`, { method: 'DELETE', headers: { 'X-Zuku-Request-Id': nonce() } }],
        [`/v1/sessions/${id}/input`, { value: { inputId: nonce(), prompt: '게임 변경', experimental: false } }],
      ]) assert.equal((await f.call(path, options)).status, 404);
      const result = await f.call(`/v1/sessions/${id}/resume`, { value: { projectId: 'project_game1' } });
      assert.equal(result.status, expectedStatus);
      assert.doesNotMatch(JSON.stringify(result.data), /private-home|should-not-leak|providerId|modelId|lastSeq/);
      assert.equal((await f.call(`/v1/sessions/${id}`)).status, 404);
      assert.equal((await f.call(`/v1/sessions/${id}`, { bearer: old.token })).status, 200);
      assert.equal(f.calls.length, 1);
    } finally { await f.adapter.close(); }
  }
});

test('resume accepts one exact registered project and no additional browser authority', async () => {
  const f = await fixture({ approveResume: () => true });
  try {
    const old = await f.pair(), id = await f.session(); await f.pair();
    assert.equal((await f.call(`/v1/sessions/${id}/resume`, { value: { projectId: 'project_unknown' } })).status, 404);
    assert.equal((await f.call(`/v1/sessions/${id}/resume`, { value: { projectId: 'project_game1', cwd: '/etc' } })).status, 400);
    assert.equal((await f.call(`/v1/sessions/${id}/resume?projectId=project_game1`, { value: { projectId: 'project_game1' } })).status, 400);
    f.host.getProjects = async () => [];
    assert.equal((await f.call(`/v1/sessions/${id}/resume`, { value: { projectId: 'project_game1' } })).data.code, 'INVALID_PROJECT');
    assert.equal(f.resumeCalls.length, 0);
    assert.equal((await f.call(`/v1/sessions/${id}`, { bearer: old.token })).status, 200);
  } finally { await f.adapter.close(); }
});

test('concurrent resume and old-owner cancellation cannot transfer during an owner operation', async () => {
  const approval = deferred(), prompted = deferred(), cancelStarted = deferred(), cancelRelease = deferred();
  const f = await fixture({ approveResume: args => { prompted.resolve(args); return approval.promise; } });
  try {
    const old = await f.pair(), id = await f.session(); await f.pair();
    const pending = f.call(`/v1/sessions/${id}/resume`, { value: { projectId: 'project_game1' } });
    const native = await prompted.promise;
    assert.equal((await f.call(`/v1/sessions/${id}/resume`, { value: { projectId: 'project_game1' } })).data.code, 'SESSION_BUSY');
    f.host.cancel = async () => { cancelStarted.resolve(); await cancelRelease.promise; };
    const cancellation = f.call(`/v1/sessions/${id}/cancel`, { value: {}, bearer: old.token });
    await cancelStarted.promise;
    assert.equal((await pending).data.code, 'RESUME_CHANGED'); assert.equal(native.signal.aborted, true);
    assert.equal((await f.call(`/v1/sessions/${id}/resume`, { value: { projectId: 'project_game1' } })).data.code, 'SESSION_BUSY');
    approval.resolve(true); cancelRelease.resolve(); assert.equal((await cancellation).status, 200); await pause(0);
    assert.equal(f.resumeCalls.length, 1);
    assert.equal((await f.call(`/v1/sessions/${id}`)).status, 404);
    assert.equal((await f.call(`/v1/sessions/${id}`, { bearer: old.token })).status, 200);
  } finally { approval.resolve(false); cancelRelease.resolve(); await f.adapter.close(); }
});

test('new or old token revocation cancels pending resume and late approval cannot resurrect authority', async () => {
  for (const revokeOld of [false, true]) {
    const approval = deferred(), prompted = deferred();
    const f = await fixture({ approveResume: args => { prompted.resolve(args); return approval.promise; } });
    try {
      const old = await f.pair(), id = await f.session(), fresh = await f.pair();
      const pending = f.call(`/v1/sessions/${id}/resume`, { value: { projectId: 'project_game1' } }); const native = await prompted.promise;
      assert.equal((await f.call('/v1/pair/revoke', { value: {}, bearer: revokeOld ? old.token : fresh.token })).status, 200);
      assert.equal((await pending).status, 401); assert.equal(native.signal.aborted, true);
      approval.resolve(true); await pause(0);
      assert.equal((await f.call(`/v1/sessions/${id}`, { bearer: revokeOld ? fresh.token : old.token })).status, revokeOld ? 404 : 200);
    } finally { approval.resolve(false); await f.adapter.close(); }
  }
});

test('native resume deadline is 120 seconds and a stalled approval is cancelled without ownership change', async () => {
  let now = Date.now(); const prompted = deferred(), approval = deferred();
  const f = await fixture({ clock: () => now, approveResume: args => { prompted.resolve(args); return approval.promise; } });
  try {
    const old = await f.pair(), id = await f.session(); await f.pair();
    const pending = f.call(`/v1/sessions/${id}/resume`, { value: { projectId: 'project_game1' } }); const native = await prompted.promise;
    assert.equal(native.expiresAt, now + 120000); now += 120001;
    const result = await pending; assert.equal(result.status, 410); assert.equal(result.data.code, 'RESUME_EXPIRED'); assert.equal(native.signal.aborted, true);
    approval.resolve(true); await pause(0);
    assert.equal((await f.call(`/v1/sessions/${id}`)).status, 404);
    assert.equal((await f.call(`/v1/sessions/${id}`, { bearer: old.token })).status, 200);
  } finally { approval.resolve(false); await f.adapter.close(); }
});

test('disconnected resume request cancels native approval and does not transfer a session', async () => {
  const prompted = deferred(), approval = deferred();
  const f = await fixture({ approveResume: args => { prompted.resolve(args); return approval.promise; } });
  try {
    const old = await f.pair(), id = await f.session(), fresh = await f.pair();
    const controller = new AbortController();
    const request = fetch(`${f.adapter.origin}/v1/sessions/${id}/resume`, { method: 'POST', signal: controller.signal, headers: { Origin: ORIGIN, 'X-Zuku-Protocol': '1', Authorization: `Bearer ${fresh.token}`, 'Content-Type': 'application/json', 'X-Zuku-Request-Id': nonce() }, body: JSON.stringify({ projectId: 'project_game1' }) });
    const native = await prompted.promise; controller.abort(); await assert.rejects(request, error => error.name === 'AbortError');
    for (let i = 0; i < 50 && !native.signal.aborted; i++) await pause(5);
    assert.equal(native.signal.aborted, true); approval.resolve(true); await pause(0);
    assert.equal((await f.call(`/v1/sessions/${id}`)).status, 404);
    assert.equal((await f.call(`/v1/sessions/${id}`, { bearer: old.token })).status, 200);
  } finally { approval.resolve(false); await f.adapter.close(); }
});

test('approval rechecks project registration and closes old-owner streams before the new owner reads events', async () => {
  const approval = deferred(), prompted = deferred();
  const f = await fixture({ approveResume: args => { prompted.resolve(args); return approval.promise; } });
  try {
    const old = await f.pair(), id = await f.session(), fresh = await f.pair();
    const pending = f.call(`/v1/sessions/${id}/resume`, { value: { projectId: 'project_game1' } }); await prompted.promise;
    const getProjects = f.host.getProjects; f.host.getProjects = async () => [];
    approval.resolve(true); assert.equal((await pending).data.code, 'INVALID_PROJECT');
    assert.equal((await f.call(`/v1/sessions/${id}`)).status, 404);
    assert.equal((await f.call(`/v1/sessions/${id}`, { bearer: old.token })).status, 200);
    f.host.getProjects = getProjects;
    const response = await fetch(`${f.adapter.origin}/v1/sessions/${id}/events?after=1`, { headers: { Origin: ORIGIN, 'X-Zuku-Protocol': '1', Authorization: `Bearer ${old.token}` } });
    const reader = response.body.getReader();
    assert.equal((await f.call(`/v1/sessions/${id}/resume`, { value: { projectId: 'project_game1' } })).status, 200);
    assert.equal((await reader.read()).done, true);
    assert.equal((await f.call(`/v1/sessions/${id}`, { bearer: old.token })).status, 404);
    assert.equal((await getEvents(f, id, fresh.token, 1))[0].seq, 1);
  } finally { approval.resolve(false); await f.adapter.close(); }
});

test('revocation during auth/config metadata validation prevents every late host mutation', async () => {
  for (const [path, value] of [
    ['/v1/auth/login', { providerId: 'zuku', experimental: false }], ['/v1/auth/logout', { providerId: 'zuku' }],
    ['/v1/providers/use', { providerId: 'zuku' }], ['/v1/models/use', { providerId: 'zuku', modelId: 'auto' }],
  ]) {
    const gate = deferred(), entered = deferred(), f = await fixture();
    try {
      await f.pair(); const catalog = f.host.getProviders;
      f.host.getProviders = async () => { entered.resolve(); await gate.promise; return catalog(); };
      const pending = f.call(path, { value }); await entered.promise;
      assert.equal((await f.call('/v1/pair/revoke', { value: {} })).status, 200);
      gate.resolve(); assert.equal((await pending).status, 401); assert.equal(f.operations.length, 0);
    } finally { gate.resolve(); await f.adapter.close(); }
  }
});
