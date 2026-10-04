import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CommandError } from './errors.mjs';

// This finite set is taken from the framework's CLI registration. Unknown
// commands stay local errors rather than becoming arbitrary executable paths.
export const FRAMEWORK_COMMANDS = Object.freeze([
  'build', 'analyze', 'dev', 'export', 'info', 'start', 'telemetry', 'typegen',
  'upgrade', 'experimental-test', 'experimental-request-insights', 'internal',
  'report-agent-upgrade', 'agent-feedback-instructions', 'trace', 'query-trace',
  'post-build', 'upload-trace', 'static-routes-info',
]);

// ZUKU's framework fork keeps the upstream next package/bin for compatibility.
// Its package-owned identity is an explicit distribution marker; an ordinary
// Next.js install, directory name or inferred version is insufficient.
function brandedNext(pkg) {
  const identity = pkg.zukujs;
  return pkg.name === 'next' && identity?.name === 'ZukuJS'
    && typeof identity.version === 'string'
    && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(identity.version)
    && identity.command_protocol === 'zuku-command/1'
    && (identity.upstream === undefined || identity.upstream === pkg.version);
}

async function manifestEntry(manifest) {
  try {
    const root = await realpath(dirname(manifest));
    const pkg = JSON.parse(await readFile(manifest, 'utf8'));
    const native = brandedNext(pkg);
    if (pkg.name !== 'zukujs' && !native) throw new Error();
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[native ? 'next' : 'zukujs'];
    if (typeof bin !== 'string' || isAbsolute(bin)) throw new Error();
    const entry = await realpath(resolve(root, bin));
    const child = relative(root, entry);
    const ownEntry = await realpath(new URL('../index.mjs', import.meta.url));
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || entry === ownEntry) throw new Error();
    return entry;
  } catch { throw new CommandError('FRAMEWORK_UNAVAILABLE'); }
}

export async function frameworkEntry(cwd) {
  const resolvers = [createRequire(join(resolve(cwd), 'package.json')), createRequire(import.meta.url)];
  for (const require of resolvers) {
    for (const name of ['zukujs', 'next']) {
      let manifest;
      try { manifest = require.resolve(`${name}/package.json`); }
      catch (error) {
        if (error?.code === 'MODULE_NOT_FOUND') continue;
        throw new CommandError('FRAMEWORK_UNAVAILABLE');
      }
      return manifestEntry(manifest);
    }
  }
  throw new CommandError('FRAMEWORK_UNAVAILABLE');
}

export async function runFramework(args, { cwd, stdout, stderr, signal }) {
  if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
  const entry = await frameworkEntry(cwd);
  if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd, shell: false,
      stdio: ['inherit', stdout === process.stdout ? 'inherit' : 'pipe', stderr === process.stderr ? 'inherit' : 'pipe'],
    });
    child.stdout?.on('data', chunk => stdout.write(chunk));
    child.stderr?.on('data', chunk => stderr.write(chunk));
    let killTimer;
    const cancel = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const cleanup = () => { signal?.removeEventListener('abort', cancel); clearTimeout(killTimer); };
    child.once('error', () => { cleanup(); reject(new CommandError('FRAMEWORK_UNAVAILABLE')); });
    child.once('close', (code, childSignal) => {
      cleanup();
      resolveResult(signal?.aborted || childSignal === 'SIGINT' ? 130 : code ?? 1);
    });
    if (signal?.aborted) cancel();
  });
}
