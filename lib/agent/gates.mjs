import { posix } from 'node:path';
import { safeRelativePath, TITLE_MAX } from '../manifest-reader.mjs';
import { LIMITS } from './limits.mjs';
import { HOOK_CONTRACT } from './stages.mjs';
import { containsSecret, externalUrls, usesCommandApi, usesNetworkApi } from './safety.mjs';

/*
 * Deterministic quality and safety gates. Each gate returns a list of UPPER_SNAKE codes; an
 * empty list passes. Gates judge the structured artifacts themselves — a model saying that it
 * applied a skill or passed a check is never accepted as evidence.
 */
const unique = values => new Set(values).size === values.length;
const lowerUnique = values => unique(values.map(value => value.toLowerCase()));
const push = (codes, code) => { if (!codes.includes(code)) codes.push(code); };

export function gatePlan(plan) {
  const codes = [];
  if (!unique(plan.player_verbs)) push(codes, 'PLAN_VERB_DUPLICATE');
  const actions = plan.input_actions.map(action => action.id);
  if (!unique(actions)) push(codes, 'PLAN_ACTION_DUPLICATE');
  const keys = plan.input_actions.flatMap(action => action.keys);
  if (!unique(keys)) push(codes, 'PLAN_KEY_CONFLICT');
  if (!actions.includes(plan.loss_or_reset.reset_action)) push(codes, 'PLAN_RESET_ACTION_UNKNOWN');
  const ids = [...plan.hud.map(item => item.id), ...plan.menus.map(item => item.id)];
  if (!unique(ids)) push(codes, 'PLAN_DOM_ID_DUPLICATE');
  if (!plan.menus.some(menu => menu.kind === 'start')) push(codes, 'PLAN_START_MENU_MISSING');
  if (!plan.menus.some(menu => menu.kind === 'game_over')) push(codes, 'PLAN_GAME_OVER_MENU_MISSING');
  const assets = plan.asset_manifest;
  if (!unique(assets.map(asset => asset.id))) push(codes, 'PLAN_ASSET_DUPLICATE');
  for (const asset of assets) {
    if ((asset.source === 'procedural') !== (asset.path === '')) push(codes, 'PLAN_ASSET_PATH_INVALID');
    if (asset.kind === 'audio' && asset.source === 'file') push(codes, 'PLAN_ASSET_AUDIO_FILE');
  }
  if (!lowerUnique(assets.filter(asset => asset.path).map(asset => asset.path))) push(codes, 'PLAN_ASSET_DUPLICATE');
  if ([plan.title, plan.summary, ...plan.core_loop].some(value => containsSecret(value) || externalUrls(value).length)) push(codes, 'PLAN_TEXT_UNSAFE');
  return codes;
}

export function gateArchitecture(arch, plan, { engines }) {
  const codes = [];
  if (!engines.includes(arch.engine.name)) push(codes, 'ARCH_ENGINE_UNAVAILABLE');
  if (arch.engine.uses_create_scaffold && arch.engine.name !== 'canvas') push(codes, 'ARCH_SCAFFOLD_ENGINE_MISMATCH');
  const paths = arch.modules.map(module => module.path);
  if (!lowerUnique(paths)) push(codes, 'ARCH_MODULE_DUPLICATE');
  if (paths.some(path => path.toLowerCase().startsWith('src/vendor/'))) push(codes, 'ARCH_VENDOR_RESERVED');
  for (const role of ['simulation', 'render', 'input', 'boot']) {
    if (!arch.modules.some(module => module.role === role)) push(codes, `ARCH_${role.toUpperCase()}_MISSING`);
  }
  const byRole = role => arch.modules.filter(module => module.role === role).map(module => module.path).sort();
  const same = (a, b) => a.length === b.length && [...a].sort().every((value, index) => value === b[index]);
  if (!same(arch.boundary.simulation_modules, byRole('simulation')) || !same(arch.boundary.render_modules, byRole('render'))) push(codes, 'ARCH_BOUNDARY_MISMATCH');
  const keys = arch.state_shape.map(item => item.key);
  if (!['status', 'score', 'tick'].every(key => keys.includes(key))) push(codes, 'ARCH_STATE_HOOK_KEYS_MISSING');
  const planned = new Map(plan.input_actions.map(action => [action.id, action.keys.join(',')]));
  const mapped = new Map(arch.input_mapping.map(item => [item.action, item.keys.join(',')]));
  if (planned.size !== mapped.size || arch.input_mapping.length !== mapped.size || [...planned].some(([id, keys]) => mapped.get(id) !== keys)) push(codes, 'ARCH_INPUT_MISMATCH');
  return codes;
}

