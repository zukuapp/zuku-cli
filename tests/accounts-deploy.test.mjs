import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, symlink, link, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { accountClient, GAME_SCOPES, readTokens, readQuota, readDeployment } from '../lib/accounts/client.mjs';
import { loadZukuAccount, saveZukuAccount, readZukuAccessToken, withZukuAccountLock, removeZukuAccount, captureZukuAccountGeneration } from '../lib/accounts/store.mjs';
import { loadDeploymentOperation } from '../lib/accounts/deployment-store.mjs';
import { runLoginZuku } from '../commands/login-zuku.mjs';
import { runDeploy, recoverDeploy } from '../commands/deploy.mjs';
import { readDeployQuota, createGameDeployAdapter } from '../lib/accounts/deploy-quota.mjs';

// Static credentials are synthetic format fixtures, never live secrets.
const ACCESS = 'zuku_oa_' + 'a'.repeat(64), REFRESH = 'zuku_or_' + 'b'.repeat(64), NOW = 1000000;
const BYTES = zipSync({ 'index.html': Buffer.from('<!doctype html><html><title>Fixture</title><body>game</body></html>') }, { mtime: new Date('2020-01-01T00:00:00Z') });
const HASH = createHash('sha256').update(BYTES).digest('hex'), SIZE = BYTES.length;
const tokenData = () => ({ access_token: ACCESS, refresh_token: REFRESH, token_type: 'Bearer', expires_in: 900, scope: GAME_SCOPES.join(' ') });
const savedTokens = () => ({ access_token: ACCESS, refresh_token: REFRESH, expires_at: NOW + 900000, scope: GAME_SCOPES.join(' ') });
const envelope = data => ({ status: 200, data: { success: true, data, meta: { version: 'v1' } } });
const me = () => envelope({ user: { id: 'usr_1', handle: 'fixture' }, client_id: 'zuku-cli', scopes: [...GAME_SCOPES], expires_at: '2026-10-04T00:15:00Z' });
const quota = (remaining = 3, pending = 0) => envelope({ limit: 3, window_seconds: 21600, used: 3 - remaining - pending, pending, remaining, reset_at: remaining === 3 ? null : '2026-10-04T00:00:00Z', retry_after: remaining === 0 ? 60 : 0 });
const deployment = (key, status = 'draft', patch = {}) => envelope({ deployment: { idempotency_key: key, content_id: 'cnt_fixture', status, reserved_at: status === 'draft' ? null : '2026-10-03T00:00:00Z', completed_at: status === 'published' ? '2026-10-03T00:00:01Z' : null, package_sha256: HASH, size_bytes: SIZE, content_status: status === 'published' ? 'published' : 'draft', source_verified: true, ...patch } });
async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), 'zuku-account-test-')); await writeFile(join(dir, 'game.zip'), BYTES); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function context(cwd, overrides = {}) {
  return { cwd, zukuCredentials: async () => ACCESS, accountClientFactory: () => ({ me: async () => me(), quota: async () => quota(), deployment: async key => deployment(key), publish: async (id, key) => deployment(key, 'published') }), runUpload: async () => ({ content: { id: 'cnt_fixture', status: 'draft' }, package: { sha256: HASH, size_bytes: SIZE } }), ...overrides };
}
const device = () => ({ device_code: 'zuku_od_' + 'd'.repeat(64), user_code: 'ABCD-1234-EF56', verification_uri: 'https://www.zuzunza.com/oauth/device', verification_uri_complete: 'https://www.zuzunza.com/oauth/device?user_code=ABCD-1234-EF56', expires_in: 600, interval: 5 });

