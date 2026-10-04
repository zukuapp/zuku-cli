import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { mkdir, mkdtemp, copyFile, writeFile, chmod, chown, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { validateRequest, validateEvent } from '../lib/agent-protocol/schema.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const native = `${root}studio/native/linux`;
const binary = `${native}/build/zuku-studio`;
const available = process.platform === 'linux' && spawnSync('pkg-config', ['--exists', 'gtk+-3.0', 'webkit2gtk-4.1', 'javascriptcoregtk-4.1', 'gio-unix-2.0']).status === 0;
const options = { skip: available ? false : 'Linux GTK3/WebKitGTK 4.1 development tools are unavailable' };
if (available) {
  const build = spawnSync('make', ['-s', 'all'], { cwd: native, encoding: 'utf8', timeout: 30000 });
  assert.equal(build.status, 0, build.stderr);
  assert.equal(existsSync(binary), true);
}

const envelope = (method, params = {}) => ({ protocolVersion: 1, id: 'ui_fixture', method, params });
function admits(value) {
  const run = spawnSync(binary, ['--validate-request'], { input: JSON.stringify(value), encoding: 'utf8', timeout: 5000 });
  assert.equal(run.signal, null);
  assert.match(run.stdout, /^(ACCEPT|REJECT)\n$/);
  return run.status === 0;
}
function bridge() {
  const sent = [], handlers = new Map(), timers = new Map(); let nextTimer = 0;
  const window = { webkit: { messageHandlers: { zuku: { postMessage(message) { assert.equal(typeof message, 'string'); sent.push(JSON.parse(message)); } } } }, addEventListener(name, callback) { handlers.set(name, callback); } };
  vm.runInNewContext(readFileSync(`${root}studio/native/bridge.js`, 'utf8'), {
    window, crypto: webcrypto, Uint8Array, TextEncoder,
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout(id) { timers.delete(id); },
  });
  const reply = (message, result) => window.ZukuStudioReceive({ protocolVersion: 1, id: message.id, result });
  return { window, sent, handlers, timers, reply };
}

test('Linux C calls the current common request schema for canonical renderer calls', options, () => {
  const cases = [envelope('hello'), envelope('project.list'), envelope('project.read', { projectHandle: 'project_fixture', path: 'src/game.mjs' }), envelope('session.create', { projectHandle: 'project_fixture' }), envelope('session.input', { sessionId: 'session_fixture', requestId: 'input_fixture', operation: 'game.maintain', request: '게임 점프 추가', experimental: false }), envelope('auth.request', { providerId: 'codex', experimental: false })];
  for (const value of cases) { validateRequest(value, { native: true }); assert.equal(admits(value), true, value.method); }
});

test('Linux C rejects renderer native authority, OS paths, credentials and execution fields', options, () => {
  const cases = [
    envelope('project.grant', { localPath: '/etc' }), envelope('native.projectChosen', { requestId: 'ui_fixture', localPath: '/etc' }),
    envelope('native.resolvePreview', { previewHandle: 'preview_fixture' }), envelope('native.pairingDecision', { requestId: 'pair_fixture', allow: true }),
    envelope('native.authResponse', { requestId: 'auth_fixture', value: 'synthetic-fixture-value' }),
    envelope('project.read', { projectHandle: 'project_fixture', path: '/etc/passwd' }), envelope('project.read', { projectHandle: 'project_fixture', path: '../auth.json' }),
    envelope('auth.request', { providerId: 'codex', token: 'synthetic-fixture-value' }), envelope('session.create', { projectHandle: 'project_fixture', command: 'fixture' }),
    { ...envelope('project.list'), native: true }, { ...envelope('project.list'), protocolVersion: 2 },
  ];
  for (const value of cases) assert.equal(admits(value), false, value.method);
});

test('Linux private bridge admits only typed picker, subscriptions and opaque preview bounds', options, () => {
  for (const value of [envelope('native.pickProject'), envelope('native.subscribe', { subscriptionId: 'sub_fixture', sessionId: 'session_fixture', afterSequence: 0 }), envelope('native.unsubscribe', { subscriptionId: 'sub_fixture' }), envelope('native.previewShow', { previewHandle: 'preview_fixture', rect: { x: 0, y: 8, width: 640, height: 480 } }), envelope('native.previewHide')]) assert.equal(admits(value), true);
  for (const value of [envelope('native.pickProject', { localPath: '/etc' }), envelope('native.subscribe', { subscriptionId: 'sub_fixture', sessionId: 'session_fixture', afterSequence: 0.5 }), envelope('native.unsubscribe', { subscriptionId: 'sub_fixture', cancel: true }), envelope('native.previewShow', { url: 'http://127.0.0.1:1/', previewHandle: 'preview_fixture', rect: { x: 0, y: 0, width: 640, height: 480 } }), envelope('native.previewShow', { previewHandle: 'preview_fixture', rect: { x: -1, y: 0, width: 640, height: 480 } }), envelope('native.previewHide', { sessionId: 'session_fixture' })]) assert.equal(admits(value), false);
});

test('Linux C request body is bounded and malformed input never opens a host', options, () => {
  for (const input of ['{', '[]', JSON.stringify(envelope('session.input', { sessionId: 'session_fixture', requestId: 'input_fixture', operation: 'game.maintain', request: 'x'.repeat(70000) }))]) {
    const run = spawnSync(binary, ['--validate-request'], { input, encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 1); assert.equal(run.stdout, 'REJECT\n'); assert.equal(run.stderr, '');
  }
  const rootLaunch = typeof process.getuid === 'function' && process.getuid() === 0;
  if (rootLaunch) { const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000 }); assert.equal(run.status, 2); assert.match(run.stderr, /STUDIO_USER_REQUIRED/); }
});

