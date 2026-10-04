// Built-in provider descriptors. Each entry names an implemented wire adapter
// (apiType), its fixed official endpoint, the credential fields/env names the core
// must resolve, and capability metadata for the *adapter* (what this CLI can send
// and parse). Model-level capabilities come only from live catalogs.
// Base URLs cross-checked against Kilo Code packages/llm/src/providers/* at
// 76bcfd40be616a72f4697b3041565f322245b462 and vendor documentation (see docs).

// AuthMethod: official/experimental/unofficial are metadata; unofficial === !official.
// `credential` names the getCredentials() kind the core must supply for this method.
const method = (fields) => Object.freeze({ official: true, experimental: false, unofficial: false, env: Object.freeze([]), ...fields });
const apiKey = (env, name = 'API 키') => method({ id: 'api-key', type: 'api-key', name, credential: 'api-key', env: Object.freeze([env]) });
const LOCAL = method({ id: 'local', type: 'local', name: '로컬 서버(키 없음)', credential: 'none' });

const caps = (patch = {}) => Object.freeze({
  streaming: true,
  tools: true,
  // Request schema is text-only: images are never sent by these adapters.
  vision: false,
  reasoning: false,
  modelDiscovery: false,
  promptCaching: null,
  structuredOutput: false,
  stage: true,
  nativeInference: null,
  ...patch,
});

/** Vendor profile: wire-specific knobs read only inside adapter factories. */
const chatVendor = (id, name, baseUrl, env, { catalog = 'openai', tools = true, maxTokensField = 'max_tokens', structuredOutput = false, reasoningEffort = false, reasoning = false, extra = {} } = {}) => ({
  id, name, apiType: 'openai-chat', baseUrl,
  authMethods: [apiKey(env)],
  capabilities: caps({ tools, reasoning, modelDiscovery: catalog !== 'none', structuredOutput }),
  options: { catalog, maxTokensField, structuredOutput, reasoningEffort, ...extra },
  tier: 'secondary',
});

