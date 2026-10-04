// Anthropic Messages wire protocol (POST {base}/messages, named SSE events).
// Block/delta handling follows Kilo Code packages/llm/src/protocols/anthropic-messages.ts
// (MIT): content_block_start/delta/stop keyed by index, input_json_delta for tool
// arguments, message_delta stop_reason + cumulative output usage.
import { sseJson } from '../framing.mjs';
import { ToolCalls, usage } from '../request.mjs';
import { pushMerged, record, streamError, str } from './shared.mjs';
import { AdapterError, fail } from '../errors.mjs';

export const PATH = '/messages';
export const API_VERSION = '2023-06-01';
/** Messages requires max_tokens; used only when neither request nor descriptor sets one. */
export const FALLBACK_MAX_TOKENS = 4096;
const THINKING_BUDGET = { low: 1024, medium: 4096, high: 16384 };

export function buildBody(request, options = {}) {
  const messages = [];
  for (const message of request.messages) {
    if (message.role === 'tool') pushMerged(messages, 'user', [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]);
    else if (message.role === 'assistant') {
      const parts = [];
      if (message.content) parts.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) parts.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      if (parts.length) pushMerged(messages, 'assistant', parts);
    } else pushMerged(messages, 'user', [{ type: 'text', text: message.content }]);
  }
  if (messages[0]?.role !== 'user') fail('ADAPTER_REQUEST_INVALID');
  const maxTokens = request.maxOutputTokens ?? options.defaultMaxOutputTokens ?? FALLBACK_MAX_TOKENS;
  const body = { model: request.model, max_tokens: maxTokens, messages, stream: true };
  if (request.system) body.system = request.system;
  if (request.tools.length) {
    body.tools = request.tools.map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), input_schema: tool.parameters }));
    body.tool_choice = { type: request.toolChoice === 'required' ? 'any' : request.toolChoice };
  }
  if (request.reasoning !== undefined) {
    const budget = THINKING_BUDGET[request.reasoning];
    // Extended thinking requires budget < max_tokens and no custom temperature.
    if (budget >= maxTokens || request.temperature !== undefined) fail('ADAPTER_REQUEST_INVALID');
    body.thinking = { type: 'enabled', budget_tokens: budget };
  } else if (request.temperature !== undefined) body.temperature = Math.min(request.temperature, 1);
  return body;
}

function finishReason(reason, hasTools) {
  if (reason === 'end_turn' || reason === 'stop_sequence') return hasTools ? 'tool-calls' : 'stop';
  if (reason === 'tool_use') return 'tool-calls';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'length';
  if (reason === 'refusal') return 'content-filter';
  return 'other';
}

export async function* parse(chunks, options) {
  const tools = new ToolCalls();
  let input; let cacheRead; let cacheWrite; let output; let stop;
  let emitted = 0;
  for await (const item of sseJson(chunks, options)) {
    if (item.done) continue;
    const event = item.value;
    if (!record(event) || typeof event.type !== 'string') throw new AdapterError('PROVIDER_RESPONSE_INVALID');
    switch (event.type) {
      case 'message_start': {
        const u = event.message?.usage;
        input = u?.input_tokens; cacheRead = u?.cache_read_input_tokens ?? undefined; cacheWrite = u?.cache_creation_input_tokens ?? undefined; output = u?.output_tokens;
        break;
      }
      case 'content_block_start': {
        const block = event.content_block;
        if (!Number.isSafeInteger(event.index) || !record(block)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
        if (block.type === 'tool_use') tools.start(event.index, { id: str(block.id), name: str(block.name) });
        else if (block.type === 'text' && str(block.text)) yield { type: 'text-delta', text: block.text };
        else if (block.type === 'thinking' && str(block.thinking)) yield { type: 'reasoning-delta', text: block.thinking };
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta;
        if (!record(delta)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
        if (delta.type === 'text_delta' && str(delta.text)) yield { type: 'text-delta', text: delta.text };
        else if (delta.type === 'thinking_delta' && str(delta.thinking)) yield { type: 'reasoning-delta', text: delta.thinking };
        else if (delta.type === 'input_json_delta') tools.append(event.index, delta.partial_json ?? '');
        break;
      }
      case 'content_block_stop': {
        if (tools.has(event.index)) { const call = tools.finish(event.index); if (call) { emitted += 1; yield call; } }
        break;
      }
      case 'message_delta': {
        if (str(event.delta?.stop_reason)) stop = event.delta.stop_reason;
        if (Number.isSafeInteger(event.usage?.output_tokens)) output = event.usage.output_tokens;
        if (Number.isSafeInteger(event.usage?.input_tokens)) input = event.usage.input_tokens;
        break;
      }
      case 'message_stop': {
        for (const call of tools.finishAll()) { emitted += 1; yield call; }
        // Anthropic `input_tokens` excludes cache reads/writes; report the inclusive input.
        const inclusive = Number.isSafeInteger(input) ? input + (cacheRead ?? 0) + (cacheWrite ?? 0) : undefined;
        const u = usage({ input: inclusive, output, cacheRead, cacheWrite });
        if (Object.keys(u).length) yield { type: 'usage', usage: u };
        if (stop === undefined) throw new AdapterError('PROVIDER_STREAM_ERROR');
        yield { type: 'finish', reason: finishReason(stop, emitted > 0) };
        return;
      }
      case 'error': throw streamError(event.error?.type, event.error?.message);
      default: break; // ping and future event types
    }
  }
  throw new AdapterError('PROVIDER_STREAM_ERROR');
}

/** GET {base}/models: { data: [...], has_more, last_id } with after_id/limit paging. */
export function catalogPage(json) {
  if (!record(json) || !Array.isArray(json.data)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
  return { entries: json.data, next: json.has_more === true && typeof json.last_id === 'string' ? json.last_id : undefined };
}
