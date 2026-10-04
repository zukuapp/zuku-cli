import { join } from 'node:path';
import { ProviderError } from './errors.mjs';
import { validProviderId, validModelId, parseModelAddress } from './address.mjs';
import { validateEndpoint, validateHeaderName, ENV_NAME } from './endpoint.mjs';
import { CUSTOM_API_TYPES, DEFAULT_MODEL_ADDRESS, BUILTIN_IDS, normalizeApiType } from './catalog.mjs';
import { ensurePrivateDir, readPrivateFile, writePrivateFile, withLock } from './fs-safe.mjs';

export const CONFIG_FILE = 'config.json';
const MAX_CONFIG_BYTES = 262144;
const MAX_PROVIDERS = 64;
const MAX_MODELS = 200;
const NAME = /^[\x20-\x7e]{1,64}$/;
const SECRET_KEY = /(api[-_]?key|secret|token|passw|authori[sz]ation|credential|bearer|cookie|private[-_]?key|access[-_]?key)/i;
// Well-known credential shapes (OpenAI/Anthropic/Groq/xAI/HF/Google/AWS/GitHub/JWT/PEM).
const SECRET_VALUE = /^(sk-|sk_|sk-ant-|gsk_|xai-|hf_|AIza|AKIA|ASIA|ghp_|gho_|github_pat_|zk_|zuku_o[ar]_|eyJ[A-Za-z0-9_-]{8,}\.)|-----BEGIN/;
const SAFE_KEYS = new Set(['apiKeyEnv', 'maxOutputTokens']);
const OPTION_PATTERNS = Object.freeze({
  region: /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/,
  project: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
  location: /^(global|[a-z]+(-[a-z0-9]+)+)$/,
  catalog: /^(openai|none)$/,
  accountId: /^[a-f0-9]{32}$/,
  gatewayId: /^[A-Za-z0-9_-]{1,64}$/,
});
const ENTRY_KEYS = new Set(['enabled', 'custom', 'name', 'apiType', 'baseUrl', 'apiKeyEnv', 'headers', 'models', 'defaultModel', 'options']);
const MODEL_KEYS = new Set(['id', 'name', 'contextWindow', 'maxOutputTokens', 'capabilities']);
const MODEL_CAPS = new Set(['tools', 'vision', 'reasoning', 'streaming']);

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const fail = (code = 'PROVIDER_CONFIG_INVALID') => { throw new ProviderError(code); };
const positiveInt = value => value === undefined || (Number.isSafeInteger(value) && value > 0 && value <= 100_000_000);

