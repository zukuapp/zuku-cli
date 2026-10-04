// Lazy loader for the official cloud SDKs. Only these exact packages may be
// loaded, and only when the adapter that needs them is used.
import { AdapterError } from './errors.mjs';

export const SDK_PACKAGES = Object.freeze({
  '@aws-sdk/client-bedrock-runtime': '3.1146.0',
  '@aws-sdk/client-bedrock': '3.1146.0',
  'google-auth-library': '11.1.0',
});

const cache = new Map();

/** context.importModule(name) is a test/bundler seam; default is a dynamic import. */
export async function loadSdk(context, name) {
  if (!Object.hasOwn(SDK_PACKAGES, name)) throw new AdapterError('ADAPTER_SDK_UNAVAILABLE');
  const load = typeof context.importModule === 'function' ? context.importModule : undefined;
  if (!load && cache.has(name)) return cache.get(name);
  let module;
  try { module = await (load ? load(name) : import(name)); } catch { throw new AdapterError('ADAPTER_SDK_UNAVAILABLE'); }
  if (!module || typeof module !== 'object') throw new AdapterError('ADAPTER_SDK_UNAVAILABLE');
  // CommonJS builds may surface their exports on `default` only.
  const namespace = module.default && typeof module.default === 'object' ? { ...module.default, ...module } : module;
  if (!load) cache.set(name, namespace);
  return namespace;
}

/** Await a promise that cannot itself be aborted, but stop waiting on abort. */
export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AdapterError('COMMAND_CANCELLED'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new AdapterError('COMMAND_CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
