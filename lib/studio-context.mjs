import { randomBytes } from 'node:crypto';
import { createCoreClient } from './agent-core/client.mjs';
import { ProtocolError, projectPublicResult, validateRequest } from './agent-protocol/index.mjs';
import { cliVersion } from './identity.mjs';

const id = () => `studio_${randomBytes(16).toString('hex')}`;
const unavailable = () => { throw new ProtocolError('TOOL_UNAVAILABLE'); };
const unwrap = reply => { if (reply.error) throw new ProtocolError(reply.error.code); return reply.result; };

/** Native UI/Adapter facade. It owns a connection, never another agent or provider runtime. */
export async function createStudioHostContext(options = {}) {
  const client = options.coreClient ?? await createCoreClient(options);
  let detachPrompter, eventSink, closed = false;
  const dispatchNative = async (method, params = {}, context = {}) => {
    if (closed) throw new ProtocolError('CORE_CLOSED');
    const request = typeof method === 'object' ? method : { protocolVersion: 1, id: context.id ?? id(), method, params };
    validateRequest(request, { native: true }); return unwrap(await client.dispatch(request));
  };
  const adapterHost = Object.freeze({
    async getHealth() { return { ...await dispatchNative('hello'), studioVersion: cliVersion }; },
    async getProjects() { return (await dispatchNative('project.list')).projects; },
    async getProviders() {
      const result = await dispatchNative('provider.list');
      return { ...result, defaultProvider: result.activeProvider, defaultModel: result.activeModel,
        providers: result.providers.map(provider => ({ ...provider, authenticated: ['configured', 'environment', 'credential-chain', 'not-required'].includes(provider.auth?.status) })),
      };
    },
    async getModels({ providerId } = {}) { return (await dispatchNative('model.list', providerId ? { providerId } : {})).models; },
    dispatchCore(request, actor, context = {}) { context.authorize?.(); return client.dispatch(request, { actor }); },
    subscribeCore(params, actor) { return client.subscribe(params, { actor }); },
    // The Adapter's Core transport handles session methods. Legacy paths cannot acquire native authority.
    createSession: unavailable, input: unavailable, cancel: unavailable, authLogin: unavailable,
    authLogout: unavailable, useProvider: unavailable, useModel: unavailable,
  });
  return Object.freeze({
    adapterHost, dispatchNative,
    async grantNativeProject(localPath, { purpose, name, requestId } = {}) {
      const params = { localPath, ...(name ? { name } : {}), purpose: purpose ?? 'game.maintain' };
      try { return await dispatchNative('project.grant', params, { id: requestId }); }
      catch (error) {
        // The Core's actual classifier permits this fallback only for a legitimate empty initializer.
        if (purpose || error.code !== 'AGENT_REQUEST_OUT_OF_SCOPE') throw error;
        return dispatchNative('project.grant', { ...params, purpose: 'game.init' }, { id: requestId });
      }
    },
    subscribeNative(params) { return client.subscribe(params); },
    async setNativePrompter(callback) {
      if (detachPrompter) { const detach = detachPrompter; detachPrompter = undefined; await detach(); }
      if (callback !== null && callback !== undefined) {
        if (typeof callback !== 'function') throw new ProtocolError('INVALID_INPUT');
        detachPrompter = await client.attachNativePrompter(callback);
      }
    },
    setNativeEventSink(callback) { if (callback != null && typeof callback !== 'function') throw new ProtocolError('INVALID_INPUT'); eventSink = callback; },
    emitNativeEvent(type, data) { return eventSink?.(type, projectPublicResult(data)); },
    async close() { if (closed) return; closed = true; if (detachPrompter) await detachPrompter().catch(() => {}); eventSink = undefined; client.close(); },
  });
}