const TEXT_EXTENSIONS = new Set(['html', 'js', 'mjs', 'css', 'json', 'svg', 'txt', 'md']);
const IMPURE = /\b(?:document|window|globalThis|Phaser|HTMLCanvasElement|getContext|requestAnimationFrame|performance|localStorage|sessionStorage|setTimeout|setInterval|AudioContext|navigator)\b/;
const quoted = key => new RegExp(`["'\`]${key}["'\`]`);

/** Path admission for one model-provided file path. Returns a normalized path or undefined. */
export function admitArtifactPath(path) {
  if (typeof path !== 'string' || !path.startsWith('src/') || !safeRelativePath(path) || path.length > 220) return undefined;
  const parts = path.split('/');
  if (parts.length > 8 || parts.some(part => part.startsWith('.') || part === 'node_modules' || part.length > 80 || /[^A-Za-z0-9_.-]/.test(part))) return undefined;
  if (parts[1].toLowerCase() === 'vendor') return undefined;
  const extension = parts.at(-1).includes('.') ? parts.at(-1).split('.').pop() : '';
  if (!TEXT_EXTENSIONS.has(extension)) return undefined;
  return path;
}

/**
 * Safety checks that make the whole artifact set unusable (nothing is written). Returns codes.
 */
export function scanArtifacts(files) {
  const codes = [];
  let total = 0;
  const seen = new Set();
  for (const file of files) {
    const path = admitArtifactPath(file.path);
    if (!path) { push(codes, 'ARTIFACT_PATH_UNSAFE'); continue; }
    if (seen.has(path.toLowerCase())) push(codes, 'ARTIFACT_PATH_DUPLICATE');
    seen.add(path.toLowerCase());
    const bytes = Buffer.byteLength(file.content, 'utf8');
    total += bytes;
    if (bytes > LIMITS.fileBytes) push(codes, 'ARTIFACT_FILE_TOO_LARGE');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(file.content)) push(codes, 'ARTIFACT_BINARY');
    if (containsSecret(file.content)) push(codes, 'ARTIFACT_SECRET');
    if (usesCommandApi(file.content)) push(codes, 'ARTIFACT_COMMAND');
    if (externalUrls(file.content).length || usesNetworkApi(file.content)) push(codes, 'ARTIFACT_NETWORK');
  }
  if (files.length > LIMITS.files) push(codes, 'ARTIFACT_TOO_MANY_FILES');
  if (total > LIMITS.totalGeneratedBytes) push(codes, 'ARTIFACT_TOTAL_TOO_LARGE');
  return codes;
}