const BUILTINS = [
  {
    id: 'zuku', name: 'ZUKU AI', apiType: 'zuku', baseUrl: 'https://www.zuzunza.com/api/v1',
    authMethods: [method({ id: 'zuku-oauth-device', type: 'device-code', name: 'ZUKU 계정 (게임 제작 동의)', credential: 'bearer' })],
    capabilities: caps({ streaming: false, tools: false, modelDiscovery: true, stage: true, nativeInference: true }),
    models: ['auto'],
    options: { defaultModel: 'auto' },
    tier: 'native',
  },
  {
    id: 'openai', name: 'OpenAI', apiType: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
    authMethods: [apiKey('OPENAI_API_KEY')],
    capabilities: caps({ reasoning: true, modelDiscovery: true, structuredOutput: 'json_schema', promptCaching: true }),
    options: { catalog: 'openai', maxTokensField: 'max_completion_tokens', structuredOutput: 'json_schema', reasoningEffort: true },
    tier: 'primary',
  },
  {
    id: 'anthropic', name: 'Anthropic', apiType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
    authMethods: [apiKey('ANTHROPIC_API_KEY')],
    capabilities: caps({ reasoning: true, modelDiscovery: true, promptCaching: true }),
    options: { catalog: 'anthropic' },
    tier: 'primary',
  },
  {
    id: 'google', name: 'Google Gemini', apiType: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authMethods: [apiKey('GEMINI_API_KEY')],
    capabilities: caps({ reasoning: true, modelDiscovery: true, structuredOutput: 'json_object' }),
    options: { catalog: 'gemini' },
    tier: 'primary',
  },
  {
    id: 'openrouter', name: 'OpenRouter', apiType: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1',
    authMethods: [apiKey('OPENROUTER_API_KEY')],
    capabilities: caps({ reasoning: true, modelDiscovery: true }),
    options: { catalog: 'openrouter', maxTokensField: 'max_tokens', extraBody: { usage: { include: true } } },
    tier: 'primary',
  },
  {
    id: 'amazon-bedrock', name: 'AWS Bedrock', apiType: 'bedrock', baseUrl: null,
    authMethods: [method({ id: 'aws-credential-chain', type: 'cloud-chain', name: 'AWS 기본 자격 증명 체인', credential: 'cloud-chain', sdk: Object.freeze(['@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-bedrock']) }), method({ id: 'aws-bedrock-api-key', type: 'api-key', name: 'Amazon Bedrock API Key', credential: 'api-key', env: Object.freeze(['AWS_BEARER_TOKEN_BEDROCK']) })],
    capabilities: caps({ reasoning: true, modelDiscovery: true }),
    options: { region: undefined, profile: undefined },
    tier: 'primary',
  },
  {
    id: 'google-vertex', name: 'Google Vertex AI', apiType: 'vertex', baseUrl: null,
    authMethods: [method({ id: 'google-adc', type: 'cloud-chain', name: 'Google 애플리케이션 기본 사용자 인증 정보(ADC)', credential: 'cloud-chain', sdk: Object.freeze(['google-auth-library']) })],
    capabilities: caps({ reasoning: true, modelDiscovery: true, structuredOutput: 'json_object' }),
    options: { project: undefined, location: 'global' },
    tier: 'primary',
  },
  {
    id: 'azure', name: 'Azure OpenAI', apiType: 'azure-openai', baseUrl: null,
    authMethods: [apiKey('AZURE_OPENAI_API_KEY')],
    // Model IDs are deployment names; /models lists base models, not deployments.
    capabilities: caps({ reasoning: true, modelDiscovery: false, structuredOutput: 'json_schema' }),
    options: { resourceName: undefined, wire: 'responses' },
    tier: 'primary',
  },
  {
    id: 'ollama', name: 'Ollama', apiType: 'ollama', baseUrl: 'http://127.0.0.1:11434',
    authMethods: [LOCAL],
    capabilities: caps({ reasoning: true, modelDiscovery: true, structuredOutput: 'json_schema' }),
    options: { allowLoopbackHttp: true },
    tier: 'primary',
  },
  {
    id: 'lmstudio', name: 'LM Studio', apiType: 'openai-chat', baseUrl: 'http://127.0.0.1:1234/v1',
    authMethods: [LOCAL],
    capabilities: caps({ modelDiscovery: true }),
    options: { catalog: 'openai', allowLoopbackHttp: true, maxTokensField: 'max_tokens' },
    tier: 'primary',
  },
  chatVendor('mistral', 'Mistral', 'https://api.mistral.ai/v1', 'MISTRAL_API_KEY', { catalog: 'mistral' }),
  chatVendor('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'DEEPSEEK_API_KEY', { reasoning: true }),
  chatVendor('groq', 'Groq', 'https://api.groq.com/openai/v1', 'GROQ_API_KEY'),
  chatVendor('xai', 'xAI', 'https://api.x.ai/v1', 'XAI_API_KEY'),
  chatVendor('alibaba', 'Qwen (Alibaba Model Studio)', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', { catalog: 'none' }),
  chatVendor('togetherai', 'Together AI', 'https://api.together.xyz/v1', 'TOGETHER_API_KEY'),
  chatVendor('fireworks', 'Fireworks AI', 'https://api.fireworks.ai/inference/v1', 'FIREWORKS_API_KEY', { catalog: 'none' }),
  chatVendor('cerebras', 'Cerebras', 'https://api.cerebras.ai/v1', 'CEREBRAS_API_KEY'),
  chatVendor('sambanova', 'SambaNova', 'https://api.sambanova.ai/v1', 'SAMBANOVA_API_KEY'),
  chatVendor('huggingface', 'Hugging Face Inference Providers', 'https://router.huggingface.co/v1', 'HF_TOKEN'),
  chatVendor('deepinfra', 'DeepInfra', 'https://api.deepinfra.com/v1/openai', 'DEEPINFRA_API_KEY'),
  chatVendor('vercel', 'Vercel AI Gateway', 'https://ai-gateway.vercel.sh/v1', 'AI_GATEWAY_API_KEY'),
  chatVendor('venice', 'Venice AI', 'https://api.venice.ai/api/v1', 'VENICE_API_KEY'),
  chatVendor('perplexity', 'Perplexity', 'https://api.perplexity.ai', 'PERPLEXITY_API_KEY', { catalog: 'none', tools: false }),
  {
    id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', apiType: 'openai-chat', baseUrl: null,
    authMethods: [method({ id: 'gateway-token', type: 'api-key', name: 'AI Gateway 토큰', credential: 'api-key', env: Object.freeze(['CLOUDFLARE_API_TOKEN']) })],
    capabilities: caps({ modelDiscovery: false }),
    options: { catalog: 'none', accountId: undefined, gatewayId: 'default', authHeader: 'cf-aig-authorization' },
    tier: 'secondary',
  },
  {
    id: 'codex', name: 'Codex (ChatGPT 계정)', apiType: 'codex', baseUrl: null,
    authMethods: [method({ id: 'codex-oauth', type: 'oauth', name: 'Codex OAuth', official: false, experimental: true, unofficial: true, credential: 'own-client' })],
    capabilities: caps({ tools: false, modelDiscovery: false }),
    options: { optIn: true },
    tier: 'experimental',
  },
];

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v); }
  return value;
};

/**
 * Lifecycle/support state. Registration is not proof of a working route:
 * - available: transport implemented; needs only the declared credential kind
 * - requires-config: needs the listed public options before use
 * - requires-sdk: needs the listed official SDK packages (lazy-loaded)
 * - catalog-only: only the read-only catalog is live (native contract pending)
 * - experimental-opt-in: own-client integration, explicit selection only
 */
const SUPPORT = {
  zuku: { state: 'available', requires: ['games:generate'] },
  'amazon-bedrock': { state: 'requires-sdk', requires: ['@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-bedrock'] },
  'google-vertex': { state: 'requires-sdk', requires: ['google-auth-library', 'options.project'] },
  azure: { state: 'requires-config', requires: ['options.resourceName|baseUrl', 'models'] },
  'cloudflare-ai-gateway': { state: 'requires-config', requires: ['options.accountId', 'models'] },
  codex: { state: 'experimental-opt-in', requires: ['codexModules'] },
};

/** Fresh frozen copies; `enabled` defaults: native on, everything else off until configured. */
export function listBuiltinDescriptors() {
  return BUILTINS.map(entry => deepFreeze(structuredClone({ ...entry, enabled: entry.id === 'zuku', models: entry.models ?? undefined, support: SUPPORT[entry.id] ?? { state: 'available', requires: [] } })));
}

export function builtinDescriptor(id) {
  return listBuiltinDescriptors().find(entry => entry.id === id);
}

/** API types accepted for user-defined custom endpoints. */
export const CUSTOM_API_TYPES = Object.freeze(['openai-chat', 'openai-responses', 'anthropic']);
