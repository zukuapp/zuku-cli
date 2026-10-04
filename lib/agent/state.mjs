import { lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { AgentError } from './errors.mjs';
import { LIMITS, RUN_ID } from './limits.mjs';
import { containsSecret } from './safety.mjs';

/*
 * Local agent state lives in <cwd>/.zukujs/agent (0700): run.lock plus runs/<run_id>/ with
 * receipt.json, playtest evidence and the thumbnail. Every component is created one level at a
 * time and must be a real, user-owned directory (never a symlink). Receipts are written
 * atomically (temp + rename, 0600) and never contain the request text, prompts or tokens.
 */
export const STATE_DIR = join('.zukujs', 'agent');
export const RECEIPT_SCHEMA = 'zukujs-agent-receipt/1';
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

async function validateDir(path, uid, privateMode = true) {
  let stat;
  try { stat = await lstat(path); } catch { throw new AgentError('AGENT_STATE_UNSAFE'); }
  if (stat.isSymbolicLink() || !stat.isDirectory() || (typeof uid === 'number' && (stat.uid !== uid || (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0))) throw new AgentError('AGENT_STATE_UNSAFE');
  return stat;
}

async function ensureDir(path, uid, privateMode = true) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw new AgentError('AGENT_STATE_UNSAFE'); }
  await validateDir(path, uid, privateMode);
  return path;
}

const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Validate every existing component, and remember identities across awaited I/O. */
async function validateStateChain(state, runId) {
  const agent = resolve(state.agent);
  const shared = dirname(agent);
  const runs = join(agent, 'runs');
  if (basename(agent) !== 'agent' || basename(shared) !== '.zukujs'
      || resolve(state.runs) !== runs || resolve(state.lock) !== join(agent, 'run.lock')) throw new AgentError('AGENT_STATE_UNSAFE');
  const paths = [[shared, false], [agent, true], [runs, true]];
  if (runId !== undefined) {
    if (!RUN_ID.test(runId)) throw new AgentError('AGENT_RESUME_INVALID');
    paths.push([join(runs, runId), true]);
  }
  const uid = process.getuid?.();
  const chain = [];
  for (const [path, privateMode] of paths) chain.push({ path, privateMode, stat: await validateDir(path, uid, privateMode) });
  return chain;
}

async function verifyChain(chain) {
  for (const entry of chain) {
    if (!sameIdentity(entry.stat, await validateDir(entry.path, process.getuid?.(), entry.privateMode))) throw new AgentError('AGENT_STATE_UNSAFE');
  }
}

function stateForRun(dir) {
  const run = resolve(dir);
  const runs = dirname(run);
  const agent = dirname(runs);
  if (basename(runs) !== 'runs' || !RUN_ID.test(basename(run))) throw new AgentError('AGENT_STATE_UNSAFE');
  return { state: { agent, runs, lock: join(agent, 'run.lock') }, runId: basename(run) };
}

/** Read-only guard for state-backed cleanup: never creates a missing component. */
export async function validateRunDir(dir) {
  const { state, runId } = stateForRun(dir);
  await validateStateChain(state, runId);
  return resolve(dir);
}

function validatePrivateFile(stat, maxBytes) {
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes
      || (typeof uid === 'number' && (stat.uid !== uid || (stat.mode & 0o777) !== 0o600))) throw new AgentError('AGENT_STATE_UNSAFE');
}

async function verifyFile(path, expected, maxBytes) {
  const stat = await lstat(path);
  validatePrivateFile(stat, maxBytes);
  if (!sameIdentity(stat, expected)) throw new AgentError('AGENT_STATE_UNSAFE');
}

