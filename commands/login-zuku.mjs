import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_BASE_URL } from '../lib/api-client.mjs';
import { accountClient, readTokens, readIdentity, GAME_SCOPES, NATIVE_GAME_SCOPE } from '../lib/accounts/client.mjs';
import { saveZukuAccount, captureZukuAccountGeneration } from '../lib/accounts/store.mjs';
import { AccountError } from '../lib/accounts/errors.mjs';

const USER_CODE = /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/;
const VERIFY_URI = 'https://www.zuzunza.com/oauth/device';
const DEVICE_CODE = /^zuku_od_[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
async function browser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
}
/** Browser approval is the only interactive step. Passwords and bearer values never enter CLI output. */
export async function runLoginZuku(args = [], context = {}) {
  if (!Array.isArray(args) || args.some(arg => !['--no-browser', '--generate'].includes(arg)) || new Set(args).size !== args.length) throw new AccountError('INVALID_INPUT');
  const { baseUrl = DEFAULT_BASE_URL, accountClientFactory = accountClient, signal, onDeviceCode, openBrowser = browser, sleep = (ms, signal) => delay(ms, undefined, { signal }), now = Date.now, accountStoreOptions = {} } = context;
  if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
  const expectedGeneration = await captureZukuAccountGeneration(accountStoreOptions);
  const requestedScopes = [...GAME_SCOPES, ...(args.includes('--generate') ? [NATIVE_GAME_SCOPE] : [])];
  const client = await accountClientFactory(baseUrl, { signal, requestedScopes }); const started = now(); const result = await client.device(); const d = result?.data;
  if (result?.status !== 200 || !record(d) || !DEVICE_CODE.test(d.device_code) || !USER_CODE.test(d.user_code) || d.verification_uri !== VERIFY_URI || d.verification_uri_complete !== `${VERIFY_URI}?user_code=${d.user_code}` || !Number.isSafeInteger(d.expires_in) || d.expires_in < 1 || d.expires_in > 900 || !Number.isSafeInteger(d.interval) || d.interval < 5 || d.interval > 60) throw new AccountError(result?.status === 404 || result?.status === 501 ? 'ZUKU_AUTH_UNAVAILABLE' : 'ZUKU_AUTH_RESPONSE_INVALID');
  // Device secret stays in this closure; user-facing callback receives only the
  // short verification code and official approval URL, never device/bearer tokens.
  await onDeviceCode?.({ user_code: d.user_code, verification_uri: d.verification_uri, verification_uri_complete: d.verification_uri_complete, expires_in: d.expires_in });
  let browserOpened = false;
  if (!args.includes('--no-browser')) { try { await openBrowser(d.verification_uri_complete); browserOpened = true; } catch { /* The printed official URL remains usable. */ } }
  let interval = d.interval; const deadline = started + d.expires_in * 1000;
  while (now() < deadline) {
    if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
    try { await sleep(Math.min(interval * 1000, deadline - now()), signal); } catch { throw new AccountError(signal?.aborted ? 'COMMAND_CANCELLED' : 'ZUKU_AUTH_UNAVAILABLE'); }
    if (now() >= deadline) break;
    const polled = await client.poll(d.device_code);
    if (polled.status === 200) {
      const tokens = readTokens(polled, now(), requestedScopes); const authenticated = await accountClientFactory(baseUrl, { accessToken: tokens.access_token, signal }); const me = await authenticated.me();
      const user = readIdentity(me, tokens.scope);
      await saveZukuAccount(tokens, { ...accountStoreOptions, expectedGeneration, signal });
      return { status: 'connected', provider: 'zuku', account: { id: user.id, handle: user.handle }, scopes: tokens.scope.split(' '), browser_opened: browserOpened };
    }
    if (polled.status !== 400 || !record(polled.data)) throw new AccountError('ZUKU_AUTH_UNAVAILABLE');
    if (polled.data.error === 'authorization_pending') continue;
    if (polled.data.error === 'slow_down') { interval += 5; continue; }
    if (polled.data.error === 'access_denied') throw new AccountError('ZUKU_AUTH_DENIED');
    if (polled.data.error === 'expired_token') throw new AccountError('ZUKU_AUTH_EXPIRED');
    throw new AccountError('ZUKU_AUTH_UNAVAILABLE');
  }
  throw new AccountError('ZUKU_AUTH_EXPIRED');
}
export default runLoginZuku;
