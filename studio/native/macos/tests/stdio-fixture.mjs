// SYNTHETIC FIXTURE — not Agent Core and not lib/studio-host.mjs.
// Used only by `ZukuStudio --stdio-test` to exercise the macOS shell's real HostProcess
// stdio framing, backpressure, sensitive write path and overflow handling. It has no
// network, credential store, provider, project or filesystem access.
import { createInterface } from 'node:readline';
import { validateRequest, projectPublicResult } from '../../../../lib/agent-protocol/schema.mjs';

const timer = setTimeout(() => process.exit(2), 5000);
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => write({ protocolVersion: 1, id, result: projectPublicResult(result) });
const reader = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
reader.on('line', line => {
  if (Buffer.byteLength(line) > 65536) process.exit(3);
  const request = JSON.parse(line);
  if (request.protocolVersion !== 1 || typeof request.id !== 'string') process.exit(4);
  switch (request.method) {
    case 'project.list':
      validateRequest(request, { native: true });
      return reply(request.id, { projects: [{ projectHandle: 'project_fixture', name: 'Synthetic Game' }] });
    case 'session.create':
      validateRequest(request, { native: true });
      return reply(request.id, { sessionId: 'session_fixture' });
    case 'native.subscribe':
      if (Object.keys(request.params).sort().join() !== 'afterSequence,sessionId,subscriptionId') process.exit(5);
      reply(request.id, { accepted: true });
      write({ protocolVersion: 1, type: 'native.subscription', data: { subscriptionId: request.params.subscriptionId, event: { protocolVersion: 1, sessionId: 'session_fixture', sequence: 1, eventId: 'event_1', time: '2026-10-04T00:00:00.000Z', type: 'agent.delta', data: { text: 'synthetic delta', blockId: 'block_1' } } } });
      return write({ protocolVersion: 1, type: 'native.pairing', data: { requestId: 'pair_fixture', challengeId: 'challenge_fixture', origin: 'https://ai.zuzunza.com', purpose: 'browser.connect', expiresAt: Date.now() + 60000 } });
    case 'native.authResponse': {
      if (Object.keys(request.params).sort().join() !== 'requestId,value') process.exit(6);
      // Confirms receipt without echoing the synthetic secret.
      return reply(request.id, { accepted: request.params.value === 'synthetic-fixture-secret' });
    }
    case 'hello':
      if (request.params.clientVersion === 'overflow') { process.stdout.write('x'.repeat(300000)); return; }
      return reply(request.id, { protocolVersion: 1 });
    default:
      return write({ protocolVersion: 1, id: request.id, error: { code: 'UNKNOWN_OPERATION' } });
  }
});
reader.on('close', () => clearTimeout(timer));
