import { parseArgs } from '../lib/provider-system/args.mjs';
import { invalidInput, ProviderError } from '../lib/provider-system/errors.mjs';
import { promptContext } from '../lib/provider-system/command-context.mjs';
import { isInteractive, askLine, askChoice, askSecret, readSecretFromStdin } from '../lib/provider-system/prompt.mjs';
import { validProviderId, validModelId } from '../lib/provider-system/address.mjs';
import { validateEndpoint, HEADER_NAME, ENV_NAME } from '../lib/provider-system/endpoint.mjs';
import { CUSTOM_API_TYPES, normalizeApiType } from '../lib/provider-system/catalog.mjs';
import { hasSecret, PROVIDER_OPTION_ALIASES, PROVIDER_OPTION_CHECKS, normalizeProviderOptions } from '../lib/agent-protocol/schema.mjs';
import { providerRuntimeFor, createNativePrompter, requestAuth, methodKind } from '../lib/cli-core-runtime.mjs';

// Canonical API types; legacy spellings (anthropic-messages) normalize through the catalog.
const API_TYPE_LABELS = Object.freeze({ 'openai-chat': 'OpenAI Chat Completions compatible', 'openai-responses': 'OpenAI Responses compatible', anthropic: 'Anthropic Messages compatible' });
const ADD_FLAGS = { '--id': 'string', '--name': 'string', '--type': 'string', '--base-url': 'string', '--model': 'list', '--api-key-env': 'string', '--api-key-stdin': 'boolean', '--header-env': 'list', '--header-secret': 'list', '--option': 'list', '--disabled': 'boolean', '--non-interactive': 'boolean' };
const CONFIGURE_FLAGS = { '--name': 'string', '--type': 'string', '--base-url': 'string', '--model': 'list', '--remove-model': 'list', '--default-model': 'string', '--region': 'string', '--project': 'string', '--location': 'string', '--option': 'list', '--api-key-env': 'string', '--clear-api-key-env': 'boolean', '--header-env': 'list', '--header-secret': 'list', '--remove-header': 'list' };
const OPTION_KEYS = new Set([...Object.keys(PROVIDER_OPTION_CHECKS), ...Object.keys(PROVIDER_OPTION_ALIASES), 'model']);

const apiType = value => value === undefined ? undefined : normalizeApiType(value);

function parseOptions(list = [], flags = {}) {
  const out = { options: {} };
  for (const [key, value] of Object.entries(flags)) if (value !== undefined) out.options[key] = value;
  for (const item of list) {
    const eq = item.indexOf('=');
    const input = item.slice(0, eq), key = PROVIDER_OPTION_ALIASES[input] ?? input, value = item.slice(eq + 1);
    if (eq < 1 || !OPTION_KEYS.has(input) || Object.hasOwn(out.options, key) || (key === 'model' && out.model !== undefined)) throw invalidInput();
    if (hasSecret(value)) throw new ProviderError('AUTH_SECRET_ARGUMENT');
    if (key === 'model') { if (!validModelId(value)) throw new ProviderError('MODEL_ADDRESS_INVALID'); out.model = value; continue; }
    const typed = key === 'maxOutputTokens' && /^[1-9][0-9]*$/.test(value) ? Number(value) : key === 'allowLoopbackHttp' && /^(true|false)$/.test(value) ? value === 'true' : value;
    try { out.options[key] = normalizeProviderOptions({ [key]: typed })[key]; } catch { throw invalidInput(); }
  }
  return out;
}

function headerRefs({ headerEnv = [], headerSecret = [] }) {
  const refs = {};
  for (const item of headerEnv) {
    const eq = item.indexOf('=');
    const name = item.slice(0, eq), env = item.slice(eq + 1);
    if (eq < 1 || !HEADER_NAME.test(name) || !ENV_NAME.test(env) || refs[name]) throw invalidInput();
    refs[name] = { source: 'env', env };
  }
  for (const name of headerSecret) { if (!HEADER_NAME.test(name) || refs[name]) throw invalidInput(); refs[name] = { source: 'secret' }; }
  return refs;
}

