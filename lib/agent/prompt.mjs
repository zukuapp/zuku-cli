import { AgentError } from './errors.mjs';

/**
 * Reads one request line from an interactive stdin. Only used when both stdin and stderr are
 * TTYs (or the caller explicitly marks the context interactive); non-interactive runs never wait.
 * The prompt is written to stderr so stdout stays reserved for command data.
 */
export function readInteractiveRequest({ stdin, stderr, signal, maxChars }) {
  if (!stdin || typeof stdin.on !== 'function') return Promise.reject(new AgentError('AGENT_REQUEST_REQUIRED'));
  if (signal?.aborted) return Promise.reject(new AgentError('COMMAND_CANCELLED'));
  stderr?.write?.('만들 게임을 한 줄로 설명하세요 (취소: Ctrl+C): ');
  return new Promise((resolve, reject) => {
    let buffer = '';
    const limit = maxChars * 4 + 8;
    const finish = (error, value) => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      stdin.pause?.();
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      // Ctrl+C in raw mode arrives as \x03.
      if (buffer.includes('\x03')) return finish(new AgentError('COMMAND_CANCELLED'));
      const newline = buffer.search(/\r?\n/);
      if (newline >= 0) return finish(null, buffer.slice(0, newline));
      if (buffer.length > limit) return finish(new AgentError('AGENT_REQUEST_INVALID'));
    };
    const onEnd = () => finish(buffer.trim() ? null : new AgentError('AGENT_REQUEST_REQUIRED'), buffer);
    const onError = () => finish(new AgentError('AGENT_REQUEST_REQUIRED'));
    const onAbort = () => finish(new AgentError('COMMAND_CANCELLED'));
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    stdin.resume?.();
  });
}
