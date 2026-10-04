import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelAddress, formatModelAddress, validModelId } from '../lib/provider-system/address.mjs';
import { validateEndpoint, validateHeaderName, validHeaderValue } from '../lib/provider-system/endpoint.mjs';
import { BUILTIN_PROVIDERS, DEFAULT_MODEL_ADDRESS } from '../lib/provider-system/catalog.mjs';
import { AuthRegistry } from '../lib/provider-system/auth-registry.mjs';

test('model addresses split on the FIRST slash and keep vendor/path model IDs', () => {
  assert.deepEqual({ ...parseModelAddress('openrouter/anthropic/claude-x') }, { provider: 'openrouter', model: 'anthropic/claude-x', address: 'openrouter/anthropic/claude-x' });
  assert.equal(parseModelAddress('ollama/llama3.2:3b').model, 'llama3.2:3b');
  assert.equal(parseModelAddress('amazon-bedrock/anthropic.claude-v2:1').model, 'anthropic.claude-v2:1');
  assert.equal(parseModelAddress('cloudflare-ai-gateway/@cf/meta/llama').model, '@cf/meta/llama');
  assert.equal(parseModelAddress(DEFAULT_MODEL_ADDRESS).address, 'zuku/auto');
  assert.equal(formatModelAddress('openai', 'gpt-x'), 'openai/gpt-x');
});

test('model addresses reject traversal, control characters, encodings and bounds', () => {
  for (const bad of ['', 'openai', '/gpt', 'openai/', 'OpenAI/gpt', 'openai//gpt', 'openai/../x', 'openai/a/./b', 'openai/a b', 'openai/a\u0000', 'openai/a‮', 'openai/a%2f', 'openai/a\\b', `openai/${'a'.repeat(257)}`, 'x'.repeat(65) + '/m', 42, null]) {
    assert.throws(() => parseModelAddress(bad), error => error.code === 'MODEL_ADDRESS_INVALID', String(bad));
  }
  assert.equal(validModelId('a'.repeat(128)), true);
  assert.equal(validModelId('a'.repeat(129)), false);
});

test('credential endpoints: HTTPS or loopback HTTP only, no userinfo/query/fragment/path escape', () => {
  assert.equal(validateEndpoint('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(validateEndpoint('http://127.0.0.1:8000/v1'), 'http://127.0.0.1:8000/v1');
  assert.equal(validateEndpoint('http://localhost:11434'), 'http://localhost:11434');
  for (const bad of ['http://example.com/v1', 'ftp://example.com', 'https://user:pw@example.com', 'https://example.com/v1?key=1', 'https://example.com/#x', 'https://example.com/a/../b', 'https://example.com/%2e%2e/x', 'https://example.com/a\\b', 'https://example.com/a\r\nX: y', 'https://exa mple.com', 'http://10.0.0.1/v1', 'javascript:alert(1)']) {
    assert.throws(() => validateEndpoint(bad), error => error.code === 'PROVIDER_ENDPOINT_REJECTED', bad);
  }
  assert.equal(validateEndpoint('https://res.openai.azure.com/openai/v1', { hostSuffixes: ['.openai.azure.com'] }), 'https://res.openai.azure.com/openai/v1');
  assert.throws(() => validateEndpoint('https://openai.azure.com.evil.test/v1', { hostSuffixes: ['.openai.azure.com'] }));
  assert.throws(() => validateEndpoint('https://evil.test/gateway.ai.cloudflare.com', { hostSuffixes: ['gateway.ai.cloudflare.com'] }));
});

test('header names/values reject CRLF and transport-owned names', () => {
  assert.equal(validateHeaderName('X-Org-Id'), 'X-Org-Id');
  for (const bad of ['Host', 'Content-Length', 'Cookie', 'Proxy-Authorization', 'X Bad', 'X:Bad', 'X\r\nY']) assert.throws(() => validateHeaderName(bad));
  assert.equal(validHeaderValue('Bearer abc'), true);
  assert.equal(validHeaderValue('abc\r\nInjected: 1'), false);
  assert.equal(validHeaderValue(' leading'), false);
});

test('built-in catalog: native default, unique IDs, unknown capabilities are null, auth metadata explicit', () => {
  const ids = BUILTIN_PROVIDERS.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'zuku');
  for (const id of ['openai', 'anthropic', 'google', 'openrouter', 'amazon-bedrock', 'google-vertex', 'azure', 'ollama', 'lmstudio', 'mistral', 'deepseek', 'groq', 'xai', 'alibaba', 'togetherai', 'fireworks', 'cerebras', 'sambanova', 'huggingface', 'cloudflare-ai-gateway', 'vercel', 'codex']) assert.ok(ids.includes(id), id);
  const zuku = BUILTIN_PROVIDERS[0];
  assert.equal(zuku.capabilities.stageInference, true);
  assert.equal(zuku.capabilities.streaming, false);
  assert.equal(zuku.capabilities.vision, null);
  for (const item of BUILTIN_PROVIDERS) {
    if (item.baseUrl) assert.ok(item.baseUrl.startsWith('https://') || item.local, item.id);
    assert.equal(item.capabilities.vision, null, `${item.id} vision must not be guessed`);
  }
  const auth = new AuthRegistry({ codexMethod: { official: true, experimental: false, name: 'Codex OAuth' } });
  assert.equal(auth.get('codex-oauth').official, false, 'Codex integration is never official');
  assert.equal(auth.get('codex-oauth').experimental, true);
  for (const method of ['api-key', 'environment', 'aws-credential-chain', 'google-adc', 'local', 'zuku-oauth-device']) assert.equal(auth.get(method).experimental, false, method);
  assert.equal(auth.get('custom-api-key').experimental, true);
});
