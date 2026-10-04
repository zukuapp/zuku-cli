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

export async function frameworkEntry(cwd) {
  const resolvers = [createRequire(join(resolve(cwd), 'package.json')), createRequire(import.meta.url)];
  let manifest;
  for (const require of resolvers) {
    try { manifest = require.resolve('zukujs/package.json'); break; }
    catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw new CommandError('FRAMEWORK_UNAVAILABLE');
    }
  }
  if (!manifest) throw new CommandError('FRAMEWORK_UNAVAILABLE');
  try {
    const root = await realpath(dirname(manifest));
    const pkg = JSON.parse(await readFile(manifest, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.zukujs;
    if (pkg.name !== 'zukujs' || typeof bin !== 'string' || isAbsolute(bin)) throw new Error();
    const entry = await realpath(resolve(root, bin));
    const child = relative(root, entry);
    const ownEntry = await realpath(new URL('../index.mjs', import.meta.url));
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || entry === ownEntry) throw new Error();
    return entry;
  } catch { throw new CommandError('FRAMEWORK_UNAVAILABLE'); }
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
