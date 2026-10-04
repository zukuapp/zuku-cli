import { randomBytes } from 'node:crypto';
import { ProtocolError, validateEvent } from '../agent-protocol/index.mjs';

/** Validated records are committed before observers see them; slow observers lose only their subscription. */
export async function createJournal({ storage, sessionId, now = () => new Date(), maxBytes = 4 * 1024 * 1024, maxEvents = 2048, subscriberBytes = 256 * 1024 } = {}) {
  if (!storage || !/^ses_[a-f0-9]{32}$/.test(sessionId) || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024 || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 65536 || !Number.isSafeInteger(subscriberBytes) || subscriberBytes < 1024 || subscriberBytes > 256 * 1024) throw new ProtocolError('INVALID_INPUT');
  if (storage.windowsProtected) maxBytes = Math.min(maxBytes, 1024 * 1024);
  let lines = [], bytes = 0, sequence = 0, tail = Promise.resolve(), closed = false;
  const subscribers = new Set();
  const raw = await storage.read('journal', sessionId, maxBytes + 32768);
  if (raw !== undefined) {
    let previous = 0;
    // Only a trailing incomplete append may be discarded after a crash. Complete malformed
    // records are never repaired or skipped, because that would forge the replay history.
    const complete = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
    for (const line of complete.split('\n').filter(Boolean)) {
      let event;
      try { event = validateEvent(JSON.parse(line)); } catch { throw new ProtocolError('CORE_STATE_UNSAFE'); }
      if (event.sessionId !== sessionId || previous && event.sequence !== previous + 1) throw new ProtocolError('CORE_STATE_UNSAFE');
      previous = event.sequence; sequence = event.sequence;
      const size = Buffer.byteLength(line + '\n'); lines.push({ event, line: line + '\n', bytes: size }); bytes += size;
    }
    if (bytes > maxBytes || lines.length > maxEvents) throw new ProtocolError('CORE_STATE_UNSAFE');
    if (complete !== raw) await storage.write('journal', sessionId, complete);
  }
  const minimum = () => lines[0]?.event.sequence ?? sequence + 1;
  const disconnect = (subscriber, error) => {
    if (subscriber.closed) return;
    subscriber.closed = true; subscriber.error = error; subscriber.queue = []; subscriber.bytes = 0;
    subscribers.delete(subscriber); subscriber.signal?.removeEventListener('abort', subscriber.abort);
    subscriber.wake?.(); subscriber.wake = undefined;
  };
  const enqueue = (subscriber, event) => {
    if (subscriber.closed) return;
    const size = Buffer.byteLength(JSON.stringify(event));
    if (subscriber.bytes + size > subscriberBytes) { disconnect(subscriber, new ProtocolError('SLOW_SUBSCRIBER')); return; }
    subscriber.queue.push({ event, bytes: size }); subscriber.bytes += size; subscriber.wake?.(); subscriber.wake = undefined;
  };
  return Object.freeze({
    get sequence() { return sequence; }, get minimumSequence() { return minimum(); },
    async append(type, data) {
      const work = tail.then(async () => {
        if (closed) throw new ProtocolError('CORE_CLOSED');
        const event = validateEvent({ protocolVersion: 1, sessionId, sequence: sequence + 1, eventId: `evt_${randomBytes(16).toString('hex')}`, time: now().toISOString(), type, data });
        const line = JSON.stringify(event) + '\n', size = Buffer.byteLength(line);
        if (size > maxBytes) throw new ProtocolError('EVENT_TOO_LARGE');
        const next = [...lines, { event, line, bytes: size }]; let total = bytes + size;
        let compacted = false;
        while (next.length > maxEvents || total > maxBytes) { total -= next.shift().bytes; compacted = true; }
        if (!compacted && typeof storage.appendJournal === 'function') await storage.appendJournal(sessionId, line, maxBytes);
        else await storage.write('journal', sessionId, next.map(item => item.line).join(''));
        // Commit in-memory sequence only after the atomic, synced write succeeds.
        lines = next; bytes = total; sequence = event.sequence;
        for (const subscriber of subscribers) enqueue(subscriber, event);
        return event;
      });
      tail = work.catch(() => {}); return work;
    },
    subscribe({ afterSequence = 0, signal } = {}) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > sequence) throw new ProtocolError('INVALID_CURSOR');
      if (afterSequence < minimum() - 1) throw new ProtocolError('CURSOR_EXPIRED');
      if (closed) throw new ProtocolError('CORE_CLOSED');
      if (subscribers.size >= 16) throw new ProtocolError('SESSION_LIMIT');
      const subscriber = { queue: [], bytes: 0, closed: false, signal };
      subscriber.abort = () => disconnect(subscriber);
      subscribers.add(subscriber); signal?.addEventListener('abort', subscriber.abort, { once: true });
      for (const entry of lines) if (entry.event.sequence > afterSequence) enqueue(subscriber, entry.event);
      if (signal?.aborted) disconnect(subscriber);
      return {
        async next() {
          while (!subscriber.queue.length && !subscriber.closed) await new Promise(resolve => { subscriber.wake = resolve; });
          if (subscriber.error) throw subscriber.error;
          if (!subscriber.queue.length) return { done: true, value: undefined };
          const entry = subscriber.queue.shift(); subscriber.bytes -= entry.bytes;
          return { done: false, value: structuredClone(entry.event) };
        },
        async return() { disconnect(subscriber); return { done: true, value: undefined }; },
        [Symbol.asyncIterator]() { return this; },
      };
    },
    async flush() { await tail; },
    async close() { await tail; closed = true; for (const subscriber of [...subscribers]) disconnect(subscriber); },
  });
}
