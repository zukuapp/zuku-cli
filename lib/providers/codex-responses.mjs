import { isDeepStrictEqual } from 'node:util';
import { ProviderError, requireExperimental, checkCancelled, providerMetadata } from '../provider-errors.mjs';

export const CODEX_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MAX_OUTPUT = 512 * 1024;
const HARD_MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_STREAM = 12 * 1024 * 1024;
const MAX_INPUT = 2 * 1024 * 1024;
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'description', 'title', '$schema']);
// Host-owned finite game-stage constraints, not arbitrary user/model-supplied regex programs.
const GAME_PATTERNS = new Set([
  '^[a-z0-9][a-z0-9_-]{0,31}$', '^[a-z][a-z -]{0,39}$', '^[a-z][a-z0-9_]{0,31}$',
  '^[a-z][a-z0-9-]{0,39}$', '^[a-z][a-z0-9_]{0,39}$', '^[0-9a-f]{64}$',
  '^(|assets/[a-z0-9][a-z0-9_/-]{0,100}\\.(svg|json|txt))$',
  '^src/[A-Za-z0-9_][A-Za-z0-9_/-]{0,120}\\.(js|mjs)$',
  '^[a-z][A-Za-z0-9_]{0,39}$', '^[a-z0-9][a-z0-9 _-]{0,29}$',
]);
const matchesType = (v, t) => t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : t === 'integer' ? Number.isSafeInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === t;

// Deliberately bounded schema subset for the finite game stages, not a complete JSON Schema engine.
export function validateStageSchema(schema) {
  if (schema?.type !== 'object') throw new ProviderError('CODEX_INPUT_INVALID');
  let nodes = 0;
  function walk(s, depth) {
    if (++nodes > 1000 || depth > 16 || !s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(k => !KEYS.has(k))) throw new ProviderError('CODEX_INPUT_INVALID');
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.length || types.some(t => !TYPES.has(t)) || new Set(types).size !== types.length) throw new ProviderError('CODEX_INPUT_INVALID');
    if (types.includes('object')) {
      if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties) || s.additionalProperties !== false || !Array.isArray(s.required)
        || s.required.some(k => typeof k !== 'string' || !Object.hasOwn(s.properties, k)) || new Set(s.required).size !== s.required.length
        || Object.keys(s.properties).some(k => !s.required.includes(k))) throw new ProviderError('CODEX_INPUT_INVALID');
      for (const value of Object.values(s.properties)) walk(value, depth + 1);
    }
    if (types.includes('array')) walk(s.items, depth + 1);
    if (!types.includes('object') && ['properties', 'required', 'additionalProperties'].some(k => Object.hasOwn(s, k))
      || !types.includes('array') && ['items', 'minItems', 'maxItems'].some(k => Object.hasOwn(s, k))
      || !types.includes('string') && ['minLength', 'maxLength', 'pattern'].some(k => Object.hasOwn(s, k))
      || !types.some(t => ['number', 'integer'].includes(t)) && ['minimum', 'maximum'].some(k => Object.hasOwn(s, k))) throw new ProviderError('CODEX_INPUT_INVALID');
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length)) throw new ProviderError('CODEX_INPUT_INVALID');
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (s[key] !== undefined && (!Number.isFinite(s[key]) || !['minimum', 'maximum'].includes(key) && (!Number.isSafeInteger(s[key]) || s[key] < 0))) throw new ProviderError('CODEX_INPUT_INVALID');
    }
    for (const [low, high] of [['minimum', 'maximum'], ['minLength', 'maxLength'], ['minItems', 'maxItems']]) {
      if (s[low] !== undefined && s[high] !== undefined && s[low] > s[high]) throw new ProviderError('CODEX_INPUT_INVALID');
    }
    for (const key of ['description', 'title', '$schema']) if (s[key] !== undefined && typeof s[key] !== 'string') throw new ProviderError('CODEX_INPUT_INVALID');
    if (s.pattern !== undefined && (!GAME_PATTERNS.has(s.pattern) || !Number.isSafeInteger(s.maxLength) || s.maxLength > 1024)) throw new ProviderError('CODEX_INPUT_INVALID');
  }
  walk(schema, 0);
  return schema;
}

export function validateStageOutput(value, schema) {
  let nodes = 0;
  function walk(v, s, depth) {
    if (++nodes > 20000 || depth > 32) throw new ProviderError('CODEX_RESPONSE_LIMIT');
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some(t => matchesType(v, t)) || s.enum && !s.enum.some(x => isDeepStrictEqual(x, v)) || Object.hasOwn(s, 'const') && !isDeepStrictEqual(s.const, v)) throw new ProviderError('CODEX_RESPONSE_INVALID');
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (s.required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !Object.hasOwn(s.properties, k))) throw new ProviderError('CODEX_RESPONSE_INVALID');
      for (const [k, item] of Object.entries(v)) walk(item, s.properties[k], depth + 1);
    } else if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems || s.maxItems !== undefined && v.length > s.maxItems) throw new ProviderError('CODEX_RESPONSE_INVALID');
      for (const item of v) walk(item, s.items, depth + 1);
    } else if (typeof v === 'string') {
      const length = Array.from(v).length;
      if (s.minLength !== undefined && length < s.minLength || s.maxLength !== undefined && length > s.maxLength) throw new ProviderError('CODEX_RESPONSE_INVALID');
      if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) throw new ProviderError('CODEX_RESPONSE_INVALID');
    } else if (typeof v === 'number' && (s.minimum !== undefined && v < s.minimum || s.maximum !== undefined && v > s.maximum)) throw new ProviderError('CODEX_RESPONSE_INVALID');
  }
  walk(value, schema, 0);
  return value;
}

