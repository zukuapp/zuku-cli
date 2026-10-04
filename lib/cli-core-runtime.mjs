import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CommandError } from './errors.mjs';
import { ProviderError, PROVIDER_ERROR_CODES } from './provider-system/errors.mjs';
import { AgentError, isAgentCode } from './agent/errors.mjs';
import { createCoreClient } from './agent-core/client.mjs';
import { PROTOCOL_VERSION, ProtocolError, validateRequest } from './agent-protocol/index.mjs';
import { experimentalIndicator } from './experimental.mjs';
import { BUILTIN_AUTH_METHODS } from './provider-system/auth-registry.mjs';
import { DEFAULT_MODEL_ADDRESS } from './provider-system/catalog.mjs';
import { parseModelAddress } from './provider-system/address.mjs';

// Thin native transport + projection for CLI front doors. It owns no agent loop,
// session store, provider configuration or credential store: every decision is
// the one Agent Core's (and its original ProviderRuntime's) decision.

const MESSAGES = Object.freeze({
  CORE_NOT_RUNNING: 'ZUKU Agent Core를 시작하거나 연결하지 못했습니다. zuku doctor로 상태를 확인하세요.',
  CORE_STATE_UNSAFE: 'Agent Core 상태 디렉터리가 안전하지 않습니다(현재 사용자 전용 0700, 링크 금지).',
  CORE_ALREADY_RUNNING: '다른 Agent Core가 같은 상태 디렉터리를 사용 중입니다.',
  CORE_AUTH_REQUIRED: 'Agent Core 로컬 연결 인증에 실패했습니다.',
  CORE_UNAVAILABLE: 'Agent Core가 응답하지 않습니다. 잠시 후 다시 시도하세요.',
  CORE_CLOSED: 'Agent Core 연결이 닫혔습니다.',
  CORE_OPERATION_FAILED: 'Agent Core가 작업을 완료하지 못했습니다.',
  PROTOCOL_MISMATCH: 'CLI와 Agent Core 프로토콜 버전이 다릅니다. 같은 설치본으로 업데이트하세요.',
  BODY_TOO_LARGE: '요청 또는 응답이 허용 크기를 넘었습니다.',
  PERMISSION_REQUIRED: '이 프로젝트나 세션에 대한 로컬 권한이 필요합니다.',
  NATIVE_PERMISSION_REQUIRED: '이 작업은 이 컴퓨터의 네이티브 CLI·Studio 확인이 필요합니다.',
  PROJECT_NOT_FOUND: 'Agent Core에 등록된 프로젝트를 찾지 못했습니다.',
  PROJECT_CHANGED: '프로젝트 폴더가 바뀌었거나 현재 사용자 전용(그룹·기타 쓰기 금지) 일반 디렉터리가 아닙니다.',
  PROJECT_LIMIT: '등록할 수 있는 프로젝트 수를 넘었습니다.',
  SESSION_NOT_FOUND: '세션을 찾지 못했습니다.',
  SESSION_BUSY: '이 프로젝트에서 다른 작업이 진행 중입니다. 끝난 뒤 다시 실행하세요.',
  SESSION_LIMIT: 'Agent Core 세션 한도를 넘었습니다.',
  REQUEST_CONFLICT: '같은 요청 ID로 다른 요청이 이미 접수되었습니다.',
  REQUEST_LIMIT: '요청 한도를 넘었습니다.',
  CURSOR_EXPIRED: '이벤트 기록 일부가 이미 정리되었습니다.',
  INVALID_CURSOR: '이벤트 순서가 올바르지 않습니다.',
  SLOW_SUBSCRIBER: '이벤트를 제때 읽지 못해 구독이 끊겼습니다.',
  TOOL_UNAVAILABLE: '이 설치본에서 요청한 Agent Core 도구를 사용할 수 없습니다.',
  STUDIO_NOT_RUNNING: 'ZUKU Studio가 실행 중이 아닙니다.',
  AUTH_BUSY: '다른 인증 요청이 진행 중입니다.',
  AUTH_PROMPT_TIMEOUT: '인증 입력 시간이 지났습니다. 다시 실행하세요.',
  NATIVE_PROMPTER_BUSY: '다른 CLI 또는 ZUKU Studio가 인증 입력 창을 사용 중입니다. 그 창을 닫고 다시 실행하세요.',
  EXPERIMENTAL_REQUIRED: 'Experimental·비공식 기능은 --experimental을 명시해야 합니다.',
  OPERATION_UNAVAILABLE: '이 작업은 현재 사용할 수 없습니다.',
  AGENT_REQUEST_OUT_OF_SCOPE: 'This agent is restricted to ZUKU/ZUKUJS game-development tasks.',
  CORE_PROTOCOL_GAP: '이 옵션은 현재 Agent Core 프로토콜(zuku-agent/1)로 전달할 수 없어 실행하지 않았습니다. docs/unified-cli.md의 호환성 항목을 확인하세요.',
  PROVIDER_OPTION_UNSUPPORTED: '이 어댑터 옵션은 현재 제공자 설정 저장소가 보존하지 않아 적용하지 않았습니다. docs/unified-cli.md를 확인하세요.',
});

