import { BROWSER_GRANT_CAPABILITY, PROVIDER_CONFIG_CAPABILITY, PROVIDER_HEADER_AUTH_CAPABILITY } from '../agent-protocol/schema.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import { ProtocolError, validateRequest, validateEvent, projectPublicResult, sanitizeText, safeError, EVENTS } from '../agent-protocol/index.mjs';
import { createCoreStorage } from './storage.mjs';
import { createJournal } from './journal.mjs';
import { createProjectRegistry, validateActor, actorCanAccess } from './projects.mjs';
import { createProviderRuntime } from '../provider-system/index.mjs';
import { loadSkillPack } from '../agent/skills.mjs';
import { cliVersion } from '../identity.mjs';
import { createNativeAuthController } from './native-auth.mjs';
import { createBrowserRegistry } from './browsers.mjs';
import { createBrowserPlaytest, evaluateBrowserSmoke } from '../agent/playtest.mjs';

const fail = code => { throw new ProtocolError(code); };
const randomId = prefix => `${prefix}${randomBytes(16).toString('hex')}`;
const SHA = /^[a-f0-9]{64}$/;
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'closed', 'needs_auth', 'needs_local_permission']);
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const phases = { design: 'analyzing', architecture: 'analyzing', implementation: 'editing', validate: 'verifying', playtest: 'testing', browser: 'testing', package: 'building', publish: 'verifying', upload: 'verifying', deploy: 'verifying', preflight: 'analyzing' };
function snapshot(session, journal) {
  return { id: session.id, sessionId: session.id, projectHandle: session.projectHandle, state: session.state, mode: session.mode, ...(session.modelAddress ? { modelAddress: session.modelAddress } : {}), sequence: journal.sequence, minimumSequence: journal.minimumSequence, createdAt: session.createdAt, updatedAt: session.updatedAt, ...(session.requestId ? { requestId: session.requestId } : {}), ...(session.runId ? { runId: session.runId } : {}), ...(session.result ? { result: session.result } : {}) };
}
function safeResult(result) {
  const out = { status: 'completed', verified: false, published: result?.published === true };
  if (typeof result?.run_id === 'string' && /^run_[0-9]{14}_[a-f0-9]{8}$/.test(result.run_id)) out.runId = result.run_id;
  if (typeof result?.runId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(result.runId)) out.runId = result.runId;
  if (typeof result?.publish?.content_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(result.publish.content_id)) out.contentId = result.publish.content_id;
  const usage = result?.usage; out.usage = {};
  for (const [target, source] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'], ['totalTokens', 'total_tokens'], ['modelCalls', 'model_calls']]) {
    const value = usage?.[target] ?? usage?.[source]; if (Number.isSafeInteger(value) && value >= 0) out.usage[target] = value;
  }
  return out;
}
async function verifyLegacyResult(result, project, skillPack) {
  if (!/^run_[0-9]{14}_[a-f0-9]{8}$/.test(result?.run_id ?? '')) return undefined;
  const [{ prepareState, loadReceipt }, { snapshotProject }, { inspectPackageFile }] = await Promise.all([import('../agent/state.mjs'), import('../agent/project.mjs'), import('../project-package.mjs')]);
  const { receipt } = await loadReceipt(await prepareState(project.path), result.run_id);
  if (receipt.skill_pack?.sha256 !== skillPack.sha256 || receipt.playtest?.status !== 'passed' || receipt.playtest?.kind !== 'browser' || receipt.playtest?.runner !== 'chromium-sandboxed' || !receipt.project?.path || !receipt.package?.path) return undefined;
  const path = resolve(receipt.project.path), rel = relative(project.path, path);
  if (!rel || rel.startsWith('..') || rel.startsWith('/') || dirname(path) !== project.path) return undefined;
  const current = await snapshotProject(path), pkg = await inspectPackageFile(receipt.package.path);
  if (!pkg.valid || current.fullDigest !== receipt.digests?.release || current.srcDigest !== receipt.digests?.src_playtested || pkg.sha256 !== receipt.digests?.package_sha256 || current.packageSha256 !== pkg.sha256) return undefined;
  return { verified: true, digests: { source: current.fullDigest, package: pkg.sha256, skills: skillPack.sha256 }, evidenceIds: [result.run_id] };
}
/** One authoritative local runtime. Transport callers supply actors outside request JSON. */
export async function createAgentCore(options = {}) {
  const storage = options.storage ?? await createCoreStorage(options);
  const releaseOwner = await storage.acquireOwner();
  const now = options.now ?? (() => new Date());
  let closed = false, closing, metadataQueue = Promise.resolve(), dispatchQueue = Promise.resolve(), scopePromise;
  const sessions = new Map(), journals = new Map(), runs = new Map(), projectJobs = new Map(), previews = new Map();
  const state = await storage.readJSON('sessions', 2 * 1024 * 1024).catch(async error => { await releaseOwner(); throw error; }) ?? { schema: 'zuku-agent-core/1', sessions: [], revision: 0 };
  if (state.schema !== 'zuku-agent-core/1' || !Array.isArray(state.sessions) || state.sessions.length > 128 || !Number.isSafeInteger(state.revision)) { await releaseOwner(); fail('CORE_STATE_UNSAFE'); }
  const projectsState = await storage.readJSON('projects', 1024 * 1024).catch(async error => { await releaseOwner(); throw error; }) ?? { schema: 'zuku-project-registry/1', projects: [] };
  if (projectsState.schema !== 'zuku-project-registry/1') { await releaseOwner(); fail('CORE_STATE_UNSAFE'); }
  const scope = async () => {
    if (options.scope) return options.scope;
    if (!scopePromise) scopePromise = import('../agent/scope/index.mjs').catch(() => { scopePromise = undefined; fail('TOOL_UNAVAILABLE'); });
    return scopePromise;
  };
  const classify = async input => { const module = await scope(); if (typeof module.classifyWorkspace !== 'function') fail('TOOL_UNAVAILABLE'); return module.classifyWorkspace(input); };
  const admit = async (request, classification, admissionOptions) => {
    const module = await scope(); if (typeof module.admitGameRequest !== 'function') fail('TOOL_UNAVAILABLE');
    const verdict = await module.admitGameRequest(request, classification, admissionOptions);
    if (verdict?.admitted !== true) fail('AGENT_REQUEST_OUT_OF_SCOPE');
    return verdict;
  };
  let projects;
  try { projects = createProjectRegistry({ entries: projectsState.projects, classifyWorkspace: classify, admitGameRequest: admit, save: entries => storage.writeJSON('projects', { schema: 'zuku-project-registry/1', projects: entries }) }); }
  catch (error) { await releaseOwner(); throw error; }
  let browsers;
  try { browsers = await createBrowserRegistry({ storage, projects }); } catch (error) { await releaseOwner(); throw error; }
  const persist = () => {
    const work = metadataQueue.then(() => storage.writeJSON('sessions', { schema: state.schema, revision: state.revision, sessions: [...sessions.values()] }));
    metadataQueue = work.catch(() => {}); return work;
  };
  const makeJournal = id => createJournal({ storage, sessionId: id, now, ...(options.journal ?? {}) });
  try {
    for (const saved of state.sessions) {
      if (!saved || !/^ses_[a-f0-9]{32}$/.test(saved.id) || !/^project_[a-f0-9]{32}$/.test(saved.projectHandle) || !['local', 'draft', 'yolo'].includes(saved.mode) || !Array.isArray(saved.requests) || saved.requests.length > 128 || saved.requests.some(item => !item || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || !SHA.test(item.digest))) fail('CORE_STATE_UNSAFE');
      const journal = await makeJournal(saved.id); sessions.set(saved.id, saved); journals.set(saved.id, journal);
      if (saved.state === 'running') {
        saved.state = 'interrupted'; saved.updatedAt = now().toISOString();
        await journal.append('agent.error', { code: 'CORE_NOT_RUNNING', state: 'interrupted' });
      }
    }
    await persist();
  } catch (error) { await releaseOwner(); throw error; }
  const providerRuntime = async (extra = {}) => options.providerRuntime ?? createProviderRuntime({ ...(options.providerContext ?? {}), ...Object.fromEntries(['home', 'platform', 'environment'].filter(key => options[key] !== undefined).map(key => [key, options[key]])), ...extra });
  const sessionFor = async (id, actor) => {
    const session = sessions.get(id); if (!session) fail('SESSION_NOT_FOUND');
    // Viewing/cancelling a session needs its opaque grant, not a still-existing folder.
    // File/project operations perform the stronger inode/path check separately.
    if (!actorCanAccess(actor, session.projectHandle)) fail('PERMISSION_REQUIRED'); return session;
  };
  const emit = (session, type, data) => journals.get(session.id).append(type, data);
  const change = async (type, data) => { state.revision++; await persist(); for (const session of sessions.values()) if (session.state !== 'closed') await emit(session, type, { ...data, scope: 'global', revision: state.revision }); };
  const nativeAuth = createNativeAuthController({ getRuntime: providerRuntime, openSession: options.openNativePromptSession, changed: providerId => change('provider.changed', { providerId }) });
  const tool = async (project, name, input, signal, onEvent) => {
    const module = await scope();
    if (typeof module.createScopedToolRuntime !== 'function') fail('TOOL_UNAVAILABLE');
    const classification = await classify({ cwd: project.path, signal });
    if (!['zuku', 'zukujs', 'zuku-compatible'].includes(classification.classification)) fail('AGENT_REQUEST_OUT_OF_SCOPE');
    const admission = await admit('Inspect and maintain this ZUKU game project.', classification);
    const stateful = ['patch_file', 'write_file', 'run_build', 'run_tests'].includes(name);
    let run, store, runtime;
    try {
      if (stateful) {
        const { openRun, createRunStore } = await import('../agent/scope/state.mjs');
        run = await openRun(project.path); store = createRunStore(run.dir, run.runId);
        const skills = await (options.loadSkills ?? loadSkillPack)();
        if (!SHA.test(skills?.sha256 ?? '')) fail('CORE_STATE_UNSAFE');
        await store.state({ status: 'running', intent: 'host-tool', tool: name, skill_pack_sha256: skills.sha256 });
      }
      runtime = await module.createScopedToolRuntime({ ...(options.toolContext ?? {}), cwd: project.path, classification, admission, signal, onEvent, store });
      let result;
      if (typeof runtime.execute === 'function') result = await runtime.execute(name, input);
      else fail('TOOL_UNAVAILABLE');
      if (store) {
        await store.diff(runtime.journal.diff());
        await store.state({ status: 'completed', intent: 'host-tool', tool: name, changes: runtime.journal.summary(), receipt_head: store.receiptHead });
      }
      return result;
    } catch (error) {
      if (store && runtime) {
        await store.diff(runtime.journal.diff()).catch(() => {});
        const rollback = await runtime.journal.rollback().catch(() => ({ restored: [], conflicts: ['*'] }));
        await store.state({ status: 'failed', intent: 'host-tool', tool: name, code: safeError(error).code, rollback }).catch(() => {});
      }
      throw error;
    } finally { await runtime?.close?.(); await run?.release(); }
  };
  const createPreview = async (project, signal) => {
    await projects.get(project.id, { kind: 'native', id: 'core_preview' });
    const { snapshotProject } = await import('../agent/project.mjs');
    const current = await snapshotProject(project.path, signal);
    const existing = [...previews.values()].find(value => value.projectHandle === project.id);
    if (existing) { existing.files = current.files; existing.entry = current.entry; existing.sourceSha256 = current.srcDigest; existing.version++; return { previewHandle: existing.id, version: existing.version, entry: current.entry, sourceSha256: current.srcDigest }; }
    if (previews.size >= 16) fail('PROJECT_LIMIT');
    const id = randomId('preview_');
    previews.set(id, { id, projectHandle: project.id, files: current.files, entry: current.entry, sourceSha256: current.srcDigest, version: 1 });
    return { previewHandle: id, version: 1, entry: current.entry, sourceSha256: current.srcDigest };
  };
  const publicEvent = (session, project, event) => {
    if (!event || typeof event !== 'object' || event.type === 'reasoning-delta' || event.type === 'reasoning_delta') return Promise.resolve();
    if (event.type === 'stage') {
      if (!phases[event.stage]) return Promise.resolve();
      return emit(session, 'agent.reasoning_status', { phase: event.status === 'repair' ? 'repairing' : phases[event.stage] });
    }
    if (!Object.hasOwn(EVENTS, event.type)) return Promise.resolve();
    const data = event.data ?? {};
    // Never accept model-supplied completion or observed build/verification claims.
    if (!['tool.requested', 'tool.started', 'tool.completed', 'tool.failed', 'build.started', 'build.output', 'build.completed', 'game.started', 'game.stopped', 'preview.started', 'preview.updated'].includes(event.type)) return Promise.resolve();
    const admittedKeys = new Set([...Object.keys(EVENTS[event.type][0]), ...Object.keys(EVENTS[event.type][1])]);
    const safe = Object.fromEntries(Object.entries(data).filter(([key]) => admittedKeys.has(key)));
    for (const key of ['text', 'content']) if (typeof data[key] === 'string') safe[key === 'content' ? 'text' : key] = sanitizeText(data[key], { roots: projects.roots() });
    // Explicit schemas, not the transport's broader result projection, determine persisted data.
    try { validateEvent({ protocolVersion: 1, sessionId: session.id, sequence: 1, eventId: 'evt_validate', time: now().toISOString(), type: event.type, data: safe }); }
    catch { fail('INVALID_INPUT'); }
    return emit(session, event.type, safe);
  };
  const execute = async (session, project, params, controller, provider, skills, browserGrant) => {
    let sink = Promise.resolve(), sinkError, pendingText = '', block = randomId('block_');
    const append = (type, data) => {
      const work = sink.then(() => emit(session, type, data));
      sink = work.catch(error => { sinkError = error; controller.abort(); }); return work;
    };
    const visible = async (text, flush = false) => {
      pendingText += typeof text === 'string' ? text : '';
      if (pendingText.length > 65536) fail('BODY_TOO_LARGE');
      pendingText = sanitizeText(pendingText, { roots: projects.roots() });
      const count = flush ? pendingText.length : Math.max(0, pendingText.length - 4096);
      if (!count) return;
      let safe = sanitizeText(pendingText.slice(0, count), { roots: projects.roots() }); pendingText = pendingText.slice(count);
      // Chunk at code-point boundaries; each encoded record stays <=8 KiB.
      let chunk = '', bytes = 0;
      for (const char of safe) { const length = Buffer.byteLength(char); if (bytes + length > 8192) { await append('agent.delta', { text: chunk, blockId: block }); chunk = ''; bytes = 0; } chunk += char; bytes += length; }
      if (chunk) await append('agent.delta', { text: chunk, blockId: block });
    };
    const providerEvents = async event => {
      if (event?.type === 'text-delta') await visible(event.text);
      // Reasoning, tool-call arguments, raw response metadata and credentials are never journaled.
      if (event?.type === 'finish') await visible('', true);
    };
    const hostEvents = event => {
      const work = sink.then(() => publicEvent(session, project, event));
      sink = work.catch(error => { sinkError = error; controller.abort(); }); return work;
    };
    try {
      const context = { ...(options.agentContext ?? {}), cwd: project.path, signal: controller.signal, quiet: true, onEvent: hostEvents, onProviderEvent: providerEvents };
      if (browserGrant) {
        const runner = createBrowserPlaytest({ browserPath: browserGrant.path, validateBrowser: () => browsers.get(browserGrant.id, project.id, { kind: 'native', id: 'core_browser' }), onEvent: hostEvents });
        context.playtest = params.operation === 'game.init' || params.resume ? runner : async ({ snapshot, signal }) => {
          const observations = await runner.run({ snapshot, signal });
          const verdict = evaluateBrowserSmoke(observations);
          return { passed: verdict.passed, thumbnail: observations.thumbnail, observations: { kind: 'browser', browser: observations.browser, checks: 'load/render/input smoke', failures: verdict.failures, metrics: verdict.metrics } };
        };
      }
      if (provider) context.provider = Object.freeze({ ...provider,
        async runStage(request) { const result = await provider.runStage({ ...request, onEvent: providerEvents }); await visible('', true); return result; },
        ...(typeof provider.stream === 'function' ? { async *stream(request) {
          for await (const event of provider.stream(request)) {
            if (event?.type === 'reasoning-delta') continue;
            await providerEvents(event); yield event;
          }
          await visible('', true);
        } } : {}),
      });
      let result;
      if (typeof options.operationRunner === 'function') result = await options.operationRunner({ params, project: { ...project }, provider: context.provider, skills }, context);
      else if (params.operation === 'game.init' || params.resume) {
        const { runGameAgent, resumeGameAgent } = await import('../agent/orchestrator.mjs');
        const agentOptions = { request: params.request, model: provider?.model ?? params.modelAddress, mode: session.mode, ...(params.name ? { name: params.name } : {}), ...(params.resume ? { resume: params.resume } : {}) };
        result = await (params.resume ? resumeGameAgent : runGameAgent)(agentOptions, context);
      } else if (params.operation === 'game.maintain') {
        const module = await scope(); if (typeof module.runScopedGameAgent !== 'function') fail('TOOL_UNAVAILABLE');
        result = await module.runScopedGameAgent({ cwd: project.path, request: params.request, mode: session.mode, yolo: session.mode === 'yolo', forceCreate: false, model: provider?.model ?? params.modelAddress }, context);
        if (result?.handled === false) fail('AGENT_REQUEST_OUT_OF_SCOPE');
      } else if (params.operation === 'game.build' || params.operation === 'game.test') {
        result = await tool(project, params.operation === 'game.build' ? 'run_build' : 'run_tests', {}, controller.signal, hostEvents);
      } else if (params.operation === 'game.stop') { if (typeof options.stopGame !== 'function') fail('TOOL_UNAVAILABLE'); result = { status: 'completed', ...(await options.stopGame({ projectHandle: project.id, signal: controller.signal })) }; }
      else result = await createPreview(project, controller.signal);
      if (result?.previewHandle && Number.isSafeInteger(result.version)) await append('preview.started', { previewHandle: result.previewHandle, version: result.version });
      await visible('', true); await sink;
      if (sinkError) throw sinkError;
      const published = result?.published === true;
      if (controller.signal.aborted && !published) fail('COMMAND_CANCELLED');
      const safe = safeResult(result);
      let evidence;
      if (options.verifyResult) evidence = await options.verifyResult(result, { project, params, skills });
      else {
        const module = await scope();
        if (typeof module.verifyScopedResult === 'function') evidence = await module.verifyScopedResult(result, { skills });
        if (!evidence) evidence = await verifyLegacyResult(result, project, skills).catch(() => undefined);
      }
      if (evidence?.verified === true && evidence.digests && Object.values(evidence.digests).every(value => SHA.test(value)) && Array.isArray(evidence.evidenceIds) && evidence.evidenceIds.length <= 64 && evidence.evidenceIds.every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))) Object.assign(safe, { verified: true, digests: evidence.digests, evidenceIds: evidence.evidenceIds });
      session.state = 'completed'; session.result = safe; session.runId = safe.runId; session.updatedAt = now().toISOString();
      await persist(); await emit(session, 'agent.completed', safe);
    } catch (error) {
      await sink;
      const failure = safeError(sinkError ?? (controller.signal.aborted ? { code: 'COMMAND_CANCELLED' } : error));
      session.state = failure.code === 'COMMAND_CANCELLED' ? closed ? 'interrupted' : 'cancelled' : failure.action === 'login' ? 'needs_auth' : 'failed';
      session.updatedAt = now().toISOString(); session.result = { status: session.state, code: failure.code };
      await persist(); await emit(session, failure.code === 'COMMAND_CANCELLED' ? 'agent.cancelled' : 'agent.error', { code: failure.code, state: session.state, ...(failure.action ? { action: failure.action } : {}) });
    } finally { runs.delete(session.id); projectJobs.delete(project.id); }
  };
  const admitInput = async (params, actor) => {
    const session = await sessionFor(params.sessionId, actor), journal = journals.get(session.id), project = await projects.get(session.projectHandle, actor);
    const browserGrant = params.browserHandle ? await browsers.get(params.browserHandle, project.id, actor) : undefined;
    if (browserGrant && !['game.init', 'game.maintain'].includes(params.operation)) fail('INVALID_INPUT');
    const digest = hash(params), previous = session.requests.find(value => value.id === params.requestId);
    if (previous) { if (previous.digest !== digest) fail('REQUEST_CONFLICT'); return { accepted: true, sessionId: session.id, requestId: previous.id, state: session.state, sequence: journal.sequence }; }
    if (session.state === 'closed') fail('SESSION_NOT_FOUND');
    if (runs.has(session.id) || projectJobs.has(project.id)) fail('SESSION_BUSY');
    if (session.requests.length >= 128) fail('REQUEST_LIMIT');
    // Purpose and real workspace validation happen before provider discovery/inference.
    const classification = await classify({ cwd: project.path, request: params.request }); await admit(params.request, classification, { forceCreate: params.operation === 'game.init' });
    if (params.operation === 'game.init' && project.purpose !== 'game.init') fail('PERMISSION_REQUIRED');
    const skills = await (options.loadSkills ?? loadSkillPack)();
    if (!skills || !SHA.test(skills.sha256)) fail('CORE_STATE_UNSAFE');
    const controller = new AbortController(); let provider;
    if (['game.init', 'game.maintain'].includes(params.operation) && !params.resume) {
      const runtime = await providerRuntime();
      provider = await runtime.resolveStageProvider({ model: params.modelAddress ?? session.modelAddress, signal: controller.signal });
      if (provider.authMethod?.experimental === true && params.experimental !== true) fail('AUTH_EXPERIMENTAL_OPT_IN');
    }
    session.requests.push({ id: params.requestId, digest }); session.requestId = params.requestId; session.state = 'running'; session.updatedAt = now().toISOString(); session.result = undefined;
    await persist();
    await emit(session, 'agent.started', { operation: params.operation, requestId: params.requestId, ...(provider?.model ? { modelAddress: provider.model } : {}), ...(provider?.authMethod ? { authMethod: { id: provider.authMethod.id, official: provider.authMethod.official, experimental: provider.authMethod.experimental } } : {}), skillSha256: skills.sha256 });
    await emit(session, 'agent.reasoning_status', { phase: 'analyzing' });
    projectJobs.set(project.id, session.id);
    const execution = Promise.resolve().then(() => execute(session, project, params, controller, provider, skills, browserGrant));
    runs.set(session.id, { controller, execution });
    execution.catch(() => { /* journal/storage failure is not converted into fabricated success */ });
    return { accepted: true, sessionId: session.id, requestId: params.requestId, state: 'running', sequence: journal.sequence };
  };
  const handle = async (envelope, actor) => {
    const { method, params } = envelope;
    if (method === 'hello') return { product: 'zuku-agent-core', protocolVersion: 1, cliVersion, agentVersion: cliVersion, status: 'ready', capabilities: [PROVIDER_CONFIG_CAPABILITY, PROVIDER_HEADER_AUTH_CAPABILITY, BROWSER_GRANT_CAPABILITY] };
    if (method === 'project.list') return { projects: projects.list(actor) };
    if (method === 'project.grant') return projects.grant(params, actor);
    if (method === 'browser.grant') return browsers.grant(params, actor);
    if (['project.read', 'project.patch', 'project.search'].includes(method)) {
      const project = await projects.get(params.projectHandle, actor);
      if (method === 'project.patch' && projectJobs.has(project.id)) fail('SESSION_BUSY');
      return tool(project, { 'project.read': 'read_file', 'project.patch': 'patch_file', 'project.search': 'search_project' }[method], Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'projectHandle')));
    }
    if (method === 'session.create') {
      const project = await projects.get(params.projectHandle, actor); if (sessions.size >= 128) fail('SESSION_LIMIT');
      const id = randomId('ses_'), time = now().toISOString();
      const session = { id, projectHandle: project.id, state: 'idle', mode: params.mode ?? 'local', ...(params.modelAddress ? { modelAddress: params.modelAddress } : {}), requests: [], createdAt: time, updatedAt: time };
      const journal = await makeJournal(id); sessions.set(id, session); journals.set(id, journal);
      await persist(); await emit(session, 'session.created', { projectHandle: project.id, state: 'idle' }); return snapshot(session, journal);
    }
    if (method === 'session.list') {
      if (params.projectHandle) await projects.get(params.projectHandle, actor);
      return { sessions: [...sessions.values()].filter(session => actorCanAccess(actor, session.projectHandle) && (!params.projectHandle || params.projectHandle === session.projectHandle)).map(session => snapshot(session, journals.get(session.id))) };
    }
    if (method === 'session.get') { const session = await sessionFor(params.sessionId, actor); return snapshot(session, journals.get(session.id)); }
    if (method === 'session.input') return admitInput(params, actor);
    if (method === 'session.cancel') {
      const session = await sessionFor(params.sessionId, actor);
      if (params.requestId && params.requestId !== session.requestId) fail('REQUEST_CONFLICT');
      const run = runs.get(session.id); run?.controller.abort();
      return { sessionId: session.id, cancelled: Boolean(run), state: session.state };
    }
    if (method === 'session.close') {
      const session = await sessionFor(params.sessionId, actor); if (runs.has(session.id)) fail('SESSION_BUSY');
      if (session.state !== 'closed') { session.state = 'closed'; session.updatedAt = now().toISOString(); await persist(); await emit(session, 'session.closed', { projectHandle: session.projectHandle, state: 'closed' }); }
      return { sessionId: session.id, closed: true };
    }
    if (method.startsWith('provider.') || method.startsWith('model.') || method.startsWith('auth.')) {
      const runtime = await providerRuntime(); let result;
      if (method === 'provider.list') return { providers: await runtime.listProviders(), activeProvider: runtime.activeProvider, activeModel: runtime.activeModel, revision: state.revision };
      if (method === 'provider.use') { result = await runtime.useProvider(params.providerId); await change('provider.changed', { providerId: params.providerId, ...(result.model ? { modelAddress: result.model } : {}) }); }
      if (method === 'provider.add') result = await runtime.addProvider(params.config);
      if (method === 'provider.configure') result = await runtime.configureProvider(params.providerId, params.patch);
      if (method === 'provider.remove') result = await runtime.removeProvider(params.providerId);
      if (method === 'provider.enable' || method === 'provider.disable') result = await runtime.setEnabled(params.providerId, method === 'provider.enable');
      if (method === 'model.list') return { models: await runtime.listModels({ provider: params.providerId, refresh: params.refresh }) };
      if (method === 'model.info') { const info = await runtime.modelInfo(params.modelAddress, { refresh: params.refresh }); if (!info) fail('MODEL_NOT_FOUND'); return info; }
      if (method === 'model.use') { result = await runtime.useModel(params.modelAddress); await change('model.changed', { modelAddress: params.modelAddress }); }
      if (method === 'auth.list') return { auth: await runtime.authList(), requests: nativeAuth.list(actor), revision: state.revision };
      if (method === 'auth.request') {
        if (typeof options.openNativePromptSession === 'function') return nativeAuth.start(params, actor, { requestId: envelope.id });
        if (typeof options.requestNativeAuth === 'function') return options.requestNativeAuth({ ...params, actor: { id: actor.id, kind: actor.kind } });
        fail('NATIVE_PERMISSION_REQUIRED');
      }
      if (method === 'auth.logout') {
        if (actor.kind !== 'native') {
          if (typeof options.openNativePromptSession === 'function') return nativeAuth.start(params, actor, { requestId: envelope.id, action: 'logout' });
          if (typeof options.approveAuthLogout !== 'function' || await options.approveAuthLogout({ providerId: params.providerId, actor: { id: actor.id, kind: actor.kind } }) !== true) fail('NATIVE_PERMISSION_REQUIRED');
        }
        result = await runtime.authLogout(params.providerId);
        await change('provider.changed', { providerId: params.providerId });
      }
      if (result === undefined) fail('TOOL_UNAVAILABLE');
      if (['provider.add', 'provider.configure', 'provider.remove', 'provider.enable', 'provider.disable'].includes(method)) await change('provider.changed', { providerId: params.providerId ?? params.config.id });
      return result;
    }
    if (['game.run', 'game.stop', 'game.preview'].includes(method)) {
      const project = await projects.get(params.projectHandle, actor);
      if (method === 'game.stop') { if (typeof options.stopGame !== 'function') fail('TOOL_UNAVAILABLE'); return options.stopGame({ projectHandle: project.id }); }
      return createPreview(project);
    }
    if (method === 'preview.info') {
      const preview = previews.get(params.previewHandle); if (!preview) fail('PROJECT_NOT_FOUND');
      await projects.get(preview.projectHandle, actor);
      return { previewHandle: preview.id, version: preview.version, entry: preview.entry, sourceSha256: preview.sourceSha256 };
    }
    if (method === 'preview.read') {
      const preview = previews.get(params.previewHandle); if (!preview) fail('PROJECT_NOT_FOUND');
      await projects.get(preview.projectHandle, actor);
      const bytes = preview.files.get(params.path), offset = params.offset ?? 0, length = params.length ?? 49152;
      if (!bytes || offset > bytes.length) fail('INVALID_INPUT');
      const chunk = bytes.subarray(offset, offset + length);
      return { previewHandle: preview.id, path: params.path, bytes: bytes.length, offset, length: chunk.length, complete: offset + chunk.length === bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), encoding: 'base64', data: Buffer.from(chunk).toString('base64'), version: preview.version };
    }
    if (method === 'studio.open') { if (params.projectHandle) await projects.get(params.projectHandle, actor); if (typeof options.openStudio !== 'function') fail('STUDIO_NOT_RUNNING'); return options.openStudio(params); }
    fail('TOOL_UNAVAILABLE');
  };
  return Object.freeze({
    stateDir: storage.dir,
    async dispatch(envelope, actor) {
      let id = typeof envelope?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(envelope.id) ? envelope.id : 'invalid';
      try {
        if (closed) fail('CORE_CLOSED'); validateActor(actor); validateRequest(envelope, { native: actor.kind === 'native' });
        const work = dispatchQueue.then(async () => { if (closed) fail('CORE_CLOSED'); return handle(envelope, actor); });
        dispatchQueue = work.catch(() => {});
        const result = projectPublicResult(await work, { roots: projects.roots() });
        if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) fail('BODY_TOO_LARGE');
        return { protocolVersion: 1, id, result };
      } catch (error) { return { protocolVersion: 1, id, error: safeError(error) }; }
    },
    async *subscribe({ sessionId, afterSequence = 0, signal } = {}, actor) {
      if (closed) fail('CORE_CLOSED'); validateActor(actor); await sessionFor(sessionId, actor);
      const iterator = journals.get(sessionId).subscribe({ afterSequence, signal });
      try { for await (const event of iterator) { validateActor(actor); if (!actorCanAccess(actor, sessions.get(sessionId).projectHandle)) fail('PERMISSION_REQUIRED'); yield event; } }
      finally { await iterator.return(); }
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await nativeAuth.close();
        await dispatchQueue;
        for (const run of runs.values()) run.controller.abort();
        let timer;
        try { await Promise.race([Promise.allSettled([...runs.values()].map(run => run.execution)), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); }
        finally { clearTimeout(timer); }
        for (const session of sessions.values()) if (session.state === 'running') { session.state = 'interrupted'; session.updatedAt = now().toISOString(); await emit(session, 'agent.error', { code: 'CORE_NOT_RUNNING', state: 'interrupted' }); }
        await persist(); await Promise.all([...journals.values()].map(journal => journal.close())); await metadataQueue; await releaseOwner();
      })(); return closing;
    },
  });
}

export { createCoreClient } from './client.mjs';
export { startCoreHost } from './host.mjs';
export { createStudioHostContext } from '../studio-context.mjs';
