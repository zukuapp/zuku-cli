// Shared fixtures for agent tests: a real, small Canvas game authored as "model output", a
// scripted provider, a mocked (clearly labelled) playtest runner, PNG helpers and a fake deploy.
// The mocked runner exists only for orchestration tests; real browser QA is agent-browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillPack, skillReceipt } from '../lib/agent/skills.mjs';
import { gateArchitecture, gateImplementation, gatePlan, gatePlaytestScript, gatePublish, scanArtifacts } from '../lib/agent/gates.mjs';
import { validateSchema } from '../lib/agent/schema.mjs';
import { STAGES } from '../lib/agent/stages.mjs';

export const SKILLS = await loadSkillPack();
const receipt = name => skillReceipt(SKILLS.get(name));

export async function tmp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zukujs-agent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export const PLAN = Object.freeze({
  title: 'Lane Dodger',
  summary: 'Slide between three lanes to dodge falling blocks for as long as you can.',
  genre: 'arcade',
  player_verbs: ['start', 'move left', 'move right', 'restart'],
  core_loop: ['blocks fall in lanes', 'player reads the lanes', 'player switches lane', 'score rises while alive'],
  loss_or_reset: { loss_condition: 'A falling block reaches the player lane at the bottom.', reset: 'Fresh simulation state with best score kept.', reset_action: 'reset' },
  input_actions: [
    { id: 'start', keys: ['Enter', 'Space'], pointer: false, purpose: 'Start from the menu' },
    { id: 'left', keys: ['ArrowLeft', 'KeyA'], pointer: false, purpose: 'Move one lane left' },
    { id: 'right', keys: ['ArrowRight', 'KeyD'], pointer: false, purpose: 'Move one lane right' },
    { id: 'reset', keys: ['KeyR'], pointer: false, purpose: 'Restart after game over' },
  ],
  hud: [{ id: 'hud-score', purpose: 'Current score' }, { id: 'hud-best', purpose: 'Best score this session' }],
  menus: [{ id: 'menu-start', kind: 'start', purpose: 'Title and controls' }, { id: 'menu-over', kind: 'game_over', purpose: 'Game over and restart hint' }],
  asset_manifest: [{ id: 'player_badge', kind: 'image', source: 'file', path: 'assets/player.svg', license: 'original', description: 'Original player badge' }],
  engine_preference: { engine: 'canvas', reason: 'A three-lane single-screen game is clearer as a plain Canvas loop than a Phaser scene.' },
  simulation_render_boundary: 'Lanes, blocks, timers, score and status live in simulation.js; render.js only draws them.',
  save_debug_perf: { save: 'none', debug: 'No debug overlay in this version.', perf_budget: { target_fps: 60, max_entities: 64 } },
  skill_receipt: receipt('game-design'),
});

export const ARCHITECTURE = Object.freeze({
  engine: { name: 'canvas', reason: 'Plain Canvas 2D is sufficient for three lanes of rectangles.', uses_create_scaffold: true },
  modules: [
    { path: 'src/simulation.js', role: 'simulation', responsibility: 'Pure fixed-step rules' },
    { path: 'src/render.js', role: 'render', responsibility: 'Canvas drawing of state' },
    { path: 'src/input.js', role: 'input', responsibility: 'KeyboardEvent.code to action mapping' },
    { path: 'src/main.js', role: 'boot', responsibility: 'Loop, DOM HUD/menus, hooks' },
  ],
  boundary: { simulation_modules: ['src/simulation.js'], render_modules: ['src/render.js'], rule: 'Simulation never touches DOM or canvas.' },
  state_shape: [
    { key: 'status', type: 'string', purpose: 'menu, running or over' },
    { key: 'score', type: 'number', purpose: 'Score' },
    { key: 'tick', type: 'number', purpose: 'Fixed steps since start' },
    { key: 'lane', type: 'number', purpose: 'Player lane' },
    { key: 'blocks', type: 'array', purpose: 'Falling blocks' },
  ],
  input_mapping: PLAN.input_actions.map(action => ({ action: action.id, keys: action.keys })),
  test_hook_contract: 'zuku-hooks/1',
  skill_receipt: receipt('game-architecture'),
});

