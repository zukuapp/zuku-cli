import { ProviderError } from './errors.mjs';

// Pattern adapted from Kilo Code `parseModel` (MIT, packages/opencode/src/provider/provider.ts
// @76bcfd40): split on the FIRST slash only so vendor/path model IDs survive.
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEGMENT = /^[A-Za-z0-9@_][A-Za-z0-9._:@+~=,-]{0,127}$/;
export const MAX_MODEL_ID_LENGTH = 256;

export const validProviderId = id => typeof id === 'string' && PROVIDER_ID_PATTERN.test(id);
/** Model IDs keep internal slashes (openrouter vendor/model). No control chars, spaces, `%`, `\`, `.`/`..` segments. */
export function validModelId(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > MAX_MODEL_ID_LENGTH) return false;
  return id.split('/').every(segment => SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}
export function parseModelAddress(address) {
  if (typeof address !== 'string' || address.length > 64 + 1 + MAX_MODEL_ID_LENGTH) throw new ProviderError('MODEL_ADDRESS_INVALID');
  const slash = address.indexOf('/');
  if (slash < 1) throw new ProviderError('MODEL_ADDRESS_INVALID');
  const provider = address.slice(0, slash);
  const model = address.slice(slash + 1);
  if (!validProviderId(provider) || !validModelId(model)) throw new ProviderError('MODEL_ADDRESS_INVALID');
  return Object.freeze({ provider, model, address: `${provider}/${model}` });
}
export function formatModelAddress(provider, model) {
  if (!validProviderId(provider) || !validModelId(model)) throw new ProviderError('MODEL_ADDRESS_INVALID');
  return `${provider}/${model}`;
}