test('shared native preload uses string wire and resolves opaque project results unwrapped', options, async () => {
  const fixture = bridge();
  assert.equal(Object.isFrozen(fixture.window.zukuStudio), true);
  const selection = fixture.window.zukuStudio.pickProject(), message = fixture.sent.at(-1);
  assert.equal(admits(message), true); assert.equal(message.method, 'native.pickProject');
  fixture.reply(message, { projectHandle: 'project_fixture', name: '게임' });
  const result = await selection; assert.equal(result.projectHandle, 'project_fixture'); assert.equal(result.name, '게임');
  assert.equal(fixture.timers.size, 0);
  await assert.rejects(fixture.window.zukuStudio.call('native.projectChosen', { localPath: '/etc' }), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(fixture.sent.length, 1);
});

test('native subscription forwards canonical events and detach never requests Core cancellation', options, async () => {
  const fixture = bridge(), received = [];
  const unsubscribe = fixture.window.zukuStudio.subscribe({ sessionId: 'session_fixture', afterSequence: 0 }, event => received.push(event));
  const subscribe = fixture.sent.at(-1); assert.equal(admits(subscribe), true); fixture.reply(subscribe, { status: 'connected' });
  const event = { protocolVersion: 1, sessionId: 'session_fixture', sequence: 1, eventId: 'event_fixture', time: new Date().toISOString(), type: 'agent.started', data: { operation: 'game.maintain', requestId: 'input_fixture' } };
  validateEvent(event); fixture.window.ZukuStudioReceive({ protocolVersion: 1, type: 'native.subscription', data: { subscriptionId: subscribe.params.subscriptionId, event } });
  assert.equal(received.length, 1); assert.equal(received[0].sequence, 1);
  unsubscribe(); unsubscribe(); const detach = fixture.sent.at(-1); assert.equal(detach.method, 'native.unsubscribe'); assert.equal(admits(detach), true); fixture.reply(detach, { status: 'closed' });
  assert.equal(fixture.sent.filter(item => item.method === 'native.unsubscribe').length, 1);
  assert.equal(fixture.sent.some(item => item.method === 'session.cancel'), false);
  await Promise.resolve(); assert.equal(fixture.timers.size, 0);
});

test('pagehide releases native subscription without publishing or cancelling work', options, async () => {
  const fixture = bridge(); fixture.window.zukuStudio.subscribe({ sessionId: 'session_fixture', afterSequence: 0 }, () => {});
  fixture.reply(fixture.sent.at(-1), { status: 'connected' }); await Promise.resolve(); fixture.handlers.get('pagehide')();
  assert.equal(fixture.sent.at(-1).method, 'native.unsubscribe'); assert.equal(admits(fixture.sent.at(-1)), true);
  assert.equal(fixture.sent.some(item => /cancel|publish/.test(item.method)), false); assert.equal(fixture.timers.size, 0);
});

for (const packageName of ['@zuku/cli', '@zukujs/cli']) test(`installed Linux shell locates ${packageName} with one managed runtime and rejects substituted release markers`, options, async t => {
  const privateRoot = join(root, '.codex'); await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const fixture = await mkdtemp(join(privateRoot, 'linux-release-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const release = join(fixture, 'release 공백'), packageRoot = join(release, 'npm/lib/node_modules', packageName);
  const installed = join(release, 'studio/linux/zuku-studio'), runtime = join(release, 'runtime/bin/node'), markerPath = join(release, 'install.json');
  for (const directory of [join(release, 'studio/linux'), join(release, 'runtime/bin'), join(packageRoot, 'lib/agent-protocol'), join(packageRoot, 'studio/native/linux/tests')]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await copyFile(binary, installed); await chmod(installed, 0o700);
  // This test copies the current test Node, not an official pinned download.
  await copyFile(process.execPath, runtime); await chmod(runtime, 0o700);
  if (typeof process.getuid === 'function') await chown(runtime, process.getuid(), process.getgid());
  const packageMetadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ ...packageMetadata, name: packageName }), { mode: 0o600 });
  await copyFile(join(root, 'lib/agent-protocol/schema.mjs'), join(packageRoot, 'lib/agent-protocol/schema.mjs'));
  await copyFile(join(native, 'tests/stdio-fixture.mjs'), join(packageRoot, 'studio/native/linux/tests/stdio-fixture.mjs'));
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const marker = { schema: 'zukujs-user-install/1', version, sha256: '0'.repeat(64), node: runtime };
  const save = value => writeFile(markerPath, JSON.stringify(value), { mode: 0o600 });
  const run = args => spawnSync(installed, args, { encoding: 'utf8', timeout: 8000 });
  await save(marker); const pipe = run(['--stdio-test']); assert.equal(pipe.status, 0, pipe.stderr); assert.match(pipe.stdout, /3 versioned C\/Node fixture round trips/);
  if (packageName === '@zukujs/cli') {
    const canonical = join(release, 'npm/lib/node_modules/@zuku/cli'); await mkdir(canonical, { recursive: true, mode: 0o700 });
    await writeFile(join(canonical, 'package.json'), JSON.stringify({ ...packageMetadata, name: 'foreign-package' }), { mode: 0o600 });
    assert.equal(run(['--version']).status, 2, 'invalid canonical package cannot fall back to a valid legacy payload');
    await rm(canonical, { recursive: true });
  }
  assert.equal(run(['--managed-node', runtime, '--version']).status, 0);
  assert.equal(run(['--managed-node', process.execPath, '--version']).status, 2);
  for (const changed of [{ ...marker, node: process.execPath }, { ...marker, version: '999.0.0' }, { ...marker, schema: 'foreign/1' }, { ...marker, sha256: 'invalid' }]) { await save(changed); assert.equal(run(['--version']).status, 2); }
  await save(marker); await chmod(runtime, 0o722); assert.equal(run(['--version']).status, 2); await chmod(runtime, 0o700);
  await unlink(markerPath); const other = join(fixture, 'marker.json'); await writeFile(other, JSON.stringify(marker), { mode: 0o600 }); await symlink(other, markerPath); assert.equal(run(['--version']).status, 2);
});
