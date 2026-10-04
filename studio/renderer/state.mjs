// Pure Studio view state. No DOM, Node, network or credential access: every value
// shown here comes from typed Agent Core results/events, never from model prose.
import { OPERATIONS, LIMITS, validateEvent, sanitizeText, relativePath, hasSecret } from '../../lib/agent-protocol/schema.mjs';

export const VIEW_LIMITS = Object.freeze({
  transcriptBytes: 262144, blocks: 400, logLines: 2000, logBytes: 524288,
  activity: 400, gaps: 64, touchedPaths: 64, sessions: 200, projects: 200, models: 2000,
});
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ADDRESS = /^[a-z][a-z0-9_-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,254}$/;
export const isId = value => typeof value === 'string' && ID.test(value);
export const isModelAddress = value => typeof value === 'string' && ADDRESS.test(value);
const bytes = value => new TextEncoder().encode(value).length;
const plain = (value, max = 200) => typeof value === 'string' ? sanitizeText(value).slice(0, max) : '';

export const PHASE_LABELS = Object.freeze({
  analyzing: '프로젝트 분석 중', editing: '파일 편집 중', building: '빌드 실행 중',
  testing: '게임 테스트 중', repairing: '문제 수정 중', verifying: '결과 검증 중',
});
export const OPERATION_LABELS = Object.freeze({
  'game.init': '새 게임 만들기', 'game.maintain': '게임 수정', 'game.build': '빌드',
  'game.test': '테스트', 'game.run': '실행', 'game.stop': '중지', 'game.preview': '미리보기',
});
export const STATE_LABELS = Object.freeze({
  idle: '대기', running: '실행 중', completed: '완료', failed: '실패', cancelled: '취소됨',
  interrupted: '중단됨', closed: '닫힘', needs_auth: '인증 필요', needs_local_permission: '로컬 승인 필요',
});
export const CAPABILITY_LABELS = Object.freeze({
  'project.read': '파일 읽기', 'project.write': '파일 쓰기', 'project.patch': '파일 수정', 'project.search': '검색',
  'zuku.build': '빌드', 'zuku.test': '테스트', 'zuku.run': '실행', 'zuku.stop': '중지',
  'asset.inspect': '에셋 검사', 'docs.search': '문서 검색', 'game.preview': '미리보기',
});
export const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'closed']);

