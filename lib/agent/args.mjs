import { isAbsolute } from 'node:path';
import { NAME_PATTERN } from '../manifest-reader.mjs';
import { AgentError } from './errors.mjs';
import { MODEL_PATTERN, RUN_ID } from './limits.mjs';

/*
 * zukujs agent ["game request"] [--name <name>] [--model <id>] [--yolo | --draft]
 *                               [--browser <absolute chromium path>] [--resume <run_id>]
 * Pure parser: no I/O. Unknown flags (including --no-skills), duplicates, conflicting modes and
 * malformed values are INVALID_INPUT before any file system or network access. `--json` is
 * handled by the root entrypoint and never reaches here.
 */
const VALUE_FLAGS = Object.freeze({ '--name': 'name', '--model': 'model', '--browser': 'browser', '--resume': 'resume' });
const BOOLEAN_FLAGS = Object.freeze({ '--yolo': 'yolo', '--draft': 'draft' });

export function parseAgentArgs(args = []) {
  if (!Array.isArray(args)) throw new AgentError('INVALID_INPUT');
  const options = { yolo: false, draft: false };
  const words = [];
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string' || arg.includes('\0')) throw new AgentError('INVALID_INPUT');
    if (arg === '--') { words.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { words.push(arg); continue; }
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    if (seen.has(flag)) throw new AgentError('INVALID_INPUT');
    seen.add(flag);
    if (Object.hasOwn(BOOLEAN_FLAGS, flag)) {
      if (inline !== undefined) throw new AgentError('INVALID_INPUT');
      options[BOOLEAN_FLAGS[flag]] = true;
    } else if (Object.hasOwn(VALUE_FLAGS, flag)) {
      const value = inline ?? args[++i];
      if (typeof value !== 'string' || value === '' || value.includes('\0')) throw new AgentError('INVALID_INPUT');
      options[VALUE_FLAGS[flag]] = value;
    } else throw new AgentError('INVALID_INPUT');
  }
  if (words.some(word => typeof word !== 'string' || word.includes('\0'))) throw new AgentError('INVALID_INPUT');
  const request = words.length ? words.join(' ') : undefined;
  if (options.yolo && options.draft) throw new AgentError('INVALID_INPUT');
  if (options.name !== undefined && !NAME_PATTERN.test(options.name)) throw new AgentError('INVALID_INPUT');
  if (options.model !== undefined && !MODEL_PATTERN.test(options.model)) throw new AgentError('INVALID_INPUT');
  if (options.browser !== undefined && (!isAbsolute(options.browser) || options.browser.length > 1024)) throw new AgentError('INVALID_INPUT');
  if (options.resume !== undefined) {
    if (!RUN_ID.test(options.resume) || request !== undefined || options.name !== undefined || options.model !== undefined) throw new AgentError('INVALID_INPUT');
  }
  return Object.freeze({ ...options, request, mode: options.yolo ? 'yolo' : options.draft ? 'draft' : 'local' });
}
