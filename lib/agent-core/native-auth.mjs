import { randomBytes } from 'node:crypto';
import { validProviderHeaderRefs } from '../agent-protocol/schema.mjs';
import { ProtocolError, safeError } from '../agent-protocol/index.mjs';

const fail = code => { throw new ProtocolError(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const shape = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value);
const shortText = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 240 && !/[\x00-\x1f\x7f]/.test(value);

/** Authorization URLs are private native UI data, never Agent protocol events. */
export function nativeAuthorizationUrl(providerId, value) {
  if (typeof value !== 'string' || value.length > 8192) fail('INVALID_INPUT');
  let url; try { url = new URL(value); } catch { fail('INVALID_INPUT'); }
  if (url.username || url.password || url.hash || url.port || url.protocol !== 'https:') fail('INVALID_INPUT');
  if (providerId === 'zuku') {
    if (url.hostname !== 'www.zuzunza.com' || url.pathname !== '/oauth/device' || [...url.searchParams.keys()].some(key => key !== 'user_code') || url.searchParams.getAll('user_code').length > 1 || url.searchParams.has('user_code') && !/^[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}$/.test(url.searchParams.get('user_code'))) fail('INVALID_INPUT');
  } else if (providerId === 'codex') {
    if (url.hostname !== 'auth.openai.com' || url.pathname !== '/api/accounts/authorize') fail('INVALID_INPUT');
    const fields = ['client_id', 'ext_agent_host_id', 'response_type', 'redirect_uri', 'scope', 'resource', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'agent_name_hint'];
    if ([...url.searchParams.keys()].some(key => !fields.includes(key) || url.searchParams.getAll(key).length !== 1)) fail('INVALID_INPUT');
  } else fail('AUTH_METHOD_UNSUPPORTED');
  return url.href;
}

/** Closed native-only sideband. A renderer must never receive this protocol. */
export function validateNativePrompt(value) {
  if (!shape(value, ['id', 'kind', 'providerId', 'authMethodId', 'official', 'experimental', 'title', 'expiresAt', 'purpose', 'url', 'userCode', 'headerName']) || !identifier(value.id) || !identifier(value.providerId) || !identifier(value.authMethodId) || typeof value.official !== 'boolean' || typeof value.experimental !== 'boolean' || !shortText(value.title) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) fail('INVALID_INPUT');
  if (value.headerName !== undefined && (value.kind !== 'secret' || !validProviderHeaderRefs({ [value.headerName]: { source: 'secret' } }))) fail('INVALID_INPUT');
  if (!['secret', 'device-authorization', 'authorization-url', 'decision'].includes(value.kind)) fail('INVALID_INPUT');
  if (value.kind === 'decision') {
    if (!['login', 'logout'].includes(value.purpose) || value.url !== undefined || value.userCode !== undefined) fail('INVALID_INPUT');
  } else if (value.purpose !== undefined) fail('INVALID_INPUT');
  if (['device-authorization', 'authorization-url'].includes(value.kind)) nativeAuthorizationUrl(value.providerId, value.url);
  else if (value.url !== undefined) fail('INVALID_INPUT');
  if (value.kind === 'device-authorization') {
    if (value.providerId !== 'zuku' || !/^[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}$/.test(value.userCode)) fail('INVALID_INPUT');
  } else if (value.userCode !== undefined) fail('INVALID_INPUT');
  return value;
}
export function validateNativeReply(prompt, reply) {
  if (shape(reply, ['cancelled']) && reply.cancelled === true) return reply;
  if (prompt.kind === 'secret' && shape(reply, ['value']) && typeof reply.value === 'string' && /^[\x21-\x7e]{1,16384}$/.test(reply.value)) return reply;
  if (prompt.kind === 'decision' && shape(reply, ['approved']) && typeof reply.approved === 'boolean') return reply;
  if (['device-authorization', 'authorization-url'].includes(prompt.kind) && shape(reply, ['acknowledged']) && reply.acknowledged === true) return reply;
  fail('INVALID_INPUT');
}

const quiet = Object.freeze({ isTTY: false, write() { return true; } });
/** Core-owned jobs call the existing provider/account authentication implementation. */
export function createNativeAuthController({ getRuntime, openSession, changed }) {
  const jobs = new Map(); let closed = false;
  const view = job => ({ authRequestId: job.id, providerId: job.providerId, methodId: job.method.id, status: job.status, ...(job.code ? { code: job.code } : {}), ...(job.verified ? { verified: job.verified } : {}) });
  return Object.freeze({
    list(actor) { return [...jobs.values()].filter(job => actor.kind === 'native' || job.owner.kind === actor.kind && job.owner.id === actor.id).map(view); },
    async start(params, actor, { requestId, action = 'login' } = {}) {
      if (closed) fail('CORE_CLOSED');
      const duplicate = [...jobs.values()].find(job => job.owner.kind === actor.kind && job.owner.id === actor.id && job.requestId === requestId);
      if (duplicate) {
        if (duplicate.providerId !== params.providerId || duplicate.requestedMethod !== params.methodId || duplicate.experimental !== (params.experimental === true) || duplicate.action !== action || JSON.stringify(duplicate.headerNames) !== JSON.stringify(params.headerNames ?? []) || duplicate.verify !== (params.verify === true) || duplicate.includeApiKey !== (params.includeApiKey === true)) fail('REQUEST_CONFLICT');
        return { accepted: true, ...view(duplicate) };
      }
      if ([...jobs.values()].some(job => job.status === 'running')) fail('AUTH_BUSY');
      if (typeof openSession !== 'function') fail('NATIVE_PERMISSION_REQUIRED');
      const runtime = await getRuntime(), methods = runtime.providers?.authMethods(params.providerId);
      if (!Array.isArray(methods) || !methods.length) fail('AUTH_METHOD_UNSUPPORTED');
      const method = params.methodId ? methods.find(item => item.id === params.methodId) : methods.find(item => item.delegate || item.storage === 'secure-store') ?? methods[0];
      if (!method) fail('AUTH_METHOD_UNSUPPORTED');
      const headerNames = params.headerNames ?? [];
      if (headerNames.length && (action !== 'login' || method.delegate || !headerNames.every(name => runtime.providers.get(params.providerId).headers?.[name]?.source === 'secret'))) fail('INVALID_INPUT');
      if (action === 'login' && method.experimental && params.experimental !== true) fail('AUTH_EXPERIMENTAL_OPT_IN');
      if (jobs.size >= 32) { const terminal = [...jobs.values()].find(job => job.status !== 'running'); if (terminal) jobs.delete(terminal.id); else fail('REQUEST_LIMIT'); }
      // Capture ONE registered native owner before accepting. Re-registration cannot redirect secrets.
      const channel = openSession(), controller = new AbortController();
      const job = { id: `auth_${randomBytes(16).toString('hex')}`, providerId: params.providerId, method, owner: { kind: actor.kind, id: actor.id }, requestId, requestedMethod: params.methodId, experimental: params.experimental === true, action, headerNames, verify: params.verify === true, includeApiKey: params.includeApiKey === true, status: 'running', controller };
      jobs.set(job.id, job);
      const abort = () => controller.abort(); channel.signal?.addEventListener('abort', abort, { once: true });
      if (channel.signal?.aborted) abort();
      const deadline = setTimeout(abort, 900000); deadline.unref();
      const check = () => { if (controller.signal.aborted) fail('COMMAND_CANCELLED'); };
      const prompt = async (kind, fields = {}) => {
        check(); const reply = await channel.request({ kind, providerId: job.providerId, authMethodId: method.id, official: method.official === true, experimental: method.experimental === true, title: `${action === 'logout' ? 'Sign out of' : 'Connect'} ${job.providerId}`, ...fields }, { signal: controller.signal });
        check(); if (reply.cancelled === true) { controller.abort(); fail('COMMAND_CANCELLED'); } return reply;
      };
      job.execution = Promise.resolve().then(async () => {
        try {
          check();
          if (actor.kind !== 'native' || action === 'logout') {
            const answer = await prompt('decision', { purpose: action }); if (!answer.approved) fail('NATIVE_PERMISSION_REQUIRED');
          }
          const current = await getRuntime({ signal: controller.signal, stdout: quiet, stderr: quiet });
          if (action === 'logout') { check(); await current.authLogout(job.providerId); }
          else if (method.delegate) {
            if (!['zuku', 'codex'].includes(method.delegate)) fail('AUTH_METHOD_UNSUPPORTED');
            const commandContext = { signal: controller.signal, stdout: quiet, stderr: quiet,
              onDeviceCode: async info => { await prompt('device-authorization', { url: nativeAuthorizationUrl('zuku', info.verification_uri_complete ?? info.verification_uri), userCode: info.user_code }); },
              onAuthorizationUrl: async url => { await prompt('authorization-url', { url: nativeAuthorizationUrl('codex', url) }); },
            };
            await current.authLogin(job.providerId, { experimental: job.experimental, args: method.delegate === 'zuku' ? ['--generate', '--no-browser'] : [], commandContext });
          } else if (method.storage === 'secure-store' || headerNames.length) {
            // Collect all fields before atomic persistence. No partial secret update on cancellation.
            let apiKey; const headers = {};
            try {
              if (!headerNames.length || job.includeApiKey) { const answer = await prompt('secret'); check(); apiKey = answer.value; }
              for (const headerName of headerNames) { const answer = await prompt('secret', { headerName, title: `Connect ${job.providerId}: ${headerName}` }); check(); headers[headerName] = answer.value; }
              const target = await getRuntime({ signal: controller.signal, stdout: quiet, stderr: quiet });
              check();
              const result = await target.authLogin(job.providerId, { ...(apiKey !== undefined ? { apiKey } : {}), ...(headerNames.length ? { headers } : {}), verify: job.verify });
              job.verified = result.verified;
            } finally { apiKey = undefined; for (const name of Object.keys(headers)) delete headers[name]; }
          } else if (['credential-chain', 'none'].includes(method.storage)) {
            check(); const result = await current.authLogin(job.providerId, { verify: job.verify }); job.verified = result.verified;
          } else fail('AUTH_METHOD_UNSUPPORTED');
          check(); await changed(job.providerId); job.status = 'completed';
        } catch (error) { job.code = controller.signal.aborted ? 'COMMAND_CANCELLED' : safeError(error).code; job.status = job.code === 'COMMAND_CANCELLED' ? 'cancelled' : 'failed'; }
        finally { clearTimeout(deadline); channel.signal?.removeEventListener('abort', abort); channel.close(); }
      });
      return { accepted: true, ...view(job) };
    },
    async close() { closed = true; for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...jobs.values()].map(job => job.execution)); },
  });
}
