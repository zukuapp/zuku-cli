// Anthropic Messages adapter (official Anthropic and custom Anthropic-compatible endpoints).
import { assembleClient, pagedJson, prepare, probe, requestHeaders, resolveBase } from './base.mjs';
import { joinUrl } from './http.mjs';
import { httpStream } from './transport.mjs';
import { CATALOGS } from './models.mjs';
import * as Messages from './protocols/anthropic-messages.mjs';

export function createAnthropicAdapter(descriptor, context) {
  const prepared = prepare(descriptor, context, ['anthropic']);
  const base = resolveBase(descriptor, prepared, prepared.context);
  const required = Boolean(prepared.builtin);
  const headers = (accept, signal) => requestHeaders(prepared, { accept, 'anthropic-version': Messages.API_VERSION }, 'x-api-key', { required, signal });
  const fetchCatalog = prepared.custom ? undefined : async ({ signal } = {}) => {
    const h = await headers('application/json', signal);
    const entries = await pagedJson(prepared.context, after => joinUrl(base, '/models', { limit: 1000, after_id: after }), h, Messages.catalogPage, { signal });
    return entries.map(entry => CATALOGS.anthropic(descriptor.id, entry));
  };
  return assembleClient(descriptor, prepared, {
    capabilities: { modelDiscovery: Boolean(fetchCatalog) },
    stream: async function* (request) {
      const body = Messages.buildBody(request, prepared.options);
      const h = await headers('text/event-stream', request.signal);
      yield* httpStream(prepared.context, { url: joinUrl(base, Messages.PATH), headers: h, body, parse: Messages.parse, signal: request.signal });
    },
    fetchCatalog,
    checkAuth: fetchCatalog ? ({ signal }) => probe(fetchCatalog, signal) : undefined,
  });
}