async function pickProvider(runtime, ctx, title) {
  const rows = (await runtime.listProviders()).filter(row => row.enabled);
  return askChoice(promptContext(ctx), title, rows.map(row => ({ label: `${row.name} (${row.id})${row.active ? ' ●' : ''}`, value: row.id })));
}

/** Stores secrets: directly in the legacy runtime, or through Core's native auth sideband. */
async function storeSecrets(runtime, id, { apiKey, headers }, ctx) {
  if (!runtime.core) return runtime.authLogin(id, { ...(apiKey ? { apiKey } : {}), ...(headers ? { headers } : {}) });
  const method = runtime.providers.authMethods(id).find(item => methodKind(item) === 'secret');
  if (!method) throw new ProviderError('AUTH_METHOD_UNSUPPORTED');
  const pctx = promptContext(ctx);
  const prompter = createNativePrompter({ stderr: pctx.stderr, secret: async prompt => prompt.headerName ? headers?.[prompt.headerName] : apiKey });
  // The user is registering this custom endpoint in this native command; its (exp!) label is shown.
  await requestAuth(runtime.core, { providerId: id, methodId: method.id, experimental: method.experimental === true && runtime.providers.get(id).custom === true, ...(headers ? { headerNames: Object.keys(headers), includeApiKey: Boolean(apiKey) } : {}), prompter, signal: ctx.signal });
}

async function add(runtime, options, ctx) {
  const pctx = promptContext(ctx);
  const interactive = !options.nonInteractive && isInteractive(pctx);
  let { id, name, baseUrl } = options;
  let type = apiType(options.type);
  const extra = parseOptions(options.option);
  let models = [...(extra.model !== undefined ? [extra.model] : []), ...(options.model ?? [])];
  if (!type && interactive) type = await askChoice(pctx, 'Provider type:', CUSTOM_API_TYPES.map(value => ({ label: API_TYPE_LABELS[value] ?? value, value })));
  if (!name && interactive) name = await askLine(pctx, 'Name: ', { validate: value => /^[\x20-\x7e]{1,64}$/.test(value) });
  if (!id && interactive) id = await askLine(pctx, 'Provider ID (소문자·숫자·-): ', { validate: validProviderId });
  if (!baseUrl && interactive) baseUrl = await askLine(pctx, 'Base URL: ', { validate: value => { try { validateEndpoint(value); return true; } catch { return false; } } });
  if (!models.length && interactive) models = [await askLine(pctx, 'Model: ', { validate: validModelId })];
  if (!id || !type || !baseUrl || !CUSTOM_API_TYPES.includes(type) || !models.every(validModelId)) throw invalidInput();
  const headers = headerRefs(options);
  const optionPatch = Object.keys(extra.options).length ? { options: extra.options } : undefined;
  // Validate transport expressibility before any configuration is written.
  if (optionPatch) runtime.checkPatch?.({ apiType: type, ...optionPatch });
  const result = await runtime.addProvider({ id, name: name ?? id, apiType: type, baseUrl, model: models[0], apiKeyEnv: options.apiKeyEnv, headers: Object.keys(headers).length ? headers : undefined, ...(optionPatch ?? {}), enabled: options.disabled ? false : undefined });
  if (models.length > 1) await runtime.configureProvider(id, { addModels: models.slice(1).map(model => ({ id: model })) });
  let apiKey;
  if (options.apiKeyStdin) apiKey = await readSecretFromStdin(pctx);
  else if (interactive && !options.apiKeyEnv) {
    const wants = await askLine(pctx, 'API 키를 지금 안전 저장소에 저장할까요? [y/N] ', { validate: value => /^(y|n|yes|no)$/i.test(value), fallback: 'n' });
    if (/^y/i.test(wants)) apiKey = await askSecret(pctx, 'API key (입력 내용은 표시되지 않습니다): ');
  }
  const secretHeaders = {};
  if (interactive) for (const name of options.headerSecret ?? []) secretHeaders[name] = await askSecret(pctx, `${name} 값 (표시되지 않음): `);
  try { if (apiKey || Object.keys(secretHeaders).length) await storeSecrets(runtime, id, { apiKey, headers: Object.keys(secretHeaders).length ? secretHeaders : undefined }, ctx); }
  finally { apiKey = undefined; }
  return (await runtime.listProviders()).find(row => row.id === result.id);
}