const scriptTags = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map(match => ({ attrs: match[1], body: match[2], src: /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1] }));
const importSpecifiers = code => [...code.matchAll(/(?:^|[;\n}])\s*(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']|(?:^|[;\n])\s*import\s*["']([^"']+)["']/g)].map(match => match[1] ?? match[2]);

/** Structural gate: the implementation must match the plan and architecture. Returns codes. */
export function gateImplementation(files, plan, arch) {
  const codes = [];
  const byPath = new Map(files.map(file => [file.path, file.content]));
  const html = byPath.get('src/index.html');
  if (html === undefined) return ['IMPL_ENTRY_MISSING'];
  for (const module of arch.modules) if (!byPath.has(module.path)) push(codes, 'IMPL_MODULE_MISSING');
  const scripts = scriptTags(html);
  if (!scripts.length) push(codes, 'IMPL_SCRIPT_MISSING');
  for (const script of scripts) {
    if (!script.src || script.body.trim()) { push(codes, 'IMPL_INLINE_SCRIPT'); continue; }
    const target = posix.normalize(posix.join('src', script.src));
    const vendor = target === 'src/vendor/phaser.min.js';
    if (script.src.startsWith('/') || !target.startsWith('src/') || (vendor ? arch.engine.name !== 'phaser' : !byPath.has(target))) push(codes, 'IMPL_SCRIPT_SRC_INVALID');
  }
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) push(codes, 'IMPL_INLINE_HANDLER');
  for (const id of [...plan.hud.map(item => item.id), ...plan.menus.map(item => item.id)]) {
    if (!new RegExp(`<[a-z][^>]*\\bid\\s*=\\s*["']${id}["']`, 'i').test(html)) push(codes, 'IMPL_DOM_ID_MISSING');
  }
  for (const [path, content] of byPath) {
    if (!/\.(m?js)$/.test(path)) continue;
    for (const specifier of importSpecifiers(content)) {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (!/^\.\.?\//.test(specifier) || !target.startsWith('src/') || !byPath.has(target)) push(codes, 'IMPL_IMPORT_INVALID');
    }
  }
  const boot = arch.modules.filter(module => module.role === 'boot').map(module => byPath.get(module.path) ?? '');
  if (!boot.some(code => code.includes('__zukuGame') && code.includes(HOOK_CONTRACT) && /\bgetState\b/.test(code) && /\bforceLoss\b/.test(code))) push(codes, 'IMPL_HOOK_MISSING');
  const input = arch.modules.filter(module => module.role === 'input').map(module => byPath.get(module.path) ?? '').join('\n');
  for (const action of plan.input_actions) {
    if (!action.keys.every(key => quoted(key).test(input))) push(codes, 'IMPL_INPUT_KEYS_MISSING');
    if (!quoted(action.id).test(input) && !new RegExp(`\\b${action.id}\\s*:`).test(input)) push(codes, 'IMPL_INPUT_ACTION_MISSING');
  }
  for (const module of arch.modules.filter(item => item.role === 'simulation')) {
    const code = (byPath.get(module.path) ?? '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    if (IMPURE.test(code)) push(codes, 'IMPL_SIMULATION_IMPURE');
  }
  for (const asset of plan.asset_manifest) if (asset.source === 'file' && !byPath.has(`src/${asset.path}`)) push(codes, 'IMPL_ASSET_MISSING');
  const all = [...byPath.values()].join('\n');
  const phaserTag = scripts.some(script => script.src && posix.normalize(posix.join('src', script.src)) === 'src/vendor/phaser.min.js');
  if (arch.engine.name === 'phaser' && !phaserTag) push(codes, 'IMPL_ENGINE_MISMATCH');
  if (arch.engine.name === 'canvas' && /\bPhaser\b/.test(all)) push(codes, 'IMPL_ENGINE_MISMATCH');
  if (plan.save_debug_perf.save === 'none' && /\blocalStorage\b/.test(all)) push(codes, 'IMPL_SAVE_UNPLANNED');
  return codes;
}

export function gatePlaytestScript(script, plan) {
  const codes = [];
  const actions = new Set(plan.input_actions.map(action => action.id));
  if (!actions.has(script.start_action)) push(codes, 'PLAYTEST_ACTION_UNKNOWN');
  if (script.smoke.some(step => !actions.has(step.action))) push(codes, 'PLAYTEST_ACTION_UNKNOWN');
  const duration = script.smoke.reduce((sum, step) => sum + step.hold_ms + step.wait_ms, 0);
  if (duration > 12_000) push(codes, 'PLAYTEST_SCRIPT_TOO_LONG');
  if (duration < 1500) push(codes, 'PLAYTEST_SCRIPT_TOO_SHORT');
  const hud = new Set(plan.hud.map(item => item.id));
  if (!script.observe_hud_ids.every(id => hud.has(id)) || !unique(script.observe_hud_ids)) push(codes, 'PLAYTEST_HUD_UNKNOWN');
  return codes;
}

export function gatePublish(meta, plan) {
  const codes = [];
  if (!meta.title.trim() || meta.title.length > TITLE_MAX) push(codes, 'PUBLISH_TITLE_INVALID');
  if (!unique(meta.tags)) push(codes, 'PUBLISH_TAG_DUPLICATE');
  for (const value of [meta.title, meta.description, meta.release_notes, ...meta.tags]) {
    if (containsSecret(value) || externalUrls(value).length || /\b[\w.+-]+@[\w-]+\.[\w.]+\b/.test(value) || /\bwww\./i.test(value)) push(codes, 'PUBLISH_TEXT_UNSAFE');
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) push(codes, 'PUBLISH_TEXT_UNSAFE');
  }
  if (!meta.platform.pc) push(codes, 'PUBLISH_PLATFORM_INVALID');
  if ((meta.platform.mobile || meta.platform.tablet) && !plan.input_actions.every(action => action.pointer)) push(codes, 'PUBLISH_PLATFORM_UNSUPPORTED');
  return codes;
}
