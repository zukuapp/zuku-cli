// Minimal strict JSON-Schema subset validator for stage outputs. The same schema objects are
// sent to the provider as `outputSchema`, but provider-side validation is never trusted:
// every stage output is re-validated here. Supported keywords: type, enum, const, properties,
// required, additionalProperties(false), items, minItems, maxItems, minLength, maxLength,
// pattern, minimum, maximum.
const MAX_DEPTH = 12;
const MAX_ERRORS = 32;

const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
const matches = (type, value) => {
  const actual = typeOf(value);
  return type === actual || (type === 'number' && (actual === 'integer' || (actual === 'number' && Number.isFinite(value))));
};

export function validateSchema(schema, value) {
  const errors = [];
  const visit = (node, item, path, depth) => {
    if (errors.length >= MAX_ERRORS) return;
    if (depth > MAX_DEPTH) { errors.push({ path, code: 'DEPTH' }); return; }
    const types = node.type === undefined ? null : [].concat(node.type);
    if (types && !types.some(type => matches(type, item))) { errors.push({ path, code: 'TYPE' }); return; }
    if (node.const !== undefined && item !== node.const) errors.push({ path, code: 'CONST' });
    if (node.enum && !node.enum.includes(item)) errors.push({ path, code: 'ENUM' });
    if (typeof item === 'string') {
      if (node.minLength !== undefined && item.length < node.minLength) errors.push({ path, code: 'MIN_LENGTH' });
      if (node.maxLength !== undefined && item.length > node.maxLength) errors.push({ path, code: 'MAX_LENGTH' });
      if (node.pattern && !new RegExp(node.pattern, 'u').test(item)) errors.push({ path, code: 'PATTERN' });
    }
    if (typeof item === 'number') {
      if (node.minimum !== undefined && item < node.minimum) errors.push({ path, code: 'MINIMUM' });
      if (node.maximum !== undefined && item > node.maximum) errors.push({ path, code: 'MAXIMUM' });
    }
    if (Array.isArray(item)) {
      if (node.minItems !== undefined && item.length < node.minItems) errors.push({ path, code: 'MIN_ITEMS' });
      if (node.maxItems !== undefined && item.length > node.maxItems) { errors.push({ path, code: 'MAX_ITEMS' }); return; }
      if (node.items) item.forEach((entry, index) => visit(node.items, entry, `${path}[${index}]`, depth + 1));
    }
    if (typeOf(item) === 'object') {
      const properties = node.properties ?? {};
      for (const key of node.required ?? []) if (!Object.hasOwn(item, key)) errors.push({ path: `${path}.${key}`, code: 'REQUIRED' });
      for (const key of Object.keys(item)) {
        if (Object.hasOwn(properties, key)) visit(properties[key], item[key], `${path}.${key}`, depth + 1);
        else if (node.additionalProperties === false) errors.push({ path: `${path}.${key.slice(0, 40)}`, code: 'UNKNOWN_FIELD' });
      }
    }
  };
  visit(schema, value, '$', 0);
  return errors;
}

// Helpers to keep stage schemas strict-mode compatible (every property required, no extras).
export const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
export const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
export const array = (items, minItems, maxItems) => ({ type: 'array', items, minItems, maxItems });
export const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
export const boolean = { type: 'boolean' };
export const enumOf = values => ({ type: 'string', enum: values });
