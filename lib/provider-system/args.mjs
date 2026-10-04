import { ProviderError, invalidInput } from './errors.mjs';

// Flags that would put a secret into argv (shell history, /proc, CI logs).
const SECRET_FLAGS = /^--(api-?key|key|token|secret|password|passwd|bearer|access-?token|header-value|authorization)(=|$)/i;
const SECRET_SHAPE = /^(sk-|sk_|gsk_|xai-|hf_|AIza|AKIA|ASIA|ghp_|gho_|github_pat_|zk_|zuku_o[ar]_)|^eyJ[A-Za-z0-9_-]{8,}\./;
const MAX_ARGS = 64;
const MAX_ARG = 2048;

/**
 * Strict parser: spec = { flags: { '--name': 'string' | 'boolean' | 'list' }, positionals: n }.
 * Unknown flags, duplicates, missing values and secret-bearing flags are rejected without echo.
 */
export function parseArgs(args, { flags = {}, positionals = 0 } = {}) {
  if (!Array.isArray(args) || args.length > MAX_ARGS) throw invalidInput();
  const out = { _: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== 'string' || arg.length > MAX_ARG || /[\u0000-\u001f\u007f]/.test(arg)) throw invalidInput();
    if (SECRET_FLAGS.test(arg) || SECRET_SHAPE.test(arg)) throw new ProviderError('AUTH_SECRET_ARGUMENT');
    if (arg === '--json') continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      const kind = Object.hasOwn(flags, name) ? flags[name] : undefined;
      if (!kind) throw invalidInput();
      const key = name.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (kind === 'boolean') {
        if (eq > 0 || Object.hasOwn(out, key)) throw invalidInput();
        out[key] = true; continue;
      }
      let value;
      if (eq > 0) value = arg.slice(eq + 1);
      else { value = args[++index]; if (typeof value !== 'string' || value.startsWith('--')) throw invalidInput(); }
      if (value.length > MAX_ARG || /[\u0000-\u001f\u007f]/.test(value)) throw invalidInput();
      if (SECRET_SHAPE.test(value)) throw new ProviderError('AUTH_SECRET_ARGUMENT');
      if (kind === 'list') (out[key] ??= []).push(value);
      else { if (Object.hasOwn(out, key)) throw invalidInput(); out[key] = value; }
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') throw invalidInput();
    out._.push(arg);
  }
  if (out._.length > positionals) throw invalidInput();
  return out;
}
