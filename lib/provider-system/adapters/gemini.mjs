// Google adapters over the generateContent wire protocol:
// - Gemini API (generativelanguage.googleapis.com, x-goog-api-key)
// - Vertex AI (aiplatform.googleapis.com, OAuth bearer from Application Default
//   Credentials via the official google-auth-library, loaded lazily).
import { AdapterError, fail } from './errors.mjs';
import { assembleClient, buildHeaders, credentials, pagedJson, prepare, probe, requestHeaders, resolveBase } from './base.mjs';
import { joinUrl, segment } from './http.mjs';
import { httpStream } from './transport.mjs';
import { CATALOGS } from './models.mjs';
import { abortable, loadSdk } from './sdk.mjs';
import * as Gemini from './protocols/gemini.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const page = key => json => {
  if (!record(json)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
  const entries = json[key] ?? [];
  if (!Array.isArray(entries)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
  return { entries, next: typeof json.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : undefined };
};

export function createGeminiAdapter(descriptor, context) {
  const prepared = prepare(descriptor, context, ['gemini']);
  const base = resolveBase(descriptor, prepared, prepared.context);
  // Key travels in the x-goog-api-key header, never in the URL query.
  const headers = (accept, signal) => requestHeaders(prepared, { accept }, 'x-goog-api-key', { required: true, signal });
  const fetchCatalog = async ({ signal } = {}) => {
    const entries = await pagedJson(prepared.context, token => joinUrl(base, '/models', { pageSize: 1000, pageToken: token }), await headers('application/json', signal), page('models'), { signal });
    return entries.map(entry => CATALOGS.gemini(descriptor.id, entry));
  };
  return assembleClient(descriptor, prepared, {
    stream: async function* (request) {
      const body = Gemini.buildBody(request);
      const h = await headers('text/event-stream', request.signal);
      yield* httpStream(prepared.context, { url: joinUrl(base, Gemini.streamPath(request.model), Gemini.STREAM_QUERY), headers: h, body, parse: Gemini.parse, signal: request.signal });
    },
    fetchCatalog,
    checkAuth: ({ signal }) => probe(fetchCatalog, signal),
  });
}

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Regional endpoint selection as in googleapis/js-genai _api_client.ts. */
export function vertexBase(location) {
  if (location === 'global') return 'https://aiplatform.googleapis.com';
  if (location === 'us' || location === 'eu') return `https://aiplatform.${location}.rep.googleapis.com`;
  return `https://${location}-aiplatform.googleapis.com`;
}

export function createVertexAdapter(descriptor, context) {
  const prepared = prepare(descriptor, context, ['vertex']);
  const { project, location = 'global' } = prepared.options;
  if (typeof project !== 'string' || !PROJECT.test(project) || typeof location !== 'string' || !LOCATION.test(location)) fail('ADAPTER_INVALID_DESCRIPTOR');
  const base = resolveBase({ ...descriptor, baseUrl: undefined }, prepared, prepared.context, vertexBase(location));
  let adc;
  // Credential kinds: 'cloud-chain' → Application Default Credentials through the
  // official google-auth-library (instantiated only here, on first use of this
  // explicitly selected provider); 'bearer' → an access token supplied by the core.
  const token = async (cred, signal) => {
    if (cred.kind === 'bearer') return cred.accessToken;
    if (cred.kind !== 'cloud-chain') fail(cred.kind === 'none' ? 'ADAPTER_CREDENTIALS_MISSING' : 'ADAPTER_CREDENTIALS_INVALID');
    try {
      if (!adc) {
        if (prepared.context.googleAuth) adc = prepared.context.googleAuth;
        else {
          const { GoogleAuth } = await loadSdk(prepared.context, 'google-auth-library');
          if (typeof GoogleAuth !== 'function') throw new AdapterError('ADAPTER_SDK_UNAVAILABLE');
          adc = new GoogleAuth({ scopes: [VERTEX_SCOPE] });
        }
      }
      const value = await abortable(Promise.resolve(adc.getAccessToken()), signal ?? prepared.context.signal);
      const text = typeof value === 'string' ? value : value?.token;
      if (typeof text !== 'string' || !/^[\x21-\x7e]{8,16384}$/.test(text)) throw new AdapterError('ADAPTER_CREDENTIALS_MISSING');
      return text;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      // ADC errors can include file paths or account names; never surface them.
      throw new AdapterError(/default credentials|could not load|not found|ENOENT/i.test(String(error?.message ?? '').slice(0, 512)) ? 'ADAPTER_CREDENTIALS_MISSING' : 'PROVIDER_AUTH_FAILED');
    }
  };
  const headers = async (accept, signal) => {
    const cred = await credentials(prepared, signal);
    return buildHeaders({ accept, authorization: `Bearer ${await token(cred, signal)}`, 'x-goog-user-project': project }, prepared.options.headers, cred.headers);
  };
  const fetchCatalog = async ({ signal } = {}) => {
    const h = await headers('application/json', signal);
    const entries = await pagedJson(prepared.context, next => joinUrl(base, '/v1beta1/publishers/google/models', { pageSize: 1000, pageToken: next }), h, page('publisherModels'), { signal });
    return entries.map(entry => CATALOGS.vertex(descriptor.id, entry));
  };
  const modelPath = model => `/v1/projects/${segment(project)}/locations/${segment(location)}/publishers/google/models/${segment(model)}:streamGenerateContent`;
  return assembleClient(descriptor, prepared, {
    stream: async function* (request) {
      const body = Gemini.buildBody(request);
      const h = await headers('text/event-stream', request.signal);
      yield* httpStream(prepared.context, { url: joinUrl(base, modelPath(request.model), Gemini.STREAM_QUERY), headers: h, body, parse: Gemini.parse, signal: request.signal });
    },
    fetchCatalog,
    checkAuth: ({ signal }) => probe(fetchCatalog, signal),
  });
}
