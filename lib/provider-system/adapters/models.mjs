// Catalog → normalized model metadata. Only fields the vendor actually reports
// are mapped; anything else stays null (never guessed from model names).
import { AdapterError } from './errors.mjs';
import { validModelId } from './http.mjs';

const MAX_MODELS = 5000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => (Number.isSafeInteger(value) && value > 0 ? value : null);
const flag = value => (typeof value === 'boolean' ? value : null);
const label = (value, fallback) => (typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : fallback);
/** USD per token (string/number) → USD per 1M tokens. Negative/unknown → undefined. */
const perMillion = value => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined;
};

export function model(provider, id, { name, tools = null, vision = null, reasoning = null, contextWindow = null, maxOutputTokens = null, inputCost, outputCost, source = 'remote' } = {}) {
  const out = { id, address: `${provider}/${id}`, name: label(name, id), provider, capabilities: { tools, vision, reasoning }, contextWindow, maxOutputTokens, source };
  if (inputCost !== undefined) out.inputCost = inputCost;
  if (outputCost !== undefined) out.outputCost = outputCost;
  return out;
}

/** Keep valid, unique IDs; bound the catalog size. */
export function finalize(models) {
  const seen = new Set();
  const out = [];
  for (const entry of models) {
    if (!entry || !validModelId(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
    if (out.length > MAX_MODELS) throw new AdapterError('PROVIDER_RESPONSE_TOO_LARGE');
  }
  return out;
}

export const configuredModels = (provider, ids = []) => finalize((Array.isArray(ids) ? ids : []).map(id => (typeof id === 'string' ? model(provider, id, { source: 'configured' }) : undefined)));

export const CATALOGS = Object.freeze({
  /** OpenAI-style GET /models: id (+owned_by). No capability fields. */
  openai: (provider, entry) => (record(entry) && typeof entry.id === 'string' ? model(provider, entry.id) : undefined),
  /** OpenRouter GET /api/v1/models. */
  openrouter: (provider, entry) => {
    if (!record(entry) || typeof entry.id !== 'string') return undefined;
    const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : null;
    const modalities = Array.isArray(entry.architecture?.input_modalities) ? entry.architecture.input_modalities : null;
    return model(provider, entry.id, {
      name: entry.name,
      tools: params ? params.includes('tools') : null,
      reasoning: params ? params.includes('reasoning') : null,
      vision: modalities ? modalities.includes('image') : null,
      contextWindow: count(entry.context_length),
      maxOutputTokens: count(entry.top_provider?.max_completion_tokens),
      inputCost: perMillion(entry.pricing?.prompt),
      outputCost: perMillion(entry.pricing?.completion),
    });
  },
  /** Mistral GET /v1/models: capabilities.{function_calling,vision,reasoning}, max_context_length. */
  mistral: (provider, entry) => {
    if (!record(entry) || typeof entry.id !== 'string') return undefined;
    if (record(entry.capabilities) && entry.capabilities.completion_chat === false) return undefined;
    return model(provider, entry.id, {
      name: entry.name ?? undefined,
      tools: flag(entry.capabilities?.function_calling),
      vision: flag(entry.capabilities?.vision),
      reasoning: flag(entry.capabilities?.reasoning),
      contextWindow: count(entry.max_context_length),
    });
  },
  /** Anthropic GET /v1/models: display_name, max_input_tokens, max_tokens, capabilities.*. */
  anthropic: (provider, entry) => {
    if (!record(entry) || typeof entry.id !== 'string') return undefined;
    const c = record(entry.capabilities) ? entry.capabilities : {};
    return model(provider, entry.id, {
      name: entry.display_name,
      vision: flag(c.image_input?.supported),
      reasoning: flag(c.thinking?.supported),
      contextWindow: count(entry.max_input_tokens),
      maxOutputTokens: count(entry.max_tokens),
    });
  },
  /** Gemini GET /v1beta/models: name "models/x", token limits, supportedGenerationMethods, thinking. */
  gemini: (provider, entry) => {
    if (!record(entry) || typeof entry.name !== 'string' || !entry.name.startsWith('models/')) return undefined;
    const methods = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : null;
    if (methods && !methods.includes('generateContent')) return undefined;
    return model(provider, entry.name.slice('models/'.length), {
      name: entry.displayName,
      reasoning: flag(entry.thinking),
      contextWindow: count(entry.inputTokenLimit),
      maxOutputTokens: count(entry.outputTokenLimit),
    });
  },
  /** Vertex GET v1beta1/publishers/google/models: publisherModels[].name "publishers/google/models/x". */
  vertex: (provider, entry) => {
    const prefix = 'publishers/google/models/';
    if (!record(entry) || typeof entry.name !== 'string' || !entry.name.startsWith(prefix)) return undefined;
    return model(provider, entry.name.slice(prefix.length));
  },
  /** Ollama GET /api/tags: models[].model|name. */
  ollama: (provider, entry) => {
    if (!record(entry)) return undefined;
    const id = typeof entry.model === 'string' ? entry.model : entry.name;
    return typeof id === 'string' ? model(provider, id, { name: entry.name }) : undefined;
  },
  /** Bedrock ListFoundationModels summaries (TEXT output, streaming). */
  bedrockFoundation: (provider, entry) => {
    if (!record(entry) || typeof entry.modelId !== 'string') return undefined;
    if (entry.responseStreamingSupported === false) return undefined;
    const input = Array.isArray(entry.inputModalities) ? entry.inputModalities : null;
    return model(provider, entry.modelId, { name: [entry.providerName, entry.modelName].filter(v => typeof v === 'string').join(' ') || undefined, vision: input ? input.includes('IMAGE') : null });
  },
  /** Bedrock ListInferenceProfiles summaries (cross-region IDs such as us.vendor.model). */
  bedrockProfile: (provider, entry) => {
    if (!record(entry) || typeof entry.inferenceProfileId !== 'string' || (entry.status && entry.status !== 'ACTIVE')) return undefined;
    return model(provider, entry.inferenceProfileId, { name: entry.inferenceProfileName });
  },
});