const FILES = {
  'src/index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lane Dodger</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="frame">
    <canvas id="stage" width="640" height="360" aria-label="Lane Dodger"></canvas>
    <div class="hud"><span id="hud-score">Score 0</span><span id="hud-best">Best 0</span><img src="assets/player.svg" alt="" width="24" height="24"></div>
    <section id="menu-start" class="menu"><h1>Lane Dodger</h1><p>Enter or Space to start. Arrow keys or A/D to switch lanes.</p></section>
    <section id="menu-over" class="menu" hidden><h2>Game over</h2><p>Press R to restart.</p></section>
  </main>
  <script type="module" src="main.js"></script>
</body>
</html>
`,
  'src/style.css': `html, body { margin: 0; height: 100%; background: #0f1320; color: #f3f5fb; font-family: system-ui, sans-serif; }
.frame { position: relative; width: min(100vw, 177.78vh); margin: 0 auto; }
canvas { display: block; width: 100%; height: auto; background: #182038; }
.hud { position: absolute; top: 8px; left: 12px; right: 12px; display: flex; gap: 16px; font-size: 18px; align-items: center; }
.menu { position: absolute; inset: 25% 20%; background: rgba(10, 14, 28, 0.85); border-radius: 12px; padding: 16px; text-align: center; }
.menu[hidden] { display: none; }
`,
  'src/simulation.js': `// Pure Lane Dodger rules: no DOM, canvas, timers or storage.
export const TICK = 1 / 60;
export const LANES = 3;

export function createState(seed = 7, status = 'menu', best = 0) {
  return { status, score: 0, tick: 0, lane: 1, blocks: [], spawnIn: 0.6, speed: 160, seed, best, last_action: null };
}

function random(state) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 4294967296;
}

export function lose(state) {
  state.status = 'over';
  state.best = Math.max(state.best, state.score);
  return state;
}

export function applyAction(state, action) {
  if (state.status === 'over' && action === 'reset') {
    const next = createState(state.seed, 'running', state.best);
    next.last_action = action;
    return next;
  }
  state.last_action = action;
  if (state.status === 'menu' && action === 'start') state.status = 'running';
  else if (state.status === 'running' && action === 'left') state.lane = Math.max(0, state.lane - 1);
  else if (state.status === 'running' && action === 'right') state.lane = Math.min(LANES - 1, state.lane + 1);
  return state;
}

export function step(state) {
  if (state.status !== 'running') return state;
  state.tick += 1;
  state.score = Math.floor(state.tick / 6);
  state.spawnIn -= TICK;
  if (state.spawnIn <= 0) {
    state.blocks.push({ lane: Math.floor(random(state) * LANES), y: -30 });
    state.spawnIn = 0.9 + random(state) * 0.6;
  }
  for (const block of state.blocks) block.y += state.speed * TICK;
  state.blocks = state.blocks.filter(block => block.y < 400);
  state.speed += 2 * TICK;
  if (state.blocks.some(block => block.lane === state.lane && block.y > 290 && block.y < 330)) lose(state);
  return state;
}
`,
  'src/render.js': `// Canvas rendering only: reads simulation state, never changes rules.
const LANE_WIDTH = 640 / 3;

export function draw(ctx, state) {
  ctx.fillStyle = '#182038';
  ctx.fillRect(0, 0, 640, 360);
  for (let lane = 0; lane < 3; lane++) {
    ctx.fillStyle = lane % 2 ? '#1f2a48' : '#22305a';
    ctx.fillRect(lane * LANE_WIDTH, 0, LANE_WIDTH, 360);
  }
  ctx.fillStyle = '#3b4a7a';
  for (let y = (state.tick * 4) % 40; y < 360; y += 40) ctx.fillRect(LANE_WIDTH - 2, y, 4, 20), ctx.fillRect(2 * LANE_WIDTH - 2, y, 4, 20);
  ctx.fillStyle = '#ff6b6b';
  for (const block of state.blocks) ctx.fillRect(block.lane * LANE_WIDTH + 40, block.y, LANE_WIDTH - 80, 30);
  ctx.fillStyle = state.status === 'over' ? '#9aa3b5' : '#ffd166';
  ctx.beginPath();
  ctx.arc(state.lane * LANE_WIDTH + LANE_WIDTH / 2, 315, 18, 0, Math.PI * 2);
  ctx.fill();
}
`,
  'src/input.js': `// Explicit KeyboardEvent.code -> action mapping.
export const INPUT_MAP = Object.freeze({
  start: ['Enter', 'Space'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  reset: ['KeyR'],
});
const BY_CODE = new Map(Object.entries(INPUT_MAP).flatMap(([action, codes]) => codes.map(code => [code, action])));

export function bindInput(target, onAction) {
  target.addEventListener('keydown', event => {
    const action = BY_CODE.get(event.code);
    if (!action) return;
    event.preventDefault();
    if (!event.repeat) onAction(action);
  });
}
`,
  'src/main.js': `import { createState, applyAction, step, lose, TICK } from './simulation.js';
import { draw } from './render.js';
import { bindInput } from './input.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const hudScore = document.getElementById('hud-score');
const hudBest = document.getElementById('hud-best');
const menuStart = document.getElementById('menu-start');
const menuOver = document.getElementById('menu-over');
let state = createState(7);
let accumulator = 0;
let last = performance.now();

bindInput(window, action => { state = applyAction(state, action); });

function syncDom() {
  hudScore.textContent = 'Score ' + state.score;
  hudBest.textContent = 'Best ' + state.best;
  menuStart.hidden = state.status !== 'menu';
  menuOver.hidden = state.status !== 'over';
}

function frame(now) {
  accumulator += Math.min((now - last) / 1000, 0.25);
  last = now;
  while (accumulator >= TICK) { step(state); accumulator -= TICK; }
  draw(ctx, state);
  syncDom();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__zukuGame = Object.freeze({
  contract: 'zuku-hooks/1',
  getState: () => ({ status: state.status, score: state.score, tick: state.tick, last_action: state.last_action }),
  forceLoss: () => { if (state.status === 'running') lose(state); },
});
`,
  'src/assets/player.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#ffd166"/></svg>
`,
};

export const implementation = (files = FILES) => ({ files: Object.entries(files).map(([path, content]) => ({ path, content })), notes: 'Canvas lane game.', skill_receipt: receipt('game-implementation') });
export const GAME_FILES = Object.freeze({ ...FILES });

export const SCRIPT = Object.freeze({
  start_action: 'start',
  smoke: [{ action: 'left', hold_ms: 80, wait_ms: 500 }, { action: 'right', hold_ms: 80, wait_ms: 500 }, { action: 'right', hold_ms: 80, wait_ms: 500 }, { action: 'left', hold_ms: 80, wait_ms: 300 }],
  observe_hud_ids: ['hud-score'],
  skill_receipt: receipt('game-playtest'),
});

export const META = Object.freeze({
  title: 'Lane Dodger', description: 'Switch between three lanes with the arrow keys or A/D and dodge falling blocks. Press R to restart.',
  tags: ['arcade', 'dodge'], genre: 'arcade', age_rating: 'all', platform: { pc: true, mobile: false, tablet: false },
  release_notes: 'First playable version.', skill_receipt: receipt('game-publish'),
});

export const defaultOutputs = () => ({ design: PLAN, architecture: ARCHITECTURE, implementation: implementation(), playtest: SCRIPT, publish: META });

/** Scripted provider: per-stage output queues (or functions); records every call. */
export function scriptedProvider(overrides = {}) {
  const outputs = { ...defaultOutputs(), ...overrides };
  const calls = [];
  return {
    calls,
    async runStage(request) {
      calls.push(request);
      if (request.signal?.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
      let output = outputs[request.stage];
      if (Array.isArray(output)) output = output.length > 1 ? output.shift() : output[0];
      if (typeof output === 'function') output = await output(request);
      return { stage: request.stage, output: structuredClone(output), usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }, provider: 'codex-test', experimental: true, unofficial: true };
    },
  };
}

// --- PNG helpers -------------------------------------------------------------------------
const chunk = (type, data) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
};
export function makePng(width, height, paint) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = paint(x, y);
    const i = y * (width * 3 + 1) + 1 + x * 3;
    raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export const sceneA = makePng(96, 54, (x, y) => [(x * 3) & 255, (y * 5) & 255, 120]);
export const sceneB = makePng(96, 54, (x, y) => [(x * 3 + 90) & 255, (y * 5 + 40) & 255, 60]);
export const blank = makePng(96, 54, () => [20, 20, 20]);

/** Observations of a good run, as the real runner would report them. Overrides simulate failures. */
export function goodObservations(overrides = {}) {
  const dom = (startVisible, overVisible, score) => ({
    'hud-score': { present: true, visible: true, text: `Score ${score}` }, 'hud-best': { present: true, visible: true, text: 'Best 0' },
    'menu-start': { present: true, visible: startVisible, text: 'Lane Dodger' }, 'menu-over': { present: true, visible: overVisible, text: 'Game over' },
  });
  return {
    kind: 'browser', browser: { name: 'chromium', version: 'mock', sandbox: true },
    entry_loaded: true, page_errors: 0, console_errors: 0, failed_requests: 0, blocked_requests: 0, canvas_count: 1, hook_present: true,
    states: {
      initial: { status: 'menu', score: 0, tick: 0, last_action: null }, after_start: { status: 'running', score: 4, tick: 27, last_action: 'start' },
      after_smoke: { status: 'running', score: 30, tick: 180, last_action: 'left' }, after_loss: { status: 'over', score: 31, tick: 186, last_action: 'left' },
      after_reset: { status: 'running', score: 5, tick: 30, last_action: 'reset' },
    },
    running_ticks: [60, 100, 140, 180],
    dom: { initial: dom(true, false, 0), after_start: dom(false, false, 4), after_smoke: dom(false, false, 30), after_loss: dom(false, true, 31), after_reset: dom(false, false, 5) },
    frames: [sceneA, sceneB], thumbnail: sceneB, error_samples: [],
    ...overrides,
  };
}

/** MOCKED playtest runner (not a browser). kind !== 'browser' so receipts say "injected". */
export function mockRunner(observations = () => goodObservations()) {
  const calls = [];
  return { kind: 'mock', calls, async run(input) { calls.push(input); return typeof observations === 'function' ? observations(input, calls.length) : observations; } };
}

export function fakeDeploy({ quota = { limit: 3, window_seconds: 21600, used: 0, pending: 0, remaining: 3, reset_at: null, retry_after: null }, run, recover } = {}) {
  const calls = { preflight: 0, run: [], recover: 0 };
  return {
    calls,
    async preflight() { calls.preflight++; if (quota instanceof Error) throw quota; return { quota }; },
    async run(path, options) { calls.run.push({ path, options }); return run ? run(path, options) : { status: 'published', content_id: 'cnt_test123', url: 'https://zuku.app/jump/cnt_test123', idempotent: false }; },
    ...(recover ? { async recover(input) { calls.recover++; return recover(input); } } : {}),
  };
}

test('fixture game satisfies every stage schema and gate', () => {
  const outputs = defaultOutputs();
  for (const [stage, output] of Object.entries(outputs)) assert.deepEqual(validateSchema(STAGES[stage].schema, output), [], stage);
  assert.deepEqual(gatePlan(PLAN), []);
  assert.deepEqual(gateArchitecture(ARCHITECTURE, PLAN, { engines: ['canvas'] }), []);
  assert.deepEqual(scanArtifacts(outputs.implementation.files), []);
  assert.deepEqual(gateImplementation(outputs.implementation.files, PLAN, ARCHITECTURE), []);
  assert.deepEqual(gatePlaytestScript(SCRIPT, PLAN), []);
  assert.deepEqual(gatePublish(META, PLAN), []);
});
