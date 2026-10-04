import { parseArgs } from '../lib/provider-system/args.mjs';
import { invalidInput } from '../lib/provider-system/errors.mjs';
import { promptContext } from '../lib/provider-system/command-context.mjs';
import { isInteractive, askChoice } from '../lib/provider-system/prompt.mjs';
import { providerRuntimeFor, normalizeModelAddress } from '../lib/cli-core-runtime.mjs';

/**
 * zuku|zukujs model [list|use|info|refresh|current] ...
 * Addresses are <provider>/<model>; only the FIRST slash splits (openrouter/vendor/model).
 * Discovery and its cache stay in the existing model registry behind Agent Core.
 */
export default async function model(args = [], ctx = {}) {
  const [sub = 'list', ...rest] = args.filter(arg => arg !== '--json');
  const { runtime, close } = await providerRuntimeFor(ctx);
  try { return await dispatch(sub, rest, runtime, ctx); } finally { close(); }
}

async function dispatch(sub, rest, runtime, ctx) {
  const signal = ctx.signal;
  switch (sub) {
    case 'list': {
      const options = parseArgs(rest, { flags: { '--provider': 'string', '--refresh': 'boolean' } });
      return runtime.listModels({ provider: options.provider, refresh: options.refresh === true, signal });
    }
    case 'refresh': {
      const options = parseArgs(rest, { flags: { '--provider': 'string' } });
      return runtime.listModels({ provider: options.provider, refresh: true, signal });
    }
    case 'current': {
      parseArgs(rest);
      return { provider: runtime.activeProvider, model: runtime.activeModel };
    }
    case 'use': {
      const options = parseArgs(rest, { flags: { '--provider': 'string' }, positionals: 1 });
      let address = options._[0];
      const pctx = promptContext(ctx);
      if (!address && isInteractive(pctx)) {
        const listing = await runtime.listModels({ provider: options.provider, signal });
        if (!listing.models.length) throw invalidInput();
        address = await askChoice(pctx, `Model (${listing.provider}):`, listing.models.slice(0, 200).map(item => ({ label: `${item.address}${item.name !== item.id ? ` — ${item.name}` : ''}`, value: item.address })));
      }
      if (!address) throw invalidInput();
      return runtime.useModel(normalizeModelAddress(address, { provider: options.provider }), { signal });
    }
    case 'info': {
      const options = parseArgs(rest, { flags: { '--refresh': 'boolean' }, positionals: 1 });
      const address = options._[0] ? normalizeModelAddress(options._[0], { provider: options._[0].includes('/') ? undefined : runtime.activeProvider }) : runtime.activeModel;
      if (!address) throw invalidInput();
      return runtime.modelInfo(address, { signal, refresh: options.refresh === true });
    }
    default: throw invalidInput();
  }
}
