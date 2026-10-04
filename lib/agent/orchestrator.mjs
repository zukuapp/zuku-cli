import { createHash, randomUUID } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { CommandError } from '../errors.mjs';
import { join, resolve } from 'node:path';
import packageCmd from '../../commands/package.mjs';
import { inspectPackageFile } from '../project-package.mjs';
import { cliVersion } from '../identity.mjs';
import { NAME_PATTERN } from '../manifest-reader.mjs';
import { AgentError } from './errors.mjs';
import { LIMITS } from './limits.mjs';
import { admitRequest } from './safety.mjs';
import { loadSkillPack, receiptMatches, skillReceipt } from './skills.mjs';
import { STAGES, stageInstructions, HOOK_CONTRACT } from './stages.mjs';
import { validateSchema } from './schema.mjs';
import { gateArchitecture, gateImplementation, gatePlan, gatePlaytestScript, gatePublish, scanArtifacts } from './gates.mjs';
import { prepareState, acquireLock, newRunId, runDir, validateRunDir, saveReceipt, writeAtomic, loadReceipt, RECEIPT_SCHEMA } from './state.mjs';
import { assertAbsent, buildManifest, claimProject, deriveName, materialize, releaseClaim, rewriteManifest, snapshotProject, stageProject } from './project.mjs';
import { availableEngines } from './engine.mjs';
import { createBrowserPlaytest, evaluatePlaytest } from './playtest.mjs';
import { readInteractiveRequest } from './prompt.mjs';
import { classifyPublishFailure, normalizePublish, normalizeQuota, preflightFailure, providerFailure, quotaExceeded, resolveDeploy, resolveProvider } from './adapters.mjs';

/*
 * One orchestrated local run:
 *   request → [yolo: account+quota preflight] → design → architecture → implementation
 *   → staged project (create scaffold + files) → validate (zwf admission) → playtest script
 *   → real sandboxed browser playtest (≤1 repair) → publish metadata → materialize <cwd>/<name>
 *   → deterministic package → digest gates → [--draft upload | --yolo publish].
 * Without --yolo nothing is ever published. --yolo is the user's explicit authorization for the
 * whole flow; no further confirmation is requested. Every stage is bound to a mandatory skill.
 */
const sha256 = value => createHash('sha256').update(value).digest('hex');
const STAGE_LABELS = Object.freeze({ design: '설계', architecture: '구조', implementation: '구현', playtest: '플레이테스트 계획', publish: '게시 정보', validate: '검증', browser: '브라우저 플레이테스트', package: '패키징', upload: '초안 업로드', deploy: '게시', preflight: '계정·한도 확인' });
const STATUS_LABELS = Object.freeze({ started: '시작', done: '완료', retry: '재시도', failed: '실패', repair: '수정', installing: '설치 중', installed: '설치됨', skipped: '건너뜀' });
const PLAYTEST_FIELDS = ['input_actions', 'hud', 'menus', 'loss_or_reset'];
const PLAYTEST_CONTRACT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, required: PLAYTEST_FIELDS,
  properties: Object.fromEntries(PLAYTEST_FIELDS.map(name => [name, STAGES.design.schema.properties[name]])) });

class Budget {
  calls = 0;
  tokens = 0;
  call() { if (++this.calls > LIMITS.modelCalls) throw new AgentError('AGENT_BUDGET_EXCEEDED', { reason: 'model_calls' }); }
  usage(usage) {
    this.tokens += usage.total_tokens;
    if (this.tokens > LIMITS.totalTokens) throw new AgentError('AGENT_BUDGET_EXCEEDED', { reason: 'tokens' });
  }
}

const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
function safeUsage(usage) {
  const input = count(usage?.input_tokens ?? usage?.inputTokens), output = count(usage?.output_tokens ?? usage?.outputTokens);
  return { input_tokens: input, output_tokens: output, total_tokens: Math.max(count(usage?.total_tokens ?? usage?.totalTokens), input + output) };
}

function makeEmitter(context) {
  return event => {
    const safe = Object.fromEntries(Object.entries(event).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)));
    try { context.onEvent?.(safe); } catch { /* observers cannot break the run */ }
    if (context.stderr?.write && !context.quiet) {
      const label = STAGE_LABELS[safe.stage] ?? safe.stage ?? safe.type;
      context.stderr.write(`[zukujs agent] ${label}${safe.stage && STAGE_LABELS[safe.stage] ? `(${safe.stage})` : ''} ${STATUS_LABELS[safe.status] ?? safe.status ?? ''}${safe.attempt > 1 ? ` #${safe.attempt}` : ''}\n`);
    }
  };
}