export class CoreCliError extends CommandError {
  constructor(code, { action, retryAfterMs } = {}) {
    super('COMMAND_FAILED');
    const known = Object.hasOwn(MESSAGES, code) ? code : 'CORE_OPERATION_FAILED';
    this.code = known; this.message = MESSAGES[known]; this.name = 'ZukuCoreCliError';
    if (typeof action === 'string' && /^[a-z_]{1,32}$/.test(action)) this.action = action;
    if (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs = retryAfterMs;
  }
  toJSON() { return { ...super.toJSON(), ...(this.action ? { action: this.action } : {}), ...(this.retryAfterMs !== undefined ? { retry_after_ms: this.retryAfterMs } : {}) }; }
}

/** Maps a Core/protocol failure onto the CLI's fixed-message error families. */
export function cliError(error) {
  if (error instanceof CommandError) return error;
  const code = typeof error?.code === 'string' ? error.code : undefined;
  if (code === 'COMMAND_CANCELLED' || error?.name === 'AbortError') return new CommandError('COMMAND_CANCELLED');
  if (code === 'INVALID_INPUT') return new CommandError('INVALID_INPUT');
  const extras = { action: error?.action, retryAfterMs: error?.retryAfterMs };
  if (code && isAgentCode(code)) return new AgentError(code, { ...(extras.action ? { action: extras.action } : {}), ...(extras.retryAfterMs !== undefined ? { retry_after_ms: extras.retryAfterMs } : {}) });
  if (code && PROVIDER_ERROR_CODES.includes(code)) { const out = new ProviderError(code); if (extras.action) out.action = extras.action; return out; }
  return new CoreCliError(code, extras);
}
export const protocolGap = () => new CoreCliError('CORE_PROTOCOL_GAP');

/**
 * `<provider>/<model>` normalization (first slash splits). `auto` is the native ZUKU
 * router; a bare model ID binds to the explicitly given or currently active provider.
 * Never substitutes another (paid) provider.
 */
export function normalizeModelAddress(value, { provider } = {}) {
  if (typeof value !== 'string' || !value) throw new ProviderError('MODEL_ADDRESS_INVALID');
  if (value === 'auto' && !provider) return DEFAULT_MODEL_ADDRESS;
  if (value.includes('/') && provider && !value.startsWith(`${provider}/`)) throw new CommandError('INVALID_INPUT');
  const address = value.includes('/') ? value : provider ? `${provider}/${value}` : undefined;
  if (!address) throw new ProviderError('MODEL_ADDRESS_INVALID');
  return parseModelAddress(address).address;
}

const opaque = prefix => `${prefix}${randomBytes(16).toString('hex')}`;
const pause = (ms, signal) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});
export const ECOSYSTEM = Object.freeze(['zuku', 'zukujs', 'zuku-compatible']);
export const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'interrupted', 'closed', 'needs_auth', 'needs_local_permission']);

/**
 * Attaches (or autostarts) the per-user Core as a native actor. `ctx.coreClient` is an
 * already-connected client owned by the caller; `ctx.core` is createCoreClient context.
 * Closing this handle only detaches: it never cancels a Core session.
 */
