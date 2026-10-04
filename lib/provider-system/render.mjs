// Plain-text rendering for provider/model/auth results. JSON output never passes
// through here, so it can never carry ANSI sequences. Only the (exp!) marker is
// coloured, and only when it is derived from auth-method metadata.
export const EXP_COLOR = '\x1b[38;5;208m';
export const RESET = '\x1b[0m';
const SAFE = /[\u0000-\u001f\u007f-\u009f]/g;
const text = value => String(value ?? '').replace(SAFE, '');

export function colorEnabled({ stream, environment = process.env } = {}) {
  if (Object.hasOwn(environment, 'NO_COLOR') || environment.TERM === 'dumb') return false;
  return stream?.isTTY === true;
}

/** Fallback twin of root lib/experimental.mjs; root's helpers win when supplied. */
export function authMethodLabel(method, { color = false, experimental } = {}) {
  if (typeof experimental?.renderAuthMethod === 'function') return experimental.renderAuthMethod(method, { color });
  const name = text(method?.name ?? method?.id);
  if (method?.experimental !== true) return name;
  const marker = typeof experimental?.experimentalIndicator === 'function' ? experimental.experimentalIndicator({ color }) : color ? `${EXP_COLOR}(exp!)${RESET}` : '(exp!)';
  return `${name} ${marker}`;
}

const yesNo = value => value === true ? 'yes' : value === false ? 'no' : 'unknown';
const capabilityLine = caps => Object.entries(caps ?? {}).map(([key, value]) => `${key}=${yesNo(value)}`).join(' ');

function providerList(rows, options) {
  const lines = ['ZUKU Provider Configuration', ''];
  for (const row of rows) {
    const mark = row.active ? '●' : ' ';
    const state = row.enabled ? '' : ' [disabled]';
    const auth = row.auth ? `  ${authMethodLabel(row.auth.method, options)}: ${text(row.auth.status)}` : '';
    lines.push(`${mark} ${text(row.name).padEnd(34)} ${text(row.id).padEnd(24)}${state}${auth}`);
  }
  return lines.join('\n') + '\n';
}

function providerDetail(row, options) {
  const lines = [`${text(row.name)} (${text(row.id)})`, `  API: ${text(row.apiType)}${row.baseUrl ? `  ${text(row.baseUrl)}` : ''}`, `  Enabled: ${yesNo(row.enabled)}  Active: ${yesNo(row.active)}`];
  lines.push('  Authentication Methods');
  for (const method of row.authMethods ?? []) lines.push(`    ${authMethodLabel(method, options)}`);
  if (row.auth) lines.push(`  Status: ${text(row.auth.status)}`);
  lines.push(`  Capabilities: ${capabilityLine(row.capabilities)}`);
  if (row.missingConfiguration?.length) lines.push(`  Missing: ${row.missingConfiguration.map(text).join(', ')}`);
  return lines.join('\n') + '\n';
}

function modelList(data) {
  const lines = [`Models (${text(data.provider)}) — discovery: ${text(data.discovery?.status)}${data.discovery?.error ? ` (${text(data.discovery.error)})` : ''}`];
  for (const model of data.models ?? []) {
    const ctx = model.contextWindow ? ` ctx=${model.contextWindow}` : '';
    lines.push(`  ${text(model.address).padEnd(48)} ${text(model.source)}${ctx}`);
  }
  if (!data.models?.length) lines.push('  (none)');
  return lines.join('\n') + '\n';
}

function modelInfo(model) {
  const unknown = value => value === null || value === undefined ? 'unknown' : text(value);
  return [`${text(model.address)} — ${text(model.name)}`, `  Source: ${text(model.source)}`, `  Context window: ${unknown(model.contextWindow)}  Max output: ${unknown(model.maxOutputTokens)}`, `  Cost in/out: ${unknown(model.inputCost)} / ${unknown(model.outputCost)}`, `  Capabilities: ${capabilityLine(model.capabilities)}`].join('\n') + '\n';
}

function authList(rows, options) {
  const lines = ['Authentication', ''];
  for (const row of rows) {
    lines.push(`  ${text(row.provider).padEnd(24)} ${authMethodLabel(row.method, options).padEnd(40)} ${text(row.status)}${row.envVar ? ` (${text(row.envVar)})` : ''}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * renderProviderOutput(command, data, { color?, stream?, environment?, experimental? }) -> string.
 * command: 'provider.list' | 'provider.show' | 'provider.*' | 'model.list' | 'model.info' | 'model.*' | 'auth.list' | 'auth.*'
 */
export function renderProviderOutput(command, data, options = {}) {
  const resolved = { ...options, color: options.color ?? colorEnabled(options) };
  switch (command) {
    case 'provider.list': return providerList(data, resolved);
    case 'provider.show': case 'provider.add': case 'provider.configure': return providerDetail(data, resolved);
    case 'model.list': return modelList(data);
    case 'model.info': return modelInfo(data);
    case 'auth.list': return authList(data, resolved);
    default: {
      const pairs = Object.entries(data ?? {}).filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value));
      const method = data?.method ? `  ${authMethodLabel(data.method, resolved)}\n` : '';
      return pairs.map(([key, value]) => `${key}: ${text(value)}`).join('\n') + '\n' + method;
    }
  }
}
