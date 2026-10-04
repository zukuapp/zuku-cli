import { access, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { AgentError } from './errors.mjs';
import { LIMITS } from './limits.mjs';
import { frameDifference, imageStats } from './png.mjs';
import { serveSnapshot } from './server.mjs';

/*
 * Real browser playtest. A pinned playwright-core drives a sandboxed Chromium
 * (chromiumSandbox: true — Playwright's own default is false) against the loopback snapshot
 * server. All non-loopback requests and every WebSocket are aborted, service workers are
 * blocked, and the browser gets a minimal environment with a throwaway HOME. There is no
 * fallback: if a sandboxed Chromium cannot run, the playtest fails closed.
 *
 * The runner only collects observations (states read after real keyboard input, DOM checks,
 * errors, request failures and real PNG screenshots). evaluatePlaytest() decides pass/fail.
 */
const VIEWPORT = Object.freeze({ width: 960, height: 540 });
const ENV_ALLOW = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE'];
const SECRETISH = /TOKEN|SECRET|KEY|PASS|AUTH|COOKIE|SESSION|CRED|ZUKU|CODEX|OPENAI|ANTHROPIC|AWS|GITHUB|NPM/i;
const require = createRequire(import.meta.url);

/** Allowlisted, secret-free environment for the browser child process. */
export function minimalBrowserEnv(home, env = process.env) {
  const out = {};
  for (const name of ENV_ALLOW) if (typeof env[name] === 'string' && !SECRETISH.test(name)) out[name] = env[name];
  Object.assign(out, { HOME: home, TMPDIR: home, TMP: home, TEMP: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache') });
  if (process.platform === 'win32') Object.assign(out, { USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home });
  return out;
}

const INSTALL_ALLOW = [...ENV_ALLOW, 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'PLAYWRIGHT_BROWSERS_PATH', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];

/** Installs playwright-core's pinned Chromium with its own CLI: no shell, bounded output, timeout. */
export async function installPinnedChromium({ signal, env = process.env, onEvent } = {}) {
  let cli;
  try { cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js'); } catch { throw new AgentError('AGENT_PLAYTEST_UNAVAILABLE', { reason: 'playwright_core_missing' }); }
  const childEnv = {};
  for (const name of INSTALL_ALLOW) if (typeof env[name] === 'string') childEnv[name] = env[name];
  onEvent?.({ type: 'browser', status: 'installing' });
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv, signal, timeout: LIMITS.browserInstallTimeoutMs, windowsHide: true });
    let seen = 0;
    const bound = chunk => { seen += chunk.length; if (seen > LIMITS.diagnosticBytes * 64) child.kill(); };
    child.stdout.on('data', bound); child.stderr.on('data', bound);
    child.once('error', () => resolve(-1));
    child.once('close', status => resolve(status ?? -1));
  });
  if (signal?.aborted) throw new AgentError('COMMAND_CANCELLED');
  if (code !== 0) throw new AgentError('AGENT_PLAYTEST_UNAVAILABLE', { reason: 'browser_install_failed', exit_code: code });
  onEvent?.({ type: 'browser', status: 'installed' });
}

async function executable(path) {
  try {
    const real = await realpath(path);
    const stat = await lstat(real);
    if (!stat.isFile()) return undefined;
    await access(real, constants.X_OK);
    return real;
  } catch { return undefined; }
}

const sanitizeState = value => {
  if (!value || typeof value !== 'object') return null;
  return {
    status: ['menu', 'running', 'over'].includes(value.status) ? value.status : 'invalid',
    score: Number.isFinite(value.score) ? value.score : null,
    tick: Number.isSafeInteger(value.tick) ? value.tick : null,
    last_action: typeof value.last_action === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(value.last_action) ? value.last_action : null,
  };
};

/**
 * @param {{ browserPath?: string, loadPlaywright?: Function, install?: Function, uid?: number, onEvent?: Function }} options
 */
