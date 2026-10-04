/** Authentication status is metadata; provider names never decide this indicator. */
export const CODEX_AUTH_METHOD = Object.freeze({ id: 'codex-oauth', name: 'Codex OAuth', official: false, unofficial: true, experimental: true });

export function experimentalIndicator(method, { stream = process.stderr, environment = process.env } = {}) {
  if (method?.experimental !== true) return '';
  const color = stream?.isTTY === true && !Object.hasOwn(environment, 'NO_COLOR') && environment.TERM !== 'dumb';
  return color ? '\u001b[38;5;208m(exp!)\u001b[0m' : '(exp!)';
}

export function renderAuthMethod(method, options) {
  const indicator = experimentalIndicator(method, options);
  return `${method.name}${indicator ? ` ${indicator}` : ''}`;
}
