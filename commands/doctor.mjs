import { CommandError } from '../lib/errors.mjs';
import { identity, cliVersion } from '../lib/identity.mjs';
import { ADAPTER_PORT, ADAPTER_ORIGIN } from '../lib/browser-adapter/protocol.mjs';
import { openCore, isZukuGame } from '../lib/cli-core-runtime.mjs';

const safeCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'COMMAND_FAILED';

/**
 * zuku|zukujs doctor [--no-start]
 * Read-only health report of the one shared runtime: CLI identity (both aliases), Agent Core
 * (attach, or autostart unless --no-start), active provider/model and auth status metadata,
 * framework availability and the current folder's classification. Never prints credentials.
 */
export default async function doctor(args = [], context = {}) {
  if (args.some(arg => !['--json', '--no-start'].includes(arg)) || args.filter(arg => arg === '--no-start').length > 1) throw new CommandError('INVALID_INPUT');
  const cwd = context.cwd ?? process.cwd();
  const data = {
    cli: { runtime: identity.name, version: identity.version, cli_version: cliVersion, command_protocol: identity.command_protocol, aliases: ['zuku', 'zukujs'], shared_state: true },
    core: { status: 'unknown' },
    frontend: { local_browser: ADAPTER_ORIGIN, adapter: `http://127.0.0.1:${ADAPTER_PORT}`, remote_cloud_execution: 'unspecified' },
  };
  let core;
  try {
    core = context.coreHandle ?? await openCore({ ...context, core: { ...(context.core ?? {}), ...(args.includes('--no-start') ? { autostart: false } : {}) } });
    const hello = await core.call('hello');
    data.core = { status: hello.status ?? 'ready', product: hello.product, protocol_version: hello.protocolVersion, agent_version: hello.agentVersion };
    const providers = await core.call('provider.list');
    const auth = (await core.call('auth.list')).auth.find(row => row.provider === providers.activeProvider);
    data.provider = { active: providers.activeProvider, model: providers.activeModel, auth: auth ? { method: auth.method?.id ?? null, status: auth.status, official: auth.method?.official === true, experimental: auth.method?.experimental === true } : null };
    data.projects = { granted: (await core.call('project.list')).projects.length };
  } catch (error) { data.core = { status: 'unavailable', code: safeCode(error) }; }
  finally { if (core && !context.coreHandle) core.close(); }
  try { const { frameworkEntry } = await import('../lib/framework-command.mjs'); await frameworkEntry(cwd); data.framework = { available: true }; }
  catch { data.framework = { available: false }; }
  data.workspace = { zuku_game: await isZukuGame(cwd, { signal: context.signal }) };
  return data;
}
