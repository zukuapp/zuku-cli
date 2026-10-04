import { AdapterError } from './errors.mjs';
import { Exchange } from './http.mjs';
import { StreamGuard } from './request.mjs';

/**
 * POST a JSON body once and translate the framed response into normalized
 * events. No retry, no replay, no fallback: a failure ends the stream with a
 * fixed error. Breaking out of iteration cancels the request body.
 */
export async function* httpStream(context, { url, headers, body, parse, signal }) {
  const exchange = new Exchange({ fetch: context.fetch, signals: [context.signal, signal], timeouts: context.timeouts, limits: context.limits });
  const guard = new StreamGuard();
  let payload;
  try { payload = JSON.stringify(body); } catch { exchange.close(); throw new AdapterError('ADAPTER_REQUEST_INVALID'); }
  if (Buffer.byteLength(payload) > 16 * 1024 * 1024) { exchange.close(); throw new AdapterError('ADAPTER_REQUEST_INVALID'); }
  headers.set('content-type', 'application/json');
  try {
    const response = await exchange.send(url, { method: 'POST', headers, body: payload });
    for await (const event of parse(exchange.chunks(response), { maxLineBytes: exchange.limits.lineBytes })) {
      yield guard.check(event);
      if (event.type === 'finish') return;
    }
    if (!guard.finished) throw new AdapterError('PROVIDER_STREAM_ERROR');
  } catch (error) {
    throw exchange.error(error);
  } finally { exchange.close(); }
}
