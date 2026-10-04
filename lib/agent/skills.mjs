import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { AgentError } from './errors.mjs';

/*
 * Mandatory bundled game skill pack. The five SKILL.md files ship with the CLI and are pinned
 * by version and SHA-256 in skill-lock.json. A run loads all five, verifies them against the
 * lock, injects the full text into the matching stage instructions, and records
 * {name, version, sha256} in every stage receipt. There is no flag, context option or model
 * output that can skip, replace or "claim" a skill: stage outputs are validated by code gates.
 */
export const SKILL_NAMES = Object.freeze(['game-design', 'game-architecture', 'game-implementation', 'game-playtest', 'game-publish']);
export const SKILLS_ROOT = new URL('../../skills/', import.meta.url);
const LOCK_URL = new URL('./skill-lock.json', import.meta.url);
const MAX_SKILL_BYTES = 64 * 1024;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

// CRLF is normalized so a Windows checkout with autocrlf verifies identically.
export const skillDigest = text => createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

export function parseSkill(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(normalized);
  if (!match) return undefined;
  const meta = {};
  for (const line of match[1].split('\n')) {
    const field = /^([a-z]+):\s*(.+)$/.exec(line);
    if (field) meta[field[1]] = field[2].trim();
  }
  if (!SKILL_NAMES.includes(meta.name) || !VERSION.test(meta.version ?? '') || !meta.description) return undefined;
  return { name: meta.name, version: meta.version, description: meta.description, body: match[2].trim() };
}

async function readSkill(url) {
  let handle;
  try {
    handle = await open(url, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return undefined;
    return await handle.readFile('utf8');
  } catch { return undefined; } finally { await handle?.close().catch(() => {}); }
}

/** Loads and verifies the pack; `root`/`lock` exist for integrity tests, never for user overrides. */
export async function loadSkillPack({ root = SKILLS_ROOT, lock } = {}) {
  let pinned = lock;
  if (!pinned) {
    try { pinned = JSON.parse(await readFile(LOCK_URL, 'utf8')); } catch { throw new AgentError('AGENT_SKILL_INTEGRITY'); }
  }
  if (pinned?.schema !== 'zukujs-skill-lock/1' || !pinned.skills) throw new AgentError('AGENT_SKILL_INTEGRITY');
  const skills = new Map();
  for (const name of SKILL_NAMES) {
    const text = await readSkill(new URL(`${name}/SKILL.md`, root));
    const parsed = text && parseSkill(text);
    const expected = pinned.skills[name];
    const sha256 = text ? skillDigest(text) : '';
    if (!parsed || parsed.name !== name || !expected || parsed.version !== expected.version || sha256 !== expected.sha256) {
      throw new AgentError('AGENT_SKILL_INTEGRITY', { skill: name });
    }
    skills.set(name, Object.freeze({ ...parsed, sha256 }));
  }
  const packSha256 = createHash('sha256').update(SKILL_NAMES.map(name => `${name}@${skills.get(name).version}:${skills.get(name).sha256}\n`).join('')).digest('hex');
  if (pinned.pack_sha256 !== packSha256) throw new AgentError('AGENT_SKILL_INTEGRITY');
  return Object.freeze({
    version: pinned.version,
    sha256: packSha256,
    get(name) { const skill = skills.get(name); if (!skill) throw new AgentError('AGENT_SKILL_INTEGRITY'); return skill; },
    receipts: () => SKILL_NAMES.map(name => skillReceipt(skills.get(name))),
  });
}

export const skillReceipt = skill => ({ name: skill.name, version: skill.version, sha256: skill.sha256 });

/** The model must echo the exact receipt; this is a consistency check, not proof of application. */
export const receiptMatches = (claimed, skill) => claimed !== null && typeof claimed === 'object'
  && claimed.name === skill.name && claimed.version === skill.version && claimed.sha256 === skill.sha256;

/** Builds the lock content for the current files (used by tests and when skills are revised). */
export async function computeSkillLock({ root = SKILLS_ROOT, version = '1.0.0' } = {}) {
  const skills = {};
  let pack = '';
  for (const name of SKILL_NAMES) {
    const text = await readSkill(new URL(`${name}/SKILL.md`, root));
    const parsed = text && parseSkill(text);
    if (!parsed) throw new AgentError('AGENT_SKILL_INTEGRITY', { skill: name });
    skills[name] = { version: parsed.version, sha256: skillDigest(text) };
    pack += `${name}@${parsed.version}:${skills[name].sha256}\n`;
  }
  return { schema: 'zukujs-skill-lock/1', pack: 'zukujs-game-skills', version, pack_sha256: createHash('sha256').update(pack).digest('hex'), skills };
}
