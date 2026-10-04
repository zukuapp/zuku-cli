// Bounded stage-schema admission and output validation. This is the protocol
// layer's own defence: a schema is admitted before any network use, and the
// model's JSON is revalidated against it afterwards. Host validators
// (lib/agent/schema, Codex validateStageSchema/validateStageOutput) may be
// injected and run in addition — never instead.
import { AdapterError } from './errors.mjs';

export const SCHEMA_LIMITS = Object.freeze({ depth: 24, nodes: 4096, properties: 256, enum: 256, patternLength: 256, validationSteps: 2_000_000 });
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ALLOWED = new Set(['type', 'properties', 'required', 'items', 'enum', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'uniqueItems', 'additionalProperties', 'pattern', 'description', 'title', 'format', '$schema', 'default', 'examples']);
const COUNTS = ['minLength', 'maxLength', 'minItems', 'maxItems'];
const BOUNDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reject = () => { throw new AdapterError('ADAPTER_REQUEST_INVALID'); };

/**
 * Reject regexes that can backtrack catastrophically or depend on context:
 * backreferences, lookaround, and a quantified group that itself contains a quantifier.
 */
export function safePattern(source) {
  if (typeof source !== 'string' || source.length === 0 || source.length > SCHEMA_LIMITS.patternLength) return false;
  if (/\\[1-9]|\\k<|\(\?<?[=!]/.test(source)) return false;
  if (/\((?:[^()\\]|\\.)*(?:[*+]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)(?:[*+]|\{\d+,?\d*\})/.test(source)) return false;
  try { new RegExp(source, 'u'); } catch { return false; }
  return true;
}

/** Admit a JSON Schema in the bounded subset; returns the same object when valid. */
export function admitSchema(schema) {
  let nodes = 0;
  const visit = (node, depth) => {
    if (typeof node === 'boolean') return;
    if (!record(node) || depth > SCHEMA_LIMITS.depth || ++nodes > SCHEMA_LIMITS.nodes) reject();
    for (const key of Object.keys(node)) if (!ALLOWED.has(key)) reject();
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (types.length === 0 || !types.every(type => TYPES.has(type))) reject();
    }
    for (const key of COUNTS) if (node[key] !== undefined && (!Number.isSafeInteger(node[key]) || node[key] < 0)) reject();
    for (const key of BOUNDS) if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]))) reject();
    if (node.uniqueItems !== undefined && typeof node.uniqueItems !== 'boolean') reject();
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.length > SCHEMA_LIMITS.enum)) reject();
    if (node.pattern !== undefined && !safePattern(node.pattern)) reject();
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.length > SCHEMA_LIMITS.properties || !node.required.every(name => typeof name === 'string'))) reject();
    if (node.properties !== undefined) {
      if (!record(node.properties) || Object.keys(node.properties).length > SCHEMA_LIMITS.properties) reject();
      for (const child of Object.values(node.properties)) visit(child, depth + 1);
    }
    if (node.items !== undefined) visit(node.items, depth + 1);
    if (node.additionalProperties !== undefined) visit(node.additionalProperties, depth + 1);
  };
  visit(schema, 0);
  if (!record(schema)) reject();
  return schema;
}

const typeOf = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Validate a value against an admitted schema. Returns true/false; bounded work. */
export function validateValue(schema, value) {
  let steps = 0;
  const check = (node, v) => {
    if (++steps > SCHEMA_LIMITS.validationSteps) throw new AdapterError('STAGE_OUTPUT_TOO_LARGE');
    if (node === true || node === undefined) return true;
    if (node === false) return false;
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      const actual = typeOf(v);
      const ok = types.some(type => type === actual || (type === 'integer' && actual === 'number' && Number.isInteger(v)) || (type === 'number' && actual === 'number'));
      if (!ok) return false;
    }
    if (node.const !== undefined && !equal(node.const, v)) return false;
    if (node.enum !== undefined && !node.enum.some(option => equal(option, v))) return false;
    if (typeof v === 'string') {
      const length = [...v].length;
      if (node.minLength !== undefined && length < node.minLength) return false;
      if (node.maxLength !== undefined && length > node.maxLength) return false;
      if (node.pattern !== undefined && !new RegExp(node.pattern, 'u').test(v)) return false;
    }
    if (typeof v === 'number') {
      if (node.minimum !== undefined && v < node.minimum) return false;
      if (node.maximum !== undefined && v > node.maximum) return false;
      if (node.exclusiveMinimum !== undefined && v <= node.exclusiveMinimum) return false;
      if (node.exclusiveMaximum !== undefined && v >= node.exclusiveMaximum) return false;
    }
    if (Array.isArray(v)) {
      if (node.minItems !== undefined && v.length < node.minItems) return false;
      if (node.maxItems !== undefined && v.length > node.maxItems) return false;
      if (node.uniqueItems === true && new Set(v.map(item => JSON.stringify(item))).size !== v.length) return false;
      if (node.items !== undefined && !v.every(item => check(node.items, item))) return false;
    }
    if (record(v)) {
      for (const name of node.required ?? []) if (!Object.hasOwn(v, name)) return false;
      const properties = node.properties ?? {};
      for (const [key, item] of Object.entries(v)) {
        if (Object.hasOwn(properties, key)) { if (!check(properties[key], item)) return false; }
        else if (node.additionalProperties !== undefined && !check(node.additionalProperties, item)) return false;
      }
    }
    return true;
  };
  return check(schema, value);
}
