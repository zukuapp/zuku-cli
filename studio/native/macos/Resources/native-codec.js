// Private native admission codec for the macOS shell. ZukuStudio evaluates this file
// once, inside its own JavaScriptCore context, directly after the shared
// lib/agent-protocol/schema.mjs body (exports stripped). It is never loaded by a page,
// the renderer or a game preview. Every function takes and returns plain strings or
// small plain objects; nothing here can reach the OS, the network or credentials.
const NATIVE_RENDERER_METHODS = new Set(['hello', 'project.list', 'project.read', 'project.patch', 'project.search', 'session.create', 'session.list', 'session.get', 'session.input', 'session.cancel', 'session.close', 'provider.list', 'provider.use', 'provider.add', 'provider.remove', 'provider.configure', 'provider.enable', 'provider.disable', 'model.list', 'model.use', 'model.info', 'auth.list', 'auth.request', 'auth.logout', 'game.run', 'game.stop', 'game.preview']);
// Host-only methods. A renderer naming one of these is refused before anything reaches Core.
const NATIVE_PRIVATE_METHODS = new Set(['project.grant', 'native.projectChosen', 'native.resolvePreview', 'native.pairingDecision', 'native.authResponse', 'preview.read', 'studio.open']);
const NATIVE_LIMITS = Object.freeze({ rendererRequest: 65536, hostLine: 262144, rendererMessage: 65536 });
const NATIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NATIVE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const NATIVE_PURPOSE = /^[a-z][a-z0-9_.-]{0,63}$/;
const NATIVE_PREVIEW = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/p\/[a-f0-9]{32}\/$/;
const NATIVE_STATUS = new Set(['connected', 'disconnected', 'cursor_expired', 'closed']);
const nativeBytes = text => new TextEncoder().encode(text).length;
const nativeExact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const nativeOnly = (value, required, optional = []) => record(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const nativeId = value => typeof value === 'string' && NATIVE_ID.test(value);
const nativeInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const nativeParse = (text, limit) => {
  if (typeof text !== 'string' || text.length === 0 || nativeBytes(text) > limit) return null;
  try { const value = JSON.parse(text); return record(value) ? value : null; } catch { return null; }
};
const nativePreviewURL = value => {
  if (typeof value !== 'string' || value.length > 200) return null;
  const match = NATIVE_PREVIEW.exec(value);
  return match && Number(match[1]) <= 65535 ? value : null;
};
// Prompt text is shown by AppKit as plain text only. Newlines are kept; every other
// control or bidi-override character is refused instead of being rendered.
const nativeQuestion = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\x00-\x09\x0b-\x1f\x7f‪-‮⁦-⁩]/.test(value);

