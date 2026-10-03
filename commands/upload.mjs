import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { CommandError } from '../lib/errors.mjs';
import { DEFAULT_BASE_URL } from '../lib/api-client.mjs';
import { readAccessToken } from '../lib/credentials.mjs';
import { cliVersion } from '../lib/identity.mjs';
import { UploadError, asUploadError } from '../lib/upload-errors.mjs';
import { inspectPackage, validTitle, LIMITS } from '../lib/upload-package.mjs';
import { uploadClient, multipartFraming, MAX_MULTIPART_BYTES, CONTENT_ID } from '../lib/upload-client.mjs';
import { prepareReceiptDir, buildReceipt, writeReceipt, DEFAULT_RECEIPT_DIR } from '../lib/upload-receipt.mjs';

/*
 * zukujs upload <path>: validate a local .zwf/.zip (or package a project directory through the injected
 * core packager), upload it with POST /uploads, verify the server receipt, then create a JUMP *draft*
 * with POST /contents. Publishing is never performed. Mutations are never retried.
 */
const MAX_FILE_BYTES = LIMITS.archiveBytes + 16 + LIMITS.manifestBytes;
const UPLOAD_PATH = /^\/uploads\/[0-9]{4}-[0-9]{2}\/[A-Za-z0-9_-]{1,128}\.(zwf|zip)$/;
const GAME_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z.-]{1,32})?$/;
const GENRE = /^[a-z][a-z0-9_-]{0,31}$/;
const AGE = new Set(['all', '12', '15', '18']);
const PLATFORMS = ['pc', 'mobile', 'tablet'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const VALUE_FLAGS = new Set(['--title', '--description', '--game-id', '--genre', '--version', '--age-rating', '--tag', '--platform', '--receipt-dir']);

/** Parse arguments strictly; unknown flags or a missing path are INVALID_INPUT (exit 2) before any I/O. */
export function parseUploadArgs(args) {
  if (!Array.isArray(args)) throw new CommandError('INVALID_INPUT');
  const options = { tags: [] };
  let path;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') throw new CommandError('INVALID_INPUT');
    if (arg === '--verify') { if (options.verify) throw new CommandError('INVALID_INPUT'); options.verify = true; continue; }
    if (VALUE_FLAGS.has(arg)) {
      const value = args[++i];
      if (typeof value !== 'string') throw new CommandError('INVALID_INPUT');
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key === 'tag') { options.tags.push(value); continue; }
      if (Object.hasOwn(options, key)) throw new CommandError('INVALID_INPUT');
      options[key] = value; continue;
    }
    if (arg.startsWith('-') || path !== undefined) throw new CommandError('INVALID_INPUT');
    path = arg;
  }
  if (!path || path.includes('\0')) throw new CommandError('INVALID_INPUT');
  return { path, ...options };
}

/** Build the exact JUMP draft body. Status is always draft; thread publishing is always false. */
export function buildDraftBody(meta, pkg, upload) {
  return {
    category: 'jump', type: 'game', title: meta.title, description: meta.description, tags: meta.tags, age_rating: meta.ageRating,
    thumbnail_url: '', media_url: upload.url, publish_to_thread: false,
    jump: {
      game_id: meta.gameId, game_type: 'html5', genre: meta.genre, distribution_mode: 'online',
      platform: meta.platform, mobile_optimized: { certified: false, level: null },
      package: { format: pkg.format, entry_point: pkg.entry_point, size_bytes: pkg.size, hash: pkg.sha256, version: meta.version, url: upload.url },
      play_count: 0, rating_avg: 0, rating_count: 0, status: 'draft',
    },
  };
}

