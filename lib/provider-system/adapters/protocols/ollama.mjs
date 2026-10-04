// Ollama native chat (POST {base}/api/chat, NDJSON stream; GET {base}/api/tags).
// Contract: github.com/ollama/ollama docs/api.md.
import { ndjson } from '../framing.mjs';
import { usage } from '../request.mjs';
import { record, streamError, str, toolNames, parseArguments } from './shared.mjs';
import { AdapterError, fail } from '../errors.mjs';

export const CHAT_PATH = '/api/chat';
export const TAGS_PATH = '/api/tags';

export function buildBody(request) {
  // Ollama has no tool_choice; forcing a call cannot be honoured.
  if (request.toolChoice === 'required') fail('ADAPTER_UNSUPPORTED');
  const names = toolNames(request.messages);
  const messages = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  for (const message of request.messages) {
    if (message.role === 'tool') messages.push({ role: 'tool', content: message.content, tool_name: message.name ?? names.get(message.toolCallId) });
    else if (message.toolCalls?.length) messages.push({ role: 'assistant', content: message.content, tool_calls: message.toolCalls.map(call => ({ function: { name: call.name, arguments: call.arguments } })) });
    else messages.push({ role: message.role, content: message.content });
  }
  const body = { model: request.model, messages, stream: true };
  if (request.tools.length && request.toolChoice !== 'none') body.tools = request.tools.map(tool => ({ type: 'function', function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters } }));
  if (request.reasoning !== undefined) body.think = request.reasoning;
  if (request.responseFormat) body.format = request.responseFormat.schema ?? 'json';
  const options = {};
  if (request.maxOutputTokens !== undefined) options.num_predict = request.maxOutputTokens;
  if (request.temperature !== undefined) options.temperature = request.temperature;
  if (Object.keys(options).length) body.options = options;
  return body;
}

export async function* parse(chunks, options) {
  let calls = 0;
  for await (const event of ndjson(chunks, options)) {
    if (!record(event)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
    if (event.error !== undefined) throw streamError(undefined, typeof event.error === 'string' ? event.error : event.error?.message);
    const message = record(event.message) ? event.message : {};
    if (str(message.thinking)) yield { type: 'reasoning-delta', text: message.thinking };
    if (str(message.content)) yield { type: 'text-delta', text: message.content };
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
      for (const call of message.tool_calls) {
        const name = str(call?.function?.name);
        if (!name || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
        if (++calls > 64) throw new AdapterError('PROVIDER_RESPONSE_TOO_LARGE');
        const id = typeof call.id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(call.id) ? call.id : `call_${calls}`;
        yield { type: 'tool-call', id, name, arguments: parseArguments(call.function.arguments ?? {}) };
      }
    }
    if (event.done === true) {
      const u = usage({ input: event.prompt_eval_count, output: event.eval_count });
      if (Object.keys(u).length) yield { type: 'usage', usage: u };
      const reason = event.done_reason;
      yield { type: 'finish', reason: reason === 'length' ? 'length' : reason === 'stop' || reason === undefined ? (calls ? 'tool-calls' : 'stop') : 'other' };
      return;
    }
  }
  throw new AdapterError('PROVIDER_STREAM_ERROR');
}
