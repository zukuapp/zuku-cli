import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, chmod, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { apiClient, DEFAULT_BASE_URL } from '../lib/api-client.mjs';
import { readAccessToken } from '../lib/credentials.mjs';
import { CommandError } from '../lib/errors.mjs';
import { identity, cliVersion } from '../lib/identity.mjs';
import { readManifest, validateManifest } from '../lib/manifest-reader.mjs';
import diagnostics from '../commands/diagnostics.mjs';
import { run } from '../index.mjs';

const token = 'fixture_only_access_token';
const privateValue = 'fixture_only_secret_echo';
const catalog = { plans: [{ title: privateValue }], cash: [], points: { purchasable: false }, stale: false };
const envelope = data => ({ success: true, data, meta: { request_id: 'fixture', version: 'v1', timestamp: '2026-10-03T00:00:00Z' } });
async function fixture(t, mode = 'normal') {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    if (mode === 'slow') return;
    if (mode === 'redirect') { res.writeHead(302, { Location: '/api/v1/billing/checkout' }); res.end(); return; }
    if (mode === 'large') { res.writeHead(200); res.end(JSON.stringify(envelope('x'.repeat(70000)))); return; }
    if (mode === 'internal') { res.writeHead(200); res.end(JSON.stringify({ ok: true, data: catalog })); return; }
    if (mode === 'missing-meta') { res.writeHead(200); res.end(JSON.stringify({ success: true, data: catalog })); return; }
    if (mode === 'failure') { res.writeHead(503); res.end(JSON.stringify({ success: false, error: { code: 'BILLING_UNAVAILABLE', message: `${token} ${privateValue}` }, meta: {} })); return; }
    if (req.url === '/api/v1/auth/me' && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: token }, meta: {} })); return; }
    if (!['/api/v1/billing/catalog', '/api/v1/auth/me'].includes(req.url)) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'ignored_fixture_cookie=secret' });
    res.end(JSON.stringify(envelope(req.url.endsWith('/auth/me') ? { user: { id: 'usr_91', email: privateValue } } : catalog)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}/api/v1`;
  return { origin, requests, client: options => apiClient(origin, { allowFixtureOrigin: true, ...options }) };
}
async function capture(args, options = {}) {
  let out = '', err = '';
  const exit = await run(args, { stdout: { write: x => { out += x; } }, stderr: { write: x => { err += x; } }, ...options });
  return { exit, out, err };
}

test('canonical public API and runtime identity stay distinct from CLI package version', async () => {
  assert.equal(DEFAULT_BASE_URL, 'https://www.zuzunza.com/api/v1');
  const result = await capture(['system.version', '--json']);
  assert.equal(result.exit, 0);
  const body = JSON.parse(result.out);
  assert.deepEqual(body, { success: true, data: { runtime: identity.name, version: identity.version, command_protocol: identity.command_protocol, cli_version: cliVersion }, meta: { runtime: identity.version, protocol: identity.command_protocol } });
  assert.equal(result.err, '');
});
test('help aliases describe all implemented commands', async () => {
  for (const args of [['help'], ['--help'], ['-h']]) {
    const result = await capture(args);
    assert.equal(result.exit, 0); assert.doesNotMatch(result.out, /NOT_IMPLEMENTED/); assert.match(result.out, /zukujs create/); assert.match(result.out, /--check-api/);
  }
  const result = await capture(['system.help', '--json']);
  assert.equal(JSON.parse(result.out).data.some(item => item.name === 'app.status'), true);
});
test('project commands and manifest APIs reject invalid inputs without echoing paths/tokens', async () => {
  const upload = await capture(['upload', '/root/private/' + token, '--json']);
  assert.equal(upload.exit, 1); assert.equal(upload.out, '');
  assert.equal(JSON.parse(upload.err).error.code, 'UPLOAD_INPUT_UNSAFE');
  assert.equal(upload.err.includes(token), false); assert.equal(upload.err.includes('/root/private'), false);
  for (const name of ['create', 'validate', 'package']) {
    const result = await capture([name, '/root/private/' + token, '--json']);
    assert.ok([1, 2].includes(result.exit), `${name} exit ${result.exit}`); assert.equal(result.out, '');
    const body = JSON.parse(result.err);
    assert.equal(body.success, false);
    assert.equal(typeof body.error.code, 'string'); assert.equal(typeof body.error.message, 'string');
    assert.notEqual(body.error.code, 'NOT_IMPLEMENTED');
    assert.deepEqual(body.meta, { runtime: identity.version, protocol: identity.command_protocol });
    assert.equal(result.err.includes(token), false); assert.equal(result.err.includes('/root/private'), false);
  }
  const manifest = { schema: 'zukujs-project/1', name: 'demo', title: 'Demo', version: '0.1.0' };
  const parsed = readManifest(new TextEncoder().encode(JSON.stringify(manifest)));
  assert.deepEqual(parsed, { manifest, diagnostics: [] });
  assert.deepEqual(validateManifest(manifest), []);
  assert.throws(() => readManifest('/root/private'), error => error instanceof TypeError && !String(error.message).includes('/root/private'));
  const problems = validateManifest({});
  assert.ok(Array.isArray(problems));
  assert.deepEqual(problems.map(item => item.code), ['MANIFEST_REQUIRED', 'MANIFEST_REQUIRED', 'MANIFEST_REQUIRED', 'MANIFEST_REQUIRED']);
  const echoed = validateManifest({ schema: token, name: token, title: '/root/private\u0001', version: token });
  assert.ok(echoed.length > 0);
  assert.equal(JSON.stringify(echoed).includes(token), false); assert.equal(JSON.stringify(echoed).includes('/root/private'), false);
});
test('unknown commands/flags and injected errors emit stable redacted failures only', async () => {
  for (const args of [[token, '--json'], ['status', '--base-url', token, '--json'], ['status', '--check-api', '--check-api', '--json'], ['version', token, '--json']]) {
    const result = await capture(args); assert.equal(result.exit, 2); assert.equal(result.out, ''); assert.equal(result.err.includes(token), false);
  }
  const result = await capture(['status', '--json'], { diagnostics: async () => { throw Error(token); } });
  assert.equal(JSON.parse(result.err).error.code, 'COMMAND_FAILED'); assert.equal(result.err.includes(token), false);
});
test('offline diagnostics do not create a client/request and never expose bearer/service keys', async () => {
  let called = 0;
  const data = await diagnostics({ credentials: async () => token, clientFactory: async () => { called++; throw Error(privateValue); } });
  assert.equal(called, 0); assert.equal(data.api.checked, false); assert.equal(data.authentication.configured, true);
  assert.equal(JSON.stringify(data).includes(token), false); assert.equal(JSON.stringify(data).includes(privateValue), false);
});
test('actual local HTTP sends anonymous catalog then bearer-only auth, with no HMAC/cookies/body', async t => {
  const f = await fixture(t);
  const client = await f.client({ accessToken: token });
  assert.equal((await client.request('/billing/catalog')).success, true);
  assert.equal((await client.request('/auth/me')).data.user.id, 'usr_91');
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.equal(request.method, 'GET'); assert.equal(request.body, ''); assert.equal(request.headers.cookie, undefined);
    assert.equal(Object.keys(request.headers).some(key => key.startsWith('x-zuku')), false);
  }
  assert.equal(f.requests[0].headers.authorization, undefined);
  assert.equal(f.requests[1].headers.authorization, `Bearer ${token}`);
});
test('online diagnostics produce counts/status only; no account, raw catalog, server meta or token', async t => {
  const f = await fixture(t);
  const data = await diagnostics({ checkApi: true, credentials: async () => token, clientFactory: async (_, options) => f.client(options) });
  assert.equal(data.api.status, 'ready'); assert.equal(data.authentication.status, 'authenticated'); assert.equal(data.api.points_purchasable, false);
  for (const secret of [token, privateValue, 'usr_91', 'ignored_fixture_cookie', 'request_id']) assert.equal(JSON.stringify(data).includes(secret), false);
  assert.equal(f.requests.length, 2);
});
test('anonymous online diagnostics make exactly one catalog GET', async t => {
  const f = await fixture(t);
  const data = await diagnostics({ checkApi: true, credentials: async () => undefined, clientFactory: async (_, options) => f.client(options) });
  assert.equal(data.authentication.status, 'anonymous'); assert.equal(f.requests.length, 1);
});
test('scoped ZUKU OAuth checks its game profile and keeps generic account fields private', async () => {
  const calls = [];
  const result = await diagnostics({ checkApi: true, credentials: async () => 'zuku_oa_' + 'a'.repeat(64), clientFactory: async () => ({ request: async path => { calls.push(path); return envelope(catalog); } }), accountClientFactory: async () => ({ me: async () => ({ status: 200, data: envelope({ user: { id: 'usr_91', display_name: privateValue } }) }) }) });
  assert.deepEqual(calls, ['/billing/catalog']); assert.equal(result.authentication.status, 'authenticated'); assert.equal(JSON.stringify(result).includes(privateValue), false);
});
test('auth requires user bearer before fetch; arbitrary paths, mutations and headers are rejected', async () => {
  let calls = 0;
  const client = await apiClient(undefined, { fetch: async () => { calls++; throw Error(token); } });
  await assert.rejects(client.request('/auth/me'), { code: 'UNAUTHORIZED' });
  for (const [path, options] of [['/billing/checkout', {}], ['/internal/v1/catalog', {}], ['/billing/catalog?user=91', {}], ['https://evil.example', {}], ['/billing/catalog', { method: 'POST' }], ['/billing/catalog', { headers: { 'X-Zuku-Client-Key': token } }], ['/billing/catalog', { body: '{}' }]]) await assert.rejects(client.request(path, options), { code: 'API_READ_ONLY' });
  assert.equal(calls, 0);
});
test('noncanonical, credentialed, private and redirected origins cannot receive a token', async t => {
  for (const origin of ['https://api.zuzunza.com/v1', 'https://evil.example/api/v1', 'https://www.zuzunza.com.evil.example/api/v1', 'https://user:pass@www.zuzunza.com/api/v1', 'https://www.zuzunza.com/api/v1?x=1', 'http://127.0.0.1:1234/api/v1']) await assert.rejects(apiClient(origin, { accessToken: token }), { code: 'API_ORIGIN_REJECTED' });
  const f = await fixture(t, 'redirect');
  await assert.rejects((await f.client({ accessToken: token })).request('/auth/me'), { code: 'API_UNAVAILABLE' });
  assert.equal(f.requests.length, 1);
});
test('invalid/oversized/internal/error responses fail closed with redacted codes and zero retry', async t => {
  for (const mode of ['large', 'internal', 'missing-meta', 'failure']) {
    const f = await fixture(t, mode);
    await assert.rejects((await f.client()).request('/billing/catalog'), error => error instanceof CommandError && !String(error.stack).includes(token) && !String(error.stack).includes(privateValue));
    assert.equal(f.requests.length, 1);
  }
  const client = await apiClient(undefined, { fetch: async () => { throw Error(`${token} /root/secret ${privateValue}`); } });
  await assert.rejects(client.request('/billing/catalog'), error => error.code === 'API_UNAVAILABLE' && !String(error.stack).includes(token));
});
test('bounded timeout and cancellation abort the same read with no automatic retry', async t => {
  const f = await fixture(t, 'slow');
  const attempts = [];
  const observedFetch = (url, options) => {
    attempts.push(options.signal);
    return fetch(url, options);
  };
  await assert.rejects((await f.client({ timeoutMs: 20, fetch: observedFetch })).request('/billing/catalog'), { code: 'API_UNAVAILABLE' });
  const controller = new AbortController();
  const request = (await f.client({ signal: controller.signal, fetch: observedFetch })).request('/billing/catalog');
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(request, { code: 'COMMAND_CANCELLED' });
  // Under concurrent load, abort may precede the TCP connection. Count actual
  // fetch attempts and their aborted signals rather than requiring delivery.
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(signal => signal.aborted));
  assert.ok(f.requests.length <= attempts.length);
  const result = await capture(['status', '--check-api', '--json'], { signal: controller.signal });
  assert.equal(result.exit, 130); assert.equal(JSON.parse(result.err).error.code, 'COMMAND_CANCELLED');
});
test('late local diagnostics are not published after interrupt', async () => {
  const controller = new AbortController();
  const result = await capture(['status', '--json'], { signal: controller.signal, diagnostics: async () => { controller.abort(); return { private: privateValue }; } });
  assert.equal(result.exit, 130); assert.equal(result.out, ''); assert.equal(result.err.includes(privateValue), false);
});
test('user credential files must be owner-only regular files; symlinks/large/invalid are rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zuku-cli-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'credentials.json');
  await writeFile(file, JSON.stringify({ access_token: token }), { mode: 0o600 });
  const options = { environment: { ZUKU_CREDENTIALS_FILE: file } };
  assert.equal(await readAccessToken(options), token);
  await chmod(file, 0o644); await assert.rejects(readAccessToken(options), { code: 'CREDENTIALS_UNSAFE' });
  await chmod(file, 0o600); await assert.rejects(readAccessToken({ ...options, uid: process.getuid() + 1 }), { code: 'CREDENTIALS_UNSAFE' });
  const link = join(dir, 'link.json'); await symlink(file, link); await assert.rejects(readAccessToken({ environment: { ZUKU_CREDENTIALS_FILE: link } }), { code: 'CREDENTIALS_UNSAFE' });
  await writeFile(file, 'x'.repeat(17000)); await assert.rejects(readAccessToken(options), { code: 'CREDENTIALS_UNSAFE' });
  await writeFile(file, '{'); await assert.rejects(readAccessToken(options), { code: 'CREDENTIALS_INVALID' });
  await writeFile(file, JSON.stringify({ access_token: token, service_secret: privateValue })); await assert.rejects(readAccessToken(options), { code: 'CREDENTIALS_INVALID' });
  assert.equal(await readAccessToken({ environment: {}, home: dir }), undefined);
});
test('env bearer overrides files, control characters rejected, service keys never used', async () => {
  assert.equal(await readAccessToken({ environment: { ZUKU_ACCESS_TOKEN: token, ZUKU_CREDENTIALS_FILE: '/missing' } }), token);
  for (const invalid of ['', 'Bearer ' + token, token + '\r\nInjected: yes']) await assert.rejects(readAccessToken({ environment: { ZUKU_ACCESS_TOKEN: invalid } }), { code: 'CREDENTIALS_INVALID' });
  const data = await diagnostics({ credentials: () => readAccessToken({ environment: { ZUKU_ACCESS_TOKEN: token, SERVICE_CLIENT_SECRET: privateValue } }) });
  assert.equal(JSON.stringify(data).includes(privateValue), false);
});
test('ZukuJS credential names take precedence over explicit legacy aliases', async () => {
  assert.equal(await readAccessToken({ environment: { ZUKUJS_ACCESS_TOKEN: token, ZUKU_ACCESS_TOKEN: privateValue, ZUKUJS_CREDENTIALS_FILE: '/missing' } }), token);
  await assert.rejects(readAccessToken({ environment: { ZUKUJS_ACCESS_TOKEN: '', ZUKU_ACCESS_TOKEN: token } }), { code: 'CREDENTIALS_INVALID' });
});
test('default credential file uses the ZukuJS directory and explicit file aliases retain ownership checks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zukujs-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'credentials.json');
  await writeFile(file, JSON.stringify({ access_token: token }), { mode: 0o600 });
  assert.equal(await readAccessToken({ environment: { ZUKUJS_CREDENTIALS_FILE: file, ZUKU_CREDENTIALS_FILE: '/missing' } }), token);
  await assert.rejects(readAccessToken({ environment: { ZUKUJS_CREDENTIALS_FILE: '/missing', ZUKU_CREDENTIALS_FILE: file } }), { code: 'CREDENTIALS_UNSAFE' });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(dir, '.config', 'zukujs'), { recursive: true });
  await writeFile(join(dir, '.config', 'zukujs', 'credentials.json'), JSON.stringify({ access_token: token }), { mode: 0o600 });
  assert.equal(await readAccessToken({ environment: {}, home: dir }), token);
});
test('platforms without POSIX ownership checks use env credentials or stay anonymous', async () => {
  assert.equal(await readAccessToken({ environment: {}, uid: null }), undefined);
  assert.equal(await readAccessToken({ environment: { ZUKU_ACCESS_TOKEN: token }, uid: null }), token);
  await assert.rejects(readAccessToken({ environment: { ZUKU_CREDENTIALS_FILE: '/private' }, uid: null }), { code: 'CREDENTIALS_UNSAFE' });
});
test('unknown API error codes and invalid authenticated account shapes are not trusted', async () => {
  const client = await apiClient(undefined, { fetch: async () => new Response(JSON.stringify({ success: false, error: { code: privateValue, message: token }, meta: {} }), { status: 401 }) });
  await assert.rejects(client.request('/billing/catalog'), error => error.code === 'UNAUTHORIZED' && !JSON.stringify(error).includes(privateValue));
  const clientFactory = async () => ({ request: async path => envelope(path === '/billing/catalog' ? catalog : { user: { email: privateValue } }) });
  await assert.rejects(diagnostics({ checkApi: true, credentials: async () => token, clientFactory }), { code: 'API_RESPONSE_INVALID' });
});
test('entrypoint version/help run without dependencies and output valid protocol JSON', () => {
  for (const args of [['--version', '--json'], ['--help', '--json']]) {
    const child = spawnSync(process.execPath, ['index.mjs', ...args], { cwd: new URL('../', import.meta.url), encoding: 'utf8', env: { PATH: process.env.PATH, NODE_OPTIONS: '' } });
    assert.equal(child.status, 0); assert.equal(JSON.parse(child.stdout).meta.protocol, identity.command_protocol); assert.equal(child.stderr, '');
  }
});
test('installed-style symlink bin executes the same canonical version command', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zuku-cli-bin-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'zukujs');
  await symlink(new URL('../index.mjs', import.meta.url).pathname, bin);
  const child = spawnSync(process.execPath, [bin, '--version', '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, NODE_OPTIONS: '' } });
  assert.equal(child.status, 0); assert.equal(JSON.parse(child.stdout).data.version, identity.version); assert.equal(child.stderr, '');
});
