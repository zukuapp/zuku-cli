// Experimental Codex adapter: a thin wrapper around this CLI's own existing
// modules (not edited here):
//   createCodexOAuth({ storePath?, fetchImpl?, ... })
//   createCodexResponsesProvider({ oauth, fetchImpl?, requestTimeoutMs? }).runStage(request)
// Constructed only when the user explicitly selects provider `codex`; never a
// fallback. Results are always experimental:true / unofficial:true regardless of
// what the wrapped client reports. The modules are supplied by the root
// integration as context.codexModules; this adapter never reads personal Codex
// login state, unrelated credential files or the generic credential getter.
import { AdapterError } from './errors.mjs';
import { ProviderError as CodexProviderError } from '../../provider-errors.mjs';
import { assembleClient, prepare } from './base.mjs';
import { requireModelId } from './http.mjs';
import { usage } from './request.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createCodexAdapter(descriptor, context) {
  const prepared = prepare(descriptor, context, ['codex']);
  const modules = prepared.context.codexModules;
  const available = record(modules) && typeof modules.createCodexOAuth === 'function' && typeof modules.createCodexResponsesProvider === 'function';
  let oauth;
  let provider;
  // storePath only for an explicit isolated home; otherwise the module's own
  // platform default (e.g. %LOCALAPPDATA%/ZukuJS on Windows) is preserved.
  const oauthOptions = () => ({
    ...(typeof prepared.context.codexStorePath === 'string' ? { storePath: prepared.context.codexStorePath } : {}),
    ...(context.fetch ? { fetchImpl: context.fetch } : {}),
  });
  const getProvider = () => {
    if (!available) throw new AdapterError('ADAPTER_CODEX_UNAVAILABLE');
    oauth ??= modules.createCodexOAuth(oauthOptions());
    provider ??= modules.createCodexResponsesProvider({ oauth, ...(context.fetch ? { fetchImpl: context.fetch } : {}) });
    if (!record(provider) || typeof provider.runStage !== 'function') throw new AdapterError('ADAPTER_CODEX_UNAVAILABLE');
    return provider;
  };
  const defaultModel = prepared.options.defaultModel ?? prepared.options.model;
  return assembleClient(descriptor, prepared, {
    // The existing Codex client is JSON-stage only and rejects executable tool calls.
    capabilities: { stage: available, streaming: false, tools: false, nativeInference: false },
    stream: () => { throw new AdapterError('ADAPTER_UNSUPPORTED'); },
    runStage: async stageRequest => {
      if (!record(stageRequest)) throw new AdapterError('ADAPTER_REQUEST_INVALID');
      const model = requireModelId(stageRequest.model ?? defaultModel);
      const client = getProvider();
      let result;
      try { result = await client.runStage({ ...stageRequest, model }); }
      catch (error) {
        if (stageRequest.signal?.aborted || prepared.context.signal?.aborted) throw new AdapterError('COMMAND_CANCELLED');
        throw error instanceof AdapterError || error instanceof CodexProviderError ? error : new AdapterError('PROVIDER_UNAVAILABLE');
      }
      if (!record(result)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
      const u = record(result.usage) ? result.usage : {};
      return {
        provider: descriptor.id,
        stage: stageRequest.stage,
        output: result.output,
        usage: usage({ input: u.input_tokens ?? u.inputTokens, output: u.output_tokens ?? u.outputTokens, total: u.total_tokens ?? u.totalTokens }),
        experimental: true,
        unofficial: true,
      };
    },
    checkAuth: async () => {
      if (!available) return { ok: null, reason: 'codex-unavailable' };
      oauth ??= modules.createCodexOAuth(oauthOptions());
      if (typeof oauth?.status !== 'function') return { ok: null, reason: 'no-status' };
      let status;
      try { status = await oauth.status({ experimental: true }); } catch { return { ok: null, reason: 'status-failed' }; }
      return { ok: status?.authenticated === true ? true : status?.authenticated === false ? false : null };
    },
  });
}
