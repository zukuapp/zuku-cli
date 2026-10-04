// Cloud adapters through their official SDKs.
// - Bedrock: the REAL @aws-sdk/client-bedrock-runtime / client-bedrock clients
//   (default credential provider chain → env provider, genuine SigV4 signing,
//   genuine AWS event-stream decoding) against a loopback fixture endpoint.
//   The SigV4 signature is recomputed independently here to prove signing ran.
// - Vertex: the REAL google-auth-library performing an OAuth refresh against a
//   loopback token endpoint, then genuine Gemini wire over loopback HTTP.
// No AWS/Google account, network egress, cost or personal credential is used.
// SDK packages: resolved from node_modules, or from ZUKU_TEST_SDK_DIR (a
// directory with those exact versions installed); otherwise tests are skipped.
// Bedrock/Gemini response bodies marked "recorded" are verbatim Kilo Code
// recordings (MIT, commit 76bcfd40be616a72f4697b3041565f322245b462).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createH2Server } from 'node:http2';
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdapter, listBuiltinDescriptors } from '../lib/provider-system/adapters/index.mjs';
import { vertexBase } from '../lib/provider-system/adapters/gemini.mjs';

const builtin = id => listBuiltinDescriptors().find(d => d.id === id);
const AKID = 'AKIDFIXTUREONLY00001';
const SECRET = 'fixtureOnlySecretAccessKey/0000000000000';
const RECORDED_BEDROCK_TEXT = "AAAAmQAAAFI8UarQCzpldmVudC10eXBlBwAMbWVzc2FnZVN0YXJ0DTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUIiLCJyb2xlIjoiYXNzaXN0YW50In3SL1jNAAAAvQAAAFd4etebCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsidGV4dCI6IkhlbGxvIn0sInAiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ekFCQ0RFIn2B0NR6AAAAxgAAAFf2eAZFCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsidGV4dCI6IiJ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTIn3XaHMvAAAAhwAAAFbk7EcqCzpldmVudC10eXBlBwAQY29udGVudEJsb2NrU3RvcA06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJwIjoiYWJjIn3Lqeu3AAAAjwAAAFFK+JlICzpldmVudC10eXBlBwALbWVzc2FnZVN0b3ANOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJwIjoiYWJjZGVmZ2hpamtsbW4iLCJzdG9wUmVhc29uIjoiZW5kX3R1cm4ifZ+RQqEAAAECAAAATkXaMzsLOmV2ZW50LXR5cGUHAAhtZXRhZGF0YQ06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7Im1ldHJpY3MiOnsibGF0ZW5jeU1zIjozMDZ9LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVCIsInVzYWdlIjp7ImlucHV0VG9rZW5zIjoxMiwib3V0cHV0VG9rZW5zIjoyLCJzZXJ2ZXJUb29sVXNhZ2UiOnt9LCJ0b3RhbFRva2VucyI6MTR9fSnnkUk=";
const RECORDED_BEDROCK_TOOL = "AAAAuQAAAFL9kIXUCzpldmVudC10eXBlBwAMbWVzc2FnZVN0YXJ0DTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2NyIsInJvbGUiOiJhc3Npc3RhbnQifWf51EkAAAEMAAAAV56BJZoLOmV2ZW50LXR5cGUHABFjb250ZW50QmxvY2tTdGFydA06Y29udGVudC10eXBlBwAQYXBwbGljYXRpb24vanNvbg06bWVzc2FnZS10eXBlBwAFZXZlbnR7ImNvbnRlbnRCbG9ja0luZGV4IjowLCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTk9QUVJTVFUiLCJzdGFydCI6eyJ0b29sVXNlIjp7Im5hbWUiOiJnZXRfd2VhdGhlciIsInRvb2xVc2VJZCI6InRvb2x1c2VfNmExcFB2bmM5OUdMS08zS0drVUEyTiJ9fX2LR7PFAAAA4gAAAFfCOY+BCzpldmVudC10eXBlBwARY29udGVudEJsb2NrRGVsdGENOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwiZGVsdGEiOnsidG9vbFVzZSI6eyJpbnB1dCI6IntcImNpdHlcIjpcIlBhcmlzXCJ9In19LCJwIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXpBQkNERUZHSElKS0xNTiJ9RkW+2gAAAIcAAABW5OxHKgs6ZXZlbnQtdHlwZQcAEGNvbnRlbnRCbG9ja1N0b3ANOmNvbnRlbnQtdHlwZQcAEGFwcGxpY2F0aW9uL2pzb24NOm1lc3NhZ2UtdHlwZQcABWV2ZW50eyJjb250ZW50QmxvY2tJbmRleCI6MCwicCI6ImFiYyJ9y6nrtwAAAK4AAABRtlmf/As6ZXZlbnQtdHlwZQcAC21lc3NhZ2VTdG9wDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsicCI6ImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSUyIsInN0b3BSZWFzb24iOiJ0b29sX3VzZSJ9MTlQawAAAOIAAABOplInQQs6ZXZlbnQtdHlwZQcACG1ldGFkYXRhDTpjb250ZW50LXR5cGUHABBhcHBsaWNhdGlvbi9qc29uDTptZXNzYWdlLXR5cGUHAAVldmVudHsibWV0cmljcyI6eyJsYXRlbmN5TXMiOjM1NX0sInAiOiJhYmNkZWZnaGlqayIsInVzYWdlIjp7ImlucHV0VG9rZW5zIjo0MTksIm91dHB1dFRva2VucyI6MTYsInNlcnZlclRvb2xVc2FnZSI6e30sInRvdGFsVG9rZW5zIjo0MzV9fU1tVJc=";
const RECORDED_GEMINI_TOOL = "data: {\"candidates\": [{\"content\": {\"parts\": [{\"functionCall\": {\"name\": \"get_weather\",\"args\": {\"city\": \"Paris\"}},\"thoughtSignature\": \"CiQBDDnWx5RcSsS1UMbykQ5HWlrMu6wrxXGUhmZ0uRKLaMhDZaEKXwEMOdbHVoJAlfbOQyKB378pDZ/gkjWr3HP+dWw1us1kMG22g4G3oJvuTq/SrWS+7KYtSlvOxCKhW2l/2/TczpyGyGmANmsusDcxF1SKOYA5/8Hg0nI24MAlT3+91V/MCoUBAQw51seClFLy3E71v2H44F1kpmjgz8FeTRZofrjbaazfrT+w8Yxgdr3UgGagLMY4OadZemQTWckq9IAqRum78hrBg6NGtQvn15SbtfTNqI4PcxX/+qPo4/g4/ZT5kVORDhVqO8BVP/RA5GQ3ce3sRK8hSkvQlXSoXIPpHh6x7hBezIGXzw==\"}],\"role\": \"model\"},\"finishReason\": \"STOP\",\"index\": 0,\"finishMessage\": \"Model generated function call(s).\"}],\"usageMetadata\": {\"promptTokenCount\": 55,\"candidatesTokenCount\": 15,\"totalTokenCount\": 115,\"promptTokensDetails\": [{\"modality\": \"TEXT\",\"tokenCount\": 55}],\"thoughtsTokenCount\": 45},\"modelVersion\": \"gemini-2.5-flash\",\"responseId\": \"NyTxaYuTJ_OW_uMPgIPKgAg\"}\r\n\r\n";