/** Merge CLI flags over packager metadata over package defaults, then validate the public draft rules. */
export function resolveMetadata(options, pkg, projectMeta = {}) {
  const from = (flag, key) => options[flag] ?? (record(projectMeta) ? projectMeta[key] : undefined);
  const title = from('title', 'title') ?? pkg.title;
  const bad = reason => { throw new UploadError('UPLOAD_METADATA_INVALID', { reason, stage: 'metadata' }); };
  if (!validTitle(title)) bad('title');
  const description = from('description', 'description') ?? '';
  if (typeof description !== 'string' || [...description].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) bad('description');
  const tags = options.tags.length ? options.tags : (Array.isArray(projectMeta?.tags) ? projectMeta.tags : []);
  if (tags.length > 10 || !tags.every(tag => typeof tag === 'string' && tag.trim() !== '' && [...tag].length <= 50 && !/[\u0000-\u001f\u007f,]/.test(tag)) || new Set(tags).size !== tags.length) bad('tags');
  const ageRating = from('ageRating', 'age_rating') ?? 'all';
  if (!AGE.has(ageRating)) bad('age_rating');
  const derived = typeof title === 'string' ? 'game_' + title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 58) : '';
  const gameId = from('gameId', 'game_id') ?? (GAME_ID.test(derived) && derived !== 'game_' ? derived : undefined);
  if (typeof gameId !== 'string' || !GAME_ID.test(gameId)) bad('game_id');
  const genre = from('genre', 'genre') ?? 'arcade';
  if (typeof genre !== 'string' || !GENRE.test(genre)) bad('genre');
  const version = from('version', 'version') ?? '1.0.0';
  if (typeof version !== 'string' || !SEMVER.test(version)) bad('version');
  let platform = { pc: true, mobile: false, tablet: false };
  const declared = options.platform ?? projectMeta?.platform;
  if (typeof declared === 'string') {
    const names = declared.split(',');
    if (!names.length || !names.every(name => PLATFORMS.includes(name)) || new Set(names).size !== names.length) bad('platform');
    platform = Object.fromEntries(PLATFORMS.map(name => [name, names.includes(name)]));
  } else if (record(declared)) {
    if (Object.keys(declared).some(key => !PLATFORMS.includes(key)) || !PLATFORMS.every(key => typeof declared[key] === 'boolean') || !PLATFORMS.some(key => declared[key])) bad('platform');
    platform = { pc: declared.pc, mobile: declared.mobile, tablet: declared.tablet };
  } else if (declared !== undefined) bad('platform');
  return { title, description, tags, ageRating, gameId, genre, version, platform };
}

/** Read a regular, non-symlink file once (bounded) so the validated bytes are exactly the uploaded bytes. */
async function readPackageFile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw new UploadError('UPLOAD_INPUT_UNSAFE');
    if (stat.size > MAX_FILE_BYTES) throw new UploadError('UPLOAD_INPUT_TOO_LARGE');
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = await handle.read(new Uint8Array(1), 0, 1, offset);
    if (offset !== stat.size || extra.bytesRead !== 0) throw new UploadError('UPLOAD_INPUT_UNSAFE');
    return bytes;
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError('UPLOAD_INPUT_UNSAFE');
  } finally { await handle?.close().catch(() => {}); }
}

/** Verify the upload envelope against the local package before any draft is created. */
export function verifyUpload(result, pkg, apiOrigin) {
  const upload = result.status === 201 && record(result.envelope) && result.envelope.success === true && record(result.envelope.meta) && record(result.envelope.data) ? result.envelope.data.upload : undefined;
  if (!record(upload) || !record(upload.package)) return { ok: false };
  let url = upload.url;
  if (typeof url === 'string' && /^https?:/i.test(url)) {
    // An absolute URL is only accepted on the configured origin, then normalized to its /uploads path.
    try { const parsed = new URL(url); url = parsed.origin === new URL(apiOrigin).origin && !parsed.search && !parsed.hash && !parsed.username && !parsed.password ? parsed.pathname : undefined; } catch { url = undefined; }
  }
  const match = typeof url === 'string' ? UPLOAD_PATH.exec(url) : null;
  const ok = Boolean(match) && match[1] === pkg.format && upload.kind === pkg.kind && upload.mime === pkg.mediaType && upload.size === pkg.size && upload.sha256 === pkg.sha256
    && upload.package.format === pkg.format && upload.package.entry_point === pkg.entry_point && upload.package.scan === 'clean' && upload.package.file_count === pkg.file_count;
  return { ok, url: match ? url : undefined };
}

/**
 * Upload pipeline with dependency injection for the coordinator-owned entrypoint and core packager.
 * @param {string[]} args
 * @param {{signal?: AbortSignal, credentials?: () => Promise<string|undefined>, clientFactory?: Function,
 *   baseUrl?: string, core?: {packageProject: (dir: string, o: {signal?: AbortSignal}) => Promise<{bytes: Uint8Array, metadata?: object}>},
 *   validator?: object, cwd?: string, onProgress?: Function, now?: () => Date}} context
 */
