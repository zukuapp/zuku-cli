import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, chmod, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createProviderRuntime } from '../lib/provider-system/index.mjs';
import { loadWindowsProtectedStore } from '../lib/provider-system/secret-store.mjs';
import provider from '../commands/provider.mjs';
import model from '../commands/model.mjs';
import auth from '../commands/auth.mjs';

const SECRET = 'sk-fixture-only-' + 'a1b2c3d4'.repeat(4);
const posix = process.platform !== 'win32';
const repo = new URL('../', import.meta.url);
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zuku-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const base = (dir, extra = {}) => ({ home: dir, environment: {}, adapters: null, experimental: undefined, legacyAuth: {}, ...extra });
const nonTty = (dir, extra = {}) => ({ home: dir, environment: {}, stdin: Readable.from([]), stderr: { write() {}, isTTY: false }, providerContext: { adapters: null, experimental: undefined, legacyAuth: {} }, ...extra });
const stateDir = dir => join(dir, '.config', 'zukujs', 'providers');

test('config and secrets are separate owner-only files; secrets never appear in config or projections', { skip: !posix }, async t => {
  const dir = await home(t);
  const ctx = nonTty(dir, { stdin: Readable.from([SECRET + '\n']) });
  const result = await auth(['login', '--provider', 'openai', '--api-key-stdin'], ctx);
  assert.equal(result.status, 'configured'); assert.equal(result.method.official, true); assert.equal(result.method.experimental, false);
  const root = stateDir(dir);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, 'secrets.json'))).mode & 0o777, 0o600);
  const authConfig = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.deepEqual(authConfig.providers, {});
  assert.match(authConfig.authRevisions.openai, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(authConfig).includes(SECRET), false);
  await provider(['configure', 'openai', '--model', 'gpt-fixture'], nonTty(dir));
  assert.equal((await stat(join(root, 'config.json'))).mode & 0o777, 0o600);
  const config = await readFile(join(root, 'config.json'), 'utf8');
  assert.equal(config.includes(SECRET), false);
  const outputs = [await provider(['list'], nonTty(dir)), await auth(['list'], nonTty(dir)), await model(['list', '--provider', 'openai'], nonTty(dir))];
  for (const output of outputs) assert.equal(JSON.stringify(output).includes(SECRET), false);
  const row = outputs[1].find(item => item.provider === 'openai');
  assert.deepEqual([row.status, row.method.id], ['configured', 'api-key']);
  const logout = await auth(['logout', '--provider', 'openai'], nonTty(dir));
  assert.equal(logout.status, 'removed');
  assert.equal((await readFile(join(root, 'secrets.json'), 'utf8')).includes(SECRET), false);
});

test('secrets in argv, public config, header refs or env-shaped values are rejected without echo', async t => {
  const dir = await home(t);
  for (const args of [['login', '--provider', 'openai', '--api-key', SECRET], ['login', '--provider', 'openai', `--api-key=${SECRET}`], ['login', '--provider', 'openai', '--token', 'x'], ['login', SECRET]]) {
    await assert.rejects(auth(args, nonTty(dir)), error => error.code === 'AUTH_SECRET_ARGUMENT' && !error.message.includes(SECRET) && !String(error.stack).includes(SECRET));
  }
  await assert.rejects(provider(['add', '--id', 'x', '--type', 'openai-chat', '--base-url', 'https://e.test/v1', '--header-env', `Authorization=${SECRET}`], nonTty(dir)), error => !JSON.stringify(error).includes(SECRET));
  const runtime = await createProviderRuntime(base(dir));
  await assert.rejects(runtime.addProvider({ id: 'x', apiType: 'openai-chat', baseUrl: 'https://e.test/v1', headers: { 'X-Key': { source: 'value', value: 'abc' } } }), { code: 'PROVIDER_SECRET_IN_CONFIG' });
  await assert.rejects(runtime.configureProvider('openai', { addModels: [{ id: 'm', apiKey: 'x' }] }), error => ['PROVIDER_SECRET_IN_CONFIG', 'PROVIDER_CONFIG_INVALID'].includes(error.code));
  if (posix) {
    await mkdir(stateDir(dir), { recursive: true, mode: 0o700 });
    await writeFile(join(stateDir(dir), 'config.json'), JSON.stringify({ version: 1, providers: { openai: { options: {}, models: [{ id: 'gpt', name: SECRET }] } } }), { mode: 0o600 });
    await assert.rejects(createProviderRuntime(base(dir)), error => error.code === 'PROVIDER_SECRET_IN_CONFIG' && !error.message.includes(SECRET));
  }
});

test('symlinked, hard-linked or group-readable state files are refused', { skip: !posix }, async t => {
  const dir = await home(t);
  const root = stateDir(dir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const outside = join(dir, 'outside.json');
  await writeFile(outside, JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
  await symlink(outside, join(root, 'config.json'));
  await assert.rejects(createProviderRuntime(base(dir)), { code: 'PROVIDER_CONFIG_UNSAFE' });
  await rm(join(root, 'config.json'));
  await link(outside, join(root, 'config.json'));
  await assert.rejects(createProviderRuntime(base(dir)), { code: 'PROVIDER_CONFIG_UNSAFE' });
  await rm(join(root, 'config.json'));
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, providers: {} }), { mode: 0o644 });
  await chmod(join(root, 'config.json'), 0o644);
  await assert.rejects(createProviderRuntime(base(dir)), { code: 'PROVIDER_CONFIG_UNSAFE' });
  await rm(join(root, 'config.json'));
  await writeFile(join(dir, 'secret-target'), '{}', { mode: 0o600 });
  await symlink(join(dir, 'secret-target'), join(root, 'secrets.json'));
  const runtime = await createProviderRuntime(base(dir));
  await assert.rejects(runtime.authList(), { code: 'SECRET_STORE_UNSAFE' });
  await assert.rejects(runtime.authLogin('openai', { apiKey: SECRET }), { code: 'SECRET_STORE_UNSAFE' });
  assert.equal(await readFile(join(dir, 'secret-target'), 'utf8'), '{}');
});