function normalizeContext(context) {
  const cwd = resolve(context.cwd ?? process.cwd());
  const interactive = context.interactive ?? Boolean(context.stdin?.isTTY && context.stderr?.isTTY);
  return { ...context, cwd, interactive, now: context.now ?? (() => new Date()) };
}

const cancelled = signal => { if (signal?.aborted) throw new AgentError('COMMAND_CANCELLED'); };

/** Parses provider output, enforces size, schema and skill receipt; returns {output, codes}. */
function admitStageOutput(stage, result, skill) {
  const definition = STAGES[stage];
  if (!result || typeof result !== 'object' || result.stage !== stage || typeof result.experimental !== 'boolean') throw new AgentError('AGENT_STAGE_OUTPUT_INVALID', { stage });
  let output = result.output;
  if (typeof output === 'string') {
    if (Buffer.byteLength(output) > definition.maxBytes) throw new AgentError('AGENT_BUDGET_EXCEEDED', { reason: 'stage_output', stage });
    try { output = JSON.parse(output); } catch { throw new AgentError('AGENT_STAGE_OUTPUT_INVALID', { stage }); }
  }
  const serialized = JSON.stringify(output ?? null);
  if (Buffer.byteLength(serialized) > definition.maxBytes) throw new AgentError('AGENT_BUDGET_EXCEEDED', { reason: 'stage_output', stage });
  const schemaErrors = validateSchema(definition.schema, output);
  if (schemaErrors.length) return { output, codes: ['SCHEMA_INVALID'], digest: sha256(serialized) };
  if (!receiptMatches(output.skill_receipt, skill)) return { output, codes: ['SKILL_RECEIPT_MISMATCH'], digest: sha256(serialized) };
  return { output, codes: [], digest: sha256(serialized) };
}

class Run {
  constructor(options, context) {
    this.options = options;
    this.context = context;
    this.signal = context.signal;
    this.emit = makeEmitter(context);
    this.budget = new Budget();
  }

  async save(patch = {}) {
    Object.assign(this.receipt, patch);
    this.receipt.usage = { model_calls: this.budget.calls, total_tokens: this.budget.tokens };
    this.receiptPath = await saveReceipt(this.dir, this.receipt);
  }

  /** Runs one model stage with its mandatory skill; gate codes trigger at most one revision. */
  async stage(stage, input, gate) {
    const definition = STAGES[stage];
    const skill = this.skills.get(definition.skill);
    let feedback;
    for (let attempt = 1; attempt <= LIMITS.stageAttempts; attempt++) {
      cancelled(this.signal);
      this.budget.call();
      this.emit({ type: 'stage', stage, status: attempt > 1 ? 'retry' : 'started', attempt });
      const started = this.context.now().toISOString();
      const signal = AbortSignal.any([this.signal ?? new AbortController().signal, AbortSignal.timeout(LIMITS.stageTimeoutMs)]);
      const requestId = randomUUID();
      // Persist identity before inference; a lost reply is recovered by GET,
      // never by dispatching a new request under another UUID after a crash.
      await writeAtomic(this.dir, `stage-${stage}-${attempt}-request.json`, JSON.stringify({ schema: 'zuku-stage-request/1', run_id: this.runId, request_id: requestId, stage, attempt, input_sha256: sha256(JSON.stringify(feedback ? { ...input, gate_feedback: feedback } : input)) }) + '\n');
      let result;
      try {
        result = await this.provider.runStage({
          experimental: true, stage, runId: this.runId, requestId, model: this.options.model, instructions: stageInstructions(stage, skill),
          ...(typeof this.context.onProviderEvent === 'function' ? { onEvent: this.context.onProviderEvent } : {}),
          input: feedback ? { ...input, gate_feedback: feedback } : input, outputSchema: definition.schema, maxOutputBytes: definition.maxBytes, signal,
        });
      } catch (error) { throw providerFailure(error, this.signal); }
      cancelled(this.signal);
      const usage = safeUsage(result?.usage);
      this.budget.usage(usage);
      const admitted = admitStageOutput(stage, result, skill);
      let codes = admitted.codes;
      let unsafe = [];
      if (!codes.length) {
        if (stage === 'implementation') unsafe = scanArtifacts(admitted.output.files);
        if (!unsafe.length) codes = gate(admitted.output);
      }
      this.receipt.stages.push({
        stage, attempt, status: unsafe.length ? 'unsafe' : codes.length ? 'rejected' : 'accepted', source: 'model',
        provider: typeof result.provider === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(result.provider) ? result.provider : 'unknown',
        experimental: result.experimental === true, unofficial: result.unofficial === true, skill: skillReceipt(skill), usage,
        output_sha256: admitted.digest, gate_codes: [...unsafe, ...codes], started_at: started, finished_at: this.context.now().toISOString(),
      });
      await this.save();
      if (unsafe.length) { this.emit({ type: 'stage', stage, status: 'failed' }); throw new AgentError('AGENT_ARTIFACT_UNSAFE', { stage, codes: unsafe }); }
      if (!codes.length) { this.emit({ type: 'stage', stage, status: 'done' }); return admitted.output; }
      feedback = { attempt, codes };
    }
    this.emit({ type: 'stage', stage, status: 'failed' });
    throw new AgentError(feedback.codes.includes('SCHEMA_INVALID') ? 'AGENT_STAGE_OUTPUT_INVALID' : 'AGENT_GATE_FAILED', { stage, codes: feedback.codes });
  }

