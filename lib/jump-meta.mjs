// Pure mapping from a validated ZukuJS project + a verified upload receipt to the
// POST /api/v1/contents JUMP draft body (coordinator-verified deployed contract, 2026-10-04).
// No network, no filesystem. The upload command owns the requests; this only shapes data.
import { AGE_RATINGS, DESCRIPTION_MAX, TAGS_MAX, TITLE_MAX } from './manifest-reader.mjs';

const UPLOAD_URL = /^\/uploads\/[0-9]{4}-[0-9]{2}\/[A-Za-z0-9_-]{1,128}\.(zwf|zip)$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class JumpMetaError extends Error {
  constructor(field) { super(`invalid ${field}`); this.name = 'JumpMetaError'; this.field = field; }
}

/**
 * `upload` is the verified receipt: { url, format: 'zwf'|'zip', entry_point, size, sha256 }
 * where size/sha256 were already compared with the local package file.
 */
export function toJumpDraft(project, upload) {
  const check = (ok, field) => { if (!ok) throw new JumpMetaError(field); };
  check(typeof project?.title === 'string' && project.title.length >= 1 && project.title.length <= TITLE_MAX && project.title.trim() !== '', 'title');
  check(typeof project.description === 'string' && [...project.description].length <= DESCRIPTION_MAX, 'description');
  check(Array.isArray(project.tags) && project.tags.length <= TAGS_MAX, 'tags');
  check(AGE_RATINGS.includes(project.age_rating), 'age_rating');
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
