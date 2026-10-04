# Provider protocol adapters — API contracts

Owner scope: `lib/provider-system/adapters/**`, `tests/provider-adapters-*.test.mjs`, this file.
The core (`lib/provider-system/*.mjs`) owns registry, config, credential storage, model
selection and CLI rendering; it imports only `createAdapter`, `listBuiltinDescriptors`
and `API_TYPES` from `lib/provider-system/adapters/index.mjs`.

## 1. Public interface

```js
import { createAdapter, listBuiltinDescriptors, API_TYPES } from './lib/provider-system/adapters/index.mjs';
```

### apiType enum (single enum for built-ins, custom setup and `createAdapter`)

| apiType | Wire | Used by |
| --- | --- | --- |
| `zuku` | ZUKU public API envelope (catalog only) | `zuku` |
| `openai-responses` | `POST {base}/responses`, typed SSE | `openai`, custom |
| `openai-chat` | `POST {base}/chat/completions`, SSE | `openai` (alternative), OpenRouter, LM Studio, compatible vendors, custom |
| `anthropic` | `POST {base}/messages`, named SSE | `anthropic`, custom |
| `gemini` | `POST {base}/models/{m}:streamGenerateContent?alt=sse` | `google` |
| `vertex` | same body, `…/projects/{p}/locations/{l}/publishers/google/models/{m}:streamGenerateContent?alt=sse` | `google-vertex` |
| `azure-openai` | Responses or Chat on `{resource}/openai/v1` | `azure` |
| `ollama` | `POST {base}/api/chat`, NDJSON | `ollama` |
| `bedrock` | ConverseStream via the official AWS SDK (AWS event-stream) | `amazon-bedrock` |
| `codex` | wraps the CLI's own Codex client (experimental) | `codex` |

Custom endpoints accept `openai-chat`, `openai-responses`, `anthropic`
(`CUSTOM_API_TYPES`). A built-in may only use its own apiType (OpenAI may also use
`openai-chat`). Provider ID and protocol are separate: OpenRouter = provider
`openrouter` + `openai-chat`; Azure = `azure` + `options.wire` `responses|chat`.

### Descriptor

`{ id, name, apiType, baseUrl, enabled, authMethods, capabilities, models?, options, support }`

