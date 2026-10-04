// Protocol adapter entry point: one factory per wire API type. Vendor-specific
// behaviour lives inside the factory modules, never in callers.
import { AdapterError } from './errors.mjs';
import { createOpenAIChatAdapter, createOpenAIResponsesAdapter, createAzureOpenAIAdapter } from './openai.mjs';
import { createAnthropicAdapter } from './anthropic.mjs';
import { createGeminiAdapter, createVertexAdapter } from './gemini.mjs';
import { createOllamaAdapter } from './ollama.mjs';
import { createBedrockAdapter } from './bedrock.mjs';
import { createZukuNativeAdapter } from './zuku-native.mjs';
import { createCodexAdapter } from './codex.mjs';

export { listBuiltinDescriptors, builtinDescriptor, CUSTOM_API_TYPES } from './descriptors.mjs';
export { AdapterError, ADAPTER_ERROR_CODES } from './errors.mjs';
export { SDK_PACKAGES } from './sdk.mjs';
export { REQUEST_LIMITS, STREAM_LIMITS } from './request.mjs';
export { STAGE_LIMITS } from './stage.mjs';

// Cloud SDKs inside the Bedrock/Vertex factories are imported lazily on first use.
const FACTORIES = new Map([
  ['zuku', createZukuNativeAdapter],
  ['openai-responses', createOpenAIResponsesAdapter],
  ['openai-chat', createOpenAIChatAdapter],
  ['anthropic', createAnthropicAdapter],
  ['gemini', createGeminiAdapter],
  ['vertex', createVertexAdapter],
  ['azure-openai', createAzureOpenAIAdapter],
  ['ollama', createOllamaAdapter],
  ['bedrock', createBedrockAdapter],
  ['codex', createCodexAdapter],
]);

export const API_TYPES = Object.freeze([...FACTORIES.keys()]);

/**
 * createAdapter(descriptor, context) → client
 *   { id, name, authMethods, capabilities, listModels, validateAuth, stream, runStage }
 * descriptor: { id, name, apiType, baseUrl, enabled, authMethods, capabilities, models?, options }
 *   apiType ∈ API_TYPES (one enum shared with listBuiltinDescriptors and custom setup).
 * context (operational seams only; nothing here is exposed on the client):
 *   getCredentials({signal}) private, selected-provider scoped, called per operation
 *   fetch, signal, timeouts, limits, testOrigin (tests: explicit loopback origin),
 *   importModule (SDK loader seam), googleAuth (ADC client seam), nativeZuku,
 *   codexModules, codexStorePath, validateStageSchema, validateStageOutput
 */
export function createAdapter(descriptor, context = {}) {
  const factory = FACTORIES.get(descriptor?.apiType);
  if (!factory) throw new AdapterError('ADAPTER_UNKNOWN_API_TYPE');
  return factory(descriptor, context);
}
