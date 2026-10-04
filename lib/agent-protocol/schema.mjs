// This codec deliberately has no Node, filesystem, provider or credential imports.
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_ID = 'zuku-agent/1';
export const LIMITS = Object.freeze({ requestBytes: 65536, eventBytes: 32768, textBytes: 8192, depth: 12, promptChars: 4000 });
export class ProtocolError extends Error {
  constructor(code) { super(code); this.name = 'ProtocolError'; this.code = code; }
}
const fail = code => { throw new ProtocolError(code); };
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,63}$/;
const ADDRESS = /^[a-z][a-z0-9_-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,254}$/;
const SHA = /^[a-f0-9]{64}$/;
const SECRET_KEY = /^(?:__proto__|prototype|constructor|apiKey|api_key|access_token|refresh_token|id_token|authorization|cookie|credentials|environment|env|shell|argv|executable)$/i;
const SECRET_TEXT = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|zuku_o[adr]_[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~-]{16,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
export function hasSecret(value) { return typeof value === 'string' && SECRET_TEXT.test(value); }
function inspect(value, depth = 0, seen = new Set()) {
  if (depth > LIMITS.depth) fail('INVALID_INPUT');
  if (typeof value === 'string') { if (hasSecret(value) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('INVALID_INPUT'); return; }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !record(value) || seen.has(value)) fail('INVALID_INPUT');
  seen.add(value);
  if (Object.keys(value).length > 1024) fail('INVALID_INPUT');
  for (const [key, entry] of Object.entries(value)) { if (SECRET_KEY.test(key)) fail('INVALID_INPUT'); inspect(entry, depth + 1, seen); }
  seen.delete(value);
}
const string = (max, pattern) => value => typeof value === 'string' && value.length > 0 && value.length <= max && (!pattern || pattern.test(value));
const id = string(128, ID), provider = string(64, PROVIDER), address = string(320, ADDRESS);
const bool = value => typeof value === 'boolean';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const oneOf = (...choices) => value => choices.includes(value);
export function relativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\\:\x00-\x1f]/.test(value)
    && value.split('/').every(part => part && part !== '..' && part !== '.' && !part.startsWith('.') && !/^(?:node_modules|credentials?|secrets?)$/i.test(part));
}
const obj = value => record(value);
export const OPERATIONS = Object.freeze(['game.init', 'game.maintain', 'game.build', 'game.test', 'game.run', 'game.stop', 'game.preview']);
export const METHODS = Object.freeze({
  hello: { required: {}, optional: { clientVersion: string(40) } },
  'project.list': { required: {}, optional: {} },
  'project.grant': { required: { localPath: string(4096) }, optional: { name: string(120), purpose: oneOf('game.init', 'game.maintain'), request: string(4000) }, native: true },
  'project.read': { required: { projectHandle: id, path: relativePath }, optional: {} },
  'project.patch': { required: { projectHandle: id, path: relativePath, content: value => typeof value === 'string' && bytes(value) <= 49152, expectedSha256: string(64, SHA) }, optional: {} },
  'project.search': { required: { projectHandle: id, query: string(256) }, optional: { path: relativePath } },
  'session.create': { required: { projectHandle: id }, optional: { mode: oneOf('local', 'draft', 'yolo'), modelAddress: address } },
  'session.list': { required: {}, optional: { projectHandle: id } },
  'session.get': { required: { sessionId: id }, optional: {} },
  'session.input': { required: { sessionId: id, requestId: id, operation: oneOf(...OPERATIONS), request: string(LIMITS.promptChars) }, optional: { modelAddress: address, name: string(64, /^[a-z0-9][a-z0-9_-]{0,63}$/), experimental: bool, resume: string(64, /^run_[0-9]{14}_[a-f0-9]{8}$/) } },
  'session.cancel': { required: { sessionId: id }, optional: { requestId: id } },
  'session.close': { required: { sessionId: id }, optional: {} },
  'provider.list': { required: {}, optional: {} },
  'provider.use': { required: { providerId: provider }, optional: {} },
  'provider.add': { required: { config: obj }, optional: {}, native: true },
  'provider.configure': { required: { providerId: provider, patch: obj }, optional: {}, native: true },
  'provider.remove': { required: { providerId: provider }, optional: {}, native: true },
  'provider.enable': { required: { providerId: provider }, optional: {}, native: true },
  'provider.disable': { required: { providerId: provider }, optional: {}, native: true },
  'model.list': { required: {}, optional: { providerId: provider, refresh: bool } },
  'model.info': { required: { modelAddress: address }, optional: { refresh: bool } },
  'model.use': { required: { modelAddress: address }, optional: {} },
  'auth.list': { required: {}, optional: {} },
  'auth.request': { required: { providerId: provider }, optional: { methodId: id, experimental: bool } },
  'auth.logout': { required: { providerId: provider }, optional: {} },
  'game.run': { required: { projectHandle: id }, optional: {} },
  'game.stop': { required: { projectHandle: id }, optional: {} },
  'game.preview': { required: { projectHandle: id }, optional: {} },
  'preview.info': { required: { previewHandle: id }, optional: {} },
  'preview.read': { required: { previewHandle: id, path: relativePath }, optional: { offset: integer, length: value => Number.isSafeInteger(value) && value > 0 && value <= 49152 } },
  'studio.open': { required: {}, optional: { projectHandle: id } },
});
function shape(value, required, optional) {
  if (!record(value) || Object.keys(value).some(key => !Object.hasOwn(required, key) && !Object.hasOwn(optional, key))) fail('INVALID_INPUT');
  for (const [key, check] of Object.entries(required)) if (!Object.hasOwn(value, key) || !check(value[key])) fail('INVALID_INPUT');
  for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(value, key) && !check(value[key])) fail('INVALID_INPUT');
}
export function validateRequest(envelope, { native = false } = {}) {
  if (!record(envelope) || envelope.protocolVersion !== PROTOCOL_VERSION) fail('PROTOCOL_MISMATCH');
  try { if (bytes(envelope) > LIMITS.requestBytes) fail('BODY_TOO_LARGE'); } catch (error) { if (error instanceof ProtocolError) throw error; fail('INVALID_INPUT'); }
  inspect(envelope);
  shape(envelope, { protocolVersion: value => value === 1, id, method: value => Object.hasOwn(METHODS, value), params: obj }, {});
  const method = METHODS[envelope.method];
  if (method.native && !native) fail('NATIVE_PERMISSION_REQUIRED');
  shape(envelope.params, method.required, method.optional);
  if (envelope.method === 'provider.add') shape(envelope.params.config, { id: provider, apiType: oneOf('openai-chat', 'openai-responses', 'anthropic-messages'), baseUrl: string(2048) }, { name: string(120), model: string(255), apiKeyEnv: string(128, /^[A-Z][A-Z0-9_]*$/), enabled: bool });
  if (envelope.method === 'provider.configure') shape(envelope.params.patch, {}, { baseUrl: string(2048), name: string(120), apiType: oneOf('openai-chat', 'openai-responses', 'anthropic-messages'), defaultModel: string(255), apiKeyEnv: string(128, /^[A-Z][A-Z0-9_]*$/), addModels: value => Array.isArray(value) && value.length <= 64 && value.every(entry => record(entry) && Object.keys(entry).every(key => key === 'id') && string(255)(entry.id)), removeModels: value => Array.isArray(value) && value.length <= 64 && value.every(string(255)), options: value => record(value) && Object.keys(value).every(key => ['region', 'projectId', 'location', 'deployment', 'apiVersion'].includes(key)) && Object.values(value).every(string(128)) });
  return envelope;
}
const status = oneOf('idle', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'closed', 'needs_auth', 'needs_local_permission');
const capability = oneOf('project.read', 'project.write', 'project.patch', 'project.search', 'zuku.build', 'zuku.test', 'zuku.run', 'zuku.stop', 'asset.inspect', 'docs.search', 'game.preview');
const safeText = value => typeof value === 'string' && bytes(value) <= LIMITS.textBytes;
const code = string(64, /^[A-Z][A-Z0-9_]*$/);
const digests = value => record(value) && Object.keys(value).every(key => ['source', 'package', 'skills'].includes(key)) && Object.values(value).every(string(64, SHA));
const usage = value => record(value) && Object.keys(value).every(key => ['inputTokens', 'outputTokens', 'totalTokens', 'modelCalls'].includes(key)) && Object.values(value).every(integer);
const auth = value => record(value) && Object.keys(value).every(key => ['id', 'official', 'experimental'].includes(key)) && id(value.id) && bool(value.official) && bool(value.experimental);
const tool = { callId: id, capability }; const toolOptional = { path: relativePath, beforeSha256: string(64, SHA), afterSha256: string(64, SHA), status: oneOf('passed', 'failed', 'started', 'requested'), code };
export const EVENTS = Object.freeze({
  'session.created': [{ projectHandle: id, state: status }, {}],
  'session.closed': [{ projectHandle: id, state: status }, {}],
  'agent.started': [{ operation: oneOf(...OPERATIONS), requestId: id }, { modelAddress: address, authMethod: auth, skillSha256: string(64, SHA) }],
  'agent.delta': [{ text: safeText, blockId: id }, {}],
  'agent.reasoning_status': [{ phase: oneOf('analyzing', 'editing', 'building', 'testing', 'repairing', 'verifying') }, {}],
  'agent.completed': [{ status, verified: bool }, { runId: id, digests, evidenceIds: value => Array.isArray(value) && value.length <= 64 && value.every(id), usage, published: bool, contentId: id }],
  'agent.cancelled': [{ code, state: status }, {}],
  'agent.error': [{ code, state: status }, { action: oneOf('login', 'update', 'retry', 'inspect_project', 'recover_deployment') }],
  'tool.requested': [tool, toolOptional], 'tool.started': [tool, toolOptional], 'tool.completed': [tool, toolOptional], 'tool.failed': [tool, toolOptional],
  'build.started': [{ buildId: id, scriptId: id }, {}],
  'build.output': [{ buildId: id, stream: oneOf('stdout', 'stderr'), text: safeText }, {}],
  'build.completed': [{ buildId: id, exitCode: value => Number.isSafeInteger(value) && value >= -1 && value <= 255, status: oneOf('passed', 'failed') }, { evidenceId: id, sourceSha256: string(64, SHA) }],
  'game.started': [{ gameHandle: id, state: oneOf('running') }, {}],
  'game.stopped': [{ gameHandle: id, state: oneOf('stopped') }, { code }],
  'preview.started': [{ previewHandle: id, version: integer }, {}],
  'preview.updated': [{ previewHandle: id, version: integer }, {}],
  'provider.changed': [{ scope: oneOf('global', 'session'), providerId: provider, revision: integer }, { modelAddress: address, authMethod: auth }],
  'model.changed': [{ scope: oneOf('global', 'session'), modelAddress: address, revision: integer }, { authMethod: auth }],
  'auth.required': [{ providerId: provider, reason: code, action: oneOf('login') }, { methodId: id }],
  'permission.required': [{ grantId: id, purpose: oneOf('project', 'auth', 'browser'), expiresAt: integer, localApproval: value => value === true }, {}],
});
export function validateEvent(event) {
  inspect(event);
  shape(event, { protocolVersion: value => value === 1, sessionId: id, sequence: value => Number.isSafeInteger(value) && value > 0, eventId: id, time: value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value), type: value => Object.hasOwn(EVENTS, value), data: obj }, {});
  shape(event.data, ...EVENTS[event.type]);
  if (bytes(event) > LIMITS.eventBytes) fail('EVENT_TOO_LARGE');
  return event;
}
export function sanitizeText(value, { roots = [], secrets = [] } = {}) {
  let text = typeof value === 'string' ? value : '';
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  for (const literal of [...roots, ...secrets].filter(value => typeof value === 'string' && value.length >= 4).sort((a, b) => b.length - a.length)) text = text.split(literal).join('[redacted]');
  if (hasSecret(text) || /(?:\b(?:access|refresh|id)_token|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]{8,}/i.test(text)) return '[redacted]';
  text = text.replace(/(?:[A-Za-z]:[\\/]|\/(?:home|root|Users|etc|var|tmp|srv|opt)\/)[^\s"'<>]+/g, '[local path]');
  return text;
}
const SAFE_CODES = new Set(['INVALID_INPUT', 'BODY_TOO_LARGE', 'PROTOCOL_MISMATCH', 'NATIVE_PERMISSION_REQUIRED', 'PERMISSION_REQUIRED', 'PROJECT_NOT_FOUND', 'PROJECT_CHANGED', 'PROJECT_LIMIT', 'SESSION_NOT_FOUND', 'SESSION_BUSY', 'SESSION_LIMIT', 'REQUEST_CONFLICT', 'REQUEST_LIMIT', 'CURSOR_EXPIRED', 'INVALID_CURSOR', 'SLOW_SUBSCRIBER', 'CORE_CLOSED', 'CORE_NOT_RUNNING', 'CORE_STATE_UNSAFE', 'CORE_ALREADY_RUNNING', 'CORE_AUTH_REQUIRED', 'CORE_UNAVAILABLE', 'COMMAND_CANCELLED', 'AGENT_REQUEST_OUT_OF_SCOPE', 'AGENT_PROVIDER_UNAVAILABLE', 'NATIVE_STAGE_UNAVAILABLE', 'AUTH_REQUIRED', 'AUTH_EXPERIMENTAL_OPT_IN', 'AUTH_METHOD_UNSUPPORTED', 'MODEL_NOT_FOUND', 'MODEL_UNAVAILABLE', 'PROVIDER_NOT_FOUND', 'PROVIDER_DISABLED', 'ADAPTER_UNAVAILABLE', 'AGENT_GATE_FAILED', 'AGENT_SOURCE_CHANGED', 'AGENT_PLAYTEST_FAILED', 'AGENT_PLAYTEST_UNAVAILABLE', 'AGENT_PLAYTEST_SANDBOX', 'AGENT_PUBLISH_OUTCOME_UNKNOWN', 'AGENT_RECOVERY_REQUIRED', 'DEPLOY_QUOTA_EXCEEDED', 'TOOL_UNAVAILABLE', 'STUDIO_NOT_RUNNING']);
for (const code of ['PAIRING_PENDING', 'PAIRING_DENIED', 'PAIRING_EXPIRED', 'PAIRING_INVALID', 'PAIRING_REPLAY', 'PAIRING_BUSY', 'PAIRING_LIMIT', 'INVALID_TOKEN', 'TOKEN_EXPIRED', 'HOST_REJECTED', 'ORIGIN_REJECTED', 'REQUEST_REPLAY', 'INVALID_SEQUENCE', 'STREAM_LIMIT', 'EVENTS_EXPIRED', 'EXPERIMENTAL_REQUIRED', 'OPERATION_UNAVAILABLE']) SAFE_CODES.add(code);
for (const code of ['AUTH_BUSY', 'AUTH_SECRET_INVALID', 'AUTH_PROMPT_TIMEOUT', 'NATIVE_PROMPTER_BUSY']) SAFE_CODES.add(code);
export function safeError(error) {
  const result = { code: SAFE_CODES.has(error?.code) ? error.code : 'CORE_OPERATION_FAILED' };
  if (['AUTH_REQUIRED', 'AGENT_PROVIDER_UNAVAILABLE'].includes(result.code)) result.action = 'login';
  if (['PROTOCOL_MISMATCH'].includes(result.code)) result.action = 'update';
  if (['AGENT_RECOVERY_REQUIRED', 'AGENT_PUBLISH_OUTCOME_UNKNOWN'].includes(result.code)) result.action = 'recover_deployment';
  if (Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs >= 0 && error.retryAfterMs <= 21600000) result.retryAfterMs = error.retryAfterMs;
  return result;
}
// Public result projection accepts only a bounded, explicit metadata vocabulary.
const PUBLIC_KEYS = new Set(['id', 'projectHandle', 'previewHandle', 'sessionId', 'requestId', 'runId', 'name', 'path', 'content', 'sha256', 'expectedSha256', 'bytes', 'offset', 'length', 'complete', 'entry', 'sourceSha256', 'matches', 'line', 'text', 'projects', 'sessions', 'providers', 'models', 'authMethods', 'auth', 'available', 'provider', 'providerId', 'model', 'modelId', 'modelAddress', 'activeProvider', 'activeModel', 'defaultProvider', 'defaultModel', 'enabled', 'authenticated', 'official', 'experimental', 'unofficial', 'native', 'builtin', 'custom', 'local', 'active', 'method', 'type', 'status', 'state', 'operation', 'mode', 'result', 'protocolVersion', 'product', 'cliVersion', 'studioVersion', 'agentVersion', 'capabilities', 'streaming', 'tools', 'vision', 'reasoning', 'modelDiscovery', 'promptCaching', 'stageInference', 'contextWindow', 'maxOutputTokens', 'source', 'cached', 'stale', 'revision', 'sequence', 'minimumSequence', 'accepted', 'cancelled', 'closed', 'verified', 'published', 'contentId', 'digests', 'package', 'skills', 'evidenceIds', 'usage', 'inputTokens', 'outputTokens', 'totalTokens', 'modelCalls', 'exitCode', 'scriptId', 'code', 'action', 'remaining', 'version', 'mimeType', 'encoding', 'data', 'reason', 'classification', 'signals', 'count', 'createdAt', 'updatedAt', 'displayName', 'address']);
for (const key of ['requests', 'authRequestId', 'methodId']) PUBLIC_KEYS.add(key);
export function projectPublicResult(value, options = {}, depth = 0) {
  if (depth > LIMITS.depth) return null;
  if (typeof value === 'string') return sanitizeText(value, options).slice(0, 65536);
  if (typeof value === 'boolean' || value === null || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.slice(0, 1024).map(entry => projectPublicResult(entry, options, depth + 1));
  if (!record(value)) return null;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PUBLIC_KEYS.has(key) || key === 'path' && !relativePath(entry) || key === 'content' && typeof entry !== 'string') continue;
    out[key] = projectPublicResult(entry, options, depth + 1);
  }
  return out;
}
