// OpenAI Responses wire protocol (POST {base}/responses, typed SSE events).
// Event handling mirrors Kilo Code packages/llm/src/protocols/openai-responses.ts
// (MIT): output_text / reasoning summary deltas, function_call items keyed by
// item id with call_id as the tool-call id, terminal completed/incomplete/failed.
import { sseJson } from '../framing.mjs';
import { ToolCalls, usage } from '../request.mjs';
import { record, streamError, str } from './shared.mjs';
import { AdapterError } from '../errors.mjs';

export const PATH = '/responses';

export function buildBody(request, options = {}) {
  const input = [];
  for (const message of request.messages) {
    if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
    else if (message.role === 'assistant') {
      if (message.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
    } else input.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] });
  }
  // store:false — no server-side retention of CLI conversations.
  const body = { model: request.model, input, stream: true, store: false };
  if (request.system) body.instructions = request.system;
  if (request.tools.length && request.toolChoice !== 'none') {
    body.tools = request.tools.map(tool => ({ type: 'function', name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters, strict: false }));
    body.tool_choice = request.toolChoice;
  }
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.reasoning !== undefined) body.reasoning = { effort: request.reasoning, summary: 'auto' };
  if (request.responseFormat && options.structuredOutput !== false) {
    body.text = { format: request.responseFormat.schema ? { type: 'json_schema', name: 'output', schema: request.responseFormat.schema, strict: false } : { type: 'json_object' } };
  }
  return body;
}

function mapUsage(raw) {
  if (!record(raw)) return undefined;
  return usage({
    input: raw.input_tokens,
    output: raw.output_tokens,
    reasoning: raw.output_tokens_details?.reasoning_tokens,
    cacheRead: raw.input_tokens_details?.cached_tokens,
    total: raw.total_tokens,
  });
}

const REASONING = new Set(['response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.reasoning_summary.delta']);

export async function* parse(chunks, options) {
  const tools = new ToolCalls();
  let emitted = 0;
  for await (const item of sseJson(chunks, options)) {
    if (item.done) break;
    const event = item.value;
    if (!record(event) || typeof event.type !== 'string') throw new AdapterError('PROVIDER_RESPONSE_INVALID');
    const type = event.type;
    if (type === 'response.output_text.delta') { if (str(event.delta)) yield { type: 'text-delta', text: event.delta }; continue; }
    if (REASONING.has(type)) { if (str(event.delta)) yield { type: 'reasoning-delta', text: event.delta }; continue; }
    if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const key = str(event.item.id) ?? str(event.item.call_id);
      if (!key) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
      tools.start(key, { id: str(event.item.call_id), name: str(event.item.name) });
      if (str(event.item.arguments)) tools.append(key, event.item.arguments);
      continue;
    }
    if (type === 'response.function_call_arguments.delta') { tools.append(str(event.item_id), event.delta); continue; }
    if (type === 'response.function_call_arguments.done') { if (str(event.arguments) !== undefined && tools.has(event.item_id)) tools.set(event.item_id, event.arguments); continue; }
    if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const key = str(event.item.id) ?? str(event.item.call_id);
      if (!key) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
      tools.start(key, { id: str(event.item.call_id), name: str(event.item.name) });
      if (str(event.item.arguments) !== undefined) tools.set(key, event.item.arguments);
      const call = tools.finish(key);
      if (call) { emitted += 1; yield call; }
      continue;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      for (const call of tools.finishAll()) { emitted += 1; yield call; }
      const u = mapUsage(event.response?.usage);
      if (u) yield { type: 'usage', usage: u };
      const reason = event.response?.incomplete_details?.reason;
      let finish = emitted ? 'tool-calls' : 'stop';
      if (type === 'response.incomplete') finish = reason === 'max_output_tokens' ? 'length' : reason === 'content_filter' ? 'content-filter' : 'other';
      yield { type: 'finish', reason: finish };
      return;
    }
    if (type === 'response.failed') throw streamError(event.response?.error?.code, event.response?.error?.message);
    if (type === 'error') throw streamError(event.code ?? event.error?.code, event.message ?? event.error?.message);
    // Other typed events (created, in_progress, content_part.*, hosted tools) carry no normalized output.
  }
  throw new AdapterError('PROVIDER_STREAM_ERROR');
}