export function createBrowserPlaytest({ browserPath, validateBrowser, loadPlaywright = () => import('playwright-core'), install = installPinnedChromium, uid = process.getuid?.(), onEvent } = {}) {
  let prepared;
  /** Resolves (and if needed installs) a sandbox-capable browser once; safe to call before model work. */
  async function prepare({ signal } = {}) {
    await validateBrowser?.();
    if (prepared) return prepared;
    // Chromium refuses its sandbox as root; we never fall back to --no-sandbox.
    if (uid === 0) throw new AgentError('AGENT_PLAYTEST_SANDBOX');
    let playwright;
    try { playwright = await loadPlaywright(); } catch { throw new AgentError('AGENT_PLAYTEST_UNAVAILABLE', { reason: 'playwright_core_missing' }); }
    const chromium = playwright?.chromium ?? playwright?.default?.chromium;
    if (!chromium?.launch) throw new AgentError('AGENT_PLAYTEST_UNAVAILABLE', { reason: 'playwright_core_missing' });
    let executablePath;
    if (browserPath) {
      if (!isAbsolute(browserPath) || !(executablePath = await executable(browserPath))) throw new AgentError('AGENT_PLAYTEST_UNAVAILABLE', { reason: 'browser_path_invalid' });
    } else {
      let pinned;
      try { pinned = chromium.executablePath(); } catch { /* not installed */ }
      executablePath = pinned && await executable(pinned);
      if (!executablePath) {
        await install({ signal, onEvent });
        try { executablePath = await executable(chromium.executablePath()); } catch { /* still missing */ }
        if (!executablePath) throw new AgentError('AGENT_PLAYTEST_UNAVAILABLE', { reason: 'browser_missing' });
      }
    }
    prepared = { chromium, executablePath };
    return prepared;
  }
  return Object.freeze({
    kind: 'browser',
    prepare,
    async run({ snapshot, plan, script, signal }) {
      const { chromium, executablePath } = await prepare({ signal });
      if (signal?.aborted) throw new AgentError('COMMAND_CANCELLED');
      const home = await mkdtemp(join(tmpdir(), 'zukujs-browser-'));
      const server = await serveSnapshot(snapshot.files, snapshot.entry);
      let browser;
      const stop = () => { browser?.close().catch(() => {}); };
      signal?.addEventListener('abort', stop, { once: true });
      try {
        if (signal?.aborted) throw new AgentError('COMMAND_CANCELLED');
        await validateBrowser?.();
        try {
          browser = await chromium.launch({
            executablePath, headless: true, chromiumSandbox: true, env: minimalBrowserEnv(home),
            handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, timeout: LIMITS.browserLaunchTimeoutMs,
            args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--metrics-recording-only', '--deny-permission-prompts'],
          });
        } catch (error) {
          if (signal?.aborted) throw new AgentError('COMMAND_CANCELLED');
          // Only the classification is used; the browser's own text is never surfaced.
          throw new AgentError(/sandbox|namespace|setuid/i.test(String(error?.message)) ? 'AGENT_PLAYTEST_SANDBOX' : 'AGENT_PLAYTEST_UNAVAILABLE', { reason: 'browser_launch_failed' });
        }
        if (signal?.aborted) throw new AgentError('COMMAND_CANCELLED');
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new AgentError('AGENT_PLAYTEST_FAILED', { codes: ['PT_TIMEOUT'] })), LIMITS.playtestTimeoutMs); });
        try {
          const work = observe({ browser, origin: server.origin, snapshot, plan, script, signal, version: browser.version() });
          work.catch(() => {});
          return await Promise.race([work, timeout]);
        } finally { clearTimeout(timer); }
      } finally {
        signal?.removeEventListener('abort', stop);
        await browser?.close().catch(() => {});
        await server.close();
        await rm(home, { recursive: true, force: true }).catch(() => {});
      }
    },
  });
}