// Fixed, actionable Korean text keyed by safe error code. error.message is never shown.
const ERRORS = {
  BRIDGE_UNAVAILABLE: ['ZUKU Studio 네이티브 연결이 없습니다. Studio 앱에서 이 화면을 여세요.', null],
  CORE_NOT_RUNNING: ['ZUKU Agent Core가 실행 중이 아닙니다.', 'retry'],
  CORE_UNAVAILABLE: ['ZUKU Agent Core에 연결할 수 없습니다.', 'retry'],
  CORE_CLOSED: ['ZUKU Agent Core가 종료되었습니다.', 'retry'],
  CORE_TIMEOUT: ['Agent Core 응답이 제한 시간을 넘었습니다. 같은 요청으로 다시 시도할 수 있습니다.', 'retry'],
  CORE_STATE_UNSAFE: ['로컬 상태 저장소를 안전하게 열 수 없습니다. zuku doctor로 확인하세요.', null],
  PROTOCOL_MISMATCH: ['ZUKU Studio 업데이트가 필요합니다. 로컬 런타임과 프로토콜 버전이 다릅니다.', 'update'],
  AUTH_REQUIRED: ['제공자 인증이 필요합니다.', 'login'], CORE_AUTH_REQUIRED: ['제공자 인증이 필요합니다.', 'login'],
  AUTH_EXPERIMENTAL_OPT_IN: ['실험적 인증 방식은 명시적인 동의가 필요합니다.', null],
  AUTH_METHOD_UNSUPPORTED: ['이 제공자는 선택한 인증 방식을 지원하지 않습니다.', null],
  AGENT_PROVIDER_UNAVAILABLE: ['선택한 제공자를 사용할 수 없습니다. 인증 상태를 확인하세요.', 'login'],
  PROVIDER_NOT_FOUND: ['제공자를 찾을 수 없습니다.', null], PROVIDER_DISABLED: ['비활성화된 제공자입니다.', null],
  MODEL_NOT_FOUND: ['선택한 모델을 찾을 수 없습니다.', null], MODEL_UNAVAILABLE: ['선택한 모델을 지금 사용할 수 없습니다.', null],
  PROJECT_NOT_FOUND: ['로컬 프로젝트에 더 이상 접근할 수 없습니다. 프로젝트를 다시 여세요.', 'inspect_project'],
  PROJECT_CHANGED: ['파일이 다른 곳에서 변경되었습니다. 다시 불러온 뒤 수정하세요.', 'reload'],
  PROJECT_LIMIT: ['열 수 있는 프로젝트 수를 초과했습니다.', null],
  SESSION_NOT_FOUND: ['세션을 찾을 수 없습니다.', null], SESSION_BUSY: ['세션에서 이미 작업이 실행 중입니다.', null],
  SESSION_LIMIT: ['세션 수 제한에 도달했습니다. 사용하지 않는 세션을 닫으세요.', null],
  REQUEST_CONFLICT: ['같은 요청 ID로 다른 내용이 전송되었습니다.', null], REQUEST_LIMIT: ['요청 한도에 도달했습니다.', null],
  CURSOR_EXPIRED: ['이전 이벤트 기록이 보존 기간을 지났습니다. 남아 있는 이벤트부터 표시합니다.', null],
  INVALID_CURSOR: ['이벤트 위치가 올바르지 않습니다.', null], SLOW_SUBSCRIBER: ['이벤트 수신이 지연되어 연결이 끊겼습니다. 다시 연결합니다.', 'retry'],
  AGENT_REQUEST_OUT_OF_SCOPE: ['이 에이전트는 ZUKU/ZUKUJS 게임 개발 작업만 처리합니다.', null],
  AGENT_GATE_FAILED: ['필수 검증 단계를 통과하지 못했습니다.', null], AGENT_SOURCE_CHANGED: ['작업 중 소스가 변경되었습니다.', null],
  AGENT_PLAYTEST_FAILED: ['게임 플레이테스트가 실패했습니다.', null], AGENT_PLAYTEST_UNAVAILABLE: ['플레이테스트 환경을 사용할 수 없습니다.', null],
  AGENT_PLAYTEST_SANDBOX: ['플레이테스트 샌드박스를 시작할 수 없습니다.', null],
  AGENT_RECOVERY_REQUIRED: ['이전 배포 결과를 확인해야 합니다.', 'recover_deployment'],
  AGENT_PUBLISH_OUTCOME_UNKNOWN: ['배포 결과를 확인할 수 없습니다. 자동으로 다시 배포하지 않습니다.', 'recover_deployment'],
  DEPLOY_QUOTA_EXCEEDED: ['배포 한도를 초과했습니다.', null], NATIVE_STAGE_UNAVAILABLE: ['ZUKU AI 단계 실행 경로가 아직 제공되지 않습니다.', null],
  TOOL_UNAVAILABLE: ['요청한 도구를 사용할 수 없습니다.', null], COMMAND_CANCELLED: ['작업이 취소되었습니다.', null],
  NATIVE_PERMISSION_REQUIRED: ['ZUKU Studio 창에서 로컬 승인이 필요합니다.', null], PERMISSION_REQUIRED: ['로컬 승인이 필요합니다.', null],
  STUDIO_NOT_RUNNING: ['ZUKU Studio가 실행 중이 아닙니다.', null], ADAPTER_UNAVAILABLE: ['Browser Adapter를 사용할 수 없습니다.', null],
  INVALID_INPUT: ['입력이 프로토콜 규칙에 맞지 않습니다.', null], BODY_TOO_LARGE: ['요청이 너무 큽니다.', null],
  METHOD_NOT_ALLOWED: ['이 화면에서 허용되지 않는 동작입니다.', null],
  PREVIEW_UNAVAILABLE: ['게임 미리보기를 표시할 수 없습니다.', null],
  REQUEST_EMPTY: ['요청 내용을 입력하세요.', null], REQUEST_TOO_LONG: [`요청은 ${LIMITS.promptChars}자 이하여야 합니다.`, null],
  REQUEST_SECRET: ['비밀 키처럼 보이는 값은 보낼 수 없습니다. 인증은 제공자 탭의 로그인 버튼을 사용하세요.', null],
  REQUEST_CONTROL_CHARS: ['요청에 허용되지 않는 제어 문자가 있습니다.', null],
  NO_SESSION: ['먼저 세션을 선택하거나 만드세요.', null], NO_PROJECT: ['먼저 프로젝트를 선택하세요.', null],
  INVALID_PATH: ['프로젝트 기준 상대 경로만 열 수 있습니다.', null], NOT_TEXT: ['텍스트 파일만 편집할 수 있습니다.', null],
  NO_CORE_DIGEST: ['Core가 파일 해시를 제공하지 않아 저장할 수 없습니다.', 'reload'],
  CONTENT_TOO_LARGE: ['파일이 편집 저장 한도(48 KiB)를 넘습니다.', null],
  UNSAVED_CHANGES: ['저장하지 않은 편집 내용이 있습니다. 저장하거나 되돌린 뒤 다른 파일이나 프로젝트를 여세요.', null],
};
export function describeError(error) {
  const code = typeof error?.code === 'string' && CODE.test(error.code) ? error.code : 'CORE_OPERATION_FAILED';
  const [message, fallback] = ERRORS[code] ?? ['작업을 완료하지 못했습니다. 자세한 내용은 zuku doctor 진단 로그를 확인하세요.', null];
  const action = ['login', 'update', 'retry', 'inspect_project', 'recover_deployment', 'reload'].includes(error?.action) ? error.action : fallback;
  const out = { code, message, action };
  if (Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs >= 0) out.retryAfterMs = error.retryAfterMs;
  return out;
}

