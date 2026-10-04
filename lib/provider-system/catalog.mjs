// Built-in provider METADATA only (no transport). Fixed base URLs/env names were
// verified against the vendors' official SDK defaults published on npm
// (@ai-sdk/openai@4.0.83, @ai-sdk/anthropic@4.0.71, @ai-sdk/google@4.0.87,
// @ai-sdk/google-vertex@5.0.101, @ai-sdk/amazon-bedrock@5.0.105, @ai-sdk/azure@4.0.90,
// @openrouter/ai-sdk-provider@3.1.0, @ai-sdk/mistral@4.0.56, @ai-sdk/deepseek@3.0.58,
// @ai-sdk/groq@4.0.54, @ai-sdk/xai@5.0.14, @ai-sdk/alibaba@2.0.60, @ai-sdk/togetherai@3.0.63,
// @ai-sdk/fireworks@3.0.65, @ai-sdk/cerebras@3.0.62, sambanova-ai-provider@1.2.2,
// @ai-sdk/huggingface@2.0.62) and the vendors' API references listed in docs/providers.md.
// Capability values are provider-level API facts; per-model facts stay null (unknown)
// until an adapter or discovery endpoint reports them.
export const NATIVE_PROVIDER_ID = 'zuku';
export const DEFAULT_MODEL_ADDRESS = 'zuku/auto';
export const API_TYPES = Object.freeze(['zuku', 'openai-responses', 'openai-chat', 'anthropic', 'gemini', 'vertex', 'azure-openai', 'ollama', 'bedrock', 'codex']);
export { normalizeProviderApiType as normalizeApiType } from '../agent-protocol/schema.mjs';
export const CUSTOM_API_TYPES = Object.freeze(['openai-chat', 'openai-responses', 'anthropic']);
export const CAPABILITY_KEYS = Object.freeze(['streaming', 'tools', 'vision', 'reasoning', 'modelDiscovery', 'promptCaching', 'stageInference']);

const caps = (values = {}) => Object.freeze(Object.fromEntries(CAPABILITY_KEYS.map(key => [key, values[key] ?? null])));
const hosted = (id, name, apiType, baseUrl, env, { capabilities, ...extra } = {}) => ({ id, name, apiType, baseUrl, env, authMethods: ['api-key', 'environment'], capabilities: caps({ streaming: true, tools: true, ...capabilities }), ...extra });