async function observe({ browser, origin, snapshot, plan, script, signal, version }) {
  const obs = {
    kind: 'browser', browser: { name: 'chromium', version: String(version).slice(0, 40), sandbox: true },
    entry_loaded: false, page_errors: 0, console_errors: 0, failed_requests: 0, blocked_requests: 0, canvas_count: 0,
    hook_present: false, states: {}, running_ticks: [], dom: {}, frames: [], thumbnail: null, error_samples: [],
  };
  const sample = text => { if (obs.error_samples.length < 5) obs.error_samples.push(String(text).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200)); };
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: VIEWPORT, acceptDownloads: false, permissions: [], bypassCSP: false, javaScriptEnabled: true });
  await context.route('**/*', route => {
    let allowed = false;
    try { allowed = new URL(route.request().url()).origin === origin; } catch { /* malformed */ }
    if (allowed) return route.continue();
    obs.blocked_requests++;
    return route.abort('blockedbyclient');
  });
  if (typeof context.routeWebSocket === 'function') await context.routeWebSocket(/.*/, ws => { obs.blocked_requests++; ws.close(); });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => { obs.page_errors++; sample(error?.message); });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    // CSP refusals happen before routing; they are external-load attempts, not ordinary errors.
    if (/Content Security Policy/i.test(message.text())) obs.blocked_requests++;
    else { obs.console_errors++; sample(message.text()); }
  });
  page.on('response', response => { if (response.status() >= 400 && response.url().startsWith(origin)) obs.failed_requests++; });
  page.on('requestfailed', request => { if (request.url().startsWith(origin)) obs.failed_requests++; });
  page.on('websocket', () => { obs.blocked_requests++; });
  const cancelled = () => { if (signal?.aborted) throw new AgentError('COMMAND_CANCELLED'); };
  const wait = ms => page.waitForTimeout(ms);
  if (!plan || !script) {
    const response = await page.goto(`${origin}/${snapshot.entry}`, { waitUntil: 'load' });
    obs.entry_loaded = response?.status() === 200;
    await wait(700); cancelled();
    obs.canvas_count = await page.locator('canvas:visible').count();
    await page.keyboard.press('Enter'); await wait(450); cancelled();
    obs.frames.push(await page.screenshot({ type: 'png' }));
    await page.keyboard.down('ArrowRight'); await wait(150); await page.keyboard.up('ArrowRight');
    await wait(350); cancelled();
    obs.frames.push(await page.screenshot({ type: 'png' }));
    obs.thumbnail = obs.frames[1];
    await context.close(); return obs;
  }
  const key = action => plan.input_actions.find(item => item.id === action)?.keys[0];
  const state = async () => sanitizeState(await page.evaluate(() => {
    const game = window.__zukuGame;
    if (!game || typeof game.getState !== 'function') return null;
    try { return JSON.parse(JSON.stringify(game.getState())); } catch { return null; }
  }));
  const ids = [...plan.hud.map(item => item.id), ...plan.menus.map(item => item.id)];
  const dom = () => page.evaluate(list => Object.fromEntries(list.map(id => {
    const element = document.getElementById(id);
    if (!element) return [id, { present: false, visible: false, text: '' }];
    const visible = typeof element.checkVisibility === 'function' ? element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : element.getClientRects().length > 0;
    return [id, { present: true, visible, text: (element.textContent ?? '').trim().slice(0, 80) }];
  })), ids);

  const response = await page.goto(`${origin}/${snapshot.entry}`, { waitUntil: 'load' });
  obs.entry_loaded = response?.status() === 200;
  await wait(700);
  cancelled();
  obs.canvas_count = await page.evaluate(() => document.querySelectorAll('canvas').length);
  obs.hook_present = await page.evaluate(() => typeof window.__zukuGame?.getState === 'function' && typeof window.__zukuGame?.forceLoss === 'function' && window.__zukuGame?.contract === 'zuku-hooks/1');
  obs.states.initial = await state();
  obs.dom.initial = await dom();
  if (!obs.hook_present) return obs;

  await page.keyboard.press(key(script.start_action));
  await wait(450);
  cancelled();
  obs.states.after_start = await state();
  obs.dom.after_start = await dom();
  obs.frames.push(await page.screenshot({ type: 'png' }));
  for (const step of script.smoke) {
    const code = key(step.action);
    await page.keyboard.down(code);
    await wait(step.hold_ms);
    await page.keyboard.up(code);
    if (step.wait_ms) await wait(step.wait_ms);
    cancelled();
    const current = await state();
    if (current?.status === 'running' && current.tick !== null) obs.running_ticks.push(current.tick);
  }
  await wait(200);
  obs.states.after_smoke = await state();
  obs.dom.after_smoke = await dom();
  if (obs.states.after_smoke?.status === 'running' && obs.states.after_smoke.tick !== null) obs.running_ticks.push(obs.states.after_smoke.tick);
  obs.frames.push(await page.screenshot({ type: 'png' }));
  obs.thumbnail = obs.states.after_smoke?.status === 'running' ? obs.frames[1] : obs.frames[0];

  if (obs.states.after_smoke?.status === 'running') await page.evaluate(() => { window.__zukuGame.forceLoss(); });
  await wait(450);
  cancelled();
  obs.states.after_loss = await state();
  obs.dom.after_loss = await dom();
  await page.keyboard.press(key(plan.loss_or_reset.reset_action));
  await wait(500);
  obs.states.after_reset = await state();
  obs.dom.after_reset = await dom();
  await context.close();
  return obs;
}

