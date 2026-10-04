// OpenAI-family adapters: Chat Completions (OpenAI, OpenRouter, LM Studio,
// OpenAI-compatible vendors, Cloudflare AI Gateway, custom), Responses (OpenAI,
// custom) and Azure OpenAI v1 (api-key header, deployment names as models).
import { fail } from './errors.mjs';
import { assembleClient, prepare, probe, resolveBase, requestHeaders, pagedJson } from './base.mjs';
import { joinUrl } from './http.mjs';
import { httpStream } from './transport.mjs';
import { CATALOGS } from './models.mjs';
import * as Chat from './protocols/openai-chat.mjs';
import * as Responses from './protocols/openai-responses.mjs';

/** Wire auth style and whether a credential is mandatory, from trusted metadata only. */
function authPolicy(prepared, style = 'bearer') {
  const local = prepared.builtin?.authMethods?.every(method => method.credential === 'none');
  return { style: prepared.builtin?.id === 'cloudflare-ai-gateway' ? 'cf-aig' : style, required: Boolean(prepared.builtin) && !local };
}

function cloudflareBase(options) {
  const account = options.accountId;
  const gateway = options.gatewayId ?? 'default';
  if (typeof account !== 'string' || !/^[a-f0-9]{32}$/.test(account) || typeof gateway !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(gateway)) fail('ADAPTER_INVALID_DESCRIPTOR');
  return `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/compat`;
}

function makeCatalog(descriptor, prepared, base, auth) {
  const catalog = prepared.custom ? (prepared.options.catalog === 'openai' ? 'openai' : 'none') : prepared.options.catalog;
  if (!catalog || catalog === 'none') return undefined;
  const map = CATALOGS[catalog];
  return async ({ signal } = {}) => {
    const headers = await requestHeaders(prepared, { accept: 'application/json' }, auth.style, { required: auth.required, signal });
    const entries = await pagedJson(prepared.context, () => joinUrl(base, '/models'), headers, json => ({ entries: Chat.catalogEntries(json) }), { signal });
    return entries.map(entry => map(descriptor.id, entry));
  };
}

function wire(protocol, prepared, base, auth, path, query) {
  return async function* (request) {
    const body = protocol.buildBody(request, prepared.options);
    const headers = await requestHeaders(prepared, { accept: 'text/event-stream' }, auth.style, { required: auth.required, signal: request.signal });
    yield* httpStream(prepared.context, { url: joinUrl(base, path, query), headers, body, parse: protocol.parse, signal: request.signal });
  };
}

function client(descriptor, prepared, base, auth, protocol, query) {
  const fetchCatalog = makeCatalog(descriptor, prepared, base, auth);
  return assembleClient(descriptor, prepared, {
    capabilities: { modelDiscovery: Boolean(fetchCatalog) },
    stream: wire(protocol, prepared, base, auth, protocol.PATH, query),
    fetchCatalog,
    checkAuth: fetchCatalog ? ({ signal }) => probe(fetchCatalog, signal) : undefined,
  });
}

export function createOpenAIChatAdapter(descriptor, context) {
  const prepared = prepare(descriptor, context, ['openai-chat']);
  const official = descriptor.id === 'cloudflare-ai-gateway' && !prepared.custom ? cloudflareBase(prepared.options) : undefined;
  const base = resolveBase(descriptor, prepared, prepared.context, official);
  return client(descriptor, prepared, base, authPolicy(prepared), Chat);
}

export function createOpenAIResponsesAdapter(descriptor, context) {
  const prepared = prepare(descriptor, context, ['openai-responses']);
  const base = resolveBase(descriptor, prepared, prepared.context);
  return client(descriptor, prepared, base, authPolicy(prepared), Responses);
}

const AZURE_HOST = /^[a-z0-9][a-z0-9-]{1,62}\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/i;
const API_VERSION = /^(v1|preview|\d{4}-\d{2}-\d{2}(-preview)?)$/;

function azureBase(descriptor, options) {
  if (typeof options.resourceName === 'string') {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/i.test(options.resourceName)) fail('ADAPTER_INVALID_DESCRIPTOR');
    return `https://${options.resourceName}.openai.azure.com/openai/v1`;
  }
  if (typeof descriptor.baseUrl === 'string') {
    let url;
    try { url = new URL(descriptor.baseUrl); } catch { fail('ADAPTER_ENDPOINT_REJECTED'); }
    if (url.protocol !== 'https:' || !AZURE_HOST.test(url.hostname) || url.pathname.replace(/\/+$/, '') !== '/openai/v1' || url.search || url.hash || url.username) fail('ADAPTER_ENDPOINT_REJECTED');
    return `${url.origin}/openai/v1`;
  }
  fail('ADAPTER_INVALID_DESCRIPTOR');
}

/** Azure OpenAI v1 API: {resource}/openai/v1, `api-key` header, model = deployment name. */
export function createAzureOpenAIAdapter(descriptor, context) {
  const prepared = prepare(descriptor, context, ['azure-openai']);
  const official = azureBase(descriptor, prepared.options);
  // The pinned Azure host is derived from user config on Azure-owned domains only.
  const base = resolveBase({ ...descriptor, baseUrl: undefined }, prepared, prepared.context, official);
  const apiVersion = prepared.options.apiVersion;
  if (apiVersion !== undefined && (typeof apiVersion !== 'string' || !API_VERSION.test(apiVersion))) fail('ADAPTER_INVALID_DESCRIPTOR');
  const mode = prepared.options.wire ?? 'responses';
  if (mode !== 'responses' && mode !== 'chat') fail('ADAPTER_INVALID_DESCRIPTOR');
  const azure = { ...prepared, options: { ...prepared.options, catalog: 'none', maxTokensField: 'max_completion_tokens' } };
  return client(descriptor, azure, base, { style: 'api-key', required: true }, mode === 'chat' ? Chat : Responses, apiVersion ? { 'api-version': apiVersion } : undefined);
}