export async function openCore(ctx = {}) {
  let client;
  try { client = ctx.coreClient ?? await createCoreClient({ ...(ctx.core ?? {}), signal: ctx.signal }); } catch (error) { throw cliError(error); }
  const owned = !ctx.coreClient;
  let closed = false;
  return Object.freeze({
    stateDir: client.stateDir,
    async call(method, params = {}) {
      if (closed) throw new CoreCliError('CORE_CLOSED');
      const envelope = { protocolVersion: PROTOCOL_VERSION, id: opaque('cli_'), method, params };
      try {
        validateRequest(envelope, { native: true });
        const response = await client.dispatch(envelope);
        if (!response || response.protocolVersion !== PROTOCOL_VERSION || response.id !== envelope.id) throw new ProtocolError('PROTOCOL_MISMATCH');
        if (response.error) throw Object.assign(new ProtocolError(response.error.code), response.error);
        return response.result;
      } catch (error) { throw cliError(error); }
    },
    subscribe(params) { return client.subscribe(params); },
    attachNativePrompter(callback) { return client.attachNativePrompter(callback).catch(error => { throw cliError(error); }); },
    client,
    close() { if (closed) return; closed = true; if (owned) client.close(); },
  });
}

// ---------------------------------------------------------------------------
// Provider/model/auth: original ProviderRuntime method API over Core dispatch.
// ---------------------------------------------------------------------------

// The protocol accepts the legacy wire spelling; the runtime normalizes it back.
const WIRE_API_TYPE = Object.freeze({ 'openai-chat': 'openai-chat', 'openai-responses': 'openai-responses', anthropic: 'anthropic-messages' });
const CORE_OPTION_KEYS = Object.freeze(['region', 'location']);
function wireApiType(value) {
  if (value === undefined) return undefined;
  const wire = WIRE_API_TYPE[value];
  if (!wire) throw new ProviderError('PROVIDER_CONFIG_INVALID');
  return wire;
}
function wirePatch(patch = {}) {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'apiType') out.apiType = wireApiType(value);
    else if (['baseUrl', 'name', 'defaultModel', 'addModels', 'removeModels'].includes(key)) out[key] = value;
    else if (key === 'apiKeyEnv') { if (value === null) throw protocolGap(); out.apiKeyEnv = value; }
    else if (key === 'options') {
      if (Object.entries(value).some(([name, item]) => !CORE_OPTION_KEYS.includes(name) || typeof item !== 'string')) throw protocolGap();
      out.options = { ...value };
    } else throw protocolGap(); // headers and other runtime-only fields
  }
  return out;
}

const SECURE_METHODS = new Set(BUILTIN_AUTH_METHODS.filter(item => item.storage === 'secure-store').map(item => item.id));
const DELEGATED_METHODS = new Set([...BUILTIN_AUTH_METHODS.filter(item => item.delegate).map(item => item.id), 'codex-oauth']);
const ENV_METHODS = new Set(BUILTIN_AUTH_METHODS.filter(item => item.storage === 'environment').map(item => item.id));
/** Storage class of a projected auth method, from the registry's own metadata. */
export function methodKind(method) {
  if (DELEGATED_METHODS.has(method?.id)) return 'delegate';
  if (SECURE_METHODS.has(method?.id)) return 'secret';
  if (ENV_METHODS.has(method?.id)) return 'environment';
  return 'passive';
}

/**
 * Legacy library/test seam: an explicitly injected runtime or provider context keeps the
 * historical direct ProviderRuntime. Production (no injection) attaches the one Core.
 */
export async function providerRuntimeFor(ctx = {}) {
  if (ctx.providerRuntime || ctx.providerContext || ctx.home || ctx.environment) {
    const { runtimeFor } = await import('./provider-system/command-context.mjs');
    return { runtime: await runtimeFor(ctx), close() {} };
  }
  const core = ctx.coreHandle ?? await openCore(ctx);
  try { return { runtime: await createCoreProviderRuntime(core), close: () => { if (!ctx.coreHandle) core.close(); } }; }
  catch (error) { if (!ctx.coreHandle) core.close(); throw error; }
}

