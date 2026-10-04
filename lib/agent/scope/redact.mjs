import { containsSecret } from '../safety.mjs';

// Redacts credential-shaped text before anything reaches a model, a receipt or an event.
// Detection is also used to refuse reading or writing secret material at all.
const PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|rk|pk)-(?:live-|test-|proj-|ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bzuku_o[adr]_[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*["']?[^\s"'`]{6,}/g,
];
const MATERIAL = [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bsk-(?:live-|proj-|ant-)[A-Za-z0-9_-]{16,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bzuku_o[adr]_[A-Za-z0-9_-]{20,}/];

export function redact(text) {
  let out = String(text);
  for (const pattern of PATTERNS) out = out.replace(pattern, match => (/^[A-Z0-9_]+\s*[=:]/.test(match) ? `${match.split(/[=:]/)[0].trim()}=[REDACTED]` : '[REDACTED]'));
  return out;
}

/** True when text contains material that looks like a real credential (refused on read/write). */
export const looksLikeSecret = text => typeof text === 'string' && (containsSecret(text) || MATERIAL.some(pattern => pattern.test(text)));

/** Redacts, strips control characters (except tab/newline/CR) and bounds model/event text. */
export function boundText(value, max) {
  const clean = redact(String(value)).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return clean.length > max ? { text: clean.slice(0, max), truncated: true } : { text: clean, truncated: false };
}
