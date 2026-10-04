import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import { PROJECT_MANIFEST, normalizeManifest, readManifest, validateManifest } from '../../manifest-reader.mjs';
import { ScopeError, cancelled } from './errors.mjs';

export const CLASSIFICATION_SCHEMA = 'zuku.scope.classification/1';
export const CLASSIFICATIONS = Object.freeze(['zuku', 'zukujs', 'zuku-compatible', 'unknown', 'out-of-scope']);
export const CLASSIFY_LIMITS = Object.freeze({ depth: 6, entries: 5000, readFiles: 300, readBytes: 65536 });

// Classifications are host evidence. Only objects produced here are accepted by
// admitGameRequest, so a caller (or a model) cannot hand in a claimed classification.
const issued = new WeakSet();
export const isIssuedClassification = value => issued.has(value);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);
const CODE = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.html', '.htm']);
const SHADER = new Set(['.glsl', '.vert', '.frag', '.wgsl']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const AUDIO = new Set(['.mp3', '.ogg', '.oga', '.wav', '.m4a', '.opus', '.flac', '.weba']);
const GAME_DEPS = new Set(['phaser', 'pixi.js', 'three', 'babylonjs', '@babylonjs/core', 'kaboom', 'kaplay', 'excalibur', 'playcanvas', 'matter-js', 'planck', 'planck-js', 'cannon-es', 'howler', '@dimforge/rapier2d', '@dimforge/rapier3d', 'melonjs', 'littlejsengine', 'ogl', 'regl', 'twgl.js', 'tone', 'colyseus.js']);
const GENERIC_DEPS = new Set(['express', 'fastify', 'koa', '@nestjs/core', 'hapi', '@hapi/hapi', 'next', 'nuxt', '@remix-run/node', 'stripe', 'prisma', '@prisma/client', 'sequelize', 'typeorm', 'mongoose', 'pg', 'mysql2', 'discord.js', 'telegraf', 'node-telegram-bot-api', '@slack/bolt', 'puppeteer', 'cheerio', 'crawlee', 'nodemailer', 'shopify-api-node', '@shopify/shopify-api', 'xero-node', '@medusajs/medusa', '@strapi/strapi', '@keystone-6/core']);
const GENERIC_PY = /^\s*"?(django|flask|fastapi|scrapy|selenium|celery|sqlalchemy|stripe|discord\.py|python-telegram-bot)\b/im;
const ZUKU_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](@zukujs\/[^'"\s]+|@zuku\/[^'"\s]+|zukujs(?:\/[^'"\s]*)?|zuku(?:\/[^'"\s]*)?)['"]/;
const GAME_LOOP = /\brequestAnimationFrame\s*\(/;
const RENDER_CTX = /\bgetContext\s*\(\s*['"](2d|webgl2?|webgpu)['"]/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Signal kinds and weights. A kind counts once however often it appears.
const WEIGHT = Object.freeze({
  MANIFEST_VALID: 3, DEP_ZUKUJS: 3, DEP_ZUKU: 3, IMPORT_ZUKUJS: 3, IMPORT_ZUKU: 3,
  SOURCE_ENTRY: 2, BIN_ZUKU: 2,
  MANIFEST_INVALID: 1, PACKAGE_NAME_ZUKU: 1, KEYWORD_ZUKU: 1, ZWF_ARTIFACT: 1, AGENT_STATE: 1,
  GAME_ENGINE_DEP: 3, GAME_RENDER_LOOP: 2, SHADER_SOURCE: 1, GAME_ASSETS: 1, WASM_MODULE: 1,
  GENERIC_DEP: 2, GENERIC_PYTHON: 2,
});
const ECOSYSTEM = new Set(['MANIFEST_VALID', 'DEP_ZUKUJS', 'DEP_ZUKU', 'IMPORT_ZUKUJS', 'IMPORT_ZUKU', 'SOURCE_ENTRY', 'BIN_ZUKU', 'MANIFEST_INVALID', 'PACKAGE_NAME_ZUKU', 'KEYWORD_ZUKU', 'ZWF_ARTIFACT', 'AGENT_STATE']);
const GAME = new Set(['GAME_ENGINE_DEP', 'GAME_RENDER_LOOP', 'SHADER_SOURCE', 'GAME_ASSETS', 'WASM_MODULE']);
const GENERIC = new Set(['GENERIC_DEP', 'GENERIC_PYTHON']);

/** Reads at most `max` bytes of a regular, single-link file without following links. */
export async function readHead(path, max) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) return undefined;
    const buffer = Buffer.alloc(Math.min(max, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { bytes: buffer.subarray(0, bytesRead), complete: bytesRead === stat.size };
  } catch { return undefined; } finally { await handle?.close().catch(() => {}); }
}

const isZukuName = name => typeof name === 'string' && (name === 'zukujs' || name === 'zuku' || name.startsWith('@zukujs/') || name.startsWith('@zuku/'));

function packageSignals(json, add) {
  if (!record(json)) return;
  if (isZukuName(json.name)) add('PACKAGE_NAME_ZUKU', 'package.json');
  if (Array.isArray(json.keywords) && json.keywords.some(word => ['zuku', 'zukujs', 'zwf'].includes(String(word).toLowerCase()))) add('KEYWORD_ZUKU', 'package.json');
  const bin = record(json.bin) ? json.bin : {};
  if (Object.keys(bin).some(name => name === 'zuku' || name === 'zukujs')) add('BIN_ZUKU', 'package.json');
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!record(json[field])) continue;
    for (const name of Object.keys(json[field]).slice(0, 2000)) {
      if (name === 'zukujs' || name.startsWith('@zukujs/')) add('DEP_ZUKUJS', `package.json#${field}`);
      else if (name === 'zuku' || name.startsWith('@zuku/')) add('DEP_ZUKU', `package.json#${field}`);
      else if (GAME_DEPS.has(name)) add('GAME_ENGINE_DEP', `package.json#${field}`);
      else if (GENERIC_DEPS.has(name)) add('GENERIC_DEP', `package.json#${field}`);
    }
  }
}

/**
 * classifyWorkspace({ cwd, request, signal }) -> frozen classification.
 * Evidence comes only from bounded regular files under `cwd` (manifest content, dependency
 * manifests, imports, project structure). `request` is accepted for interface symmetry but is
 * never evidence.
 */
export async function classifyWorkspace({ cwd = process.cwd(), signal } = {}) {
  cancelled(signal);
  let root, rootStat;
  try {
    const top = await lstat(cwd);
    if (top.isSymbolicLink() || !top.isDirectory()) throw new ScopeError('SCOPE_WORKSPACE_UNSAFE');
    root = await realpath(cwd);
    rootStat = await lstat(root);
    if (typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) throw new ScopeError('SCOPE_WORKSPACE_UNSAFE');
  } catch (error) {
    if (error instanceof ScopeError) throw error;
    throw new ScopeError('SCOPE_WORKSPACE_UNSAFE');
  }
  const signals = new Map();
  const add = (kind, path) => { if (!signals.has(kind)) signals.set(kind, { kind, path, weight: WEIGHT[kind] }); };
  let entries = 0, reads = 0, truncated = false, visible = 0, images = 0, audio = 0, manifest;
  const pending = [{ rel: '', depth: 0 }];
  while (pending.length) {
    cancelled(signal);
    const { rel, depth } = pending.shift();
    let list;
    try { list = await readdir(rel ? join(root, rel) : root, { withFileTypes: true }); } catch { continue; }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of list) {
      if (++entries > CLASSIFY_LIMITS.entries) { truncated = true; pending.length = 0; break; }
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.')) {
        if (!rel && entry.name === '.zukujs' && entry.isDirectory()) add('AGENT_STATE', '.zukujs');
        continue;
      }
      visible++;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth + 1 < CLASSIFY_LIMITS.depth) pending.push({ rel: name, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (ext === '.zwf') add('ZWF_ARTIFACT', name);
      if (SHADER.has(ext)) add('SHADER_SOURCE', name);
      if (ext === '.wasm') add('WASM_MODULE', name);
      if (IMAGE.has(ext)) images++;
      if (AUDIO.has(ext)) audio++;
      const wanted = (!rel && [PROJECT_MANIFEST, 'package.json', 'requirements.txt', 'pyproject.toml'].includes(entry.name)) || CODE.has(ext);
      if (!wanted) continue;
      if (reads >= CLASSIFY_LIMITS.readFiles) { truncated = true; continue; }
      reads++;
      const head = await readHead(join(root, name), CLASSIFY_LIMITS.readBytes);
      if (!head) continue;
      const text = head.bytes.toString('utf8');
      if (!rel && entry.name === PROJECT_MANIFEST) {
        const parsed = head.complete ? readManifest(head.bytes) : { diagnostics: [1] };
        if (parsed.manifest !== undefined && !validateManifest(parsed.manifest).length) { add('MANIFEST_VALID', name); manifest = normalizeManifest(parsed.manifest); }
        else add('MANIFEST_INVALID', name);
      } else if (!rel && entry.name === 'package.json') {
        try { packageSignals(JSON.parse(text), add); } catch { /* malformed package.json is no evidence */ }
      } else if (!rel && (entry.name === 'requirements.txt' || entry.name === 'pyproject.toml')) {
        if (GENERIC_PY.test(text)) add('GENERIC_PYTHON', name);
      } else {
        const match = ZUKU_IMPORT.exec(text);
        if (match) add(match[1].startsWith('@zuku/') || /^zuku(\/|$)/.test(match[1]) ? 'IMPORT_ZUKU' : 'IMPORT_ZUKUJS', name);
        if (GAME_LOOP.test(text) && RENDER_CTX.test(text)) add('GAME_RENDER_LOOP', name);
      }
    }
  }
  if (images && audio) add('GAME_ASSETS', '');
  if (manifest) {
    const entry = await lstat(join(root, manifest.source, manifest.entry)).catch(() => undefined);
    if (entry?.isFile() && !entry.isSymbolicLink()) add('SOURCE_ENTRY', `${manifest.source}/${manifest.entry}`);
  }
  const list = [...signals.values()];
  const score = set => list.filter(item => set.has(item.kind)).reduce((sum, item) => sum + item.weight, 0);
  const kinds = set => list.filter(item => set.has(item.kind)).length;
  const has = kind => signals.has(kind);
  const ecosystem = score(ECOSYSTEM), game = score(GAME), generic = score(GENERIC);
  const strongEcosystem = ecosystem >= 4 && kinds(ECOSYSTEM) >= 2;
  let classification = 'unknown';
  if (strongEcosystem && (has('MANIFEST_VALID') || has('DEP_ZUKUJS') || has('IMPORT_ZUKUJS'))) classification = 'zukujs';
  else if (strongEcosystem && (has('DEP_ZUKU') || has('IMPORT_ZUKU'))) classification = 'zuku';
  else if (strongEcosystem || (game >= 4 && kinds(GAME) >= 2) || (ecosystem >= 2 && game >= 2)) classification = 'zuku-compatible';
  else if (generic >= 2 && ecosystem <= 1 && game < 2) classification = 'out-of-scope';
  const digest = createHash('sha256').update(JSON.stringify([root, list.map(item => [item.kind, item.path])])).digest('hex');
  const result = Object.freeze({
    schema: CLASSIFICATION_SCHEMA, classification, empty: visible === 0, root,
    root_identity: Object.freeze({ dev: rootStat.dev, ino: rootStat.ino }),
    signals: Object.freeze(list.map(item => Object.freeze({ ...item }))),
    scores: Object.freeze({ ecosystem, game, generic }),
    manifest: manifest ? Object.freeze({ name: manifest.name, source: manifest.source, entry: manifest.entry }) : null,
    truncated, digest,
  });
  issued.add(result);
  return result;
}
