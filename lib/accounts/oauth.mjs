import { accountClient, canonicalGameScopes, NATIVE_GAME_SCOPE, oauthAccessToken } from './client.mjs';
import { loadZukuAccount, readZukuAccessToken } from './store.mjs';
import { AccountError } from './errors.mjs';
import { DEFAULT_BASE_URL } from '../api-client.mjs';

/** Official protected game account only; no legacy environment/session lookup. */
export function createZukuAccountClient(options = {}) {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const storeOptions = { ...options.accountStoreOptions, ...(Object.hasOwn(options, 'home') ? { home: options.home } : {}) };
  const factory = options.accountClientFactory ?? ((origin, requestOptions) => accountClient(origin, { ...requestOptions, ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}), allowFixtureOrigin: options.allowFixtureOrigin === true }));
  return Object.freeze({
    async ensureFresh({ signal = options.signal, requiredScope = NATIVE_GAME_SCOPE } = {}) {
      if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
      if (requiredScope !== NATIVE_GAME_SCOPE) throw new AccountError('INVALID_INPUT');
      const before = await loadZukuAccount(storeOptions);
      if (!before) throw new AccountError('ZUKU_LOGIN_REQUIRED');
      if (!canonicalGameScopes(before.scope)?.split(' ').includes(requiredScope)) throw new AccountError('ZUKU_GENERATE_SCOPE_REQUIRED');
      const token = await readZukuAccessToken({ ...storeOptions, baseUrl, signal, accountClientFactory: factory });
      if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
      const current = await loadZukuAccount(storeOptions);
      if (!current || current.generation !== before.generation || current.access_token !== token) throw new AccountError('ZUKU_ACCOUNT_CHANGED');
      if (!oauthAccessToken(token) || !canonicalGameScopes(current.scope)?.split(' ').includes(requiredScope)) throw new AccountError('ZUKU_GENERATE_SCOPE_REQUIRED');
      return { accessToken: token, scope: current.scope, scopes: current.scope.split(' '), generation: current.generation };
    },
  });
}
