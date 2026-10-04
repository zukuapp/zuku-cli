// OpenAI Chat Completions wire protocol (POST {base}/chat/completions, SSE).
// Shared by OpenAI, OpenRouter, LM Studio, Azure (chat mode) and the
// OpenAI-compatible vendors. Stream reduction follows the pattern of Kilo Code
// packages/llm/src/protocols/openai-chat.ts (MIT, see docs/provider-api-contracts.md).
import { sseJson } from '../framing.mjs';
import { ToolCalls, usage } from '../request.mjs';
import { record, streamError, str } from './shared.mjs';
import { AdapterError } from '../errors.mjs';

export const PATH = '/chat/completions';

/**
 * @param request normalized request (request.mjs)
 * @param options { maxTokensField, streamUsage, structuredOutput: 'json_schema'|'json_object'|false,
 *                  reasoningEffort: boolean, extraBody }
 */
export function buildBody(request, options = {}) {
  const messages = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  for (const message of request.messages) {
    if (message.role === 'tool') messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
    else if (message.toolCalls?.length) {
      messages.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
      });
    } else messages.push({ role: message.role, content: message.content });
  }
  const body = { model: request.model, messages, stream: true };
  if (options.streamUsage !== false) body.stream_options = { include_usage: true };
  if (request.tools.length && request.toolChoice !== 'none') {
    body.tools = request.tools.map(tool => ({ type: 'function', function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters } }));
    body.tool_choice = request.toolChoice;
  }
  if (request.maxOutputTokens !== undefined) body[options.maxTokensField ?? 'max_tokens'] = request.maxOutputTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.reasoning !== undefined && options.reasoningEffort) body.reasoning_effort = request.reasoning;
  if (request.responseFormat) {
    if (options.structuredOutput === 'json_schema' && request.responseFormat.schema) body.response_format = { type: 'json_schema', json_schema: { name: 'output', schema: request.responseFormat.schema, strict: false } };
    else if (options.structuredOutput === 'json_schema' || options.structuredOutput === 'json_object') body.response_format = { type: 'json_object' };
  }
  if (record(options.extraBody)) Object.assign(body, options.extraBody);
  return body;
}

function finishReason(reason, hasTools) {
  if (reason === 'stop') return hasTools ? 'tool-calls' : 'stop';
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool-calls';
  if (reason === 'content_filter') return 'content-filter';
  return 'other';
}

function mapUsage(raw) {
  if (!record(raw)) return undefined;
  return usage({
    input: raw.prompt_tokens,
    output: raw.completion_tokens,
    reasoning: raw.completion_tokens_details?.reasoning_tokens,
    cacheRead: raw.prompt_tokens_details?.cached_tokens,
    total: raw.total_tokens,
  });
}

export async function* parse(chunks, options) {
  const tools = new ToolCalls();
  let finish;
  let lastUsage;
  for await (const item of sseJson(chunks, options)) {
    if (item.done) break;
    const event = item.value;
    if (!record(event)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
    if (event.error !== undefined) throw streamError(event.error?.code ?? event.error?.type, event.error?.message);
    const u = mapUsage(event.usage);
    if (u) lastUsage = u;
    const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
    if (!choice) continue;
    const delta = record(choice.delta) ? choice.delta : {};
    const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning);
    if (reasoning) yield { type: 'reasoning-delta', text: reasoning };
    if (str(delta.content)) yield { type: 'text-delta', text: delta.content };
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
      for (const call of delta.tool_calls) {
        const key = Number.isSafeInteger(call?.index) ? call.index : (typeof call?.id === 'string' ? call.id : undefined);
        if (key === undefined) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
        tools.start(key, { id: str(call.id), name: str(call.function?.name) });
        if (call.function?.arguments !== undefined) {
          // Some compatible servers send the complete arguments object instead of a string delta.
          tools.append(key, typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments));
        }
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finish ??= choice.finish_reason;
  }
  if (finish === undefined) throw new AdapterError('PROVIDER_STREAM_ERROR');
  const calls = tools.finishAll();
  yield* calls;
  if (lastUsage) yield { type: 'usage', usage: lastUsage };
  yield { type: 'finish', reason: finishReason(finish, calls.length > 0) };
}

/** GET {base}/models catalog: { data: [{ id }] } (some vendors return a bare array). */
export function catalogEntries(json) {
  const list = Array.isArray(json) ? json : json?.data;
  if (!Array.isArray(list)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
  return list;
}
