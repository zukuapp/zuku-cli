import { ProviderError } from './errors.mjs';

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const CONTROL = /[\u0000- \u007f-\u009f\\]/;
export const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
// Transport-owned or credential-smuggling headers can never be user-configured.
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect', 'cookie', 'set-cookie', 'proxy-authorization', 'proxy-connection', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'origin', 'referer']);

export const isLoopbackUrl = url => url.protocol === 'http:' && LOOPBACK.has(url.hostname);

/**
 * Credential-bearing endpoints: https, or http only on loopback. No userinfo,
 * query, fragment, backslash, control characters, dot-segments or encoded
 * traversal. `hostSuffixes` pins vendor endpoints (e.g. Azure resources).
 */
export function validateEndpoint(value, { hostSuffixes, allowLoopback = true } = {}) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 2048 || CONTROL.test(value)) throw new ProviderError('PROVIDER_ENDPOINT_REJECTED');
  let url;
  try { url = new URL(value); } catch { throw new ProviderError('PROVIDER_ENDPOINT_REJECTED'); }
  if (url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#') || value.includes('@')) throw new ProviderError('PROVIDER_ENDPOINT_REJECTED');
  if (!(url.protocol === 'https:' || (allowLoopback && isLoopbackUrl(url)))) throw new ProviderError('PROVIDER_ENDPOINT_REJECTED');
  const raw = value.slice(value.indexOf('//') + 2);
  const rawPath = raw.includes('/') ? raw.slice(raw.indexOf('/')) : '';
  if (/%2e|%2f|%5c|%00/i.test(rawPath) || rawPath.split('/').some(segment => segment === '.' || segment === '..') || rawPath.includes('//')) throw new ProviderError('PROVIDER_ENDPOINT_REJECTED');
  // '.example.com' pins a subdomain; 'host.example.com' pins that exact host.
  if (hostSuffixes && !hostSuffixes.some(suffix => suffix.startsWith('.') ? url.hostname.endsWith(suffix) && url.hostname.length > suffix.length : url.hostname === suffix)) throw new ProviderError('PROVIDER_ENDPOINT_REJECTED');
  return url.href.replace(/\/+$/, '');
}

export function validateHeaderName(name) {
  if (typeof name !== 'string' || !HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) throw new ProviderError('PROVIDER_CONFIG_INVALID');
  return name;
}
/** Header values: visible ASCII + space/tab, no CR/LF, bounded. */
export const validHeaderValue = value => typeof value === 'string' && value.length >= 1 && value.length <= 8192 && /^[\x21-\x7e](?:[\x20-\x7e\t]*[\x21-\x7e])?$/.test(value);
export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