export const BUILTIN_PROVIDERS = Object.freeze([
  {
    id: 'zuku', name: 'ZUKU AI', apiType: 'zuku', baseUrl: 'https://www.zuzunza.com/api/v1', env: [], native: true,
    authMethods: ['game-cli-device'],
    // `auto` is server routed. Support describes the frozen scoped OAuth API;
    // missing games:generate/auth or a server 503 is an error, never a fallback.
    models: [{ id: 'auto', name: 'Auto (ZUKU server routing)' }],
    capabilities: caps({ modelDiscovery: true, stageInference: true, streaming: false, tools: false }),
  },
  hosted('openai', 'OpenAI', 'openai-responses', 'https://api.openai.com/v1', ['OPENAI_API_KEY'], { capabilities: { modelDiscovery: true, promptCaching: true } }),
  hosted('anthropic', 'Anthropic', 'anthropic', 'https://api.anthropic.com', ['ANTHROPIC_API_KEY'], { capabilities: { modelDiscovery: true, promptCaching: true } }),
  hosted('google', 'Google Gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta', ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'], { capabilities: { modelDiscovery: true } }),
  hosted('openrouter', 'OpenRouter', 'openai-chat', 'https://openrouter.ai/api/v1', ['OPENROUTER_API_KEY'], { capabilities: { modelDiscovery: true } }),
  {
    id: 'amazon-bedrock', name: 'AWS Bedrock', apiType: 'bedrock', baseUrl: null, env: ['AWS_BEARER_TOKEN_BEDROCK'],
    authMethods: ['aws-credential-chain', 'aws-bedrock-api-key'], requiredOptions: ['region'],
    capabilities: caps({ streaming: true, tools: true }),
  },
  {
    id: 'google-vertex', name: 'Google Vertex AI', apiType: 'vertex', baseUrl: null, env: [],
    authMethods: ['google-adc'], requiredOptions: ['project', 'location'],
    capabilities: caps({ streaming: true, tools: true }),
  },
  {
    id: 'azure', name: 'Azure OpenAI', apiType: 'azure-openai', baseUrl: null, env: ['AZURE_OPENAI_API_KEY', 'AZURE_API_KEY'],
    authMethods: ['api-key', 'environment'], requiresBaseUrl: true,
    hostSuffixes: ['.openai.azure.com', '.cognitiveservices.azure.com', '.services.ai.azure.com'],
    capabilities: caps({ streaming: true, tools: true }),
  },
  { id: 'ollama', name: 'Ollama', apiType: 'ollama', baseUrl: 'http://127.0.0.1:11434', env: [], local: true, authMethods: ['local'], capabilities: caps({ streaming: true, modelDiscovery: true }) },
  { id: 'lmstudio', name: 'LM Studio', apiType: 'openai-chat', baseUrl: 'http://127.0.0.1:1234/v1', env: [], local: true, authMethods: ['local'], capabilities: caps({ streaming: true, modelDiscovery: true }) },
  hosted('mistral', 'Mistral', 'openai-chat', 'https://api.mistral.ai/v1', ['MISTRAL_API_KEY'], { capabilities: { modelDiscovery: true } }),
  hosted('deepseek', 'DeepSeek', 'openai-chat', 'https://api.deepseek.com', ['DEEPSEEK_API_KEY'], { capabilities: { modelDiscovery: true } }),
  hosted('groq', 'Groq', 'openai-chat', 'https://api.groq.com/openai/v1', ['GROQ_API_KEY'], { capabilities: { modelDiscovery: true } }),
  hosted('xai', 'xAI', 'openai-chat', 'https://api.x.ai/v1', ['XAI_API_KEY'], { capabilities: { modelDiscovery: true } }),
  hosted('alibaba', 'Alibaba Qwen (DashScope)', 'openai-chat', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', ['DASHSCOPE_API_KEY', 'ALIBABA_API_KEY']),
  hosted('togetherai', 'Together AI', 'openai-chat', 'https://api.together.xyz/v1', ['TOGETHER_API_KEY'], { capabilities: { modelDiscovery: true } }),
  hosted('fireworks', 'Fireworks AI', 'openai-chat', 'https://api.fireworks.ai/inference/v1', ['FIREWORKS_API_KEY']),
  hosted('cerebras', 'Cerebras', 'openai-chat', 'https://api.cerebras.ai/v1', ['CEREBRAS_API_KEY'], { capabilities: { modelDiscovery: true } }),
  hosted('sambanova', 'SambaNova', 'openai-chat', 'https://api.sambanova.ai/v1', ['SAMBANOVA_API_KEY']),
  hosted('huggingface', 'Hugging Face Inference Providers', 'openai-chat', 'https://router.huggingface.co/v1', ['HF_TOKEN', 'HUGGINGFACE_API_KEY'], { capabilities: { modelDiscovery: true } }),
  hosted('vercel', 'Vercel AI Gateway', 'openai-chat', 'https://ai-gateway.vercel.sh/v1', ['AI_GATEWAY_API_KEY'], { capabilities: { modelDiscovery: true } }),
  // The adapter builds the pinned official route from finite public IDs.
  hosted('cloudflare-ai-gateway', 'Cloudflare AI Gateway', 'openai-chat', null, ['CLOUDFLARE_API_TOKEN'], { requiredOptions: ['accountId', 'gatewayId'] }),
  {
    // Existing own-client Codex integration: opt-in only, never a fallback.
    id: 'codex', name: 'Codex (ChatGPT account)', apiType: 'codex', baseUrl: null, env: [],
    authMethods: ['codex-oauth'], capabilities: caps({ streaming: true }),
  },
].map(entry => Object.freeze({ ...entry, builtin: true, custom: false })));

export const BUILTIN_IDS = Object.freeze(new Set(BUILTIN_PROVIDERS.map(entry => entry.id)));
export { caps as normalizeCapabilities };
