import { ProviderError } from './errors.mjs';

// Authentication METHOD metadata. `official`/`experimental` drive the (exp!)
// rendering; nothing is inferred from names. Storage says where a credential
// lives — never the credential itself.
const method = (id, type, name, official, experimental, storage, extra = {}) => Object.freeze({ id, type, name, official, experimental, unofficial: !official, storage, ...extra });

export const BUILTIN_AUTH_METHODS = Object.freeze([
  method('api-key', 'api-key', 'API Key', true, false, 'secure-store', { interactive: true }),
  method('environment', 'environment', 'Environment Variable', true, false, 'environment'),
  method('aws-credential-chain', 'cloud-chain', 'AWS Credential Chain', true, false, 'credential-chain'),
  method('aws-bedrock-api-key', 'api-key', 'Amazon Bedrock API Key', true, false, 'secure-store', { interactive: true }),
  method('google-adc', 'cloud-chain', 'Google Application Default Credentials', true, false, 'credential-chain'),
  method('local', 'local', 'Local (no credentials)', true, false, 'none'),
  method('zuku-oauth-device', 'oauth-device', 'ZUKU OAuth (Device Code)', true, false, 'zuku-account-store', { interactive: true, delegate: 'zuku' }),
  method('game-cli-device', 'oauth-device', 'ZUKU Game CLI OAuth', true, false, 'zuku-account-store', { interactive: true, delegate: 'zuku', requiredScope: 'games:generate' }),
  method('zuku-env-token', 'environment', 'ZUKU Access Token (environment)', true, false, 'environment', { env: ['ZUKUJS_ACCESS_TOKEN', 'ZUKU_ACCESS_TOKEN'] }),
  // Custom endpoints: the service's official auth is unknown, so compatibility
  // keys default to experimental and render (exp!).
  method('custom-api-key', 'custom-endpoint', 'Custom Endpoint API Key', false, true, 'secure-store', { interactive: true }),
  method('custom-env', 'custom-endpoint', 'Custom Endpoint Environment Key', false, true, 'environment'),
  method('custom-none', 'local', 'No credentials', false, true, 'none'),
]);

/** Fallback only when root lib/experimental.mjs is absent; root CODEX_AUTH_METHOD wins. */
export const CODEX_AUTH_FALLBACK = method('codex-oauth', 'experimental-oauth', 'Codex OAuth', false, true, 'codex-store', { interactive: true, delegate: 'codex', optIn: true });

export function normalizeAuthMethod(input) {
  if (!input || typeof input !== 'object' || typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) throw new ProviderError('ADAPTER_INVALID');
  const experimental = input.experimental === true || input.official !== true;
  return Object.freeze({
    id: input.id,
    type: typeof input.type === 'string' && /^[a-z-]{1,32}$/.test(input.type) ? input.type : 'experimental-oauth',
    name: typeof input.name === 'string' && /^[\x20-\x7e]{1,64}$/.test(input.name) ? input.name : input.id,
    // Official must be asserted explicitly; anything ambiguous is experimental.
    official: input.official === true && input.experimental !== true,
    unofficial: !(input.official === true && input.experimental !== true),
    experimental,
    storage: typeof input.storage === 'string' && /^[a-z-]{1,32}$/.test(input.storage) ? input.storage : 'external',
    ...(input.interactive === true ? { interactive: true } : {}),
    ...(typeof input.delegate === 'string' ? { delegate: input.delegate } : {}),
    ...(experimental ? { optIn: true } : {}),
  });
}

export class AuthRegistry {
  #methods = new Map();
  constructor({ codexMethod } = {}) {
    for (const item of BUILTIN_AUTH_METHODS) this.#methods.set(item.id, item);
    const codex = normalizeAuthMethod({ ...CODEX_AUTH_FALLBACK, ...(codexMethod ?? {}), id: 'codex-oauth', delegate: 'codex', storage: 'codex-store' });
    // Our Codex integration is never official, regardless of supplied metadata.
    this.#methods.set('codex-oauth', Object.freeze({ ...codex, official: false, experimental: true, unofficial: true, optIn: true }));
  }
  get(id) {
    const found = this.#methods.get(id);
    if (!found) throw new ProviderError('AUTH_METHOD_UNSUPPORTED');
    return found;
  }
  has(id) { return this.#methods.has(id); }
  list() { return [...this.#methods.values()]; }
  forProvider(descriptor) { return descriptor.authMethods.map(id => this.get(id)); }
  /** Secure-store method a provider accepts for an interactively entered key, if any. */
  keyMethod(descriptor) { return this.forProvider(descriptor).find(item => item.storage === 'secure-store'); }
}
