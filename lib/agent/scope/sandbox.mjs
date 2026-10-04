import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ScopeError } from './errors.mjs';
import { isPrivate } from './paths.mjs';
import { boundText } from './redact.mjs';

// Project tests/builds execute project code. They run ONLY inside an OS sandbox
// (Linux bubblewrap): fresh namespaces incl. network, cleared environment, tmpfs home,
// read-only system/Node, a disposable snapshot of admitted project files. There is no
// unsandboxed fallback: without a verified sandbox the capability is unavailable.
export const SANDBOX_LIMITS = Object.freeze({ files: 5000, bytes: 64 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, timeoutMs: 120_000, outputBytes: 64 * 1024, outputKillBytes: 8 * 1024 * 1024, testFiles: 200, lineChars: 2000, outputLines: 4000, outputQueue: 64, sinkTimeoutMs: 10_000 });
const SKIP_TOP = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const FORBIDDEN_ARG = /^(?:-e|-p|-r|-i|-c|--(?:eval|print|require|import|loader|experimental|inspect|allow|permission|env-file|watch|run|interactive|check|input-type|preserve-symlinks|conditions|snapshot|build-snapshot|cpu-prof|heap-prof|diagnostic|report|openssl|use-|tls|redirect|frozen|disable))/;
let probeCache = new Map();

/** Detects a usable sandbox. Returns { available, kind, reason }. Never throws. */
export async function detectSandbox({ platform = process.platform, bwrapPath = '/usr/bin/bwrap', nodePath = process.execPath, spawnImpl = spawn, signal } = {}) {
  if (platform !== 'linux') return { available: false, kind: null, reason: 'platform-unsupported' };
  const key = `${bwrapPath}\0${nodePath}`;
  if (probeCache.has(key)) return probeCache.get(key);
  let result;
  try {
    const stat = await lstat(bwrapPath);
    // A sandbox binary that others could have replaced is not trusted.
    if (!stat.isFile() || (stat.mode & 0o022) || (typeof process.getuid === 'function' && stat.uid !== 0 && stat.uid !== process.getuid())) result = { available: false, kind: null, reason: 'bwrap-untrusted' };
    else {
      const work = await mkdtemp(join(tmpdir(), 'zuku-scope-probe-'));
      try {
        const probe = await execute({ bwrapPath, nodePath, work, argv: ['node', '-e', 'require("node:net").connect(80,"1.1.1.1").on("error",()=>process.exit(0)).on("connect",()=>process.exit(3))'], timeoutMs: 15_000, spawnImpl, signal, probe: true });
        result = probe.exit_code === 0 ? { available: true, kind: 'bwrap', reason: null } : { available: false, kind: null, reason: 'bwrap-probe-failed' };
      } finally { await rm(work, { recursive: true, force: true }); }
    }
  } catch { result = { available: false, kind: null, reason: 'bwrap-missing' }; }
  probeCache.set(key, result);
  return result;
}
export const resetSandboxProbe = () => { probeCache = new Map(); };