async function loader(names) {
  const dir = process.env.ZUKU_TEST_SDK_DIR;
  const load = async name => {
    try { return await import(name); } catch (error) {
      if (!dir) throw error;
      return import(pathToFileURL(createRequire(join(dir, 'package.json')).resolve(name)).href);
    }
  };
  try { for (const name of names) await load(name); return load; } catch { return undefined; }
}
const awsLoad = await loader(['@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-bedrock']);
const googleLoad = await loader(['google-auth-library']);
const AWS_SKIP = awsLoad ? false : 'official AWS SDK not installed (root adds @aws-sdk/client-bedrock-runtime@3.1146.0, @aws-sdk/client-bedrock@3.1146.0)';
const GOOGLE_SKIP = googleLoad ? false : 'google-auth-library@11.1.0 not installed';

async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(entry);
    try { await handler(entry, res, req); } catch { res.destroy(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}
/** HTTP/2 cleartext fixture: the Bedrock runtime client speaks HTTP/2 (as against AWS). */
async function h2fixture(t, handler) {
  const requests = [];
  const sessions = new Set();
  const server = createH2Server(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(entry);
    try { await handler(entry, res, req); } catch { res.stream.close(); }
  });
  server.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const session of sessions) session.destroy(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, sessions };
}
async function collect(iterable) { const out = []; for await (const e of iterable) out.push(e); return out; }

