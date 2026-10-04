import { AdapterError, fail } from './errors.mjs';
import { requireModelId } from './http.mjs';

/** Protocol input limits shared by every adapter. */
export const REQUEST_LIMITS = Object.freeze({
  messages: 1024,
  contentBytes: 8 * 1024 * 1024,
  systemBytes: 1024 * 1024,
  tools: 128,
  toolSchemaBytes: 64 * 1024,
  toolCallsPerMessage: 64,
  maxOutputTokens: 1_000_000,
});
export const STREAM_LIMITS = Object.freeze({
  textBytes: 8 * 1024 * 1024,
  toolArgumentBytes: 1024 * 1024,
  toolCalls: 64,
  events: 500_000,
});

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ROLES = new Set(['user', 'assistant', 'tool']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = value => Buffer.byteLength(value, 'utf8');

function jsonSize(value) {
  try { return bytes(JSON.stringify(value)); } catch { fail('ADAPTER_REQUEST_INVALID'); }
}

/**
 * Normalize the provider-independent stream request. Text-only content; tool
 * definitions are declared to the model but never executed by an adapter.
 */
export function normalizeRequest(request, { defaultModel } = {}) {
  if (!record(request)) fail('ADAPTER_REQUEST_INVALID');
  const model = requireModelId(request.model ?? defaultModel);
  const system = request.system ?? undefined;
  if (system !== undefined && (typeof system !== 'string' || bytes(system) > REQUEST_LIMITS.systemBytes)) fail('ADAPTER_REQUEST_INVALID');
  if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > REQUEST_LIMITS.messages) fail('ADAPTER_REQUEST_INVALID');
  let total = 0;
  const known = new Set();
  const messages = request.messages.map(message => {
    if (!record(message) || !ROLES.has(message.role)) fail('ADAPTER_REQUEST_INVALID');
    const content = message.content ?? '';
    if (typeof content !== 'string') fail('ADAPTER_REQUEST_INVALID');
    total += bytes(content);
    if (message.role === 'tool') {
      if (!CALL_ID.test(message.toolCallId ?? '') || !known.has(message.toolCallId)) fail('ADAPTER_REQUEST_INVALID');
      if (message.name !== undefined && !TOOL_NAME.test(message.name)) fail('ADAPTER_REQUEST_INVALID');
      return { role: 'tool', toolCallId: message.toolCallId, name: message.name, content };
    }
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      if (!Array.isArray(message.toolCalls) || message.toolCalls.length > REQUEST_LIMITS.toolCallsPerMessage) fail('ADAPTER_REQUEST_INVALID');
      const toolCalls = message.toolCalls.map(call => {
        if (!record(call) || !CALL_ID.test(call.id ?? '') || !TOOL_NAME.test(call.name ?? '') || !record(call.arguments)) fail('ADAPTER_REQUEST_INVALID');
        total += jsonSize(call.arguments);
        known.add(call.id);
        return { id: call.id, name: call.name, arguments: call.arguments };
      });
      return { role: 'assistant', content, toolCalls };
    }
    if (message.toolCalls !== undefined) fail('ADAPTER_REQUEST_INVALID');
    return { role: message.role, content };
  });
  if (total > REQUEST_LIMITS.contentBytes) fail('ADAPTER_REQUEST_INVALID');
  if (messages[0].role === 'tool') fail('ADAPTER_REQUEST_INVALID');
  let tools = [];
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools) || request.tools.length > REQUEST_LIMITS.tools) fail('ADAPTER_REQUEST_INVALID');
    const names = new Set();
    tools = request.tools.map(tool => {
      if (!record(tool) || !TOOL_NAME.test(tool.name ?? '') || names.has(tool.name)) fail('ADAPTER_REQUEST_INVALID');
      names.add(tool.name);
      if (tool.description !== undefined && (typeof tool.description !== 'string' || bytes(tool.description) > 8192)) fail('ADAPTER_REQUEST_INVALID');
      const parameters = tool.parameters ?? { type: 'object', properties: {} };
      if (!record(parameters) || parameters.type !== 'object' || jsonSize(parameters) > REQUEST_LIMITS.toolSchemaBytes) fail('ADAPTER_REQUEST_INVALID');
      return { name: tool.name, description: tool.description, parameters };
    });
  }
  const toolChoice = request.toolChoice ?? (tools.length ? 'auto' : undefined);
  if (toolChoice !== undefined && !['auto', 'none', 'required'].includes(toolChoice)) fail('ADAPTER_REQUEST_INVALID');
  if (toolChoice !== undefined && toolChoice !== 'none' && !tools.length) fail('ADAPTER_REQUEST_INVALID');
  const maxOutputTokens = request.maxOutputTokens;
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > REQUEST_LIMITS.maxOutputTokens)) fail('ADAPTER_REQUEST_INVALID');
  const temperature = request.temperature;
  if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) fail('ADAPTER_REQUEST_INVALID');
  const reasoning = request.reasoning;
  if (reasoning !== undefined && !['low', 'medium', 'high'].includes(reasoning)) fail('ADAPTER_REQUEST_INVALID');
  let responseFormat;
  if (request.responseFormat !== undefined) {
    const format = request.responseFormat;
    if (!record(format) || format.type !== 'json' || (format.schema !== undefined && (!record(format.schema) || jsonSize(format.schema) > REQUEST_LIMITS.toolSchemaBytes))) fail('ADAPTER_REQUEST_INVALID');
    responseFormat = { type: 'json', schema: format.schema };
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) fail('ADAPTER_REQUEST_INVALID');
  if (request.includeReasoning !== undefined && typeof request.includeReasoning !== 'boolean') fail('ADAPTER_REQUEST_INVALID');
  return { model, system, messages, tools, toolChoice, maxOutputTokens, temperature, reasoning, responseFormat, includeReasoning: request.includeReasoning === true, signal: request.signal };
}

