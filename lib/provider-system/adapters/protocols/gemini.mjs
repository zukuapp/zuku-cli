// Gemini generateContent wire protocol, shared by the Gemini API
// ({base}/models/{model}:streamGenerateContent?alt=sse, x-goog-api-key) and Vertex AI
// (.../publishers/google/models/{model}:streamGenerateContent?alt=sse, OAuth bearer).
// Tool-schema projection adapts Kilo Code packages/llm/src/protocols/utils/gemini-tool-schema.ts
// and stream reduction packages/llm/src/protocols/gemini.ts (MIT).
import { sseJson } from '../framing.mjs';
import { usage } from '../request.mjs';
import { pushMerged, record, streamError, str, toolNames, parseArguments } from './shared.mjs';
import { AdapterError, fail } from '../errors.mjs';
import { segment } from '../http.mjs';

export const streamPath = model => `/models/${segment(model)}:streamGenerateContent`;
export const STREAM_QUERY = Object.freeze({ alt: 'sse' });

/** Project JSON Schema onto the OpenAPI subset accepted by functionDeclarations.parameters. */
export function projectSchema(schema, depth = 0) {
  if (!record(schema) || depth > 32) return undefined;
  const type = Array.isArray(schema.type) ? schema.type.find(t => t !== 'null') : schema.type;
  const out = {};
  if (typeof type === 'string') out.type = type;
  if (Array.isArray(schema.type) && schema.type.includes('null')) out.nullable = true;
  if (typeof schema.description === 'string') out.description = schema.description;
  if (typeof schema.format === 'string') out.format = schema.format;
  const values = schema.const !== undefined ? [schema.const] : schema.enum;
  if (Array.isArray(values)) { out.enum = values.map(String); if (out.type === 'integer' || out.type === 'number') out.type = 'string'; }
  if (out.type === 'object' && record(schema.properties)) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) out.properties[key] = projectSchema(value, depth + 1) ?? { type: 'string' };
    if (Array.isArray(schema.required)) out.required = schema.required.filter(key => typeof key === 'string' && key in out.properties);
  }
  if (out.type === 'array') out.items = projectSchema(schema.items, depth + 1) ?? { type: 'string' };
  for (const combiner of ['anyOf', 'oneOf']) if (Array.isArray(schema[combiner])) out.anyOf = schema[combiner].map(s => projectSchema(s, depth + 1)).filter(Boolean);
  return out;
}

export function buildBody(request) {
  const names = toolNames(request.messages);
  const contents = [];
  for (const message of request.messages) {
    if (message.role === 'tool') {
      const name = message.name ?? names.get(message.toolCallId);
      if (!name) fail('ADAPTER_REQUEST_INVALID');
      pushMerged(contents, 'user', [{ functionResponse: { name, response: { content: message.content } } }], 'parts');
    } else if (message.role === 'assistant') {
      const parts = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) parts.push({ functionCall: { name: call.name, args: call.arguments } });
      if (parts.length) pushMerged(contents, 'model', parts, 'parts');
    } else pushMerged(contents, 'user', [{ text: message.content }], 'parts');
  }
  const body = { contents };
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
  if (request.tools.length) {
    body.tools = [{ functionDeclarations: request.tools.map(tool => {
      const parameters = projectSchema(tool.parameters);
      return { name: tool.name, ...(tool.description ? { description: tool.description } : {}), ...(parameters?.properties && Object.keys(parameters.properties).length ? { parameters } : {}) };
    }) }];
    body.toolConfig = { functionCallingConfig: { mode: request.toolChoice === 'required' ? 'ANY' : request.toolChoice === 'none' ? 'NONE' : 'AUTO' } };
  }
  const generationConfig = {};
  if (request.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = request.maxOutputTokens;
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.responseFormat) generationConfig.responseMimeType = 'application/json';
  if (request.reasoning !== undefined) generationConfig.thinkingConfig = { includeThoughts: true };
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return body;
}

const FILTERED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);
function finishReason(reason, hasTools) {
  if (reason === 'STOP') return hasTools ? 'tool-calls' : 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (FILTERED.has(reason)) return 'content-filter';
  return 'other';
}

export async function* parse(chunks, options) {
  let finish; let lastUsage; let calls = 0;
  for await (const item of sseJson(chunks, options)) {
    if (item.done) continue;
    const event = item.value;
    if (!record(event)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
    if (event.error !== undefined) throw streamError(event.error?.status, event.error?.message);
    if (record(event.usageMetadata)) {
      const m = event.usageMetadata;
      // candidatesTokenCount excludes thoughtsTokenCount; output reported inclusive.
      const output = Number.isSafeInteger(m.candidatesTokenCount) ? m.candidatesTokenCount + (Number.isSafeInteger(m.thoughtsTokenCount) ? m.thoughtsTokenCount : 0) : undefined;
      lastUsage = usage({ input: m.promptTokenCount, output, reasoning: m.thoughtsTokenCount, cacheRead: m.cachedContentTokenCount, total: m.totalTokenCount });
    }
    if (str(event.promptFeedback?.blockReason)) finish = 'SAFETY';
    const candidate = Array.isArray(event.candidates) ? event.candidates[0] : undefined;
    if (!candidate) continue;
    for (const part of Array.isArray(candidate.content?.parts) ? candidate.content.parts : []) {
      if (!record(part)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
      if (str(part.text)) yield { type: part.thought === true ? 'reasoning-delta' : 'text-delta', text: part.text };
      if (record(part.functionCall)) {
        const name = str(part.functionCall.name);
        if (!name || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
        calls += 1;
        if (calls > 64) throw new AdapterError('PROVIDER_RESPONSE_TOO_LARGE');
        const id = typeof part.functionCall.id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(part.functionCall.id) ? part.functionCall.id : `call_${calls}`;
        yield { type: 'tool-call', id, name, arguments: parseArguments(part.functionCall.args ?? {}) };
      }
    }
    if (str(candidate.finishReason)) finish = candidate.finishReason;
  }
  if (finish === undefined) throw new AdapterError('PROVIDER_STREAM_ERROR');
  if (lastUsage && Object.keys(lastUsage).length) yield { type: 'usage', usage: lastUsage };
  yield { type: 'finish', reason: finishReason(finish, calls > 0) };
}