  gateRecord(gate, codes) {
    this.receipt.gates.push({ gate, status: codes.length ? 'failed' : 'passed', codes: codes.slice(0, 32), at: this.context.now().toISOString() });
  }

  async playtest(snapshot, plan, script) {
    this.emit({ type: 'stage', stage: 'browser', status: 'started' });
    const observations = await this.runner.run({ snapshot, plan, script, signal: this.signal });
    cancelled(this.signal);
    const verdict = evaluatePlaytest(observations, plan, script);
    let thumbnail = null;
    if (verdict.passed) {
      const bytes = Buffer.from(observations.thumbnail);
      const path = await writeAtomic(this.dir, 'thumbnail.png', bytes);
      thumbnail = { path, sha256: sha256(bytes), bytes: bytes.length, width: verdict.metrics.thumbnail_width, height: verdict.metrics.thumbnail_height, content_type: 'image/png' };
    }
    this.receipt.playtest = {
      status: verdict.passed ? 'passed' : 'failed', kind: observations?.kind === 'browser' ? 'browser' : 'invalid', runner: this.runner.kind === 'browser' ? 'chromium-sandboxed' : 'injected',
      browser: observations?.browser ? { name: String(observations.browser.name).slice(0, 20), version: String(observations.browser.version).slice(0, 40), sandbox: observations.browser.sandbox === true } : null,
      failures: verdict.failures, metrics: verdict.metrics, src_digest: snapshot.srcDigest,
      thumbnail: thumbnail && { path: thumbnail.path, sha256: thumbnail.sha256, bytes: thumbnail.bytes },
      script, contract: { input_actions: plan.input_actions, hud: plan.hud, menus: plan.menus, loss_or_reset: plan.loss_or_reset },
      at: this.context.now().toISOString(),
    };
    this.gateRecord('playtest', verdict.failures);
    await this.save();
    this.emit({ type: 'stage', stage: 'browser', status: verdict.passed ? 'done' : 'failed' });
    return { verdict, thumbnail, samples: Array.isArray(observations?.error_samples) ? observations.error_samples.slice(0, 5).map(item => String(item).slice(0, 200)) : [] };
  }
}

async function resolveRequest(options, context) {
  let request = options.request;
  if (request === undefined) {
    if (!context.interactive) throw new AgentError('AGENT_REQUEST_REQUIRED');
    request = await readInteractiveRequest({ stdin: context.stdin, stderr: context.stderr, signal: context.signal, maxChars: LIMITS.requestChars });
  }
  const admitted = admitRequest(request, LIMITS.requestChars);
  if (!admitted) throw new AgentError('AGENT_REQUEST_INVALID');
  return admitted;
}

async function preflightDeploy(run) {
  run.emit({ type: 'stage', stage: 'preflight', status: 'started' });
  let quota;
  try { quota = normalizeQuota(await run.deploy.preflight({ signal: run.signal })); } catch (error) { throw preflightFailure(error, run.signal); }
  if (quota.remaining <= 0) throw quotaExceeded(quota);
  run.emit({ type: 'stage', stage: 'preflight', status: 'done' });
  return quota;
}

