// Ollama native API adapter (loopback by default; NDJSON streaming).
import { assembleClient, pagedJson, prepare, probe, requestHeaders, resolveBase } from './base.mjs';
import { AdapterError } from './errors.mjs';
import { joinUrl } from './http.mjs';
import { httpStream } from './transport.mjs';
import { CATALOGS } from './models.mjs';
import * as Ollama from './protocols/ollama.mjs';

export function createOllamaAdapter(descriptor, context) {
  const prepared = prepare(descriptor, context, ['ollama']);
  const base = resolveBase(descriptor, prepared, prepared.context);
  // Local server: credential kind 'none' (secret headers allowed for a proxied local server).
  const headers = (accept, signal) => requestHeaders(prepared, { accept }, 'bearer', { required: false, signal });
  const fetchCatalog = async ({ signal } = {}) => {
    const entries = await pagedJson(prepared.context, () => joinUrl(base, Ollama.TAGS_PATH), await headers('application/json', signal), json => {
      if (!Array.isArray(json?.models)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
      return { entries: json.models };
    }, { signal });
    return entries.map(entry => CATALOGS.ollama(descriptor.id, entry));
  };
  return assembleClient(descriptor, prepared, {
    stream: async function* (request) {
      const body = Ollama.buildBody(request);
      const h = await headers('application/x-ndjson', request.signal);
      yield* httpStream(prepared.context, { url: joinUrl(base, Ollama.CHAT_PATH), headers: h, body, parse: Ollama.parse, signal: request.signal });
    },
    fetchCatalog,
    checkAuth: ({ signal }) => probe(fetchCatalog, signal),
  });
}