// Input admission mirrors the shared schema bounds before the bridge sees it.
export function admitInput({ sessionId, operation, request, sessionState }) {
  if (!isId(sessionId)) return { ok: false, code: 'NO_SESSION' };
  if (!OPERATIONS.includes(operation)) return { ok: false, code: 'INVALID_INPUT' };
  if (sessionState === 'running') return { ok: false, code: 'SESSION_BUSY' };
  const text = typeof request === 'string' ? request.replace(/\r\n?/g, '\n').trim() : '';
  if (!text) return { ok: false, code: 'REQUEST_EMPTY' };
  if (text.length > LIMITS.promptChars) return { ok: false, code: 'REQUEST_TOO_LONG' };
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return { ok: false, code: 'REQUEST_CONTROL_CHARS' };
  if (hasSecret(text)) return { ok: false, code: 'REQUEST_SECRET' };
  return { ok: true, params: { sessionId, operation, request: text } };
}

// (exp!) derives only from metadata booleans; names/labels are never inspected.
export function authBadge(method) {
  if (!method || typeof method !== 'object') return 'unknown';
  if (method.experimental === true || method.unofficial === true || method.official === false) return 'experimental';
  if (method.official === true) return 'official';
  return 'unknown';
}
const normMethod = method => method && typeof method === 'object'
  ? { id: isId(method.id) ? method.id : null, name: plain(method.name ?? method.displayName ?? method.id, 80) || '알 수 없는 방식', badge: authBadge(method) }
  : null;
const yesNoUnknown = value => value === true ? true : value === false ? false : null;
function normCapabilities(caps) {
  const out = {};
  if (caps && typeof caps === 'object') for (const key of ['streaming', 'tools', 'vision', 'reasoning', 'modelDiscovery', 'promptCaching', 'stageInference']) if (key in caps) out[key] = yesNoUnknown(caps[key]);
  return out;
}
const list = (raw, key) => Array.isArray(raw) ? raw : Array.isArray(raw?.[key]) ? raw[key] : [];
export function normalizeProviders(raw) {
  return list(raw, 'providers').filter(row => row && /^[a-z][a-z0-9_-]{0,63}$/.test(row.id)).slice(0, 256).map(row => ({
    id: row.id, name: plain(row.name ?? row.displayName ?? row.id, 80), active: row.active === true,
    enabled: row.enabled === true ? true : row.enabled === false ? false : null,
    authStatus: plain(row.auth?.status ?? row.status, 40) || null, method: normMethod(row.auth?.method ?? row.method),
    methods: list(row, 'authMethods').map(normMethod).filter(method => method?.id).slice(0, 32),
    capabilities: normCapabilities(row.capabilities),
  }));
}
export function normalizeModels(raw) {
  const models = list(raw, 'models').filter(model => isModelAddress(model?.address)).slice(0, VIEW_LIMITS.models).map(model => ({
    address: model.address, name: plain(model.name ?? model.displayName ?? model.modelId ?? model.address, 120),
    source: plain(model.source, 40) || null,
    contextWindow: Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null,
    maxOutputTokens: Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0 ? model.maxOutputTokens : null,
    capabilities: normCapabilities(model.capabilities), active: model.active === true,
  }));
  const active = [raw?.activeModel, raw?.modelAddress, raw?.defaultModel].find(isModelAddress) ?? models.find(model => model.active)?.address ?? null;
  const discovery = typeof raw?.discovery?.status === 'string' ? plain(raw.discovery.status, 40) : null;
  return { models, activeModel: active, discovery, stale: raw?.stale === true, cached: raw?.cached === true };
}
export function normalizeAuth(raw) {
  return list(Array.isArray(raw) ? raw : raw?.auth ?? raw?.authMethods ?? raw, 'auth').filter(row => row && typeof row === 'object').slice(0, 256).map(row => ({
    providerId: /^[a-z][a-z0-9_-]{0,63}$/.test(row.provider ?? row.providerId) ? row.provider ?? row.providerId : null,
    method: normMethod(row.method ?? row), status: plain(row.status, 40) || null,
    authenticated: row.authenticated === true ? true : row.authenticated === false ? false : null,
  })).filter(row => row.providerId);
}
export function normalizeProject(raw) {
  const handle = raw?.projectHandle ?? raw?.id;
  return isId(handle) ? { projectHandle: handle, name: plain(raw.name ?? raw.displayName, 120) || handle } : null;
}
export function normalizeProjects(raw) { return list(raw, 'projects').map(normalizeProject).filter(Boolean).slice(0, VIEW_LIMITS.projects); }
export function normalizeSession(raw) {
  const sessionId = raw?.sessionId ?? raw?.id;
  if (!isId(sessionId)) return null;
  return { sessionId, projectHandle: isId(raw.projectHandle) ? raw.projectHandle : null, state: STATE_LABELS[raw.state] ? raw.state : 'idle',
    sequence: Number.isSafeInteger(raw.sequence) && raw.sequence >= 0 ? raw.sequence : null,
    modelAddress: isModelAddress(raw.modelAddress) ? raw.modelAddress : null, updatedAt: plain(raw.updatedAt, 40) || null };
}
export function normalizeSessions(raw) { return list(raw, 'sessions').map(normalizeSession).filter(Boolean).slice(0, VIEW_LIMITS.sessions); }