test('Canonical device form and identity route pin origin and omit cookies/redirects', async () => {
  const observed = [];
  const c = accountClient(undefined, { accessToken: ACCESS, fetch: async (url, init) => { observed.push({ url, init }); return new Response('{}'); } });
  await c.device(); await c.me(); await c.publish('cnt_fixture', 'fixture.key');
  assert.equal(observed[0].url, 'https://www.zuzunza.com/api/v1/oauth/device/authorization');
  assert.equal(new URLSearchParams(observed[0].init.body).get('client_id'), 'zuku-cli');
  assert.equal(new URLSearchParams(observed[0].init.body).get('scope'), 'games:upload games:create games:publish');
  assert.equal(observed[1].url.endsWith('/oauth/me'), true);
  assert.equal(observed[2].init.headers['Idempotency-Key'], 'fixture.key');
  assert.equal(observed[2].init.body, '{"mode":"yolo"}');
  for (const { init } of observed) { assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.headers.Cookie, undefined); }
  assert.throws(() => accountClient('https://evil.invalid/api/v1'), e => e.code === 'API_ORIGIN_REJECTED');
  assert.throws(() => accountClient('http://127.0.0.1:31300/api/v1'), e => e.code === 'API_ORIGIN_REJECTED');
  assert.doesNotThrow(() => accountClient('http://127.0.0.1:31300/api/v1', { allowFixtureOrigin: true }));
  assert.throws(() => accountClient(undefined, { accessToken: 'zk_oat_' + 'a'.repeat(64) }), e => e.code === 'ZUKU_LOGIN_REQUIRED');
});
test('Bounded OAuth errors discard remote exception text', async () => {
  await assert.rejects(accountClient(undefined, { fetch: async () => new Response('x'.repeat(131073)) }).device(), e => e.code === 'ZUKU_AUTH_RESPONSE_INVALID');
  await assert.rejects(accountClient(undefined, { fetch: async () => { throw new Error(ACCESS); } }).device(), e => e.code === 'ZUKU_AUTH_UNAVAILABLE' && !JSON.stringify(e.toJSON()).includes(ACCESS));
});
test('Tokens require exact canonical scopes and bounded lifetime', () => {
  assert.equal(readTokens({ status: 200, data: tokenData() }, NOW).expires_at, NOW + 900000);
  for (const patch of [{ token_type: 'JWT' }, { expires_in: 86400 }, { scope: 'games:read games:write games:publish' }, { access_token: 'shz_at_session' }, { refresh_token: '' }]) assert.throws(() => readTokens({ status: 200, data: { ...tokenData(), ...patch } }), e => e.code === 'ZUKU_AUTH_RESPONSE_INVALID');
});
test('Quota preserves pending reservations and rejects missing or inconsistent arithmetic', () => {
  assert.deepEqual(readQuota(quota(1, 1)), { limit: 3, window_seconds: 21600, used: 1, pending: 1, remaining: 1, reset_at: '2026-10-04T00:00:00Z', retry_after: 0 });
  for (const patch of [{ pending: undefined }, { pending: 3 }, { remaining: 2 }, { retry_after: 1 }, { reset_at: null }, { window_seconds: 1 }]) assert.throws(() => readQuota(envelope({ ...quota(1, 1).data.data, ...patch })), e => e.code === 'ZUKU_AUTH_RESPONSE_INVALID');
});
test('POSIX v2 account stores tokens privately and keeps shared state format internal', { skip: process.platform === 'win32' }, async t => {
  const home = await fixture(t); await saveZukuAccount(savedTokens(), { home });
  assert.equal((await stat(join(home, '.config', 'zukujs'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(home, '.config', 'zukujs', 'account.json'))).mode & 0o777, 0o600);
  const account = await loadZukuAccount({ home }); assert.equal(account.version, 2); assert.equal(account.state, 'connected');
  const other = await fixture(t); assert.equal(await readZukuAccessToken({ home: other, environment: { ZUKUJS_ACCESS_TOKEN: ACCESS }, now: () => NOW }), undefined);
});
test('POSIX store refuses links, loose file modes and unsafe directories', { skip: process.platform === 'win32' }, async t => {
  for (const kind of ['symlink', 'hardlink', 'loose', 'directory']) {
    const home = await fixture(t); await saveZukuAccount(savedTokens(), { home }); const file = join(home, '.config', 'zukujs', 'account.json');
    if (kind === 'symlink') { const copy = join(home, 'copy'); await writeFile(copy, await readFile(file), { mode: 0o600 }); await rm(file); await symlink(copy, file); }
    if (kind === 'hardlink') await link(file, join(home, 'other'));
    if (kind === 'loose') await chmod(file, 0o644);
    if (kind === 'directory') await chmod(join(home, '.config', 'zukujs'), 0o755);
    await assert.rejects(loadZukuAccount({ home }), e => e.code === 'ZUKU_ACCOUNT_UNSAFE');
  }
});
test('Concurrent store lock fails closed and cancellation enters no mutation', async t => {
  const home = await fixture(t); let ready, release; const started = new Promise(r => { ready = r; }); const pending = new Promise(r => { release = r; });
  const first = withZukuAccountLock(async () => { ready(); await pending; }, { home }); await started;
  await assert.rejects(withZukuAccountLock(async () => {}, { home, timeoutMs: 1 }), e => e.code === 'ZUKU_ACCOUNT_BUSY'); release(); await first;
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(withZukuAccountLock(async () => { calls++; }, { home, signal: controller.signal }), e => e.code === 'COMMAND_CANCELLED'); assert.equal(calls, 0);
});
test('Refresh rotation preserves generation and serializes concurrent refresh', async t => {
  const home = await fixture(t); await saveZukuAccount({ ...savedTokens(), expires_at: NOW - 1 }, { home }); const generation = await captureZukuAccountGeneration({ home }); let calls = 0;
  const factory = () => ({ refresh: async () => { calls++; return { status: 200, data: tokenData() }; } });
  await readZukuAccessToken({ home, now: () => NOW, accountClientFactory: factory }); await readZukuAccessToken({ home, now: () => NOW, accountClientFactory: factory });
  assert.equal(calls, 1); assert.equal(await captureZukuAccountGeneration({ home }), generation);
});
for (const action of ['logout', 'account switch']) test(`Delayed refresh cannot resurrect ${action}`, async t => {
  const home = await fixture(t); await saveZukuAccount({ ...savedTokens(), expires_at: NOW - 1 }, { home }); let ready, release; const started = new Promise(r => { ready = r; }); const pending = new Promise(r => { release = r; });
  const work = readZukuAccessToken({ home, now: () => NOW, accountClientFactory: () => ({ refresh: async () => { ready(); await pending; return { status: 200, data: tokenData() }; } }) }); await started;
  if (action === 'logout') await removeZukuAccount({ home }); else await saveZukuAccount({ ...savedTokens(), access_token: 'zuku_oa_' + 'c'.repeat(64) }, { home });
  release(); await assert.rejects(work, e => e.code === 'ZUKU_ACCOUNT_CHANGED');
  const stored = await loadZukuAccount({ home }); assert.equal(action === 'logout' ? stored === undefined : stored.access_token !== ACCESS, true);
  if (action === 'logout') { const raw = await readFile(join(home, '.config', 'zukujs', 'account.json'), 'utf8'); assert.equal(raw.includes('access_token'), false); assert.equal(JSON.parse(raw).state, 'logged_out'); }
});
test('Provisional own-store requires explicit new login and never transmits old credentials', async t => {
  const home = await fixture(t); await mkdir(join(home, '.config', 'zukujs'), { recursive: true, mode: 0o700 });
  await writeFile(join(home, '.config', 'zukujs', 'account.json'), JSON.stringify({ version: 1, client_id: 'zukujs-cli', api_base: 'https://www.zuzunza.com/api/v1', access_token: 'zk_oat_' + 'a'.repeat(64), refresh_token: 'zk_ort_' + 'b'.repeat(64), scope: 'games:read games:write games:publish', expires_at: NOW }), { mode: 0o600 });
  await assert.rejects(readZukuAccessToken({ home, accountClientFactory: () => { throw new Error('must not call'); } }), e => e.code === 'ZUKU_ACCOUNT_MIGRATION_REQUIRED');
  const previous = await captureZukuAccountGeneration({ home }); await saveZukuAccount(savedTokens(), { home, expectedGeneration: previous }); assert.ok(await loadZukuAccount({ home }));
});
test('Device login uses cumulative slow-down and exposes only official short code', async t => {
  const home = await fixture(t); let time = NOW, polls = 0, displayed; const waits = [];
  const factory = () => ({ device: async () => ({ status: 200, data: device() }), poll: async () => ++polls === 1 ? { status: 400, data: { error: 'authorization_pending' } } : polls === 2 ? { status: 400, data: { error: 'slow_down' } } : { status: 200, data: tokenData() }, me: async () => me() });
  const result = await runLoginZuku(['--no-browser'], { accountClientFactory: factory, accountStoreOptions: { home }, now: () => time, sleep: async ms => { waits.push(ms); time += ms; }, onDeviceCode: e => { displayed = e; } });
  assert.deepEqual(waits, [5000, 5000, 10000]); assert.equal(result.status, 'connected'); assert.equal(JSON.stringify(displayed).includes(device().device_code), false); assert.equal(JSON.stringify(result).includes('access_token'), false);
});
test('Delayed device login cannot restore a logged out generation', async t => {
  const home = await fixture(t); let time = NOW;
  await assert.rejects(runLoginZuku(['--no-browser'], { accountStoreOptions: { home }, now: () => time, sleep: async ms => { time += ms; await removeZukuAccount({ home }); }, accountClientFactory: () => ({ device: async () => ({ status: 200, data: device() }), poll: async () => ({ status: 200, data: tokenData() }), me: async () => me() }) }), e => e.code === 'ZUKU_ACCOUNT_CHANGED');
  assert.equal(await loadZukuAccount({ home }), undefined);
});
test('Malicious verification URL is refused before browser opening', async t => {
  const home = await fixture(t); let opened = 0;
  await assert.rejects(runLoginZuku([], { accountStoreOptions: { home }, accountClientFactory: () => ({ device: async () => ({ status: 200, data: { ...device(), verification_uri: 'https://evil.invalid' } }) }), openBrowser: () => { opened++; } }), e => e.code === 'ZUKU_AUTH_RESPONSE_INVALID'); assert.equal(opened, 0);
});
test('YOLO and game OAuth are mandatory; exhausted quota causes zero uploads', async t => {
  const cwd = await fixture(t); let uploads = 0;
  await assert.rejects(runDeploy(['game.zip'], context(cwd)), e => e.code === 'DEPLOY_YOLO_REQUIRED');
  await assert.rejects(runDeploy(['game.zip', '--yolo'], context(cwd, { zukuCredentials: async () => 'shz_at_session' })), e => e.code === 'ZUKU_LOGIN_REQUIRED');
  await assert.rejects(runDeploy(['game.zip', '--yolo'], context(cwd, { accountClientFactory: () => ({ me: async () => me(), quota: async () => quota(0) }), runUpload: async () => { uploads++; } })), e => e.code === 'DEPLOY_QUOTA_EXCEEDED' && e.retryAfter === 60);
  assert.equal(uploads, 0); assert.equal((await readDeployQuota(context(cwd))).remaining, 3);
});
test('One-shot draft and publication share durable key and source identity', async t => {
  const cwd = await fixture(t); let key, posts = 0;
  const result = await runDeploy(['game.zip', '--yolo'], context(cwd, { runUpload: async (_, o) => { key = o.idempotencyKey; const op = await loadDeploymentOperation(join(cwd, '.zukujs', 'receipts')); assert.equal(op.idempotency_key, key); assert.equal(op.owner_id, 'usr_1'); assert.equal(op.size_bytes, SIZE); return { content: { id: 'cnt_fixture', status: 'draft' }, package: { sha256: HASH, size_bytes: SIZE } }; }, accountClientFactory: () => ({ me: async () => me(), quota: async () => quota(), deployment: async k => deployment(k), publish: async (id, k) => { posts++; assert.equal(k, key); return deployment(k, 'published'); } }) }));
  assert.equal(posts, 1); assert.equal(result.published, true); assert.equal(result.quota_consumed, null);
  const raw = await readFile(join(cwd, result.receipt.path), 'utf8'); assert.equal(raw.includes(ACCESS), false); assert.equal(JSON.parse(raw).size_bytes, SIZE);
});
test('Lost publication response uses only bound status GET and never replays POST', async t => {
  const cwd = await fixture(t); let posts = 0, gets = 0;
  const result = await runDeploy(['game.zip', '--yolo'], context(cwd, { accountClientFactory: () => ({ me: async () => me(), quota: async () => quota(), deployment: async k => deployment(k, ++gets === 1 ? 'draft' : 'published'), publish: async () => { posts++; throw new Error(ACCESS); } }) }));
  assert.equal(posts, 1); assert.equal(gets, 2); assert.equal(result.recovered, true); assert.equal(JSON.stringify(result).includes(ACCESS), false);
});
test('A hash-only content response cannot prove publication or release a pending attempt', async t => {
  const cwd = await fixture(t); let gets = 0, posts = 0;
  await assert.rejects(runDeploy(['game.zip', '--yolo'], context(cwd, { accountClientFactory: () => ({ me: async () => me(), quota: async () => quota(), deployment: async k => deployment(k, ++gets === 1 ? 'draft' : 'publishing'), publish: async () => { posts++; return envelope({ content: { id: 'cnt_fixture', jump: { status: 'published' } } }); } }) })), e => e.code === 'DEPLOY_OUTCOME_UNKNOWN');
  assert.equal(posts, 1);
  const op = await loadDeploymentOperation(join(cwd, '.zukujs', 'receipts'));
  for (const patch of [{ package_sha256: 'c'.repeat(64) }, { size_bytes: SIZE + 1 }, { idempotency_key: 'other.key' }, { source_verified: false }, { content_id: 'cnt_other' }]) assert.throws(() => readDeployment(deployment(op.idempotency_key, 'published', patch), op, { complete: true }), e => e.code === 'DEPLOY_OUTCOME_UNKNOWN');
});
test('Explicit recovery observes pending/draft/published without a mutation', async t => {
  const cwd = await fixture(t); let phase = 'draft', posts = 0;
  const c = context(cwd, { accountClientFactory: () => ({ me: async () => me(), quota: async () => quota(), deployment: async k => deployment(k, phase), publish: async () => { posts++; phase = 'publishing'; throw new Error('lost'); } }) });
  await assert.rejects(runDeploy(['game.zip', '--yolo'], c), e => e.code === 'DEPLOY_OUTCOME_UNKNOWN');
  await assert.rejects(recoverDeploy(c), e => e.code === 'DEPLOY_OUTCOME_UNKNOWN'); phase = 'draft'; assert.equal((await recoverDeploy(c)).status, 'not_published'); phase = 'published'; assert.equal((await recoverDeploy(c)).published, true); assert.equal(posts, 1);
});
test('Successful replay with a saved canonical operation consumes no new upload or publish', async t => {
  const cwd = await fixture(t); await runDeploy(['game.zip', '--yolo'], context(cwd)); let posts = 0;
  const result = await runDeploy(['--content', 'cnt_fixture', '--yolo'], context(cwd, { accountClientFactory: () => ({ me: async () => me(), deployment: async k => deployment(k, 'published'), publish: async () => { posts++; } }) }));
  assert.equal(result.idempotent, true); assert.equal(result.quota_consumed, false); assert.equal(posts, 0);
});
test('Confirmed limit response is safe, not retried, and preserves retry interval', async t => {
  const cwd = await fixture(t); let posts = 0, gets = 0;
  await assert.rejects(runDeploy(['game.zip', '--yolo'], context(cwd, { accountClientFactory: () => ({ me: async () => me(), quota: async () => quota(), deployment: async k => { gets++; return deployment(k); }, publish: async () => { posts++; return { status: 429, retryAfter: 60, data: { success: false, error: { code: 'PRODUCTION_DEPLOY_LIMIT', message: ACCESS } } }; } }) })), e => e.code === 'DEPLOY_QUOTA_EXCEEDED' && e.retryAfter === 60 && !JSON.stringify(e.toJSON()).includes(ACCESS));
  assert.equal(posts, 1); assert.equal(gets, 1);
});
test('Verified screenshot path, metadata project input and receipt directory propagate', async t => {
  const cwd = await fixture(t); let thumbnail, input;
  const dir = join(cwd, 'receipts'); const result = await createGameDeployAdapter(context(cwd, { thumbnailUploader: async (_, options) => { assert.equal(options.cwd, cwd); assert.equal(options.thumbnailDirectory, join(cwd, '.zukujs', 'agent')); return { verified: true, url: '/uploads/2026-10/cover.png' }; }, runUpload: async (args, o) => { input = args[0]; thumbnail = o.thumbnailUrl; return { content: { id: 'cnt_fixture', status: 'draft' }, package: { sha256: HASH, size_bytes: SIZE } }; } })).run('ignored.zip', { yolo: true, project_root: 'game.zip', package_sha256: HASH, thumbnail: {}, receiptDir: dir });
  assert.equal(result.status, 'published'); assert.equal(result.content_id, 'cnt_fixture'); assert.equal(input, 'game.zip'); assert.equal(thumbnail, '/uploads/2026-10/cover.png'); assert.equal((await stat(join(dir, 'deploy-operation.json'))).mode & 0o777, 0o600);
});
test('Account switch after preflight dispatches no mutation', async t => {
  const cwd = await fixture(t); let token = ACCESS, calls = 0;
  const adapter = createGameDeployAdapter(context(cwd, { zukuCredentials: async () => token, runUpload: async () => { calls++; } }));
  await adapter.preflight(); token = 'zuku_oa_' + 'd'.repeat(64); await assert.rejects(adapter.run('game.zip', { yolo: true }), e => e.code === 'ZUKU_ACCOUNT_CHANGED' && e.definite); assert.equal(calls, 0);
});
test('Cancellation during credential await sends zero API requests', async t => {
  const cwd = await fixture(t); const controller = new AbortController(); let calls = 0;
  const adapter = createGameDeployAdapter(context(cwd, { zukuCredentials: async () => { controller.abort(); return ACCESS; }, accountClientFactory: () => { calls++; return {}; } }));
  await assert.rejects(adapter.preflight({ signal: controller.signal }), e => e.code === 'COMMAND_CANCELLED'); assert.equal(calls, 0);
});
test('Changed local package blocks cover/upload and changed receipt blocks publication', async t => {
  const cwd = await fixture(t); let covers = 0, uploads = 0, posts = 0;
  const c = context(cwd, { thumbnail: {}, thumbnailUploader: async () => { covers++; return { verified: true, url: '/uploads/2026-10/a.png' }; }, runUpload: async () => { uploads++; return { content: { id: 'cnt_fixture', status: 'draft' }, package: { sha256: 'c'.repeat(64), size_bytes: SIZE } }; }, accountClientFactory: () => ({ me: async () => me(), quota: async () => quota(), publish: async () => { posts++; } }) });
  await assert.rejects(runDeploy(['game.zip', '--yolo'], { ...c, expectedPackageSha256: 'd'.repeat(64) }), e => e.code === 'DEPLOY_SOURCE_CHANGED'); assert.equal(covers + uploads + posts, 0);
  await assert.rejects(runDeploy(['game.zip', '--yolo'], { ...c, expectedPackageSha256: HASH }), e => e.code === 'DEPLOY_SOURCE_CHANGED'); assert.equal(covers, 1); assert.equal(uploads, 1); assert.equal(posts, 0);
});

test('Native inference permission requires explicit generate consent and survives rotation', async t => {
  const home = await fixture(t); let requested, time = NOW;
  const scopes = [...GAME_SCOPES, 'games:generate'];
  const factory = (_, o) => ({ device: async () => { requested = o.requestedScopes; return { status: 200, data: device() }; }, poll: async () => ({ status: 200, data: { ...tokenData(), scope: scopes.join(' ') } }), me: async () => envelope({ ...me().data.data, scopes }) });
  const result = await runLoginZuku(['--generate', '--no-browser'], { accountStoreOptions: { home }, accountClientFactory: factory, now: () => time, sleep: async ms => { time += ms; } });
  assert.deepEqual(requested, scopes); assert.deepEqual(result.scopes, scopes); assert.equal((await loadZukuAccount({ home })).scope, scopes.join(' '));
  assert.throws(() => readTokens({ status: 200, data: tokenData() }, NOW, scopes), e => e.code === 'ZUKU_AUTH_RESPONSE_INVALID');
  assert.throws(() => readTokens({ status: 200, data: { ...tokenData(), scope: scopes.join(' ') + ' billing:write' } }), e => e.code === 'ZUKU_AUTH_RESPONSE_INVALID');
});
test('Ambiguous rotating-refresh response retires only its generation and is not retried', async t => {
  const home = await fixture(t); await saveZukuAccount({ ...savedTokens(), expires_at: 1 }, { home }); let calls = 0;
  const factory = () => ({ refresh: async () => { calls++; throw new Error(ACCESS); } });
  await assert.rejects(readZukuAccessToken({ home, now: () => NOW, accountClientFactory: factory }), e => e.code === 'ZUKU_ACCOUNT_EXPIRED');
  assert.equal(await readZukuAccessToken({ home, accountClientFactory: factory }), undefined); assert.equal(calls, 1);
});
test('Re-login with identical token still changes the account generation before mutation', async t => {
  const cwd = await fixture(t), home = await fixture(t); await saveZukuAccount({ ...savedTokens(), expires_at: Date.now() + 900000 }, { home }); let posts = 0;
  const c = context(cwd, { accountStoreOptions: { home }, zukuCredentials: undefined, runUpload: async () => { posts++; } });
  const adapter = createGameDeployAdapter(c); await adapter.preflight(); await saveZukuAccount({ ...savedTokens(), expires_at: Date.now() + 900000 }, { home });
  await assert.rejects(adapter.run('game.zip', { yolo: true }), e => e.code === 'ZUKU_ACCOUNT_CHANGED'); assert.equal(posts, 0);
});
test('Known published receipt wins over cancellation after the server response', async t => {
  const cwd = await fixture(t); const controller = new AbortController();
  const result = await runDeploy(['game.zip', '--yolo'], context(cwd, { signal: controller.signal, accountClientFactory: () => ({ me: async () => me(), quota: async () => quota(), deployment: async k => deployment(k), publish: async (id, key) => { controller.abort(); return deployment(key, 'published'); } }) }));
  assert.equal(result.published, true);
});

test('Native account factory reads only official protected grant with explicit inference scope', async t => {
  const { createZukuAccountClient } = await import('../lib/accounts/oauth.mjs'); const home = await fixture(t); const factory = createZukuAccountClient({ home });
  await assert.rejects(factory.ensureFresh(), e => e.code === 'ZUKU_LOGIN_REQUIRED');
  await saveZukuAccount({ ...savedTokens(), expires_at: Date.now() + 900000 }, { home });
  await assert.rejects(factory.ensureFresh(), e => e.code === 'ZUKU_GENERATE_SCOPE_REQUIRED');
  await saveZukuAccount({ ...savedTokens(), scope: [...GAME_SCOPES, 'games:generate'].join(' '), expires_at: Date.now() + 900000 }, { home });
  const grant = await factory.ensureFresh(); assert.equal(grant.accessToken, ACCESS); assert.equal(grant.scopes.includes('games:generate'), true); assert.match(grant.generation, /^[a-f0-9]{64}$/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(factory.ensureFresh({ signal: controller.signal }), e => e.code === 'COMMAND_CANCELLED');
});
