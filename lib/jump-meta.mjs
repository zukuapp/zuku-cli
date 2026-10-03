// Pure mapping from a validated ZukuJS project + a verified upload receipt to the
// POST /api/v1/contents JUMP draft body (coordinator-verified deployed contract, 2026-10-04).
// No network, no filesystem. The upload command owns the requests; this only shapes data.
import { AGE_RATINGS, DESCRIPTION_MAX, GAME_ID_PATTERN, GENRE_PATTERN, TAGS_MAX, TAG_MAX, TITLE_MAX, VERSION_PATTERN } from './manifest-reader.mjs';

const UPLOAD_URL = /^\/uploads\/[0-9]{4}-[0-9]{2}\/[A-Za-z0-9_-]{1,128}\.(zwf|zip)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const isText = (value, max, codePoints) => typeof value === 'string' && (codePoints ? [...value].length : value.length) <= max;

export class JumpMetaError extends Error {
  constructor(field) { super(`invalid ${field}`); this.name = 'JumpMetaError'; this.field = field; }
}

/**
 * `upload` is the verified receipt: { url, format: 'zwf'|'zip', entry_point, size, sha256 }
 * where size/sha256 were already compared with the local package file.
 */
export function toJumpDraft(project, upload) {
  const check = (ok, field) => { if (!ok) throw new JumpMetaError(field); };
  // Re-checks every field so a non-normalized project cannot produce a malformed draft.
  check(project !== null && typeof project === 'object', 'project');
  check(isText(project.title, TITLE_MAX) && project.title.trim() !== '' && !CONTROL.test(project.title), 'title');
  check(isText(project.description, DESCRIPTION_MAX, true), 'description');
  check(Array.isArray(project.tags) && project.tags.length <= TAGS_MAX && new Set(project.tags).size === project.tags.length
    && project.tags.every(tag => isText(tag, TAG_MAX, true) && tag.trim() !== '' && !CONTROL.test(tag)), 'tags');
  check(AGE_RATINGS.includes(project.age_rating), 'age_rating');
  check(typeof project.game_id === 'string' && GAME_ID_PATTERN.test(project.game_id), 'game_id');
  check(project.genre === null || project.genre === undefined || (typeof project.genre === 'string' && GENRE_PATTERN.test(project.genre)), 'genre');
  check(typeof project.version === 'string' && VERSION_PATTERN.test(project.version), 'version');
  check(project.platform !== null && typeof project.platform === 'object' && ['pc', 'mobile', 'tablet'].every(key => typeof project.platform[key] === 'boolean'), 'platform');
  check(typeof project.entry === 'string', 'entry');
  check(typeof upload?.url === 'string' && UPLOAD_URL.test(upload.url), 'upload.url');
  check(['zwf', 'zip'].includes(upload.format) && upload.url.endsWith(`.${upload.format}`), 'upload.format');
  check(typeof upload.entry_point === 'string' && upload.entry_point === project.entry, 'upload.entry_point');
  check(Number.isSafeInteger(upload.size) && upload.size > 0, 'upload.size');
  check(typeof upload.sha256 === 'string' && SHA256.test(upload.sha256), 'upload.sha256');
  const jump = {
    game_id: project.game_id,
    game_type: 'html5',
    ...(project.genre ? { genre: project.genre } : {}),
    distribution_mode: 'online',
    platform: { pc: project.platform.pc, mobile: project.platform.mobile, tablet: project.platform.tablet },
    // Certification is never self-declared by the CLI.
    mobile_optimized: { certified: false, level: null },
    package: { format: upload.format, entry_point: upload.entry_point, size_bytes: upload.size, hash: upload.sha256, version: project.version, url: upload.url },
    play_count: 0, rating_avg: 0, rating_count: 0,
    status: 'draft',
  };
  return {
    category: 'jump', type: 'game', title: project.title, description: project.description,
    tags: [...project.tags], age_rating: project.age_rating, thumbnail_url: '', media_url: upload.url,
    publish_to_thread: false, jump,
  };
}
