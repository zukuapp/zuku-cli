import { randomBytes } from 'node:crypto';
import { checkProject } from '../../../commands/validate.mjs';
import { snapshotProject as snapshotGame } from '../project.mjs';
import { decodePng } from '../png.mjs';
import { ScopeError, cancelled } from './errors.mjs';
import { isIssuedAdmission, toolAdmission } from './purpose.mjs';
import { classifyWorkspace, isIssuedClassification } from './classify.mjs';
import { ProjectRoot } from './paths.mjs';
import { ChangeJournal, sha256 } from './files.mjs';
import { TOOL_IDS, TOOL_SCHEMAS, admitToolInput, toWireSchema } from './schema.mjs';
import { createSandboxRunner, snapshotTree } from './sandbox.mjs';
import { createDocsTool } from './docs.mjs';
import { boundText } from './redact.mjs';
import { digest } from './state.mjs';
import { NULL_SINK, capabilityFor, createEventSink } from './events.mjs';

export const RUNTIME_LIMITS = Object.freeze({ toolCalls: 64, observationChars: 16000, diagnostics: 20, thumbnailBytes: 4 * 1024 * 1024 });
const DESCRIPTIONS = Object.freeze({
  read_file: 'Read a UTF-8 project file (returns sha256 needed for edits).',
  write_file: 'Create (expected_sha256:null) or replace (expected_sha256 of current bytes) a game source/config file.',
  patch_file: 'Apply exact unique text replacements to a file at expected_sha256.',
  search_project: 'Literal text search over non-private project files.',
  run_zuku: 'Built-in ZukuJS validate/package (in-process, no project code runs) or a root-supplied sandboxed browser playtest.',
  run_tests: 'Run a host-declared test form by script_id inside the OS sandbox.',
  run_build: 'Run a host-declared build form by script_id inside the OS sandbox.',
  inspect_asset: 'Report asset type, size, sha256 and dimensions.',
  query_zuku_docs: 'Search official ZUKU/ZukuJS documentation (reference data only).',
});
// Errors a model can react to (they become observations); anything else ends the run.
const OBSERVABLE = new Set(['SCOPE_PATH_DENIED', 'SCOPE_CONFLICT', 'SCOPE_TOOL_DENIED', 'SANDBOX_UNAVAILABLE', 'DOCS_UNAVAILABLE']);
const randomId = prefix => `${prefix}${randomBytes(8).toString('hex')}`;
const isPng = bytes => { try { const png = decodePng(bytes); return png.width > 0 && png.height > 0 ? png : undefined; } catch { return undefined; } };

/**
 * createScopedToolRuntime(options) -> runtime. The runtime, not the model or provider,
 * decides which operations run. Options (all optional except a project):
 *   cwd | classification       project directory, or the host object from classifyWorkspace
 *   admission                  host admission (scoped route); default: internal tool admission
 *   signal, onEvent | events   cancellation and Agent Core event delivery
 *   sandbox, forms             OS sandbox runner / root-declared extra test & build forms
 *   playtest({root, snapshot, signal}) -> {passed, thumbnail: PNG bytes, observations}
 *                              root-supplied real sandboxed browser playtest (optional)
 *   docs                       { sources, fetchImpl } fixed official public docs
 *   store                      run store (receipts/backups) from state.mjs
 *   limits                     { toolCalls }
 * execute({tool, input}) is the model path (returns an observation envelope);
 * execute(name, input) is the direct host path used by Agent Core (returns the result or
 * throws a protocol-safe ScopeError).
 */