const ZukuNativeCodec = Object.freeze({
  limits: NATIVE_LIMITS,
  /** Renderer → native. null drops silently (no usable id); {kind:'reject'} answers the id. */
  admitRenderer(text) {
    const value = nativeParse(text, NATIVE_LIMITS.rendererRequest);
    if (!value || !nativeExact(value, ['protocolVersion', 'id', 'method', 'params']) || !nativeId(value.id)) return null;
    const { id, method, params } = value;
    if (value.protocolVersion !== PROTOCOL_VERSION) return { kind: 'reject', id, code: 'PROTOCOL_MISMATCH' };
    if (typeof method !== 'string' || !record(params)) return { kind: 'reject', id, code: 'INVALID_INPUT' };
    const invalid = { kind: 'reject', id, code: 'INVALID_INPUT' };
    switch (method) {
      case 'native.pickProject': return nativeExact(params, []) ? { kind: 'pickProject', id } : invalid;
      case 'native.previewHide': return nativeExact(params, []) ? { kind: 'previewHide', id } : invalid;
      case 'native.subscribe':
        if (!nativeExact(params, ['subscriptionId', 'sessionId', 'afterSequence']) || !nativeId(params.subscriptionId) || !nativeId(params.sessionId) || !nativeInt(params.afterSequence, 0, Number.MAX_SAFE_INTEGER)) return invalid;
        return { kind: 'forward', id, method, params: JSON.stringify({ subscriptionId: params.subscriptionId, sessionId: params.sessionId, afterSequence: params.afterSequence }) };
      case 'native.unsubscribe':
        if (!nativeExact(params, ['subscriptionId']) || !nativeId(params.subscriptionId)) return invalid;
        return { kind: 'forward', id, method, params: JSON.stringify({ subscriptionId: params.subscriptionId }) };
      case 'native.previewShow': {
        const rect = params.rect;
        if (!nativeExact(params, ['previewHandle', 'rect']) || !nativeId(params.previewHandle) || !nativeExact(rect, ['x', 'y', 'width', 'height'])
          || !nativeInt(rect.x, 0, 16384) || !nativeInt(rect.y, 0, 16384) || !nativeInt(rect.width, 16, 16384) || !nativeInt(rect.height, 16, 16384)) return invalid;
        return { kind: 'previewShow', id, previewHandle: params.previewHandle, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    if (NATIVE_PRIVATE_METHODS.has(method)) return { kind: 'reject', id, code: 'NATIVE_PERMISSION_REQUIRED' };
    if (!NATIVE_RENDERER_METHODS.has(method)) return { kind: 'reject', id, code: 'METHOD_NOT_ALLOWED' };
    try { validateRequest(value, { native: true }); }
    catch (error) { return { kind: 'reject', id, code: error instanceof ProtocolError && NATIVE_CODE.test(error.code) ? error.code : 'INVALID_INPUT' }; }
    return { kind: 'forward', id, method, params: JSON.stringify(params) };
  },
  /** Host stdout line → native. null is a protocol violation; the shell stops the host. */
  admitHost(text) {
    const value = nativeParse(text, NATIVE_LIMITS.hostLine);
    if (!value || value.protocolVersion !== PROTOCOL_VERSION) return null;
    if (Object.hasOwn(value, 'id')) {
      if (!nativeId(value.id)) return null;
      if (Object.hasOwn(value, 'error')) {
        const code = record(value.error) && typeof value.error.code === 'string' && NATIVE_CODE.test(value.error.code) ? value.error.code : 'CORE_OPERATION_FAILED';
        return { kind: 'response', id: value.id, errorCode: code, result: 'null', previewURL: null };
      }
      const raw = Object.hasOwn(value, 'result') ? value.result : null;
      // The readonly preview URL is native-only; projectPublicResult drops `url`, so the
      // renderer can never receive it even if the host mistakenly echoes it.
      const previewURL = record(raw) ? nativePreviewURL(raw.url) : null;
      return { kind: 'response', id: value.id, errorCode: null, result: JSON.stringify(projectPublicResult(raw)), previewURL };
    }
    const data = value.data;
    switch (value.type) {
      case 'native.subscription': {
        if (!record(data) || !nativeId(data.subscriptionId)) return { kind: 'ignored' };
        let payload = null;
        if (nativeExact(data, ['subscriptionId', 'event'])) {
          try { validateEvent(data.event); payload = { subscriptionId: data.subscriptionId, event: data.event }; } catch { return { kind: 'ignored' }; }
        } else if (nativeExact(data, ['subscriptionId', 'status']) && nativeOnly(data.status, ['kind', 'state'], ['code', 'minimumSequence']) && data.status.kind === 'status' && NATIVE_STATUS.has(data.status.state)) {
          const status = { kind: 'status', state: data.status.state };
          if (typeof data.status.code === 'string' && NATIVE_CODE.test(data.status.code)) status.code = data.status.code;
          if (nativeInt(data.status.minimumSequence, 0, Number.MAX_SAFE_INTEGER)) status.minimumSequence = data.status.minimumSequence;
          payload = { subscriptionId: data.subscriptionId, status };
        } else return { kind: 'ignored' };
        const message = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'native.subscription', data: payload });
        return nativeBytes(message) <= NATIVE_LIMITS.rendererMessage ? { kind: 'deliver', message } : { kind: 'ignored' };
      }
      case 'native.pairing': {
        if (!record(data) || !nativeId(data.requestId)) return { kind: 'ignored' };
        const valid = nativeExact(data, ['requestId', 'challengeId', 'origin', 'purpose', 'expiresAt']) && nativeId(data.challengeId)
          && data.origin === 'https://ai.zuzunza.com' && typeof data.purpose === 'string' && NATIVE_PURPOSE.test(data.purpose) && nativeInt(data.expiresAt, 0, Number.MAX_SAFE_INTEGER);
        return valid ? { kind: 'pairing', requestId: data.requestId, purpose: data.purpose, expiresAt: data.expiresAt } : { kind: 'pairingInvalid', requestId: data.requestId };
      }
      case 'native.auth': {
        if (!record(data) || !nativeId(data.requestId)) return { kind: 'ignored' };
        // `experimental`/`official` are Core auth-method metadata. The shell never derives
        // the (exp!) badge from a provider or model name.
        const valid = nativeOnly(data, ['requestId', 'providerId', 'methodId', 'question', 'expiresAt'], ['official', 'experimental'])
          && typeof data.providerId === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(data.providerId) && nativeId(data.methodId)
          && nativeQuestion(data.question) && nativeInt(data.expiresAt, 0, Number.MAX_SAFE_INTEGER)
          && (!Object.hasOwn(data, 'official') || typeof data.official === 'boolean') && (!Object.hasOwn(data, 'experimental') || typeof data.experimental === 'boolean');
        return valid ? { kind: 'auth', requestId: data.requestId, providerId: data.providerId, methodId: data.methodId, question: data.question, expiresAt: data.expiresAt, experimental: data.experimental === true } : { kind: 'authInvalid', requestId: data.requestId };
      }
      case 'native.pairingClosed': case 'native.authClosed':
        return record(data) && nativeId(data.requestId) ? { kind: 'promptClosed', requestId: data.requestId } : { kind: 'ignored' };
      default: return { kind: 'ignored' };
    }
  },
  previewURL: nativePreviewURL,
});
