import { CommandError } from '../errors.mjs';
import { ProviderError, safeAdapterError } from './errors.mjs';
import { validProviderId, validModelId } from './address.mjs';
import { validateEndpoint } from './endpoint.mjs';
import { BUILTIN_PROVIDERS, CAPABILITY_KEYS, normalizeCapabilities } from './catalog.mjs';

const NAME = /^[\x20-\x7e]{1,64}$/;
const API_TYPE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const CUSTOM_AUTH_METHODS = Object.freeze(['custom-api-key', 'custom-env', 'custom-none']);

/** Default protocol seam: the adapter owner's factory, lazily imported. Never stubbed in production. */
export async function loadAdapterModule(importer = () => import('./adapters/index.mjs')) {
  let mod;
  try { mod = await importer(); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw new ProviderError('ADAPTER_UNAVAILABLE');
  }
  if (typeof mod?.createAdapter !== 'function') throw new ProviderError('ADAPTER_UNAVAILABLE');
  return mod;
}

function mergeCapabilities(base, extra) {
  const out = { ...normalizeCapabilities(base) };
  if (extra && typeof extra === 'object') for (const key of CAPABILITY_KEYS) if (out[key] === null && typeof extra[key] === 'boolean') out[key] = extra[key];
  return Object.freeze(out);
}

/**
 * ONE registry: provider id -> descriptor. Built-in metadata + adapter-declared
 * built-ins + user custom endpoints, all resolved here; protocol behaviour is
 * selected by `apiType` inside the adapter factory, not by switches elsewhere.
 * Kilo Code reference (MIT, @76bcfd40): `BUNDLED_PROVIDERS` lazy loader map and
 * `enabled_providers`/`disabled_providers` filtering in provider/provider.ts.
 */
