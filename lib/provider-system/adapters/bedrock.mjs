// AWS Bedrock adapter. ConverseStream and the model catalog go through the
// official AWS SDK v3 clients, which own SigV4 signing, the default credential
// provider chain and AWS event-stream decoding. maxAttempts is pinned to 1:
// no automatic retry of a (paid) inference call.
import { AdapterError, fail } from './errors.mjs';
import { PROVIDER_OPTION_CHECKS } from '../../agent-protocol/schema.mjs';
import { assembleClient, buildHeaders, credentials, MAX_PAGES, prepare } from './base.mjs';
import { isLoopbackHost, resolveTimeouts } from './http.mjs';
import { StreamGuard } from './request.mjs';
import { abortable, loadSdk } from './sdk.mjs';
import { CATALOGS } from './models.mjs';
import * as Converse from './protocols/bedrock-converse.mjs';

const validRegion = PROVIDER_OPTION_CHECKS.region;
const PROFILE = /^[A-Za-z0-9_.+=,@-]{1,64}$/;

export function createBedrockAdapter(descriptor, context) {
  const prepared = prepare(descriptor, context, ['bedrock']);
  const { region, profile } = prepared.options;
  if (region !== undefined && !validRegion(region)) fail('ADAPTER_INVALID_DESCRIPTOR');
  if (profile !== undefined && (typeof profile !== 'string' || !PROFILE.test(profile))) fail('ADAPTER_INVALID_DESCRIPTOR');
  let endpoint;
  if (prepared.context.testOrigin !== undefined) {
    const url = new URL(prepared.context.testOrigin);
    if (!isLoopbackHost(url.hostname) || url.pathname !== '/' || url.search || url.username) fail('ADAPTER_ENDPOINT_REJECTED');
    endpoint = url.origin;
  } else if (descriptor.baseUrl !== undefined && descriptor.baseUrl !== null) fail('ADAPTER_ENDPOINT_REJECTED');
  const timeouts = resolveTimeouts(prepared.context.timeouts);
  // Core selects either its scoped Bedrock API key or the AWS chain. The SDK
  // resolves chain keys (env, shared config/SSO, IMDS/ECS) inside the operation.
  const chainConfig = async signal => {
    const cred = await credentials(prepared, signal);
    if (!['cloud-chain', 'api-key'].includes(cred.kind)) fail(cred.kind === 'none' ? 'ADAPTER_CREDENTIALS_MISSING' : 'ADAPTER_CREDENTIALS_INVALID');
    const r = cred.configuration?.region ?? region;
    const p = cred.configuration?.profile ?? profile;
    if (r !== undefined && !validRegion(r)) fail('ADAPTER_CREDENTIALS_INVALID');
    if (p !== undefined && (typeof p !== 'string' || !PROFILE.test(p))) fail('ADAPTER_CREDENTIALS_INVALID');
    const headers = buildHeaders({ authorization: 'reserved', 'x-amz-date': 'reserved', 'x-amz-security-token': 'reserved' }, prepared.options.headers, cred.headers);
    for (const name of ['authorization', 'x-amz-date', 'x-amz-security-token']) headers.delete(name);
    return { region: r, profile: p, ...(cred.kind === 'api-key' ? { token: cred.apiKey } : {}), headers: Object.fromEntries(headers) };
  };
  // One SDK client per operation, destroyed afterwards: the runtime client keeps
  // an HTTP/2 session open, which would otherwise hold the CLI process alive.
  const client = async (pkg, ctor, signal) => {
    const chain = await chainConfig(signal);
    const sdk = await loadSdk(prepared.context, pkg);
    if (typeof sdk[ctor] !== 'function') throw new AdapterError('ADAPTER_SDK_UNAVAILABLE');
    const config = { maxAttempts: 1, requestHandler: { connectionTimeout: timeouts.connectMs, requestTimeout: timeouts.idleMs } };
    if (chain.region) config.region = chain.region;
    if (chain.profile) config.profile = chain.profile;
    // The official SDK's bearer signer owns Bedrock API-key authentication.
    // Never put the token in process.env or a public descriptor.
    if (chain.token) { config.token = { token: chain.token }; config.authSchemePreference = ['httpBearerAuth']; config.credentials = async () => { throw new AdapterError('ADAPTER_CREDENTIALS_INVALID'); }; }
    if (endpoint) config.endpoint = endpoint;
    const c = new sdk[ctor](config);
    if (Object.keys(chain.headers).length) {
      c.middlewareStack.add(next => async args => {
        for (const [name, value] of Object.entries(chain.headers)) {
          if (Object.keys(args.request.headers).some(fixed => fixed.toLowerCase() === name)) fail('ADAPTER_HEADER_REJECTED');
          args.request.headers[name] = value;
        }
        return next(args);
      }, { step: 'build', name: 'zukuProviderHeaders', priority: 'low' });
    }
    return { client: c, sdk };
  };
  const send = async (pkg, ctor, command, input, signal) => {
    const { client: c, sdk } = await client(pkg, ctor, signal);
    const controller = new AbortController();
    const signals = [prepared.context.signal, signal].filter(Boolean);
    const onAbort = () => controller.abort();
    for (const s of signals) { if (s.aborted) controller.abort(); else s.addEventListener('abort', onAbort, { once: true }); }
    const total = setTimeout(onAbort, timeouts.totalMs);
    const done = () => { clearTimeout(total); for (const s of signals) s.removeEventListener('abort', onAbort); try { c.destroy?.(); } catch { /* best effort */ } };
    try {
      if (typeof sdk[command] !== 'function') throw new AdapterError('ADAPTER_SDK_UNAVAILABLE');
      return { output: await abortable(c.send(new sdk[command](input), { abortSignal: controller.signal }), controller.signal), controller, done };
    } catch (error) {
      done();
      throw signals.some(s => s.aborted) ? new AdapterError('COMMAND_CANCELLED') : controller.signal.aborted ? new AdapterError('PROVIDER_TIMEOUT') : Converse.sdkError(error);
    }
  };
  const fetchCatalog = async ({ signal } = {}) => {
    const out = [];
    const foundation = await send(Converse.CONTROL_SDK, 'BedrockClient', 'ListFoundationModelsCommand', { byOutputModality: 'TEXT' }, signal);
    foundation.done();
    for (const entry of foundation.output?.modelSummaries ?? []) out.push(CATALOGS.bedrockFoundation(descriptor.id, entry));
    let nextToken;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const profiles = await send(Converse.CONTROL_SDK, 'BedrockClient', 'ListInferenceProfilesCommand', { maxResults: 1000, ...(nextToken ? { nextToken } : {}) }, signal);
      profiles.done();
      for (const entry of profiles.output?.inferenceProfileSummaries ?? []) out.push(CATALOGS.bedrockProfile(descriptor.id, entry));
      nextToken = typeof profiles.output?.nextToken === 'string' ? profiles.output.nextToken : undefined;
      if (!nextToken) break;
    }
    return out;
  };
  return assembleClient(descriptor, prepared, {
    stream: request => (async function* () {
      const { output, controller, done } = await send(Converse.RUNTIME_SDK, 'BedrockRuntimeClient', 'ConverseStreamCommand', Converse.buildInput(request), request.signal);
      const guard = new StreamGuard();
      const iterator = output?.stream?.[Symbol.asyncIterator]?.();
      try {
        if (!iterator) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
        const events = { [Symbol.asyncIterator]: () => iterator };
        for await (const event of Converse.parse(events)) {
          yield guard.check(event);
          if (event.type === 'finish') return;
        }
        throw new AdapterError('PROVIDER_STREAM_ERROR');
      } catch (error) {
        if ([prepared.context.signal, request.signal].some(s => s?.aborted)) throw new AdapterError('COMMAND_CANCELLED');
        if (controller.signal.aborted) throw new AdapterError('PROVIDER_TIMEOUT');
        throw Converse.sdkError(error);
      } finally {
        controller.abort();
        try { await iterator?.return?.(); } catch { /* already closed */ }
        done();
      }
    })(),
    fetchCatalog,
    checkAuth: async ({ signal }) => {
      try { await fetchCatalog({ signal }); return { ok: true }; }
      catch (error) {
        if (error instanceof AdapterError && ['PROVIDER_AUTH_FAILED', 'PROVIDER_FORBIDDEN', 'ADAPTER_CREDENTIALS_MISSING'].includes(error.code)) return { ok: false, code: error.code };
        throw error;
      }
    },
  });
}
