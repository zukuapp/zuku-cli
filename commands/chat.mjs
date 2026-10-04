import { parseArgs } from '../lib/provider-system/args.mjs';
import { promptContext } from '../lib/provider-system/command-context.mjs';
import { isInteractive, askLine } from '../lib/provider-system/prompt.mjs';
import { AgentError } from '../lib/agent/errors.mjs';
import { LIMITS } from '../lib/agent-protocol/index.mjs';
import { DEFAULT_MODEL_ADDRESS } from '../lib/provider-system/catalog.mjs';
import { openCore, grantProject, runCoreOperation, renderEvent, normalizeModelAddress } from '../lib/cli-core-runtime.mjs';

const FLAGS = { '--model': 'string', '--experimental': 'boolean', '--yolo': 'boolean', '--draft': 'boolean' };

/**
 * zuku|zukujs chat ["message"] [--model <provider/model>] [--experimental] [--yolo | --draft]
 * Maintains the ZUKU game in the current folder through one reused Agent Core session
 * (`game.maintain`). Without a message on a terminal it reads turns until an empty line.
 */
export default async function chat(args = [], context = {}) {
  const options = parseArgs(args, { flags: FLAGS, positionals: 64 });
  if (options.yolo && options.draft) throw new AgentError('INVALID_INPUT');
  const mode = options.yolo ? 'yolo' : options.draft ? 'draft' : 'local';
  const pctx = promptContext(context), stderr = pctx.stderr;
  const first = options._.length ? options._.join(' ') : undefined;
  if (first === undefined && !isInteractive(pctx)) throw new AgentError('AGENT_REQUEST_REQUIRED');
  const core = context.coreHandle ?? await openCore(context);
  try {
    let modelAddress;
    if (options.model === 'auto') modelAddress = DEFAULT_MODEL_ADDRESS;
    else if (options.model) modelAddress = normalizeModelAddress(options.model, { provider: options.model.includes('/') ? undefined : (await core.call('provider.list')).activeProvider });
    const project = await grantProject(core, { cwd: context.cwd ?? process.cwd(), purpose: 'game.maintain', request: first });
    const turn = request => {
      if (!request.trim() || [...request].length > LIMITS.promptChars) throw new AgentError('AGENT_REQUEST_INVALID');
      return runCoreOperation(core, { projectHandle: project.projectHandle, operation: 'game.maintain', request: request.trim(), modelAddress, mode, experimental: options.experimental === true, signal: context.signal, onEvent: event => renderEvent(event, { stderr }) });
    };
    if (first !== undefined) return await turn(first);
    const turns = [];
    while (!context.signal?.aborted) {
      const line = await askLine(pctx, 'zuku> ', { fallback: '', maxLength: LIMITS.promptChars * 4 });
      if (!line) break;
      turns.push(await turn(line));
      stderr.write('\n');
    }
    return { turns: turns.length, last: turns.at(-1) ?? null, projectHandle: project.projectHandle };
  } finally { if (!context.coreHandle) core.close(); }
}
