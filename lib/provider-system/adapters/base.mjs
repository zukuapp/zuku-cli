// Shared descriptor validation, endpoint policy, credential scoping and client
// assembly. Every factory goes through `prepare` before touching the network.
import { AdapterError, fail } from './errors.mjs';
import { builtinDescriptor, CUSTOM_API_TYPES } from './descriptors.mjs';
import { buildHeaders, rebaseForTest, validateBaseUrl, validModelId, getJson } from './http.mjs';
import { configuredModels, finalize } from './models.mjs';
import { normalizeRequest } from './request.mjs';
import { runStageOverStream } from './stage.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECRET_KEY = /^(api[-_]?key|key|token|access[-_]?token|secret|password|authorization|credentials?|bearer)$/i;
const SECRET_HEADER = /^(authorization|x-api-key|api-key|x-goog-api-key|cf-aig-authorization|proxy-authorization|cookie)$/i;
const SECRET_VALUE = /^[\x21-\x7e]{1,4096}$/;
const BEARER_VALUE = /^[\x21-\x7e]{8,16384}$/;
export const MAX_PAGES = 20;
const BUILTIN_OPTIONS = new Set(['headers', 'defaultModel', 'model', 'region', 'profile', 'project', 'location', 'resourceName', 'wire', 'apiVersion', 'accountId', 'gatewayId', 'defaultMaxOutputTokens']);
const CUSTOM_OPTIONS = new Set(['custom', 'allowLoopbackHttp', 'headers', 'defaultModel', 'model', 'catalog', 'maxTokensField', 'defaultMaxOutputTokens']);

function rejectEmbeddedSecrets(value, depth = 0) {
  if (depth > 4 || !record(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) fail('ADAPTER_INVALID_DESCRIPTOR');
    if (key === 'headers') {
      if (!record(inner)) fail('ADAPTER_HEADER_REJECTED');
      for (const name of Object.keys(inner)) if (SECRET_HEADER.test(name)) fail('ADAPTER_HEADER_REJECTED');
    } else rejectEmbeddedSecrets(inner, depth + 1);
  }
}

/** Validate the public descriptor (no secrets allowed in it). */
export function checkDescriptor(descriptor, apiTypes) {
  if (!record(descriptor) || !PROVIDER_ID.test(descriptor.id ?? '') || !apiTypes.includes(descriptor.apiType)) fail('ADAPTER_INVALID_DESCRIPTOR');
  if (descriptor.name !== undefined && (typeof descriptor.name !== 'string' || descriptor.name.length > 128 || /[\u0000-\u001f\u007f]/.test(descriptor.name))) fail('ADAPTER_INVALID_DESCRIPTOR');
  const options = descriptor.options ?? {};
  if (!record(options)) fail('ADAPTER_INVALID_DESCRIPTOR');
  rejectEmbeddedSecrets(options);
  if (descriptor.models !== undefined && (!Array.isArray(descriptor.models) || descriptor.models.length > 1000 || !descriptor.models.every(validModelId))) fail('ADAPTER_INVALID_DESCRIPTOR');
  const builtin = builtinDescriptor(descriptor.id);
  const custom = options.custom === true;
  if (builtin && custom) fail('ADAPTER_INVALID_DESCRIPTOR');
  if (!builtin && !custom) fail('ADAPTER_INVALID_DESCRIPTOR');
  if (custom && !CUSTOM_API_TYPES.includes(descriptor.apiType)) fail('ADAPTER_UNKNOWN_API_TYPE');
  // A built-in may switch between its vendor's own official wire APIs only.
  if (builtin && builtin.apiType !== descriptor.apiType && !(builtin.id === 'openai' && descriptor.apiType === 'openai-chat')) fail('ADAPTER_INVALID_DESCRIPTOR');
  // Wire knobs (auth header, catalog, extra body) stay adapter-owned; user config may set only these.
  const allowed = custom ? CUSTOM_OPTIONS : BUILTIN_OPTIONS;
  const picked = Object.fromEntries(Object.entries(options).filter(([key]) => allowed.has(key)));
  if (custom) {
    if (picked.catalog !== undefined && !['openai', 'none'].includes(picked.catalog)) fail('ADAPTER_INVALID_DESCRIPTOR');
    if (picked.maxTokensField !== undefined && !['max_tokens', 'max_completion_tokens'].includes(picked.maxTokensField)) fail('ADAPTER_INVALID_DESCRIPTOR');
    if (picked.allowLoopbackHttp !== undefined && typeof picked.allowLoopbackHttp !== 'boolean') fail('ADAPTER_INVALID_DESCRIPTOR');
  }
  if (picked.defaultMaxOutputTokens !== undefined && (!Number.isSafeInteger(picked.defaultMaxOutputTokens) || picked.defaultMaxOutputTokens < 1 || picked.defaultMaxOutputTokens > 1_000_000)) fail('ADAPTER_INVALID_DESCRIPTOR');
  for (const key of ['defaultModel', 'model']) if (picked[key] !== undefined && !validModelId(picked[key])) fail('ADAPTER_INVALID_DESCRIPTOR');
  return { builtin, custom, options: { ...(builtin?.options ?? {}), ...picked } };
}