/** Defense in depth: no credential-looking keys or values anywhere in public config. */
function rejectEmbeddedSecrets(value, path = []) {
  if (typeof value === 'string') { if (SECRET_VALUE.test(value)) fail('PROVIDER_SECRET_IN_CONFIG'); return; }
  if (Array.isArray(value)) { value.forEach(item => rejectEmbeddedSecrets(item, path)); return; }
  if (!record(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const headerName = path.at(-1) === 'headers';
    if (!headerName && !SAFE_KEYS.has(key) && SECRET_KEY.test(key)) fail('PROVIDER_SECRET_IN_CONFIG');
    rejectEmbeddedSecrets(child, [...path, key]);
  }
}

export function defaultConfig() {
  const { provider } = parseModelAddress(DEFAULT_MODEL_ADDRESS);
  return { version: 1, active: { provider, model: DEFAULT_MODEL_ADDRESS }, providers: {}, authRevisions: {} };
}

function normalizeModel(item) {
  if (!record(item) || Object.keys(item).some(key => !MODEL_KEYS.has(key)) || !validModelId(item.id)) fail();
  if (item.name !== undefined && !(typeof item.name === 'string' && NAME.test(item.name))) fail();
  if (!positiveInt(item.contextWindow) || !positiveInt(item.maxOutputTokens)) fail();
  if (item.capabilities !== undefined && (!record(item.capabilities) || Object.entries(item.capabilities).some(([key, flag]) => !MODEL_CAPS.has(key) || typeof flag !== 'boolean'))) fail();
  return { ...item };
}

export function normalizeEntry(id, entry) {
  if (!validProviderId(id) || !record(entry) || Object.keys(entry).some(key => !ENTRY_KEYS.has(key))) fail();
  rejectEmbeddedSecrets(entry);
  const out = {};
  if (entry.enabled !== undefined) { if (typeof entry.enabled !== 'boolean') fail(); out.enabled = entry.enabled; }
  if (entry.custom !== undefined) {
    if (entry.custom !== true || BUILTIN_IDS.has(id)) fail();
    const apiType = normalizeApiType(entry.apiType);
    if (!CUSTOM_API_TYPES.includes(apiType) || typeof entry.baseUrl !== 'string' || !(typeof entry.name === 'string' && NAME.test(entry.name))) fail();
    out.custom = true; out.name = entry.name; out.apiType = apiType;
  } else if (entry.name !== undefined || entry.apiType !== undefined) fail();
  if (entry.baseUrl !== undefined) out.baseUrl = validateEndpoint(entry.baseUrl);
  if (entry.apiKeyEnv !== undefined) { if (typeof entry.apiKeyEnv !== 'string' || !ENV_NAME.test(entry.apiKeyEnv)) fail(); out.apiKeyEnv = entry.apiKeyEnv; }
  if (entry.headers !== undefined) {
    if (!record(entry.headers) || Object.keys(entry.headers).length > 16) fail();
    out.headers = {};
    const seen = new Set();
    for (const [name, ref] of Object.entries(entry.headers)) {
      validateHeaderName(name);
      if (seen.has(name.toLowerCase())) fail();
      seen.add(name.toLowerCase());
      if (record(ref) && ref.source === 'secret' && Object.keys(ref).length === 1) out.headers[name] = { source: 'secret' };
      else if (record(ref) && ref.source === 'env' && Object.keys(ref).length === 2 && typeof ref.env === 'string' && ENV_NAME.test(ref.env)) out.headers[name] = { source: 'env', env: ref.env };
      else fail('PROVIDER_SECRET_IN_CONFIG');
    }
  }
  if (entry.models !== undefined) {
    if (!Array.isArray(entry.models) || entry.models.length > MAX_MODELS) fail();
    out.models = entry.models.map(normalizeModel);
    if (new Set(out.models.map(item => item.id)).size !== out.models.length) fail();
  }
  if (entry.defaultModel !== undefined) { if (!validModelId(entry.defaultModel)) fail(); out.defaultModel = entry.defaultModel; }
  if (entry.options !== undefined) {
    if (!record(entry.options)) fail();
    out.options = {};
    for (const [key, value] of Object.entries(entry.options)) {
      if (!Object.hasOwn(OPTION_PATTERNS, key) || typeof value !== 'string' || !OPTION_PATTERNS[key].test(value)) fail();
      if (key === 'catalog' && !(out.custom && ['openai-chat', 'openai-responses'].includes(out.apiType))) fail();
      if (['accountId', 'gatewayId'].includes(key) && id !== 'cloudflare-ai-gateway') fail();
      out.options[key] = value;
    }
  }
  return out;
}

export function normalizeConfig(raw) {
  if (!record(raw) || raw.version !== 1 || Object.keys(raw).some(key => !['version', 'active', 'providers', 'authRevisions'].includes(key))) fail();
  if (!record(raw.providers) || Object.keys(raw.providers).length > MAX_PROVIDERS) fail();
  const providers = {};
  for (const [id, entry] of Object.entries(raw.providers)) providers[id] = normalizeEntry(id, entry);
  const active = defaultConfig().active;
  if (raw.active !== undefined) {
    if (!record(raw.active) || Object.keys(raw.active).some(key => !['provider', 'model'].includes(key)) || !validProviderId(raw.active.provider)) fail();
    active.provider = raw.active.provider;
    active.model = raw.active.model === null || raw.active.model === undefined ? null : parseModelAddress(raw.active.model).address;
    if (active.model && !active.model.startsWith(`${active.provider}/`)) fail();
  }
  const authRevisions = {};
  if (raw.authRevisions !== undefined) {
    if (!record(raw.authRevisions) || Object.keys(raw.authRevisions).length > 256) fail();
    for (const [id, revision] of Object.entries(raw.authRevisions)) {
      if (!validProviderId(id) || typeof revision !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(revision)) fail();
      authRevisions[id] = revision;
    }
  }
  return { version: 1, active, providers, authRevisions };
}

/**
 * Public provider configuration (never secrets). One file shared by both
 * command names; every mutation is lock + read + validate + atomic replace.
 */
export class ConfigStore {
  constructor({ dir, platform = process.platform, uid = process.getuid?.() }) {
    this.dir = dir; this.platform = platform; this.uid = uid;
    this.file = join(dir, CONFIG_FILE);
  }
  async read() {
    const bytes = await readPrivateFile(this.file, { maxBytes: MAX_CONFIG_BYTES, platform: this.platform, uid: this.uid });
    if (!bytes) return defaultConfig();
    let raw;
    try { raw = JSON.parse(bytes.toString('utf8')); } catch { fail(); }
    return normalizeConfig(raw);
  }
  async update(mutate, { signal } = {}) {
    await ensurePrivateDir(this.dir, { platform: this.platform, uid: this.uid });
    return withLock(this.dir, async () => {
      const current = await this.read();
      const next = await mutate(structuredClone(current));
      const normalized = normalizeConfig(next ?? current);
      const text = JSON.stringify(normalized, null, 2) + '\n';
      if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) fail();
      await writePrivateFile(this.file, text, { platform: this.platform });
      return normalized;
    }, { signal });
  }
}