/** AWS event-stream frame encoder (test side), CRC32 from node:zlib. */
function frame(headers, payload) {
  const parts = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name); const v = Buffer.from(value);
    const h = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    h.writeUInt8(n.length, 0); n.copy(h, 1); h.writeUInt8(7, 1 + n.length); h.writeUInt16BE(v.length, 2 + n.length); v.copy(h, 4 + n.length);
    parts.push(h);
  }
  const head = Buffer.concat(parts);
  const body = Buffer.from(JSON.stringify(payload));
  const total = 12 + head.length + body.length + 4;
  const prelude = Buffer.alloc(8); prelude.writeUInt32BE(total, 0); prelude.writeUInt32BE(head.length, 4);
  const preludeCrc = Buffer.alloc(4); preludeCrc.writeUInt32BE(crc32(prelude), 0);
  const message = Buffer.concat([prelude, preludeCrc, head, body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(message), 0);
  return Buffer.concat([message, crc]);
}
const event = (type, payload) => frame({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }, payload);
const exception = (type, payload) => frame({ ':exception-type': type, ':content-type': 'application/json', ':message-type': 'exception' }, payload);

/** Independent SigV4 verification of a captured request (proves the SDK signed it). */
function verifySigV4(req, { service, region }) {
  const auth = req.headers.authorization;
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth ?? '');
  assert.ok(m, 'SigV4 authorization header');
  const [, akid, date, r, s, signedHeaders, signature] = m;
  assert.deepEqual([akid, r, s], [AKID, region, service]);
  const url = new URL(req.url, 'http://x');
  // Non-S3 SigV4 canonical URIs are double-encoded: encode the already-encoded wire path again.
  const path = url.pathname.split('/').map(seg => encodeURIComponent(seg)).join('/');
  const query = [...url.searchParams].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const names = signedHeaders.split(';');
  const header = n => (n === 'host' ? req.headers.host ?? req.headers[':authority'] : req.headers[n]);
  const canonicalHeaders = names.map(n => `${n}:${String(header(n)).trim().replace(/\s+/g, ' ')}\n`).join('');
  const payloadHash = req.headers['x-amz-content-sha256'] ?? createHash('sha256').update(req.body).digest('hex');
  const canonical = [req.method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const amzDate = req.headers['x-amz-date'];
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  let key = createHmac('sha256', `AWS4${SECRET}`).update(date).digest();
  for (const part of [region, service, 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
  assert.equal(createHmac('sha256', key).update(toSign).digest('hex'), signature, 'independently recomputed SigV4 signature matches');
}

function withAwsEnv(t) {
  const keys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_EC2_METADATA_DISABLED', 'AWS_REGION', 'AWS_MAX_ATTEMPTS'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: AKID, AWS_SECRET_ACCESS_KEY: SECRET, AWS_CONFIG_FILE: '/nonexistent/zuku-fixture-aws-config', AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/zuku-fixture-aws-credentials', AWS_EC2_METADATA_DISABLED: 'true', AWS_MAX_ATTEMPTS: '5' });
  delete process.env.AWS_SESSION_TOKEN; delete process.env.AWS_PROFILE; delete process.env.AWS_REGION;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
const chain = (configuration = { region: 'us-east-1' }) => ({ getCredentials: async () => ({ kind: 'cloud-chain', configuration }) });
const bedrock = (fx, extra = {}) => createAdapter(builtin('amazon-bedrock'), { ...chain(), importModule: awsLoad, testOrigin: fx.origin, ...extra });
const ask = { model: 'us.amazon.nova-micro-v1:0', system: 'Call tools exactly as requested.', messages: [{ role: 'user', content: 'Call get_weather with city exactly Paris.' }], tools: [{ name: 'get_weather', description: 'Get current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }] };

test('Bedrock ConverseStream: real SDK signs with the default chain and decodes recorded event-stream frames', { skip: AWS_SKIP }, async t => {
  withAwsEnv(t);
  let body = RECORDED_BEDROCK_TOOL;
  const fx = await h2fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    const bytes = Buffer.from(body, 'base64');
    for (let i = 0; i < bytes.length; i += 11) res.write(bytes.subarray(i, i + 11));
    res.end();
  });
  const client = bedrock(fx);
  const events = await collect(client.stream(ask));
  assert.deepEqual(events.filter(e => e.type === 'tool-call').map(e => [e.name, e.arguments]), [['get_weather', { city: 'Paris' }]]);
  assert.equal(events.at(-1).reason, 'tool-calls');
  assert.ok(events.find(e => e.type === 'usage').usage.inputTokens > 0);
  const [req] = fx.requests;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/model/us.amazon.nova-micro-v1%3A0/converse-stream');
  verifySigV4(req, { service: 'bedrock', region: 'us-east-1' });
  const sent = JSON.parse(req.body.toString('utf8'));
  assert.deepEqual(sent.system, [{ text: 'Call tools exactly as requested.' }]);
  assert.deepEqual(sent.toolConfig.tools[0].toolSpec.inputSchema.json, ask.tools[0].parameters);
  assert.deepEqual(sent.toolConfig.toolChoice, { auto: {} });
  body = RECORDED_BEDROCK_TEXT;
  const text = await collect(client.stream({ ...ask, tools: undefined }));
  for (let i = 0; i < 50 && fx.sessions.size; i += 1) await delay(10);
  assert.equal(fx.sessions.size, 0, 'no lingering HTTP/2 session keeps the CLI alive');
  assert.ok(text.filter(e => e.type === 'text-delta').map(e => e.text).join('').length > 0);
  assert.equal(text.at(-1).reason, 'stop');
});

test('Bedrock: modeled stream exception, HTTP error and truncated stream map to fixed codes with exactly one attempt', { skip: AWS_SKIP }, async t => {
  withAwsEnv(t);
  let mode = 'exception';
  const fx = await h2fixture(t, async (req, res) => {
    if (mode === 'http') {
      res.writeHead(403, { 'content-type': 'application/json', 'x-amzn-errortype': 'AccessDeniedException:http://internal.amazon.com/coral/com.amazon.bedrock/' });
      return res.end(JSON.stringify({ message: `denied ${SECRET}` }));
    }
    if (mode === 'server') { res.writeHead(500, { 'content-type': 'application/json', 'x-amzn-errortype': 'InternalServerException' }); return res.end('{"message":"boom"}'); }
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    res.write(event('messageStart', { role: 'assistant' }));
    res.write(event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: '안녕' } }));
    if (mode === 'exception') res.write(exception('throttlingException', { message: `slow down ${SECRET}` }));
    res.end();
  });
  const client = bedrock(fx);
  await assert.rejects(collect(client.stream(ask)), e => !JSON.stringify(e).includes(SECRET) && e.code === 'PROVIDER_RATE_LIMITED');
  mode = 'http';
  await assert.rejects(collect(client.stream(ask)), e => !String(e.message).includes(SECRET) && e.code === 'PROVIDER_FORBIDDEN');
  mode = 'server';
  const before = fx.requests.length;
  await assert.rejects(collect(client.stream(ask)), { code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(fx.requests.length - before, 1, 'maxAttempts pinned to 1 despite AWS_MAX_ATTEMPTS=5');
  mode = 'truncated';
  await assert.rejects(collect(client.stream(ask)), { code: 'PROVIDER_STREAM_ERROR' });
});

test('Bedrock: cancellation mid-stream aborts the SDK request', { skip: AWS_SKIP }, async t => {
  withAwsEnv(t);
  let closed = false;
  const fx = await h2fixture(t, async (req, res, raw) => {
    raw.stream.on('close', () => { closed = true; });
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    res.write(event('messageStart', { role: 'assistant' }));
    for (let i = 0; i < 100 && !res.destroyed; i += 1) { res.write(event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: `t${i} ` } })); await delay(15); }
    res.end();
  });
  const controller = new AbortController();
  const seen = [];
  await assert.rejects((async () => { for await (const e of bedrock(fx).stream({ ...ask, signal: controller.signal })) { seen.push(e); if (seen.length === 2) controller.abort(); } })(), { code: 'COMMAND_CANCELLED' });
  for (let i = 0; i < 50 && !closed; i += 1) await delay(20);
  assert.equal(closed, true, 'HTTP/2 stream closed by the client');
  assert.equal(fx.sessions.size, 0, 'per-operation SDK client destroyed its HTTP/2 session');
  assert.ok(seen.length < 10);
});