/** Judges observations (from the real runner or an injected one) using only observed values. */
export function evaluatePlaytest(obs, plan, script) {
  const failures = [];
  const fail = code => { if (!failures.includes(code)) failures.push(code); };
  if (!obs || obs.kind !== 'browser' || obs.browser?.sandbox !== true) return { passed: false, failures: ['PT_NOT_BROWSER'], metrics: {} };
  if (!obs.entry_loaded) fail('PT_ENTRY_NOT_LOADED');
  if (obs.page_errors) fail('PT_PAGE_ERROR');
  if (obs.console_errors) fail('PT_CONSOLE_ERROR');
  if (obs.failed_requests) fail('PT_ASSET_FAILED');
  if (obs.blocked_requests) fail('PT_EXTERNAL_REQUEST');
  if (!obs.canvas_count) fail('PT_CANVAS_MISSING');
  if (!obs.hook_present) { fail('PT_HOOK_MISSING'); return { passed: false, failures, metrics: {} }; }
  const { initial, after_start: started, after_smoke: smoked, after_loss: lost, after_reset: reset } = obs.states ?? {};
  for (const item of plan.hud) {
    const seen = obs.dom?.after_start?.[item.id];
    if (!seen?.present || !seen.visible) fail('PT_HUD_MISSING');
  }
  for (const item of plan.menus) if (!obs.dom?.initial?.[item.id]?.present) fail('PT_MENU_MISSING');
  if (initial?.status !== 'menu') fail('PT_INITIAL_NOT_MENU');
  if (started?.status !== 'running') fail('PT_START_INPUT_NO_EFFECT');
  const ticks = (obs.running_ticks ?? []).filter(Number.isSafeInteger);
  if (!Number.isSafeInteger(started?.tick) || !ticks.length || Math.max(...ticks) <= started.tick) fail('PT_SIMULATION_STALLED');
  for (const id of script.observe_hud_ids) {
    const before = obs.dom?.after_start?.[id]?.text, after = obs.dom?.after_smoke?.[id]?.text;
    if (before === undefined || after === undefined || before === after) fail('PT_HUD_NOT_UPDATED');
  }
  const metrics = {};
  try {
    metrics.frame_change = frameDifference(obs.frames[0], obs.frames[1]);
    if (!(metrics.frame_change > 0.001)) fail('PT_RENDER_STATIC');
  } catch { fail('PT_SCREENSHOT_INVALID'); }
  try {
    const stats = imageStats(obs.thumbnail);
    Object.assign(metrics, { thumbnail_width: stats.width, thumbnail_height: stats.height, distinct_colors: stats.distinct_colors });
    if (stats.distinct_colors < 4 || stats.luminance_stddev < 2) fail('PT_THUMBNAIL_BLANK');
  } catch { fail('PT_SCREENSHOT_INVALID'); }
  if (lost?.status !== 'over') fail('PT_LOSS_NOT_REACHED');
  const overMenus = plan.menus.filter(menu => menu.kind === 'game_over').map(menu => menu.id);
  if (!overMenus.some(id => obs.dom?.after_loss?.[id]?.visible)) fail('PT_GAME_OVER_MENU_HIDDEN');
  if (overMenus.some(id => obs.dom?.after_start?.[id]?.visible)) fail('PT_GAME_OVER_MENU_EARLY');
  if (reset?.status !== 'running') fail('PT_RESET_INPUT_NO_EFFECT');
  if (!Number.isSafeInteger(reset?.tick) || !Number.isSafeInteger(lost?.tick) || reset.tick >= lost.tick) fail('PT_RESET_NOT_FRESH');
  return { passed: failures.length === 0, failures, metrics };
}

/** Existing-game smoke reports observed loading/rendering/input only, never a full game-plan verdict. */
export function evaluateBrowserSmoke(obs) {
  const failures = [], metrics = {};
  if (obs?.kind !== 'browser' || obs.browser?.sandbox !== true) return { passed: false, failures: ['PT_NOT_BROWSER'], metrics };
  for (const [bad, code] of [[!obs.entry_loaded, 'PT_ENTRY_NOT_LOADED'], [obs.page_errors, 'PT_PAGE_ERROR'], [obs.console_errors, 'PT_CONSOLE_ERROR'], [obs.failed_requests, 'PT_ASSET_FAILED'], [obs.blocked_requests, 'PT_EXTERNAL_REQUEST'], [!obs.canvas_count, 'PT_CANVAS_MISSING']]) if (bad) failures.push(code);
  try { metrics.frame_change = frameDifference(obs.frames[0], obs.frames[1]); if (!(metrics.frame_change > 0.001)) failures.push('PT_RENDER_STATIC'); } catch { failures.push('PT_SCREENSHOT_INVALID'); }
  try { const stats = imageStats(obs.thumbnail); Object.assign(metrics, { thumbnail_width: stats.width, thumbnail_height: stats.height, distinct_colors: stats.distinct_colors }); if (stats.distinct_colors < 4 || stats.luminance_stddev < 2) failures.push('PT_THUMBNAIL_BLANK'); } catch { if (!failures.includes('PT_SCREENSHOT_INVALID')) failures.push('PT_SCREENSHOT_INVALID'); }
  return { passed: failures.length === 0, failures, metrics };
}
