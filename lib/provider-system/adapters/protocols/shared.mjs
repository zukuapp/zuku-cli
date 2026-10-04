import { AdapterError } from '../errors.mjs';

export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const str = value => (typeof value === 'string' ? value : undefined);

/** In-stream provider error → fixed code. Only local classification is kept. */
export function streamError(code, message) {
  const text = `${typeof code === 'string' ? code : ''} ${typeof message === 'string' ? message.slice(0, 2048) : ''}`.toLowerCase();
  if (/context_length|context window|prompt is too long|maximum context|too many tokens/.test(text)) return new AdapterError('PROVIDER_CONTEXT_OVERFLOW');
  if (/rate_limit|rate limit|throttl|resource_exhausted|quota/.test(text)) return new AdapterError('PROVIDER_RATE_LIMITED');
  if (/authentication|unauthenticated|invalid_api_key|permission_denied/.test(text)) return new AdapterError('PROVIDER_AUTH_FAILED');
  if (/overloaded|unavailable|internal|server_error/.test(text)) return new AdapterError('PROVIDER_UNAVAILABLE');
  if (/invalid_request|invalid_argument|validation/.test(text)) return new AdapterError('PROVIDER_BAD_REQUEST');
  return new AdapterError('PROVIDER_STREAM_ERROR');
}

/** Map tool-call ids to names (needed by protocols whose tool results carry names). */
export function toolNames(messages) {
  const names = new Map();
  for (const message of messages) for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  return names;
}

/** Merge consecutive same-role entries produced by a `convert` callback. */
export function pushMerged(list, role, parts, key = 'content') {
  const last = list.at(-1);
  if (last && last.role === role && Array.isArray(last[key])) last[key].push(...parts);
  else list.push({ role, [key]: [...parts] });
}

export const parseArguments = value => {
  if (record(value)) return value;
  if (typeof value !== 'string') throw new AdapterError('PROVIDER_RESPONSE_INVALID');
  let parsed;
  try { parsed = value.trim() === '' ? {} : JSON.parse(value); } catch { throw new AdapterError('PROVIDER_RESPONSE_INVALID'); }
  if (!record(parsed)) throw new AdapterError('PROVIDER_RESPONSE_INVALID');
  return parsed;
};