async function systemBinds() {
  const args = ['--ro-bind', '/usr', '/usr'];
  for (const dir of ['/bin', '/sbin', '/lib', '/lib64', '/lib32']) {
    const stat = await lstat(dir).catch(() => undefined);
    if (!stat) continue;
    if (stat.isSymbolicLink()) args.push('--symlink', (await realpath(dir)).replace(/^\//, ''), dir);
    else if (stat.isDirectory()) args.push('--ro-bind', dir, dir);
  }
  for (const file of ['/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/alternatives']) args.push('--ro-bind-try', file, file);
  return args;
}

// Live output: line-buffered so redaction sees whole lines, each line bounded, total bounded
// by the same per-stream cap as the stored output and by outputLines. Deliveries are awaited
// one at a time in order. At most outputQueue lines wait: above that the child's pipes are
// paused (backpressure) until the queue drains. A delivery that rejects, throws or exceeds
// sinkTimeoutMs is a host journal failure: onFailure kills the process group and idle()
// rejects with it, so the run never completes with output the host did not accept.
function lineEmitter(onOutput, { onFailure = () => {}, onPressure = () => {}, sinkTimeoutMs = SANDBOX_LIMITS.sinkTimeoutMs } = {}) {
  if (typeof onOutput !== 'function') return { push() {}, flush() {}, idle: async () => {} };
  const pending = { stdout: '', stderr: '' }, sent = { stdout: 0, stderr: 0 };
  let chain = Promise.resolve(), queued = 0, lines = 0, failure, paused = false;
  const fail = error => { if (failure) return; failure = error instanceof ScopeError ? error : new ScopeError('SCOPE_STATE_UNSAFE', { reason: 'event_delivery' }); onFailure(failure); };
  const deliver = async item => {
    let timer;
    try {
      await Promise.race([
        (async () => onOutput(item))(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new ScopeError('SCOPE_STATE_UNSAFE', { reason: 'event_timeout' })), sinkTimeoutMs); }),
      ]);
    } catch (error) { fail(error); } finally { clearTimeout(timer); }
  };
  const emit = (stream, line) => {
    if (failure || sent[stream] >= SANDBOX_LIMITS.outputBytes || lines >= SANDBOX_LIMITS.outputLines) return;
    const text = boundText(line, SANDBOX_LIMITS.lineChars).text;
    sent[stream] += text.length + 1; lines++; queued++;
    if (!paused && queued > SANDBOX_LIMITS.outputQueue) { paused = true; onPressure(true); }
    // The chain itself never rejects; failures are recorded and surfaced by idle().
    chain = chain.then(() => (failure ? undefined : deliver({ stream, text }))).then(() => {
      queued--;
      if (paused && (failure || queued <= SANDBOX_LIMITS.outputQueue / 2)) { paused = false; onPressure(false); }
    });
  };
  return {
    push(stream, chunk) {
      pending[stream] += chunk.toString('utf8');
      let index;
      while ((index = pending[stream].indexOf('\n')) >= 0) { emit(stream, pending[stream].slice(0, index)); pending[stream] = pending[stream].slice(index + 1); }
      if (pending[stream].length > 8192) { emit(stream, pending[stream]); pending[stream] = ''; }
    },
    flush() { for (const stream of ['stdout', 'stderr']) if (pending[stream]) { emit(stream, pending[stream]); pending[stream] = ''; } },
    async idle() { await chain; if (failure) throw failure; },
  };
}

async function execute({ bwrapPath, nodePath, work, nodeModules, argv, timeoutMs, spawnImpl = spawn, signal, prlimitPath, onOutput, sinkTimeoutMs }) {
  const nodeReal = await realpath(nodePath);
  const nodePrefix = dirname(dirname(nodeReal));
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL',
    ...(await systemBinds()),
    ...(nodePrefix === '/usr' || nodePrefix.startsWith('/usr/') ? [] : ['--ro-bind', nodePrefix, nodePrefix]),
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/home',
    '--bind', work, '/work', ...(nodeModules ? ['--ro-bind', nodeModules, '/work/node_modules'] : []), '--chdir', '/work',
    '--setenv', 'PATH', `${dirname(nodeReal)}:/usr/bin:/bin`, '--setenv', 'HOME', '/tmp/home', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'CI', '1', '--setenv', 'NO_COLOR', '1', '--setenv', 'LANG', 'C.UTF-8',
    '--', nodeReal, ...argv.slice(1),
  ];
  const [command, full] = prlimitPath ? [prlimitPath, ['--nproc=512', '--nofile=1024', '--fsize=67108864', '--core=0', '--', bwrapPath, ...args]] : [bwrapPath, args];
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(command, full, { stdio: ['ignore', 'pipe', 'pipe'], env: {}, detached: true, shell: false, windowsHide: true }); }
    catch { resolve({ exit_code: null, signal: null, spawn_failed: true, timed_out: false, aborted: false, output_overflow: false, stdout: '', stderr: '', truncated: false, duration_ms: 0 }); return; }
    const out = { stdout: [], stderr: [], size: { stdout: 0, stderr: 0 } };
    let timedOut = false, aborted = false, overflow = false, finished = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } } };
    const live = lineEmitter(onOutput, {
      sinkTimeoutMs, onFailure: kill,
      onPressure: full => { for (const stream of [child.stdout, child.stderr]) { try { if (full) stream?.pause(); else stream?.resume(); } catch { /* stream closed */ } } },
    });
    const collect = name => chunk => {
      const before = out.size[name];
      out.size[name] += chunk.length;
      live.push(name, chunk);
      if (before < SANDBOX_LIMITS.outputBytes) out[name].push(chunk.subarray(0, SANDBOX_LIMITS.outputBytes - before));
      if (out.size.stdout + out.size.stderr > SANDBOX_LIMITS.outputKillBytes && !overflow) { overflow = true; kill(); }
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { aborted = true; kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const done = (code, sig, failed = false) => {
      if (finished) return; finished = true;
      live.flush();
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      const text = name => boundText(Buffer.concat(out[name]).toString('utf8'), SANDBOX_LIMITS.outputBytes).text;
      // Completion is reported only after every queued output line was accepted by the host.
      const result = { exit_code: code, signal: sig, spawn_failed: failed, timed_out: timedOut, aborted, output_overflow: overflow, stdout: text('stdout'), stderr: text('stderr'), truncated: out.size.stdout > SANDBOX_LIMITS.outputBytes || out.size.stderr > SANDBOX_LIMITS.outputBytes, duration_ms: Date.now() - started };
      live.idle().then(() => resolve(result), reject);
    };
    child.on('error', () => done(null, null, true));
    child.on('close', (code, sig) => done(code, sig));
  });
}

