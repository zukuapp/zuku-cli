import { apiClient, DEFAULT_BASE_URL } from '../lib/api-client.mjs';
import { readAccessToken } from '../lib/credentials.mjs';
import { identity, cliVersion } from '../lib/identity.mjs';
import { CommandError } from '../lib/errors.mjs';

export default async function diagnostics({ checkApi = false, signal, credentials = readAccessToken, clientFactory = apiClient, accountClientFactory } = {}) {
  const token = await credentials({ signal });
  const data = { runtime: identity.name, version: identity.version, upstream: identity.upstream,
    command_protocol: identity.command_protocol, cli_version: cliVersion,
    api: { origin: DEFAULT_BASE_URL, checked: false },
    authentication: { configured: Boolean(token), status: 'not_checked' },
    capabilities: { readonly_diagnostics: true, project_create: true, project_validate: true, project_package: true, package_upload: true, service_keys: false } };
  if (!checkApi) return data;
  const client = await clientFactory(DEFAULT_BASE_URL, { accessToken: token, signal });
  const catalog = (await client.request('/billing/catalog')).data;
  if (!catalog || !Array.isArray(catalog.plans) || catalog.plans.length > 100 || !Array.isArray(catalog.cash) || catalog.cash.length > 100 || catalog.points?.purchasable !== false) throw new CommandError('API_RESPONSE_INVALID');
  data.api = { origin: DEFAULT_BASE_URL, checked: true, status: 'ready', plan_count: catalog.plans.length, cash_product_count: catalog.cash.length, points_purchasable: false };
  if (token) {
    const { oauthAccessToken, accountClient } = await import('../lib/accounts/client.mjs');
    let account;
    if (oauthAccessToken(token)) {
      const scoped = await (accountClientFactory ?? accountClient)(DEFAULT_BASE_URL, { accessToken: token, signal });
      const response = await scoped.me();
      if (response.status !== 200 || response.data?.success !== true) throw new CommandError(response.status === 401 ? 'UNAUTHORIZED' : 'API_RESPONSE_INVALID');
      account = response.data.data;
    } else account = (await client.request('/auth/me')).data;
    const id = account?.user?.id;
    if (!((typeof id === 'string' && /^usr_[1-9]\d*$/.test(id)) || (Number.isSafeInteger(id) && id > 0))) throw new CommandError('API_RESPONSE_INVALID');
    data.authentication.status = 'authenticated';
  } else data.authentication.status = 'anonymous';
  return data;
}