function finalText(response) {
  if (!response || response.status !== 'completed' || !Array.isArray(response.output)) throw new ProviderError('CODEX_RESPONSE_INVALID');
  const texts = [];
  for (const item of response.output) {
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) throw new ProviderError('CODEX_RESPONSE_INVALID');
    for (const content of item.content) {
      if (content.type !== 'output_text' || typeof content.text !== 'string') throw new ProviderError('CODEX_RESPONSE_INVALID');
      texts.push(content.text);
    }
  }
  return texts.join('');
}

async function emitBounded(callback, value, signal, timeoutMs) {
  if (!callback) return;
  checkCancelled(signal);
  let timer, aborted;
  try {
    await Promise.race([
      Promise.resolve().then(() => callback(value)).catch(() => { throw new ProviderError('CODEX_RESPONSE_INVALID'); }),
      new Promise((_, reject) => {
        aborted = () => reject(new ProviderError('CODEX_AUTH_CANCELLED'));
        signal?.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => reject(new ProviderError('CODEX_RESPONSE_INVALID')), timeoutMs);
        if (signal?.aborted) aborted();
      }),
    ]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
}

async function readSse(response, signal, maxOutputBytes, onEvent, eventTimeoutMs, secret) {
  if (!response.body) throw new ProviderError('CODEX_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const prefix = Array(secret.length).fill(0);
  for (let index = 1, matched = 0; index < secret.length; index++) {
    while (matched && secret[index] !== secret[matched]) matched = prefix[matched - 1];
    if (secret[index] === secret[matched]) matched++;
    prefix[index] = matched;
  }
  let pending = '', data = [], total = 0, output = '', terminal, visible = '';
  async function emitText(delta, flush = false) {
    if (!onEvent) return;
    visible += delta;
    visible = visible.split(secret).join('[REDACTED]');
    let held = 0;
    if (!flush) for (const character of visible) {
      while (held && character !== secret[held]) held = prefix[held - 1];
      if (character === secret[held]) held++;
      if (held === secret.length) held = prefix[held - 1];
    }
    const text = visible.slice(0, visible.length - held);
    visible = held ? visible.slice(-held) : '';
    // These are bounded pieces of a real wire delta, never invented final text.
    let part = '', bytes = 0;
    for (const character of text) {
      const size = Buffer.byteLength(character);
      if (bytes + size > 8192) { await emitBounded(onEvent, { type: 'text-delta', text: part }, signal, eventTimeoutMs); part = ''; bytes = 0; }
      part += character; bytes += size;
    }
    if (part) await emitBounded(onEvent, { type: 'text-delta', text: part }, signal, eventTimeoutMs);
  }
  async function event() {
    if (!data.length) return;
    const text = data.join('\n'); data = [];
    if (text === '[DONE]') return;
    let e;
    try { e = JSON.parse(text); } catch { throw new ProviderError('CODEX_RESPONSE_INVALID'); }
    if (!e || typeof e.type !== 'string') throw new ProviderError('CODEX_RESPONSE_INVALID');
    if (e.type === 'response.output_text.delta') {
      if (typeof e.delta !== 'string') throw new ProviderError('CODEX_RESPONSE_INVALID');
      output += e.delta;
      if (Buffer.byteLength(output) > maxOutputBytes) throw new ProviderError('CODEX_RESPONSE_LIMIT');
      await emitText(e.delta);
    } else if (e.type === 'response.completed') {
      const complete = finalText(e.response);
      if (Buffer.byteLength(complete) > maxOutputBytes) throw new ProviderError('CODEX_RESPONSE_LIMIT');
      if (!complete || output && complete !== output) throw new ProviderError('CODEX_RESPONSE_INVALID');
      if (complete.includes(secret)) throw new ProviderError('CODEX_RESPONSE_INVALID');
      terminal = { text: complete, usage: e.response.usage };
      await emitText('', true);
    } else if (['response.failed', 'response.incomplete', 'error'].includes(e.type)) throw new ProviderError('CODEX_INFERENCE_FAILED');
  }
  async function lines(text) {
    pending += text;
    if (Buffer.byteLength(pending) > MAX_STREAM) throw new ProviderError('CODEX_RESPONSE_LIMIT');
    let newline;
    while (!terminal && (newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1);
      if (!line) await event();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  try {
    while (!terminal) {
      checkCancelled(signal);
      let aborted;
      let chunk;
      try {
        chunk = await Promise.race([reader.read(), new Promise((_, reject) => {
          aborted = () => reject(new ProviderError('CODEX_AUTH_CANCELLED'));
          signal?.addEventListener('abort', aborted, { once: true });
          if (signal?.aborted) aborted();
        })]);
      } finally { signal?.removeEventListener('abort', aborted); }
      const { value, done } = chunk;
      if (done) { await lines(decoder.decode()); if (pending) await lines('\n'); await event(); break; }
      total += value.length;
      if (total > MAX_STREAM) throw new ProviderError('CODEX_RESPONSE_LIMIT');
      await lines(decoder.decode(value, { stream: true }));
    }
    if (!terminal) throw new ProviderError('CODEX_RESPONSE_INVALID');
    return terminal;
  } catch (error) {
    checkCancelled(signal);
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('CODEX_RESPONSE_INVALID');
  } finally { await reader.cancel().catch(() => {}); }
}

export function createCodexResponsesProvider({ oauth, fetchImpl = globalThis.fetch, requestTimeoutMs = 180000, eventTimeoutMs = 10000 } = {}) {
  if (!oauth || typeof oauth.getAccessToken !== 'function' || typeof fetchImpl !== 'function' || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0
    || !Number.isSafeInteger(eventTimeoutMs) || eventTimeoutMs <= 0 || eventTimeoutMs > 60000) throw new ProviderError('CODEX_INPUT_INVALID');
  async function runStage({ experimental, stage, model, instructions, input, outputSchema, signal, onEvent, onDelta, maxOutputBytes = DEFAULT_MAX_OUTPUT } = {}) {
    requireExperimental(experimental); checkCancelled(signal);
    if (typeof stage !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(stage) || typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(model)
      || typeof instructions !== 'string' || !instructions.trim() || instructions.length > 65536 || input === undefined
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > HARD_MAX_OUTPUT
      || onEvent !== undefined && typeof onEvent !== 'function' || onDelta !== undefined && typeof onDelta !== 'function'
      || onEvent && onDelta && onEvent !== onDelta) throw new ProviderError('CODEX_INPUT_INVALID');
    validateStageSchema(outputSchema);
    let body;
    try {
      body = JSON.stringify({ model, store: false, stream: true, instructions,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ stage, input }) }] }],
        text: { format: { type: 'json_schema', name: `zukujs_${stage}`, strict: true, schema: outputSchema } } });
      if (Buffer.byteLength(body) > MAX_INPUT) throw new Error();
    } catch { throw new ProviderError('CODEX_INPUT_INVALID'); }
    const access = await oauth.getAccessToken({ experimental: true, signal });
    if (typeof access !== 'string' || !access || access.length > 32768 || !/^[\x21-\x7e]+$/.test(access)) throw new ProviderError('CODEX_AUTH_RESPONSE_INVALID');
    let response;
    const inference = new AbortController();
    const deadline = AbortSignal.any([inference.signal, AbortSignal.timeout(requestTimeoutMs), ...(signal ? [signal] : [])]);
    try { response = await fetchImpl(CODEX_RESPONSES_URL, { method: 'POST', redirect: 'error', signal: deadline,
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'text/event-stream', 'user-agent': 'zukujs-experimental-codex' }, body }); }
    catch { checkCancelled(signal); throw new ProviderError('CODEX_NETWORK_ERROR'); }
    if (response.url && response.url !== CODEX_RESPONSES_URL || response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError('CODEX_RESPONSE_INVALID');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(response.status === 429 ? 'CODEX_RATE_LIMITED' : [401, 403].includes(response.status) ? 'CODEX_REAUTH_REQUIRED' : 'CODEX_INFERENCE_FAILED');
    }
    if ((response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim() !== 'text/event-stream') {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError('CODEX_RESPONSE_INVALID');
    }
    try {
      const callback = onEvent ?? onDelta;
      const result = await readSse(response, deadline, maxOutputBytes, callback, eventTimeoutMs, access);
      let output;
      try { output = JSON.parse(result.text); } catch { throw new ProviderError('CODEX_RESPONSE_INVALID'); }
      validateStageOutput(output, outputSchema);
      const usage = {}, observed = {};
      for (const [key, normalized] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['total_tokens', 'totalTokens']]) {
        const value = result.usage?.[key];
        if (Number.isSafeInteger(value) && value >= 0) { usage[key] = value; observed[normalized] = value; }
      }
      if (Object.keys(observed).length) await emitBounded(callback, { type: 'usage', usage: observed }, deadline, eventTimeoutMs);
      await emitBounded(callback, { type: 'finish', reason: 'completed' }, deadline, eventTimeoutMs);
      return { ...providerMetadata, stage, output, usage };
    } finally { inference.abort(); }
  }
  return Object.freeze({ runStage });
}