export async function runUpload(args, context = {}) {
  const { signal, credentials = readAccessToken, clientFactory = uploadClient, baseUrl = DEFAULT_BASE_URL, core, validator, cwd = process.cwd(), onProgress, now = () => new Date() } = context;
  const options = parseUploadArgs(args);
  const cancelled = () => { if (signal?.aborted) throw new UploadError('COMMAND_CANCELLED'); };
  cancelled();
  // 1. Local input only: no credentials or network until the package and metadata are valid.
  const target = resolve(cwd, options.path);
  let stat;
  try { stat = await lstat(target); } catch { throw new UploadError('UPLOAD_INPUT_UNSAFE'); }
  if (stat.isSymbolicLink()) throw new UploadError('UPLOAD_INPUT_UNSAFE');
  let bytes, projectMeta;
  if (stat.isDirectory()) {
    if (typeof core?.packageProject !== 'function') throw new UploadError('UPLOAD_PACKAGER_UNAVAILABLE');
    let packaged;
    try { packaged = await core.packageProject(target, { signal }); } catch (error) { throw asUploadError(error, { stage: 'package' }); }
    if (!record(packaged) || !(packaged.bytes instanceof Uint8Array)) throw new UploadError('PACKAGE_INVALID', { reason: 'packager_output', stage: 'package' });
    bytes = packaged.bytes; projectMeta = packaged.metadata;
  } else if (stat.isFile()) {
    if (stat.size > MAX_FILE_BYTES) throw new UploadError('UPLOAD_INPUT_TOO_LARGE');
    bytes = await readPackageFile(target);
  } else throw new UploadError('UPLOAD_INPUT_UNSAFE');
  cancelled();
  const pkg = await inspectPackage(bytes, { validator });
  const meta = resolveMetadata(options, pkg, projectMeta);
  pkg.version = meta.version;
  if (multipartFraming(bytes.length, { filename: pkg.filename, mediaType: pkg.mediaType }).contentLength > MAX_MULTIPART_BYTES) throw new UploadError('UPLOAD_INPUT_TOO_LARGE');
  const receiptDir = await prepareReceiptDir(options.receiptDir ?? DEFAULT_RECEIPT_DIR, { cwd });
  cancelled();
  // 2. User Bearer credential is read only now, after all local checks passed.
  const token = await credentials();
  if (!token) throw new UploadError('UNAUTHORIZED');
  const client = await clientFactory(baseUrl, { accessToken: token, signal, onProgress });
  const apiOrigin = baseUrl;
  const save = async (state, extra) => {
    const receipt = buildReceipt({ state, apiOrigin, pkg, cliVersion, now: now(), ...extra });
    try { return { saved: true, path: await writeReceipt(receiptDir, receipt, { cwd }), receipt }; }
    catch { return { saved: false, receipt }; }
  };
  const failWithReceipt = async (error, state, extra) => {
    const failure = asUploadError(error);
    const saved = await save(state, { ...extra, error: { stage: failure.stage ?? extra.stage, code: failure.code, httpStatus: failure.httpStatus } });
    failure.receipt = saved.saved ? { saved: true, path: saved.path } : { saved: false, ...pickRecovery(saved.receipt) };
    return failure;
  };

  // 3. POST /uploads exactly once.
  let uploaded;
  try { uploaded = await client.uploadPackage({ bytes, filename: pkg.filename, mediaType: pkg.mediaType }); }
  catch (error) {
    if (error?.ambiguous) throw await failWithReceipt(error, 'upload_outcome_unknown', { upload: null, stage: 'upload' });
    throw asUploadError(error, { stage: 'upload' });
  }
  if (uploaded.status !== 201 || uploaded.envelope?.success !== true) {
    if (definiteRejection(uploaded)) throw client.apiFailure(uploaded.status, uploaded.envelope, 'upload');
    const failure = record(uploaded.envelope) && uploaded.envelope.success === false ? client.apiFailure(uploaded.status, uploaded.envelope, 'upload') : new UploadError('API_RESPONSE_INVALID', { stage: 'upload', httpStatus: uploaded.status });
    throw await failWithReceipt(failure, 'upload_outcome_unknown', { upload: null });
  }
  const verified = verifyUpload(uploaded, pkg, apiOrigin);
  if (!verified.ok) throw await failWithReceipt(new UploadError('UPLOAD_RECEIPT_MISMATCH', { stage: 'upload', httpStatus: uploaded.status }), 'upload_unverified', { upload: { url: verified.url, verified: false } });
  const upload = { url: verified.url, verified: true };

  // 4. POST /contents exactly once with a draft-only JUMP body.
  if (signal?.aborted) throw await failWithReceipt(new UploadError('COMMAND_CANCELLED', { stage: 'draft' }), 'draft_not_attempted', { upload });
  let created;
  try { created = await client.createDraft(buildDraftBody(meta, pkg, upload)); }
  catch (error) {
    throw await failWithReceipt(error, error?.ambiguous ? 'draft_outcome_unknown' : 'draft_rejected', { upload, stage: 'draft' });
  }
  const content = created.status === 201 && created.envelope?.success === true && record(created.envelope.meta) && record(created.envelope.data) ? created.envelope.data.content : undefined;
  if (!record(content) || typeof content.id !== 'string' || !CONTENT_ID.test(content.id) || !record(content.jump)) {
    if (definiteRejection(created)) throw await failWithReceipt(client.apiFailure(created.status, created.envelope, 'draft'), 'draft_rejected', { upload });
    if (record(created.envelope) && created.envelope.success === false) throw await failWithReceipt(client.apiFailure(created.status, created.envelope, 'draft'), 'draft_outcome_unknown', { upload });
    throw await failWithReceipt(new UploadError('API_RESPONSE_INVALID', { stage: 'draft', httpStatus: created.status }), 'draft_outcome_unknown', { upload });
  }
  const draft = { content_id: content.id, status: typeof content.jump.status === 'string' ? content.jump.status : null };
  if (draft.status !== 'draft') throw await failWithReceipt(new UploadError('DRAFT_STATE_UNEXPECTED', { stage: 'draft', httpStatus: created.status }), 'draft_unexpected_state', { upload, draft });

  // 5. Optional owner read-back (explicit --verify only), then the success receipt.
  let verification = { performed: false };
  if (options.verify) {
    let read;
    try { read = await client.getContent(draft.content_id); } catch (error) { read = { error: asUploadError(error, { stage: 'verify' }) }; }
    const readContent = read.status === 200 && read.envelope?.success === true && record(read.envelope.data) ? read.envelope.data.content : undefined;
    verification = { performed: true, owner_visible: record(readContent) && readContent.id === draft.content_id, status: record(readContent?.jump) && typeof readContent.jump.status === 'string' && /^[a-z_]{1,32}$/.test(readContent.jump.status) ? readContent.jump.status : null };
    if (read.error) verification.error = read.error.code;
    else if (!verification.owner_visible && Number.isSafeInteger(read.status)) verification.http_status = read.status;
  }
  const saved = await save('draft_created', { upload, draft });
  return {
    status: 'draft_created', published: false,
    content: { id: draft.content_id, status: 'draft' },
    package: { format: pkg.format, entry_point: pkg.entry_point, file_count: pkg.file_count, size_bytes: pkg.size, sha256: pkg.sha256, version: meta.version, validator: pkg.validator },
    upload: { url: upload.url, verified: true },
    verification,
    receipt: saved.saved ? { saved: true, path: saved.path } : { saved: false, ...pickRecovery(saved.receipt) },
  };
}
// 5xx/408 do not prove the server did not commit the mutation, so they are treated as ambiguous.
const definiteRejection = result => result.status >= 400 && result.status < 500 && result.status !== 408 && record(result.envelope) && result.envelope.success === false;
const pickRecovery = receipt => ({ state: receipt.state, upload_url: receipt.upload?.url ?? null, content_id: receipt.draft?.content_id ?? null, package_sha256: receipt.package.sha256 });

/**
 * Entry used by index.mjs. Until the coordinator wires a context object (signal + output), the legacy
 * one-argument call stays a no-I/O NOT_IMPLEMENTED so no real upload can run with its result discarded.
 */
export default async function upload(args, context) {
  if (context === undefined) throw new CommandError('NOT_IMPLEMENTED');
  return runUpload(args, context);
}
