// AWS Bedrock Converse / ConverseStream through the official AWS SDK for
// JavaScript v3 (SigV4 signing, default credential provider chain and the AWS
// event-stream binary framing stay inside the SDK). The SDK is imported lazily,
// only when the Bedrock adapter is explicitly selected and used.
// Request/stream mapping follows Kilo Code packages/llm/src/protocols/bedrock-converse.ts (MIT).
import { AdapterError, fail } from '../errors.mjs';
import { ToolCalls, usage } from '../request.mjs';
import { record, str } from './shared.mjs';

export const RUNTIME_SDK = '@aws-sdk/client-bedrock-runtime';
export const CONTROL_SDK = '@aws-sdk/client-bedrock';

export function buildInput(request) {
  const messages = [];
  const push = (role, blocks) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const message of request.messages) {
    if (message.role === 'tool') push('user', [{ toolResult: { toolUseId: message.toolCallId, content: [{ text: message.content }] } }]);
    else if (message.role === 'assistant') {
      const blocks = [];
      if (message.content) blocks.push({ text: message.content });
      for (const call of message.toolCalls ?? []) blocks.push({ toolUse: { toolUseId: call.id, name: call.name, input: call.arguments } });
      if (blocks.length) push('assistant', blocks);
    } else push('user', [{ text: message.content }]);
  }
  if (messages[0]?.role !== 'user') fail('ADAPTER_REQUEST_INVALID');
  const input = { modelId: request.model, messages };
  if (request.system) input.system = [{ text: request.system }];
  const inferenceConfig = {};
  if (request.maxOutputTokens !== undefined) inferenceConfig.maxTokens = request.maxOutputTokens;
  if (request.temperature !== undefined) inferenceConfig.temperature = Math.min(request.temperature, 1);
  if (Object.keys(inferenceConfig).length) input.inferenceConfig = inferenceConfig;
  if (request.tools.length && request.toolChoice !== 'none') {
    input.toolConfig = {
      tools: request.tools.map(tool => ({ toolSpec: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), inputSchema: { json: tool.parameters } } })),
      toolChoice: request.toolChoice === 'required' ? { any: {} } : { auto: {} },
    };
  }
  return input;
}

function finishReason(reason, hasTools) {
  if (reason === 'end_turn' || reason === 'stop_sequence') return hasTools ? 'tool-calls' : 'stop';
  if (reason === 'tool_use') return 'tool-calls';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'length';
  if (reason === 'guardrail_intervened' || reason === 'content_filtered') return 'content-filter';
  return 'other';
}

const EXCEPTION_MEMBERS = {
  internalServerException: 'PROVIDER_UNAVAILABLE',
  serviceUnavailableException: 'PROVIDER_UNAVAILABLE',
  modelStreamErrorException: 'PROVIDER_STREAM_ERROR',
  throttlingException: 'PROVIDER_RATE_LIMITED',
  validationException: 'PROVIDER_BAD_REQUEST',
};

/** Map an SDK error by its modeled name only (messages may echo request data). */
export function sdkError(error, signal) {
  if (signal?.aborted) return new AdapterError('COMMAND_CANCELLED');
  if (error instanceof AdapterError) return error;
  const name = typeof error?.name === 'string' ? error.name : '';
  const status = error?.$metadata?.httpStatusCode;
  if (name === 'AbortError') return new AdapterError('COMMAND_CANCELLED');
  if (/^Region is missing/.test(String(error?.message ?? ''))) return new AdapterError('ADAPTER_INVALID_DESCRIPTOR');
  if (name === 'CredentialsProviderError' || name === 'ProviderError') return new AdapterError('ADAPTER_CREDENTIALS_MISSING');
  if (/^(UnrecognizedClient|InvalidSignature|ExpiredToken|InvalidClientTokenId|IncompleteSignature)/.test(name)) return new AdapterError('PROVIDER_AUTH_FAILED', { status });
  if (name === 'AccessDeniedException') return new AdapterError('PROVIDER_FORBIDDEN', { status });
  if (name === 'ResourceNotFoundException') return new AdapterError('PROVIDER_NOT_FOUND', { status });
  if (name === 'ThrottlingException' || name === 'ServiceQuotaExceededException') return new AdapterError('PROVIDER_RATE_LIMITED', { status });
  if (name === 'ValidationException') return /too long|context|token/i.test(String(error?.message ?? '').slice(0, 512)) ? new AdapterError('PROVIDER_CONTEXT_OVERFLOW', { status }) : new AdapterError('PROVIDER_BAD_REQUEST', { status });
  if (name === 'TimeoutError' || name === 'RequestTimeout') return new AdapterError('PROVIDER_TIMEOUT');
  if (Number.isInteger(status) && status >= 300 && status < 400) return new AdapterError('PROVIDER_REDIRECT_REJECTED', { status });
  return new AdapterError('PROVIDER_UNAVAILABLE', Number.isInteger(status) ? { status } : undefined);
}

/** Normalize the SDK's decoded ConverseStream union events. */
export async function* parse(stream) {
  const tools = new ToolCalls();
  let stop; let lastUsage; let emitted = 0;
  for await (const event of stream) {
    if (!record(event)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
    for (const [member, code] of Object.entries(EXCEPTION_MEMBERS)) if (event[member]) throw new AdapterError(code);
    if (event.contentBlockStart) {
      const start = event.contentBlockStart.start?.toolUse;
      if (start) tools.start(event.contentBlockStart.contentBlockIndex, { id: str(start.toolUseId), name: str(start.name) });
    } else if (event.contentBlockDelta) {
      const { delta, contentBlockIndex } = event.contentBlockDelta;
      if (str(delta?.text)) yield { type: 'text-delta', text: delta.text };
      else if (str(delta?.reasoningContent?.text)) yield { type: 'reasoning-delta', text: delta.reasoningContent.text };
      else if (delta?.toolUse) tools.append(contentBlockIndex, delta.toolUse.input ?? '');
    } else if (event.contentBlockStop) {
      const index = event.contentBlockStop.contentBlockIndex;
      if (tools.has(index)) { const call = tools.finish(index); if (call) { emitted += 1; yield call; } }
    } else if (event.messageStop) stop = event.messageStop.stopReason;
    else if (event.metadata) {
      const u = event.metadata.usage;
      if (u) lastUsage = usage({ input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheWriteInputTokens, total: u.totalTokens });
    }
  }
  if (stop === undefined) throw new AdapterError('PROVIDER_STREAM_ERROR');
  for (const call of tools.finishAll()) { emitted += 1; yield call; }
  if (lastUsage && Object.keys(lastUsage).length) yield { type: 'usage', usage: lastUsage };
  yield { type: 'finish', reason: finishReason(stop, emitted > 0) };
}
