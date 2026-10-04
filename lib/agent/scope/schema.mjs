// Strict JSON-schema subset used for host tool inputs and for the two scope stages.
// Everything is closed and bounded and checked by the host, never trusted because a
// provider or model said so. Stage wire schemas carry no regex patterns, so they pass the
// shared provider admission (lib/provider-system/stage-schema.mjs) unchanged.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Host-side validator (supports `multiline`, a host-only keyword stripped from wire schemas). */
export function check(schema, value, path = '$', out = []) {
  if (out.length >= 20) return out;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (!types.includes(kind) && !(kind === 'integer' && types.includes('number'))) { out.push(`${path}: expected ${types.join('|')}`); return out; }
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: not an allowed value`);
  if (kind === 'string') {
    const length = [...value].length;
    if (length > (schema.maxLength ?? 4096)) out.push(`${path}: too long`);
    if (schema.minLength && length < schema.minLength) out.push(`${path}: too short`);
    if (schema.hostPattern && !schema.hostPattern.test(value)) out.push(`${path}: invalid format`);
    if (!schema.multiline && /[\x00-\x1f\x7f]/.test(value)) out.push(`${path}: control characters`);
    if (schema.multiline && /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) out.push(`${path}: control characters`);
  } else if (kind === 'integer' || kind === 'number') {
    if (!Number.isFinite(value)) out.push(`${path}: not finite`);
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path}: above maximum`);
  } else if (kind === 'array') {
    if (value.length > (schema.maxItems ?? 64)) out.push(`${path}: too many items`);
    if (schema.minItems && value.length < schema.minItems) out.push(`${path}: too few items`);
    value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, out));
  } else if (kind === 'object') {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) out.push(`${path}.${key}: required`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) out.push(`${path}.${key}: unknown field`);
      else check(properties[key], value[key], `${path}.${key}`, out);
    }
  }
  return out;
}

const SHA = /^[0-9a-f]{64}$/;
const SCRIPT_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PATH = { type: 'string', minLength: 1, maxLength: 512 };
const text = (max, multiline = false) => ({ type: 'string', maxLength: max, ...(multiline ? { multiline: true } : {}) });

// The capability enum. A provider's own tool list never extends it.
export const TOOL_IDS = Object.freeze(['read_file', 'write_file', 'patch_file', 'search_project', 'run_zuku', 'run_tests', 'run_build', 'inspect_asset', 'query_zuku_docs']);

export const TOOL_SCHEMAS = Object.freeze({
  read_file: { type: 'object', required: ['path'], properties: { path: PATH, offset: { type: 'integer', minimum: 0, maximum: 4194304 }, length: { type: 'integer', minimum: 1, maximum: 65536 } } },
  write_file: { type: 'object', required: ['path', 'content', 'expected_sha256'], properties: { path: PATH, content: text(262144, true), expected_sha256: { type: ['string', 'null'], maxLength: 64, hostPattern: SHA } } },
  patch_file: { type: 'object', required: ['path', 'expected_sha256', 'edits'], properties: { path: PATH, expected_sha256: { type: 'string', maxLength: 64, hostPattern: SHA }, edits: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['old', 'new'], properties: { old: { ...text(16384, true), minLength: 1 }, new: text(65536, true) } } } } },
  search_project: { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 2, maxLength: 200 }, path: PATH } },
  run_zuku: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['validate', 'package', 'playtest'] } } },
  run_tests: { type: 'object', required: ['script_id'], properties: { script_id: { type: 'string', maxLength: 64, hostPattern: SCRIPT_ID } } },
  run_build: { type: 'object', required: ['script_id'], properties: { script_id: { type: 'string', maxLength: 64, hostPattern: SCRIPT_ID } } },
  inspect_asset: { type: 'object', required: ['path'], properties: { path: PATH } },
  query_zuku_docs: { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 2, maxLength: 200 } } },
});

/** Admits one model-proposed tool input against the closed per-tool schema. */
export function admitToolInput(tool, input) {
  if (!TOOL_IDS.includes(tool)) return ['$.tool: not a declared capability'];
  if (!record(input)) return ['$.input: expected object'];
  return check(TOOL_SCHEMAS[tool], input, '$.input');
}

