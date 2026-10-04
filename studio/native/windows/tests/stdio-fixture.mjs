// SYNTHETIC FIXTURE — stands in for lib/studio-host.mjs --stdio in the Windows shell's
// stdio self-test. No Agent Core, credentials, providers, network, browser or filesystem.
// It answers with deliberately hostile payloads (absolute paths, secret-like keys/text,
// an oversize line) so the native gate's filtering is exercised.
import { createInterface } from 'node:readline';
import { validateRequest } from '../../../../lib/agent-protocol/schema.mjs';

const NONCE = '0123456789abcdef0123456789abcdef';
const timeout = setTimeout(() => process.exit(2), 15000);
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => write({ protocolVersion: 1, id, result });
const fail = (id, code, extra = {}) => write({ protocolVersion: 1, id, error: { code, message: 'C:\\Users\\fixture\\secret.txt failed', ...extra } });
const event = (subscriptionId, type, data, sequence) => write({ protocolVersion: 1, type: 'native.subscription', data: { subscriptionId, event: {
  protocolVersion: 1, sessionId: 'session_fixture', sequence, eventId: `event_${sequence}`, time: '2026-10-04T00:00:00.000Z', type, data } } });

const reader = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
reader.on('line', line => {
  if (Buffer.byteLength(line) > 65536) process.exit(3);
  const request = JSON.parse(line);
  if (request.protocolVersion !== 1 || typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.id)) process.exit(4);
  const { id, method, params } = request;
  switch (method) {
    case 'native.projectChosen':
      if (Object.keys(params).sort().join() !== 'localPath,requestId' || !/^[A-Za-z]:\\/.test(params.localPath)) process.exit(5);
      // The host answers the renderer's original picker request id.
      return reply(params.requestId, { projectHandle: 'project_fixture', name: 'Synthetic Game', path: params.localPath });
    case 'native.resolvePreview':
      return reply(id, params.previewHandle === 'preview_bad' ? { url: `http://127.0.0.1:45678/p/${NONCE}/?token=x` } : { url: `http://127.0.0.1:45678/p/${NONCE}/` });
    case 'native.pairingDecision':
      if (Object.keys(params).sort().join() !== 'allow,requestId' || typeof params.allow !== 'boolean') process.exit(6);
      return reply(id, { accepted: params.allow });
    case 'native.authResponse':
      if (Object.keys(params).sort().join() !== 'requestId,value' || typeof params.value !== 'string') process.exit(7);
      return reply(id, { accepted: params.value.length > 0 });   // never echoes the value
    case 'native.subscribe':
      reply(id, { status: 'subscribed' });
      event(params.subscriptionId, 'agent.delta', { text: '대시 기능을 추가합니다', blockId: 'block_1' }, 1);
      event(params.subscriptionId, 'agent.delta', { text: 'x', blockId: 'block_2', apiKey: 'leak' }, 2);   // must be dropped
      return write({ protocolVersion: 1, type: 'native.subscription', data: { subscriptionId: params.subscriptionId, status: { kind: 'status', state: 'connected', minimumSequence: 1, path: '/root/x' } } });
    case 'native.unsubscribe':
      return reply(id, { status: 'detached' });
  }
  validateRequest(request, { native: true });
  if (method === 'hello' && params.clientVersion === 'emit-pairing') {
    write({ protocolVersion: 1, type: 'native.pairing', data: { requestId: 'pair_fixture', challengeId: 'challenge_fixture', origin: 'https://ai.zuzunza.com', purpose: 'browser.connect', expiresAt: Date.now() + 60000 } });
    return reply(id, { product: 'zuku-studio-host-fixture' });
  }
  if (method === 'hello' && params.clientVersion === 'emit-auth') {
    write({ protocolVersion: 1, type: 'native.auth', data: { requestId: 'auth_fixture', providerId: 'codex', methodId: 'compat_login', question: 'Codex 로그인 코드를 입력하세요', expiresAt: Date.now() + 60000, experimental: true } });
    return reply(id, { product: 'zuku-studio-host-fixture' });
  }
  if (method === 'hello' && params.clientVersion === 'oversize') {
    process.stdout.write('{"protocolVersion":1,"pad":"' + 'x'.repeat(300000) + '"}\n');
    return;
  }
  if (method === 'project.list') return reply(id, { projects: [{ projectHandle: 'project_fixture', name: 'Synthetic Game', path: 'C:\\Users\\fixture\\game', apiKey: 'synthetic-leak' }], note: 'see /home/fixture/notes' });
  if (method === 'hello') return reply(id, { product: 'zuku-studio-host-fixture', protocolVersion: 1 });
  fail(id, 'UNKNOWN_OPERATION', { action: 'retry', stack: 'Error at C:\\x' });
});
reader.on('close', () => { clearTimeout(timeout); process.exit(0); });
