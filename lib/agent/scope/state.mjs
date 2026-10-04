import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { acquireLock as acquireAgentLock, newRunId, prepareState, runDir, writeAtomic } from '../state.mjs';
import { ScopeError } from './errors.mjs';
import { looksLikeSecret } from './redact.mjs';

// One project agent namespace shared with the existing new-game pipeline (lib/agent/state.mjs):
//   .zukujs/agent/run.lock                         the same single-writer lock for both pipelines
//   .zukujs/agent/runs/<run_id>/scope-run.json     zuku.scope.run/1 (no receipt.json, so the
//                                                  legacy --resume never treats it as its own)
//   .zukujs/agent/runs/<run_id>/scope-receipts.json  hash-chained zuku.scope.receipt/1 list
//   .zukujs/agent/runs/<run_id>/changes.diff + backup-NNN.bin
// The directory is private to the host: model tools can never read or write it.
export const STATE_DIR = join('.zukujs', 'agent');
export const LOCK_FILE = 'run.lock';
export const RUN_SCHEMA = 'zuku.scope.run/1';
export const RECEIPT_SCHEMA = 'zuku.scope.receipt/1';
export const STATE_LIMITS = Object.freeze({ receipts: 2048, stateBytes: 512 * 1024, diffBytes: 8 * 1024 * 1024, backups: 64 });
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value) ?? 'undefined').digest('hex');
export { newRunId };

const mapStateError = error => {
  if (error instanceof ScopeError) return error;
  if (error?.code === 'AGENT_BUSY') return new ScopeError('SCOPE_LOCKED');
  return new ScopeError('SCOPE_STATE_UNSAFE');
};

/** Acquires the shared run lock and creates the run directory. Returns { runId, dir, release }. */
export async function openRun(root, now = new Date()) {
  let state, lock;
  const runId = newRunId(now);
  try {
    state = await prepareState(root);
    lock = await acquireAgentLock(state, runId);
    const dir = await runDir(state, runId);
    return { runId, dir, release: () => lock.release() };
  } catch (error) {
    await lock?.release().catch(() => {});
    throw mapStateError(error);
  }
}

export function createRunStore(dir, runId) {
  const receipts = [];
  let prev = null, backups = 0, queue = Promise.resolve();
  // Writes are serialized; each is an atomic 0600 replace inside the validated run dir.
  const write = (name, text) => {
    const work = queue.then(() => writeAtomic(dir, name, text));
    queue = work.catch(() => {});
    return work.catch(error => { throw mapStateError(error); });
  };
  return {
    dir, runId,
    async receipt(entry) {
      if (receipts.length >= STATE_LIMITS.receipts) throw new ScopeError('SCOPE_LIMIT');
      const record = { schema: RECEIPT_SCHEMA, seq: receipts.length + 1, at: new Date().toISOString(), ...entry, prev };
      prev = digest(JSON.stringify(record));
      receipts.push({ ...record, digest: prev });
      await write('scope-receipts.json', JSON.stringify(receipts) + '\n');
      return receipts.at(-1);
    },
    async state(value) {
      const text = JSON.stringify({ schema: RUN_SCHEMA, run_id: runId, ...value }, null, 2) + '\n';
      if (text.length > STATE_LIMITS.stateBytes || looksLikeSecret(text)) throw new ScopeError('SCOPE_STATE_UNSAFE');
      await write('scope-run.json', text);
    },
    async backup(bytes) {
      if (++backups > STATE_LIMITS.backups) throw new ScopeError('SCOPE_LIMIT');
      const name = `backup-${String(backups).padStart(3, '0')}.bin`;
      await write(name, bytes);
      return { name, sha256: digest(bytes) };
    },
    async diff(text) { await write('changes.diff', text.length > STATE_LIMITS.diffBytes ? text.slice(0, STATE_LIMITS.diffBytes) + '\n[diff truncated]\n' : text); },
    async artifact(name, bytes) { return write(name, bytes); },
    get receipts() { return receipts.slice(); },
    get receiptHead() { return prev; },
  };
}