/**
 * Resolve the endpoint base. Built-ins are pinned to their official HTTPS base
 * (or a template on official hosts). Custom endpoints must be explicit HTTPS, or
 * loopback HTTP with allowLoopbackHttp. context.testOrigin (tests only) rebases
 * the official path onto an explicit loopback origin.
 */
export function resolveBase(descriptor, { builtin, custom, options }, context, official) {
  if (context.testOrigin !== undefined) return rebaseForTest(official ?? descriptor.baseUrl ?? 'https://invalid.example/', context.testOrigin);
  if (custom) {
    if (typeof descriptor.baseUrl !== 'string') fail('ADAPTER_ENDPOINT_REJECTED');
    return validateBaseUrl(descriptor.baseUrl, { allowLoopbackHttp: options.allowLoopbackHttp === true });
  }
  const pinned = official ?? builtin.baseUrl;
  if (typeof pinned !== 'string') fail('ADAPTER_INVALID_DESCRIPTOR');
  const base = validateBaseUrl(pinned, { allowLoopbackHttp: builtin.options?.allowLoopbackHttp === true });
  // Local servers may be moved to another loopback port; any other override is refused.
  if (descriptor.baseUrl !== undefined && descriptor.baseUrl !== null && descriptor.baseUrl !== pinned) {
    if (builtin.options?.allowLoopbackHttp !== true) fail('ADAPTER_ENDPOINT_REJECTED');
    const moved = validateBaseUrl(descriptor.baseUrl, { allowLoopbackHttp: true });
    const url = new URL(moved);
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.pathname !== new URL(base).pathname) fail('ADAPTER_ENDPOINT_REJECTED');
    return moved;
  }
  return base;
}

const KINDS = new Set(['api-key', 'bearer', 'none', 'cloud-chain']);
const SAFE_CONTEXT = ['fetch', 'signal', 'timeouts', 'limits', 'testOrigin', 'importModule', 'googleAuth', 'nativeZuku', 'codexModules', 'codexStorePath', 'validateStageSchema', 'validateStageOutput'];

/**
 * Canonical private credential boundary:
 *   context.getCredentials({ signal }) → { kind: 'api-key', apiKey, headers? }
 *     | { kind: 'bearer', accessToken, headers? } | { kind: 'none', headers? }
 *     | { kind: 'cloud-chain', configuration }
 * Called once per network operation (rotation-safe). The value never leaves the
 * operation's closure: it is not stored on the client, in errors or in events.
 */