async function packageProject(run, root, { force = false } = {}) {
  run.emit({ type: 'stage', stage: 'package', status: 'started' });
  const packaged = await packageCmd(force ? [root, '--force'] : [root], { cwd: run.context.cwd, signal: run.signal });
  run.emit({ type: 'stage', stage: 'package', status: 'done' });
  return { path: packaged.path, sha256: packaged.sha256, bytes: packaged.bytes, format: packaged.format, file_count: packaged.file_count };
}

/** Recomputes the source and package digests right before an external mutation. */
async function verifyRelease(run, root, digests, pkg) {
  const now = await snapshotProject(root, run.signal);
  const file = await inspectPackageFile(pkg.path).catch(() => ({ valid: false }));
  const codes = [];
  if (now.srcDigest !== digests.src_playtested || now.fullDigest !== digests.release) codes.push('SOURCE_DIGEST_CHANGED');
  if (!file.valid || file.sha256 !== pkg.sha256 || now.packageSha256 !== pkg.sha256) codes.push('PACKAGE_DIGEST_CHANGED');
  run.gateRecord('release_digest', codes);
  if (codes.length) { await run.save({ state: 'source_changed' }); throw new AgentError('AGENT_SOURCE_CHANGED', { codes }); }
}

async function publish(run, root, pkg, thumbnail) {
  cancelled(run.signal);
  await verifyRelease(run, root, run.receipt.digests, pkg);
  cancelled(run.signal);
  run.emit({ type: 'stage', stage: 'deploy', status: 'started' });
  cancelled(run.signal);
  // Persist the attempt first: a crash mid-request must resume as "outcome unknown", never as "not attempted".
  await run.save({ state: 'publish_attempting', publish: { status: 'attempting', package_sha256: pkg.sha256, at: run.context.now().toISOString() } });
  let result;
  try {
    if (run.signal?.aborted) throw Object.assign(new AgentError('COMMAND_CANCELLED'), { definite: true });
    result = await run.deploy.run(pkg.path, { signal: run.signal, yolo: true, receiptDir: run.dir, thumbnail, package_sha256: pkg.sha256, project_root: root });
  } catch (error) {
    const { outcome, error: failure } = classifyPublishFailure(error, run.signal);
    await run.save({ state: outcome === 'unknown' ? 'publish_outcome_unknown' : 'publish_rejected', publish: { status: outcome, package_sha256: pkg.sha256, error: failure.code } });
    run.emit({ type: 'stage', stage: 'deploy', status: 'failed' });
    failure.details = { ...(failure.details ?? {}), run_id: run.runId };
    throw failure;
  }
  const published = normalizePublish(result);
  if (!published) {
    await run.save({ state: 'publish_outcome_unknown', publish: { status: 'unknown', package_sha256: pkg.sha256, error: 'AGENT_PUBLISH_OUTCOME_UNKNOWN' } });
    throw new AgentError('AGENT_PUBLISH_OUTCOME_UNKNOWN', { run_id: run.runId });
  }
  await run.save({ state: 'published', publish: { ...published, package_sha256: pkg.sha256 } });
  run.emit({ type: 'stage', stage: 'deploy', status: 'done' });
  return published;
}

async function uploadDraft(run, root, pkg) {
  cancelled(run.signal);
  await verifyRelease(run, root, run.receipt.digests, pkg);
  run.emit({ type: 'stage', stage: 'upload', status: 'started' });
  cancelled(run.signal);
  let upload = run.context.upload;
  if (!upload) {
    const [{ runUpload }, validator, { projectPackager }] = await Promise.all([import('../../commands/upload.mjs'), import('../vendor/zwf/format.mjs'), import('../upload-project.mjs')]);
    upload = (args, options) => runUpload(args, { ...options, core: projectPackager, validator });
  }
  cancelled(run.signal);
  const result = await upload([root], { cwd: run.context.cwd, signal: run.signal });
  if (result?.package?.sha256 !== pkg.sha256) throw new AgentError('AGENT_SOURCE_CHANGED', { codes: ['UPLOAD_DIGEST_MISMATCH'] });
  const draft = { status: 'draft_created', content_id: typeof result.content?.id === 'string' ? result.content.id : null, receipt: result.receipt?.path ?? null };
  await run.save({ state: 'draft_created', draft });
  run.emit({ type: 'stage', stage: 'upload', status: 'done' });
  return draft;
}

