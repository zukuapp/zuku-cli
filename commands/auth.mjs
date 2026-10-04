import { parseArgs } from '../lib/provider-system/args.mjs';
import { invalidInput, ProviderError } from '../lib/provider-system/errors.mjs';
import { promptContext } from '../lib/provider-system/command-context.mjs';
import { isInteractive, askChoice, askLine, askSecret, readSecretFromStdin } from '../lib/provider-system/prompt.mjs';
import { authMethodLabel, colorEnabled } from '../lib/provider-system/render.mjs';
import { NATIVE_PROVIDER_ID } from '../lib/provider-system/catalog.mjs';
import { HEADER_NAME } from '../lib/provider-system/endpoint.mjs';
import { providerRuntimeFor, createNativePrompter, requestAuth, methodKind } from '../lib/cli-core-runtime.mjs';

const LOGIN_FLAGS = { '--provider': 'string', '--api-key-stdin': 'boolean', '--api-key-env': 'string', '--header': 'list', '--verify': 'boolean', '--experimental': 'boolean', '--no-browser': 'boolean' };

async function pickAuthProvider(runtime, ctx) {
  const pctx = promptContext(ctx);
  const rows = (await runtime.listProviders()).filter(row => row.enabled);
  const color = colorEnabled({ stream: pctx.stderr, environment: ctx.environment ?? process.env });
  // Method labels derive (exp!) from metadata only.
  return askChoice(pctx, 'Authentication', rows.map(row => ({ label: `${row.name} — ${row.authMethods.map(method => authMethodLabel(method, { color, experimental: runtime.experimental })).join(', ')}`, value: row.id })));
}

async function login(runtime, options, ctx) {
  const pctx = promptContext(ctx);
  const interactive = isInteractive(pctx);
  let id = options.provider;
  if (!id && interactive) id = await pickAuthProvider(runtime, ctx);
  id ??= NATIVE_PROVIDER_ID; // mirrors `zukujs login` (defaults to zuku)
  const methods = runtime.providers.authMethods(id);
  if (methods.some(method => method.delegate)) {
    if (options.apiKeyStdin || options.apiKeyEnv || options.header) throw invalidInput();
    const args = options.noBrowser ? ['--no-browser'] : [];
    const stderr = pctx.stderr;
    // Same device-code notice as the original `login zuku` command.
    const commandContext = { cwd: ctx.cwd, signal: ctx.signal, stderr, onDeviceCode: code => stderr.write(`ZUKU 계정 연결: ${code.verification_uri_complete ?? code.verification_uri}\n승인 코드: ${code.user_code}\n`) };
    return runtime.authLogin(id, { experimental: options.experimental === true, args, commandContext });
  }
  if (options.noBrowser || options.experimental) throw invalidInput();
  const headerNames = options.header ?? [];
  if (!headerNames.every(name => HEADER_NAME.test(name))) throw invalidInput();
  if (options.apiKeyEnv !== undefined) {
    if (options.apiKeyStdin || headerNames.length) throw invalidInput();
    return runtime.authLogin(id, { apiKeyEnv: options.apiKeyEnv });
  }
  const keyMethod = methods.find(method => method.storage === 'secure-store');
  const request = {};
  if (options.apiKeyStdin) {
    // One pipe carries exactly one secret.
    if (headerNames.length) throw invalidInput();
    request.apiKey = await readSecretFromStdin(pctx);
  } else if (interactive) {
    if (keyMethod && !headerNames.length) request.apiKey = await askSecret(pctx, `${keyMethod.name} (입력 내용은 표시되지 않습니다): `);
    if (headerNames.length) {
      request.headers = {};
      for (const name of headerNames) request.headers[name] = await askSecret(pctx, `${name} 값 (표시되지 않음): `);
    }
  } else if (keyMethod) throw new ProviderError('AUTH_INPUT_REQUIRED');
  if (!keyMethod && request.apiKey !== undefined) throw new ProviderError('AUTH_METHOD_UNSUPPORTED');
  return runtime.authLogin(id, { ...request, verify: options.verify === true });
}

/**
 * Agent Core login: auth.request + native prompter. Secrets are read here (hidden TTY or one
 * stdin line) and leave this process only on Core's native-only sideband.
 */
