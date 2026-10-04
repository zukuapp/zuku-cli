import { CommandError } from '../errors.mjs';
import { ProviderError } from './errors.mjs';

const USAGE = ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cachedInputTokens'];
const FINISH = new Set(['completed', 'stop', 'length', 'tool-calls', 'cancelled', 'error']);

/** Private same-inference observer. No raw reasoning/remote objects enter it. */
export function createStageEventSink({ callback, secrets, signal, maxBytes = 2 * 1024 * 1024, timeoutMs = 10000 }) {
  if (callback !== undefined && typeof callback !== 'function') throw new ProviderError('ADAPTER_INVALID');
  const needles = [...new Set(secrets.filter(value => typeof value === 'string' && value.length >= 8))];
  const prefixes = needles.map(secret => {
    const prefix = Array(secret.length).fill(0);
    for (let i = 1, count = 0; i < secret.length; i++) {
      while (count && secret[i] !== secret[count]) count = prefix[count - 1];
      if (secret[i] === secret[count]) count++;
      prefix[i] = count;
    }
    return prefix;
  });
  let pending = '', total = 0, events = 0, finish;
  async function send(value) {
    if (!callback) return;
    if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
    let timer, aborted;
    try {
      await Promise.race([
        Promise.resolve().then(() => callback(value)).catch(() => { throw new ProviderError('ADAPTER_INVALID'); }),
        new Promise((_, reject) => {
          aborted = () => reject(new CommandError('COMMAND_CANCELLED'));
          signal?.addEventListener('abort', aborted, { once: true });
          timer = setTimeout(() => reject(new ProviderError('ADAPTER_INVALID')), timeoutMs);
          if (signal?.aborted) aborted();
        }),
      ]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
  }
  async function text(delta, flush = false) {
    pending += delta;
    for (const secret of needles) pending = pending.split(secret).join('[REDACTED]');
    let held = 0;
    if (!flush) for (const [index, secret] of needles.entries()) {
      let count = 0;
      for (const character of pending) {
        while (count && character !== secret[count]) count = prefixes[index][count - 1];
        if (character === secret[count]) count++;
        if (count === secret.length) count = prefixes[index][count - 1];
      }
      held = Math.max(held, count);
    }
    const visible = pending.slice(0, pending.length - held);
    pending = held ? pending.slice(-held) : '';
    let part = '', size = 0;
    for (const character of visible) {
      const bytes = Buffer.byteLength(character);
      if (size + bytes > 8192) { await send({ type: 'text-delta', text: part }); part = ''; size = 0; }
      part += character; size += bytes;
    }
    if (part) await send({ type: 'text-delta', text: part });
  }
  return {
    async emit(event) {
      if (!event || typeof event !== 'object' || ++events > 100000) throw new ProviderError('ADAPTER_INVALID');
      if (event.type === 'reasoning-delta' || event.type === 'reasoning-status') return;
      if (event.type === 'text-delta') {
        if (typeof event.text !== 'string' || (total += Buffer.byteLength(event.text)) > maxBytes) throw new ProviderError('ADAPTER_INVALID');
        await text(event.text);
      } else if (event.type === 'usage') {
        const usage = {};
        for (const key of USAGE) if (Number.isSafeInteger(event.usage?.[key]) && event.usage[key] >= 0) usage[key] = event.usage[key];
        if (Object.keys(usage).length) await send({ type: 'usage', usage });
      } else if (event.type === 'finish') finish = FINISH.has(event.reason) ? event.reason : 'unknown';
      else throw new ProviderError('ADAPTER_INVALID');
    },
    async flush() { await text('', true); if (finish) await send({ type: 'finish', reason: finish }); },
  };
}