- `baseUrl` is the boundary name everywhere (SDKs' `baseURL`/`endpoint` are internal).
- Built-ins are pinned to their official HTTPS base; only Ollama/LM Studio may move to
  another **loopback** port. Templates are derived only from validated options on
  vendor-owned hosts (Azure `resourceName`, Cloudflare `accountId`/`gatewayId`,
  Vertex `location`).
- Custom: `options.custom === true`, explicit HTTPS `baseUrl`, or loopback HTTP with
  `options.allowLoopbackHttp === true`. User-settable custom options:
  `headers` (non-secret), `defaultModel`/`model`, `catalog` (`openai`|`none`),
  `maxTokensField`, `defaultMaxOutputTokens`. Wire knobs (auth header style,
  extra body, catalog parser) cannot be set by user config on built-ins.
- Descriptors/options refuse embedded secrets (`apiKey`, `token`, `authorization`, …)
  and secret header names in public `headers`.
- `support.state`: `available` | `requires-config` | `requires-sdk` | `catalog-only` |
  `experimental-opt-in`, plus `requires` (what is missing). Registration is not proof a
  route works.

### AuthMethod metadata

`{ id, type, name, official, experimental, unofficial, credential, env? }`

- `unofficial === !official`; anything not official is experimental. Built-in metadata
  is fixed; custom descriptors can never claim `official: true` (they render `(exp!)`).
- `credential` names the kind the core must supply: `api-key`, `bearer`, `none`,
  `cloud-chain`, or `own-client` (Codex).
- `env` lists the fixed vendor variable the **core** may read for this provider
  (e.g. `OPENAI_API_KEY`); adapters never read the environment or any store.

### Context (operational seams, never exposed on the client)

| key | purpose |
| --- | --- |
| `getCredentials({signal})` | **private** credential getter, selected-provider scoped, called once per network operation (rotation-safe) |
| `fetch`, `signal`, `timeouts`, `limits` | transport; `timeouts` = `{connectMs, firstByteMs, idleMs, totalMs}` (bounded) |
| `testOrigin` | tests only: rebases the official path onto an explicit loopback origin |
| `importModule` | SDK loader seam (bundler/tests); default dynamic `import()` |
| `googleAuth` | ADC client seam (`getAccessToken()`); default constructs `GoogleAuth` |
| `nativeZuku` | canonical native client (`runStage`, optional `stream`) once the contract exists |
| `codexModules`, `codexStorePath` | Codex bridge (see §6) |
| `validateStageSchema`, `validateStageOutput` | host validators, run in addition to local admission |

Credential kinds returned by `getCredentials`:
`{kind:'api-key', apiKey, headers?}` · `{kind:'bearer', accessToken, headers?}` ·
`{kind:'none', headers?}` · `{kind:'cloud-chain', configuration?}`.
`headers` are secret custom headers (sent, never logged). `configuration` is public
(e.g. Bedrock `region`/`profile`) and refuses secret-named keys. Values are validated
(printable, bounded, no CR/LF) and used only inside the operation's closure.

Auth header mapping (adapter-owned): OpenAI-family `Authorization: Bearer`; Anthropic
`x-api-key` + `anthropic-version: 2023-06-01`; Gemini `x-goog-api-key` (never a URL
query); Azure `api-key`; Cloudflare `cf-aig-authorization: Bearer`; Vertex
`Authorization: Bearer <ADC token>` + `x-goog-user-project`; ZUKU `bearer` only.

### Client

```
{ id, name, authMethods, capabilities,
  listModels({refresh?, signal?}) → Model[],
  validateAuth({signal?}) → {ok:true} | {ok:false, code} | {ok:null, reason},
  stream(request) → AsyncIterable<Event>,
  runStage(stageRequest) → StageResult }
```

- `stream` is lazy: validation, credential lookup and the request happen on the first
  `next()`. Breaking iteration or aborting cancels the HTTP body/SDK request.
- `validateAuth` uses only a read-only catalog GET; providers without one return
  `{ok:null, reason:'no-read-endpoint'}` — never an inference call.

Request: `{ model, system?, messages:[{role:'user'|'assistant'|'tool', content, toolCalls?, toolCallId?, name?}], tools?:[{name, description?, parameters}], toolChoice?:'auto'|'none'|'required', maxOutputTokens?, temperature?, reasoning?:'low'|'medium'|'high', responseFormat?:{type:'json', schema?}, includeReasoning?, signal? }`.
`model` is the opaque bare model ID (vendor slashes kept, e.g. `anthropic/claude-x` for
OpenRouter). Limits: 1024 messages, 8 MiB content, 128 tools, 64 KiB per tool schema.
Content is text-only (no image parts are sent).

Events:
`{type:'text-delta',text}` · `{type:'tool-call',id,name,arguments}` (decoded JSON
object, emitted once, never executed) · `{type:'usage',usage}` ·
`{type:'finish',reason:'stop'|'length'|'tool-calls'|'content-filter'|'other'}` ·
`{type:'reasoning-status',status:'reasoning'}` (default) ·
`{type:'reasoning-delta',text}` only when `includeReasoning === true` (private codec use;
frontends must map to `agent.reasoning_status`, never show the text).
Failures throw `AdapterError` (fixed code/message, optional numeric `status`); a stream
without a protocol terminal (finish/`[DONE]`/`message_stop`/`done:true`/`messageStop`)
throws `PROVIDER_STREAM_ERROR`. Tool-call IDs are unique per response (duplicates fail).

Usage units (tokens, omitted when not reported): `inputTokens` (inclusive of cache),
`outputTokens` (inclusive of reasoning), `reasoningTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `totalTokens`.

Model: `{ id, address:'provider/id', name, provider, capabilities:{tools, vision, reasoning}, contextWindow, maxOutputTokens, inputCost?, outputCost?, source:'remote'|'configured' }`.
Costs are USD per 1M tokens and only from OpenRouter's catalog. Unknown = `null`.

### Capabilities

Provider/adapter level (`client.capabilities`): `streaming`, `tools` (wire codec supports
tool calls), `vision` (always `false`: adapters send text only), `reasoning`,
`modelDiscovery`, `promptCaching` (`true`/`null`, informational), `structuredOutput`
(`'json_schema'|'json_object'|false`), `stage`, `nativeInference`. A wire capability does
not prove the selected model supports it: model-level `capabilities` come only from
catalogs that report them (OpenRouter, Mistral, Anthropic, Gemini, Bedrock modalities);
everything else stays `null`.

### Stages

`runStage({stage, model, instructions, input, outputSchema, maxOutputBytes, signal})` →
`{provider, stage, output, usage, experimental, unofficial}`.

1. `outputSchema` admitted before any network use (`schema.mjs`): subset `type,
   properties, required, items, enum, const, min/maxLength, minimum/maximum,
   exclusive*, min/maxItems, uniqueItems, additionalProperties, pattern` (+ annotations);
   `$ref`, combinators, conditionals, `patternProperties` refused; depth ≤ 24, ≤ 4096
   nodes; regex ≤ 256 chars with no backreferences, lookaround or nested quantifiers.
   Injected `validateStageSchema` runs too.
2. No tools offered; a tool call fails the stage. Text is capped at `maxOutputBytes`
   (≤ 4 MiB, so the 1,600,000-byte implementation stage fits) and the request is
   cancelled as soon as the cap is exceeded. Whole stream ≤ 32 MiB.
3. Finish must be `stop` (`length` → `STAGE_INCOMPLETE`, filter →
   `PROVIDER_CONTENT_FILTERED`). Optional fenced JSON is accepted; prose is not.
4. Output revalidated locally, then by injected `validateStageOutput`.
5. Official adapters return `experimental:false, unofficial:false`; Codex always
   `true/true`. The core must still stamp the selected AuthMethod's metadata on results.

## 2. Transport and privacy policy

- One request per operation; **no retry, no replay, no fallback** (Bedrock
  `maxAttempts: 1`). Redirects are never followed (`redirect:'manual'`, 3xx refused).
- Endpoint validation refuses userinfo, query, fragment, dot segments, encoded
  separators, `//`, repeated version segments (`/v1/v1`), bases that already end in an
  endpoint path, non-loopback HTTP, control characters and backslashes.
- Headers: token-syntax names, no CR/LF/NUL, ≤ 8 KiB, ≤ 32 extra; hop-by-hop, `host`,
  `cookie`, `proxy-*`, `sec-*` refused; protocol-managed names cannot be overridden.
- Timeouts: first byte 120 s, idle 120 s, total 15 min (bounded overrides).
  Bounds: JSON catalogs 4 MiB, error body read ≤ 16 KiB (only for local
  classification), stream 32 MiB, line 1 MiB, SSE event 4 MiB, text 8 MiB, tool args
  1 MiB/call, 64 calls, 20 catalog pages, 5000 models.
- UTF-8 decoding is incremental and fatal on invalid bytes; LF/CRLF/CR split safely
  across chunks.
- Errors never carry remote bodies, header values, URLs, credentials or stacks; HTTP
  status maps to fixed codes (401/403/404/408/413/429/5xx/3xx); context-overflow is
  classified locally from the bounded error body.

## 3. Support matrix

Coverage legend: **F** loopback HTTP fixture tests, **R** replay of genuine recorded
vendor responses (Kilo recordings) through the real adapter over loopback,
**S** real official SDK against a loopback endpoint. No live vendor call was made.

| Provider | apiType | Auth (kind / env) | Discovery | Tools | Coverage | Support |
| --- | --- | --- | --- | --- | --- | --- |
| ZUKU AI | zuku | bearer (ZUKU account JWT) | `GET /api/v1/aist/models` | — | F | catalog-only |
| OpenAI | openai-responses (or openai-chat) | api-key `OPENAI_API_KEY` | `GET /v1/models` (ids only) | yes | F R | available |
| Anthropic | anthropic | api-key `ANTHROPIC_API_KEY` | `GET /v1/models` (`after_id` paging) | yes | F R | available |
| Google Gemini | gemini | api-key `GEMINI_API_KEY` | `GET /v1beta/models` (`pageToken`) | yes | F R | available |
| OpenRouter | openai-chat | api-key `OPENROUTER_API_KEY` | `GET /api/v1/models` (caps/costs) | yes | F R | available |
| AWS Bedrock | bedrock | cloud-chain (AWS default chain) | ListFoundationModels + ListInferenceProfiles | yes | S R | requires-sdk |
| Google Vertex AI | vertex | cloud-chain (ADC) or bearer | `GET v1beta1/publishers/google/models` | yes | S R F | requires-sdk |
| Azure OpenAI | azure-openai | api-key `AZURE_OPENAI_API_KEY` | none (deployment names configured) | yes | F | requires-config |
| Ollama | ollama | none (loopback) | `GET /api/tags` | yes (no forced choice) | F | available |
| LM Studio | openai-chat | none (loopback) | `GET /v1/models` | yes | F | available |
| Custom OpenAI Chat / Responses / Anthropic | as chosen | api-key/bearer/none, experimental | `GET /models` if `catalog:'openai'` | yes | F | available |
| Mistral | openai-chat | `MISTRAL_API_KEY` | `GET /v1/models` (capabilities) | yes | F | available |
| DeepSeek | openai-chat | `DEEPSEEK_API_KEY` | `GET /v1/models` | yes | F R | available |
| Groq | openai-chat | `GROQ_API_KEY` | `GET /openai/v1/models` | yes | F R | available |
| xAI | openai-chat | `XAI_API_KEY` | `GET /v1/models` | yes | F | available |
| Qwen (Alibaba Model Studio, intl) | openai-chat | `DASHSCOPE_API_KEY` | none | yes | F (shared codec) | available |
| Together AI | openai-chat | `TOGETHER_API_KEY` | `GET /v1/models` (bare array) | yes | F R | available |
| Fireworks AI | openai-chat | `FIREWORKS_API_KEY` | none | yes | F (shared codec) | available |
| Cerebras | openai-chat | `CEREBRAS_API_KEY` | `GET /v1/models` | yes | F | available |
| SambaNova | openai-chat | `SAMBANOVA_API_KEY` | `GET /v1/models` | yes | F | available |
| Hugging Face Inference Providers | openai-chat | `HF_TOKEN` | `GET /v1/models` | yes | F (shared codec) | available |
| DeepInfra | openai-chat | `DEEPINFRA_API_KEY` | `GET /v1/openai/models` | yes | F (shared codec) | available |
| Vercel AI Gateway | openai-chat | `AI_GATEWAY_API_KEY` | `GET /v1/models` | yes | F (shared codec) | available |
| Venice AI | openai-chat | `VENICE_API_KEY` | `GET /api/v1/models` | yes | F (shared codec) | available |
| Perplexity | openai-chat | `PERPLEXITY_API_KEY` | none | no | F (shared codec) | available |
| Cloudflare AI Gateway | openai-chat | api-key `CLOUDFLARE_API_TOKEN` → `cf-aig-authorization` | none | yes | F R | requires-config |
| Codex (ChatGPT account) | codex | own-client OAuth **(exp!)** | configured | JSON stages only | F (wrapper) | experimental-opt-in |

"Shared codec" rows reuse the fully tested OpenAI Chat codec; their vendor-specific
deviations were not separately exercised. Discovery is marked `none` wherever a
current list endpoint could not be verified — those providers use user-configured
model IDs and never a fabricated catalog.

Evaluated from the Kilo inventory but **not** added: GitHub Copilot and GitLab (no
official API-key route; no invented OAuth), Kilo Gateway (Kilo's own account),
Cohere (needs its native v2 chat protocol for parity), Baseten/MiniMax/Moonshot/Z.ai
(not requested; trivially addable as OpenAI-compatible profiles once verified),
Vertex partner models (Anthropic `rawPredict`, different wire), Azure Entra ID (needs
`@azure/identity`). Bedrock API keys are not wired as an explicit method; note that the
official SDK itself honours `AWS_BEARER_TOKEN_BEDROCK` when present in the process
environment (AWS-documented behaviour inside the selected `cloud-chain`).

## 4. Verification sources

The vendor documentation hosts (docs.anthropic.com, platform.openai.com, ai.google.dev,
cloud.google.com, learn.microsoft.com, docs.aws.amazon.com, docs.ollama.com,
openrouter.ai, lmstudio.ai) were unreachable from the build sandbox, so contracts were
verified against first-party sources reachable on GitHub/npm instead:

- Kilo Code `packages/llm/src/protocols/*` and `providers/*` and the **recorded live
  wire responses** in `packages/llm/test/fixtures/recordings` (pinned SHA below).
- Anthropic `anthropic-sdk-typescript` `src/resources/models.ts`, `src/core/pagination.ts`.
- OpenAI `openai-node` `src/resources/models.ts`.
- Google `googleapis/js-genai` `src/_api_client.ts`, `_transformers.ts`,
  `converters/_models_converters.ts`, `node/_node_auth.ts` (endpoints, versions, scopes).
- `ollama/ollama` `docs/api.md` (`/api/chat`, `/api/tags`).
- OpenRouter `typescript-sdk` model schemas; Mistral `client-ts` model card/capabilities.
- AWS SDK v3 `client-bedrock-runtime`/`client-bedrock` 3.1146.0 type models.

## 5. Native ZUKU boundary

Only `GET {https://www.zuzunza.com/api/v1}/aist/models` with the user's ZUKU access
token is wired (envelope `{success, data:{models|[]}, default_model}`; unknown shapes
fail with `PROVIDER_RESPONSE_INVALID`). `zuku/auto` is listed as `configured`. The
AIST project chat/run routes are fixed-file patch runs, so `stream()`/`runStage()` throw
`ADAPTER_NATIVE_UNAVAILABLE` before any request. The games-only OAuth scopes are not
accepted. When the canonical native contract is frozen, root injects
`context.nativeZuku` (`runStage`, optional `stream`); results are stamped
`experimental:false, unofficial:false`.

## 6. Codex bridge

Wraps the existing, unmodified `createCodexOAuth({storePath?, fetchImpl?})` and
`createCodexResponsesProvider({oauth, fetchImpl?})` supplied as
`context.codexModules`. `storePath` is passed only when `context.codexStorePath` is
explicit (default platform path, e.g. `%LOCALAPPDATA%/ZukuJS`, is preserved). The
generic credential getter, environment and personal Codex login state are never
used. `runStage` requires an explicit bare model ID; usage is normalized from
`input_tokens/output_tokens/total_tokens`; results are always
`experimental:true, unofficial:true`. `stream()` is unsupported (JSON stages only).

## 7. Dependencies requested from root

Lazy-loaded only by the selected Bedrock/Vertex adapters (Node ≥ 22 compatible):

- `@aws-sdk/client-bedrock-runtime@3.1146.0` (Apache-2.0, engines node ≥ 20)
- `@aws-sdk/client-bedrock@3.1146.0` (Apache-2.0, engines node ≥ 20)
- `google-auth-library@11.1.0` (Apache-2.0, engines node ≥ 22)

Without them those adapters report `ADAPTER_SDK_UNAVAILABLE`, and SDK tests are
skipped (`ZUKU_TEST_SDK_DIR=<dir with these installed>` runs them).

## 8. Provenance and license

Patterns adapted (re-implemented natively, not copied) from Kilo Code
<https://github.com/Kilo-Org/kilocode> at commit
`76bcfd40be616a72f4697b3041565f322245b462`, MIT License —
Copyright (c) 2026 Kilo Code, Copyright (c) 2025 opencode:

| Kilo path | Applied pattern |
| --- | --- |
| `packages/llm/src/protocols/openai-chat.ts` | index-keyed tool-call deltas, `reasoning_content`, usage-only trailing chunk, finish mapping |
| `packages/llm/src/protocols/openai-responses.ts` | typed event dispatch, function_call item/call_id mapping, incomplete/failed terminals |
| `packages/llm/src/protocols/anthropic-messages.ts` | block-index state machine, `input_json_delta`, cache-inclusive usage |
| `packages/llm/src/protocols/gemini.ts`, `utils/gemini-tool-schema.ts` | thought parts, candidates+thoughts output usage, tool-schema projection |
| `packages/llm/src/protocols/bedrock-converse.ts` | Converse message/tool mapping, stream member handling |
| `packages/llm/src/providers/{openai-compatible-profile,azure,cloudflare,openrouter}.ts` | vendor base URLs, Azure v1 `api-key`, Cloudflare gateway URL/header, OpenRouter usage option |
| `packages/opencode/src/provider/provider.ts` | registry-of-factories (no distributed provider switch) |

The test file `tests/provider-adapters-recorded.test.mjs` and the recorded bodies in
`tests/provider-adapters-cloud.test.mjs` embed verbatim recordings from
`packages/llm/test/fixtures/recordings` under the same MIT notice:

```text
MIT License

Copyright (c) 2026 Kilo Code
Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The package's own license (`SOL`) is unchanged.
