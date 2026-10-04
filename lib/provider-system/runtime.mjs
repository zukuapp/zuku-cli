import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CommandError } from '../errors.mjs';
import { ProviderError, invalidInput, safeAdapterError } from './errors.mjs';
import { parseModelAddress, validProviderId, validModelId } from './address.mjs';
import { validateEndpoint, validateHeaderName, validHeaderValue } from './endpoint.mjs';
import { NATIVE_PROVIDER_ID, DEFAULT_MODEL_ADDRESS, BUILTIN_IDS, CUSTOM_API_TYPES, normalizeApiType } from './catalog.mjs';
import { AuthRegistry } from './auth-registry.mjs';
import { ProviderRegistry, loadAdapterModule } from './provider-registry.mjs';
import { ModelRegistry, ModelCache, catalogFingerprint } from './model-registry.mjs';
import { ConfigStore, normalizeEntry } from './config-store.mjs';
import { SecretStore, validSecret } from './secret-store.mjs';
import { providerStateDir } from './fs-safe.mjs';
import { createStageEventSink } from './stage-events.mjs';
import { admitStageRequest, admitStageResult } from './stage-schema.mjs';

const project = method => ({ id: method.id, name: method.name, type: method.type, official: method.official, experimental: method.experimental, unofficial: !method.official });
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cachedInputTokens'];
const DELEGATES = Object.freeze({ zuku: () => import('../../commands/login-zuku.mjs'), codex: () => import('../../commands/login-codex.mjs') });

/** Root lib/experimental.mjs (renderAuthMethod/experimentalIndicator/CODEX_AUTH_METHOD); absent => undefined. */
export async function loadExperimental(importer = () => import('../experimental.mjs')) {
  try { return await importer(); } catch (error) { if (error?.code === 'ERR_MODULE_NOT_FOUND') return undefined; throw new ProviderError('ADAPTER_UNAVAILABLE'); }
}

/** Existing login commands keep owning the ZUKU device-code and Codex stores. */
const defaultLegacyAuth = Object.freeze({
  async login(provider, args, context) {
    let mod;
    try { mod = await DELEGATES[provider](); } catch { throw new ProviderError('AUTH_DELEGATE_UNAVAILABLE'); }
    if (typeof mod?.default !== 'function') throw new ProviderError('AUTH_DELEGATE_UNAVAILABLE');
    return mod.default(args, context);
  },
  async status(provider, context) {
    if (provider === 'codex') return (await context.oauth.status({ experimental: true })).authenticated ? 'configured' : 'not-configured';
    const { loadZukuAccount } = await import('../accounts/store.mjs');
    const account = await loadZukuAccount(context.accountStoreOptions);
    return account ? account.scope.split(' ').includes('games:generate') ? 'configured' : 'scope-required' : 'not-configured';
  },
  async logout(provider, context) {
    if (provider === 'codex') return (await DELEGATES.codex()).default(['logout'], context);
    return (await import('../../commands/account.mjs')).default(['logout'], context);
  },
});

/**
 * createProviderRuntime(context) -> runtime (async; lazily loads adapters).
 * context: { home, platform, uid, environment, stateDir, fetch, signal, stdin, stderr,
 *   protectedStore, adapters: {createAdapter, listBuiltinDescriptors} | null,
 *   nativeZuku: (descriptor, ctx) => client, experimental, legacyAuth, now, modelCacheTtlMs }
 */
