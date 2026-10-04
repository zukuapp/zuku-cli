// Native ZUKU five-stage facade uses only the protected zuku-cli OAuth grant.
// Schemas and skills are pinned to the owning server contract. A lost POST is
// read back with its durable UUID; inference is never automatically dispatched twice.
// The current server has no token-stream or existing-game tool-decision endpoint.
import { AdapterError } from './errors.mjs';
import { assembleClient, prepare, probe, requestHeaders, resolveBase } from './base.mjs';
import { getJson, joinUrl, validModelId, Exchange } from './http.mjs';
import { finalize, model } from './models.mjs';
import { createNativeStageRequest, validateNativeReceipt, nativeStageResult, NATIVE_CONTRACT, NATIVE_CONTRACT_SHA, NATIVE_PACK_SHA } from './zuku-stage.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parse the API envelope { success, data, meta } used by the ZUKU public API. */
export function parseCatalog(provider, envelope) {
  if (!record(envelope) || envelope.success !== true || !Object.hasOwn(envelope, 'data')) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
  const data = envelope.data;
  const list = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : undefined;
  if (!list) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
  if (!record(data) || data.provider !== 'zuku' || data.contract_version !== NATIVE_CONTRACT || data.contract_sha256 !== NATIVE_CONTRACT_SHA || data.skill_pack_sha256 !== NATIVE_PACK_SHA || data.billing?.pool !== 'aist' || data.billing?.paid_checkout !== false) throw new AdapterError('NATIVE_CONTRACT_MISMATCH');
  const models = list.map(entry => {
    const id = typeof entry === 'string' ? entry : record(entry) ? (entry.id ?? entry.model) : undefined;
    return typeof id === 'string' && entry.available === true ? model(provider, id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id, { name: record(entry) ? entry.name ?? entry.display_name : undefined, source: 'remote' }) : undefined;
  }).filter(Boolean);
  const defaultModel = typeof data?.default_model === 'string' && validModelId(data.default_model) ? data.default_model : undefined;
  // `auto` is the CLI's server-routed selection; listed as configured, not as a catalog claim.
  return { models: finalize([...models.length ? [model(provider, 'auto', { name: 'Auto', source: 'remote' })] : [], ...models]), defaultModel };
}

export function createZukuNativeAdapter(descriptor, context) {
  const prepared = prepare(descriptor, context, ['zuku']);
  const base = resolveBase(descriptor, prepared, prepared.context);
  // Only the ZUKU account access token (credential kind 'bearer') is accepted.
  const headers = async signal => {
    if ((signal ?? prepared.context.signal)?.aborted) throw new AdapterError('COMMAND_CANCELLED');
    const value = await requestHeaders(prepared, { accept: 'application/json', 'content-type': 'application/json' }, 'bearer', { required: true, kinds: ['bearer'], signal });
    if (!/^Bearer zuku_oa_[a-f0-9]{64}$/.test(value.get('authorization') ?? '')) throw new AdapterError('ADAPTER_CREDENTIALS_INVALID');
    return value;
  };
  const fetchCatalog = async ({ signal } = {}) => parseCatalog(descriptor.id, await getJson(prepared.context, joinUrl(base, '/oauth/game-agent/models'), await headers(signal), { signal })).models;
  const exchange = async (path, method, body, signal) => {
    const requestHeaders = await headers(signal);
    const io = new Exchange({ fetch: prepared.context.fetch, signals: [prepared.context.signal, signal], timeouts: prepared.context.timeouts, limits: { ...prepared.context.limits, jsonBytes: 524288 } });
    try { const response = await io.send(joinUrl(base,path), { method, headers: requestHeaders, ...(body ? { body: JSON.stringify(body) } : {}) }); return await io.json(response); }
    catch (error) { throw io.error(error); } finally { io.close(); }
  };
  const status = async (expected, signal) => validateNativeReceipt(await exchange(`/oauth/game-agent/stages/${expected.request_id}`, 'GET', undefined, signal), expected);
  const native = prepared.context.nativeZuku;
  const injected = record(native) && typeof native.runStage === 'function';
  return assembleClient(descriptor, prepared, {
    capabilities: { stage: true, stageInference: true, nativeInference: true, tools: false, streaming: injected && typeof native.stream === 'function' },
    stream: request => {
      if (!injected || typeof native.stream !== 'function') throw new AdapterError('ADAPTER_NATIVE_UNAVAILABLE');
      return native.stream(request);
    },
    runStage: async stageRequest => {
      if (!injected) {
        const body = await createNativeStageRequest(stageRequest);
        if (stageRequest.signal?.aborted || prepared.context.signal?.aborted) throw new AdapterError('COMMAND_CANCELLED');
        let receipt;
        try { receipt = validateNativeReceipt(await exchange('/oauth/game-agent/stages', 'POST', body, stageRequest.signal), body); }
        catch (error) {
          if (stageRequest.signal?.aborted || prepared.context.signal?.aborted) { const unknown = new AdapterError('NATIVE_OUTCOME_UNCERTAIN'); unknown.requestId = body.request_id; throw unknown; }
          if (error?.status >= 400 && error.status < 500 && ![408,429].includes(error.status)) throw error;
          try { receipt = await status(body, stageRequest.signal); }
          catch { const unknown = new AdapterError('NATIVE_OUTCOME_UNCERTAIN'); unknown.requestId = body.request_id; throw unknown; }
        }
        try { return await nativeStageResult(receipt, body); }
        catch (error) { if (error instanceof AdapterError) error.requestId = body.request_id; throw error; }
      }
      const result = await native.runStage(stageRequest);
      if (!record(result)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
      return { provider: descriptor.id, stage: result.stage ?? stageRequest?.stage, output: result.output, usage: result.usage ?? {}, experimental: false, unofficial: false };
    },
    fetchCatalog,
    checkAuth: ({ signal }) => probe(fetchCatalog, signal),
  });
}