test('Bedrock catalog: real control-plane SDK lists foundation models and inference profiles (paged)', { skip: AWS_SKIP }, async t => {
  withAwsEnv(t);
  const fx = await fixture(t, async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (url.pathname === '/foundation-models') return res.end(JSON.stringify({ modelSummaries: [
      { modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0', modelId: 'amazon.nova-micro-v1:0', modelName: 'Nova Micro', providerName: 'Amazon', inputModalities: ['TEXT'], outputModalities: ['TEXT'], responseStreamingSupported: true },
      { modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/x.batch-only', modelId: 'x.batch-only', responseStreamingSupported: false },
      { modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0', modelId: 'amazon.nova-lite-v1:0', inputModalities: ['TEXT', 'IMAGE'], responseStreamingSupported: true } ] }));
    if (url.pathname === '/inference-profiles' && !url.searchParams.get('nextToken')) return res.end(JSON.stringify({ inferenceProfileSummaries: [{ inferenceProfileId: 'us.amazon.nova-micro-v1:0', inferenceProfileName: 'US Nova Micro', inferenceProfileArn: 'arn:x', status: 'ACTIVE', type: 'SYSTEM_DEFINED', models: [] }], nextToken: 'page2' }));
    if (url.pathname === '/inference-profiles') return res.end(JSON.stringify({ inferenceProfileSummaries: [{ inferenceProfileId: 'eu.old', inferenceProfileName: 'old', inferenceProfileArn: 'arn:y', status: 'DELETED', type: 'SYSTEM_DEFINED', models: [] }] }));
    res.end('{}');
  });
  const client = bedrock(fx);
  const models = await client.listModels();
  assert.deepEqual(models.map(m => [m.address, m.capabilities.vision, m.capabilities.tools]), [['amazon-bedrock/amazon.nova-micro-v1:0', false, null], ['amazon-bedrock/amazon.nova-lite-v1:0', true, null], ['amazon-bedrock/us.amazon.nova-micro-v1:0', null, null]]);
  assert.match(fx.requests[0].url, /byOutputModality=TEXT/);
  verifySigV4(fx.requests[0], { service: 'bedrock', region: 'us-east-1' });
  assert.deepEqual(await client.validateAuth(), { ok: true });
});

test('Bedrock credential kinds and SDK availability fail before any request', { skip: AWS_SKIP }, async t => {
  withAwsEnv(t);
  const fx = await h2fixture(t, async (req, res) => { res.writeHead(500); res.end(); });
  await assert.rejects(collect(bedrock(fx, { getCredentials: async () => ({ kind: 'api-key', apiKey: 'x'.repeat(20) }) }).stream(ask)), { code: 'ADAPTER_CREDENTIALS_INVALID' });
  await assert.rejects(collect(bedrock(fx, { getCredentials: async () => ({ kind: 'none' }) }).stream(ask)), { code: 'ADAPTER_CREDENTIALS_MISSING' });
  await assert.rejects(collect(bedrock(fx, { getCredentials: async () => ({ kind: 'cloud-chain', configuration: { region: 'not a region' } }) }).stream(ask)), { code: 'ADAPTER_CREDENTIALS_INVALID' });
  await assert.rejects(collect(bedrock(fx, { getCredentials: async () => ({ kind: 'cloud-chain', configuration: { secretAccessKey: 'x' } }) }).stream(ask)), { code: 'ADAPTER_INVALID_DESCRIPTOR' });
  await assert.rejects(collect(bedrock(fx, { importModule: async () => { throw new Error('missing'); } }).stream(ask)), { code: 'ADAPTER_SDK_UNAVAILABLE' });
  assert.equal(fx.requests.length, 0);
  assert.throws(() => createAdapter({ ...builtin('amazon-bedrock'), baseUrl: 'https://evil.example' }, chain()), { code: 'ADAPTER_ENDPOINT_REJECTED' });
});

test('Bedrock request mapping without the SDK: Converse input shape', async () => {
  const { buildInput } = await import('../lib/provider-system/adapters/protocols/bedrock-converse.mjs');
  const input = buildInput({ model: 'm', system: 's', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', toolCalls: [{ id: 'tu_1', name: 'read_file', arguments: { p: 1 } }] }, { role: 'tool', toolCallId: 'tu_1', content: 'out' }], tools: [], toolChoice: undefined, maxOutputTokens: 100 });
  assert.deepEqual(input, { modelId: 'm', system: [{ text: 's' }], inferenceConfig: { maxTokens: 100 }, messages: [
    { role: 'user', content: [{ text: 'q' }] },
    { role: 'assistant', content: [{ toolUse: { toolUseId: 'tu_1', name: 'read_file', input: { p: 1 } } }] },
    { role: 'user', content: [{ toolResult: { toolUseId: 'tu_1', content: [{ text: 'out' }] } }] }] });
});

test('Vertex AI: real google-auth-library refresh (loopback token endpoint) then Gemini wire with recorded body', { skip: GOOGLE_SKIP }, async t => {
  const tokenServer = await fixture(t, async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: 'ya29.fixture_vertex_token', expires_in: 3600, token_type: 'Bearer' })); });
  const api = await fixture(t, async (req, res) => {
    if (req.url.startsWith('/v1beta1/publishers/google/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ publisherModels: [{ name: 'publishers/google/models/gemini-2.5-flash' }] })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(RECORDED_GEMINI_TOOL);
  });
  const dir = await mkdtemp(join(tmpdir(), 'zuku-adc-'));
  const file = join(dir, 'adc.json');
  await writeFile(file, JSON.stringify({ type: 'authorized_user', client_id: 'fixture.apps.googleusercontent.com', client_secret: 'fixture-client-secret', refresh_token: 'fixture-refresh-token' }), { mode: 0o600 });
  const { GoogleAuth } = await googleLoad('google-auth-library');
  // Real library, real refresh flow; only the token endpoint is the loopback fixture.
  const googleAuth = new GoogleAuth({ keyFilename: file, scopes: ['https://www.googleapis.com/auth/cloud-platform'], clientOptions: { endpoints: { oauth2TokenUrl: `${tokenServer.origin}/token` } } });
  const client = createAdapter({ ...builtin('google-vertex'), options: { project: 'zuku-fixture-proj', location: 'us-central1' } }, { getCredentials: async () => ({ kind: 'cloud-chain' }), googleAuth, testOrigin: api.origin });
  const events = await collect(client.stream({ ...ask, model: 'gemini-2.5-flash' }));
  assert.deepEqual(events.filter(e => e.type === 'tool-call').map(e => [e.name, e.arguments]), [['get_weather', { city: 'Paris' }]]);
  assert.match(tokenServer.requests[0].body.toString(), /grant_type=refresh_token/);
  const req = api.requests[0];
  assert.equal(req.url, '/v1/projects/zuku-fixture-proj/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  assert.equal(req.headers.authorization, 'Bearer ya29.fixture_vertex_token');
  assert.equal(req.headers['x-goog-user-project'], 'zuku-fixture-proj');
  assert.deepEqual((await client.listModels()).map(m => m.address), ['google-vertex/gemini-2.5-flash']);
  assert.equal(tokenServer.requests.length, 1, 'token cached by the library across operations');
});

test('Vertex AI: adapter-constructed ADC with no credentials file fails safely without network', { skip: GOOGLE_SKIP }, async t => {
  const saved = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/nonexistent/zuku-fixture/adc.json';
  t.after(() => { if (saved === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS; else process.env.GOOGLE_APPLICATION_CREDENTIALS = saved; });
  const api = await fixture(t, async (req, res) => { res.writeHead(500); res.end(); });
  const client = createAdapter({ ...builtin('google-vertex'), options: { project: 'zuku-fixture-proj' } }, { getCredentials: async () => ({ kind: 'cloud-chain' }), importModule: googleLoad, testOrigin: api.origin });
  await assert.rejects(collect(client.stream({ ...ask, model: 'gemini-2.5-flash' })), e => e.code === 'ADAPTER_CREDENTIALS_MISSING' && !e.message.includes('nonexistent'));
  assert.equal(api.requests.length, 0);
});

test('Vertex AI: bearer credential kind, endpoint selection and config validation (no SDK needed)', async t => {
  const api = await fixture(t, async (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(RECORDED_GEMINI_TOOL); });
  const client = createAdapter({ ...builtin('google-vertex'), options: { project: 'zuku-fixture-proj' } }, { getCredentials: async () => ({ kind: 'bearer', accessToken: 'ya29.core_supplied_token' }), testOrigin: api.origin });
  await collect(client.stream({ ...ask, model: 'gemini-2.5-flash' }));
  assert.equal(api.requests[0].url, '/v1/projects/zuku-fixture-proj/locations/global/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  assert.equal(vertexBase('global'), 'https://aiplatform.googleapis.com');
  assert.equal(vertexBase('us'), 'https://aiplatform.us.rep.googleapis.com');
  assert.equal(vertexBase('europe-west4'), 'https://europe-west4-aiplatform.googleapis.com');
  assert.throws(() => createAdapter(builtin('google-vertex'), {}), { code: 'ADAPTER_INVALID_DESCRIPTOR' });
  assert.throws(() => createAdapter({ ...builtin('google-vertex'), options: { project: 'p', location: 'x/../y' } }), { code: 'ADAPTER_INVALID_DESCRIPTOR' });
  const keyed = createAdapter({ ...builtin('google-vertex'), options: { project: 'zuku-fixture-proj' } }, { getCredentials: async () => ({ kind: 'api-key', apiKey: 'x'.repeat(20) }), testOrigin: api.origin });
  await assert.rejects(collect(keyed.stream({ ...ask, model: 'g' })), { code: 'ADAPTER_CREDENTIALS_INVALID' });
});