/**
 * Copies admitted, non-private regular single-link files into a fresh snapshot (or, with
 * work=null, only hashes them). The digest binds verification results to exact source bytes.
 */
export async function snapshotTree(root, work, { signal } = {}) {
  const hash = createHash('sha256');
  let files = 0, bytes = 0;
  const pending = [''];
  while (pending.length) {
    if (signal?.aborted) throw new ScopeError('COMMAND_CANCELLED');
    const rel = pending.shift();
    const list = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of list) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if ((!rel && SKIP_TOP.has(entry.name)) || isPrivate(path.split('/'))) continue;
      if (entry.isDirectory()) { if (work) await mkdir(join(work, path)); pending.push(path); continue; }
      if (!entry.isFile()) continue;
      if (++files > SANDBOX_LIMITS.files) throw new ScopeError('SCOPE_LIMIT');
      let handle;
      try {
        handle = await open(join(root, path), READ);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > SANDBOX_LIMITS.fileBytes) continue;
        bytes += stat.size;
        if (bytes > SANDBOX_LIMITS.bytes) throw new ScopeError('SCOPE_LIMIT');
        const data = await handle.readFile();
        if (work) await writeFile(join(work, path), data, { flag: 'wx', mode: 0o644 });
        hash.update(`${path}\0${data.length}\0`).update(data);
      } catch (error) { if (error instanceof ScopeError) throw error; } finally { await handle?.close().catch(() => {}); }
    }
  }
  return { files, bytes, digest: hash.digest('hex') };
}

async function listTests(work) {
  const found = [];
  for (const dir of ['tests', 'test']) {
    const pending = [dir];
    while (pending.length && found.length < SANDBOX_LIMITS.testFiles) {
      const rel = pending.shift();
      let list; try { list = await readdir(join(work, rel), { withFileTypes: true }); } catch { continue; }
      for (const entry of list.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = `${rel}/${entry.name}`;
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && /\.test\.(?:mjs|cjs|js)$/.test(entry.name)) found.push(path);
      }
    }
  }
  return found;
}

/**
 * Host-declared command forms. Models choose only an id; argv is fixed here or comes from
 * root-supplied `forms` ({ id, kind: 'tests'|'build', file, args }) whose program is always
 * the trusted Node binary and whose file is a project-relative script. No shell, no npm
 * scripts, no model-provided flags.
 */