/** Reads a bounded, private regular file through a checked no-follow handle. */
async function readPrivateFile(path, maxBytes, chain) {
  let handle;
  try {
    await verifyChain(chain);
    const before = await lstat(path);
    validatePrivateFile(before, maxBytes);
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const stat = await handle.stat();
    validatePrivateFile(stat, maxBytes);
    if (!sameIdentity(before, stat)) throw new AgentError('AGENT_STATE_UNSAFE');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    validatePrivateFile(after, maxBytes);
    if (length > maxBytes || length !== after.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new AgentError('AGENT_STATE_UNSAFE');
    await verifyChain(chain);
    await verifyFile(path, after, maxBytes);
    const text = bytes.subarray(0, length).toString('utf8');
    if (containsSecret(text)) throw new AgentError('AGENT_STATE_UNSAFE');
    return { text, stat: after };
  } finally { await handle?.close().catch(() => {}); }
}

async function unlinkPrivateFile(path, stat, maxBytes, chain) {
  await verifyChain(chain);
  await verifyFile(path, stat, maxBytes);
  await unlink(path);
}

/** Creates/validates .zukujs/agent and runs/; returns absolute paths. */
export async function prepareState(cwd, { uid = process.getuid?.() } = {}) {
  // .zukujs may be shared with upload receipts: it must be a real directory, its mode is the user's choice.
  await ensureDir(join(cwd, '.zukujs'), uid, false);
  const agent = await ensureDir(join(cwd, STATE_DIR), uid);
  const runs = await ensureDir(join(agent, 'runs'), uid);
  const state = { agent, runs, lock: join(agent, 'run.lock') };
  await validateStateChain(state);
  return state;
}

export const newRunId = (now = new Date()) => `run_${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${randomBytes(4).toString('hex')}`;

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

/** Exclusive per-directory run lock. A lock left by a dead local process is reclaimed once. */
export async function acquireLock(state, runId) {
  if (!RUN_ID.test(runId)) throw new AgentError('AGENT_RESUME_INVALID');
  const chain = await validateStateChain(state);
  const body = JSON.stringify({ pid: process.pid, run_id: runId, host: hostname(), started_at: new Date().toISOString() }) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      await verifyChain(chain);
      handle = await open(state.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      await handle.writeFile(body);
      const stat = await handle.stat();
      validatePrivateFile(stat, 4096);
      await verifyChain(chain);
      await verifyFile(state.lock, stat, 4096);
      await handle.close();
      return { release: () => releaseLock(state, runId, stat, chain) };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== 'EEXIST') throw new AgentError('AGENT_STATE_UNSAFE');
    }
    let holder, record;
    try {
      record = await readPrivateFile(state.lock, 4096, chain);
      holder = JSON.parse(record.text);
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('AGENT_BUSY');
    }
    const stale = holder?.host === hostname() && Number.isSafeInteger(holder.pid) && holder.pid > 0 && holder.pid !== process.pid && !alive(holder.pid);
    if (!stale || attempt) throw new AgentError('AGENT_BUSY');
    await unlinkPrivateFile(state.lock, record.stat, 4096, chain);
  }
  throw new AgentError('AGENT_BUSY');
}

async function releaseLock(state, runId, identity, chain) {
  try {
    const record = await readPrivateFile(state.lock, 4096, chain);
    const holder = JSON.parse(record.text);
    if (sameIdentity(record.stat, identity) && holder?.run_id === runId && holder.pid === process.pid && holder.host === hostname()) await unlinkPrivateFile(state.lock, record.stat, 4096, chain);
  } catch { /* Already gone or replaced: leave the other file untouched. */ }
}

export async function runDir(state, runId) {
  if (!RUN_ID.test(runId)) throw new AgentError('AGENT_RESUME_INVALID');
  const chain = await validateStateChain(state);
  const dir = await ensureDir(join(state.runs, runId), process.getuid?.());
  await verifyChain(chain);
  return dir;
}

/** Atomic 0600 write inside a validated run directory. */
export async function writeAtomic(dir, name, bytes) {
  const { state, runId } = stateForRun(dir);
  const chain = await validateStateChain(state, runId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new AgentError('AGENT_STATE_UNSAFE');
  const target = join(dir, name);
  const temp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  let tempIdentity;
  try {
    await writeFile(temp, bytes, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode: 0o600 });
    tempIdentity = await lstat(temp);
    validatePrivateFile(tempIdentity, Number.MAX_SAFE_INTEGER);
    await verifyChain(chain);
    await verifyFile(temp, tempIdentity, Number.MAX_SAFE_INTEGER);
    await rename(temp, target);
    return target;
  } catch (error) {
    if (tempIdentity) await unlinkPrivateFile(temp, tempIdentity, Number.MAX_SAFE_INTEGER, chain).catch(() => {});
    throw error;
  }
}

/** Receipt writer: refuses to persist anything secret-looking or oversized. */
export async function saveReceipt(dir, receipt) {
  const text = JSON.stringify({ ...receipt, updated_at: new Date().toISOString() }, null, 2) + '\n';
  if (text.length > LIMITS.receiptBytes || containsSecret(text)) throw new AgentError('AGENT_STATE_UNSAFE');
  return writeAtomic(dir, 'receipt.json', text);
}

export async function loadReceipt(state, runId) {
  if (!RUN_ID.test(runId)) throw new AgentError('AGENT_RESUME_INVALID');
  const dir = join(state.runs, runId);
  const path = join(dir, 'receipt.json');
  try {
    const chain = await validateStateChain(state, runId);
    const { text } = await readPrivateFile(path, LIMITS.receiptBytes, chain);
    const receipt = JSON.parse(text);
    if (receipt?.schema !== RECEIPT_SCHEMA || receipt.run_id !== runId) throw new Error('schema');
    return { receipt, dir };
  } catch { throw new AgentError('AGENT_RESUME_INVALID'); }
}