// Session event projection: monotonic per-session cursor, explicit gaps, bounded buffers.
export function emptySessionView(sessionId) {
  return { sessionId, lastSequence: 0, duplicates: 0, dropped: 0, gaps: [], state: 'idle', operation: null, requestId: null,
    phase: null, blocks: [], transcriptBytes: 0, transcriptTrimmed: false, activity: [], logs: [], logBytes: 0, logsTrimmed: false,
    build: null, completion: null, error: null, authRequired: null, permissionRequired: null, preview: null, game: null,
    modelAddress: null, authMethod: null, touchedPaths: [], configChanged: 0 };
}
const capped = (items, max) => items.length > max ? items.slice(items.length - max) : items;
function appendBlock(view, kind, blockId, text) {
  let blocks = view.blocks.slice(), size = view.transcriptBytes + bytes(text), trimmed = view.transcriptTrimmed;
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind && last.blockId === blockId) blocks[blocks.length - 1] = { ...last, text: last.text + text };
  else blocks.push({ kind, blockId, text });
  while ((size > VIEW_LIMITS.transcriptBytes || blocks.length > VIEW_LIMITS.blocks) && blocks.length > 1) { size -= bytes(blocks.shift().text); trimmed = true; }
  return { ...view, blocks, transcriptBytes: size, transcriptTrimmed: trimmed };
}
export function appendUserRequest(view, { requestId, operation, request }) {
  return appendBlock({ ...view }, 'user', requestId, `[${OPERATION_LABELS[operation] ?? operation}] ${request}`);
}
export function recordGap(view, after, before) {
  if (!(before > after + 1)) return view;
  return { ...view, gaps: capped([...view.gaps, { after, before }], VIEW_LIMITS.gaps) };
}
// Returns {view, accepted:boolean, reason?}. Never throws on hostile input.
export function applyEvent(view, event) {
  try { validateEvent(event); } catch { return { view: { ...view, dropped: view.dropped + 1 }, accepted: false, reason: 'invalid' }; }
  if (event.sessionId !== view.sessionId) return { view: { ...view, dropped: view.dropped + 1 }, accepted: false, reason: 'session' };
  if (event.sequence <= view.lastSequence) return { view: { ...view, duplicates: view.duplicates + 1 }, accepted: false, reason: 'duplicate' };
  let next = recordGap(view, view.lastSequence, event.sequence);
  next = { ...next, lastSequence: event.sequence };
  const data = event.data;
  switch (event.type) {
    case 'session.created': next.state = data.state; break;
    case 'session.closed': next.state = 'closed'; next.phase = null; break;
    case 'agent.started':
      next = { ...next, state: 'running', operation: data.operation, requestId: data.requestId, phase: null, completion: null, error: null, authRequired: null,
        modelAddress: data.modelAddress ?? next.modelAddress, authMethod: data.authMethod ? { ...data.authMethod, badge: authBadge(data.authMethod) } : next.authMethod };
      break;
    case 'agent.delta': next = appendBlock(next, 'assistant', data.blockId, sanitizeText(data.text)); break;
    case 'agent.reasoning_status': next.phase = data.phase; break;
    case 'agent.completed':
      // Verified only when the host event says so; transcript wording is irrelevant.
      next = { ...next, state: data.status, phase: null, completion: { status: data.status, verified: data.verified === true && data.status === 'completed',
        runId: data.runId ?? null, evidenceCount: data.evidenceIds?.length ?? 0, usage: data.usage ?? null, published: data.published === true } };
      break;
    case 'agent.cancelled': next = { ...next, state: data.state, phase: null, error: describeError({ code: data.code }) }; break;
    case 'agent.error': next = { ...next, state: data.state, phase: null, error: describeError({ code: data.code, action: data.action }) }; break;
    case 'tool.requested': case 'tool.started': case 'tool.completed': case 'tool.failed': {
      const entry = { sequence: event.sequence, type: event.type.slice(5), callId: data.callId, capability: data.capability, path: data.path ?? null,
        status: data.status ?? null, code: data.code ?? null, beforeSha256: data.beforeSha256 ?? null, afterSha256: data.afterSha256 ?? null };
      next.activity = capped([...next.activity, entry], VIEW_LIMITS.activity);
      if (data.path && event.type === 'tool.completed' && data.afterSha256) next.touchedPaths = capped([...next.touchedPaths.filter(path => path !== data.path), data.path], VIEW_LIMITS.touchedPaths);
      break;
    }
    case 'build.started': next.build = { buildId: data.buildId, scriptId: data.scriptId, status: 'running', exitCode: null }; break;
    case 'build.output': {
      let logs = next.logs.slice(), size = next.logBytes, trimmed = next.logsTrimmed;
      for (const line of sanitizeText(data.text).split('\n')) { if (!line) continue; logs.push({ stream: data.stream, buildId: data.buildId, text: line }); size += bytes(line); }
      while ((logs.length > VIEW_LIMITS.logLines || size > VIEW_LIMITS.logBytes) && logs.length) { size -= bytes(logs.shift().text); trimmed = true; }
      next = { ...next, logs, logBytes: size, logsTrimmed: trimmed };
      break;
    }
    case 'build.completed': next.build = { ...(next.build?.buildId === data.buildId ? next.build : { buildId: data.buildId, scriptId: null }), status: data.status, exitCode: data.exitCode, evidenceId: data.evidenceId ?? null }; break;
    case 'game.started': next.game = { gameHandle: data.gameHandle, state: 'running', code: null }; break;
    case 'game.stopped': next.game = { gameHandle: data.gameHandle, state: 'stopped', code: data.code ?? null }; break;
    case 'preview.started': case 'preview.updated': next.preview = { previewHandle: data.previewHandle, version: data.version }; break;
    case 'provider.changed': case 'model.changed': next.configChanged += 1; break;
    case 'auth.required': next = { ...next, state: 'needs_auth', authRequired: { providerId: data.providerId, methodId: data.methodId ?? null, reason: data.reason } }; break;
    case 'permission.required': next = { ...next, state: 'needs_local_permission', permissionRequired: { grantId: data.grantId, purpose: data.purpose, expiresAt: data.expiresAt } }; break;
  }
  return { view: next, accepted: true };
}

// Subscription status messages from the native relay. Unknown shapes are ignored.
export function subscriptionStatus(message) {
  if (!message || typeof message !== 'object' || message.kind !== 'status') return null;
  const state = ['connected', 'disconnected', 'cursor_expired', 'closed'].includes(message.state) ? message.state : null;
  if (!state) return null;
  return { state, code: typeof message.code === 'string' && CODE.test(message.code) ? message.code : null,
    minimumSequence: Number.isSafeInteger(message.minimumSequence) && message.minimumSequence > 0 ? message.minimumSequence : null };
}

export function admitProjectPath(path) { return relativePath(path) ? path : null; }
export function editorSaveState(file) {
  if (!file || typeof file.content !== 'string') return { ok: false, code: 'NOT_TEXT' };
  if (!/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) return { ok: false, code: 'NO_CORE_DIGEST' };
  if (bytes(file.draft) > 49152) return { ok: false, code: 'CONTENT_TOO_LARGE' };
  return { ok: file.draft !== file.content, code: null };
}
