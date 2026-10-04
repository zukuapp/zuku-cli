// Real-DOM renderer QA in sandboxed Chrome. The bridge below is a test fixture for
// window.zukuStudio (the preload boundary); it does not claim Electron/Core integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const CHROME = process.env.ZUKU_STUDIO_CHROME || '/opt/zuku-thumbnail-browser/chrome-linux64/chrome';
const skip = process.getuid?.() === 0 ? 'Chrome sandbox needs an ordinary UID; --no-sandbox is deliberately not used'
  : !existsSync(CHROME) ? `Chrome not found at ${CHROME} (set ZUKU_STUDIO_CHROME)` : false;
const SHA = 'a'.repeat(64);
const ROOT = new URL('../', import.meta.url);
const TYPES = { mjs: 'text/javascript', html: 'text/html; charset=utf-8', css: 'text/css' };

async function serve(t) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (!/^\/studio\/renderer\/[a-z-]+\.(?:mjs|html|css)$/.test(path) && path !== '/lib/agent-protocol/schema.mjs') { res.writeHead(404).end(); return; }
    try { const body = await readFile(new URL(`.${path}`, ROOT)); res.writeHead(200, { 'content-type': TYPES[path.split('.').pop()], 'cache-control': 'no-store' }).end(body); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function fixture(mode) {
  if (mode === 'none') return;
  const state = { calls: [], subs: [], previews: [], files: { 'src/player.mjs': 'export const speed = 4;\nexport function move() {}\n' } };
  window.__zk = state;
  const zuku = { id: 'zuku-account', name: 'ZUKU 계정', official: true, experimental: false };
  const codex = { id: 'codex-oauth', name: 'Codex OAuth', official: false, experimental: true };
  window.zukuStudio = {
    async call(method, params) {
      state.calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
      if (mode === 'offline') throw Object.assign(new Error('connect ECONNREFUSED /root/.zuku/core.sock'), { code: 'CORE_NOT_RUNNING' });
      switch (method) {
        case 'hello': return { protocolVersion: 1, product: 'zuku-agent-core' };
        case 'project.list': return { projects: [{ projectHandle: 'prj_demo', name: 'MyGame' }] };
        case 'session.list': return { sessions: [{ sessionId: 'ses_demo0001', projectHandle: 'prj_demo', state: 'idle' }] };
        case 'session.get': return { sessionId: params.sessionId, state: 'idle' };
        case 'session.input': return { accepted: true, requestId: params.requestId };
        case 'session.cancel': return { cancelled: true };
        case 'provider.list': return { providers: [
          { id: 'zuku', name: 'ZUKU AI', active: true, enabled: true, auth: { method: zuku, status: 'authenticated' }, authMethods: [zuku] },
          { id: 'codex', name: 'Codex', active: false, enabled: true, auth: { method: codex, status: 'missing' }, authMethods: [codex] }] };
        case 'model.list': return { models: [{ address: 'zuku/auto', name: 'Auto', source: 'builtin' }, { address: 'openrouter/anthropic/claude-x', name: 'Claude X', source: 'catalog', contextWindow: 200000 }], activeModel: 'zuku/auto' };
        case 'auth.list': return [];
        case 'project.read': if (!(params.path in state.files)) throw { code: 'PROJECT_NOT_FOUND' }; return { path: params.path, content: state.files[params.path], sha256: 'a'.repeat(64) };
        case 'project.patch': return { sha256: 'b'.repeat(64) };
        case 'game.preview': return { previewHandle: 'pvw_demo1' };
        default: return {};
      }
    },
    subscribe(params, onMessage) { const sub = { params, onMessage, detached: false }; state.subs.push(sub); return () => { sub.detached = true; }; },
    async pickProject() { return { projectHandle: 'prj_second', name: 'Second Game' }; },
    async showPreview(value) { state.previews.push({ show: value }); },
    async hidePreview() { state.previews.push({ hide: true }); },
  };
  window.__emit = (sequence, type, data) => {
    const sub = state.subs.filter(entry => !entry.detached).at(-1);
    sub.onMessage({ protocolVersion: 1, sessionId: sub.params.sessionId, sequence, eventId: `evt_${sequence}`, time: new Date().toISOString(), type, data });
  };
}

test('Studio renderer in real sandboxed Chrome', { skip, timeout: 120000 }, async t => {
  const { chromium } = await import('playwright-core');
  const origin = await serve(t);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());
  async function open(mode, viewport = { width: 1280, height: 860 }) {
    const page = await (await browser.newContext({ viewport })).newPage();
    const problems = [];
    page.on('request', request => { if (!request.url().startsWith(origin)) problems.push(`external ${request.url()}`); });
    page.on('pageerror', error => problems.push(`pageerror ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') problems.push(`console ${message.text()}`); });
    await page.addInitScript(fixture, mode);
    await page.goto(`${origin}/studio/renderer/index.html`);
    return { page, problems };
  }
  const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });
  const calls = (page, method) => page.evaluate(name => window.__zk.calls.filter(call => call.method === name).map(call => call.params), method);

  await t.test('no native bridge and offline core show actionable, redacted states', async () => {
    const none = await open('none');
    await none.page.locator('.zk-chip-no-bridge').waitFor();
    assert.match(await none.page.textContent('.zk-notice-region'), /네이티브 연결이 없습니다/);
    const offline = await open('offline');
    await offline.page.locator('.zk-chip-offline').waitFor();
    const text = await offline.page.textContent('body');
    assert.match(text, /Agent Core가 실행 중이 아닙니다/);
    assert.doesNotMatch(text, /ECONNREFUSED|\/root/);
    assert.ok(await offline.page.getByRole('button', { name: '다시 연결' }).first().isVisible());
    assert.deepEqual([...none.problems, ...offline.problems], []);
  });

  const { page, problems } = await open('ready');
  await page.locator('.zk-chip-ready').waitFor();

  await t.test('layout tokens, readable body size and named controls', async () => {
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '15px');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.zk-rail')).backgroundColor), 'rgb(20, 33, 61)');
    const unnamed = await page.$$eval('button', buttons => buttons.filter(b => b.getClientRects().length && !(b.textContent.trim() || b.getAttribute('aria-label'))).length);
    assert.equal(unnamed, 0);
  });

  await t.test('session selection subscribes from the cursor and streams inert, redacted text', async () => {
    await page.locator('.zk-session-row .zk-rail-item').first().click();
    await until(page, () => window.__zk.subs.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__zk.subs[0].params), { sessionId: 'ses_demo0001', afterSequence: 0 });
    await page.evaluate(() => {
      window.__emit(1, 'agent.started', { operation: 'game.maintain', requestId: 'input_fixture', modelAddress: 'codex/gpt-x', authMethod: { id: 'codex-oauth', official: false, experimental: true } });
      window.__emit(2, 'agent.reasoning_status', { phase: 'testing' });
      window.__emit(3, 'agent.delta', { text: 'Done <img src=x onerror="window.__xss=1"> all tests passed ✅ /home/alice/game/a.js', blockId: 'blk_1' });
    });
    await page.locator('.zk-msg-assistant').waitFor();
    const transcript = await page.textContent('.zk-transcript');
    assert.match(transcript, /<img src=x/); assert.match(transcript, /\[local path\]/); assert.doesNotMatch(transcript, /alice/);
    assert.equal(await page.$$eval('.zk-transcript img', nodes => nodes.length), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.match(await page.textContent('.zk-chat-head'), /게임 테스트 중/);
    assert.ok(await page.locator('.zk-chat-head .zk-exp').isVisible(), 'experimental auth from agent.started metadata is marked');
    await page.evaluate(() => window.__emit(4, 'agent.completed', { status: 'completed', verified: false }));
    await page.getByText('검증되지 않음').waitFor();
    assert.equal(await page.getByText('호스트 검증됨').count(), 0, 'model prose about passing tests never becomes a verified badge');
    await page.evaluate(() => { window.__emit(9, 'build.started', { buildId: 'bld_1', scriptId: 'build' }); window.__emit(3, 'agent.reasoning_status', { phase: 'editing' }); });
    await until(page, () => /#5–8/.test(document.querySelector('.zk-banners').textContent));
    assert.match(await page.textContent('.zk-top'), /이벤트 #9/);
  });

  await t.test('composer admits typed input with a crypto requestId and refuses secrets locally', async () => {
    await page.fill('#zk-chat-input', '플레이어 이동에 대시 기능 추가해줘');
    await page.press('#zk-chat-input', 'Control+Enter');
    await until(page, () => window.__zk.calls.some(call => call.method === 'session.input'));
    const [input] = await calls(page, 'session.input');
    assert.match(input.requestId, /^input_[A-Za-z0-9_-]{24}$/);
    assert.deepEqual({ ...input, requestId: 'x' }, { sessionId: 'ses_demo0001', operation: 'game.maintain', request: '플레이어 이동에 대시 기능 추가해줘', requestId: 'x' });
    await page.fill('#zk-chat-input', `use sk-proj-${'a'.repeat(30)}`);
    await page.press('#zk-chat-input', 'Control+Enter');
    await until(page, () => /비밀 키/.test(document.querySelector('.zk-notice-region').textContent));
    assert.equal((await calls(page, 'session.input')).length, 1);
    await page.evaluate(() => window.__emit(10, 'agent.started', { operation: 'game.build', requestId: 'input_run2' }));
    await page.getByRole('button', { name: '작업 취소' }).click();
    await until(page, () => window.__zk.calls.some(call => call.method === 'session.cancel'));
    assert.deepEqual(await calls(page, 'session.cancel'), [{ sessionId: 'ses_demo0001', requestId: 'input_run2' }]);
    await page.evaluate(() => window.__emit(11, 'agent.cancelled', { code: 'COMMAND_CANCELLED', state: 'cancelled' }));
  });

  await t.test('source editing uses project.read/patch with relative path and core digest; diff is shown', async () => {
    await page.fill('#zk-path', '../etc/passwd'); await page.getByRole('button', { name: '열기', exact: true }).click();
    await until(page, () => /상대 경로/.test(document.querySelector('.zk-notice-region').textContent));
    assert.equal((await calls(page, 'project.read')).length, 0);
    await page.fill('#zk-path', 'src/player.mjs'); await page.getByRole('button', { name: '열기', exact: true }).click();
    await until(page, () => document.querySelector('#zk-editor').value.includes('speed'));
    await page.fill('#zk-editor', 'export const speed = 4;\nexport function move() {}\nexport const dash = 2;\n');
    await page.focus('#zk-tab-source'); await page.keyboard.press('ArrowRight');
    assert.equal(await page.getAttribute('#zk-tab-diff', 'aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'zk-tab-diff');
    await page.locator('.zk-diff-add').filter({ hasText: 'dash' }).waitFor();
    await page.click('#zk-tab-source');
    await page.getByRole('button', { name: '저장' }).click();
    await until(page, () => window.__zk.calls.some(call => call.method === 'project.patch'));
    assert.deepEqual(await calls(page, 'project.patch'), [{ projectHandle: 'prj_demo', path: 'src/player.mjs', content: 'export const speed = 4;\nexport function move() {}\nexport const dash = 2;\n', expectedSha256: SHA }]);
  });

  await t.test('provider/auth/model UI reads core metadata and gates (exp!) login on consent', async () => {
    await page.click('#zk-tab-providers');
    const codex = page.locator('section[aria-label="Codex"]');
    await codex.waitFor();
    assert.equal(await codex.locator('.zk-provider-auth .zk-exp').evaluate(node => getComputedStyle(node).color), 'rgb(181, 74, 0)');
    assert.equal(await page.locator('section[aria-label="ZUKU AI"] .zk-exp:visible').count(), 0);
    assert.equal(await page.locator('.zk-top .zk-exp').count(), 0, 'active official provider has no (exp!) in the status bar');
    const login = codex.getByRole('button', { name: '로그인' });
    assert.equal(await login.isDisabled(), true);
    await codex.getByRole('checkbox').check();
    await login.click();
    await until(page, () => window.__zk.calls.some(call => call.method === 'auth.request'));
    assert.deepEqual(await calls(page, 'auth.request'), [{ providerId: 'codex', methodId: 'codex-oauth', experimental: true }]);
    assert.match(await page.locator('.zk-model-row').filter({ hasText: 'zuku/auto' }).textContent(), /컨텍스트 알 수 없음/);
    await page.fill('#zk-model-address', 'not an address'); await page.getByRole('button', { name: '이 모델 사용' }).click();
    await page.fill('#zk-model-address', 'ollama/llama3.2:latest'); await page.getByRole('button', { name: '이 모델 사용' }).click();
    await until(page, () => window.__zk.calls.some(call => call.method === 'model.use'));
    assert.deepEqual(await calls(page, 'model.use'), [{ modelAddress: 'ollama/llama3.2:latest' }]);
  });

  await t.test('native preview follows the registered slot across resize and mobile panes', async () => {
    const slotRect = () => page.$eval('.zk-slot', node => { const r = node.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.right) - Math.round(r.left), height: Math.round(r.bottom) - Math.round(r.top) }; });
    const lastShow = () => page.evaluate(() => window.__zk.previews.filter(entry => entry.show).at(-1)?.show ?? null);
    await page.getByRole('button', { name: '미리보기', exact: true }).click();
    await until(page, () => window.__zk.previews.some(entry => entry.show));
    let shown = await lastShow();
    assert.equal(shown.previewHandle, 'pvw_demo1');
    for (const value of Object.values(shown.rect)) assert.ok(Number.isInteger(value) && value >= 0);
    assert.deepEqual(shown.rect, await slotRect());
    await page.setViewportSize({ width: 1000, height: 760 });
    await until(page, previous => JSON.stringify(window.__zk.previews.filter(entry => entry.show).at(-1).show.rect) !== previous, JSON.stringify(shown.rect));
    shown = await lastShow();
    assert.deepEqual(shown.rect, await slotRect());
    assert.ok(shown.rect.x + shown.rect.width <= 1000 && shown.rect.y + shown.rect.height <= 760);
    await page.setViewportSize({ width: 420, height: 860 });
    assert.ok(await page.locator('.zk-panes').isVisible()); assert.equal(await page.locator('.zk-rail').isVisible(), false);
    await page.getByRole('button', { name: '대화', exact: true }).click();
    await until(page, () => window.__zk.previews.at(-1).hide === true);
    assert.ok(await page.locator('.zk-chat').isVisible());
  });

  await t.test('unmount detaches subscribers and preview only; it never cancels agent work', async () => {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await until(page, () => document.getElementById('zuku-studio').childElementCount === 0);
    assert.ok(await page.evaluate(() => window.__zk.subs.every(sub => sub.detached)));
    assert.equal((await calls(page, 'session.cancel')).length, 1, 'only the explicit user cancel was sent');
    assert.equal((await calls(page, 'session.close')).length, 0);
    assert.deepEqual(problems, []);
  });
});