export async function createScopedToolRuntime(options = {}) {
  const { signal, store } = options;
  const classification = isIssuedClassification(options.classification) ? options.classification : await classifyWorkspace({ cwd: options.cwd ?? process.cwd(), signal });
  const admission = isIssuedAdmission(options.admission) && options.admission.route === 'scoped' ? options.admission : toolAdmission(classification);
  if (options.admission !== undefined && admission !== options.admission) throw new ScopeError('SCOPE_CLASSIFICATION_INVALID');
  const events = options.events ?? (typeof options.onEvent === 'function' ? createEventSink({ onEvent: options.onEvent }) : NULL_SINK);
  const playtest = typeof options.playtest === 'function' ? options.playtest : undefined;
  const project = await ProjectRoot.open(classification.root, classification.root_identity);
  const journal = new ChangeJournal(project, classification.manifest);
  const sandbox = options.sandbox ?? createSandboxRunner({ root: project.root, forms: options.forms });
  const docs = createDocsTool(options.docs ?? {});
  const limits = { ...RUNTIME_LIMITS, ...(options.limits ?? {}) };
  const receipts = [];
  let calls = 0, callSeq = 0, lastPackage = null, lastPlaytest = null;

  const cap = await sandbox.capability(signal);
  const forms = await sandbox.forms();
  const formsOf = kind => [...forms.values()].filter(form => form.kind === kind).map(form => form.id);
  const availability = {
    run_tests: cap.available && formsOf('tests').length ? null : (cap.available ? 'no-test-forms' : cap.reason ?? 'sandbox-unavailable'),
    run_build: cap.available && formsOf('build').length ? null : (cap.available ? 'no-build-forms' : cap.reason ?? 'sandbox-unavailable'),
  };
  const zukuActions = [...(classification.manifest ? ['validate', 'package'] : []), ...(playtest && classification.manifest ? ['playtest'] : [])];
  if (!zukuActions.length) availability.run_zuku = 'no-zukujs-manifest';
  const capabilities = Object.freeze(TOOL_IDS.map(id => Object.freeze({
    id, description: DESCRIPTIONS[id], input_schema: toWireSchema(TOOL_SCHEMAS[id]), available: !availability[id], reason: availability[id] ?? null,
    ...(id === 'run_tests' ? { script_ids: formsOf('tests') } : id === 'run_build' ? { script_ids: formsOf('build') } : id === 'run_zuku' ? { actions: zukuActions } : {}),
  })));

  const builtin = async action => {
    try {
      const { result, project: manifest } = await checkProject(project.root, undefined, () => Boolean(signal?.aborted));
      const observation = { action, passed: true, entry: result.entry, file_count: result.files, format: manifest.format };
      if (action === 'package') {
        lastPackage = { sha256: sha256(result.bytes), bytes: result.bytes.length, format: manifest.format };
        Object.assign(observation, { sha256: lastPackage.sha256, bytes: lastPackage.bytes });
      }
      return observation;
    } catch (error) {
      if (error?.code === 'COMMAND_CANCELLED' || signal?.aborted) throw new ScopeError('COMMAND_CANCELLED');
      if (Array.isArray(error?.details?.diagnostics)) return { action, passed: false, error: error.code, diagnostics: error.details.diagnostics.slice(0, limits.diagnostics).map(d => ({ code: String(d.code).slice(0, 64), path: boundText(d.path ?? '', 200).text, message: boundText(d.message ?? '', 300).text })) };
      return { action, passed: false, error: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'VALIDATION_FAILED' };
    }
  };

  async function runPlaytest() {
    if (!playtest || !classification.manifest) throw new ScopeError('SCOPE_TOOL_DENIED');
    const before = await snapshotTree(project.root, null, { signal });
    let snapshot;
    try { snapshot = await snapshotGame(project.root, signal); } catch (error) {
      if (signal?.aborted) throw new ScopeError('COMMAND_CANCELLED');
      lastPlaytest = { passed: false, source_digest: before.digest, thumbnail: null };
      return { action: 'playtest', passed: false, error: typeof error?.code === 'string' ? error.code.slice(0, 64) : 'PROJECT_INVALID' };
    }
    const gameHandle = randomId('game_');
    await events.emit('game.started', { gameHandle, state: 'running' });
    let raw, failure, thrown;
    try { raw = await playtest({ root: project.root, snapshot, signal }); }
    catch (error) { if (signal?.aborted || error?.code === 'COMMAND_CANCELLED') thrown = new ScopeError('COMMAND_CANCELLED'); else failure = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'PLAYTEST_FAILED'; }
    // The stop transition is journaled even after a cancelled run; the first failure wins.
    await events.emit('game.stopped', { gameHandle, state: 'stopped', ...(failure ? { code: failure } : {}) }).catch(error => { thrown ??= error; });
    if (thrown) throw thrown;
    const after = await snapshotTree(project.root, null, { signal });
    // The thumbnail must be a real decodable PNG; the runner's `passed` must be an explicit true.
    const thumbBytes = raw?.thumbnail && (Buffer.isBuffer(raw.thumbnail) || raw.thumbnail instanceof Uint8Array) && raw.thumbnail.length <= limits.thumbnailBytes ? Buffer.from(raw.thumbnail) : null;
    const png = thumbBytes ? isPng(thumbBytes) : undefined;
    const passed = !failure && raw?.passed === true && before.digest === after.digest && snapshot.srcDigest !== undefined;
    lastPlaytest = { passed, source_digest: before.digest, src_digest: snapshot.srcDigest, thumbnail: passed && png ? { bytes: thumbBytes, sha256: sha256(thumbBytes), width: png.width, height: png.height } : null };
    return { action: 'playtest', passed, source_digest: before.digest, thumbnail: Boolean(lastPlaytest.thumbnail), ...(failure ? { error: failure } : {}), observations: boundText(JSON.stringify(raw?.observations ?? []), 4000).text };
  }

  async function runForm(scriptId, kind) {
    const buildId = randomId('build_');
    // The journal must accept build.started before the sandboxed process is launched. The
    // sandbox awaits every build.output delivery (bounded queue, flushed before it returns)
    // and kills the process when the host rejects one.
    await events.emit('build.started', { buildId, scriptId });
    let result, thrown;
    try { result = await sandbox.run(scriptId, kind, { signal, onOutput: ({ stream, text }) => events.emit('build.output', { buildId, stream, text }) }); }
    catch (error) { thrown = error; }
    const code = Number.isSafeInteger(result?.exit_code) && result.exit_code >= 0 && result.exit_code <= 255 ? result.exit_code : -1;
    await events.emit('build.completed', { buildId, exitCode: code, status: result?.passed === true ? 'passed' : 'failed', ...(typeof result?.snapshot_digest === 'string' ? { sourceSha256: result.snapshot_digest } : {}) }).catch(error => { thrown ??= error; });
    if (thrown) throw thrown;
    return result;
  }

  // Private host hook (never reachable from model input): the original bytes the journal
  // checked against expected_sha256 are persisted through the run store, and their digest
  // confirmed, before the project file is touched. A failed backup prevents the edit.
  const beforeWrite = async ({ original, original_sha256: originalSha }) => {
    if (!store || original === null) return;
    const saved = await store.backup(original);
    if (saved?.sha256 !== originalSha) throw new ScopeError('SCOPE_STATE_UNSAFE');
  };
  const handlers = {
    read_file: input => journal.readText(input.path, input),
    write_file: input => journal.write(input.path, input.content, input.expected_sha256, { beforeWrite }),
    patch_file: input => journal.patch(input.path, input.expected_sha256, input.edits, { beforeWrite }),
    search_project: input => journal.search(input.query, input.path),
    inspect_asset: input => journal.inspectAsset(input.path),
    query_zuku_docs: input => docs.query(input.query, { signal }),
    run_zuku: input => {
      if (!zukuActions.includes(input.action)) throw new ScopeError('SCOPE_TOOL_DENIED');
      return input.action === 'playtest' ? runPlaytest() : builtin(input.action);
    },
    run_tests: input => runForm(input.script_id, 'tests'),
    run_build: input => runForm(input.script_id, 'build'),
  };

  async function run(tool, input) {
    cancelled(signal);
    if (++calls > limits.toolCalls) throw new ScopeError('SCOPE_LIMIT');
    const errors = admitToolInput(tool, input);
    const capability = capabilityFor(tool, input);
    const callId = `call_${++callSeq}`;
    const path = typeof input?.path === 'string' && !errors.length ? { path: input.path } : {};
    const finish = async (status, observation, code) => {
      const receipt = { tool: TOOL_IDS.includes(tool) ? tool : 'invalid', capability, status, input_sha256: digest(JSON.stringify(input ?? null)), output_sha256: digest(JSON.stringify(observation)), executed_by: 'host' };
      receipts.push(store ? await store.receipt(receipt) : receipt);
      // Terminal transitions follow the durable receipt; a journal rejection ends the run.
      if (capability) {
        if (status === 'ok') await events.emit('tool.completed', { callId, capability, status: 'passed', ...path, ...(observation?.beforeSha256 ? { beforeSha256: observation.beforeSha256 } : {}), ...(typeof observation?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(observation.sha256) && ['write_file', 'patch_file'].includes(tool) ? { afterSha256: observation.sha256 } : {}) });
        else await events.emit('tool.failed', { callId, capability, status: 'failed', ...path, code });
      }
      return { tool, ok: status === 'ok', code: status === 'ok' ? null : code, observation };
    };
    // The host journal must accept tool.requested (after closed-schema admission, before any
    // handler) and tool.started (before any mutation or process launch); a rejection throws
    // SCOPE_STATE_UNSAFE and nothing executes.
    if (capability) await events.emit('tool.requested', { callId, capability, status: 'requested', ...path });
    // Mirrors the "rewrite the input" contract of tool-calling agents: invalid arguments are
    // reported back as data and nothing executes.
    if (errors.length) return finish('rejected', { error: 'invalid_arguments', details: errors.slice(0, 10) }, 'INVALID_ARGUMENTS');
    if (availability[tool]) return finish('unavailable', { error: 'capability_unavailable', reason: availability[tool] }, 'CAPABILITY_UNAVAILABLE');
    await events.emit('tool.started', { callId, capability, status: 'started', ...path });
    let observation;
    try {
      observation = await handlers[tool](input);
    } catch (error) {
      // A host journal/state failure outranks the abort Agent Core raises in response to it.
      if (error instanceof ScopeError && error.scopeCode === 'SCOPE_STATE_UNSAFE') throw error;
      if (error?.code === 'COMMAND_CANCELLED' || signal?.aborted) throw new ScopeError('COMMAND_CANCELLED');
      if (error instanceof ScopeError && (OBSERVABLE.has(error.scopeCode) || error.scopeCode === 'SCOPE_LIMIT')) return finish('denied', { error: error.scopeCode, ...(error.details?.reason ? { reason: error.details.reason } : {}) }, error.scopeCode);
      if (error instanceof ScopeError) throw error;
      return finish('failed', { error: 'tool_failed' }, 'TOOL_FAILED');
    }
    const failed = observation && typeof observation === 'object' && (observation.passed === false || observation.applied === false);
    return finish(failed ? 'failed' : 'ok', observation, failed ? 'CHECK_FAILED' : undefined);
  }

  const bound = observation => {
    const text = boundText(JSON.stringify(observation), limits.observationChars);
    return text.truncated ? { truncated: true, text: text.text } : observation;
  };

  // Direct host calls (Agent Core project.read/patch/search, game.build/test).
  function directInput(name, raw = {}) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    if (name === 'patch_file' && typeof input.content === 'string') {
      // Agent Core project.patch is a whole-file replace bound to the current SHA.
      return ['write_file', { path: input.path, content: input.content, expected_sha256: input.expectedSha256 ?? input.expected_sha256 }];
    }
    if (name === 'write_file' && 'expectedSha256' in input) { input.expected_sha256 = input.expectedSha256; delete input.expectedSha256; }
    if (name === 'run_tests' || name === 'run_build') {
      const kind = name === 'run_tests' ? 'tests' : 'build';
      const id = input.script_id ?? input.scriptId ?? formsOf(kind)[0];
      if (!id) throw new ScopeError(cap.available ? 'SCOPE_TOOL_DENIED' : 'SANDBOX_UNAVAILABLE');
      return [name, { script_id: id }];
    }
    return [name, input];
  }

  async function execute(call, maybeInput) {
    if (typeof call === 'string') {
      if (!TOOL_IDS.includes(call)) throw new ScopeError('SCOPE_TOOL_DENIED');
      const [tool, input] = directInput(call, maybeInput);
      const result = await run(tool, input);
      if (!result.ok) {
        if (result.code === 'INVALID_ARGUMENTS') throw new ScopeError('SCOPE_INVALID_INPUT');
        if (result.code === 'CAPABILITY_UNAVAILABLE') throw new ScopeError(cap.available ? 'SCOPE_TOOL_DENIED' : 'SANDBOX_UNAVAILABLE');
        if (result.code === 'CHECK_FAILED' && (tool === 'run_tests' || tool === 'run_build')) return { scriptId: input.script_id, status: 'failed', exitCode: Number.isSafeInteger(result.observation.exit_code) ? result.observation.exit_code : -1 };
        if (result.code === 'CHECK_FAILED') throw new ScopeError(tool === 'patch_file' ? 'SCOPE_CONFLICT' : 'SCOPE_VERIFY_FAILED');
        if (/^SCOPE_|^SANDBOX_|^DOCS_/.test(result.code)) throw new ScopeError(result.code);
        throw new ScopeError('SCOPE_TOOL_DENIED');
      }
      if (tool === 'run_tests' || tool === 'run_build') return { scriptId: input.script_id, status: 'passed', exitCode: result.observation.exit_code };
      return result.observation;
    }
    const result = await run(call?.tool, call?.input);
    return { ...result, observation: bound(result.observation) };
  }

  /**
   * Host verification. The model cannot skip it or report its outcome: built-in validate +
   * package always run for ZukuJS games; every available sandboxed test/build form runs; the
   * root playtest runs when supplied. All results are bound to one source digest.
   */
  async function verify() {
    cancelled(signal);
    const source = await snapshotTree(project.root, null, { signal });
    const checks = [], unavailable = [];
    let validated = false;
    if (classification.manifest) {
      const validate = await builtin('validate');
      validated = validate.passed;
      checks.push({ id: 'zuku:validate', passed: validate.passed, observation: validate });
      const pack = await builtin('package');
      checks.push({ id: 'zuku:package', passed: pack.passed, observation: pack });
    }
    for (const kind of ['tests', 'build']) {
      const ids = formsOf(kind);
      if (!cap.available) { unavailable.push(...ids.map(id => `${kind}:${id}`)); continue; }
      for (const id of ids) {
        const result = await runForm(id, kind).catch(error => { if (error instanceof ScopeError && error.scopeCode === 'SCOPE_STATE_UNSAFE') throw error; if (error?.code === 'COMMAND_CANCELLED' || signal?.aborted) throw new ScopeError('COMMAND_CANCELLED'); return { passed: false, error: error?.scopeCode ?? 'tool_failed' }; });
        checks.push({ id: `${kind}:${id}`, passed: result.passed === true && result.snapshot_digest === source.digest, observation: result });
      }
    }
    if (playtest && validated) {
      const observed = await runPlaytest();
      checks.push({ id: 'zuku:playtest', passed: observed.passed === true && lastPlaytest?.source_digest === source.digest, observation: observed });
    }
    const after = await snapshotTree(project.root, null, { signal });
    const stable = after.digest === source.digest;
    const verified = stable && checks.length > 0 && checks.every(check => check.passed);
    const result = {
      verified, complete: unavailable.length === 0, source_digest: source.digest, stable, unavailable,
      checks: checks.map(check => ({ id: check.id, passed: check.passed, observation: boundText(JSON.stringify(check.observation), 4000).text })),
      package: verified && lastPackage ? { sha256: lastPackage.sha256, bytes: lastPackage.bytes, format: lastPackage.format } : null,
      playtest: lastPlaytest ? { passed: lastPlaytest.passed, thumbnail: Boolean(lastPlaytest.thumbnail) } : null,
    };
    const receipt = { tool: 'verify', capability: 'host-verification', status: verified ? 'passed' : 'failed', input_sha256: source.digest, output_sha256: digest(JSON.stringify(result)), executed_by: 'host' };
    receipts.push(store ? await store.receipt(receipt) : receipt);
    return result;
  }

  return {
    root: project.root, classification, capabilities, journal, receipts, execute, verify,
    toolSchemas: TOOL_SCHEMAS,
    sourceDigest: async () => (await snapshotTree(project.root, null, { signal })).digest,
    get lastPackage() { return lastPackage; },
    get lastPlaytest() { return lastPlaytest; },
    get calls() { return calls; },
    async close() {},
  };
}
