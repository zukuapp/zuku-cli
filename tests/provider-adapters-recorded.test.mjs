// Replays genuine vendor wire responses through the real adapters over loopback
// HTTP. Response bodies are verbatim recordings from Kilo Code
// packages/llm/test/fixtures/recordings at commit
// 76bcfd40be616a72f4697b3041565f322245b462 (MIT License,
// Copyright (c) 2026 Kilo Code, Copyright (c) 2025 opencode). Each was captured
// from the live vendor API by upstream; nothing here calls a vendor.
// Expected usage/tool-call/finish values were derived from those bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAdapter, listBuiltinDescriptors } from '../lib/provider-system/adapters/index.mjs';

const KEY = 'fixture_only_recording_key';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const RECORDINGS = [
 {
  "name": "openai-chat/streams-tool-call.json#0",
  "provider": "openai",
  "apiType": "openai-chat",
  "path": "/v1/chat/completions",
  "model": "gpt-4o-mini",
  "contentType": "text/event-stream; charset=utf-8",
  "body": "data: {\"id\":\"chatcmpl-DcLQgGuIIwnMHqZMRCOwZMLir5SkK\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_d0a1738203\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"index\":0,\"id\":\"call_5wBV98AvGPwOyC6a2HtKh85w\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}],\"refusal\":null},\"logprobs\":null,\"finish_reason\":null}],\"usage\":null,\"obfuscation\":\"hrw8\"}\n\ndata: {\"id\":\"chatcmpl-DcLQgGuIIwnMHqZMRCOwZMLir5SkK\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_d0a1738203\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"\"}}]},\"logprobs\":null,\"finish_reason\":null}],\"usage\":null,\"obfuscation\":\"MzOlaTohF20Sbb\"}\n\ndata: {\"id\":\"chatcmpl-DcLQgGuIIwnMHqZMRCOwZMLir5SkK\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_d0a1738203\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"city\"}}]},\"logprobs\":null,\"finish_reason\":null}],\"usage\":null,\"obfuscation\":\"QuYBQ5vYEUVxR\"}\n\ndata: {\"id\":\"chatcmpl-DcLQgGuIIwnMHqZMRCOwZMLir5SkK\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_d0a1738203\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\":\\\"\"}}]},\"logprobs\":null,\"finish_reason\":null}],\"usage\":null,\"obfuscation\":\"spyXlsV2hl6l\"}\n\ndata: {\"id\":\"chatcmpl-DcLQgGuIIwnMHqZMRCOwZMLir5SkK\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_d0a1738203\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"Paris\"}}]},\"logprobs\":null,\"finish_reason\":null}],\"usage\":null,\"obfuscation\":\"Db1cjFKa6YAI\"}\n\ndata: {\"id\":\"chatcmpl-DcLQgGuIIwnMHqZMRCOwZMLir5SkK\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_d0a1738203\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"}\"}}]},\"logprobs\":null,\"finish_reason\":null}],\"usage\":null,\"obfuscation\":\"oPu35nrhXcjTL5\"}\n\ndata: {\"id\":\"chatcmpl-DcLQgGuIIwnMHqZMRCOwZMLir5SkK\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_d0a1738203\",\"choices\":[{\"index\":0,\"delta\":{},\"logprobs\":null,\"finish_reason\":\"stop\"}],\"usage\":null,\"obfuscation\":\"63TVy\"}\n\ndata: {\"id\":\"chatcmpl-DcLQgGuIIwnMHqZMRCOwZMLir5SkK\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_d0a1738203\",\"choices\":[],\"usage\":{\"prompt_tokens\":67,\"completion_tokens\":5,\"total_tokens\":72,\"prompt_tokens_details\":{\"cached_tokens\":0,\"audio_tokens\":0},\"completion_tokens_details\":{\"reasoning_tokens\":0,\"audio_tokens\":0,\"accepted_prediction_tokens\":0,\"rejected_prediction_tokens\":0}},\"obfuscation\":\"NxJjur40z4H\"}\n\ndata: [DONE]\n\n",
  "expect": {
   "usage": {
    "inputTokens": 67,
    "outputTokens": 5,
    "reasoningTokens": 0,
    "cacheReadTokens": 0,
    "totalTokens": 72
   },
   "tools": [
    [
     "get_weather",
     {
      "city": "Paris"
     }
    ]
   ],
   "finish": "tool-calls"
  }
 },
 {
  "name": "openai-chat/streams-text.json#0",
  "provider": "openai",
  "apiType": "openai-chat",
  "path": "/v1/chat/completions",
  "model": "gpt-4o-mini",
  "contentType": "text/event-stream; charset=utf-8",
  "body": "data: {\"id\":\"chatcmpl-DcLQgbFetadY4JFl0fHK0g7OYsCOL\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_57133166c6\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\",\"refusal\":null},\"logprobs\":null,\"finish_reason\":null}],\"usage\":null,\"obfuscation\":\"g9SWm2h6J\"}\n\ndata: {\"id\":\"chatcmpl-DcLQgbFetadY4JFl0fHK0g7OYsCOL\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_57133166c6\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"},\"logprobs\":null,\"finish_reason\":null}],\"usage\":null,\"obfuscation\":\"lVzwlh\"}\n\ndata: {\"id\":\"chatcmpl-DcLQgbFetadY4JFl0fHK0g7OYsCOL\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_57133166c6\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"!\"},\"logprobs\":null,\"finish_reason\":null}],\"usage\":null,\"obfuscation\":\"onzhziaLGv\"}\n\ndata: {\"id\":\"chatcmpl-DcLQgbFetadY4JFl0fHK0g7OYsCOL\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_57133166c6\",\"choices\":[{\"index\":0,\"delta\":{},\"logprobs\":null,\"finish_reason\":\"stop\"}],\"usage\":null,\"obfuscation\":\"LzUj1\"}\n\ndata: {\"id\":\"chatcmpl-DcLQgbFetadY4JFl0fHK0g7OYsCOL\",\"object\":\"chat.completion.chunk\",\"created\":1778031210,\"model\":\"gpt-4o-mini-2024-07-18\",\"service_tier\":\"default\",\"system_fingerprint\":\"fp_57133166c6\",\"choices\":[],\"usage\":{\"prompt_tokens\":22,\"completion_tokens\":2,\"total_tokens\":24,\"prompt_tokens_details\":{\"cached_tokens\":0,\"audio_tokens\":0},\"completion_tokens_details\":{\"reasoning_tokens\":0,\"audio_tokens\":0,\"accepted_prediction_tokens\":0,\"rejected_prediction_tokens\":0}},\"obfuscation\":\"emMuPcvvOkI\"}\n\ndata: [DONE]\n\n",
  "expect": {
   "usage": {
    "inputTokens": 22,
    "outputTokens": 2,
    "reasoningTokens": 0,
    "cacheReadTokens": 0,
    "totalTokens": 24
   },
   "tools": [],
   "finish": "stop"
  }
 },
 {
  "name": "openai-compatible-chat/deepseek-streams-text.json#0",
  "provider": "deepseek",
  "apiType": null,
  "path": "/v1/chat/completions",
  "model": "deepseek-chat",
  "contentType": "text/event-stream; charset=utf-8",
  "body": "data: {\"id\":\"0c811926-1e0c-4160-baf8-6e71247c8ad7\",\"object\":\"chat.completion.chunk\",\"created\":1777411128,\"model\":\"deepseek-v4-flash\",\"system_fingerprint\":\"fp_058df29938_prod0820_fp8_kvcache_20260402\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"logprobs\":null,\"finish_reason\":null}]}\n\ndata: {\"id\":\"0c811926-1e0c-4160-baf8-6e71247c8ad7\",\"object\":\"chat.completion.chunk\",\"created\":1777411128,\"model\":\"deepseek-v4-flash\",\"system_fingerprint\":\"fp_058df29938_prod0820_fp8_kvcache_20260402\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"},\"logprobs\":null,\"finish_reason\":null}]}\n\ndata: {\"id\":\"0c811926-1e0c-4160-baf8-6e71247c8ad7\",\"object\":\"chat.completion.chunk\",\"created\":1777411128,\"model\":\"deepseek-v4-flash\",\"system_fingerprint\":\"fp_058df29938_prod0820_fp8_kvcache_20260402\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"!\"},\"logprobs\":null,\"finish_reason\":null}]}\n\ndata: {\"id\":\"0c811926-1e0c-4160-baf8-6e71247c8ad7\",\"object\":\"chat.completion.chunk\",\"created\":1777411128,\"model\":\"deepseek-v4-flash\",\"system_fingerprint\":\"fp_058df29938_prod0820_fp8_kvcache_20260402\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\"},\"logprobs\":null,\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":14,\"completion_tokens\":2,\"total_tokens\":16,\"prompt_tokens_details\":{\"cached_tokens\":0},\"prompt_cache_hit_tokens\":0,\"prompt_cache_miss_tokens\":14}}\n\ndata: [DONE]\n\n",
  "expect": {
   "usage": {
    "inputTokens": 14,
    "outputTokens": 2,
    "cacheReadTokens": 0,
    "totalTokens": 16
   },
   "tools": [],
   "finish": "stop"
  }
 },
 {
  "name": "openai-compatible-chat/groq-streams-tool-call.json#0",
  "provider": "groq",
  "apiType": null,
  "path": "/openai/v1/chat/completions",
  "model": "llama-3.3-70b-versatile",
  "contentType": "text/event-stream",
  "body": "data: {\"id\":\"chatcmpl-05380361-f8e4-444a-ae80-296b4d1d46f7\",\"object\":\"chat.completion.chunk\",\"created\":1778031305,\"model\":\"llama-3.3-70b-versatile\",\"system_fingerprint\":\"fp_0761e44d7b\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":null},\"logprobs\":null,\"finish_reason\":null}],\"x_groq\":{\"id\":\"req_01kqxes8v4fm7baf4smt42f0qn\",\"seed\":1846647562}}\n\ndata: {\"id\":\"chatcmpl-05380361-f8e4-444a-ae80-296b4d1d46f7\",\"object\":\"chat.completion.chunk\",\"created\":1778031305,\"model\":\"llama-3.3-70b-versatile\",\"system_fingerprint\":\"fp_0761e44d7b\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"id\":\"mcf2d8nn1\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\"},\"index\":0}]},\"logprobs\":null,\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-05380361-f8e4-444a-ae80-296b4d1d46f7\",\"object\":\"chat.completion.chunk\",\"created\":1778031305,\"model\":\"llama-3.3-70b-versatile\",\"system_fingerprint\":\"fp_0761e44d7b\",\"choices\":[{\"index\":0,\"delta\":{},\"logprobs\":null,\"finish_reason\":\"tool_calls\"}],\"x_groq\":{\"id\":\"req_01kqxes8v4fm7baf4smt42f0qn\",\"usage\":{\"queue_time\":0.07684935,\"prompt_tokens\":249,\"prompt_time\":0.014815006,\"completion_tokens\":10,\"completion_time\":0.036435756,\"total_tokens\":259,\"total_time\":0.051250762}},\"usage\":{\"queue_time\":0.07684935,\"prompt_tokens\":249,\"prompt_time\":0.014815006,\"completion_tokens\":10,\"completion_time\":0.036435756,\"total_tokens\":259,\"total_time\":0.051250762}}\n\ndata: {\"id\":\"chatcmpl-05380361-f8e4-444a-ae80-296b4d1d46f7\",\"object\":\"chat.completion.chunk\",\"created\":1778031305,\"model\":\"llama-3.3-70b-versatile\",\"system_fingerprint\":\"fp_0761e44d7b\",\"choices\":[],\"usage\":{\"queue_time\":0.07684935,\"prompt_tokens\":249,\"prompt_time\":0.014815006,\"completion_tokens\":10,\"completion_time\":0.036435756,\"total_tokens\":259,\"total_time\":0.051250762},\"service_tier\":\"on_demand\"}\n\ndata: [DONE]\n\n",
  "expect": {
   "usage": {
    "inputTokens": 249,
    "outputTokens": 10,
    "totalTokens": 259
   },
   "tools": [
    [
     "get_weather",
     {
      "city": "Paris"
     }
    ]
   ],
   "finish": "tool-calls"
  }
 },
 {
  "name": "openai-compatible-chat/openrouter-streams-tool-call.json#0",
  "provider": "openrouter",
  "apiType": null,
  "path": "/api/v1/chat/completions",
  "model": "openai/gpt-4o-mini",
  "contentType": "text/event-stream",
  "body": ": OPENROUTER PROCESSING\n\ndata: {\"id\":\"gen-1778031306-HYzOq04JIk1hZQ4iaNjD\",\"object\":\"chat.completion.chunk\",\"created\":1778031306,\"model\":\"openai/gpt-4o-mini\",\"provider\":\"OpenAI\",\"system_fingerprint\":\"fp_b6580bbee1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":null,\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_L7mHMq49ZSUTBHjLJfBIP2eT\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}]},\"finish_reason\":null,\"native_finish_reason\":null}]}\n\ndata: {\"id\":\"gen-1778031306-HYzOq04JIk1hZQ4iaNjD\",\"object\":\"chat.completion.chunk\",\"created\":1778031306,\"model\":\"openai/gpt-4o-mini\",\"provider\":\"OpenAI\",\"system_fingerprint\":\"fp_b6580bbee1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":null,\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\"}}]},\"finish_reason\":null,\"native_finish_reason\":null}]}\n\ndata: {\"id\":\"gen-1778031306-HYzOq04JIk1hZQ4iaNjD\",\"object\":\"chat.completion.chunk\",\"created\":1778031306,\"model\":\"openai/gpt-4o-mini\",\"provider\":\"OpenAI\",\"system_fingerprint\":\"fp_b6580bbee1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":null,\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"\"}}]},\"finish_reason\":null,\"native_finish_reason\":null}]}\n\ndata: {\"id\":\"gen-1778031306-HYzOq04JIk1hZQ4iaNjD\",\"object\":\"chat.completion.chunk\",\"created\":1778031306,\"model\":\"openai/gpt-4o-mini\",\"provider\":\"OpenAI\",\"system_fingerprint\":\"fp_b6580bbee1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":null,\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"city\"}}]},\"finish_reason\":null,\"native_finish_reason\":null}]}\n\ndata: {\"id\":\"gen-1778031306-HYzOq04JIk1hZQ4iaNjD\",\"object\":\"chat.completion.chunk\",\"created\":1778031306,\"model\":\"openai/gpt-4o-mini\",\"provider\":\"OpenAI\",\"system_fingerprint\":\"fp_b6580bbee1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":null,\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\":\\\"\"}}]},\"finish_reason\":null,\"native_finish_reason\":null}]}\n\ndata: {\"id\":\"gen-1778031306-HYzOq04JIk1hZQ4iaNjD\",\"object\":\"chat.completion.chunk\",\"created\":1778031306,\"model\":\"openai/gpt-4o-mini\",\"provider\":\"OpenAI\",\"system_fingerprint\":\"fp_b6580bbee1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":null,\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"Paris\"}}]},\"finish_reason\":null,\"native_finish_reason\":null}]}\n\ndata: {\"id\":\"gen-1778031306-HYzOq04JIk1hZQ4iaNjD\",\"object\":\"chat.completion.chunk\",\"created\":1778031306,\"model\":\"openai/gpt-4o-mini\",\"provider\":\"OpenAI\",\"system_fingerprint\":\"fp_b6580bbee1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":null,\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"}\"}}]},\"finish_reason\":null,\"native_finish_reason\":null}]}\n\ndata: {\"id\":\"gen-1778031306-HYzOq04JIk1hZQ4iaNjD\",\"object\":\"chat.completion.chunk\",\"created\":1778031306,\"model\":\"openai/gpt-4o-mini\",\"provider\":\"OpenAI\",\"system_fingerprint\":\"fp_b6580bbee1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\",\"role\":\"assistant\"},\"finish_reason\":\"tool_calls\",\"native_finish_reason\":\"stop\"}]}\n\ndata: {\"id\":\"gen-1778031306-HYzOq04JIk1hZQ4iaNjD\",\"object\":\"chat.completion.chunk\",\"created\":1778031306,\"model\":\"openai/gpt-4o-mini\",\"provider\":\"OpenAI\",\"system_fingerprint\":\"fp_b6580bbee1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\",\"role\":\"assistant\"},\"finish_reason\":\"tool_calls\",\"native_finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":67,\"completion_tokens\":5,\"total_tokens\":72,\"cost\":0.00001305,\"is_byok\":false,\"prompt_tokens_details\":{\"cached_tokens\":0,\"cache_write_tokens\":0,\"audio_tokens\":0,\"video_tokens\":0},\"cost_details\":{\"upstream_inference_cost\":0.00001305,\"upstream_inference_prompt_cost\":0.00001005,\"upstream_inference_completions_cost\":0.000003},\"completion_tokens_details\":{\"reasoning_tokens\":0,\"image_tokens\":0,\"audio_tokens\":0}}}\n\ndata: [DONE]\n\n",
  "expect": {
   "usage": {
    "inputTokens": 67,
    "outputTokens": 5,
    "reasoningTokens": 0,
    "cacheReadTokens": 0,
    "totalTokens": 72
   },
   "tools": [
    [
     "get_weather",
     {
      "city": "Paris"
     }
    ]
   ],
   "finish": "tool-calls"
  }
 },
 {
  "name": "openai-compatible-chat/togetherai-streams-tool-call.json#0",
  "provider": "togetherai",
  "apiType": null,
  "path": "/v1/chat/completions",
  "model": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  "contentType": "text/event-stream;charset=utf-8",
  "body": "data: {\"id\":\"ogzjfRD-6Ng1vN-9f391a2bb8ca75e1\",\"object\":\"chat.completion.chunk\",\"created\":1777411135,\"choices\":[{\"index\":0,\"role\":\"assistant\",\"text\":\"\",\"logprobs\":null,\"finish_reason\":null,\"delta\":{\"token_id\":null,\"role\":\"assistant\",\"content\":\"\"}}],\"model\":\"meta-llama/Llama-3.3-70B-Instruct-Turbo\"}\n\ndata: {\"id\":\"ogzjfRD-6Ng1vN-9f391a2bb8ca75e1\",\"object\":\"chat.completion.chunk\",\"created\":1777411135,\"choices\":[{\"index\":0,\"text\":\"\",\"logprobs\":null,\"finish_reason\":null,\"delta\":{\"token_id\":null,\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"index\":0,\"id\":\"call_yu1mxtmex7x48nximi9c8jpo\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}]}}],\"model\":\"meta-llama/Llama-3.3-70B-Instruct-Turbo\"}\n\ndata: {\"id\":\"ogzjfRD-6Ng1vN-9f391a2bb8ca75e1\",\"object\":\"chat.completion.chunk\",\"created\":1777411135,\"choices\":[{\"index\":0,\"text\":\"\",\"logprobs\":null,\"finish_reason\":\"tool_calls\",\"delta\":{\"token_id\":null,\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\"}}]}}],\"model\":\"meta-llama/Llama-3.3-70B-Instruct-Turbo\"}\n\ndata: {\"id\":\"ogzjfRD-6Ng1vN-9f391a2bb8ca75e1\",\"object\":\"chat.completion.chunk\",\"created\":1777411135,\"choices\":[{\"index\":0,\"text\":\"\",\"logprobs\":null,\"finish_reason\":\"tool_calls\",\"seed\":9033012299842426000,\"delta\":{\"token_id\":128009,\"role\":\"assistant\",\"content\":\"\"}}],\"model\":\"meta-llama/Llama-3.3-70B-Instruct-Turbo\",\"usage\":{\"prompt_tokens\":194,\"completion_tokens\":19,\"total_tokens\":213,\"cached_tokens\":0}}\n\ndata: [DONE]\n\n",
  "expect": {
   "usage": {
    "inputTokens": 194,
    "outputTokens": 19,
    "totalTokens": 213
   },
   "tools": [
    [
     "get_weather",
     {
      "city": "Paris"
     }
    ]
   ],
   "finish": "tool-calls"
  }
 },
 {
  "name": "cloudflare-ai-gateway/cloudflare-ai-gateway-workers-ai-gpt-oss-20b-tools-tool-call.json#0",
  "provider": "cloudflare-ai-gateway",
  "apiType": null,
  "path": "/v1/{account}/{gateway}/compat/chat/completions",
  "model": "workers-ai/@cf/openai/gpt-oss-20b",
  "contentType": "text/event-stream",
  "body": "data: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"logprobs\":null,\"finish_reason\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"We\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\" need\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\" to\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\" call\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\" the\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\" function\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\" get\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"_weather\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\" with\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\" city\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\" \\\"\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"Paris\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"\\\".\"},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"id\":\"chatcmpl-tool-b975da5af1f843e095ba7062d8e108ba\",\"type\":\"function\",\"index\":0,\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}]},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"\"}}]},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"city\"}}]},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\":\\\"\"}}]},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"Paris\"}}]},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"}\"}}]},\"logprobs\":null,\"finish_reason\":null,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"logprobs\":null,\"finish_reason\":\"tool_calls\",\"stop_reason\":200012,\"token_ids\":null}]}\n\ndata: {\"id\":\"id-1778260808196\",\"object\":\"chat.completion.chunk\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":136,\"total_tokens\":173,\"completion_tokens\":37}}\n\ndata: {\"id\":\"id-1778260808196\",\"object\":\"chat.completion.chunk\",\"created\":1778260808,\"model\":\"@cf/openai/gpt-oss-20b\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":136,\"completion_tokens\":37,\"total_tokens\":173,\"prompt_tokens_details\":{\"cached_tokens\":0}}}\n\ndata: [DONE]\n\n",
  "expect": {
   "usage": {
    "inputTokens": 136,
    "outputTokens": 37,
    "cacheReadTokens": 0,
    "totalTokens": 173
   },
   "tools": [
    [
     "get_weather",
     {
      "city": "Paris"
     }
    ]
   ],
   "finish": "tool-calls"
  }
 },
 {
  "name": "openai-responses/gpt-5-5-streams-tool-call.json#0",
  "provider": "openai",
  "apiType": null,
  "path": "/v1/responses",
  "model": "gpt-5.5",
  "contentType": "text/event-stream; charset=utf-8",
  "body": "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_05200a06f78f5b310069fa8aa28134819eba958e34eb1db6ae\",\"object\":\"response\",\"created_at\":1778027170,\"status\":\"in_progress\",\"background\":false,\"completed_at\":null,\"error\":null,\"frequency_penalty\":0.0,\"incomplete_details\":null,\"instructions\":null,\"max_output_tokens\":80,\"max_tool_calls\":null,\"model\":\"gpt-5.5-2026-04-23\",\"moderation\":null,\"output\":[],\"parallel_tool_calls\":true,\"presence_penalty\":0.0,\"previous_response_id\":null,\"prompt_cache_key\":null,\"prompt_cache_retention\":\"24h\",\"reasoning\":{\"effort\":\"medium\",\"summary\":null},\"safety_identifier\":null,\"service_tier\":\"auto\",\"store\":true,\"temperature\":1.0,\"text\":{\"format\":{\"type\":\"text\"},\"verbosity\":\"medium\"},\"tool_choice\":{\"type\":\"function\",\"name\":\"get_weather\"},\"tools\":[{\"type\":\"function\",\"description\":\"Get current weather for a city.\",\"name\":\"get_weather\",\"parameters\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"],\"additionalProperties\":false},\"strict\":true}],\"top_logprobs\":0,\"top_p\":0.98,\"truncation\":\"disabled\",\"usage\":null,\"user\":null,\"metadata\":{}},\"sequence_number\":0}\n\nevent: response.in_progress\ndata: {\"type\":\"response.in_progress\",\"response\":{\"id\":\"resp_05200a06f78f5b310069fa8aa28134819eba958e34eb1db6ae\",\"object\":\"response\",\"created_at\":1778027170,\"status\":\"in_progress\",\"background\":false,\"completed_at\":null,\"error\":null,\"frequency_penalty\":0.0,\"incomplete_details\":null,\"instructions\":null,\"max_output_tokens\":80,\"max_tool_calls\":null,\"model\":\"gpt-5.5-2026-04-23\",\"moderation\":null,\"output\":[],\"parallel_tool_calls\":true,\"presence_penalty\":0.0,\"previous_response_id\":null,\"prompt_cache_key\":null,\"prompt_cache_retention\":\"24h\",\"reasoning\":{\"effort\":\"medium\",\"summary\":null},\"safety_identifier\":null,\"service_tier\":\"auto\",\"store\":true,\"temperature\":1.0,\"text\":{\"format\":{\"type\":\"text\"},\"verbosity\":\"medium\"},\"tool_choice\":{\"type\":\"function\",\"name\":\"get_weather\"},\"tools\":[{\"type\":\"function\",\"description\":\"Get current weather for a city.\",\"name\":\"get_weather\",\"parameters\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"],\"additionalProperties\":false},\"strict\":true}],\"top_logprobs\":0,\"top_p\":0.98,\"truncation\":\"disabled\",\"usage\":null,\"user\":null,\"metadata\":{}},\"sequence_number\":1}\n\nevent: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"fc_05200a06f78f5b310069fa8aa37ca8819e9f131e85e47bcff9\",\"type\":\"function_call\",\"status\":\"in_progress\",\"arguments\":\"\",\"call_id\":\"call_ZAbAwsIFeJSyPqz3HaHRXBSn\",\"name\":\"get_weather\"},\"output_index\":0,\"sequence_number\":2}\n\nevent: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\"\",\"item_id\":\"fc_05200a06f78f5b310069fa8aa37ca8819e9f131e85e47bcff9\",\"obfuscation\":\"X7dp3R85iTgHxP\",\"output_index\":0,\"sequence_number\":3}\n\nevent: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"city\",\"item_id\":\"fc_05200a06f78f5b310069fa8aa37ca8819e9f131e85e47bcff9\",\"obfuscation\":\"ECfxJgedKWUn\",\"output_index\":0,\"sequence_number\":4}\n\nevent: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"\\\":\\\"\",\"item_id\":\"fc_05200a06f78f5b310069fa8aa37ca8819e9f131e85e47bcff9\",\"obfuscation\":\"BYRjhhZxbw5AR\",\"output_index\":0,\"sequence_number\":5}\n\nevent: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"Paris\",\"item_id\":\"fc_05200a06f78f5b310069fa8aa37ca8819e9f131e85e47bcff9\",\"obfuscation\":\"lmbnKOW4qyI\",\"output_index\":0,\"sequence_number\":6}\n\nevent: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"\\\"}\",\"item_id\":\"fc_05200a06f78f5b310069fa8aa37ca8819e9f131e85e47bcff9\",\"obfuscation\":\"2PHhvsR2H0PNaP\",\"output_index\":0,\"sequence_number\":7}\n\nevent: response.function_call_arguments.done\ndata: {\"type\":\"response.function_call_arguments.done\",\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\",\"item_id\":\"fc_05200a06f78f5b310069fa8aa37ca8819e9f131e85e47bcff9\",\"output_index\":0,\"sequence_number\":8}\n\nevent: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"fc_05200a06f78f5b310069fa8aa37ca8819e9f131e85e47bcff9\",\"type\":\"function_call\",\"status\":\"completed\",\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\",\"call_id\":\"call_ZAbAwsIFeJSyPqz3HaHRXBSn\",\"name\":\"get_weather\"},\"output_index\":0,\"sequence_number\":9}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_05200a06f78f5b310069fa8aa28134819eba958e34eb1db6ae\",\"object\":\"response\",\"created_at\":1778027170,\"status\":\"completed\",\"background\":false,\"completed_at\":1778027171,\"error\":null,\"frequency_penalty\":0.0,\"incomplete_details\":null,\"instructions\":null,\"max_output_tokens\":80,\"max_tool_calls\":null,\"model\":\"gpt-5.5-2026-04-23\",\"moderation\":null,\"output\":[{\"id\":\"fc_05200a06f78f5b310069fa8aa37ca8819e9f131e85e47bcff9\",\"type\":\"function_call\",\"status\":\"completed\",\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\",\"call_id\":\"call_ZAbAwsIFeJSyPqz3HaHRXBSn\",\"name\":\"get_weather\"}],\"parallel_tool_calls\":true,\"presence_penalty\":0.0,\"previous_response_id\":null,\"prompt_cache_key\":null,\"prompt_cache_retention\":\"24h\",\"reasoning\":{\"effort\":\"medium\",\"summary\":null},\"safety_identifier\":null,\"service_tier\":\"default\",\"store\":true,\"temperature\":1.0,\"text\":{\"format\":{\"type\":\"text\"},\"verbosity\":\"medium\"},\"tool_choice\":{\"type\":\"function\",\"name\":\"get_weather\"},\"tools\":[{\"type\":\"function\",\"description\":\"Get current weather for a city.\",\"name\":\"get_weather\",\"parameters\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"],\"additionalProperties\":false},\"strict\":true}],\"top_logprobs\":0,\"top_p\":0.98,\"truncation\":\"disabled\",\"usage\":{\"input_tokens\":61,\"input_tokens_details\":{\"cached_tokens\":0},\"output_tokens\":18,\"output_tokens_details\":{\"reasoning_tokens\":0},\"total_tokens\":79},\"user\":null,\"metadata\":{}},\"sequence_number\":10}\n\n",
  "expect": {
   "usage": {
    "inputTokens": 61,
    "outputTokens": 18,
    "reasoningTokens": 0,
    "cacheReadTokens": 0,
    "totalTokens": 79
   },
   "tools": [
    [
     "get_weather",
     {
      "city": "Paris"
     }
    ]
   ],
   "finish": "tool-calls"
  }
 },
 {
  "name": "openai-responses/openai-responses-gpt-5-5-reasoning.json#0",
  "provider": "openai",
  "apiType": null,
  "path": "/v1/responses",
  "model": "gpt-5.5",
  "contentType": "text/event-stream; charset=utf-8",
  "body": "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_05f7e55dc1d2d743016a1235e5bb3c8193b4c0e30fa316700c\",\"object\":\"response\",\"created_at\":1779578341,\"status\":\"in_progress\",\"background\":false,\"completed_at\":null,\"error\":null,\"frequency_penalty\":0.0,\"incomplete_details\":null,\"instructions\":null,\"max_output_tokens\":120,\"max_tool_calls\":null,\"model\":\"gpt-5.5-2026-04-23\",\"moderation\":null,\"output\":[],\"parallel_tool_calls\":true,\"presence_penalty\":0.0,\"previous_response_id\":null,\"prompt_cache_key\":null,\"prompt_cache_retention\":\"24h\",\"reasoning\":{\"context\":\"current_turn\",\"effort\":\"low\",\"summary\":\"detailed\"},\"safety_identifier\":null,\"service_tier\":\"auto\",\"store\":false,\"temperature\":1.0,\"text\":{\"format\":{\"type\":\"text\"},\"verbosity\":\"low\"},\"tool_choice\":\"auto\",\"tools\":[],\"top_logprobs\":0,\"top_p\":0.98,\"truncation\":\"disabled\",\"usage\":null,\"user\":null,\"metadata\":{}},\"sequence_number\":0}\n\nevent: response.in_progress\ndata: {\"type\":\"response.in_progress\",\"response\":{\"id\":\"resp_05f7e55dc1d2d743016a1235e5bb3c8193b4c0e30fa316700c\",\"object\":\"response\",\"created_at\":1779578341,\"status\":\"in_progress\",\"background\":false,\"completed_at\":null,\"error\":null,\"frequency_penalty\":0.0,\"incomplete_details\":null,\"instructions\":null,\"max_output_tokens\":120,\"max_tool_calls\":null,\"model\":\"gpt-5.5-2026-04-23\",\"moderation\":null,\"output\":[],\"parallel_tool_calls\":true,\"presence_penalty\":0.0,\"previous_response_id\":null,\"prompt_cache_key\":null,\"prompt_cache_retention\":\"24h\",\"reasoning\":{\"context\":\"current_turn\",\"effort\":\"low\",\"summary\":\"detailed\"},\"safety_identifier\":null,\"service_tier\":\"auto\",\"store\":false,\"temperature\":1.0,\"text\":{\"format\":{\"type\":\"text\"},\"verbosity\":\"low\"},\"tool_choice\":\"auto\",\"tools\":[],\"top_logprobs\":0,\"top_p\":0.98,\"truncation\":\"disabled\",\"usage\":null,\"user\":null,\"metadata\":{}},\"sequence_number\":1}\n\nevent: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"rs_05f7e55dc1d2d743016a1235e65eac8193ba914b956e3a49e1\",\"type\":\"reasoning\",\"encrypted_content\":\"gAAAAABqEjXmpkIEr1Ox1CgTHFUzuGnLwOE9YZFf7lBDRcOgQiNuTk-CopgZ20-kaosULz5cy40Ga0zkuwMFxLHSH4Cyebm9mQCMMZmzZQybp-s-yfNGm9zz7kAh_y6NbaAQZiI2iaTY5_sQwIrMsdQ56-T3_--unhlXVjEqMwdbsQOLpTg0KpAigUOJkuAl4PgCHsr6p_oTIZ5ycChpihxh6Oyuyf_YzLz-bL63kWZeu2bZFYE3WftnJNzcY5VjaNEVDlYY5IBbgCqOCc8OhLrYarwaPdhiizu1FIuhreEDiYurEQOa5jSW3wN2KGUhfDPurzguIbZ-ZhSRW58w9UgrhYOS30bQkm3EYd7w9nI5MteZruw3hIVKR__tU_2T2o7GsTxYNYLgn7Q8WoBASZrBtDpXuBM5jO2JQzDEFPG9_S8f44_LDgKInHgh-t32eV1ZNW08Pg9l0tUutiqdEVbDFKFB68Eu5PCKRKqZ18VzXI2X_YeU0DW9ld_GoSesI88rmWCmOta2AQOrVNa2uehlMRXb0wGXKzS6t31di0_PQwPj9rBdVk-N3S-FOlF5fFEGDqWBR3E0lrEOtNMeIuR8u3gGDbEacqL-Sz22Mi7AJou7trOnVH5qFqbKpfOJnxpzjOeWUYVDpmVFD81Om7Fc6zlZsv0KIEt-w5IE_dXi2_guUpu0JhowDWFI9aFcRVZ6A9z7Mrwqtkrs9QqRJws2BRUde-6MOryUcKWGfwdkNMRkAVHSlC6T3Yq44UtLqb1gJ-vasc2K9BZwRtYBVy0jif1tjrMviiNy9ltdxPVlIJ-R_4JcYtcbRQc1ovd-aQ9MprDatYE3Vnmk_O_WSnzHRxzPbftBHb_IWwir4G3lTOTi7xopkmVFidgl03h72BfbmwkzKXlMmvClRYP5u-mYyZoG50h9ag==\",\"summary\":[]},\"output_index\":0,\"sequence_number\":2}\n\nevent: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"rs_05f7e55dc1d2d743016a1235e65eac8193ba914b956e3a49e1\",\"type\":\"reasoning\",\"encrypted_content\":\"gAAAAABqEjXn9Xij0jt39Rh_0pwIWNN4jY3e6aD8Z0BBuhH_kgkhr6VNIvsDQdD8q9ju8vkF4JnhDqcfSIbdtX_8r4HHiV7O6kFEHRSiW23Z775HdB6fggaELggnLAcBN4MxzN618I2CV-pnNStMVMeUZtbV22l6o0F6n00-_5vm7KkP44JQRFrYj_iypI9AY0S0OqItcAiB6ERLLdKTJELOAzGxyeHKpQeWH3kQY9ZbSFLfUVooZjZEEBBB3sLMkvkDq6J9iIyQFKXZeo_oFvayxWFD8BwW3fVuUFcg0waG5TJwHA90iPFjOCddkk4Kn07cIwoyuM8xYquLPQ2x3jBLninoP8UyRXrQaDFR3maPtQ4HbNBf9cz5nZmXmjmZnO9Ee78ELcU_LkvmTgtozd094XVxLHg9DN-Y_s-1GMD9SgiqBNePe-1f_Sf2FD-CQsE-vDIcpmlLwxrhkXkwZ8Ws4k8NhA1Kq8DA5KYmz7S2akl2Vg2wr5ZrdH1XQBarWUIwlhTFALhTipDPinqhytnxm5MEmu09MBGXYOP5qNQ2hT2F_ibH7kM4kBQV5zVLDl6U2ZsKDt_r7F9in8YU5ffLYAd_4M9FgsJQUvC1CxLRSSQyyPKbdy0mYCrBLTo68FGV36JIj_SQBYHp9I5IIXfMfw1d78SNN_jtgs8JweLVNhOzoOFqMEYgO4zO6xa6r7E1F6YtuQ3oQ8OIEjXIeWeLsRGn51hNYA9s2hfm8Qh14rq5TMV9QhDXj0a-7FO6PIqTUr2ZqfB6Oqeb_Ut708MWtIjZ0oRSYkDddS8QzcwGbg1AFwF9okVtZZqXyItZseC9hKQ7vjh9pWaMrsKT8pYxjbB1fwKPgwTZHGzQzhkLXsp7btR5DpRP4h1-YHTsiMDlEdjtZVF0Zn7OuKTQlanB14FsmaaJq-Ty0pktr9ejKji3VmmDeIWTWKmIMvnp9nc3_Wl_Cbvschquknk7Hd12KZkyRaWq-Q==\",\"summary\":[]},\"output_index\":0,\"sequence_number\":3}\n\nevent: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"msg_05f7e55dc1d2d743016a1235e7171481938e1402264186381c\",\"type\":\"message\",\"status\":\"in_progress\",\"content\":[],\"phase\":\"final_answer\",\"role\":\"assistant\"},\"output_index\":1,\"sequence_number\":4}\n\nevent: response.content_part.added\ndata: {\"type\":\"response.content_part.added\",\"content_index\":0,\"item_id\":\"msg_05f7e55dc1d2d743016a1235e7171481938e1402264186381c\",\"output_index\":1,\"part\":{\"type\":\"output_text\",\"annotations\":[],\"logprobs\":[],\"text\":\"\"},\"sequence_number\":5}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"content_index\":0,\"delta\":\"Hello\",\"item_id\":\"msg_05f7e55dc1d2d743016a1235e7171481938e1402264186381c\",\"logprobs\":[],\"obfuscation\":\"rArO0JBBk8l\",\"output_index\":1,\"sequence_number\":6}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"content_index\":0,\"delta\":\"!\",\"item_id\":\"msg_05f7e55dc1d2d743016a1235e7171481938e1402264186381c\",\"logprobs\":[],\"obfuscation\":\"WgBYGB6udiKMN2k\",\"output_index\":1,\"sequence_number\":7}\n\nevent: response.output_text.done\ndata: {\"type\":\"response.output_text.done\",\"content_index\":0,\"item_id\":\"msg_05f7e55dc1d2d743016a1235e7171481938e1402264186381c\",\"logprobs\":[],\"output_index\":1,\"sequence_number\":8,\"text\":\"Hello!\"}\n\nevent: response.content_part.done\ndata: {\"type\":\"response.content_part.done\",\"content_index\":0,\"item_id\":\"msg_05f7e55dc1d2d743016a1235e7171481938e1402264186381c\",\"output_index\":1,\"part\":{\"type\":\"output_text\",\"annotations\":[],\"logprobs\":[],\"text\":\"Hello!\"},\"sequence_number\":9}\n\nevent: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"msg_05f7e55dc1d2d743016a1235e7171481938e1402264186381c\",\"type\":\"message\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"annotations\":[],\"logprobs\":[],\"text\":\"Hello!\"}],\"phase\":\"final_answer\",\"role\":\"assistant\"},\"output_index\":1,\"sequence_number\":10}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_05f7e55dc1d2d743016a1235e5bb3c8193b4c0e30fa316700c\",\"object\":\"response\",\"created_at\":1779578341,\"status\":\"completed\",\"background\":false,\"completed_at\":1779578343,\"error\":null,\"frequency_penalty\":0.0,\"incomplete_details\":null,\"instructions\":null,\"max_output_tokens\":120,\"max_tool_calls\":null,\"model\":\"gpt-5.5-2026-04-23\",\"moderation\":null,\"output\":[{\"id\":\"rs_05f7e55dc1d2d743016a1235e65eac8193ba914b956e3a49e1\",\"type\":\"reasoning\",\"encrypted_content\":\"gAAAAABqEjXnFOrSKMBad2Atutni2Bxu4oRnudNwadGzwBCliXn-ocbCrlL6URwbrS22k21EaNPztTRWQVOGMzldY1PrMyJQZxj479kaAPXFbXir2xv5QfL6ykVcNNb5yn8eV5flXuOPfRM1dkosOD5QtlEhOvFbW14i-WhbjU1fpTiDCbLIotPo8tkuIk-zJMSgA0jlE73Rmz2BQlT-ZSTqJA7f9hT93QMYjsWNCslk40WCbmqo4dJuuf19qg_2ktrXu5yjmde8QU-blxhPKiDsMlj4rFA1F6_pNqJ_oUgU6mwIuUDIVPLxIaV3IBDS9j9XjiBSzwtFAsotlqWv_D1vWGUKSGPQKPs31ylYvBVQMTOdXxQZ6TKPveYybka8XbAEVNTFAJjg5PDRKWikfqqH4b0W_FFVNCSSf1UIgLh2-Hf-xMRBXozAFkCoj8M_wZOqj-gYoIsaoLnm7Z15rMrNiL2aMgNc1-mB1Iw1rFTo7hdiLiEj7C0rmm77CrxkFfQgpWsVAw94xpbVO7oC4Xiy1UNB-VCCb5FLNAHyJyLd_wc0SVuEsxjllLZ-q3unHYDnZO-zuxhjZ2jodX_7tbM6PCKul5ETSxtWQztzZD3MZ8ED_kVagXNNth-BTuTB4W9678cQbkSZK0DzV50H2_NJuRgQdCROnVKiiA2mzAOl7LXzDLTdTlHOQYRKt3wvaFI1DkVD0T0_Wj3z9lI2kgx6ExtOvU9nkqnPv4gf1x2ce8Ao9uf8NgtQbqhpeGMoU0Km9AALkoCtiyIXYJWNVVYAi9JA9QS05K-S__J_GlgFg7J3_YiH8bcmMrfwryn9K6yelsLt3SBKCA9pkLVI-HFDRx19brkAQRZRlaflF7qQApps8MQBGGrvrKTui_4EAABhFmjsn8XVIGoz7f_MFoS6ijdi8LCHEf8MNquinKURmb8Cdg1Zekrbl6KGsdcPztftMKH-sO6bEWZeUWJb2KqtIDnH5jr-Qw==\",\"summary\":[]},{\"id\":\"msg_05f7e55dc1d2d743016a1235e7171481938e1402264186381c\",\"type\":\"message\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"annotations\":[],\"logprobs\":[],\"text\":\"Hello!\"}],\"phase\":\"final_answer\",\"role\":\"assistant\"}],\"parallel_tool_calls\":true,\"presence_penalty\":0.0,\"previous_response_id\":null,\"prompt_cache_key\":null,\"prompt_cache_retention\":\"24h\",\"reasoning\":{\"context\":\"current_turn\",\"effort\":\"low\",\"summary\":\"detailed\"},\"safety_identifier\":null,\"service_tier\":\"default\",\"store\":false,\"temperature\":1.0,\"text\":{\"format\":{\"type\":\"text\"},\"verbosity\":\"low\"},\"tool_choice\":\"auto\",\"tools\":[],\"top_logprobs\":0,\"top_p\":0.98,\"truncation\":\"disabled\",\"usage\":{\"input_tokens\":31,\"input_tokens_details\":{\"cached_tokens\":0},\"output_tokens\":21,\"output_tokens_details\":{\"reasoning_tokens\":13},\"total_tokens\":52},\"user\":null,\"metadata\":{}},\"sequence_number\":11}\n\n",
  "expect": {
   "usage": {
    "inputTokens": 31,
    "outputTokens": 21,
    "reasoningTokens": 13,
    "cacheReadTokens": 0,
    "totalTokens": 52
   },
   "tools": [],
   "finish": "stop"
  }
 },
 {
  "name": "openai-responses-cache/reports-cached-tokens-on-identical-second-call.json#1",
  "provider": "openai",
  "apiType": null,
  "path": "/v1/responses",
  "model": "gpt-4.1-mini",
  "contentType": "text/event-stream; charset=utf-8",
  "body": "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_06a66d5dbf005c28006a0133e48a28819d957163a92a5a56cc\",\"object\":\"response\",\"created_at\":1778463716,\"status\":\"in_progress\",\"background\":false,\"completed_at\":null,\"error\":null,\"frequency_penalty\":0.0,\"incomplete_details\":null,\"instructions\":null,\"max_output_tokens\":16,\"max_tool_calls\":null,\"model\":\"gpt-4.1-mini-2025-04-14\",\"moderation\":null,\"output\":[],\"parallel_tool_calls\":true,\"presence_penalty\":0.0,\"previous_response_id\":null,\"prompt_cache_key\":\"recorded-cache-test\",\"prompt_cache_retention\":\"in_memory\",\"reasoning\":{\"effort\":null,\"summary\":null},\"safety_identifier\":null,\"service_tier\":\"auto\",\"store\":true,\"temperature\":0.0,\"text\":{\"format\":{\"type\":\"text\"},\"verbosity\":\"medium\"},\"tool_choice\":\"auto\",\"tools\":[],\"top_logprobs\":0,\"top_p\":1.0,\"truncation\":\"disabled\",\"usage\":null,\"user\":null,\"metadata\":{}},\"sequence_number\":0}\n\nevent: response.in_progress\ndata: {\"type\":\"response.in_progress\",\"response\":{\"id\":\"resp_06a66d5dbf005c28006a0133e48a28819d957163a92a5a56cc\",\"object\":\"response\",\"created_at\":1778463716,\"status\":\"in_progress\",\"background\":false,\"completed_at\":null,\"error\":null,\"frequency_penalty\":0.0,\"incomplete_details\":null,\"instructions\":null,\"max_output_tokens\":16,\"max_tool_calls\":null,\"model\":\"gpt-4.1-mini-2025-04-14\",\"moderation\":null,\"output\":[],\"parallel_tool_calls\":true,\"presence_penalty\":0.0,\"previous_response_id\":null,\"prompt_cache_key\":\"recorded-cache-test\",\"prompt_cache_retention\":\"in_memory\",\"reasoning\":{\"effort\":null,\"summary\":null},\"safety_identifier\":null,\"service_tier\":\"auto\",\"store\":true,\"temperature\":0.0,\"text\":{\"format\":{\"type\":\"text\"},\"verbosity\":\"medium\"},\"tool_choice\":\"auto\",\"tools\":[],\"top_logprobs\":0,\"top_p\":1.0,\"truncation\":\"disabled\",\"usage\":null,\"user\":null,\"metadata\":{}},\"sequence_number\":1}\n\nevent: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"msg_06a66d5dbf005c28006a0133e6a2b0819d90b31eabe0bb0568\",\"type\":\"message\",\"status\":\"in_progress\",\"content\":[],\"role\":\"assistant\"},\"output_index\":0,\"sequence_number\":2}\n\nevent: response.content_part.added\ndata: {\"type\":\"response.content_part.added\",\"content_index\":0,\"item_id\":\"msg_06a66d5dbf005c28006a0133e6a2b0819d90b31eabe0bb0568\",\"output_index\":0,\"part\":{\"type\":\"output_text\",\"annotations\":[],\"logprobs\":[],\"text\":\"\"},\"sequence_number\":3}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"content_index\":0,\"delta\":\"Hi\",\"item_id\":\"msg_06a66d5dbf005c28006a0133e6a2b0819d90b31eabe0bb0568\",\"logprobs\":[],\"obfuscation\":\"qLgi78ygFGnuw7\",\"output_index\":0,\"sequence_number\":4}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"content_index\":0,\"delta\":\".\",\"item_id\":\"msg_06a66d5dbf005c28006a0133e6a2b0819d90b31eabe0bb0568\",\"logprobs\":[],\"obfuscation\":\"dyQaYugaXCUfkYH\",\"output_index\":0,\"sequence_number\":5}\n\nevent: response.output_text.done\ndata: {\"type\":\"response.output_text.done\",\"content_index\":0,\"item_id\":\"msg_06a66d5dbf005c28006a0133e6a2b0819d90b31eabe0bb0568\",\"logprobs\":[],\"output_index\":0,\"sequence_number\":6,\"text\":\"Hi.\"}\n\nevent: response.content_part.done\ndata: {\"type\":\"response.content_part.done\",\"content_index\":0,\"item_id\":\"msg_06a66d5dbf005c28006a0133e6a2b0819d90b31eabe0bb0568\",\"output_index\":0,\"part\":{\"type\":\"output_text\",\"annotations\":[],\"logprobs\":[],\"text\":\"Hi.\"},\"sequence_number\":7}\n\nevent: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"msg_06a66d5dbf005c28006a0133e6a2b0819d90b31eabe0bb0568\",\"type\":\"message\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"annotations\":[],\"logprobs\":[],\"text\":\"Hi.\"}],\"role\":\"assistant\"},\"output_index\":0,\"sequence_number\":8}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_06a66d5dbf005c28006a0133e48a28819d957163a92a5a56cc\",\"object\":\"response\",\"created_at\":1778463716,\"status\":\"completed\",\"background\":false,\"completed_at\":1778463718,\"error\":null,\"frequency_penalty\":0.0,\"incomplete_details\":null,\"instructions\":null,\"max_output_tokens\":16,\"max_tool_calls\":null,\"model\":\"gpt-4.1-mini-2025-04-14\",\"moderation\":null,\"output\":[{\"id\":\"msg_06a66d5dbf005c28006a0133e6a2b0819d90b31eabe0bb0568\",\"type\":\"message\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"annotations\":[],\"logprobs\":[],\"text\":\"Hi.\"}],\"role\":\"assistant\"}],\"parallel_tool_calls\":true,\"presence_penalty\":0.0,\"previous_response_id\":null,\"prompt_cache_key\":\"recorded-cache-test\",\"prompt_cache_retention\":\"in_memory\",\"reasoning\":{\"effort\":null,\"summary\":null},\"safety_identifier\":null,\"service_tier\":\"default\",\"store\":true,\"temperature\":0.0,\"text\":{\"format\":{\"type\":\"text\"},\"verbosity\":\"medium\"},\"tool_choice\":\"auto\",\"tools\":[],\"top_logprobs\":0,\"top_p\":1.0,\"truncation\":\"disabled\",\"usage\":{\"input_tokens\":4765,\"input_tokens_details\":{\"cached_tokens\":4608},\"output_tokens\":3,\"output_tokens_details\":{\"reasoning_tokens\":0},\"total_tokens\":4768},\"user\":null,\"metadata\":{}},\"sequence_number\":9}\n\n",
  "expect": {
   "usage": {
    "inputTokens": 4765,
    "outputTokens": 3,
    "reasoningTokens": 0,
    "cacheReadTokens": 4608,
    "totalTokens": 4768
   },
   "tools": [],
   "finish": "stop"
  }
 },
 {
  "name": "anthropic-messages/streams-tool-call.json#0",
  "provider": "anthropic",
  "apiType": null,
  "path": "/v1/messages",
  "model": "claude-haiku-4-5-20251001",
  "contentType": "text/event-stream; charset=utf-8",
  "body": "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_01RYgU7NUPMK4B9v8S7gVpCS\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":677,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":0},\"output_tokens\":16,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"}}             }\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_012rmAruviySvUXSjgCPWVRu\",\"name\":\"get_weather\",\"input\":{},\"caller\":{\"type\":\"direct\"}}      }\n\nevent: ping\ndata: {\"type\": \"ping\"}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\"}             }\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"city\\\":\"}    }\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\" \\\"Paris\\\"}\"}     }\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0     }\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null,\"stop_details\":null},\"usage\":{\"input_tokens\":677,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0,\"output_tokens\":33}              }\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"     }\n\n",
  "expect": {
   "usage": {
    "inputTokens": 677,
    "outputTokens": 33,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "totalTokens": 710
   },
   "tools": [
    [
     "get_weather",
     {
      "city": "Paris"
     }
    ]
   ],
   "finish": "tool-calls"
  }
 },
 {
  "name": "anthropic-messages-cache/writes-then-reads-cache-control-on-identical-second-call.json#1",
  "provider": "anthropic",
  "apiType": null,
  "path": "/v1/messages",
  "model": "claude-haiku-4-5-20251001",
  "contentType": "text/event-stream; charset=utf-8",
  "body": "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-haiku-4-5-20251001\",\"id\":\"msg_01W9dNB2vnT7HoPQmDfKyniu\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"stop_details\":null,\"usage\":{\"input_tokens\":9,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":5752,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":0},\"output_tokens\":2,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"}}       }\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}    }\n\nevent: ping\ndata: {\"type\": \"ping\"}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi.\"}              }\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0     }\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null,\"stop_details\":null},\"usage\":{\"input_tokens\":9,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":5752,\"output_tokens\":5}     }\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"               }\n\n",
  "expect": {
   "usage": {
    "inputTokens": 5761,
    "outputTokens": 5,
    "cacheReadTokens": 5752,
    "cacheWriteTokens": 0,
    "totalTokens": 5766
   },
   "tools": [],
   "finish": "stop"
  }
 },
 {
  "name": "gemini/streams-tool-call.json#0",
  "provider": "google",
  "apiType": null,
  "path": "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
  "model": "gemini-2.5-flash",
  "contentType": "text/event-stream",
  "body": "data: {\"candidates\": [{\"content\": {\"parts\": [{\"functionCall\": {\"name\": \"get_weather\",\"args\": {\"city\": \"Paris\"}},\"thoughtSignature\": \"CiQBDDnWx5RcSsS1UMbykQ5HWlrMu6wrxXGUhmZ0uRKLaMhDZaEKXwEMOdbHVoJAlfbOQyKB378pDZ/gkjWr3HP+dWw1us1kMG22g4G3oJvuTq/SrWS+7KYtSlvOxCKhW2l/2/TczpyGyGmANmsusDcxF1SKOYA5/8Hg0nI24MAlT3+91V/MCoUBAQw51seClFLy3E71v2H44F1kpmjgz8FeTRZofrjbaazfrT+w8Yxgdr3UgGagLMY4OadZemQTWckq9IAqRum78hrBg6NGtQvn15SbtfTNqI4PcxX/+qPo4/g4/ZT5kVORDhVqO8BVP/RA5GQ3ce3sRK8hSkvQlXSoXIPpHh6x7hBezIGXzw==\"}],\"role\": \"model\"},\"finishReason\": \"STOP\",\"index\": 0,\"finishMessage\": \"Model generated function call(s).\"}],\"usageMetadata\": {\"promptTokenCount\": 55,\"candidatesTokenCount\": 15,\"totalTokenCount\": 115,\"promptTokensDetails\": [{\"modality\": \"TEXT\",\"tokenCount\": 55}],\"thoughtsTokenCount\": 45},\"modelVersion\": \"gemini-2.5-flash\",\"responseId\": \"NyTxaYuTJ_OW_uMPgIPKgAg\"}\r\n\r\n",
  "expect": {
   "usage": {
    "inputTokens": 55,
    "outputTokens": 60,
    "reasoningTokens": 45,
    "totalTokens": 115
   },
   "tools": [
    [
     "get_weather",
     {
      "city": "Paris"
     }
    ]
   ],
   "finish": "tool-calls"
  }
 },
 {
  "name": "gemini-cache/reports-cachedcontenttokencount-on-identical-second-call.json#1",
  "provider": "google",
  "apiType": null,
  "path": "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
  "model": "gemini-2.5-flash",
  "contentType": "text/event-stream",
  "body": "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"Hi.\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"cachedContentTokenCount\":1100,\"promptTokenCount\":1200,\"candidatesTokenCount\":2,\"totalTokenCount\":1202}}\n\n",
  "expect": {
   "usage": {
    "inputTokens": 1200,
    "outputTokens": 2,
    "cacheReadTokens": 1100,
    "totalTokens": 1202
   },
   "tools": [],
   "finish": "stop"
  }
 }
];