/** Returns an object with the ProviderRuntime methods the provider/model/auth commands use. */
export async function createCoreProviderRuntime(core) {
  let snapshot = await core.call('provider.list');
  const rows = () => snapshot.providers ?? [];
  const refresh = async () => { snapshot = await core.call('provider.list'); };
  const find = id => { const row = rows().find(item => item.id === id); if (!row) throw new ProviderError('PROVIDER_NOT_FOUND'); return row; };
  const mutate = async (method, params) => { const result = await core.call(method, params); await refresh(); return result; };
  return {
    core,
    experimental: undefined,
    checkPatch(patch) { wirePatch(patch); },
    get activeProvider() { return snapshot.activeProvider; },
    get activeModel() { return snapshot.activeModel; },
    providers: Object.freeze({ get: find, has: id => rows().some(item => item.id === id), authMethods: id => find(id).authMethods ?? [] }),
    async listProviders() { await refresh(); return rows(); },
    useProvider: id => mutate('provider.use', { providerId: id }),
    async addProvider({ id, name, apiType, baseUrl, model, apiKeyEnv, headers, enabled } = {}) {
      if (headers !== undefined) throw protocolGap();
      const config = { id, apiType: wireApiType(apiType), baseUrl, ...(name !== undefined ? { name } : {}), ...(model !== undefined ? { model } : {}), ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}), ...(enabled !== undefined ? { enabled } : {}) };
      return mutate('provider.add', { config });
    },
    configureProvider: (id, patch) => mutate('provider.configure', { providerId: id, patch: wirePatch(patch) }),
    removeProvider: id => mutate('provider.remove', { providerId: id }),
    setEnabled: (id, enabled) => mutate(enabled ? 'provider.enable' : 'provider.disable', { providerId: id }),
    async listModels({ provider, refresh: again = false } = {}) { return (await core.call('model.list', { ...(provider ? { providerId: provider } : {}), ...(again ? { refresh: true } : {}) })).models; },
    useModel: address => mutate('model.use', { modelAddress: address }),
    modelInfo: (address, { refresh: again = false } = {}) => core.call('model.info', { modelAddress: address, ...(again ? { refresh: true } : {}) }),
    async authList() { return (await core.call('auth.list')).auth; },
    authLogout: id => mutate('auth.logout', { providerId: id }),
  };
}

// ---------------------------------------------------------------------------
// Native auth prompter: secrets are collected only in this process and sent on
// the native-only sideband; they never enter Core results, events or logs.
// ---------------------------------------------------------------------------

async function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
}
export function authLabel(prompt, { stream, environment = process.env } = {}) {
  const marker = experimentalIndicator({ experimental: prompt.experimental === true }, { stream, environment });
  return `${prompt.title}${marker ? ` ${marker}` : ''}`;
}

/**
 * Builds a callback for attachNativePrompter. `secret(prompt, {signal})` resolves the hidden
 * value (askSecret/readSecretFromStdin in the caller's closure); `decide(prompt)` answers
 * approval prompts. Failures are kept in `state.error` and the prompt is cancelled.
 */
export function createNativePrompter({ stderr = process.stderr, environment = process.env, secret, decide, noBrowser = false, open = openBrowser } = {}) {
  const state = { error: undefined, kinds: [] };
  const callback = async (prompt, { signal } = {}) => {
    state.kinds.push(prompt.kind);
    try {
      if (prompt.kind === 'secret') {
        if (typeof secret !== 'function') throw new ProviderError('AUTH_INPUT_REQUIRED');
        stderr.write(`${authLabel(prompt, { stream: stderr, environment })}\n`);
        return { value: await secret(prompt, { signal }) };
      }
      if (prompt.kind === 'device-authorization') {
        // Same notice as the original `login zuku`; device/bearer tokens never reach this process.
        stderr.write(`ZUKU 계정 연결: ${prompt.url}\n승인 코드: ${prompt.userCode}\n`);
        if (!noBrowser) await open(prompt.url).catch(() => {});
        return { acknowledged: true };
      }
      if (prompt.kind === 'authorization-url') {
        stderr.write(`${authLabel(prompt, { stream: stderr, environment })}: Experimental · 비공식 연결입니다.\n브라우저에서 Continue with ChatGPT를 진행하세요:\n${prompt.url}\n`);
        return { acknowledged: true };
      }
      if (prompt.kind === 'decision') return { approved: typeof decide === 'function' ? (await decide(prompt, { signal })) === true : false };
      return { cancelled: true };
    } catch (error) { state.error ??= cliError(error); return { cancelled: true }; }
  };
  return { callback, state };
}

/**
 * auth.request + bounded asynchronous auth.list polling. Ctrl-C detaches the prompter,
 * which makes Core cancel the job before anything is persisted.
 */