export async function credentials(prepared, signal) {
  const getter = prepared.getCredentials;
  if (getter === undefined) return { kind: 'none' };
  let value;
  try { value = await getter({ signal }); }
  catch (error) {
    if (signal?.aborted || prepared.context.signal?.aborted) throw new AdapterError('COMMAND_CANCELLED');
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('ADAPTER_CREDENTIALS_MISSING');
  }
  if (value === undefined || value === null) return { kind: 'none' };
  if (!record(value) || !KINDS.has(value.kind)) fail('ADAPTER_CREDENTIALS_INVALID');
  if (value.headers !== undefined && !record(value.headers)) fail('ADAPTER_HEADER_REJECTED');
  if (value.kind === 'api-key' && (typeof value.apiKey !== 'string' || !SECRET_VALUE.test(value.apiKey))) fail('ADAPTER_CREDENTIALS_INVALID');
  if (value.kind === 'bearer' && (typeof value.accessToken !== 'string' || !BEARER_VALUE.test(value.accessToken))) fail('ADAPTER_CREDENTIALS_INVALID');
  if (value.kind === 'cloud-chain') {
    if (value.configuration !== undefined && !record(value.configuration)) fail('ADAPTER_CREDENTIALS_INVALID');
    rejectEmbeddedSecrets(value.configuration ?? {});
  }
  return value;
}

/**
 * Credential → auth headers for one wire style. `style` is adapter-owned:
 * 'bearer' (Authorization), 'x-api-key', 'api-key', 'x-goog-api-key', 'cf-aig'.
 */
export function authHeaders(cred, style, { required, kinds }) {
  if (kinds && !kinds.includes(cred.kind)) fail(cred.kind === 'none' ? 'ADAPTER_CREDENTIALS_MISSING' : 'ADAPTER_CREDENTIALS_INVALID');
  if (cred.kind === 'none') { if (required) fail('ADAPTER_CREDENTIALS_MISSING'); return {}; }
  if (cred.kind === 'bearer') { if (style !== 'bearer') fail('ADAPTER_CREDENTIALS_INVALID'); return { authorization: `Bearer ${cred.accessToken}` }; }
  if (cred.kind !== 'api-key') fail('ADAPTER_CREDENTIALS_INVALID');
  if (style === 'x-api-key') return { 'x-api-key': cred.apiKey };
  if (style === 'api-key') return { 'api-key': cred.apiKey };
  if (style === 'x-goog-api-key') return { 'x-goog-api-key': cred.apiKey };
  if (style === 'cf-aig') return { 'cf-aig-authorization': `Bearer ${cred.apiKey}` };
  return { authorization: `Bearer ${cred.apiKey}` };
}

/** Headers for one request: fixed + credential auth + public descriptor headers + secret credential headers. */
export async function requestHeaders(prepared, fixed, style, { required, kinds, signal }) {
  const cred = await credentials(prepared, signal);
  return buildHeaders({ ...fixed, ...authHeaders(cred, style, { required, kinds }) }, prepared.options.headers, cred.headers);
}

export function prepare(descriptor, context, apiTypes) {
  if (!record(context)) fail('ADAPTER_INVALID_DESCRIPTOR');
  if (context.signal !== undefined && !(context.signal instanceof AbortSignal)) fail('ADAPTER_INVALID_DESCRIPTOR');
  if (context.fetch !== undefined && typeof context.fetch !== 'function') fail('ADAPTER_INVALID_DESCRIPTOR');
  if (context.getCredentials !== undefined && typeof context.getCredentials !== 'function') fail('ADAPTER_INVALID_DESCRIPTOR');
  const prepared = checkDescriptor(descriptor, apiTypes);
  // Only operational seams are kept; credential getters stay out of `context`.
  const safe = Object.fromEntries(SAFE_CONTEXT.filter(key => context[key] !== undefined).map(key => [key, context[key]]));
  return { ...prepared, getCredentials: context.getCredentials, context: { ...safe, fetch: context.fetch ?? globalThis.fetch } };
}