test('concurrent processes never lose configuration updates (lock + atomic replace)', async t => {
  const dir = await home(t);
  const script = `const { createProviderRuntime } = await import(${JSON.stringify(new URL('lib/provider-system/index.mjs', repo).href)});
const runtime = await createProviderRuntime({ home: process.argv[1], environment: {}, adapters: null, experimental: undefined, legacyAuth: {} });
await runtime.addProvider({ id: 'p' + process.argv[2], name: 'P', apiType: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' });
await runtime.configureProvider('openai', { addModels: [{ id: 'model-' + process.argv[2] }] });`;
  const children = Array.from({ length: 8 }, (_, index) => spawn(process.execPath, ['--input-type=module', '-e', script, dir, String(index)], { stdio: ['ignore', 'ignore', 'pipe'] }));
  const codes = await Promise.all(children.map(async child => { let err = ''; child.stderr.on('data', chunk => { err += chunk; }); const [code] = await once(child, 'exit'); return { code, err }; }));
  assert.deepEqual(codes.map(item => item.code), Array(8).fill(0), codes.map(item => item.err).join('\n'));
  const runtime = await createProviderRuntime(base(dir));
  const rows = await runtime.listProviders();
  for (let index = 0; index < 8; index++) assert.ok(rows.some(row => row.id === `p${index}`), `p${index}`);
  assert.equal(rows.find(row => row.id === 'openai').models.length, 8);
  assert.deepEqual((await readdir(stateDir(dir))).filter(name => name.endsWith('.tmp') || name === '.lock'), []);
});

test('`zuku` and `zukujs` invocation names share one provider/model/auth state', async t => {
  const dir = await home(t);
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const probe = `(async () => { const [cmd, ...args] = process.argv.slice(2); const mod = await import(${JSON.stringify(new URL('commands/', repo).href)} + cmd + '.mjs');
const { Readable } = require('node:stream');
const data = await mod.default(args, { home: ${JSON.stringify(dir)}, environment: {}, stdin: Readable.from([]), stderr: process.stderr, providerContext: { adapters: null, experimental: undefined, legacyAuth: {} } });
process.stdout.write(JSON.stringify(data)); })().catch(error => { process.stderr.write(String(error.code)); process.exitCode = 1; });`;
  await writeFile(join(bin, 'probe.cjs'), probe);
  for (const name of ['zuku', 'zukujs']) await symlink(join(bin, 'probe.cjs'), join(bin, name));
  const run = (name, ...args) => {
    const result = spawnSync(process.execPath, [join(bin, name), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  run('zuku', 'provider', 'add', '--id', 'local-ai', '--name', 'Local AI', '--type', 'openai-chat', '--base-url', 'http://localhost:8000/v1', '--model', 'my-model');
  assert.ok(run('zukujs', 'provider', 'list').some(row => row.id === 'local-ai'));
  run('zukujs', 'model', 'use', 'local-ai/my-model');
  assert.deepEqual(run('zuku', 'model', 'current'), { provider: 'local-ai', model: 'local-ai/my-model' });
  run('zuku', 'provider', 'use', 'zuku');
  assert.deepEqual(run('zukujs', 'model', 'current'), { provider: 'zuku', model: 'zuku/auto' });
});

test('Windows: secrets go through the protected store (DPAPI seam) and fail closed without it', async t => {
  const dir = await home(t);
  // Test double for the DPAPI module: reversible transform, NOT a real protection claim.
  const protectedStore = {
    async writeProtectedStore(file, plain) { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, Buffer.concat([Buffer.from('DPAPI-DOUBLE:'), Buffer.from(plain).map(byte => byte ^ 0x5a)])); },
    async readProtectedStore(file) { try { return Buffer.from((await readFile(file)).subarray(13)).map(byte => byte ^ 0x5a).toString(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    async withProtectedStoreLock(file, operation, options) { assert.equal(typeof file, 'string'); assert.ok(Object.hasOwn(options, 'signal')); return operation(); },
  };
  const runtime = await createProviderRuntime({ ...base(dir), platform: 'win32', stateDir: join(dir, 'win'), protectedStore });
  await runtime.authLogin('anthropic', { apiKey: SECRET });
  const blob = await readFile(join(dir, 'win', 'secrets.dpapi'));
  assert.equal(blob.includes(Buffer.from(SECRET)), false);
  assert.equal((await runtime.authList()).find(row => row.provider === 'anthropic').status, 'configured');
  await assert.rejects(loadWindowsProtectedStore(async () => { throw Object.assign(Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' }); }), { code: 'SECRET_STORE_UNAVAILABLE' });
  await assert.rejects(loadWindowsProtectedStore(async () => ({ encrypt() {} })), { code: 'SECRET_STORE_UNAVAILABLE' });
  if (!posix) return; // Actual Windows default API is covered separately, not expected to fail.
  const closed = await createProviderRuntime({ ...base(dir), platform: 'win32', stateDir: join(dir, 'win2'), protectedStore: undefined });
  // Without a usable DPAPI module (absent here, or not functional off-Windows) nothing is written.
  await assert.rejects(closed.authLogin('anthropic', { apiKey: SECRET }), error => ['SECRET_STORE_UNAVAILABLE', 'SECRET_STORE_UNSAFE'].includes(error.code));
  await assert.rejects(readFile(join(dir, 'win2', 'secrets.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dir, 'win2', 'secrets.dpapi')), { code: 'ENOENT' });
});