function summary(run, extra) {
  const experimental = run.receipt.stages.some(stage => stage.experimental === true);
  const unofficial = run.receipt.stages.some(stage => stage.unofficial === true);
  return {
    status: run.receipt.state, published: run.receipt.state === 'published', mode: run.options.mode, run_id: run.runId,
    project: run.receipt.project, package: run.receipt.package ?? null,
    playtest: run.receipt.playtest && { status: run.receipt.playtest.status, runner: run.receipt.playtest.runner, browser: run.receipt.playtest.browser, failures: run.receipt.playtest.failures, metrics: run.receipt.playtest.metrics, thumbnail: run.receipt.playtest.thumbnail },
    skills: run.receipt.skills, usage: run.receipt.usage,
    provider: run.receipt.stages.length ? { experimental, unofficial, ...(experimental ? { indicator: '(exp!)', notice: '선택한 인증 연결은 Experimental입니다.' } : {}) } : null,
    receipt: { path: run.receiptPath ?? null },
    ...extra,
  };
}

/** Fresh agent run. `options` comes from parseAgentArgs (without --resume). */
export async function runGameAgent(options, rawContext = {}) {
  const context = normalizeContext(rawContext);
  const run = new Run(options, context);
  cancelled(run.signal);
  // 1. Local, mutation-free checks.
  const request = await resolveRequest(options, context);
  run.skills = await loadSkillPack();
  if (options.name) await assertAbsent(resolve(context.cwd, options.name));
  // 2. YOLO: authoritative account + quota preflight before any model token is spent.
  let quota = null;
  if (options.mode === 'yolo') {
    run.deploy = await resolveDeploy(context.deploy, context);
    quota = await preflightDeploy(run);
  }
  run.provider = await resolveProvider(context.provider);
  run.runner = context.playtest ?? createBrowserPlaytest({ browserPath: options.browser, onEvent: run.emit });
  if (typeof run.runner?.run !== 'function') throw new AgentError('AGENT_PLAYTEST_UNAVAILABLE');
  // Fail on a missing/unsandboxable browser before any model token is spent (may install the pinned Chromium).
  await run.runner.prepare?.({ signal: run.signal });
  cancelled(run.signal);
  // 3. State, lock and receipt.
  const state = await prepareState(context.cwd);
  run.runId = newRunId(context.now());
  const lock = await acquireLock(state, run.runId);
  let claim, stagingRoot, materialized = false;
  try {
    run.dir = await runDir(state, run.runId);
    run.receipt = {
      schema: RECEIPT_SCHEMA, run_id: run.runId, cli_version: cliVersion, created_at: context.now().toISOString(), mode: options.mode,
      request_sha256: sha256(request), request_chars: [...request].length, model: options.model ?? null, state: 'planning',
      skill_pack: { version: run.skills.version, sha256: run.skills.sha256 }, skills: run.skills.receipts(),
      quota, project: null, engine: null, stages: [], gates: [], playtest: null, digests: null, package: null, publish: null,
    };
    await run.save();

    // 4. Design → architecture.
    const plan = await run.stage('design', { request, hook_contract: HOOK_CONTRACT }, gatePlan);
    run.gateRecord('plan', []);
    claim = await claimName(context.cwd, options.name, deriveName(plan.title, `game-${run.runId.slice(-8)}`), run.runId);
    const name = claim.name;
    const engines = await availableEngines(context.engine);
    const scaffold = engines.names.includes('canvas') ? await readScaffold() : null;
    const architecture = await run.stage('architecture', { plan, available_engines: engines.names, engine_notes: engines.phaser ? { phaser: engines.phaser.version } : { phaser: 'not_bundled' }, create_scaffold: scaffold, hook_contract: HOOK_CONTRACT }, output => gateArchitecture(output, plan, { engines: engines.names }));
    run.gateRecord('architecture', []);
    const engine = architecture.engine.name === 'phaser'
      ? { name: 'phaser', version: engines.phaser.version, bytes: engines.phaser.bytes, license: engines.phaser.license, sha256: engines.phaser.sha256, reason: architecture.engine.reason }
      : { name: 'canvas', version: null, reason: engines.phaser ? architecture.engine.reason : `${architecture.engine.reason} (phaser bundle unavailable)`, uses_create_scaffold: architecture.engine.uses_create_scaffold };
    await run.save({ state: 'implementing', project: { name, path: claim.path, title: plan.title }, engine: { name: engine.name, version: engine.version, sha256: engine.sha256 ?? null, reason: engine.reason.slice(0, 400) } });

    // 5. Implementation → staged + validated project → real playtest (with bounded repair).
    const implement = repair => run.stage('implementation', { plan, architecture, create_scaffold: architecture.engine.uses_create_scaffold ? scaffold : null, hook_contract: HOOK_CONTRACT, ...(repair ? { repair } : {}) }, output => gateImplementation(output.files, plan, architecture));
    let files = (await implement()).files;
    let script, verdict, thumbnail, snapshot;
    for (let repairs = 0; ; repairs++) {
      cancelled(run.signal);
      const manifest = buildManifest(name, plan);
      stagingRoot = await stageProject({ runDir: run.dir, name, manifest, plan, engine, files });
      run.emit({ type: 'stage', stage: 'validate', status: 'started' });
      let failure;
      try { snapshot = await snapshotProject(stagingRoot, run.signal); } catch (error) {
        if (error?.code !== 'PROJECT_INVALID') throw error;
        failure = { failures: ['PROJECT_INVALID'], samples: (error.details?.diagnostics ?? []).slice(0, 5).map(item => `${item.code} ${item.path}`.slice(0, 200)) };
      }
      run.gateRecord('validate', failure ? failure.failures : []);
      run.emit({ type: 'stage', stage: 'validate', status: failure ? 'failed' : 'done' });
      if (!failure) {
        await run.save({ state: 'playtesting' });
        if (!script) script = await run.stage('playtest', { plan, architecture: { modules: architecture.modules, input_mapping: architecture.input_mapping }, files: files.map(file => file.path) }, output => gatePlaytestScript(output, plan));
        let result;
        try { result = await run.playtest(snapshot, plan, script); } catch (error) {
          if (!['AGENT_PLAYTEST_UNAVAILABLE', 'AGENT_PLAYTEST_SANDBOX'].includes(error?.code)) throw error;
          // The game stays editable locally, but an unplaytested project is never packaged or published.
          await materialize(stagingRoot, claim); materialized = true;
          await run.save({ state: 'playtest_unavailable', project: { ...run.receipt.project, materialized: true } });
          error.details = { ...(error.details ?? {}), project_path: claim.path, run_id: run.runId };
          throw error;
        }
        ({ verdict, thumbnail } = result);
        if (verdict.passed) break;
        failure = { failures: verdict.failures, samples: result.samples };
      }
      if (repairs >= LIMITS.repairs) {
        // Keep the editable project for the user, but never package, upload or publish it.
        await run.save({ state: failure.failures.includes('PROJECT_INVALID') ? 'validation_failed' : 'playtest_failed' });
        await materialize(stagingRoot, claim); materialized = true;
        await run.save({ project: { ...run.receipt.project, materialized: true } });
        throw new AgentError(failure.failures.includes('PROJECT_INVALID') ? 'AGENT_GATE_FAILED' : 'AGENT_PLAYTEST_FAILED', { codes: failure.failures, project_path: claim.path, run_id: run.runId });
      }
      run.emit({ type: 'stage', stage: 'implementation', status: 'repair' });
      files = (await implement({ previous_files: files, failures: failure.failures, error_samples: failure.samples })).files;
    }

    // 6. Publish metadata (game-publish skill), final manifest, digests, materialize, package.
    const meta = await run.stage('publish', { plan, files: files.map(file => file.path), playtest: { failures: [], metrics: verdict.metrics } }, output => gatePublish(output, plan));
    await rewriteManifest(stagingRoot, buildManifest(name, plan, meta));
    const release = await snapshotProject(stagingRoot, run.signal);
    if (release.srcDigest !== snapshot.srcDigest) { run.gateRecord('source_digest', ['SOURCE_DIGEST_CHANGED']); throw new AgentError('AGENT_SOURCE_CHANGED'); }
    const digests = { src_playtested: snapshot.srcDigest, release: release.fullDigest };
    cancelled(run.signal);
    await materialize(stagingRoot, claim); materialized = true;
    const final = await snapshotProject(claim.path, run.signal);
    if (final.fullDigest !== digests.release) { run.gateRecord('source_digest', ['SOURCE_DIGEST_CHANGED']); throw new AgentError('AGENT_SOURCE_CHANGED'); }
    await run.save({ state: 'packaging', digests, project: { name, path: claim.path, title: meta.title, materialized: true, file_count: final.files.size } });
    const pkg = await packageProject(run, claim.path);
    await run.save({ state: 'packaged', package: pkg, digests: { ...digests, package_sha256: pkg.sha256 } });

    // 7. Mode-specific finish.
    if (options.mode === 'draft') return summary(run, { draft: await uploadDraft(run, claim.path, pkg) });
    if (options.mode === 'yolo') return summary(run, { publish: await publish(run, claim.path, pkg, thumbnail), thumbnail: { path: thumbnail.path, sha256: thumbnail.sha256 } });
    return summary(run);
  } catch (error) {
    if (run.receipt && run.dir) {
      const code = error instanceof CommandError ? error.code : 'COMMAND_FAILED';
      const keep = ['publish_outcome_unknown', 'publish_rejected', 'published', 'playtest_failed', 'playtest_unavailable', 'validation_failed', 'source_changed', 'draft_created'];
      await run.save({ state: keep.includes(run.receipt.state) ? run.receipt.state : code === 'COMMAND_CANCELLED' ? 'cancelled' : 'failed', error: { code } }).catch(() => {});
    }
    throw error;
  } finally {
    if (claim && !materialized) await releaseClaim(claim);
    if (run.dir && !materialized) {
      try {
        await validateRunDir(run.dir);
        const staging = join(run.dir, 'staging');
        const stat = await lstat(staging).catch(() => undefined);
        if (stat?.isDirectory() && !stat.isSymbolicLink()) await rm(staging, { recursive: true, force: true });
      } catch { /* Preserve detached or changed directories for the user to inspect. */ }
    }
    await lock.release();
  }
}

