import { createInterface } from 'node:readline/promises';
import { CommandError } from '../errors.mjs';
import { ProviderError, invalidInput, cancelled } from './errors.mjs';
import { validSecret } from './secret-store.mjs';

const MAX_SECRET = 16384;
/** Prompts only when BOTH stdin and stderr are terminals; non-TTY runs never ask. */
export const isInteractive = (ctx = {}) => ctx.interactive !== false && ctx.stdin?.isTTY === true && ctx.stderr?.isTTY === true;

/** Finite line prompt on stderr (stdout stays data-only). */
export async function askLine(ctx, question, { validate = () => true, attempts = 3, maxLength = 2048, fallback } = {}) {
  if (!isInteractive(ctx)) throw invalidInput();
  const rl = createInterface({ input: ctx.stdin, output: ctx.stderr, terminal: true });
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      let answer;
      try { answer = (await rl.question(question, ctx.signal ? { signal: ctx.signal } : undefined)).trim(); } catch { throw cancelled(); }
      if (!answer && fallback !== undefined) return fallback;
      if (answer.length <= maxLength && !/[\u0000-\u001f\u007f-\u009f]/.test(answer) && validate(answer)) return answer;
      ctx.stderr.write('입력 형식을 확인하세요.\n');
    }
    throw invalidInput();
  } finally { rl.close(); }
}

export async function askChoice(ctx, title, choices) {
  ctx.stderr.write(`${title}\n`);
  choices.forEach((choice, index) => ctx.stderr.write(`  ${index + 1}) ${choice.label}\n`));
  const answer = await askLine(ctx, '> ', { validate: value => /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= choices.length });
  return choices[Number(answer) - 1].value;
}

/** Hidden, bounded secret entry in raw mode; nothing is echoed. Ctrl-C cancels. */
export function askSecret(ctx, question) {
  if (!isInteractive(ctx) || typeof ctx.stdin.setRawMode !== 'function') return Promise.reject(new ProviderError('AUTH_INPUT_REQUIRED'));
  const { stdin, stderr, signal } = ctx;
  return new Promise((resolve, reject) => {
    let value = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData);
      signal?.removeEventListener('abort', onAbort);
      try { stdin.setRawMode(false); } catch { /* terminal already restored */ }
      stdin.pause?.();
      stderr.write('\n');
      if (error) { value = ''; reject(error); } else resolve(result);
    };
    const onAbort = () => finish(cancelled());
    const onData = chunk => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n') {
          const secret = value; value = '';
          return validSecret(secret) ? finish(undefined, secret) : finish(new ProviderError('AUTH_SECRET_INVALID'));
        }
        if (char === '\u0003') return finish(cancelled());
        if (char === '\u0004') return finish(new ProviderError('AUTH_INPUT_REQUIRED'));
        if (char === '\u007f' || char === '\b') { value = value.slice(0, -1); continue; }
        if (char < ' ' || char === '\u001b') continue;
        value += char;
        if (value.length > MAX_SECRET) return finish(new ProviderError('AUTH_SECRET_INVALID'));
      }
    };
    if (signal?.aborted) return reject(cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
    stderr.write(question);
    try { stdin.setRawMode(true); } catch { return finish(new ProviderError('AUTH_INPUT_REQUIRED')); }
    stdin.on('data', onData);
    stdin.resume?.();
  });
}

/** `--api-key-stdin`: one secret line from a pipe, bounded in size and time. */
export async function readSecretFromStdin(ctx, { timeoutMs = 30000 } = {}) {
  const { stdin, signal } = ctx;
  if (!stdin || stdin.isTTY) throw new ProviderError('AUTH_INPUT_REQUIRED');
  const chunks = []; let size = 0;
  // A ref'd timer (not AbortSignal.timeout) so a silent pipe cannot end the process early or hang it forever.
  let timer, onAbort;
  const iterator = stdin[Symbol.asyncIterator]();
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError('AUTH_INPUT_REQUIRED')), timeoutMs);
    onAbort = () => reject(cancelled());
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
  stop.catch(() => {});
  try {
    while (true) {
      const { value, done } = await Promise.race([iterator.next(), stop]);
      if (done) break;
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      size += buffer.length;
      if (size > MAX_SECRET + 2) throw new ProviderError('AUTH_SECRET_INVALID');
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new ProviderError('AUTH_INPUT_REQUIRED');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    Promise.resolve(iterator.return?.()).catch(() => {});
  }
  const raw = Buffer.concat(chunks);
  const secret = raw.toString('utf8').replace(/\r?\n$/, '');
  raw.fill(0);
  if (!validSecret(secret)) throw new ProviderError('AUTH_SECRET_INVALID');
  return secret;
}
