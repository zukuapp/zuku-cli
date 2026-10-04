import { parseAgentArgs } from '../lib/agent/args.mjs';
import { runGameAgent, resumeGameAgent } from '../lib/agent/orchestrator.mjs';
import { readInteractiveRequest } from '../lib/agent/prompt.mjs';
import { AgentError } from '../lib/agent/errors.mjs';
import { LIMITS } from '../lib/agent-protocol/index.mjs';
import { DEFAULT_MODEL_ADDRESS } from '../lib/provider-system/catalog.mjs';
import { openCore, grantProject, runCoreOperation, renderEvent, normalizeModelAddress, isZukuGame, CoreCliError, ECOSYSTEM } from '../lib/cli-core-runtime.mjs';

export { parseAgentArgs, runGameAgent, resumeGameAgent };

// Explicitly injected orchestrator dependencies are the historical test/library seam.
const LEGACY_SEAMS = Object.freeze(['provider', 'deploy', 'playtest', 'upload']);
export const usesLegacyAgentContext = (context = {}) => LEGACY_SEAMS.some(key => context[key] !== undefined);
const RESUME_REQUEST = 'Resume the recorded ZUKU game run.';

/** Direct callers without an abort signal still get SIGINT/SIGTERM cancellation. */
async function withInterrupt(context, work) {
  let controller, interrupt;
  if (!context.signal) {
    controller = new AbortController();
    interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
  }
  try { return await work(context.signal ?? controller.signal); }
  finally { if (interrupt) { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); } }
}

/** Splits the Core-only `--experimental` opt-in from the unchanged legacy agent grammar. */
export function splitExperimental(args = []) {
  if (!Array.isArray(args)) throw new AgentError('INVALID_INPUT');
  const end = args.indexOf('--');
  const flags = end === -1 ? args : args.slice(0, end);
  const count = flags.filter(arg => arg === '--experimental').length;
  if (count > 1) throw new AgentError('INVALID_INPUT');
  return { experimental: count === 1, rest: count ? args.filter((arg, index) => arg !== '--experimental' || end !== -1 && index > end) : args };
}

/**
 * One Agent Core run for agent/init. `force`: 'init' always creates a new game; otherwise a
 * granted ZUKU project is maintained and any other workspace gets a new game (Core admits it).
 */
export async function runAgentThroughCore(args = [], context = {}, { force } = {}) {
  const { experimental, rest } = splitExperimental(args);
  const options = parseAgentArgs(rest);
  // --browser selects the playtest Chromium; zuku-agent/1 has no validated carrier for it.
  if (options.browser !== undefined) throw new CoreCliError('CORE_PROTOCOL_GAP');
  const stdin = context.stdin ?? process.stdin, stderr = context.stderr ?? process.stderr;
  const interactive = context.interactive ?? Boolean(stdin?.isTTY && stderr?.isTTY);
  return withInterrupt(context, async signal => {
    let request = options.request;
    if (!options.resume && request === undefined) {
      if (!interactive) throw new AgentError('AGENT_REQUEST_REQUIRED');
      request = await readInteractiveRequest({ stdin, stderr, signal, maxChars: LIMITS.promptChars });
    }
    if (!options.resume && (typeof request !== 'string' || !request.trim() || [...request].length > LIMITS.promptChars)) throw new AgentError('AGENT_REQUEST_INVALID');
    const core = context.coreHandle ?? await openCore({ ...context, signal });
    try {
      let modelAddress;
      if (options.model === 'auto') modelAddress = DEFAULT_MODEL_ADDRESS;
      else if (options.model) modelAddress = normalizeModelAddress(options.model, { provider: options.model.includes('/') ? undefined : (await core.call('provider.list')).activeProvider });
      const init = force === 'init' || options.resume !== undefined || options.name !== undefined;
      const cwd = context.cwd ?? process.cwd();
      const project = await grantProject(core, { cwd, purpose: init ? 'game.init' : undefined, request: options.resume ? undefined : request });
      // A re-grant returns the classification recorded at first grant; re-check the folder now.
      const game = ECOSYSTEM.includes(project.classification) || await isZukuGame(cwd, { signal });
      const operation = init || !game ? 'game.init' : 'game.maintain';
      return await runCoreOperation(core, { projectHandle: project.projectHandle, operation, request: options.resume ? RESUME_REQUEST : request.trim(), name: options.name, modelAddress, mode: options.mode, experimental, resume: options.resume, signal, onEvent: event => renderEvent(event, { stderr }) });
    } finally { if (!context.coreHandle) core.close(); }
  });
}

/**
 * zukujs agent ["game request"] [--name <name>] [--model <provider/model>] [--yolo | --draft]
 *                               [--experimental] [--browser <path>] [--resume <run_id>]
 *
 * Production runs attach the one per-user Agent Core: the current folder is granted through
 * native project.grant, then session.create/session.input run there and this command follows
 * the durable session journal to its terminal outcome. Ctrl-C sends session.cancel; closing or
 * detaching never cancels. Without --yolo nothing is published; YOLO quota is Core/orchestrator's.
 *
 * Callers that inject provider/deploy/playtest/upload keep the historical in-process
 * orchestrator (library and fixture seam).
 * @param {string[]} args
 * @param {{cwd?: string, signal?: AbortSignal, stdin?: object, stdout?: object, stderr?: object,
 *   provider?: object, deploy?: object, playtest?: object, upload?: Function, onEvent?: Function,
 *   interactive?: boolean, core?: object, coreClient?: object}} context
 */
export default async function agent(args = [], context = {}) {
  if (!usesLegacyAgentContext(context)) return runAgentThroughCore(args, context);
  const options = parseAgentArgs(args);
  return withInterrupt(context, signal => {
    const ctx = { stdin: process.stdin, stderr: process.stderr, ...context, signal };
    return options.resume ? resumeGameAgent(options, ctx) : runGameAgent(options, ctx);
  });
}