/** Tool-call argument accumulation keyed by stream index/item id, bounded. */
export class ToolCalls {
  constructor() { this.calls = new Map(); this.order = []; this.emitted = new Set(); }
  start(key, { id, name } = {}) {
    let call = this.calls.get(key);
    if (!call) {
      if (this.calls.size >= STREAM_LIMITS.toolCalls) throw new AdapterError('PROVIDER_RESPONSE_TOO_LARGE');
      call = { id: undefined, name: undefined, args: '', size: 0 };
      this.calls.set(key, call);
      this.order.push(key);
    }
    if (id) call.id = id;
    if (name) call.name = (call.name ?? '') === '' ? name : call.name;
    return call;
  }
  append(key, delta, { create = false } = {}) {
    const call = this.calls.get(key) ?? (create ? this.start(key) : undefined);
    if (!call) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
    if (typeof delta !== 'string') throw new AdapterError('PROVIDER_RESPONSE_INVALID');
    call.size += Buffer.byteLength(delta);
    if (call.size > STREAM_LIMITS.toolArgumentBytes) throw new AdapterError('PROVIDER_RESPONSE_TOO_LARGE');
    call.args += delta;
  }
  set(key, args) {
    const call = this.calls.get(key);
    if (!call) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
    call.args = ''; call.size = 0;
    this.append(key, args);
  }
  has(key) { return this.calls.has(key); }
  get size() { return this.calls.size; }
  /** Finalize one call → normalized event. Arguments must be a JSON object. */
  finish(key) {
    const call = this.calls.get(key);
    if (!call || this.emitted.has(key)) return undefined;
    if (!call.id || !CALL_ID.test(call.id) || !call.name || !TOOL_NAME.test(call.name)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
    let args;
    try { args = call.args.trim() === '' ? {} : JSON.parse(call.args); } catch { throw new AdapterError('PROVIDER_RESPONSE_INVALID'); }
    if (!record(args)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
    this.emitted.add(key);
    return { type: 'tool-call', id: call.id, name: call.name, arguments: args };
  }
  finishAll() { return this.order.map(key => this.finish(key)).filter(Boolean); }
}

/** Bounds the normalized event stream regardless of protocol. */
export class StreamGuard {
  constructor() { this.text = 0; this.events = 0; this.finished = false; this.toolIds = new Set(); }
  check(event) {
    if (this.finished) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
    // Tool-call IDs must be unique within one response; a conflicting duplicate fails closed.
    if (event.type === 'tool-call') {
      if (this.toolIds.has(event.id)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
      this.toolIds.add(event.id);
    }
    if (++this.events > STREAM_LIMITS.events) throw new AdapterError('PROVIDER_RESPONSE_TOO_LARGE');
    if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
      this.text += Buffer.byteLength(event.text);
      if (this.text > STREAM_LIMITS.textBytes) throw new AdapterError('PROVIDER_RESPONSE_TOO_LARGE');
    }
    if (event.type === 'finish') this.finished = true;
    return event;
  }
}

const int = value => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);
/** Normalized usage; absent counters are omitted (never guessed). */
export function usage({ input, output, reasoning, cacheRead, cacheWrite, total } = {}) {
  const out = {};
  if (int(input) !== undefined) out.inputTokens = input;
  if (int(output) !== undefined) out.outputTokens = output;
  if (int(reasoning) !== undefined) out.reasoningTokens = reasoning;
  if (int(cacheRead) !== undefined) out.cacheReadTokens = cacheRead;
  if (int(cacheWrite) !== undefined) out.cacheWriteTokens = cacheWrite;
  if (int(total) !== undefined) out.totalTokens = total;
  else if (out.inputTokens !== undefined && out.outputTokens !== undefined) out.totalTokens = out.inputTokens + out.outputTokens;
  return out;
}

export const FINISH_REASONS = new Set(['stop', 'length', 'tool-calls', 'content-filter', 'other']);
