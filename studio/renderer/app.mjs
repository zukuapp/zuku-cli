// ZUKU Studio workspace view. mountStudio({client, nativeActions, root}) renders a
// pure view over the shared Agent Core client; it owns no agent, credentials or files.
import { OPERATIONS, LIMITS } from '../../lib/agent-protocol/schema.mjs';
import {
  describeError, admitInput, applyEvent, appendUserRequest, recordGap, emptySessionView, editorSaveState,
  normalizeProviders, normalizeModels, normalizeAuth, normalizeProject, normalizeProjects, normalizeSession, normalizeSessions,
  admitProjectPath, isId, isModelAddress, PHASE_LABELS, OPERATION_LABELS, STATE_LABELS, CAPABILITY_LABELS, TERMINAL_STATES,
} from './state.mjs';
import { createRequestId } from './client.mjs';
import { diffLines, toHunks } from './diff.mjs';
import { createPreviewController } from './preview.mjs';
import { h, append, replace, icon, button, richText } from './dom.mjs';

const COMPOSER_OPERATIONS = ['game.maintain', 'game.init', 'game.build', 'game.test', 'game.run'].filter(op => OPERATIONS.includes(op));
const QUICK = { 'game.build': '프로젝트를 빌드해 주세요.', 'game.test': '게임 테스트를 실행해 주세요.', 'game.run': '게임을 실행해 주세요.', 'game.stop': '실행 중인 게임을 중지해 주세요.' };
const TABS = [['source', '소스'], ['diff', '변경 사항'], ['logs', '로그'], ['providers', '제공자·모델']];
const PANES = [['rail', '프로젝트'], ['game', '게임'], ['work', '작업'], ['chat', '대화']];
const RETRYABLE = new Set(['CORE_TIMEOUT', 'CORE_UNAVAILABLE', 'CORE_NOT_RUNNING']);
const OFFLINE = new Set(['CORE_NOT_RUNNING', 'CORE_UNAVAILABLE', 'CORE_CLOSED', 'BRIDGE_UNAVAILABLE']);
const CONNECTION_LABELS = { connecting: '연결 중', ready: '연결됨', offline: '연결 안 됨', mismatch: '업데이트 필요', 'no-bridge': '네이티브 연결 없음' };
const SUB_LABELS = { idle: '구독 없음', live: '실시간', reconnecting: '다시 연결 중', closed: '연결 끊김' };
const MAX_VIEWS = 16, MAX_RETRIES = 6, MODEL_ROWS = 300, ACTIVITY_ROWS = 60;
const short = sha => typeof sha === 'string' ? sha.slice(0, 8) : '—';
const known = value => value === null || value === undefined ? '알 수 없음' : String(value);
const yesNo = value => value === true ? '예' : value === false ? '아니요' : '알 수 없음';