const closed = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export const PLAN_SCHEMA = Object.freeze(closed({
  summary: text(2000, true),
  design: closed({ purpose: text(2000, true), architecture: text(4000, true) }),
  // Informational only: the host decides and runs verification itself.
  verification_plan: { type: 'array', minItems: 0, maxItems: 8, items: text(80) },
  steps: { type: 'array', minItems: 0, maxItems: 24, items: text(500, true) },
}));

// Tool inputs travel as a JSON string so the wire schema stays strict and closed for every
// provider (no open objects); the host decodes and admits each input itself.
export const ACTION_INPUT_MAX = 1_200_000;
export const ACT_SCHEMA = Object.freeze(closed({
  actions: { type: 'array', minItems: 0, maxItems: 4, items: closed({ tool: { type: 'string', enum: [...TOOL_IDS] }, input_json: text(ACTION_INPUT_MAX, true) }) },
  done: { type: 'boolean' },
}));

/**
 * Stage definitions. `maxBytes` becomes stageRequest.maxOutputBytes; the act stage carries
 * file contents and matches the shared 1,600,000-byte implementation ceiling.
 */
export const STAGE_DEFINITIONS = Object.freeze({
  'scope.plan': Object.freeze({ schema: PLAN_SCHEMA, maxBytes: 98_304 }),
  'scope.act': Object.freeze({ schema: ACT_SCHEMA, maxBytes: 1_600_000 }),
});

const WIRE_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'maxLength', 'minLength', 'maxItems', 'minItems', 'minimum', 'maximum']);
/** Standard JSON Schema for the wire: host-only keywords removed, every object closed. */
export function toWireSchema(schema) {
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!WIRE_KEYS.has(key)) continue;
    if (key === 'properties') out.properties = Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, toWireSchema(inner)]));
    else if (key === 'items') out.items = toWireSchema(value);
    else out[key] = Array.isArray(value) ? [...value] : value;
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

/**
 * Admits a wire schema before any network use: keyword allowlist (no pattern/$ref/oneOf/
 * anyOf/allOf/not/format), closed objects with every property required, bounded depth/sizes.
 */
export function admitStageSchema(schema, depth = 0) {
  if (depth > 8 || !record(schema)) return false;
  for (const key of Object.keys(schema)) if (!WIRE_KEYS.has(key)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.every(type => ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(type))) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 64)) return false;
  if (types.includes('string') && !(Number.isSafeInteger(schema.maxLength) && schema.maxLength <= 2_000_000) && schema.enum === undefined) return false;
  if (types.includes('array') && !(Number.isSafeInteger(schema.maxItems) && schema.maxItems <= 256 && admitStageSchema(schema.items, depth + 1))) return false;
  if (types.includes('object')) {
    const names = Object.keys(schema.properties ?? {});
    if (schema.additionalProperties !== false || names.length > 32 || JSON.stringify([...(schema.required ?? [])].sort()) !== JSON.stringify([...names].sort())) return false;
    if (!names.every(name => admitStageSchema(schema.properties[name], depth + 1))) return false;
  }
  return true;
}

/** Parses a provider stage output (object or JSON text) and admits it against `schema`. */
export function admitJson(schema, output, maxBytes) {
  let value = output;
  if (typeof output === 'string') {
    if (Buffer.byteLength(output) > maxBytes) return { errors: ['$: output too large'] };
    const trimmed = output.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, '$1');
    try { value = JSON.parse(trimmed); } catch { return { errors: ['$: not JSON'] }; }
  } else {
    let size;
    try { size = Buffer.byteLength(JSON.stringify(output) ?? ''); } catch { return { errors: ['$: not JSON'] }; }
    if (size > maxBytes) return { errors: ['$: output too large'] };
  }
  if (!record(value)) return { errors: ['$: expected object'] };
  const errors = check(schema, value);
  return errors.length ? { errors } : { value };
}

/** Decodes one action's input_json (host side) into an object for admitToolInput. */
export function decodeActionInput(value) {
  if (typeof value !== 'string' || value.length > ACTION_INPUT_MAX) return undefined;
  try { const parsed = JSON.parse(value); return record(parsed) ? parsed : undefined; } catch { return undefined; }
}