const CUSTOM_AUTH = Object.freeze([{ id: 'custom-endpoint', type: 'custom', name: '사용자 지정 엔드포인트', official: false, experimental: true, credential: 'api-key' }]);
// Status derives from trusted method metadata only: unofficial === !official, and
// anything not official is experimental. Built-in metadata cannot be overridden.
const publicAuthMethods = (descriptor, prepared) => {
  const methods = prepared.builtin?.authMethods ?? (Array.isArray(descriptor.authMethods) && descriptor.authMethods.length ? descriptor.authMethods : CUSTOM_AUTH);
  return Object.freeze(methods.map(method => {
    const official = prepared.builtin ? method.official === true : false;
    return Object.freeze({ id: method.id, type: method.type, name: method.name, official, experimental: !official || method.experimental === true, unofficial: !official, ...(method.credential ? { credential: method.credential } : {}) });
  }));
};

/**
 * Assemble the client contract. `parts` supplies: stream(request) (normalized,
 * validated request), fetchCatalog({signal}) or undefined, checkAuth({signal}).
 */
export function assembleClient(descriptor, prepared, parts) {
  const id = descriptor.id;
  const capabilities = Object.freeze({ ...(prepared.builtin?.capabilities ?? {}), ...(descriptor.capabilities ?? {}), ...(parts.capabilities ?? {}) });
  const defaultModel = prepared.options.defaultModel ?? prepared.options.model;
  // Lazy: validation, credential lookup and the request all happen on first next().
  const stream = async function* (request) {
    const normalized = normalizeRequest(request, { defaultModel });
    const events = parts.stream(normalized);
    yield* normalized.includeReasoning ? events : privateReasoning(events);
  };
  return Object.freeze({
    id,
    name: descriptor.name ?? prepared.builtin?.name ?? id,
    authMethods: publicAuthMethods(descriptor, prepared),
    capabilities,
    async listModels(options = {}) {
      if (!parts.fetchCatalog) return configuredModels(id, descriptor.models ?? prepared.builtin?.models);
      const remote = finalize(await parts.fetchCatalog({ signal: options.signal, refresh: options.refresh === true }));
      return remote;
    },
    async validateAuth(options = {}) {
      return parts.checkAuth ? parts.checkAuth({ signal: options.signal }) : { ok: null, reason: 'no-read-endpoint' };
    },
    stream,
    async runStage(stageRequest) {
      if (parts.runStage) return parts.runStage(stageRequest);
      if (capabilities.stage === false) throw new AdapterError('ADAPTER_UNSUPPORTED');
      return runStageOverStream({ provider: id, stream, context: prepared.context, stageRequest, defaultModel, structured: capabilities.structuredOutput !== false });
    },
  });
}

/**
 * Private chain-of-thought never leaves the adapter by default: reasoning text is
 * replaced by one text-free { type: 'reasoning-status', status: 'reasoning' } per
 * contiguous reasoning segment. Only a private codec consumer that passes
 * request.includeReasoning === true receives 'reasoning-delta' text.
 */
async function* privateReasoning(events) {
  let inReasoning = false;
  for await (const event of events) {
    if (event.type === 'reasoning-delta') {
      if (!inReasoning) { inReasoning = true; yield { type: 'reasoning-status', status: 'reasoning' }; }
      continue;
    }
    inReasoning = false;
    yield event;
  }
}

/** Read-only auth probe through a catalog GET; never an inference call. */
export async function probe(fetchCatalog, signal) {
  try {
    await fetchCatalog({ signal });
    return { ok: true };
  } catch (error) {
    if (error instanceof AdapterError && (error.code === 'PROVIDER_AUTH_FAILED' || error.code === 'PROVIDER_FORBIDDEN' || error.code === 'ADAPTER_CREDENTIALS_MISSING')) return { ok: false, code: error.code };
    throw error;
  }
}

/** Paged GET helper with fixed page/size bounds. */
export async function pagedJson(context, makeUrl, headers, extract, { signal } = {}) {
  const entries = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const json = await getJson(context, makeUrl(cursor), headers, { signal });
    const { entries: chunk, next } = extract(json);
    entries.push(...chunk);
    if (!next || next === cursor) return entries;
    cursor = next;
  }
  return entries;
}

export { buildHeaders };
