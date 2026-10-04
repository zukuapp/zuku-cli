import { lstat, realpath } from 'node:fs/promises';
import { basename, resolve, parse, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ProtocolError, sanitizeText } from '../agent-protocol/index.mjs';

const fail = code => { throw new ProtocolError(code); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function canonicalDirectory(path) {
  if (typeof path !== 'string' || !parse(path).root || path.length > 4096) fail('INVALID_INPUT');
  const requested = resolve(path);
  const walk = async absolute => {
    let current = parse(absolute).root;
    for (const part of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      const component = await lstat(current);
      if (component.isSymbolicLink() || !component.isDirectory()) fail('PROJECT_CHANGED');
    }
    return lstat(absolute);
  };
  const before = await walk(requested);
  const absolute = await realpath(requested);
  // Windows realpath expands case/8.3 aliases. Walk the original first so a
  // junction is never accepted, then recheck canonical components and identity.
  if (process.platform !== 'win32' && absolute !== requested) fail('PROJECT_CHANGED');
  const stat = await walk(absolute);
  if (!same(before, stat)) fail('PROJECT_CHANGED');
  if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) fail('PROJECT_CHANGED');
  return { path: absolute, dev: stat.dev, ino: stat.ino };
}
export function validateActor(actor) {
  if (!actor || !['native', 'browser'].includes(actor.kind) || typeof actor.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actor.id)) fail('PERMISSION_REQUIRED');
  if (actor.kind === 'browser' && (actor.origin !== 'https://ai.zuzunza.com' || !Array.isArray(actor.projectHandles) || actor.projectHandles.length > 128 || actor.projectHandles.some(value => typeof value !== 'string' || !/^project_[a-f0-9]{32}$/.test(value)))) fail('PERMISSION_REQUIRED');
  return actor;
}
export function actorCanAccess(actor, handle) {
  validateActor(actor);
  return actor.kind === 'native' || actor.projectHandles.includes(handle);
}
export function createProjectRegistry({ entries = [], classifyWorkspace, admitGameRequest, save } = {}) {
  const projects = new Map();
  if (!Array.isArray(entries) || entries.length > 128) fail('CORE_STATE_UNSAFE');
  for (const entry of entries) {
    if (!entry || !/^project_[a-f0-9]{32}$/.test(entry.id) || typeof entry.path !== 'string' || typeof entry.name !== 'string' || !Number.isSafeInteger(entry.dev) || !Number.isSafeInteger(entry.ino)) fail('CORE_STATE_UNSAFE');
    projects.set(entry.id, entry);
  }
  const check = async handle => {
    const entry = projects.get(handle); if (!entry) fail('PROJECT_NOT_FOUND');
    const current = await canonicalDirectory(entry.path).catch(() => fail('PROJECT_CHANGED'));
    if (!same(current, entry)) fail('PROJECT_CHANGED');
    return entry;
  };
  return Object.freeze({
    raw() { return [...projects.values()].map(entry => ({ ...entry })); },
    roots() { return [...projects.values()].map(entry => entry.path); },
    list(actor) { validateActor(actor); return [...projects.values()].filter(entry => actorCanAccess(actor, entry.id)).map(entry => ({ id: entry.id, projectHandle: entry.id, name: entry.name, classification: entry.classification })); },
    async get(handle, actor) { if (!actorCanAccess(actor, handle)) fail('PERMISSION_REQUIRED'); return check(handle); },
    async grant(params, actor) {
      validateActor(actor); if (actor.kind !== 'native') fail('NATIVE_PERMISSION_REQUIRED');
      const canonical = await canonicalDirectory(params.localPath);
      const classification = await classifyWorkspace({ cwd: canonical.path, request: params.request, signal: undefined });
      const purpose = params.purpose ?? 'game.maintain';
      const request = params.request ?? (purpose === 'game.init' ? 'Create a new ZUKU game project.' : 'Inspect this ZUKU game project.');
      await admitGameRequest(request, classification, { forceCreate: purpose === 'game.init' });
      const kind = typeof classification === 'string' ? classification : classification.classification ?? classification.kind;
      if (!['zuku', 'zukujs', 'zuku-compatible'].includes(kind) && !(kind === 'unknown' && purpose === 'game.init')) fail('AGENT_REQUEST_OUT_OF_SCOPE');
      const current = await canonicalDirectory(canonical.path); if (!same(current, canonical)) fail('PROJECT_CHANGED');
      const old = [...projects.values()].find(entry => entry.path === canonical.path && same(entry, canonical));
      if (old) return { id: old.id, projectHandle: old.id, name: old.name, classification: old.classification };
      if (projects.size >= 128) fail('PROJECT_LIMIT');
      const id = `project_${randomBytes(16).toString('hex')}`;
      const entry = { id, ...canonical, name: sanitizeText(params.name ?? basename(canonical.path), { roots: [canonical.path] }).slice(0, 120) || 'ZUKU Game', classification: kind, purpose };
      projects.set(id, entry);
      try { await save([...projects.values()]); } catch (error) { projects.delete(id); throw error; }
      return { id, projectHandle: id, name: entry.name, classification: kind };
    },
  });
}
