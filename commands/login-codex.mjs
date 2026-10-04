import { createCodexOAuth } from '../lib/providers/codex-oauth.mjs';
import { ProviderError } from '../lib/provider-errors.mjs';
import { CODEX_AUTH_METHOD, renderAuthMethod } from '../lib/experimental.mjs';

export default async function loginCodex(args = [], { signal, stderr = process.stderr, oauth = createCodexOAuth(), experimental = false, onAuthorizationUrl } = {}) {
  let action = 'login', accountId, explicit = experimental === true, flagSeen = false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--experimental') { if (flagSeen) throw new ProviderError('CODEX_INPUT_INVALID'); flagSeen = true; explicit = true; }
    else if (a === '--account') { if (accountId !== undefined || !args[i + 1]) throw new ProviderError('CODEX_INPUT_INVALID'); accountId = args[++i]; }
    else if (a.startsWith('-')) throw new ProviderError('CODEX_INPUT_INVALID');
    else positional.push(a);
  }
  if (positional.length > 1 || positional.length && !['login', 'status', 'logout'].includes(positional[0])) throw new ProviderError('CODEX_INPUT_INVALID');
  if (positional.length) action = positional[0];
  if (action === 'status' && accountId !== undefined) throw new ProviderError('CODEX_INPUT_INVALID');
  stderr.write(`${renderAuthMethod(CODEX_AUTH_METHOD, { stream: stderr })}: Experimental · 비공식 Codex 연결입니다.\n`);
  if (action === 'status') return oauth.status({ experimental: true });
  if (action === 'logout') return oauth.logout({ experimental: true, accountId, signal });
  const state = await oauth.status({ experimental: true });
  if (!explicit && !state.experimentalAccepted) throw new ProviderError('CODEX_EXPERIMENTAL_REQUIRED');
  return oauth.login({ experimental: true, accountId, signal, onAuthorizationUrl: onAuthorizationUrl || (url => {
    // URLs contain only the PKCE challenge/state; retained ID-token hints are never added.
    stderr.write(`브라우저에서 Continue with ChatGPT를 진행하세요:\n${url}\n`);
  }) });
}
