import { CommandError } from '../lib/errors.mjs';
import { loadZukuAccount, removeZukuAccount } from '../lib/accounts/store.mjs';
import { accountClient } from '../lib/accounts/client.mjs';

export default async function account(args = [], context = {}) {
  if (args.length === 1 && args[0] === 'logout') {
    const options = context.accountStoreOptions ?? {};
    let stored;
    try { stored = await loadZukuAccount(options); } catch (error) { if (error?.code !== 'ZUKU_ACCOUNT_MIGRATION_REQUIRED') throw error; }
    // Local logout commits first, even if the network is unavailable. An
    // in-flight refresh/login cannot restore this generation afterward.
    await removeZukuAccount(options);
    let revoked = false;
    if (stored && !context.signal?.aborted) {
      try { const client = await (context.accountClientFactory ?? accountClient)(context.baseUrl, { signal: context.signal }); const result = await client.revoke(stored.refresh_token); revoked = result?.status === 200; } catch { /* Local tombstone is authoritative for this installation. */ }
    }
    return { provider: 'zuku', connected: false, revoked };
  }
  if (args.length > 1 || args.some(arg => arg !== '--quota')) throw new CommandError('INVALID_INPUT');
  const stored = await (context.loadAccount ?? loadZukuAccount)(context.accountStoreOptions);
  const data = { provider: 'zuku', connected: Boolean(stored), scope: stored?.scope ?? null };
  if (args.includes('--quota')) {
    const { readDeployQuota } = await import('../lib/accounts/deploy-quota.mjs');
    data.quota = await (context.readQuota ?? readDeployQuota)(context);
  }
  return data;
}
