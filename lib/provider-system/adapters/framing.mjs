import { AdapterError } from './errors.mjs';

/**
 * Incremental UTF-8 line splitter (LF, CRLF and lone CR), safe across chunk
 * boundaries that split multibyte characters or CRLF pairs. Lines are bounded.
 */
export async function* lines(chunks, { maxLineBytes = 1024 * 1024 } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let pendingCR = false;
  const decode = (bytes, stream) => {
    try { return decoder.decode(bytes, { stream }); } catch { throw new AdapterError('PROVIDER_RESPONSE_INVALID'); }
  };
  for await (const chunk of chunks) {
    let text = decode(chunk, true);
    if (pendingCR) { if (text.startsWith('\n')) text = text.slice(1); pendingCR = false; }
    buffer += text;
    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const ch = buffer.charCodeAt(i);
      if (ch !== 10 && ch !== 13) continue;
      yield buffer.slice(start, i);
      if (ch === 13) {
        if (i + 1 < buffer.length) { if (buffer.charCodeAt(i + 1) === 10) i += 1; }
        else pendingCR = true;
      }
      start = i + 1;
    }
    buffer = buffer.slice(start);
    // UTF-16 length ≥ bytes/3; check bytes only when near the limit.
    if (buffer.length * 3 > maxLineBytes && Buffer.byteLength(buffer) > maxLineBytes) throw new AdapterError('PROVIDER_RESPONSE_TOO_LARGE');
  }
  buffer += decode(new Uint8Array(0), false);
  if (buffer.length) yield buffer;
}

/** Server-Sent Events (WHATWG): yields { event, data } per dispatched event. */
export async function* sse(chunks, { maxLineBytes, maxEventBytes = 4 * 1024 * 1024 } = {}) {
  let data = [];
  let size = 0;
  let event = '';
  for await (const line of lines(chunks, { maxLineBytes })) {
    if (line === '') {
      if (data.length) yield { event: event || 'message', data: data.join('\n') };
      data = []; size = 0; event = '';
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      size += value.length + 1;
      if (size > maxEventBytes) throw new AdapterError('PROVIDER_RESPONSE_TOO_LARGE');
      data.push(value);
    } else if (field === 'event') event = value;
    // `id` and `retry` are ignored: reconnection is never automatic.
  }
  if (data.length) yield { event: event || 'message', data: data.join('\n') };
}

/** SSE events whose data is JSON. `[DONE]` is surfaced as { done: true }. */
export async function* sseJson(chunks, options) {
  for await (const { event, data } of sse(chunks, options)) {
    if (data === '[DONE]') { yield { event, done: true }; continue; }
    let value;
    try { value = JSON.parse(data); } catch { throw new AdapterError('PROVIDER_RESPONSE_INVALID'); }
    yield { event, value };
  }
}

/** Newline-delimited JSON (Ollama). Blank lines are skipped. */
export async function* ndjson(chunks, options) {
  for await (const line of lines(chunks, options)) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { throw new AdapterError('PROVIDER_RESPONSE_INVALID'); }
  }
}
