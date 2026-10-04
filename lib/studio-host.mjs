import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createStudioHostContext } from './studio-context.mjs';
import { createStudioStdio } from './studio-stdio.mjs';
import { safeError } from './agent-protocol/index.mjs';

export async function startStudioHost(context, options = {}) {
  return createStudioStdio({ context, input: options.input ?? process.stdin, output: options.output ?? process.stdout, ...options });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let context;
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--stdio') throw Object.assign(new Error(), { code: 'INVALID_INPUT' });
    context = await createStudioHostContext({ quiet: true });
    const bridge = await startStudioHost(context);
    const stop = () => { process.stdin.destroy(); void bridge.close(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop); await bridge.done;
  } catch (error) {
    await context?.close().catch(() => {});
    process.stdout.write(JSON.stringify({ protocolVersion: 1, type: 'studio.error', data: safeError(error) }) + '\n'); process.exitCode = 1;
  }
}