export class ProviderRegistry {
  #descriptors = new Map();
  #adapterFactory;
  #authRegistry;
  constructor({ authRegistry, adapterFactory, adapterDescriptors = [], config = { providers: {} } } = {}) {
    this.#authRegistry = authRegistry;
    this.#adapterFactory = adapterFactory;
    const extra = new Map();
    for (const item of Array.isArray(adapterDescriptors) ? adapterDescriptors.slice(0, 128) : []) if (item && validProviderId(item.id)) extra.set(item.id, item);
    for (const base of BUILTIN_PROVIDERS) this.#register(this.#apply(base, config.providers[base.id], extra.get(base.id)));
    for (const [id, item] of extra) {
      if (this.#descriptors.has(id)) continue;
      // Adapter-only built-ins must use known auth methods and fixed HTTPS/loopback endpoints.
      try {
        if (!NAME.test(item.name) || !API_TYPE.test(item.apiType) || !Array.isArray(item.authMethods) || !item.authMethods.length) continue;
        const authMethods = item.authMethods.map(method => typeof method === 'string' ? method : method?.id);
        if (!authMethods.every(id => authRegistry.has(id))) continue;
        const env = [...new Set(item.authMethods.flatMap(method => typeof method === 'object' && Array.isArray(method?.env) ? method.env : []))];
        if (env.length > 16 || !env.every(name => typeof name === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/.test(name))) continue;
        const baseUrl = item.baseUrl == null ? null : validateEndpoint(item.baseUrl);
        this.#register(this.#apply({ id, name: item.name, apiType: item.apiType, baseUrl, env, authMethods, capabilities: item.capabilities, builtin: true, custom: false, adapterOnly: true }, config.providers[id]));
      } catch { /* invalid adapter metadata is ignored, never half-registered */ }
    }
    for (const [id, entry] of Object.entries(config.providers)) {
      if (!entry.custom) continue;
      this.#register({
        id, name: entry.name, apiType: entry.apiType, baseUrl: entry.baseUrl, env: entry.apiKeyEnv ? [entry.apiKeyEnv] : [],
        authMethods: [...CUSTOM_AUTH_METHODS], capabilities: mergeCapabilities({}, undefined), builtin: false, custom: true,
        enabled: entry.enabled !== false, models: entry.models ?? [], defaultModel: entry.defaultModel, headers: entry.headers ?? {}, options: entry.options ?? {}, apiKeyEnv: entry.apiKeyEnv,
      });
    }
  }
  #apply(base, entry = {}, adapter) {
    const models = [...(base.models ?? []), ...(entry.models ?? []).filter(item => !(base.models ?? []).some(fixed => fixed.id === item.id))];
    if (entry.options?.deployment && !models.some(model => model.id === entry.options.deployment)) models.push({ id: entry.options.deployment });
    return {
      ...base, env: entry.apiKeyEnv ? [entry.apiKeyEnv, ...base.env] : [...base.env], authMethods: [...base.authMethods],
      baseUrl: entry.baseUrl ?? base.baseUrl, capabilities: mergeCapabilities(base.capabilities, adapter?.capabilities),
      enabled: entry.enabled !== false, models, defaultModel: entry.options?.deployment ?? entry.defaultModel ?? (base.native ? 'auto' : undefined),
      headers: entry.headers ?? {}, options: entry.options ?? {}, apiKeyEnv: entry.apiKeyEnv,
    };
  }
  #register(descriptor) {
    if (!validProviderId(descriptor.id) || this.#descriptors.has(descriptor.id) || !NAME.test(descriptor.name) || !API_TYPE.test(descriptor.apiType)) throw new ProviderError('PROVIDER_CONFIG_INVALID');
    for (const id of descriptor.authMethods) this.#authRegistry.get(id);
    for (const model of descriptor.models ?? []) if (!validModelId(model.id)) throw new ProviderError('PROVIDER_CONFIG_INVALID');
    this.#descriptors.set(descriptor.id, Object.freeze(descriptor));
  }
  has(id) { return this.#descriptors.has(id); }
  get(id) {
    const found = validProviderId(id) ? this.#descriptors.get(id) : undefined;
    if (!found) throw new ProviderError('PROVIDER_NOT_FOUND');
    return found;
  }
  list() { return [...this.#descriptors.values()]; }
  authMethods(id) { return this.#authRegistry.forProvider(this.get(id)); }
  /** Contract descriptor handed to adapters: metadata only; credentials travel separately in context. */
  adapterDescriptor(id) {
    const d = this.get(id);
    const options = { ...d.options };
    if (d.custom) { options.custom = true; options.allowLoopbackHttp ??= d.baseUrl.startsWith('http:'); }
    if (d.defaultModel) options.defaultModel = d.defaultModel;
    if (Object.keys(d.headers).length) options.headerNames = Object.keys(d.headers);
    return Object.freeze({
      id: d.id, name: d.name, apiType: d.apiType, baseUrl: d.baseUrl, enabled: d.enabled,
      authMethods: this.authMethods(id), capabilities: d.capabilities,
      models: d.models.map(model => model.id), options: Object.freeze(options),
      headers: d.headers,
    });
  }
  /** Validates again before handing to the factory: endpoint shape, required options, enabled. */
  async createClient(id, context) {
    const d = this.get(id);
    if (!d.enabled) throw new ProviderError('PROVIDER_DISABLED');
    if (d.baseUrl) validateEndpoint(d.baseUrl, { hostSuffixes: d.hostSuffixes });
    else if (d.requiresBaseUrl && !d.options.resourceName) throw new ProviderError('PROVIDER_OPTION_REQUIRED');
    for (const key of d.requiredOptions ?? []) if (!d.options[key]) throw new ProviderError('PROVIDER_OPTION_REQUIRED');
    if (typeof this.#adapterFactory !== 'function') throw new ProviderError('ADAPTER_UNAVAILABLE');
    let client;
    try { client = await this.#adapterFactory(this.adapterDescriptor(id), context); } catch (error) {
      throw await safeAdapterError(error, 'ADAPTER_UNAVAILABLE');
    }
    if (!client || typeof client !== 'object') throw new ProviderError('ADAPTER_UNAVAILABLE');
    return client;
  }
}