export async function createProviderRuntime(context = {}) {
  const environment = context.environment ?? process.env;
  const platform = context.platform ?? process.platform;
  const uid = Object.hasOwn(context, 'uid') ? context.uid : process.getuid?.();
  const home = context.home ?? homedir();
  const dir = providerStateDir({ stateDir: context.stateDir, home, platform, environment });
  const configStore = new ConfigStore({ dir, platform, uid });
  const secretStore = new SecretStore({ dir, platform, uid, protectedStore: context.protectedStore });
  const cache = new ModelCache({ dir, platform, uid, ttlMs: context.modelCacheTtlMs, now: context.now });
  const experimental = Object.hasOwn(context, 'experimental') ? context.experimental : await loadExperimental();
  const authRegistry = new AuthRegistry({ codexMethod: experimental?.CODEX_AUTH_METHOD });
  const adapters = Object.hasOwn(context, 'adapters') ? context.adapters : await loadAdapterModule();
  const legacyAuth = context.legacyAuth ?? defaultLegacyAuth;
  const ephemeralCatalogs = new Map();
  const clientContexts = new WeakMap();
  let ownCodex;
  let ownZuku;
  async function getZukuAccountClient() {
    if (!ownZuku) ownZuku = Promise.resolve().then(async () => {
      if (context.zukuAccountClient) return context.zukuAccountClient;
      const factory = context.zukuAccountClientFactory ?? (await import('../accounts/oauth.mjs')).createZukuAccountClient;
      return factory({ fetchImpl: context.fetch ?? globalThis.fetch, signal: context.signal,
        ...(Object.hasOwn(context, 'home') ? { home } : {}) });
    });
    return ownZuku;
  }
  async function getCodexOAuthClient() {
    if (!ownCodex) ownCodex = Promise.resolve().then(async () => {
      if (context.codexOAuth) return context.codexOAuth;
      const options = { fetchImpl: context.fetch ?? globalThis.fetch };
      if (context.codexStorePath !== undefined) options.storePath = context.codexStorePath;
      else if (Object.hasOwn(context, 'home')) options.storePath = join(home, '.config', 'zukujs', platform === 'win32' ? 'codex-oauth.dpapi' : 'codex-oauth.json');
      const factory = context.codexOAuthFactory ?? (await import('../providers/codex-oauth.mjs')).createCodexOAuth;
      return factory(options);
    });
    return ownCodex;
  }
  let adapterDescriptors = [];
  try { adapterDescriptors = typeof adapters?.listBuiltinDescriptors === 'function' ? await adapters.listBuiltinDescriptors() : []; } catch { adapterDescriptors = []; }
  let config, providers, models;
  const rebuild = next => {
    config = next;
    providers = new ProviderRegistry({ authRegistry, adapterFactory: adapters?.createAdapter, adapterDescriptors, config });
    models = new ModelRegistry({ providers, cache, clientFor, catalogContext });
  };
  const mutate = async (fn, signal = context.signal) => rebuild(await configStore.update(fn, { signal }));
  const reviseAuth = next => id => { next.authRevisions[id] = randomUUID(); };
  const bumpAuth = id => mutate(next => { reviseAuth(next)(id); return next; });

  const envValue = name => typeof environment[name] === 'string' && environment[name].length ? environment[name] : undefined;
  const firstEnv = names => names.find(name => envValue(name));

  /** Credentials for ONE provider; only its own env names / store entry are read. */
  async function resolveCredentials(descriptor) {
    const methods = providers.authMethods(descriptor.id);
    const secrets = [];
    const stored = descriptor.native || descriptor.id === 'codex' ? undefined : await secretStore.get(descriptor.id);
    const headers = {};
    for (const [name, ref] of Object.entries(descriptor.headers ?? {})) {
      const value = ref.source === 'secret' ? stored?.headers?.[name] : envValue(ref.env);
      if (!validHeaderValue(value)) throw new ProviderError('AUTH_REQUIRED');
      headers[name] = value; secrets.push(value);
    }
    const pick = id => methods.find(item => item.id === id);
    let credentials, method;
    if (descriptor.native) {
      method = pick('game-cli-device');
      credentials = { type: 'zuku-account', getAccessToken: async ({ signal } = {}) => {
        const current = await (await getZukuAccountClient()).ensureFresh({ signal, requiredScope: 'games:generate' });
        if (!current || typeof current.accessToken !== 'string' || !/^zuku_oa_[a-f0-9]{64}$/.test(current.accessToken)
          || !Array.isArray(current.scopes) || !current.scopes.includes('games:generate')) throw new ProviderError('AUTH_REQUIRED');
        return current.accessToken;
      } };
    } else if (descriptor.id === 'codex') {
      method = pick('codex-oauth');
      credentials = { type: 'codex-oauth', getOAuthClient: getCodexOAuthClient,
        getAccessToken: async ({ signal } = {}) => (await getCodexOAuthClient()).getAccessToken({ experimental: true, signal }) };
    } else {
      const keyMethod = methods.find(item => item.storage === 'secure-store');
      const envName = firstEnv(descriptor.env);
      if (keyMethod && stored?.apiKey) { method = keyMethod; credentials = { type: 'api-key', apiKey: stored.apiKey }; }
      else if (envName && (pick('environment') || pick('custom-env') || keyMethod)) {
        method = pick('environment') ?? pick('custom-env') ?? keyMethod;
        credentials = { type: 'api-key', apiKey: environment[envName] };
        if (!validSecret(credentials.apiKey)) throw new ProviderError('AUTH_SECRET_INVALID');
      } else if (pick('aws-credential-chain')) { method = pick('aws-credential-chain'); credentials = { type: 'cloud-chain', chain: 'aws' }; }
      else if (pick('google-adc')) { method = pick('google-adc'); credentials = { type: 'cloud-chain', chain: 'google-adc' }; }
      else if (pick('local')) { method = pick('local'); credentials = { type: 'none' }; }
      else if (descriptor.custom && pick('custom-none')) { method = pick('custom-none'); credentials = { type: 'none' }; }
      else throw new ProviderError('AUTH_REQUIRED');
      if (credentials.apiKey) secrets.push(credentials.apiKey);
    }
    if (Object.keys(headers).length) credentials.headers = Object.freeze(headers);
    return { credentials: Object.freeze(credentials), method, secrets };
  }

  // Environment/credential-chain identities stay only in memory. A new runtime
  // cannot replay another account's catalog without resolving its own auth.
  async function catalogContext(descriptor) {
    const latest = await configStore.read();
    const revision = latest.authRevisions[descriptor.id] ?? null;
    const resolution = await resolveCredentials(providers.get(descriptor.id));
    let scope = null;
    if (descriptor.id === 'zuku') {
      const record = await (await getZukuAccountClient()).ensureFresh({ requiredScope: 'games:generate', signal: context.signal });
      if (!record || typeof record.generation !== 'string' || !Array.isArray(record.scopes) || !record.scopes.includes('games:generate')) throw new ProviderError('AUTH_REQUIRED');
      scope = record.generation;
    }
    const ephemeral = resolution.method.storage === 'environment' || resolution.method.storage === 'credential-chain'
      || Object.values(descriptor.headers ?? {}).some(ref => ref.source === 'env');
    if (ephemeral) {
      const snapshot = JSON.stringify([resolution.method.id, resolution.credentials.apiKey, resolution.credentials.headers]);
      const previous = ephemeralCatalogs.get(descriptor.id);
      if (!previous || previous.snapshot !== snapshot) ephemeralCatalogs.set(descriptor.id, { snapshot, id: randomUUID() });
      scope = ephemeralCatalogs.get(descriptor.id).id;
    }
    return { revision, scope, cacheable: resolution.method.storage !== 'credential-chain' };
  }

  async function clientFor(id, { signal, resolution, revision } = {}) {
    const descriptor = providers.get(id);
    const selected = resolution ?? await resolveCredentials(descriptor);
    const { credentials, method } = selected;
    const selectedRevision = revision ?? (await configStore.read()).authRevisions[id] ?? null;
    const selectedIdentity = catalogFingerprint(providers.adapterDescriptor(id));
    let nativeGeneration;
    let codexAccountGuard;
    const nativeAccount = async requestSignal => {
      const account = await (await getZukuAccountClient()).ensureFresh({ signal: requestSignal ?? signal ?? context.signal, requiredScope: 'games:generate' });
      if (typeof account?.generation !== 'string' || !account.generation.length || account.generation.length > 128
        || !Array.isArray(account.scopes) || !account.scopes.includes('games:generate')
        || !/^zuku_oa_[a-f0-9]{64}$/.test(account.accessToken ?? '')) throw new ProviderError('AUTH_REQUIRED');
      if (nativeGeneration !== undefined && account.generation !== nativeGeneration) throw new ProviderError('AUTH_SESSION_CHANGED');
      nativeGeneration ??= account.generation;
      if (!selected.secrets.includes(account.accessToken)) selected.secrets.push(account.accessToken);
      return account;
    };
    const values = value => JSON.stringify([value.type, value.apiKey, value.headers]);
    const getInternalCredentials = async ({ signal: requestSignal } = {}) => {
      if ((requestSignal ?? signal ?? context.signal)?.aborted) throw new CommandError('COMMAND_CANCELLED');
      const latest = await configStore.read();
      if ((latest.authRevisions[id] ?? null) !== selectedRevision) throw new ProviderError('AUTH_SESSION_CHANGED');
      const current = providers.get(id);
      if (!current.enabled) throw new ProviderError('PROVIDER_DISABLED');
      if (catalogFingerprint(providers.adapterDescriptor(id)) !== selectedIdentity) throw new ProviderError('AUTH_SESSION_CHANGED');
      const fresh = await resolveCredentials(current);
      if (((await configStore.read()).authRevisions[id] ?? null) !== selectedRevision) throw new ProviderError('AUTH_SESSION_CHANGED');
      if (fresh.method.id !== method.id || values(fresh.credentials) !== values(credentials)) throw new ProviderError('AUTH_SESSION_CHANGED');
      if (descriptor.native) await nativeAccount(requestSignal);
      if (codexAccountGuard) await codexAccountGuard();
      selected.secrets.splice(0, selected.secrets.length, ...fresh.secrets);
      return fresh.credentials;
    };
    const getCredentials = async ({ signal: requestSignal } = {}) => {
      const credential = await getInternalCredentials({ signal: requestSignal });
      const headers = credential.headers ? { headers: credential.headers } : {};
      if (credential.type === 'api-key') return Object.freeze({ kind: 'api-key', apiKey: credential.apiKey, ...headers });
      if (credential.type === 'none') return Object.freeze({ kind: 'none', ...headers });
      if (credential.type === 'cloud-chain') return Object.freeze({ kind: 'cloud-chain', configuration: Object.freeze({ chain: credential.chain, ...descriptor.options }) });
      const accessToken = descriptor.native ? (await nativeAccount(requestSignal)).accessToken
        : await credential.getAccessToken({ signal: requestSignal ?? signal ?? context.signal });
      if (descriptor.native && !/^zuku_oa_[a-f0-9]{64}$/.test(accessToken ?? '')) throw new ProviderError('AUTH_REQUIRED');
      if (typeof accessToken !== 'string' || !/^[\x21-\x7e]{1,32768}$/.test(accessToken)) throw new ProviderError('AUTH_REQUIRED');
      if (codexAccountGuard) await codexAccountGuard();
      if (!selected.secrets.includes(accessToken)) selected.secrets.push(accessToken);
      return Object.freeze({ kind: 'bearer', accessToken, ...headers });
    };
    const ctx = { fetch: context.fetch ?? globalThis.fetch, signal: signal ?? context.signal, authMethod: project(method) };
    Object.defineProperties(ctx, {
      credentials: { value: credentials, enumerable: false },
      getCredentials: { value: getCredentials, enumerable: false },
      getInternalCredentials: { value: getInternalCredentials, enumerable: false },
    });
    if (id === 'codex') {
      const oauth = await getCodexOAuthClient();
      const activeAccount = status => {
        if (!Array.isArray(status?.accounts)) return undefined; // Trusted injected test seam without account metadata.
        const active = status.accounts.filter(account => account.active === true);
        if (active.length > 1 || active.some(account => typeof account.accountId !== 'string' || !/^[a-f0-9]{64}$/.test(account.accountId))) throw new ProviderError('AUTH_REQUIRED');
        return active[0]?.accountId ?? null;
      };
      const selectedAccount = typeof oauth.status === 'function' ? activeAccount(await oauth.status({ experimental: true })) : undefined;
      codexAccountGuard = async () => {
        if (selectedAccount !== undefined && activeAccount(await oauth.status({ experimental: true })) !== selectedAccount) throw new ProviderError('AUTH_SESSION_CHANGED');
      };
      const scopedOAuth = Object.freeze({
        getAccessToken: async options => {
          await getInternalCredentials({ signal: options?.signal });
          const token = await oauth.getAccessToken(options);
          await getInternalCredentials({ signal: options?.signal });
          if (!selected.secrets.includes(token)) selected.secrets.push(token);
          return token;
        },
        ...(typeof oauth.status === 'function' ? { status: options => oauth.status(options) } : {}),
      });
      const responses = context.codexResponsesFactory ?? (await import('../providers/codex-responses.mjs')).createCodexResponsesProvider;
      ctx.codexModules = Object.freeze({ createCodexOAuth: () => scopedOAuth, createCodexResponsesProvider: options => responses(options) });
      if (context.codexStorePath !== undefined) ctx.codexStorePath = context.codexStorePath;
    }
    Object.freeze(ctx);
    let client;
    if (descriptor.native && typeof context.nativeZuku === 'function') {
      if (!descriptor.enabled) throw new ProviderError('PROVIDER_DISABLED');
      client = await context.nativeZuku(providers.adapterDescriptor(id), ctx);
    } else client = await providers.createClient(id, ctx);
    if (!client || typeof client !== 'object') throw new ProviderError('ADAPTER_INVALID');
    if (descriptor.native && typeof client.runStage === 'function'
      && client.capabilities?.stageInference !== false && client.capabilities?.stage !== false) await nativeAccount(signal);
    clientContexts.set(client, ctx);
    return client;
  }

  const accountStoreOptions = { uid, ...(Object.hasOwn(context, 'home') ? { home } : {}) };
  const delegateContext = async provider => ({ signal: context.signal, stderr: context.stderr,
    accountStoreOptions, ...(Object.hasOwn(context, 'home') ? { home } : {}),
    ...(provider === 'codex' ? { oauth: await getCodexOAuthClient() } : {}) });
  const legacyStatus = provider => typeof legacyAuth.status === 'function' ? Promise.resolve().then(async () => legacyAuth.status(provider, await delegateContext(provider))).catch(() => 'unknown') : 'unknown';

  /** Status from local metadata only — no network, no credential values. */
  async function authStatus(descriptor, storeStatus) {
    const methods = providers.authMethods(descriptor.id);
    const pick = id => methods.find(item => item.id === id);
    const out = (method, status, extra = {}) => ({ provider: descriptor.id, method: project(method), status, ...extra });
    if (descriptor.native) {
      const status = await legacyStatus('zuku');
      return out(pick('game-cli-device'), ['configured', 'not-configured', 'scope-required'].includes(status) ? status : 'unknown');
    }
    if (descriptor.id === 'codex') {
      const status = await legacyStatus('codex');
      return out(pick('codex-oauth'), ['configured', 'not-configured'].includes(status) ? status : 'unknown');
    }
    const headers = Object.entries(descriptor.headers ?? {}).map(([name, ref]) => ({ name, source: ref.source, ...(ref.env ? { envVar: ref.env } : {}), status: (ref.source === 'secret' ? storeStatus?.headers.includes(name) : Boolean(envValue(ref.env))) ? 'configured' : 'not-configured' }));
    const keyMethod = methods.find(item => item.storage === 'secure-store');
    const envName = firstEnv(descriptor.env);
    const extra = headers.length ? { headers } : {};
    if (keyMethod && storeStatus?.apiKey) return out(keyMethod, 'configured', extra);
    if (envName) return out(pick('environment') ?? pick('custom-env') ?? keyMethod, 'environment', { envVar: envName, ...extra });
    if (pick('aws-credential-chain')) return out(pick('aws-credential-chain'), 'credential-chain', extra);
    if (pick('google-adc')) return out(pick('google-adc'), 'credential-chain', extra);
    if (pick('local')) return out(pick('local'), 'not-required', extra);
    if (descriptor.custom) return out(keyMethod, 'not-configured', extra);
    return out(keyMethod ?? methods[0], 'not-configured', extra);
  }

  function projectProvider(descriptor, auth) {
    const missing = [...(descriptor.requiredOptions ?? []).filter(key => !descriptor.options[key]), ...(descriptor.requiresBaseUrl && !descriptor.baseUrl ? ['baseUrl'] : [])];
    return {
      id: descriptor.id, name: descriptor.name, apiType: descriptor.apiType, baseUrl: descriptor.baseUrl ?? null,
      enabled: descriptor.enabled, active: config.active.provider === descriptor.id,
      native: descriptor.native === true, builtin: descriptor.builtin === true, custom: descriptor.custom === true, local: descriptor.local === true,
      authMethods: providers.authMethods(descriptor.id).map(project), auth,
      capabilities: { ...descriptor.capabilities }, models: descriptor.models.map(item => item.id), defaultModel: descriptor.defaultModel ?? null,
      options: { ...descriptor.options }, ...(descriptor.apiKeyEnv ? { apiKeyEnv: descriptor.apiKeyEnv } : {}),
      ...(missing.length ? { missingConfiguration: missing } : {}),
    };
  }

  async function storeStatus() {
    try { return await secretStore.status(); } catch (error) {
      if (error?.code === 'SECRET_STORE_UNAVAILABLE') return {};
      throw error;
    }
  }

  function patchEntry(descriptor, current, patch) {
    const allowed = new Set(['baseUrl', 'name', 'apiType', 'apiKeyEnv', 'addModels', 'removeModels', 'defaultModel', 'options', 'headers']);
    if (!patch || typeof patch !== 'object' || Object.keys(patch).some(key => !allowed.has(key))) throw invalidInput();
    const entry = { ...current };
    if (patch.baseUrl !== undefined) {
      if (!(descriptor.custom || descriptor.local || descriptor.requiresBaseUrl)) throw new ProviderError('PROVIDER_ENDPOINT_FIXED');
      entry.baseUrl = validateEndpoint(patch.baseUrl, { hostSuffixes: descriptor.hostSuffixes, allowLoopback: !descriptor.requiresBaseUrl });
    }
    if (patch.name !== undefined || patch.apiType !== undefined) {
      if (!descriptor.custom) throw new ProviderError('PROVIDER_CONFIG_INVALID');
      if (patch.name !== undefined) entry.name = patch.name;
      if (patch.apiType !== undefined) { const apiType = normalizeApiType(patch.apiType); if (!CUSTOM_API_TYPES.includes(apiType)) throw new ProviderError('PROVIDER_CONFIG_INVALID'); entry.apiType = apiType; }
    }
    if (patch.apiKeyEnv !== undefined) { if (descriptor.native || descriptor.local || descriptor.id === 'codex' || descriptor.id === 'google-vertex') throw new ProviderError('AUTH_METHOD_UNSUPPORTED'); if (patch.apiKeyEnv === null) delete entry.apiKeyEnv; else entry.apiKeyEnv = patch.apiKeyEnv; }
    if (patch.addModels || patch.removeModels) {
      if (descriptor.native) throw new ProviderError('PROVIDER_CONFIG_INVALID');
      let list = [...(entry.models ?? [])];
      for (const id of patch.removeModels ?? []) list = list.filter(item => item.id !== id);
      for (const model of patch.addModels ?? []) { if (!validModelId(model?.id)) throw new ProviderError('MODEL_ADDRESS_INVALID'); list = [...list.filter(item => item.id !== model.id), model]; }
      entry.models = list;
      if (!list.length) delete entry.models;
    }
    if (patch.defaultModel !== undefined) { if (patch.defaultModel === null) delete entry.defaultModel; else entry.defaultModel = patch.defaultModel; }
    if (patch.options !== undefined) {
      const permitted = new Set(descriptor.requiredOptions ?? []);
      if (descriptor.custom && ['openai-chat', 'openai-responses'].includes(normalizeApiType(patch.apiType ?? descriptor.apiType))) permitted.add('catalog');
      entry.options = { ...(entry.options ?? {}) };
      for (const [key, value] of Object.entries(patch.options)) {
        if (!permitted.has(key)) throw new ProviderError('PROVIDER_CONFIG_INVALID');
        if (value === null) delete entry.options[key]; else entry.options[key] = value;
      }
      if (!Object.keys(entry.options).length) delete entry.options;
    }
    if (patch.headers !== undefined) {
      if (descriptor.native || descriptor.id === 'codex') throw new ProviderError('PROVIDER_CONFIG_INVALID');
      entry.headers = { ...(entry.headers ?? {}) };
      for (const [name, ref] of Object.entries(patch.headers)) { validateHeaderName(name); if (ref === null) delete entry.headers[name]; else entry.headers[name] = ref; }
      if (!Object.keys(entry.headers).length) delete entry.headers;
    }
    return normalizeEntry(descriptor.id, entry);
  }

  const knownModel = async (descriptor, model, signal) => descriptor.models.some(item => item.id === model) || Boolean(await models.info(`${descriptor.id}/${model}`, { signal }));

  rebuild(await configStore.read());

  const runtime = {
    get stateDir() { return dir; },
    get providers() { return providers; },
    get authRegistry() { return authRegistry; },
    get models() { return models; },
    get activeModel() { return config.active.model; },
    get activeProvider() { return config.active.provider; },
    experimental,

    async listProviders() {
      const status = await storeStatus();
      return Promise.all(providers.list().map(async descriptor => projectProvider(descriptor, await authStatus(descriptor, status[descriptor.id]))));
    },
    async useProvider(id) {
      const descriptor = providers.get(id);
      if (!descriptor.enabled) throw new ProviderError('PROVIDER_DISABLED');
      const model = descriptor.defaultModel ?? descriptor.models[0]?.id;
      await mutate(next => { next.active = { provider: id, model: model ? `${id}/${model}` : null }; return next; });
      return { provider: id, model: config.active.model };
    },
    async addProvider(input = {}) {
      const { id, name, apiType, baseUrl, model, apiKeyEnv, headers, enabled } = input;
      if (!validProviderId(id)) throw invalidInput();
      if (BUILTIN_IDS.has(id) || providers.has(id)) throw new ProviderError('PROVIDER_EXISTS');
      const entry = normalizeEntry(id, { custom: true, name: name ?? id, apiType, baseUrl, ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(headers ? { headers } : {}), ...(enabled === false ? { enabled: false } : {}), ...(model ? { models: [{ id: model }], defaultModel: model } : {}) });
      await mutate(next => { if (next.providers[id]) throw new ProviderError('PROVIDER_EXISTS'); next.providers[id] = entry; reviseAuth(next)(id); return next; });
      return projectProvider(providers.get(id), await authStatus(providers.get(id), undefined));
    },
    async removeProvider(id) {
      const descriptor = providers.get(id);
      if (!descriptor.custom) throw new ProviderError('PROVIDER_BUILTIN_PROTECTED');
      let activeReset = false;
      await mutate(next => {
        delete next.providers[id];
        reviseAuth(next)(id);
        if (next.active.provider === id) { activeReset = true; next.active = { provider: NATIVE_PROVIDER_ID, model: DEFAULT_MODEL_ADDRESS }; }
        return next;
      });
      await secretStore.remove(id, { signal: context.signal }).catch(error => { if (error?.code !== 'SECRET_STORE_UNAVAILABLE') throw error; });
      return { removed: id, activeReset, active: { ...config.active } };
    },
    async configureProvider(id, patch) {
      const descriptor = providers.get(id);
      await mutate(next => {
        next.providers[id] = patchEntry(descriptor, next.providers[id] ?? {}, patch);
        if (['baseUrl', 'apiType', 'apiKeyEnv', 'headers', 'options'].some(key => Object.hasOwn(patch, key))) reviseAuth(next)(id);
        return next;
      });
      const status = await storeStatus();
      return projectProvider(providers.get(id), await authStatus(providers.get(id), status[id]));
    },
    async setEnabled(id, enabled) {
      if (typeof enabled !== 'boolean') throw invalidInput();
      providers.get(id);
      if (!enabled && config.active.provider === id) throw new ProviderError('PROVIDER_ACTIVE');
      await mutate(next => {
        const entry = { ...(next.providers[id] ?? {}) };
        if (enabled) delete entry.enabled; else entry.enabled = false;
        if (entry.custom) entry.enabled = enabled;
        next.providers[id] = entry;
        reviseAuth(next)(id);
        if (!Object.keys(entry).length) delete next.providers[id];
        return next;
      });
      return { provider: id, enabled };
    },
    async listModels({ provider, refresh = false, signal } = {}) {
      return models.list({ provider: provider ?? config.active.provider, refresh, signal: signal ?? context.signal });
    },
    async useModel(address, { signal } = {}) {
      const parsed = parseModelAddress(address);
      const descriptor = providers.get(parsed.provider);
      if (!descriptor.enabled) throw new ProviderError('PROVIDER_DISABLED');
      await knownModel(descriptor, parsed.model, signal ?? context.signal);
      await mutate(next => { next.active = { provider: parsed.provider, model: parsed.address }; return next; });
      return { provider: parsed.provider, model: parsed.address };
    },
    async modelInfo(address, { signal, refresh } = {}) { return models.info(address, { signal: signal ?? context.signal, refresh }); },

    /**
     * authLogin(id, { apiKey?, headers?, apiKeyEnv?, experimental?, args?, commandContext?, verify? }).
     * Secret values come only from the command layer's hidden/stdin input.
     */
    async authLogin(id = NATIVE_PROVIDER_ID, options = {}) {
      const descriptor = providers.get(id);
      const methods = providers.authMethods(id);
      const delegated = methods.find(item => item.delegate);
      if (delegated) {
        if (delegated.experimental && options.experimental !== true) {
          const accepted = id === 'codex' && (await (await getCodexOAuthClient()).status({ experimental: true })).experimentalAccepted === true;
          if (!accepted) throw new ProviderError('AUTH_EXPERIMENTAL_OPT_IN');
        }
        const args = [...(options.experimental === true ? ['--experimental'] : []), ...(options.args ?? [])];
        const commandContext = { ...(await delegateContext(delegated.delegate)), ...(options.commandContext ?? {}) };
        commandContext.accountStoreOptions = { ...accountStoreOptions, ...options.commandContext?.accountStoreOptions };
        const result = await legacyAuth.login(delegated.delegate, args, commandContext);
        await bumpAuth(id);
        return { provider: id, method: project(delegated), status: 'delegated', result };
      }
      if (options.apiKeyEnv !== undefined) {
        await this.configureProvider(id, { apiKeyEnv: options.apiKeyEnv });
        const method = methods.find(item => item.storage === 'environment') ?? methods.find(item => item.storage === 'secure-store');
        if (!method) throw new ProviderError('AUTH_METHOD_UNSUPPORTED');
        return { provider: id, method: project(method), status: envValue(options.apiKeyEnv) ? 'environment' : 'not-configured', envVar: options.apiKeyEnv };
      }
      const keyMethod = methods.find(item => item.storage === 'secure-store');
      if (options.apiKey !== undefined || options.headers !== undefined) {
        if (options.apiKey !== undefined && (!keyMethod || !validSecret(options.apiKey))) throw new ProviderError(keyMethod ? 'AUTH_SECRET_INVALID' : 'AUTH_METHOD_UNSUPPORTED');
        for (const [name, value] of Object.entries(options.headers ?? {})) if (descriptor.headers?.[name]?.source !== 'secret' || !validHeaderValue(value)) throw new ProviderError('AUTH_SECRET_INVALID');
        await secretStore.update(id, { ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}), ...(options.headers ? { headers: options.headers } : {}) }, { signal: context.signal });
        await bumpAuth(id);
        const result = { provider: id, method: project(keyMethod ?? methods[0]), status: 'configured', storage: 'secure-store' };
        if (options.verify) {
          const client = await clientFor(id, { signal: context.signal });
          const verdict = typeof client.validateAuth === 'function' ? await client.validateAuth({ signal: context.signal }) : undefined;
          result.verified = verdict?.valid === true ? 'valid' : verdict?.valid === false ? 'invalid' : 'unknown';
        }
        return result;
      }
      const passive = methods.find(item => ['credential-chain', 'none'].includes(item.storage));
      if (passive && !keyMethod) return { provider: id, method: project(passive), status: passive.storage === 'none' ? 'not-required' : 'credential-chain' };
      throw new ProviderError('AUTH_INPUT_REQUIRED');
    },
    async authLogout(id = NATIVE_PROVIDER_ID) {
      const descriptor = providers.get(id);
      const delegated = providers.authMethods(id).find(item => item.delegate);
      if (delegated) {
        if (typeof legacyAuth.logout !== 'function') throw new ProviderError('AUTH_DELEGATE_UNAVAILABLE');
        await legacyAuth.logout(delegated.delegate, await delegateContext(delegated.delegate));
        await bumpAuth(id);
        return { provider: id, method: project(delegated), status: 'logged-out' };
      }
      await secretStore.remove(id, { signal: context.signal });
      await bumpAuth(id);
      const after = await authStatus(descriptor, undefined);
      return { provider: id, status: 'removed', remaining: after.status };
    },
    async authList() {
      const status = await storeStatus();
      return Promise.all(providers.list().map(async descriptor => ({ ...(await authStatus(descriptor, status[descriptor.id])), available: providers.authMethods(descriptor.id).map(project) })));
    },

    /**
     * resolveStageProvider({ model?, signal }) -> client bound to ONE selected provider/model.
     * No implicit fallback: a failing/unsupported selection is an error, never another provider.
     */
    async resolveStageProvider({ model, signal } = {}) {
      const address = model ?? config.active.model;
      if (!address) throw new ProviderError('MODEL_NOT_SELECTED');
      const parsed = parseModelAddress(address);
      const descriptor = providers.get(parsed.provider);
      if (!descriptor.enabled) throw new ProviderError('PROVIDER_DISABLED');
      const effectiveSignal = signal ?? context.signal;
      if (!descriptor.native) await knownModel(descriptor, parsed.model, effectiveSignal);
      else if (parsed.model !== 'auto') await knownModel(descriptor, parsed.model, effectiveSignal);
      const resolution = await resolveCredentials(descriptor);
      const { method, secrets } = resolution;
      const revision = (await configStore.read()).authRevisions[descriptor.id] ?? null;
      let client;
      try { client = await clientFor(descriptor.id, { signal: effectiveSignal, resolution, revision }); } catch (error) {
        if (descriptor.native && error?.code === 'ADAPTER_UNAVAILABLE') throw new ProviderError('NATIVE_STAGE_UNAVAILABLE');
        throw error;
      }
      if (typeof client?.runStage !== 'function' || client.capabilities?.stageInference === false || client.capabilities?.stage === false) throw new ProviderError(descriptor.native ? 'NATIVE_STAGE_UNAVAILABLE' : 'ADAPTER_UNAVAILABLE');
      const authMethod = project(method);
      const leaks = text => secrets.some(secret => secret.length >= 8 && text.includes(secret));
      return Object.freeze({
        id: descriptor.id, provider: descriptor.id, name: descriptor.name, model: parsed.address, modelId: parsed.model,
        authMethod, experimental: authMethod.experimental, unofficial: !authMethod.official,
        capabilities: Object.freeze({ ...descriptor.capabilities, ...(client.capabilities ?? {}) }),
        async runStage(request) {
          if (!request || typeof request !== 'object' || typeof request.stage !== 'string') throw invalidInput();
          const { signal: requestSignal, onEvent, onDelta, ...rest } = request;
          if (onEvent !== undefined && typeof onEvent !== 'function' || onDelta !== undefined && typeof onDelta !== 'function'
            || onEvent && onDelta && onEvent !== onDelta) throw invalidInput();
          let serialized;
          try { serialized = JSON.stringify(rest); } catch { throw invalidInput(); }
          if (leaks(serialized)) throw new ProviderError('CREDENTIAL_IN_MODEL_INPUT');
          const inference = new AbortController();
          const signals = [inference.signal, requestSignal, effectiveSignal].filter(Boolean);
          const combined = AbortSignal.any(signals);
          if (combined?.aborted) throw new CommandError('COMMAND_CANCELLED');
          try {
            await clientContexts.get(client).getInternalCredentials({ signal: combined });
            if (leaks(serialized)) throw new ProviderError('CREDENTIAL_IN_MODEL_INPUT');
            rest.maxOutputBytes = await admitStageRequest(rest, context.stageSchema);
            const sink = createStageEventSink({ callback: onEvent ?? onDelta, secrets, signal: combined,
              maxBytes: rest.maxOutputBytes });
            let result;
            try {
              result = await client.runStage({ ...rest, model: parsed.model, signal: combined, experimental: authMethod.experimental,
                ...((onEvent ?? onDelta) ? { onEvent: sink.emit } : {}) });
            } catch (error) { throw await safeAdapterError(error, 'ADAPTER_INVALID'); }
            if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'output')) throw new ProviderError('ADAPTER_INVALID');
            let outputText;
            try { outputText = JSON.stringify(result.output) ?? ''; } catch { throw new ProviderError('ADAPTER_INVALID'); }
            if (leaks(outputText)) throw new ProviderError('ADAPTER_INVALID');
            await admitStageResult(result.output, rest, context.stageSchema);
            await sink.flush();
            const usage = {};
            for (const key of USAGE_KEYS) if (Number.isSafeInteger(result.usage?.[key]) && result.usage[key] >= 0) usage[key] = result.usage[key];
            return {
              provider: descriptor.id, stage: request.stage, model: parsed.address, output: result.output, usage,
              experimental: authMethod.experimental,
              unofficial: !authMethod.official,
            };
          } finally { inference.abort(); }
        },
      });
    },
  };
  return runtime;
}
