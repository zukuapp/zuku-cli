// Stage execution over any adapter stream. The output schema is admitted
// (bounded subset, schema.mjs) before any network use, the model's text is
// collected under maxOutputBytes, and the parsed JSON is revalidated locally.
// Host validators may be injected and run in addition:
//   context.validateStageSchema(stage, outputSchema)        → false/throw rejects
//   context.validateStageOutput(stage, output, outputSchema) → false/throw rejects
import { AdapterError, fail } from './errors.mjs';
import { admitSchema, validateValue } from './schema.mjs';

// maxOutputBytes ceiling covers the 1,600,000-byte implementation stage with margin.
export const STAGE_LIMITS = Object.freeze({ instructionsBytes: 1024 * 1024, inputBytes: 4 * 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024 });
const STAGE_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeStageRequest(stageRequest) {
  if (!record(stageRequest)) fail('ADAPTER_REQUEST_INVALID');
  const { stage, model, instructions, input, outputSchema, maxOutputBytes, signal, onEvent } = stageRequest;
  if (typeof stage !== 'string' || !STAGE_NAME.test(stage)) fail('ADAPTER_REQUEST_INVALID');
  if (typeof instructions !== 'string' || !instructions.trim() || Buffer.byteLength(instructions) > STAGE_LIMITS.instructionsBytes) fail('ADAPTER_REQUEST_INVALID');
  let inputText;
  try { inputText = JSON.stringify(input ?? null); } catch { fail('ADAPTER_REQUEST_INVALID'); }
  if (inputText === undefined || Buffer.byteLength(inputText) > STAGE_LIMITS.inputBytes) fail('ADAPTER_REQUEST_INVALID');
  if (!record(outputSchema)) fail('ADAPTER_REQUEST_INVALID');
  admitSchema(outputSchema);
  let schemaText;
  try { schemaText = JSON.stringify(outputSchema); } catch { fail('ADAPTER_REQUEST_INVALID'); }
  if (Buffer.byteLength(schemaText) > 64 * 1024) fail('ADAPTER_REQUEST_INVALID');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 2 || maxOutputBytes > STAGE_LIMITS.maxOutputBytes) fail('ADAPTER_REQUEST_INVALID');
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('ADAPTER_REQUEST_INVALID');
  if (onEvent !== undefined && typeof onEvent !== 'function') fail('ADAPTER_REQUEST_INVALID');
  return { stage, model, instructions, inputText, outputSchema, schemaText, maxOutputBytes, signal, onEvent };
}

// This operational observer shares the existing inference. It never forwards
// provider reasoning, headers, raw frames or executable tool arguments.
async function observe(callback, event, signal) {
  if (!callback) return;
  if (signal.aborted) throw new AdapterError('COMMAND_CANCELLED');
  let timer, aborted;
  try {
    await Promise.race([
      Promise.resolve().then(() => callback(event)).catch(() => { throw new AdapterError('PROVIDER_STREAM_ERROR'); }),
      new Promise((_, reject) => {
        aborted = () => reject(new AdapterError('COMMAND_CANCELLED'));
        signal.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => reject(new AdapterError('PROVIDER_STREAM_ERROR')), 10000);
        if (signal.aborted) aborted();
      }),
    ]);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', aborted); }
}

/** Extract one JSON value from model text (optionally fenced). */
export function parseStageText(text) {
  let body = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(body);
  if (fence) body = fence[1].trim();
  try { return JSON.parse(body); } catch { throw new AdapterError('STAGE_OUTPUT_INVALID'); }
}

/**
 * Run a stage through `stream(request)`. No tools are offered, so a tool call
 * is a protocol violation. Output is capped at maxOutputBytes and the request is
 * cancelled (never retried) as soon as the cap is exceeded.
 */
async function hostCheck(fn, args, code) {
  if (typeof fn !== 'function') return;
  let verdict;
  try { verdict = await fn(...args); } catch { verdict = false; }
  if (verdict === false) throw new AdapterError(code);
}

export async function runStageOverStream({ provider, stream, context, stageRequest, defaultModel, structured = true }) {
  const s = normalizeStageRequest(stageRequest);
  await hostCheck(context?.validateStageSchema, [s.stage, s.outputSchema], 'ADAPTER_REQUEST_INVALID');
  const aborter = new AbortController();
  const signal = AbortSignal.any([aborter.signal, ...(s.signal ? [s.signal] : []), ...(context?.signal ? [context.signal] : [])]);
  const system = `${s.instructions}\n\nReturn exactly one JSON value that conforms to this JSON Schema. Do not add prose or code fences.\n${s.schemaText}`;
  const request = {
    model: s.model ?? defaultModel,
    system,
    messages: [{ role: 'user', content: JSON.stringify({ stage: s.stage, input: JSON.parse(s.inputText) }) }],
    ...(structured ? { responseFormat: { type: 'json', schema: s.outputSchema } } : {}),
    signal,
  };
  let text = '';
  let size = 0;
  let usage;
  let finish;
  try { for await (const event of stream(request)) {
    if (signal.aborted) throw new AdapterError('COMMAND_CANCELLED');
    if (event.type === 'text-delta') {
      if (typeof event.text !== 'string') throw new AdapterError('PROVIDER_STREAM_ERROR');
      size += Buffer.byteLength(event.text);
      if (size > s.maxOutputBytes) throw new AdapterError('STAGE_OUTPUT_TOO_LARGE');
      text += event.text;
      await observe(s.onEvent, { type: 'text-delta', text: event.text }, signal);
    } else if (event.type === 'tool-call') throw new AdapterError('STAGE_OUTPUT_INVALID');
    else if (event.type === 'usage') usage = event.usage;
    else if (event.type === 'finish') finish = event.reason;
  } } catch (error) { aborter.abort(); throw error; }
  if (finish === 'content-filter') throw new AdapterError('PROVIDER_CONTENT_FILTERED');
  if (finish !== 'stop') throw new AdapterError('STAGE_INCOMPLETE');
  const output = parseStageText(text);
  if (!validateValue(s.outputSchema, output)) throw new AdapterError('STAGE_OUTPUT_INVALID');
  await hostCheck(context?.validateStageOutput, [s.stage, output, s.outputSchema], 'STAGE_OUTPUT_INVALID');
  if (usage) await observe(s.onEvent, { type: 'usage', usage }, signal);
  await observe(s.onEvent, { type: 'finish', reason: 'completed' }, signal);
  return { provider, stage: s.stage, output, usage: usage ?? {}, experimental: false, unofficial: false };
}