function configurePatch(options) {
  const patch = {};
  if (options.baseUrl !== undefined) patch.baseUrl = options.baseUrl;
  if (options.name !== undefined) patch.name = options.name;
  if (options.type !== undefined) patch.apiType = apiType(options.type);
  const extra = parseOptions(options.option, { region: options.region, project: options.project, location: options.location });
  const added = [...(options.model ?? [])];
  if (added.length) patch.addModels = added.map(id => { if (!validModelId(id)) throw new ProviderError('MODEL_ADDRESS_INVALID'); return { id }; });
  if (options.removeModel) patch.removeModels = options.removeModel;
  if (extra.model !== undefined && options.defaultModel !== undefined) throw invalidInput();
  if (options.defaultModel !== undefined || extra.model !== undefined) patch.defaultModel = options.defaultModel ?? extra.model;
  if (Object.keys(extra.options).length) patch.options = extra.options;
  if (options.apiKeyEnv !== undefined && options.clearApiKeyEnv) throw invalidInput();
  if (options.apiKeyEnv !== undefined) patch.apiKeyEnv = options.apiKeyEnv;
  if (options.clearApiKeyEnv) patch.apiKeyEnv = null;
  const headers = headerRefs(options);
  for (const name of options.removeHeader ?? []) { if (!HEADER_NAME.test(name) || headers[name]) throw invalidInput(); headers[name] = null; }
  if (Object.keys(headers).length) patch.headers = headers;
  return patch;
}

/**
 * zuku|zukujs provider [list|show|use|add|remove|configure|enable|disable] ...
 * Returns projected data only (no credentials); root renders JSON or plain text.
 * Production mutations go through Agent Core's versioned dispatch.
 */
export default async function provider(args = [], ctx = {}) {
  const [sub = 'list', ...rest] = args.filter(arg => arg !== '--json');
  const { runtime, close } = await providerRuntimeFor(ctx);
  try { return await dispatch(sub, rest, runtime, ctx); } finally { close(); }
}

async function dispatch(sub, rest, runtime, ctx) {
  const pctx = promptContext(ctx);
  switch (sub) {
    case 'list': { parseArgs(rest); return runtime.listProviders(); }
    case 'show': {
      const { _: [id] } = parseArgs(rest, { positionals: 1 });
      if (!id) throw invalidInput();
      runtime.providers.get(id);
      return (await runtime.listProviders()).find(row => row.id === id);
    }
    case 'use': {
      const { _: [given] } = parseArgs(rest, { positionals: 1 });
      const id = given ?? (isInteractive(pctx) ? await pickProvider(runtime, ctx, 'ZUKU Provider Configuration') : undefined);
      if (!id) throw invalidInput();
      return runtime.useProvider(id);
    }
    case 'add': return add(runtime, parseArgs(rest, { flags: ADD_FLAGS }), ctx);
    case 'remove': {
      const options = parseArgs(rest, { flags: { '--yes': 'boolean' }, positionals: 1 });
      const id = options._[0];
      if (!id) throw invalidInput();
      runtime.providers.get(id);
      if (!options.yes) {
        if (!isInteractive(pctx)) throw invalidInput();
        const answer = await askLine(pctx, `${id} 제공자와 저장된 키를 삭제할까요? [y/N] `, { validate: value => /^(y|n|yes|no)$/i.test(value), fallback: 'n' });
        if (!/^y/i.test(answer)) return { removed: null, cancelled: true };
      }
      return runtime.removeProvider(id);
    }
    case 'configure': {
      const options = parseArgs(rest, { flags: CONFIGURE_FLAGS, positionals: 1 });
      const patch = configurePatch(options);
      const id = options._[0] ?? (isInteractive(pctx) ? await pickProvider(runtime, ctx, 'Provider:') : undefined);
      if (!id) throw invalidInput();
      if (!Object.keys(patch).length) throw invalidInput();
      return runtime.configureProvider(id, patch);
    }
    case 'enable': case 'disable': {
      const { _: [id] } = parseArgs(rest, { positionals: 1 });
      if (!id) throw invalidInput();
      return runtime.setEnabled(id, sub === 'enable');
    }
    default: throw invalidInput();
  }
}