export async function resolveForms(root, forms = []) {
  const out = new Map();
  const fileStat = async path => { const s = await lstat(join(root, path)).catch(() => undefined); return s?.isFile() && !s.isSymbolicLink() && s.nlink === 1 ? s : undefined; };
  const dirExists = async path => { const s = await lstat(join(root, path)).catch(() => undefined); return Boolean(s?.isDirectory() && !s.isSymbolicLink()); };
  if (await dirExists('tests') || await dirExists('test')) out.set('node-test', { id: 'node-test', kind: 'tests', builtin: true });
  if (await dirExists('node_modules') && await fileStat('tsconfig.json') && await dirExists('node_modules/typescript') && await dirExists('node_modules/typescript/bin')) {
    out.set('tsc-check', { id: 'tsc-check', kind: 'build', builtin: true, argv: ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'] });
  }
  for (const form of Array.isArray(forms) ? forms.slice(0, 32) : []) {
    if (!form || typeof form.id !== 'string' || !ID.test(form.id) || out.has(form.id) || !['tests', 'build'].includes(form.kind)) continue;
    const parts = typeof form.file === 'string' ? form.file.split('/') : [];
    if (!parts.length || parts.some(p => !p || p === '.' || p === '..') || form.file.startsWith('/') || /[\\\x00-\x1f:]/.test(form.file) || isPrivate(parts) || !/\.(?:mjs|cjs|js)$/.test(form.file)) continue;
    const args = Array.isArray(form.args) ? form.args : [];
    if (args.length > 16 || args.some(arg => typeof arg !== 'string' || arg.length > 200 || /[\x00-\x1f]/.test(arg) || FORBIDDEN_ARG.test(arg))) continue;
    if (!(await fileStat(form.file))) continue;
    out.set(form.id, { id: form.id, kind: form.kind, argv: ['node', form.file, ...args] });
  }
  return out;
}

export function createSandboxRunner({ root, forms, detect = detectSandbox, bwrapPath = '/usr/bin/bwrap', nodePath = process.execPath, prlimitPath, spawnImpl = spawn, timeoutMs = SANDBOX_LIMITS.timeoutMs, sinkTimeoutMs = SANDBOX_LIMITS.sinkTimeoutMs } = {}) {
  return {
    async capability(signal) { return detect({ bwrapPath, nodePath, spawnImpl, signal }); },
    async forms() { return resolveForms(root, forms); },
    async run(id, kind, { signal, onOutput } = {}) {
      const cap = await detect({ bwrapPath, nodePath, spawnImpl, signal });
      if (!cap.available) throw new ScopeError('SANDBOX_UNAVAILABLE', { reason: cap.reason });
      const form = (await resolveForms(root, forms)).get(id);
      if (!form || form.kind !== kind) throw new ScopeError('SCOPE_TOOL_DENIED');
      const base = await mkdtemp(join(tmpdir(), 'zuku-scope-'));
      try {
        const work = join(base, 'work');
        await mkdir(work);
        const snapshot = await snapshotTree(root, work, { signal });
        let argv = form.argv;
        if (form.id === 'node-test') {
          const tests = await listTests(work);
          if (!tests.length) return { script_id: id, kind, sandbox: 'bwrap', passed: false, exit_code: null, reason: 'no-test-files', snapshot_digest: snapshot.digest };
          argv = ['node', '--test', '--test-reporter=spec', ...tests];
        }
        const nm = await lstat(join(root, 'node_modules')).catch(() => undefined);
        const nodeModules = nm?.isDirectory() && !nm.isSymbolicLink() ? join(root, 'node_modules') : undefined;
        if (nodeModules) await mkdir(join(work, 'node_modules')).catch(() => {});
        const prlimit = prlimitPath ?? (await lstat('/usr/bin/prlimit').then(s => (s.isFile() ? '/usr/bin/prlimit' : undefined), () => undefined));
        const result = await execute({ bwrapPath, nodePath, work, nodeModules, argv, timeoutMs, spawnImpl, signal, prlimitPath: prlimit, onOutput, sinkTimeoutMs });
        if (result.aborted) throw new ScopeError('COMMAND_CANCELLED');
        // `passed` is a host observation of the process, never a model statement.
        return { script_id: id, kind, sandbox: 'bwrap', network: false, passed: result.exit_code === 0 && !result.timed_out && !result.signal && !result.output_overflow && !result.spawn_failed, ...result, snapshot_digest: snapshot.digest, snapshot_files: snapshot.files };
      } finally { await rm(base, { recursive: true, force: true }); }
    },
  };
}
