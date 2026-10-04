// Shared content checks for user requests, model artifacts and receipts.
const SECRET_PATTERNS = Object.freeze([
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ZUKUJS_ACCESS_TOKEN|ZUKU_ACCESS_TOKEN|OPENAI_API_KEY|CODEX_[A-Z_]*TOKEN)\b/,
  /\b(?:refresh|access|id)_token\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
]);
export const containsSecret = value => typeof value === 'string' && SECRET_PATTERNS.some(pattern => pattern.test(value));

// Absolute URLs are only allowed as XML namespace identifiers inside SVG/HTML.
const NAMESPACES = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink', 'http://www.w3.org/1999/xhtml', 'http://www.w3.org/XML/1998/namespace']);
export function externalUrls(content) {
  const found = [];
  for (const match of content.matchAll(/\b(?:https?|wss?|ftp|file|data:text\/html|javascript):(?:\/\/)?[^\s"'<>)`]*/gi)) {
    if (!NAMESPACES.has(match[0].replace(/[;,]+$/, ''))) found.push(match[0]);
    if (found.length >= 4) break;
  }
  if (/\b(?:src|href|action|poster|data)\s*=\s*["']?\s*\/\//i.test(content) || /url\(\s*["']?\s*\/\//i.test(content)) found.push('//');
  return found;
}

const COMMAND_PATTERNS = Object.freeze([
  /(?<![\w$.])require\s*\(/, /\bchild_process\b/, /["']node:[a-z_]+["']/, /\bprocess\s*\.\s*(?:env|exit|argv|binding|kill)\b/,
  /^#!/m, /\bDeno\s*\./, /\bBun\s*\./, /\bexecSync\b|\bspawnSync\b/,
]);
const NETWORK_PATTERNS = Object.freeze([
  /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bimportScripts\b/,
  /\bnew\s+(?:Shared)?Worker\b/, /\bserviceWorker\b/, /\bRTCPeerConnection\b/, /(?<![\w$.])import\s*\(/,
  /(?<![\w$.])eval\s*\(/, /\bnew\s+Function\b/, /(?<![\w$.])Function\s*\(/, /\bset(?:Timeout|Interval)\s*\(\s*["'`]/,
  /\bdocument\s*\.\s*cookie\b/, /\bwindow\s*\.\s*open\s*\(/, /<\s*(?:iframe|object|embed|base|frame|portal)\b/i,
  /http-equiv\s*=\s*["']?refresh/i, /\bnavigator\s*\.\s*(?:credentials|clipboard|geolocation|mediaDevices)\b/,
]);
export const usesCommandApi = content => COMMAND_PATTERNS.some(pattern => pattern.test(content));
export const usesNetworkApi = content => NETWORK_PATTERNS.some(pattern => pattern.test(content));

/** Text request admitted to model input: bounded, printable, secret-free. */
export function admitRequest(value, maxChars) {
  if (typeof value !== 'string') return undefined;
  const request = value.replace(/\r\n/g, '\n').trim();
  if (!request || [...request].length > maxChars || /[\x00-\x08\x0b-\x1f\x7f]/.test(request) || containsSecret(request)) return undefined;
  return request;
}