export async function requestAuth(core, { providerId, methodId, experimental = false, prompter, signal, timeoutMs = 16 * 60 * 1000, intervalMs = 200 } = {}) {
  const detach = await core.attachNativePrompter(prompter.callback);
  let accepted;
  try {
    if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
    accepted = await core.call('auth.request', { providerId, ...(methodId ? { methodId } : {}), ...(experimental ? { experimental: true } : {}) });
    const deadline = Date.now() + timeoutMs;
    let job = accepted;
    while (job.status === 'running') {
      if (signal?.aborted) { await detach(); break; }
      if (Date.now() > deadline) { await detach(); throw new CoreCliError('AUTH_PROMPT_TIMEOUT'); }
      await pause(intervalMs, signal);
      const listing = await core.call('auth.list');
      job = listing.requests.find(item => item.authRequestId === accepted.authRequestId) ?? job;
    }
    if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
    if (prompter.state.error) throw prompter.state.error;
    if (job.status !== 'completed') throw cliError({ code: job.code ?? 'CORE_OPERATION_FAILED' });
    return job;
  } finally { await detach().catch(() => {}); }
}

// ---------------------------------------------------------------------------
// Sessions: grant -> session.create/reuse -> session.input -> durable journal.
// ---------------------------------------------------------------------------

/** project.grant through the closed native method; classification stays Core's. */
export async function grantProject(core, { cwd, purpose, request, name }) {
  const params = { localPath: cwd, ...(request ? { request } : {}), ...(name ? { name } : {}) };
  if (purpose) return core.call('project.grant', { ...params, purpose });
  try { return await core.call('project.grant', { ...params, purpose: 'game.maintain' }); } catch (error) {
    if (error?.code !== 'AGENT_REQUEST_OUT_OF_SCOPE') throw error;
    return core.call('project.grant', { ...params, purpose: 'game.init' });
  }
}

async function sessionFor(core, { projectHandle, mode, modelAddress }) {
  const { sessions } = await core.call('session.list', { projectHandle });
  // Reuse an idle Core session of the same mode/model so CLI runs share one history.
  const reusable = sessions.filter(item => item.mode === mode && (item.modelAddress ?? null) === (modelAddress ?? null) && !['running', 'closed'].includes(item.state))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  if (reusable) return reusable;
  return core.call('session.create', { projectHandle, mode, ...(modelAddress ? { modelAddress } : {}) });
}

export function renderEvent(event, { stderr, environment = process.env } = {}) {
  const { type, data } = event;
  if (type === 'agent.started') {
    const marker = data.authMethod ? experimentalIndicator(data.authMethod, { stream: stderr, environment }) : '';
    stderr.write(`▶ ${data.operation}${data.modelAddress ? ` · ${data.modelAddress}` : ''}${marker ? ` ${marker}` : ''}\n`);
  } else if (type === 'agent.reasoning_status') stderr.write(`· ${data.phase}\n`);
  else if (type === 'agent.delta') stderr.write(data.text);
  else if (type.startsWith('tool.')) stderr.write(`  ${type.slice(5)} ${data.capability}${data.path ? ` ${data.path}` : ''}${data.status ? ` ${data.status}` : ''}\n`);
  else if (type === 'build.output') stderr.write(data.text.endsWith('\n') ? data.text : `${data.text}\n`);
  else if (type === 'build.completed') stderr.write(`  build ${data.status} (exit ${data.exitCode})\n`);
  else if (type === 'preview.started' || type === 'preview.updated') stderr.write(`  preview v${data.version}\n`);
  else if (type === 'auth.required') stderr.write(`  ${data.providerId}: zuku auth login --provider ${data.providerId}\n`);
}

function completion(data, context) {
  const out = { ...data, ...context };
  if (data.runId) out.run_id = data.runId;
  return out;
}

/**
 * Follows the Core journal from `afterSequence` until this request's terminal event.
 * Abort sends an explicit session.cancel and keeps following; detaching never cancels.
 */
