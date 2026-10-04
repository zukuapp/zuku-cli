import { parseArgs } from '../lib/provider-system/args.mjs';
import { CommandError } from '../lib/errors.mjs';
import { promptContext } from '../lib/provider-system/command-context.mjs';
import { isInteractive, askLine, askSecret } from '../lib/provider-system/prompt.mjs';
import { createStudioHostContext } from '../lib/studio-context.mjs';
import { createBrowserAdapter } from '../lib/browser-adapter/server.mjs';
import { ADAPTER_PORT, ADAPTER_ORIGIN } from '../lib/browser-adapter/protocol.mjs';
import { createNativePrompter, cliError } from '../lib/cli-core-runtime.mjs';

const FLAGS = { '--port': 'string' };
const untilAborted = signal => new Promise(resolve => { if (!signal || signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });

/**
 * zuku|zukujs studio [--port <n>]
 * Starts the local Browser Adapter for the official local browser frontend (ADAPTER_ORIGIN)
 * on 127.0.0.1, backed by the same Agent Core. Pairing, resume and browser-requested auth are
 * approved only on this terminal. Ctrl-C closes the adapter; Core sessions are never cancelled.
 */
export default async function studio(args = [], context = {}) {
  const options = parseArgs(args, { flags: FLAGS });
  const port = options.port === undefined ? ADAPTER_PORT : Number(options.port);
  if (options.port !== undefined && !/^\d{1,5}$/.test(options.port) || !Number.isInteger(port) || port > 65535) throw new CommandError('INVALID_INPUT');
  const pctx = promptContext(context), stderr = pctx.stderr, interactive = isInteractive(pctx);
  // One terminal question at a time; non-interactive runs deny every approval.
  let queue = Promise.resolve();
  const confirm = (question, signal) => {
    if (!interactive) return Promise.resolve(false);
    const work = queue.then(async () => /^y/i.test(await askLine({ ...pctx, signal: signal ?? pctx.signal }, question, { validate: value => /^(y|n|yes|no)$/i.test(value), fallback: 'n' })));
    queue = work.catch(() => {}); return work.catch(() => false);
  };
  let host, adapter;
  try {
    try { host = await createStudioHostContext({ ...(context.core ?? {}), ...(context.coreClient ? { coreClient: context.coreClient } : {}), signal: context.signal }); } catch (error) { throw cliError(error); }
    const prompter = createNativePrompter({ stderr, environment: context.environment ?? process.env,
      secret: interactive ? (prompt, { signal }) => askSecret({ ...pctx, signal: signal ?? pctx.signal }, '값을 입력하세요 (표시되지 않음): ') : undefined,
      decide: (prompt, { signal }) => confirm(`${prompt.providerId} ${prompt.purpose === 'logout' ? '로그아웃' : '로그인'}을 승인할까요? [y/N] `, signal) });
    let authPrompts = true;
    try { await host.setNativePrompter(prompter.callback); } catch (error) {
      if (error?.code !== 'NATIVE_PROMPTER_BUSY') throw cliError(error);
      authPrompts = false; stderr.write('다른 CLI·Studio가 인증 입력을 담당하고 있어 브라우저 인증 요청은 그쪽에서 승인합니다.\n');
    }
    try {
      adapter = await createBrowserAdapter({ host: host.adapterHost, port,
        approvePairing: ({ origin, signal }) => confirm(`${origin} 브라우저 연결을 승인할까요? [y/N] `, signal),
        approveResume: ({ origin, signal }) => confirm(`${origin}에서 기존 세션을 이어받을까요? [y/N] `, signal) });
    } catch { throw new CommandError('COMMAND_FAILED'); }
    stderr.write(`ZUKU 로컬 어댑터: ${adapter.origin}\n공식 로컬 브라우저 화면: ${ADAPTER_ORIGIN} (원격 클라우드 실행은 정해지지 않았습니다)\n종료: Ctrl+C\n`);
    await untilAborted(context.signal);
    return { status: 'stopped', origin: adapter.origin, frontend: ADAPTER_ORIGIN, authPrompts };
  } finally { await adapter?.close().catch(() => {}); await host?.close().catch(() => {}); }
}
