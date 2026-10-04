import { CommandError } from '../lib/errors.mjs';
import { openCore, runCoreOperation, renderEvent } from '../lib/cli-core-runtime.mjs';

const REQUESTS = Object.freeze({ 'game.test': 'Run the declared tests for this ZUKU game.', 'game.build': 'Build this ZUKU game.' });

/**
 * Runs Core's declared build/test tool for the ZUKU game in the current folder (`game.test`
 * / `game.build`). The folder must be a granted ZUKU game; nothing outside Core executes.
 */
export async function runProjectOperation(operation, args = [], context = {}) {
  if (args.some(arg => arg !== '--json')) throw new CommandError('INVALID_INPUT');
  const stderr = context.stderr ?? process.stderr;
  const core = context.coreHandle ?? await openCore(context);
  try {
    return await runCoreOperation(core, { cwd: context.cwd ?? process.cwd(), purpose: 'game.maintain', operation, request: REQUESTS[operation], signal: context.signal, onEvent: event => renderEvent(event, { stderr }) });
  } finally { if (!context.coreHandle) core.close(); }
}

/** zuku|zukujs test — the project's declared tests in Core's OS sandbox. */
export default function test(args = [], context = {}) {
  return runProjectOperation('game.test', args, context);
}