async function follow(core, { sessionId, requestId, afterSequence, signal, onEvent, cancelGraceMs = 15000 }) {
  const stream = new AbortController();
  let cursor = afterSequence, started = false, cancelling = false, grace;
  const cancel = () => {
    if (cancelling) return; cancelling = true;
    void core.call('session.cancel', { sessionId, requestId }).catch(() => {});
    grace = setTimeout(() => stream.abort(), cancelGraceMs); grace.unref?.();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (let attempt = 0; attempt < 16 && !stream.signal.aborted; attempt++) {
      try {
        for await (const event of core.subscribe({ sessionId, afterSequence: cursor, signal: stream.signal })) {
          cursor = event.sequence; onEvent?.(event);
          if (event.type === 'agent.started' && event.data.requestId === requestId) started = true;
          if (started && ['agent.completed', 'agent.cancelled', 'agent.error'].includes(event.type)) return { event, cancelling };
        }
      } catch (error) {
        if (stream.signal.aborted) break;
        if (!['SLOW_SUBSCRIBER', 'CURSOR_EXPIRED', 'INVALID_CURSOR'].includes(error?.code)) throw cliError(error);
      }
      // Recover from the durable snapshot after a dropped or expired subscription.
      const snap = await core.call('session.get', { sessionId });
      if (snap.requestId === requestId && TERMINAL_STATES.includes(snap.state)) return { snapshot: snap, cancelling };
      // An expired cursor may skip this request's agent.started; the snapshot proves ownership.
      if (snap.requestId === requestId) started = true;
      if (cursor < snap.minimumSequence - 1) cursor = snap.minimumSequence - 1;
      if (cursor > snap.sequence) cursor = snap.sequence;
    }
    throw new CommandError(cancelling ? 'COMMAND_CANCELLED' : 'COMMAND_FAILED');
  } finally { clearTimeout(grace); signal?.removeEventListener('abort', cancel); stream.abort(); }
}

/**
 * One Core-owned operation. Returns projected completion data, or throws the safe
 * Core error (with action/retry metadata) for failed/cancelled/needs_auth outcomes.
 */
export async function runCoreOperation(core, { cwd, purpose, projectHandle, operation, request, name, modelAddress, mode = 'local', experimental = false, resume, signal, onEvent }) {
  if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
  const project = projectHandle ? { projectHandle } : await grantProject(core, { cwd, purpose, request: resume ? undefined : request, name });
  let session = await sessionFor(core, { projectHandle: project.projectHandle, mode, modelAddress });
  let before = await core.call('session.get', { sessionId: session.sessionId });
  if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
  const requestId = opaque('cli_input_');
  const fields = { requestId, operation, request, ...(modelAddress ? { modelAddress } : {}), ...(name ? { name } : {}), ...(experimental ? { experimental: true } : {}), ...(resume ? { resume } : {}) };
  try { await core.call('session.input', { sessionId: session.sessionId, ...fields }); } catch (error) {
    if (error?.code !== 'REQUEST_LIMIT') throw error;
    // A full session (Core keeps 128 requests) is closed and history continues in a new one.
    await core.call('session.close', { sessionId: session.sessionId });
    session = await core.call('session.create', { projectHandle: project.projectHandle, mode, ...(modelAddress ? { modelAddress } : {}) });
    before = await core.call('session.get', { sessionId: session.sessionId });
    await core.call('session.input', { sessionId: session.sessionId, ...fields });
  }
  const outcome = await follow(core, { sessionId: session.sessionId, requestId, afterSequence: before.sequence, signal, onEvent });
  const context = { sessionId: session.sessionId, requestId, projectHandle: project.projectHandle, operation, mode };
  if (outcome.event?.type === 'agent.completed') return completion(outcome.event.data, context);
  if (outcome.snapshot?.state === 'completed' && outcome.snapshot.result) return completion(outcome.snapshot.result, context);
  const failure = outcome.event?.data ?? outcome.snapshot?.result ?? {};
  if (outcome.event?.type === 'agent.cancelled' || failure.code === 'COMMAND_CANCELLED') throw new CommandError('COMMAND_CANCELLED');
  const state = outcome.event?.data.state ?? outcome.snapshot?.state;
  throw cliError({ code: failure.code ?? 'CORE_OPERATION_FAILED', action: failure.action ?? (state === 'needs_auth' ? 'login' : undefined) });
}

/** Classification check before contacting Core for project-scoped helpers (read-only). */
export async function isZukuGame(cwd, { signal } = {}) {
  try {
    const { classifyWorkspace } = await import('./agent/scope/index.mjs');
    const result = await classifyWorkspace({ cwd, signal });
    return ECOSYSTEM.includes(result?.classification);
  } catch { return false; }
}
