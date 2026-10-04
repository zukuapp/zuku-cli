import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CommandError } from '../errors.mjs';
import { ProviderError, safeAdapterError } from './errors.mjs';
import { parseModelAddress, validModelId } from './address.mjs';
import { ensurePrivateDir, readPrivateFile, writePrivateFile } from './fs-safe.mjs';

export const MODEL_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_MODELS = 5000;
const MODEL_CAPABILITY_KEYS = Object.freeze(['streaming', 'tools', 'vision', 'reasoning', 'promptCaching']);
const SOURCES = new Set(['discovered', 'configured', 'builtin']);
const NAME = /^[^\u0000-\u001f\u007f-\u009f]{1,128}$/;
const limit = value => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000 ? value : null;
const cost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? value : null;

/** Contract model shape. Unknown token limits / prices / capabilities stay null — never guessed. */
export function normalizeModel(raw, provider, fallbackSource) {
  if (!raw || typeof raw !== 'object' || !validModelId(raw.id)) return undefined;
  if (raw.provider !== undefined && raw.provider !== provider) return undefined;
  const capabilities = {};
  for (const key of MODEL_CAPABILITY_KEYS) capabilities[key] = typeof raw.capabilities?.[key] === 'boolean' ? raw.capabilities[key] : null;
  return {
    id: raw.id, address: `${provider}/${raw.id}`,
    name: typeof raw.name === 'string' && NAME.test(raw.name) ? raw.name : raw.id,
    provider, capabilities,
    contextWindow: limit(raw.contextWindow), maxOutputTokens: limit(raw.maxOutputTokens),
    inputCost: cost(raw.inputCost), outputCost: cost(raw.outputCost),
    source: SOURCES.has(fallbackSource) ? fallbackSource : 'discovered',
  };
}

/** Per-provider TTL file cache of credential-less model metadata (pattern: Kilo ModelCache, 5 min TTL + refresh). */
export class ModelCache {
  constructor({ dir, platform = process.platform, uid = process.getuid?.(), ttlMs = MODEL_CACHE_TTL_MS, now = Date.now }) {
    this.dir = join(dir, 'models'); this.root = dir; this.platform = platform; this.uid = uid; this.ttlMs = ttlMs; this.now = now;
  }
  async read(provider, fingerprint) {
    let bytes;
    try { bytes = await readPrivateFile(join(this.dir, `${provider}.json`), { maxBytes: 4 * 1024 * 1024, platform: this.platform, uid: this.uid }); } catch { return undefined; }
    if (!bytes) return undefined;
    try {
      const data = JSON.parse(bytes.toString('utf8'));
      if (data?.version !== 1 || data.fingerprint !== fingerprint || !Number.isSafeInteger(data.fetchedAt) || !Array.isArray(data.models)) return undefined;
      const models = data.models.slice(0, MAX_MODELS).map(item => normalizeModel(item, provider, 'discovered')).filter(Boolean);
      return { models, fetchedAt: data.fetchedAt, fresh: this.now() - data.fetchedAt < this.ttlMs && this.now() >= data.fetchedAt };
    } catch { return undefined; }
  }
  async write(provider, fingerprint, models) {
    await ensurePrivateDir(this.root, { platform: this.platform, uid: this.uid });
    await ensurePrivateDir(this.dir, { platform: this.platform, uid: this.uid });
    const fetchedAt = this.now();
    await writePrivateFile(join(this.dir, `${provider}.json`), JSON.stringify({ version: 1, fingerprint, fetchedAt, models }), { platform: this.platform });
    return fetchedAt;
  }
}

/** Fingerprint of everything that changes the catalog EXCEPT secrets. */
export const catalogFingerprint = (descriptor, context = {}) => createHash('sha256').update(JSON.stringify([
  descriptor.apiType, descriptor.baseUrl, descriptor.options, descriptor.authMethods.map(m => m.id),
  descriptor.headers ?? null, context.revision ?? null, context.scope ?? null,
])).digest('hex');

export class ModelRegistry {
  #inflight = new Map();
  constructor({ providers, cache, clientFor, catalogContext = async () => ({}) }) { this.providers = providers; this.cache = cache; this.clientFor = clientFor; this.catalogContext = catalogContext; }