export function mountStudio({ client = null, nativeActions = null, root, clientVersion = '0.1.0' } = {}) {
  if (!root?.ownerDocument?.defaultView) throw new TypeError('mountStudio requires a connected root element');
  const doc = root.ownerDocument, win = doc.defaultView;
  const native = Boolean(nativeActions) && client?.native !== false;
  const s = {
    connection: { status: client ? 'connecting' : 'no-bridge', error: client ? null : describeError({ code: 'BRIDGE_UNAVAILABLE' }) },
    projects: [], projectHandle: null, sessions: [], sessionId: null, view: null, views: new Map(),
    sub: { state: 'idle', retries: 0 }, providers: [], auth: [],
    models: { models: [], activeModel: null, discovery: null }, modelProvider: '', modelFilter: '', modelInfo: null,
    tab: 'source', pane: 'game', file: null, searchResults: null, preview: { status: 'none', previewHandle: null },
    notice: null, lastFailed: null, authForms: new Map(), expConsent: false, inflight: 0,
  };
  let disposed = false, detachSubscription = null, retryTimer = 0, frame = 0, configTimer = 0;
  const dirty = new Set();
  const nodes = new WeakMap();

  // ---------- core calls ----------
  async function call(method, params = {}, { quiet = false } = {}) {
    if (!client) { const error = describeError({ code: 'BRIDGE_UNAVAILABLE' }); if (!quiet) notify(error); return { ok: false, error }; }
    s.inflight++; schedule('top');
    try {
      const result = await client.call(method, params);
      return disposed ? { ok: false, error: null } : { ok: true, result };
    } catch (raw) {
      const error = describeError(raw);
      if (!disposed) {
        if (OFFLINE.has(error.code)) setConnection('offline', error);
        else if (error.code === 'PROTOCOL_MISMATCH') setConnection('mismatch', error);
        if (!quiet) notify(error);
      }
      return { ok: false, error };
    } finally { s.inflight--; schedule('top'); }
  }
  function notify(error) { s.notice = error; schedule('notice'); }
  function setConnection(status, error = null) { s.connection = { status, error }; schedule('all'); }

  async function connect() {
    setConnection(client ? 'connecting' : 'no-bridge', client ? null : describeError({ code: 'BRIDGE_UNAVAILABLE' }));
    if (!client) return;
    const hello = await call('hello', { clientVersion }, { quiet: true });
    if (disposed) return;
    if (!hello.ok) { setConnection(hello.error?.code === 'PROTOCOL_MISMATCH' ? 'mismatch' : 'offline', hello.error); return; }
    if (hello.result?.protocolVersion !== undefined && hello.result.protocolVersion !== 1) { setConnection('mismatch', describeError({ code: 'PROTOCOL_MISMATCH' })); return; }
    setConnection('ready');
    s.notice = null;
    await Promise.all([loadProjects(), loadProviders(), loadModels(), loadAuth()]);
    if (s.sessionId && !detachSubscription) openSubscription();
  }

  // ---------- projects & sessions ----------
  async function loadProjects() {
    const res = await call('project.list', {}, { quiet: true });
    if (!res.ok) return;
    s.projects = normalizeProjects(res.result);
    if (s.projectHandle && !s.projects.some(project => project.projectHandle === s.projectHandle)) selectProject(null);
    else if (!s.projectHandle && s.projects.length === 1) selectProject(s.projects[0].projectHandle);
    schedule('rail', 'top');
  }
  async function pickProject() {
    if (typeof nativeActions?.pickProject !== 'function') return;
    let project;
    try { project = normalizeProject(await nativeActions.pickProject()); }
    catch (raw) { const error = describeError(raw); if (error.code !== 'COMMAND_CANCELLED') notify(error); return; }
    if (!project || disposed) return;
    if (!s.projects.some(entry => entry.projectHandle === project.projectHandle)) s.projects = [...s.projects, project];
    selectProject(project.projectHandle);
  }
  function selectProject(handle) {
    if (handle === s.projectHandle) return;
    if (s.file && s.file.content !== null && s.file.draft !== s.file.content) { notify(describeError({ code: 'UNSAVED_CHANGES' })); return; }
    s.projectHandle = handle; s.file = null; s.searchResults = null; s.sessions = [];
    selectSession(null);
    preview.clear();
    el.editor.value = '';
    if (handle) loadSessions();
    schedule('all');
  }
  async function loadSessions() {
    const handle = s.projectHandle;
    const res = await call('session.list', { projectHandle: handle }, { quiet: true });
    if (!res.ok || handle !== s.projectHandle) return;
    s.sessions = normalizeSessions(res.result).filter(session => !session.projectHandle || session.projectHandle === handle);
    schedule('rail');
  }
  async function createSession() {
    if (!s.projectHandle) { notify(describeError({ code: 'NO_PROJECT' })); return; }
    const params = { projectHandle: s.projectHandle, mode: 'local' };
    const override = el.sessionModel.value.trim();
    if (override) { if (!isModelAddress(override)) { notify({ code: 'INVALID_INPUT', message: '세션 모델은 provider/model 형식이어야 합니다.', action: null }); return; } params.modelAddress = override; }
    const res = await call('session.create', params);
    if (!res.ok) return;
    const session = normalizeSession(res.result?.session ?? res.result);
    if (!session) { notify(describeError({ code: 'CORE_OPERATION_FAILED' })); return; }
    s.sessions = [session, ...s.sessions.filter(entry => entry.sessionId !== session.sessionId)];
    el.sessionModel.value = '';
    selectSession(session.sessionId);
  }
  async function closeSession(sessionId) {
    const res = await call('session.close', { sessionId });
    if (!res.ok) return;
    if (s.sessionId === sessionId) selectSession(null);
    s.views.delete(sessionId);
    await loadSessions();
  }
  function selectSession(sessionId) {
    detach();
    s.sessionId = sessionId; s.lastFailed = null; s.expConsent = false;
    s.view = sessionId ? s.views.get(sessionId) ?? emptySessionView(sessionId) : null;
    if (sessionId) {
      rememberView();
      call('session.get', { sessionId }, { quiet: true }).then(res => {
        if (!res.ok || s.sessionId !== sessionId) return;
        const snap = normalizeSession(res.result?.session ?? res.result);
        if (snap && s.view.lastSequence === 0) { s.view = { ...s.view, state: snap.state, modelAddress: snap.modelAddress ?? s.view.modelAddress }; rememberView(); schedule('chat', 'stage'); }
      });
      openSubscription();
    }
    schedule('all');
  }
  function rememberView() {
    if (!s.view) return;
    s.views.delete(s.view.sessionId); s.views.set(s.view.sessionId, s.view);
    while (s.views.size > MAX_VIEWS) s.views.delete(s.views.keys().next().value);
  }

  // ---------- event subscription (detach never cancels agent work) ----------
  function detach() {
    win.clearTimeout(retryTimer); retryTimer = 0;
    if (detachSubscription) { const stop = detachSubscription; detachSubscription = null; stop(); }
    s.sub = { state: 'idle', retries: 0 };
  }
  function openSubscription() {
    if (!client || !s.sessionId || disposed) return;
    const sessionId = s.sessionId;
    if (detachSubscription) { const stop = detachSubscription; detachSubscription = null; stop(); }
    try {
      detachSubscription = client.subscribe({ sessionId, afterSequence: s.view.lastSequence }, event => onEvent(sessionId, event), status => onStatus(sessionId, status));
      s.sub = { ...s.sub, state: 'live' };
    } catch (raw) { s.sub = { ...s.sub, state: 'closed' }; notify(describeError(raw)); }
    schedule('chat', 'top');
  }
  function onEvent(sessionId, event) {
    if (disposed || sessionId !== s.sessionId) return;
    const { view, accepted } = applyEvent(s.view, event);
    s.view = view; rememberView();
    s.sub.retries = 0;
    if (accepted) {
      if (event.type === 'provider.changed' || event.type === 'model.changed') scheduleConfigRefresh();
      if ((event.type === 'preview.started' || event.type === 'preview.updated') && native) preview.show(event.data.previewHandle);
      if (event.type === 'tool.completed' && s.file && event.data.path === s.file.path && event.data.afterSha256 && event.data.afterSha256 !== s.file.sha256) { s.file = { ...s.file, stale: true }; schedule('source'); }
      if (event.type === 'agent.started') s.lastFailed = null;
      if (event.type.startsWith('build.') || event.type.startsWith('game.')) schedule('logs');
      if (event.type.startsWith('tool.')) schedule('diff');
    }
    schedule('chat', 'top', 'stage');
  }
  function onStatus(sessionId, status) {
    if (disposed || sessionId !== s.sessionId) return;
    if (status.state === 'connected') s.sub = { state: 'live', retries: 0 };
    else if (status.state === 'dropped') s.view = { ...s.view, dropped: s.view.dropped + 1 };
    else if (status.state === 'cursor_expired') {
      if (status.minimumSequence && status.minimumSequence - 1 > s.view.lastSequence) s.view = { ...recordGap(s.view, s.view.lastSequence, status.minimumSequence), lastSequence: status.minimumSequence - 1 };
      notify(describeError({ code: 'CURSOR_EXPIRED' }));
      if (status.minimumSequence) reconnectSoon(0);
      else s.sub = { ...s.sub, state: 'closed' };
    } else if (status.state === 'disconnected') reconnectSoon();
    else if (status.state === 'closed') { if (detachSubscription) { const stop = detachSubscription; detachSubscription = null; stop(); } s.sub = { ...s.sub, state: 'closed' }; }
    rememberView();
    schedule('chat', 'top');
  }
  function reconnectSoon(delay) {
    if (s.sub.retries >= MAX_RETRIES) { s.sub = { ...s.sub, state: 'closed' }; return; }
    const retries = s.sub.retries + 1;
    s.sub = { state: 'reconnecting', retries };
    win.clearTimeout(retryTimer);
    retryTimer = win.setTimeout(() => { retryTimer = 0; if (!disposed && s.sessionId) { openSubscription(); s.sub.retries = retries; } }, delay ?? Math.min(15000, 500 * 2 ** retries));
  }
  function scheduleConfigRefresh() {
    win.clearTimeout(configTimer);
    configTimer = win.setTimeout(() => { configTimer = 0; if (!disposed) { loadProviders(); loadModels(); loadAuth(); } }, 150);
  }

  // ---------- agent input ----------
  async function send(operation, text, { fromComposer = false } = {}) {
    const admitted = admitInput({ sessionId: s.sessionId, operation, request: text, sessionState: s.view?.state });
    if (!admitted.ok) { notify(describeError({ code: admitted.code })); return; }
    const submission = { ...admitted.params, requestId: createRequestId('input') };
    if (s.expConsent && activeMethodBadge() === 'experimental') submission.experimental = true;
    s.view = appendUserRequest(s.view, submission); rememberView();
    if (fromComposer) { el.input.value = ''; updateCount(); }
    await submit(submission);
  }
  async function submit(submission) {
    const sessionId = submission.sessionId;
    s.lastFailed = null; schedule('chat');
    const res = await call('session.input', submission);
    if (disposed || s.sessionId !== sessionId) return;
    // A transport failure is retried with the SAME requestId/body so the core can de-duplicate.
    if (!res.ok && res.error && RETRYABLE.has(res.error.code)) s.lastFailed = submission;
    schedule('chat');
  }
  async function cancelRun() {
    if (!s.sessionId) return;
    const params = { sessionId: s.sessionId };
    if (isId(s.view?.requestId)) params.requestId = s.view.requestId;
    await call('session.cancel', params);
  }
  async function openPreview() {
    if (!s.projectHandle) { notify(describeError({ code: 'NO_PROJECT' })); return; }
    const res = await call('game.preview', { projectHandle: s.projectHandle });
    if (!res.ok) return;
    const handle = res.result?.previewHandle;
    if (!native || !isId(handle)) { s.preview = { status: 'unavailable', previewHandle: null }; notify(describeError({ code: 'PREVIEW_UNAVAILABLE' })); schedule('stage'); return; }
    preview.show(handle);
  }

  // ---------- source editing through project.read / project.patch ----------
  async function openFile(path) {
    const safe = admitProjectPath(typeof path === 'string' ? path.trim() : '');
    if (!safe) { notify(describeError({ code: 'INVALID_PATH' })); return; }
    if (!s.projectHandle) { notify(describeError({ code: 'NO_PROJECT' })); return; }
    if (s.file && s.file.content !== null && s.file.draft !== s.file.content && s.file.path !== safe) { notify(describeError({ code: 'UNSAVED_CHANGES' })); return; }
    const handle = s.projectHandle;
    const res = await call('project.read', { projectHandle: handle, path: safe });
    if (!res.ok || handle !== s.projectHandle) return;
    const result = res.result ?? {};
    const text = typeof result.content === 'string' && (!result.encoding || /^utf-?8$/i.test(result.encoding));
    s.file = { path: safe, content: text ? result.content : null, draft: text ? result.content : '', sha256: typeof result.sha256 === 'string' ? result.sha256 : null, stale: false };
    if (!text) notify(describeError({ code: 'NOT_TEXT' }));
    el.editor.value = s.file.draft; el.pathInput.value = safe;
    setTab('source');
    schedule('source', 'diff');
  }
  async function saveFile() {
    const file = s.file, gate = editorSaveState(file);
    if (!gate.ok) { if (gate.code) notify(describeError({ code: gate.code })); return; }
    const res = await call('project.patch', { projectHandle: s.projectHandle, path: file.path, content: file.draft, expectedSha256: file.sha256 });
    if (s.file !== file && s.file?.path !== file.path) return;
    if (!res.ok) { if (res.error?.code === 'PROJECT_CHANGED') { s.file = { ...s.file, stale: true }; schedule('source'); } return; }
    const sha = res.result?.sha256 ?? res.result?.afterSha256;
    if (typeof sha === 'string' && /^[a-f0-9]{64}$/.test(sha)) { s.file = { ...s.file, content: file.draft, sha256: sha, stale: false }; schedule('source', 'diff'); }
    else { s.file = { ...s.file, content: file.draft }; await reloadFile(); }
  }
  // Reload discards the local draft and re-reads the core's current content/digest.
  async function reloadFile() {
    if (!s.file) return;
    s.file = { ...s.file, draft: s.file.content ?? '' };
    await openFile(s.file.path);
  }
  function revertFile() { if (!s.file) return; s.file = { ...s.file, draft: s.file.content ?? '' }; el.editor.value = s.file.draft; schedule('source', 'diff'); }
  async function searchProject() {
    const query = el.searchInput.value.trim();
    if (!s.projectHandle) { notify(describeError({ code: 'NO_PROJECT' })); return; }
    if (!query || query.length > 256) { notify(describeError({ code: 'INVALID_INPUT' })); return; }
    const res = await call('project.search', { projectHandle: s.projectHandle, query });
    if (!res.ok) return;
    const raw = Array.isArray(res.result) ? res.result : res.result?.matches ?? [];
    s.searchResults = raw.filter(match => admitProjectPath(match?.path)).slice(0, 200).map(match => ({ path: match.path, line: Number.isSafeInteger(match.line) ? match.line : null, text: typeof match.text === 'string' ? match.text.slice(0, 200) : '' }));
    schedule('source');
  }

  // ---------- providers, models, auth (read from core, never cached locally) ----------
  async function loadProviders() { const res = await call('provider.list', {}, { quiet: true }); if (res.ok) { s.providers = normalizeProviders(res.result); schedule('providers', 'top', 'chat'); } }
  async function loadAuth() { const res = await call('auth.list', {}, { quiet: true }); if (res.ok) { s.auth = normalizeAuth(res.result); schedule('providers'); } }
  async function loadModels(refresh = false) {
    const params = {};
    if (s.modelProvider) params.providerId = s.modelProvider;
    if (refresh) params.refresh = true;
    const res = await call('model.list', params, { quiet: !refresh });
    if (res.ok) { s.models = normalizeModels(res.result); schedule('models', 'top'); }
  }
  async function providerAction(method, providerId) { const res = await call(method, { providerId }); if (res.ok) { await Promise.all([loadProviders(), loadModels(), loadAuth()]); } }
  async function useModel(address) {
    if (!isModelAddress(address)) { notify({ code: 'INVALID_INPUT', message: '모델 주소는 provider/model 형식이어야 합니다.', action: null }); return; }
    const res = await call('model.use', { modelAddress: address });
    if (res.ok) await Promise.all([loadModels(), loadProviders()]);
  }
  async function modelInfo(address) {
    const res = await call('model.info', { modelAddress: address });
    if (res.ok) { s.modelInfo = normalizeModels({ models: [{ ...(res.result?.model ?? res.result), address }] }).models[0] ?? null; schedule('models'); }
  }
  async function requestAuth(providerId) {
    const form = s.authForms.get(providerId) ?? {};
    const row = s.providers.find(provider => provider.id === providerId);
    const method = row?.methods.find(entry => entry.id === form.methodId) ?? row?.methods[0] ?? null;
    if (method?.badge === 'experimental' && !form.consent) { notify(describeError({ code: 'AUTH_EXPERIMENTAL_OPT_IN' })); return; }
    const params = { providerId };
    if (method?.id) params.methodId = method.id;
    if (method?.badge === 'experimental') params.experimental = true;
    // Core/main opens the trusted native auth flow; no secret is typed into this view.
    const res = await call('auth.request', params);
    if (res.ok) { s.notice = { code: 'AUTH_STARTED', message: 'ZUKU Studio 인증 창에서 로그인을 계속하세요. 이 화면에는 키나 토큰을 입력하지 않습니다.', action: null }; schedule('notice'); await Promise.all([loadAuth(), loadProviders()]); }
  }
  const activeProvider = () => s.providers.find(provider => provider.active) ?? null;
  const activeMethodBadge = () => activeProvider()?.method?.badge ?? 'unknown';

  // ---------- preview ----------
  const preview = createPreviewController({
    nativeActions: native ? nativeActions : null, getElement: () => el.slot, win,
    onChange: state => { s.preview = state; if (state.status === 'unavailable') notify(describeError({ code: 'PREVIEW_UNAVAILABLE' })); schedule('stage'); },
  });

  // ---------- view helpers ----------
  function setTab(tab) { s.tab = tab; schedule('tabs', tab === 'diff' ? 'diff' : tab === 'logs' ? 'logs' : tab === 'providers' ? 'providers' : 'source', 'models'); }
  function setPane(pane) { s.pane = pane; schedule('panes'); }
  function badge(kind) {
    if (kind === 'experimental') return h(doc, 'span', { class: 'zk-exp', title: '공식 API 인증이 아닌 실험적/비공식 경로' }, '(exp!)');
    if (kind === 'official') return h(doc, 'span', { class: 'zk-tag' }, '공식');
    return h(doc, 'span', { class: 'zk-tag zk-tag-unknown' }, '공식 여부 미확인');
  }
  function methodLabel(method) { return method ? [h(doc, 'span', { text: method.name }), ' ', badge(method.badge)] : [h(doc, 'span', { class: 'zk-muted', text: '인증 방식 정보 없음' })]; }
  const ready = () => s.connection.status === 'ready';
  const running = () => s.view?.state === 'running';

  // ---------- static skeleton ----------
  const el = {};
  el.pathInput = h(doc, 'input', { id: 'zk-path', type: 'text', class: 'zk-input zk-mono', placeholder: '예: src/player.mjs', autocomplete: 'off', spellcheck: 'false', maxlength: '512' });
  el.searchInput = h(doc, 'input', { id: 'zk-search', type: 'search', class: 'zk-input', placeholder: '프로젝트에서 검색', autocomplete: 'off', maxlength: '256' });
  el.editor = h(doc, 'textarea', { id: 'zk-editor', class: 'zk-editor zk-mono', spellcheck: 'false', wrap: 'off', 'aria-label': '파일 편집기', on: { input: () => { if (s.file && s.file.content !== null) { s.file = { ...s.file, draft: el.editor.value }; schedule('source'); } } } });
  el.sessionModel = h(doc, 'input', { id: 'zk-session-model', type: 'text', class: 'zk-input zk-mono', placeholder: '세션 모델 (선택, provider/model)', autocomplete: 'off', maxlength: '320' });
  el.modelFilter = h(doc, 'input', { id: 'zk-model-filter', type: 'search', class: 'zk-input', placeholder: '모델 필터', autocomplete: 'off', on: { input: () => { s.modelFilter = el.modelFilter.value.trim().toLowerCase(); schedule('models'); } } });
  el.modelAddress = h(doc, 'input', { id: 'zk-model-address', type: 'text', class: 'zk-input zk-mono', placeholder: 'provider/model 직접 입력', autocomplete: 'off', maxlength: '320' });
  el.modelProvider = h(doc, 'select', { id: 'zk-model-provider', class: 'zk-input', 'aria-label': '모델 목록 제공자', on: { change: () => { s.modelProvider = el.modelProvider.value; loadModels(); } } });
  el.input = h(doc, 'textarea', { id: 'zk-chat-input', class: 'zk-composer-input', rows: '3', maxlength: String(LIMITS.promptChars), placeholder: '예: 플레이어 이동에 대시 기능 추가해줘', 'aria-describedby': 'zk-count',
    on: { input: () => updateCount(), keydown: event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendComposer(); } } } });
  el.opSelect = h(doc, 'select', { id: 'zk-op', class: 'zk-input', 'aria-label': '작업 종류' }, COMPOSER_OPERATIONS.map(op => h(doc, 'option', { value: op, text: OPERATION_LABELS[op] })));
  el.count = h(doc, 'span', { id: 'zk-count', class: 'zk-count', 'aria-live': 'polite' });
  el.expConsent = h(doc, 'input', { id: 'zk-exp-consent', type: 'checkbox', on: { change: () => { s.expConsent = el.expConsent.checked; } } });
  function sendComposer() { if (ready()) send(el.opSelect.value, el.input.value, { fromComposer: true }); }
  function updateCount() { el.count.textContent = `${el.input.value.length} / ${LIMITS.promptChars}`; }

  el.top = h(doc, 'header', { class: 'zk-top' });
  el.notice = h(doc, 'div', { class: 'zk-notice-region', role: 'status', 'aria-live': 'polite' });
  el.projectList = h(doc, 'ul', { class: 'zk-list', 'aria-label': '프로젝트 목록' });
  el.sessionList = h(doc, 'ul', { class: 'zk-list', 'aria-label': '세션 목록' });
  el.pickBtn = button(doc, { label: '프로젝트 열기', iconName: 'folder', kind: 'zk-btn-rail', onClick: pickProject });
  el.newSessionBtn = button(doc, { label: '새 세션', iconName: 'plus', kind: 'zk-btn-rail', onClick: createSession });
  el.rail = h(doc, 'nav', { class: 'zk-rail', 'aria-label': '프로젝트와 세션', 'data-pane-id': 'rail' },
    h(doc, 'div', { class: 'zk-rail-section' }, h(doc, 'h2', { class: 'zk-rail-title', text: '프로젝트' }), el.pickBtn, el.projectList),
    h(doc, 'div', { class: 'zk-rail-section' }, h(doc, 'h2', { class: 'zk-rail-title', text: '세션' }),
      h(doc, 'label', { class: 'zk-visually-hidden', for: 'zk-session-model', text: '새 세션 모델 지정' }), el.sessionModel, el.newSessionBtn, el.sessionList));

  el.quick = {};
  for (const [op, label, iconName] of [['game.build', '빌드', 'hammer'], ['game.test', '테스트', 'check'], ['game.run', '실행', 'play'], ['game.stop', '중지', 'stop']]) el.quick[op] = button(doc, { label, iconName, onClick: () => send(op, QUICK[op]) });
  el.previewBtn = button(doc, { label: '미리보기', iconName: 'eye', kind: 'zk-btn-go', onClick: openPreview });
  el.previewClose = button(doc, { label: '미리보기 닫기', iconName: 'cancel', onClick: () => preview.clear() });
  el.slotText = h(doc, 'p', { class: 'zk-slot-text' });
  el.slot = h(doc, 'div', { class: 'zk-slot', role: 'region', 'aria-label': '등록된 게임 미리보기 영역' }, el.slotText);
  el.stageMeta = h(doc, 'span', { class: 'zk-stage-meta' });
  el.stage = h(doc, 'section', { class: 'zk-stage', 'aria-label': '게임 미리보기', 'data-pane-id': 'game' },
    h(doc, 'div', { class: 'zk-toolbar', role: 'toolbar', 'aria-label': '게임 작업' }, Object.values(el.quick), el.previewBtn, el.previewClose, el.stageMeta), el.slot);

  el.tabs = {}; el.panels = {};
  const tablist = h(doc, 'div', { class: 'zk-tabs', role: 'tablist', 'aria-label': '작업 탭', on: { keydown: event => {
    const index = TABS.findIndex(([id]) => id === s.tab);
    const move = { ArrowRight: 1, ArrowLeft: -1, Home: -index, End: TABS.length - 1 - index }[event.key];
    if (move === undefined) return;
    event.preventDefault();
    const next = TABS[(index + move + TABS.length) % TABS.length][0];
    setTab(next); flush(); el.tabs[next].focus();
  } } });
  for (const [id, label] of TABS) {
    el.tabs[id] = h(doc, 'button', { type: 'button', role: 'tab', id: `zk-tab-${id}`, 'aria-controls': `zk-panel-${id}`, class: 'zk-tab', text: label, on: { click: () => setTab(id) } });
    el.panels[id] = h(doc, 'div', { role: 'tabpanel', id: `zk-panel-${id}`, 'aria-labelledby': `zk-tab-${id}`, class: 'zk-panel', tabindex: '0' });
    tablist.append(el.tabs[id]);
  }
  el.searchResults = h(doc, 'div', { class: 'zk-results' });
  el.touched = h(doc, 'div', { class: 'zk-results' });
  el.editorMeta = h(doc, 'div', { class: 'zk-editor-meta' });
  el.saveBtn = button(doc, { label: '저장', iconName: 'check', kind: 'zk-btn-go', onClick: saveFile });
  el.revertBtn = button(doc, { label: '되돌리기', iconName: 'cancel', onClick: revertFile });
  el.reloadBtn = button(doc, { label: '다시 불러오기', iconName: 'refresh', onClick: () => reloadFile() });
  append(el.panels.source, [
    h(doc, 'div', { class: 'zk-source-forms' },
      h(doc, 'form', { class: 'zk-inline-form', on: { submit: event => { event.preventDefault(); openFile(el.pathInput.value); } } },
        h(doc, 'label', { for: 'zk-path', text: '파일' }), el.pathInput, h(doc, 'button', { type: 'submit', class: 'zk-btn', text: '열기' })),
      h(doc, 'form', { class: 'zk-inline-form', role: 'search', on: { submit: event => { event.preventDefault(); searchProject(); } } },
        h(doc, 'label', { for: 'zk-search', text: '검색' }), el.searchInput, h(doc, 'button', { type: 'submit', class: 'zk-btn', text: '찾기' }))),
    el.searchResults, el.touched,
    h(doc, 'div', { class: 'zk-editor-bar' }, el.editorMeta, h(doc, 'div', { class: 'zk-editor-actions' }, el.saveBtn, el.revertBtn, el.reloadBtn)),
    el.editor,
  ]);
  el.diffBody = h(doc, 'div', { class: 'zk-diff' });
  el.panels.diff.append(el.diffBody);
  el.logsBody = h(doc, 'div', { class: 'zk-logs' });
  el.panels.logs.append(el.logsBody);
  el.providerList = h(doc, 'div', { class: 'zk-provider-list' });
  el.modelList = h(doc, 'div', { class: 'zk-model-list' });
  el.modelMeta = h(doc, 'p', { class: 'zk-muted' });
  el.modelInfoBox = h(doc, 'div', { class: 'zk-model-info' });
  append(el.panels.providers, [
    h(doc, 'h3', { class: 'zk-h3', text: '제공자와 인증' }),
    h(doc, 'p', { class: 'zk-muted', text: '설정은 CLI와 같은 로컬 Agent Core 저장소에서 읽습니다. 키나 토큰은 이 화면에서 입력하거나 저장하지 않습니다.' }),
    el.providerList,
    h(doc, 'h3', { class: 'zk-h3', text: '모델' }),
    h(doc, 'div', { class: 'zk-inline-form' }, el.modelProvider, el.modelFilter, button(doc, { label: '카탈로그 새로고침', iconName: 'refresh', onClick: () => loadModels(true) })),
    el.modelMeta, el.modelList,
    h(doc, 'form', { class: 'zk-inline-form', on: { submit: event => { event.preventDefault(); useModel(el.modelAddress.value.trim()); } } },
      h(doc, 'label', { for: 'zk-model-address', text: '카탈로그에 없는 모델' }), el.modelAddress, h(doc, 'button', { type: 'submit', class: 'zk-btn', text: '이 모델 사용' })),
    el.modelInfoBox,
  ]);
  el.work = h(doc, 'section', { class: 'zk-work', 'aria-label': '작업 공간', 'data-pane-id': 'work' }, tablist, Object.values(el.panels));

  el.chatHead = h(doc, 'div', { class: 'zk-chat-head' });
  el.banners = h(doc, 'div', { class: 'zk-banners' });
  el.transcript = h(doc, 'div', { class: 'zk-transcript', role: 'log', 'aria-label': '에이전트 응답', 'aria-live': 'polite', tabindex: '0' });
  el.activity = h(doc, 'ol', { class: 'zk-activity', 'aria-label': '도구 활동' });
  el.sendBtn = button(doc, { label: '보내기', iconName: 'send', kind: 'zk-btn-go', onClick: sendComposer });
  el.cancelBtn = button(doc, { label: '작업 취소', iconName: 'cancel', kind: 'zk-btn-danger', onClick: cancelRun });
  el.retryBtn = button(doc, { label: '같은 요청 다시 보내기', iconName: 'refresh', onClick: () => { if (s.lastFailed) submit(s.lastFailed); } });
  el.expRow = h(doc, 'label', { class: 'zk-exp-consent', for: 'zk-exp-consent' }, el.expConsent, ' 이 요청에 실험적 인증 사용 동의 ', h(doc, 'span', { class: 'zk-exp' }, '(exp!)'));
  el.chat = h(doc, 'aside', { class: 'zk-chat', 'aria-label': '에이전트 대화와 활동', 'data-pane-id': 'chat' },
    el.chatHead, el.banners, el.transcript,
    h(doc, 'details', { class: 'zk-activity-box' }, h(doc, 'summary', { text: '도구 활동' }), el.activity),
    h(doc, 'div', { class: 'zk-composer' },
      h(doc, 'label', { class: 'zk-visually-hidden', for: 'zk-chat-input', text: '에이전트 요청' }),
      el.input, h(doc, 'div', { class: 'zk-composer-row' }, el.opSelect, el.count), el.expRow,
      h(doc, 'div', { class: 'zk-composer-row' }, el.sendBtn, el.cancelBtn, el.retryBtn)));

  el.panes = {};
  el.paneNav = h(doc, 'nav', { class: 'zk-panes', 'aria-label': '화면 전환' }, PANES.map(([id, label]) => (el.panes[id] = h(doc, 'button', { type: 'button', class: 'zk-pane-btn', text: label, on: { click: () => setPane(id) } }))));
  el.skip = h(doc, 'button', { type: 'button', class: 'zk-skip', text: '에이전트 요청 입력으로 이동', on: { click: () => { setPane('chat'); flush(); el.input.focus(); } } });
  el.app = h(doc, 'div', { class: 'zk-app' }, el.skip, el.top, el.notice, el.rail, el.stage, el.work, el.chat, el.paneNav);
  replace(root, el.app);

  // ---------- renderers ----------
  const R = {
    top() {
      const provider = activeProvider();
      const chips = [
        h(doc, 'span', { class: `zk-chip zk-chip-${s.connection.status}` }, h(doc, 'span', { class: 'zk-dot', 'aria-hidden': 'true' }), `Agent Core: ${CONNECTION_LABELS[s.connection.status]}`),
        h(doc, 'span', { class: 'zk-chip' }, `프로젝트: ${s.projects.find(project => project.projectHandle === s.projectHandle)?.name ?? '선택 안 됨'}`),
        h(doc, 'span', { class: 'zk-chip' }, `제공자: ${provider?.name ?? '확인 안 됨'}`, provider?.method?.badge === 'experimental' ? [' ', badge('experimental')] : null),
        h(doc, 'span', { class: 'zk-chip zk-mono' }, `모델: ${s.view?.modelAddress ?? s.models.activeModel ?? '확인 안 됨'}`),
      ];
      if (s.view) chips.push(h(doc, 'span', { class: 'zk-chip zk-mono', title: '마지막으로 받은 이벤트 순번 (재연결 커서)' }, `이벤트 #${s.view.lastSequence} · ${SUB_LABELS[s.sub.state]}`));
      if (s.inflight > 0) chips.push(h(doc, 'span', { class: 'zk-chip zk-muted', text: '요청 처리 중' }));
      replace(el.top, h(doc, 'h1', { class: 'zk-brand' }, icon(doc, 'chip'), 'ZUKU Studio'), h(doc, 'div', { class: 'zk-chips' }, chips));
    },
    notice() {
      const items = [];
      if (s.connection.status !== 'ready' && s.connection.status !== 'connecting') {
        const error = s.connection.error ?? describeError({ code: 'CORE_UNAVAILABLE' });
        items.push(h(doc, 'div', { class: 'zk-banner zk-banner-block' }, h(doc, 'strong', { text: s.connection.status === 'mismatch' ? 'ZUKU Studio 업데이트 필요' : 'Agent Core 연결 필요' }), h(doc, 'span', { text: error.message }),
          client ? button(doc, { label: '다시 연결', iconName: 'refresh', onClick: connect }) : null));
      }
      if (s.notice) items.push(h(doc, 'div', { class: 'zk-banner' }, h(doc, 'span', { text: s.notice.message }), actionButton(s.notice.action), button(doc, { label: '닫기', iconName: 'cancel', onClick: () => { s.notice = null; schedule('notice'); } })));
      replace(el.notice, items);
    },
    rail() {
      el.pickBtn.hidden = typeof nativeActions?.pickProject !== 'function';
      el.pickBtn.disabled = !ready();
      el.newSessionBtn.disabled = !ready() || !s.projectHandle;
      replace(el.projectList, s.projects.length ? s.projects.map(project => h(doc, 'li', {},
        h(doc, 'button', { type: 'button', class: 'zk-rail-item', 'aria-current': project.projectHandle === s.projectHandle ? 'true' : undefined, on: { click: () => selectProject(project.projectHandle) } },
          icon(doc, 'folder'), h(doc, 'span', { text: project.name })))) : h(doc, 'li', { class: 'zk-rail-empty', text: ready() ? '승인된 프로젝트가 없습니다.' : '연결 후 표시됩니다.' }));
      replace(el.sessionList, !s.projectHandle ? h(doc, 'li', { class: 'zk-rail-empty', text: '프로젝트를 선택하세요.' })
        : s.sessions.length ? s.sessions.map(session => {
          const state = session.sessionId === s.sessionId && s.view ? s.view.state : session.state;
          return h(doc, 'li', { class: 'zk-session-row' },
            h(doc, 'button', { type: 'button', class: 'zk-rail-item', 'aria-current': session.sessionId === s.sessionId ? 'true' : undefined, on: { click: () => selectSession(session.sessionId) } },
              h(doc, 'span', { class: `zk-state zk-state-${state}`, text: STATE_LABELS[state] }), h(doc, 'span', { class: 'zk-mono', text: session.sessionId.slice(-10) })),
            h(doc, 'button', { type: 'button', class: 'zk-icon-btn', 'aria-label': `세션 ${session.sessionId.slice(-10)} 닫기`, title: '세션 닫기 (실행 중이면 Core가 거부합니다)', disabled: state === 'running' || state === 'closed', on: { click: () => closeSession(session.sessionId) } }, icon(doc, 'cancel')));
        }) : h(doc, 'li', { class: 'zk-rail-empty', text: '세션이 없습니다.' }));
    },
    stage() {
      const canRun = ready() && Boolean(s.sessionId) && !running();
      for (const [op, node] of Object.entries(el.quick)) node.disabled = op === 'game.stop' ? !(ready() && s.sessionId) || running() : !canRun;
      el.previewBtn.disabled = !ready() || !s.projectHandle || !native;
      el.previewClose.hidden = s.preview.status !== 'shown';
      const game = s.view?.game;
      el.stageMeta.textContent = game ? `게임 ${game.state === 'running' ? '실행 중' : '중지됨'}` : '';
      el.slot.dataset.state = s.preview.status;
      el.slotText.textContent = !native ? '이 환경에서는 네이티브 게임 미리보기를 사용할 수 없습니다.'
        : s.preview.status === 'shown' ? '' : s.preview.status === 'unavailable' ? '게임 미리보기를 사용할 수 없습니다. 게임을 다시 빌드하거나 미리보기를 다시 요청하세요.'
          : s.projectHandle ? '미리보기 없음 — [미리보기]를 누르면 등록된 게임 미리보기가 이 영역에 표시됩니다.' : '프로젝트를 선택하면 게임 미리보기를 열 수 있습니다.';
      preview.refresh();
    },
    tabs() {
      for (const [id] of TABS) {
        const on = id === s.tab;
        el.tabs[id].setAttribute('aria-selected', String(on)); el.tabs[id].tabIndex = on ? 0 : -1; el.panels[id].hidden = !on;
      }
    },
    source() {
      const file = s.file;
      replace(el.searchResults, s.searchResults === null ? null : s.searchResults.length
        ? h(doc, 'ul', { class: 'zk-result-list', 'aria-label': '검색 결과' }, s.searchResults.map(match => h(doc, 'li', {}, h(doc, 'button', { type: 'button', class: 'zk-link-btn', on: { click: () => openFile(match.path) } },
          h(doc, 'span', { class: 'zk-mono', text: match.line ? `${match.path}:${match.line}` : match.path }), match.text ? h(doc, 'span', { class: 'zk-muted zk-mono', text: ` ${match.text}` }) : null))))
        : h(doc, 'p', { class: 'zk-muted', text: '검색 결과가 없습니다.' }));
      const touched = s.view?.touchedPaths ?? [];
      replace(el.touched, touched.length ? [h(doc, 'h3', { class: 'zk-h3', text: '에이전트가 변경한 파일' }), h(doc, 'ul', { class: 'zk-result-list' }, touched.map(path => h(doc, 'li', {}, h(doc, 'button', { type: 'button', class: 'zk-link-btn zk-mono', text: path, on: { click: () => openFile(path) } }))))] : null);
      const dirtyFile = file && file.content !== null && file.draft !== file.content;
      const gate = editorSaveState(file);
      replace(el.editorMeta, file ? [h(doc, 'span', { class: 'zk-mono', text: file.path }), h(doc, 'span', { class: 'zk-muted zk-mono', text: ` sha256 ${short(file.sha256)}` }),
        dirtyFile ? h(doc, 'span', { class: 'zk-tag zk-tag-warn', text: '저장 안 됨' }) : null,
        file.stale ? h(doc, 'span', { class: 'zk-tag zk-tag-warn', text: 'Core에서 변경됨 — 다시 불러오기 필요' }) : null,
        file.content === null ? h(doc, 'span', { class: 'zk-tag', text: '텍스트 아님 (읽기 전용)' }) : null,
        !gate.ok && gate.code === 'CONTENT_TOO_LARGE' ? h(doc, 'span', { class: 'zk-tag zk-tag-warn', text: '48 KiB 초과' }) : null]
        : h(doc, 'span', { class: 'zk-muted', text: '파일을 열면 여기에서 편집하고 Core의 project.patch로 저장합니다.' }));
      el.editor.readOnly = !file || file.content === null;
      el.saveBtn.disabled = !ready() || !gate.ok;
      el.revertBtn.disabled = !dirtyFile;
      el.reloadBtn.disabled = !file || !ready();
    },
    diff() {
      if (s.tab !== 'diff') return;
      const blocks = [];
      const file = s.file;
      if (file && file.content !== null) {
        const result = diffLines(file.content, file.draft);
        const { hunks, clipped } = toHunks(result.ops);
        blocks.push(h(doc, 'h3', { class: 'zk-h3' }, h(doc, 'span', { class: 'zk-mono', text: file.path }), ` 편집 내용 `, h(doc, 'span', { class: 'zk-add-count', text: `+${result.added}` }), ' ', h(doc, 'span', { class: 'zk-del-count', text: `−${result.removed}` })));
        if (result.approximate) blocks.push(h(doc, 'p', { class: 'zk-muted', text: '변경 범위가 커서 줄 단위 근사 비교(삭제 후 추가)로 표시합니다.' }));
        if (result.truncated || clipped) blocks.push(h(doc, 'p', { class: 'zk-muted', text: '비교 한도를 넘어 일부 줄만 표시합니다.' }));
        if (!hunks.length) blocks.push(h(doc, 'p', { class: 'zk-muted', text: '저장되지 않은 변경이 없습니다.' }));
        for (const hunk of hunks) blocks.push(h(doc, 'div', { class: 'zk-hunk', role: 'table', 'aria-label': `${known(hunk.oldStart)}행 부근 변경` }, hunk.lines.map(line => h(doc, 'div', { class: `zk-diff-row zk-diff-${line.type}`, role: 'row' },
          h(doc, 'span', { class: 'zk-ln', role: 'cell', text: line.oldLine ?? '' }), h(doc, 'span', { class: 'zk-ln', role: 'cell', text: line.newLine ?? '' }),
          h(doc, 'span', { class: 'zk-sign', role: 'cell', 'aria-label': line.type === 'add' ? '추가' : line.type === 'del' ? '삭제' : '유지', text: line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ' }),
          h(doc, 'span', { class: 'zk-diff-text', role: 'cell', text: line.text })))));
      } else blocks.push(h(doc, 'p', { class: 'zk-muted', text: '소스 탭에서 파일을 열고 편집하면 저장 전 변경 내용을 비교합니다.' }));
      const changes = (s.view?.activity ?? []).filter(entry => (entry.type === 'completed' || entry.type === 'failed') && entry.path && ['project.patch', 'project.write'].includes(entry.capability));
      blocks.push(h(doc, 'h3', { class: 'zk-h3', text: '에이전트 파일 변경 기록' }));
      blocks.push(changes.length ? h(doc, 'ul', { class: 'zk-result-list' }, changes.slice(-100).map(entry => h(doc, 'li', { class: 'zk-change' },
        h(doc, 'span', { class: `zk-tag ${entry.type === 'failed' ? 'zk-tag-bad' : ''}`, text: entry.type === 'failed' ? '실패' : '적용됨' }),
        h(doc, 'button', { type: 'button', class: 'zk-link-btn zk-mono', text: entry.path, on: { click: () => openFile(entry.path) } }),
        h(doc, 'span', { class: 'zk-muted zk-mono', text: ` ${short(entry.beforeSha256)} → ${short(entry.afterSha256)}` }))))
        : h(doc, 'p', { class: 'zk-muted', text: '이 세션에서 받은 파일 변경 이벤트가 없습니다.' }));
      replace(el.diffBody, blocks);
    },
    logs() {
      if (s.tab !== 'logs') return;
      const view = s.view, build = view?.build;
      const head = [];
      if (build) head.push(h(doc, 'p', { class: `zk-build zk-build-${build.status}` }, build.status === 'running' ? '빌드 실행 중' : build.status === 'passed' ? `빌드 통과 (호스트 관찰 · 종료 코드 ${build.exitCode})` : `빌드 실패 (호스트 관찰 · 종료 코드 ${build.exitCode})`, build.scriptId ? h(doc, 'span', { class: 'zk-muted zk-mono', text: ` 스크립트 ${build.scriptId}` }) : null));
      if (view?.game) head.push(h(doc, 'p', { class: 'zk-muted', text: `게임 ${view.game.state === 'running' ? '실행 중' : `중지됨${view.game.code ? ` (${view.game.code})` : ''}`}` }));
      if (view?.logsTrimmed) head.push(h(doc, 'p', { class: 'zk-muted', text: '오래된 로그 줄은 화면 한도로 생략되었습니다.' }));
      const stick = el.logsBody.scrollHeight - el.logsBody.scrollTop - el.logsBody.clientHeight < 24;
      replace(el.logsBody, head, view?.logs.length ? h(doc, 'div', { class: 'zk-log-lines zk-mono', role: 'log', 'aria-label': '빌드 출력' }, view.logs.map(line => h(doc, 'div', { class: `zk-log zk-log-${line.stream}` }, h(doc, 'span', { class: 'zk-log-stream', text: line.stream === 'stderr' ? 'ERR' : 'OUT' }), h(doc, 'span', { text: line.text }))))
        : h(doc, 'p', { class: 'zk-muted', text: view ? '아직 빌드 출력이 없습니다.' : '세션을 선택하면 빌드와 게임 로그가 표시됩니다.' }));
      if (stick) el.logsBody.scrollTop = el.logsBody.scrollHeight;
    },
    providers() {
      const options = [h(doc, 'option', { value: '', text: '활성 제공자' }), ...s.providers.map(provider => h(doc, 'option', { value: provider.id, text: provider.name }))];
      replace(el.modelProvider, options); el.modelProvider.value = s.modelProvider;
      if (s.tab !== 'providers') return;
      replace(el.providerList, s.providers.length ? s.providers.map(provider => providerRow(provider)) : h(doc, 'p', { class: 'zk-muted', text: ready() ? 'Core가 제공자 목록을 반환하지 않았습니다.' : '연결 후 표시됩니다.' }));
    },
    models() {
      if (s.tab !== 'providers') return;
      const { models, activeModel, discovery } = s.models;
      el.modelMeta.textContent = `카탈로그 ${models.length}개 · 탐색 상태: ${discovery ?? '알 수 없음'}${s.models.stale ? ' · 오래된 캐시' : ''} · 사용 중: ${activeModel ?? '확인 안 됨'}`;
      const filtered = s.modelFilter ? models.filter(model => model.address.toLowerCase().includes(s.modelFilter) || model.name.toLowerCase().includes(s.modelFilter)) : models;
      replace(el.modelList, filtered.length ? [h(doc, 'ul', { class: 'zk-model-rows' }, filtered.slice(0, MODEL_ROWS).map(model => h(doc, 'li', { class: 'zk-model-row' },
        h(doc, 'span', { class: 'zk-mono', text: model.address }), model.address === activeModel ? h(doc, 'span', { class: 'zk-tag zk-tag-go', text: '사용 중' }) : null,
        h(doc, 'span', { class: 'zk-muted', text: ` ${model.source ?? '출처 미상'} · 컨텍스트 ${known(model.contextWindow)}` }),
        h(doc, 'span', { class: 'zk-row-actions' }, button(doc, { label: '정보', onClick: () => modelInfo(model.address) }), button(doc, { label: '사용', disabled: model.address === activeModel || !ready(), onClick: () => useModel(model.address) }))))),
      filtered.length > MODEL_ROWS ? h(doc, 'p', { class: 'zk-muted', text: `${filtered.length - MODEL_ROWS}개 더 있음 — 필터로 좁히세요.` }) : null]
        : h(doc, 'p', { class: 'zk-muted', text: '표시할 모델이 없습니다. 카탈로그에 없는 모델은 아래에 주소를 직접 입력할 수 있으며, 사용 가능 여부는 Core가 판단합니다.' }));
      const info = s.modelInfo;
      replace(el.modelInfoBox, info ? h(doc, 'dl', { class: 'zk-dl' },
        h(doc, 'dt', { text: '모델' }), h(doc, 'dd', { class: 'zk-mono', text: info.address }),
        h(doc, 'dt', { text: '컨텍스트' }), h(doc, 'dd', { text: known(info.contextWindow) }),
        h(doc, 'dt', { text: '최대 출력' }), h(doc, 'dd', { text: known(info.maxOutputTokens) }),
        ['streaming', 'tools', 'vision', 'reasoning'].map(key => [h(doc, 'dt', { text: { streaming: '스트리밍', tools: '도구 호출', vision: '이미지 입력', reasoning: '추론' }[key] }), h(doc, 'dd', { text: yesNo(info.capabilities[key]) })])) : null);
    },
    chat() {
      const view = s.view;
      if (!view) {
        replace(el.chatHead, h(doc, 'h2', { class: 'zk-h2', text: '에이전트' }), h(doc, 'p', { class: 'zk-muted', text: s.projectHandle ? '세션을 선택하거나 새 세션을 만드세요.' : '프로젝트를 먼저 선택하세요.' }));
        replace(el.banners); replace(el.transcript); replace(el.activity);
      } else {
        const auth = view.authMethod;
        replace(el.chatHead,
          h(doc, 'h2', { class: 'zk-h2' }, '세션 ', h(doc, 'span', { class: 'zk-mono', text: view.sessionId.slice(-10) })),
          h(doc, 'p', { class: 'zk-session-line' }, h(doc, 'span', { class: `zk-state zk-state-${view.state}`, text: STATE_LABELS[view.state] }),
            view.operation ? ` ${OPERATION_LABELS[view.operation]}` : '', view.phase && view.state === 'running' ? h(doc, 'span', { class: 'zk-phase', text: ` · ${PHASE_LABELS[view.phase]}` }) : null),
          h(doc, 'p', { class: 'zk-muted zk-mono' }, `이벤트 #${view.lastSequence} · ${SUB_LABELS[s.sub.state]}`, auth ? [' · ', auth.id, ' ', badge(auth.badge)] : null),
          s.sub.state === 'closed' ? button(doc, { label: '이벤트 다시 연결', iconName: 'refresh', onClick: () => { s.sub.retries = 0; openSubscription(); } }) : null);
        const banners = [];
        if (view.gaps.length) banners.push(h(doc, 'p', { class: 'zk-banner zk-banner-quiet', text: `이벤트 ${view.gaps.map(gap => gap.before - gap.after - 1 === 1 ? `#${gap.after + 1}` : `#${gap.after + 1}–${gap.before - 1}`).join(', ')} 을(를) 받을 수 없었습니다. 누락된 내용은 재생하지 않습니다.` }));
        if (view.dropped) banners.push(h(doc, 'p', { class: 'zk-banner zk-banner-quiet', text: `형식이 올바르지 않은 이벤트 ${view.dropped}개를 표시하지 않았습니다.` }));
        if (view.authRequired) banners.push(h(doc, 'div', { class: 'zk-banner' }, h(doc, 'span', { text: `${view.authRequired.providerId} 제공자 인증이 필요합니다.` }), button(doc, { label: '제공자 탭에서 로그인', iconName: 'key', onClick: () => { setTab('providers'); setPane('work'); } })));
        if (view.permissionRequired && view.state === 'needs_local_permission') banners.push(h(doc, 'p', { class: 'zk-banner', text: 'ZUKU Studio 승인 창에서 로컬 권한을 허용하거나 거부하세요. 이 화면은 승인을 대신하지 않습니다.' }));
        if (view.error && !['running', 'completed'].includes(view.state)) banners.push(h(doc, 'div', { class: 'zk-banner zk-banner-bad' }, h(doc, 'span', { text: view.error.message }), actionButton(view.error.action)));
        if (view.completion) {
          const c = view.completion;
          banners.push(h(doc, 'div', { class: `zk-result ${c.verified ? 'zk-result-ok' : ''}` },
            h(doc, 'strong', { text: `작업 종료: ${STATE_LABELS[c.status] ?? c.status}` }),
            c.verified ? h(doc, 'span', { class: 'zk-tag zk-tag-go', text: '호스트 검증됨' }) : h(doc, 'span', { class: 'zk-tag', text: '검증되지 않음' }),
            c.evidenceCount ? h(doc, 'span', { class: 'zk-muted', text: ` 증거 ${c.evidenceCount}건` }) : null,
            c.usage?.totalTokens !== undefined ? h(doc, 'span', { class: 'zk-muted', text: ` · 토큰 ${c.usage.totalTokens}` }) : null));
        }
        replace(el.banners, banners);
        const stick = el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 32;
        const items = [];
        if (view.transcriptTrimmed) items.push(h(doc, 'p', { class: 'zk-muted', text: '오래된 대화는 화면 한도로 생략되었습니다.' }));
        for (const block of view.blocks) {
          let node = nodes.get(block);
          if (!node) {
            node = h(doc, 'article', { class: `zk-msg zk-msg-${block.kind}`, 'aria-label': block.kind === 'user' ? '보낸 요청' : '에이전트 응답' }, block.kind === 'user' ? h(doc, 'p', { class: 'zk-para', text: block.text }) : richText(doc, block.text));
            nodes.set(block, node);
          }
          items.push(node);
        }
        if (!view.blocks.length) items.push(h(doc, 'p', { class: 'zk-muted', text: '아직 응답이 없습니다. 아래에 게임 개발 요청을 입력하세요.' }));
        replace(el.transcript, items);
        if (stick) el.transcript.scrollTop = el.transcript.scrollHeight;
        replace(el.activity, view.activity.slice(-ACTIVITY_ROWS).map(entry => h(doc, 'li', { class: `zk-act zk-act-${entry.type}` },
          h(doc, 'span', { class: 'zk-act-type', text: { requested: '요청', started: '시작', completed: '완료', failed: '실패' }[entry.type] }),
          ` ${CAPABILITY_LABELS[entry.capability] ?? entry.capability}`, entry.path ? h(doc, 'span', { class: 'zk-mono', text: ` ${entry.path}` }) : null, entry.code ? h(doc, 'span', { class: 'zk-muted', text: ` (${entry.code})` }) : null)));
      }
      const live = ready() && Boolean(view);
      el.input.disabled = !live; el.opSelect.disabled = !live;
      el.sendBtn.disabled = !live || running();
      el.cancelBtn.hidden = !running(); el.cancelBtn.disabled = !ready();
      el.retryBtn.hidden = !s.lastFailed;
      el.expRow.hidden = activeMethodBadge() !== 'experimental';
      el.expConsent.checked = s.expConsent;
      updateCount();
    },
    panes() {
      el.app.dataset.pane = s.pane;
      for (const [id] of PANES) el.panes[id].setAttribute('aria-pressed', String(id === s.pane));
      preview.refresh();
    },
  };
  function providerRow(provider) {
    const form = s.authForms.get(provider.id) ?? { methodId: provider.methods[0]?.id ?? null, consent: false };
    s.authForms.set(provider.id, form);
    const selected = () => provider.methods.find(method => method.id === form.methodId) ?? provider.methods[0] ?? null;
    const consent = h(doc, 'input', { type: 'checkbox', id: `zk-consent-${provider.id}`, checked: form.consent, on: { change: () => { form.consent = consent.checked; syncLogin(); } } });
    const consentRow = h(doc, 'label', { class: 'zk-exp-consent', for: `zk-consent-${provider.id}` }, consent, ' 비공식·실험적 인증 경로임을 이해합니다 ', badge('experimental'));
    const login = button(doc, { label: '로그인', iconName: 'key', onClick: () => requestAuth(provider.id) });
    const methodSelect = provider.methods.length > 1 ? h(doc, 'select', { class: 'zk-input', 'aria-label': `${provider.name} 인증 방식`, on: { change: () => { form.methodId = methodSelect.value; form.consent = false; consent.checked = false; syncLogin(); } } },
      provider.methods.map(method => h(doc, 'option', { value: method.id, text: `${method.name}${method.badge === 'experimental' ? ' (exp!)' : ''}` }))) : null;
    if (methodSelect && form.methodId) methodSelect.value = form.methodId;
    function syncLogin() { const method = selected(); consentRow.hidden = method?.badge !== 'experimental'; login.disabled = !ready() || (method?.badge === 'experimental' && !form.consent); }
    syncLogin();
    const authRows = s.auth.filter(row => row.providerId === provider.id);
    return h(doc, 'section', { class: `zk-provider ${provider.active ? 'zk-provider-active' : ''}`, 'aria-label': provider.name },
      h(doc, 'div', { class: 'zk-provider-head' }, h(doc, 'strong', { text: provider.name }), h(doc, 'span', { class: 'zk-muted zk-mono', text: ` ${provider.id}` }),
        provider.active ? h(doc, 'span', { class: 'zk-tag zk-tag-go', text: '사용 중' }) : null, provider.enabled === false ? h(doc, 'span', { class: 'zk-tag', text: '비활성' }) : null),
      h(doc, 'p', { class: 'zk-provider-auth' }, '인증: ', methodLabel(provider.method), ` · 상태: ${provider.authStatus ?? '알 수 없음'}`),
      authRows.length ? h(doc, 'ul', { class: 'zk-auth-rows' }, authRows.map(row => h(doc, 'li', {}, methodLabel(row.method), ` — ${row.status ?? '알 수 없음'}`))) : null,
      h(doc, 'div', { class: 'zk-row-actions' },
        button(doc, { label: '이 제공자 사용', disabled: !ready() || provider.active || provider.enabled === false, onClick: () => providerAction('provider.use', provider.id) }),
        native && provider.enabled !== null ? button(doc, { label: provider.enabled ? '비활성화' : '활성화', disabled: !ready(), onClick: () => providerAction(provider.enabled ? 'provider.disable' : 'provider.enable', provider.id) }) : null,
        methodSelect, login,
        button(doc, { label: '로그아웃', disabled: !ready(), onClick: () => providerAction('auth.logout', provider.id) })),
      consentRow);
  }
  function actionButton(action) {
    if (action === 'login') return button(doc, { label: '제공자 인증 열기', iconName: 'key', onClick: () => { setTab('providers'); setPane('work'); } });
    if (action === 'retry') return button(doc, { label: '다시 연결', iconName: 'refresh', onClick: connect });
    if (action === 'reload' && s.file) return button(doc, { label: '파일 다시 불러오기', iconName: 'refresh', onClick: () => reloadFile() });
    if (action === 'update') return h(doc, 'span', { class: 'zk-muted', text: '터미널에서 zuku doctor로 버전을 확인하고 ZUKU를 업데이트하세요.' });
    if (action === 'recover_deployment') return h(doc, 'span', { class: 'zk-muted', text: '터미널에서 zuku agent --resume으로 배포 상태를 확인하세요.' });
    return null;
  }

  // ---------- batched rendering ----------
  function schedule(...regions) {
    if (disposed) return;
    for (const region of regions) if (region === 'all') for (const key of Object.keys(R)) dirty.add(key); else dirty.add(region);
    if (!frame) frame = win.requestAnimationFrame(flush);
  }
  function flush() {
    if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
    if (disposed) return;
    const regions = [...dirty]; dirty.clear();
    for (const region of regions) R[region]?.();
  }
  schedule('all'); flush();
  connect();

  return {
    // Unmount detaches the view only; running agent work continues in Agent Core.
    async unmount() {
      if (disposed) return;
      disposed = true;
      detach();
      win.clearTimeout(configTimer);
      if (frame) win.cancelAnimationFrame(frame);
      await preview.destroy();
      root.replaceChildren();
    },
    snapshot: () => ({ connection: s.connection.status, projectHandle: s.projectHandle, sessionId: s.sessionId, lastSequence: s.view?.lastSequence ?? null, subscription: s.sub.state, preview: s.preview.status, tab: s.tab, pane: s.pane }),
  };
}