/** Explicit --name must be free; a derived name falls back to numbered or run-id suffixes. */
async function claimName(cwd, explicit, derived, runId) {
  if (explicit) return claimProject(cwd, explicit);
  const base = derived.slice(0, 54);
  for (const candidate of [derived, ...[2, 3, 4, 5].map(n => `${base}-${n}`), `${base}-${runId.slice(-8)}`]) {
    try { return await claimProject(cwd, candidate); } catch (error) { if (error?.code !== 'AGENT_PROJECT_EXISTS') throw error; }
  }
  throw new AgentError('AGENT_PROJECT_EXISTS');
}

async function readScaffold() {
  const { readFile } = await import('node:fs/promises');
  const base = new URL('../templates/zukujs-html5/src/', import.meta.url);
  return { 'src/index.html': await readFile(new URL('index.html', base), 'utf8'), 'src/game.js': await readFile(new URL('game.js', base), 'utf8') };
}

const RESUMABLE = new Set(['packaged', 'publish_rejected', 'publish_outcome_unknown', 'publish_attempting', 'published', 'draft_created']);

/**
 * --resume <run_id>: re-validates a materialized project against its recorded digests, re-runs the
 * real browser playtest, rebuilds the deterministic package (must match), then optionally publishes.
 * An unknown or interrupted publish is only continued after deploy.recover() reports the server state.
 */
