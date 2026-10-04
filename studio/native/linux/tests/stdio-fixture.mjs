// Synthetic protocol fixture only; no Agent Core, credentials, network or browser.
import { createInterface } from 'node:readline';
import { validateRequest, projectPublicResult } from '../../../../lib/agent-protocol/schema.mjs';
const timeout = setTimeout(() => process.exit(2), 2000);
const reader = createInterface({ input: process.stdin, terminal: false });
reader.on('line', line => {
  if (Buffer.byteLength(line) > 65536) process.exit(3);
  const request = JSON.parse(line);
  if (request.protocolVersion !== 1 || typeof request.id !== 'string') process.exit(4);
  if (request.method !== 'native.authResponse') validateRequest(request, {native: true});
  else if (Object.keys(request.params).some(key=>!['requestId','value'].includes(key))) process.exit(5);
  const result = request.method === 'project.list' ? { projects: [{ projectHandle: 'project_fixture', name: 'Synthetic Game' }] }
    : request.method === 'session.create' ? { sessionId: 'session_fixture' }
    : request.method === 'native.authResponse' ? { status: 'accepted' } : null;
  process.stdout.write(JSON.stringify({ protocolVersion: 1, id: request.id, ...(result ? { result:projectPublicResult(result) } : { error: { code: 'UNKNOWN_OPERATION' } }) }) + '\n');
});
reader.on('close', () => clearTimeout(timeout));