async function coreLogin(runtime, options, ctx) {
  const core = runtime.core, pctx = promptContext(ctx), interactive = isInteractive(pctx);
  const environment = ctx.environment ?? process.env;
  const headerNames = options.header ?? [];
  if (!headerNames.every(name => HEADER_NAME.test(name))) throw invalidInput();
  let id = options.provider;
  if (!id && interactive) id = await pickAuthProvider(runtime, ctx);
  id ??= NATIVE_PROVIDER_ID;
  const row = runtime.providers.get(id), methods = row.authMethods ?? [];
  const delegated = methods.find(method => methodKind(method) === 'delegate');
  const status = async () => (await runtime.authList()).find(item => item.provider === id);
  if (delegated) {
    if (options.apiKeyStdin || options.apiKeyEnv || options.header || options.verify) throw invalidInput();
    const prompter = createNativePrompter({ stderr: pctx.stderr, environment, noBrowser: options.noBrowser === true });
    // Experimental methods (Codex) require the explicit --experimental opt-in; Core enforces it.
    await requestAuth(core, { providerId: id, methodId: delegated.id, experimental: options.experimental === true, prompter, signal: ctx.signal });
    return { provider: id, method: delegated, status: 'delegated', authStatus: (await status())?.status ?? 'unknown' };
  }
  if (options.noBrowser || options.experimental) throw invalidInput();
  if (headerNames.length && (!interactive || options.apiKeyStdin || options.apiKeyEnv)) throw new ProviderError('AUTH_INPUT_REQUIRED');
  if (options.apiKeyEnv !== undefined) {
    if (options.apiKeyStdin || options.verify) throw invalidInput();
    await runtime.configureProvider(id, { apiKeyEnv: options.apiKeyEnv });
    const method = methods.find(item => methodKind(item) === 'environment') ?? methods.find(item => methodKind(item) === 'secret');
    if (!method) throw new ProviderError('AUTH_METHOD_UNSUPPORTED');
    return { provider: id, method, status: (await status())?.status ?? 'unknown', envVar: options.apiKeyEnv };
  }
  const keyMethod = methods.find(item => methodKind(item) === 'secret');
  let secret;
  if (options.apiKeyStdin) secret = await readSecretFromStdin(pctx);
  else if (keyMethod && !headerNames.length && !interactive) throw new ProviderError('AUTH_INPUT_REQUIRED');
  if (!keyMethod && secret !== undefined) throw new ProviderError('AUTH_METHOD_UNSUPPORTED');
  const method = keyMethod ?? methods.find(item => methodKind(item) === 'passive') ?? methods[0];
  if (!method) throw new ProviderError('AUTH_METHOD_UNSUPPORTED');
  const prompter = createNativePrompter({ stderr: pctx.stderr, environment,
    secret: async (prompt, { signal }) => {
      if (secret !== undefined) { const value = secret; secret = undefined; return value; }
      return askSecret({ ...pctx, signal: signal ?? pctx.signal }, `${prompt.headerName ?? keyMethod?.name ?? 'Secret'} (입력 내용은 표시되지 않습니다): `);
    },
    decide: async () => /^y/i.test(await askLine(pctx, '진행할까요? [y/N] ', { validate: value => /^(y|n|yes|no)$/i.test(value), fallback: 'n' })),
  });
  // A user-registered custom endpoint is (exp!) by metadata; registering it here is the opt-in.
  let job;
  try { job = await requestAuth(core, { providerId: id, methodId: method.id, experimental: method.experimental === true && row.custom === true, ...(headerNames.length ? { headerNames } : {}), verify: options.verify === true, prompter, signal: ctx.signal }); }
  finally { secret = undefined; }
  if (keyMethod) return { provider: id, method: keyMethod, status: 'configured', storage: 'secure-store', ...(job.verified ? { verified: job.verified } : {}) };
  return { provider: id, method, status: (await status())?.status ?? 'unknown', ...(job.verified ? { verified: job.verified } : {}) };
}

/** zuku|zukujs auth [list|login|logout] [--provider <id>] — statuses only, never tokens. */
export default async function auth(args = [], ctx = {}) {
  const [sub = 'list', ...rest] = args.filter(arg => arg !== '--json');
  const { runtime, close } = await providerRuntimeFor(ctx);
  try {
    switch (sub) {
      case 'list': {
        const options = parseArgs(rest, { flags: { '--provider': 'string' } });
        const rows = await runtime.authList();
        if (options.provider) { runtime.providers.get(options.provider); return rows.filter(row => row.provider === options.provider); }
        return rows;
      }
      case 'login': { const options = parseArgs(rest, { flags: LOGIN_FLAGS }); return await (runtime.core ? coreLogin(runtime, options, ctx) : login(runtime, options, ctx)); }
      case 'logout': {
        const options = parseArgs(rest, { flags: { '--provider': 'string' } });
        return await runtime.authLogout(options.provider ?? NATIVE_PROVIDER_ID);
      }
      default: throw invalidInput();
    }
  } finally { close(); }
}