export async function resumeGameAgent(options, rawContext = {}) {
  const context = normalizeContext(rawContext);
  const run = new Run(options, context);
  cancelled(run.signal);
  run.skills = await loadSkillPack();
  const state = await prepareState(context.cwd);
  const { receipt, dir } = await loadReceipt(state, options.resume);
  if (!RESUMABLE.has(receipt.state) || !NAME_PATTERN.test(receipt.project?.name ?? '') || !receipt.digests?.release || !receipt.playtest?.script || !receipt.playtest?.contract) throw new AgentError('AGENT_RESUME_INVALID');
  const expectedSkills = run.skills.receipts();
  if (receipt.skill_pack?.version !== run.skills.version || receipt.skill_pack?.sha256 !== run.skills.sha256
      || !Array.isArray(receipt.skills) || receipt.skills.length !== expectedSkills.length
      || expectedSkills.some(expected => receipt.skills.filter(actual => receiptMatches(actual, expected)).length !== 1)) throw new AgentError('AGENT_RESUME_INVALID');
  if (validateSchema(PLAYTEST_CONTRACT_SCHEMA, receipt.playtest.contract).length
      || validateSchema(STAGES.playtest.schema, receipt.playtest.script).length
      || gatePlaytestScript(receipt.playtest.script, receipt.playtest.contract).length) throw new AgentError('AGENT_RESUME_INVALID');
  if (receipt.state === 'published') return { status: 'published', published: true, run_id: receipt.run_id, publish: receipt.publish, receipt: { path: join(dir, 'receipt.json') }, resumed: true };
  if (options.mode === 'yolo' || ['publish_outcome_unknown', 'publish_attempting'].includes(receipt.state)) run.deploy = await resolveDeploy(context.deploy, context);
  run.runner = context.playtest ?? createBrowserPlaytest({ browserPath: options.browser, onEvent: run.emit });
  run.runId = receipt.run_id;
  const lock = await acquireLock(state, run.runId);
  try {
    run.dir = dir;
    run.receipt = receipt;
    run.receipt.resumes = (Number.isSafeInteger(receipt.resumes) ? receipt.resumes : 0) + 1;
    run.options = { ...options, mode: options.mode };
    // Unknown publish outcomes are recovered by querying the server first; never by re-sending.
    if (['publish_outcome_unknown', 'publish_attempting'].includes(receipt.state)) {
      if (typeof run.deploy.recover !== 'function') throw new AgentError('AGENT_RECOVERY_REQUIRED', { run_id: run.runId });
      let recovered;
      try { recovered = await run.deploy.recover({ run_id: run.runId, package_sha256: receipt.digests.package_sha256, signal: run.signal }); }
      catch { throw new AgentError('AGENT_RECOVERY_REQUIRED', { run_id: run.runId }); }
      if (recovered?.status === 'published') {
        const published = normalizePublish(recovered);
        if (!published) throw new AgentError('AGENT_RECOVERY_REQUIRED', { run_id: run.runId });
        await run.save({ state: 'published', publish: { ...published, package_sha256: receipt.digests.package_sha256, recovered: true } });
        return summary(run, { publish: run.receipt.publish, resumed: true });
      }
      if (recovered?.status !== 'not_published') throw new AgentError('AGENT_RECOVERY_REQUIRED', { run_id: run.runId });
      await run.save({ state: 'publish_rejected', publish: { status: 'not_published', package_sha256: receipt.digests.package_sha256, recovered: true } });
    }
    const root = resolve(context.cwd, receipt.project.name);
    const stat = await lstat(root).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentError('AGENT_RESUME_INVALID');
    let quota = null;
    if (options.mode === 'yolo') quota = await preflightDeploy(run);
    const snapshot = await snapshotProject(root, run.signal);
    if (snapshot.srcDigest !== receipt.digests.src_playtested || snapshot.fullDigest !== receipt.digests.release) {
      run.gateRecord('resume_digest', ['SOURCE_DIGEST_CHANGED']);
      await run.save({ state: 'source_changed' });
      throw new AgentError('AGENT_SOURCE_CHANGED', { codes: ['SOURCE_DIGEST_CHANGED'] });
    }
    const contract = receipt.playtest.contract;
    const scriptCodes = gatePlaytestScript(receipt.playtest.script, contract);
    if (scriptCodes.length) throw new AgentError('AGENT_RESUME_INVALID');
    const { verdict, thumbnail } = await run.playtest(snapshot, contract, receipt.playtest.script);
    if (!verdict.passed) {
      await run.save({ state: 'playtest_failed' });
      throw new AgentError('AGENT_PLAYTEST_FAILED', { codes: verdict.failures, run_id: run.runId });
    }
    const pkg = await packageProject(run, root, { force: true });
    if (receipt.digests.package_sha256 && pkg.sha256 !== receipt.digests.package_sha256) throw new AgentError('AGENT_SOURCE_CHANGED', { codes: ['PACKAGE_DIGEST_CHANGED'] });
    await run.save({ state: 'packaged', package: pkg, quota: quota ?? receipt.quota, digests: { ...receipt.digests, package_sha256: pkg.sha256 } });
    if (options.mode === 'draft') return summary(run, { draft: await uploadDraft(run, root, pkg), resumed: true });
    if (options.mode === 'yolo') return summary(run, { publish: await publish(run, root, pkg, thumbnail), resumed: true });
    return summary(run, { resumed: true });
  } catch (error) {
    const code = error instanceof CommandError ? error.code : 'COMMAND_FAILED';
    if (run.receipt && !['publish_outcome_unknown', 'publish_rejected', 'published', 'source_changed', 'playtest_failed', 'publish_attempting'].includes(run.receipt.state)) await run.save({ error: { code } }).catch(() => {});
    throw error;
  } finally {
    await lock.release();
  }
}