  async #discover(descriptor, { refresh, signal }) {
    if (descriptor.capabilities.modelDiscovery === false) return { models: [], status: 'unsupported', fetchedAt: null };
    let identity;
    try { identity = await this.catalogContext(descriptor); }
    catch (error) {
      if (signal?.aborted || error?.code === 'COMMAND_CANCELLED') throw new CommandError('COMMAND_CANCELLED');
      return { models: [], status: 'unavailable', fetchedAt: null, error: error instanceof CommandError ? error.code : 'MODEL_DISCOVERY_FAILED' };
    }
    const fingerprint = catalogFingerprint(descriptor, identity);
    const cached = identity.cacheable === false ? undefined : await this.cache.read(descriptor.id, fingerprint);
    if (cached?.fresh && !refresh) return { models: cached.models, status: 'cached', fetchedAt: cached.fetchedAt };
    const key = `${descriptor.id}:${fingerprint}`;
    if (!this.#inflight.has(key)) {
      const task = (async () => {
        const client = await this.clientFor(descriptor.id, { signal });
        if (typeof client.listModels !== 'function') return { models: [], status: 'unsupported', fetchedAt: null };
        const raw = await client.listModels({ signal });
        if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
        if (!Array.isArray(raw)) throw new ProviderError('ADAPTER_INVALID');
        const models = []; const seen = new Set();
        for (const item of raw.slice(0, MAX_MODELS)) {
          const model = normalizeModel(item, descriptor.id, 'discovered');
          if (model && !seen.has(model.id)) { seen.add(model.id); models.push(model); }
        }
        // A logout/account/config change cannot publish the old discovery into
        // the current cache generation, including a request already in flight.
        if (catalogFingerprint(descriptor, await this.catalogContext(descriptor)) !== fingerprint) throw new ProviderError('AUTH_SESSION_CHANGED');
        const fetchedAt = identity.cacheable === false ? this.cache.now() : await this.cache.write(descriptor.id, fingerprint, models);
        if (catalogFingerprint(descriptor, await this.catalogContext(descriptor)) !== fingerprint) throw new ProviderError('AUTH_SESSION_CHANGED');
        return { models, status: 'fresh', fetchedAt };
      })().finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, task);
    }
    try { return await this.#inflight.get(key); } catch (error) {
      if (error?.code === 'COMMAND_CANCELLED' || signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
      const safe = await safeAdapterError(error, 'MODEL_DISCOVERY_FAILED');
      const code = safe.code;
      if (cached && !['AUTH_REQUIRED', 'AUTH_SESSION_CHANGED', 'PROVIDER_AUTH_FAILED', 'PROVIDER_FORBIDDEN'].includes(code)) return { models: cached.models, status: 'stale', fetchedAt: cached.fetchedAt, error: code };
      return { models: [], status: 'unavailable', fetchedAt: null, error: code };
    }
  }

  /** Configured models are always listed; discovery adds what the provider actually reports. */
  async list({ provider, refresh = false, signal } = {}) {
    const descriptor = this.providers.adapterDescriptor(provider);
    const own = this.providers.get(provider);
    const configured = own.models.map(item => normalizeModel(item, descriptor.id, own.native ? 'builtin' : 'configured')).filter(Boolean);
    const discovery = await this.#discover(descriptor, { refresh, signal });
    const byId = new Map(discovery.models.map(item => [item.id, item]));
    for (const item of configured) {
      const found = byId.get(item.id);
      // User-supplied metadata fills unknowns; discovered facts are not overwritten.
      byId.set(item.id, found ? { ...found, contextWindow: found.contextWindow ?? item.contextWindow, maxOutputTokens: found.maxOutputTokens ?? item.maxOutputTokens, source: item.source } : item);
    }
    const ordered = [...configured.map(item => byId.get(item.id)), ...discovery.models.filter(item => !configured.some(c => c.id === item.id)).map(item => byId.get(item.id))];
    return { provider: descriptor.id, models: ordered, discovery: { status: discovery.status, fetchedAt: discovery.fetchedAt ? new Date(discovery.fetchedAt).toISOString() : null, ...(discovery.error ? { error: discovery.error } : {}) } };
  }

  async info(address, { signal, refresh = false } = {}) {
    const { provider, model } = parseModelAddress(address);
    const listing = await this.list({ provider, refresh, signal });
    const found = listing.models.find(item => item.id === model);
    if (found) return { ...found, discovery: listing.discovery };
    if (['unavailable', 'unsupported'].includes(listing.discovery.status)) throw new ProviderError('MODEL_UNAVAILABLE');
    throw new ProviderError('MODEL_NOT_FOUND');
  }
}