const descriptorFor = recording => {
  const base = listBuiltinDescriptors().find(d => d.id === recording.provider);
  if (recording.provider === 'cloudflare-ai-gateway') return { ...base, options: { accountId: ACCOUNT, gatewayId: 'zuku-gw' } };
  return recording.apiType ? { ...base, apiType: recording.apiType } : base;
};
const expectedPath = recording => recording.path.replace('{account}', ACCOUNT).replace('{gateway}', 'zuku-gw');

async function replay(t, recording, chunkSize) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'content-type': recording.contentType });
    const bytes = Buffer.from(recording.body, 'utf8');
    for (let i = 0; i < bytes.length; i += chunkSize) res.write(bytes.subarray(i, i + chunkSize));
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = createAdapter(descriptorFor(recording), { getCredentials: async () => ({ kind: 'api-key', apiKey: KEY }), testOrigin: `http://127.0.0.1:${server.address().port}` });
  const events = [];
  for await (const event of client.stream({
    model: recording.model,
    system: 'Call tools exactly as requested.',
    messages: [{ role: 'user', content: 'Call get_weather with city exactly Paris.' }],
    tools: [{ name: 'get_weather', description: 'Get current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
  })) events.push(event);
  return { events, seen };
}

for (const recording of RECORDINGS) {
  test(`recorded wire replay: ${recording.name}`, async t => {
    for (const chunkSize of [7, 4096]) {
      const { events, seen } = await replay(t, recording, chunkSize);
      assert.equal(seen.length, 1, 'exactly one request, no retry');
      assert.equal(new URL(seen[0].url, 'http://x').pathname, expectedPath(recording), 'same wire path as the recorded vendor request');
      const sent = JSON.parse(seen[0].body);
      if (sent.model !== undefined) assert.equal(sent.model, recording.model, 'model ID preserved verbatim (vendor slashes included)');
      assert.deepEqual(events.filter(e => e.type === 'tool-call').map(e => [e.name, e.arguments]), recording.expect.tools);
      assert.deepEqual(events.find(e => e.type === 'usage')?.usage, recording.expect.usage);
      assert.deepEqual(events.at(-1), { type: 'finish', reason: recording.expect.finish });
      assert.equal(events.filter(e => e.type === 'finish').length, 1);
      assert.equal(events.some(e => e.type === 'reasoning-delta'), false, 'reasoning text private by default');
      if (!recording.expect.tools.length) assert.ok(events.some(e => e.type === 'text-delta' && e.text.length > 0));
      const toolIds = events.filter(e => e.type === 'tool-call').map(e => e.id);
      assert.equal(new Set(toolIds).size, toolIds.length);
    }
  });
}
