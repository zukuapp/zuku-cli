import { parseArgs } from '../lib/provider-system/args.mjs';
import { CommandError } from '../lib/errors.mjs';
import { createStudioPreview } from '../lib/studio-preview.mjs';
import { openCore, grantProject, cliError } from '../lib/cli-core-runtime.mjs';

const FLAGS = { '--port': 'string', '--once': 'boolean' };
const untilAborted = signal => new Promise(resolve => { if (!signal || signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });

/**
 * zuku|zukujs run [--port <n>] [--once]
 * Asks Agent Core for a read-only snapshot preview (`game.run`) of the ZUKU game in this folder
 * and serves it on 127.0.0.1 until Ctrl-C. `--once` returns the preview metadata only.
 */
export default async function run(args = [], context = {}) {
  const options = parseArgs(args, { flags: FLAGS });
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!/^\d{1,5}$/.test(options.port ?? '0') || !Number.isInteger(port) || port > 65535) throw new CommandError('INVALID_INPUT');
  const stderr = context.stderr ?? process.stderr;
  const core = context.coreHandle ?? await openCore(context);
  let preview;
  try {
    const project = await grantProject(core, { cwd: context.cwd ?? process.cwd(), purpose: 'game.maintain' });
    const snapshot = await core.call('game.run', { projectHandle: project.projectHandle });
    const data = { projectHandle: project.projectHandle, previewHandle: snapshot.previewHandle, version: snapshot.version, entry: snapshot.entry, sourceSha256: snapshot.sourceSha256 };
    if (options.once) return data;
    try { preview = await createStudioPreview({ dispatchNative: (method, params) => core.call(method, params), port }); } catch (error) { throw cliError(error); }
    const { url } = await preview.resolve(snapshot.previewHandle);
    stderr.write(`게임 미리보기: ${url}\n종료: Ctrl+C\n`);
    await untilAborted(context.signal);
    return { ...data, url, stopped: true };
  } finally { await preview?.close().catch(() => {}); if (!context.coreHandle) core.close(); }
}
