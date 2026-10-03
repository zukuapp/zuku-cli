import { lstat, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { UploadError } from './upload-errors.mjs';

/*
 * Local upload receipts. A receipt records only what a user needs to recover a non-atomic upload/draft
 * sequence: package hash/size/version, the server-issued /uploads path, draft id/status and a safe error
 * code. Tokens, request ids, account data and complete remote responses are never written.
 */
export const RECEIPT_SCHEMA = 'zukujs-upload-receipt/1';
export const DEFAULT_RECEIPT_DIR = join('.zukujs', 'receipts');
const MAX_RECEIPT_BYTES = 16_384;
const HEX64 = /^[0-9a-f]{64}$/;
const UPLOAD_PATH = /^\/uploads\/[0-9]{4}-[0-9]{2}\/[A-Za-z0-9_-]{1,128}\.(?:zwf|zip)$/;
const STATES = new Set(['upload_outcome_unknown', 'draft_not_attempted', 'upload_unverified', 'draft_rejected', 'draft_outcome_unknown', 'draft_unexpected_state', 'draft_created']);
const ENTRY = /^[A-Za-z0-9._ ()[\]/-]{1,256}$/;
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const pick = (value, test) => (test(value) ? value : null);

async function checkDirectory(path, uid) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UploadError('UPLOAD_RECEIPT_UNSAFE');
  if (typeof uid === 'number' && (stat.uid !== uid || (stat.mode & 0o022) !== 0)) throw new UploadError('UPLOAD_RECEIPT_UNSAFE');
}

/**
 * Validate (and create with 0700 if missing) the receipt directory before any network activity.
 * Existing components we would write into must be real directories, not symlinks; newly created
 * components are created one level at a time and rechecked.
 */
export async function prepareReceiptDir(dir = DEFAULT_RECEIPT_DIR, { cwd = process.cwd(), uid = process.getuid?.() } = {}) {
  if (typeof dir !== 'string' || dir.length < 1 || dir.length > 1024 || dir.includes('\0')) throw new UploadError('UPLOAD_RECEIPT_UNSAFE');
  const target = resolve(cwd, dir);
  // Walk from the deepest existing ancestor; every component we create or inherit below it is checked.
  const missing = [];
  let cursor = target;
  while (true) {
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UploadError('UPLOAD_RECEIPT_UNSAFE');
      break;
    } catch (error) {
      if (error instanceof UploadError) throw error;
      if (error?.code !== 'ENOENT') throw new UploadError('UPLOAD_RECEIPT_UNSAFE');
      const parent = dirname(cursor);
      if (parent === cursor || missing.length > 16) throw new UploadError('UPLOAD_RECEIPT_UNSAFE');
      missing.unshift(cursor); cursor = parent;
    }
  }
  for (const component of missing) {
    try { await mkdir(component, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw new UploadError('UPLOAD_RECEIPT_UNSAFE'); }
    await checkDirectory(component, uid);
  }
  await checkDirectory(target, uid);
  await checkChain(resolve(cwd), target, uid);
  return target;
}

/**
 * Reject symlinked path components. Inside cwd every component below cwd must be a real directory;
 * elsewhere only root-owned (system-managed, e.g. macOS /tmp) symlinks are tolerated.
 */
async function checkChain(base, target, uid) {
  const inside = relative(base, target);
  const within = inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
  const parts = within ? inside.split(sep).filter(Boolean) : target.split(sep).filter(Boolean);
  let cursor = within ? base : parse(target).root;
  for (const part of parts) {
    cursor = join(cursor, part);
    let stat;
    try { stat = await lstat(cursor); } catch { throw new UploadError('UPLOAD_RECEIPT_UNSAFE'); }
    if (stat.isSymbolicLink() && (within || typeof uid !== 'number' || stat.uid !== 0)) throw new UploadError('UPLOAD_RECEIPT_UNSAFE');
  }
}

/** Build a bounded, allowlisted receipt object. Unknown or malformed values become null. */
export function buildReceipt({ state, apiOrigin, pkg, upload, draft, error, cliVersion, now = new Date() }) {
  if (!STATES.has(state)) throw new UploadError('COMMAND_FAILED');
  return {
    schema: RECEIPT_SCHEMA,
    generator: { name: 'ZukuJS', cli_version: pick(cliVersion, v => typeof v === 'string' && SAFE_TOKEN.test(v)) },
    created_at: now.toISOString(),
    state,
    published: false,
    api_origin: pick(apiOrigin, v => typeof v === 'string' && /^https?:\/\/[A-Za-z0-9.[\]:-]{1,253}\/api\/v1$/.test(v)),
    package: {
      format: pick(pkg?.format, v => v === 'zwf' || v === 'zip'),
      size_bytes: pick(pkg?.size, v => Number.isSafeInteger(v) && v > 0),
      sha256: pick(pkg?.sha256, v => typeof v === 'string' && HEX64.test(v)),
      entry_point: pick(pkg?.entry_point, v => typeof v === 'string' && ENTRY.test(v)),
      version: pick(pkg?.version, v => typeof v === 'string' && SAFE_TOKEN.test(v)),
    },
    upload: upload ? { url: pick(upload.url, v => typeof v === 'string' && UPLOAD_PATH.test(v)), verified: upload.verified === true } : null,
    draft: draft ? { content_id: pick(draft.content_id, v => typeof v === 'string' && /^cnt_[A-Za-z0-9_-]{1,128}$/.test(v)), status: pick(draft.status, v => typeof v === 'string' && SAFE_TOKEN.test(v)) } : null,
    error: error ? { stage: pick(error.stage, v => typeof v === 'string' && SAFE_TOKEN.test(v)), code: pick(error.code, v => typeof v === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(v)), http_status: pick(error.httpStatus, v => Number.isSafeInteger(v) && v >= 100 && v <= 599) } : null,
    recovery: RECOVERY[state],
  };
}
const RECOVERY = Object.freeze({
  upload_outcome_unknown: 'The upload may or may not exist on the server. Do not assume failure; check your uploads before uploading again.',
  upload_unverified: 'The server returned an upload that does not match the local package. No draft was created.',
  draft_not_attempted: 'The package was uploaded and verified, but the draft request was not sent. Create a draft from upload.url; do not re-upload.',
  draft_rejected: 'The package was uploaded but the draft was rejected. Create a draft from upload.url after fixing metadata; do not re-upload.',
  draft_outcome_unknown: 'The package was uploaded; the draft may or may not exist. Check your drafts before creating another.',
  draft_unexpected_state: 'Content was created but not reported as draft. Review it in the service before taking any action.',
  draft_created: 'Draft created. Publishing is a separate explicit action and was not performed.',
});

/** Write a receipt with O_EXCL|O_NOFOLLOW (never overwriting, never following links), mode 0600. */
export async function writeReceipt(dir, receipt, { cwd = process.cwd(), uid = process.getuid?.() } = {}) {
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  if (bytes.length > MAX_RECEIPT_BYTES) throw new UploadError('UPLOAD_RECEIPT_UNSAFE');
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new UploadError('UPLOAD_RECEIPT_UNSAFE');
  await checkDirectory(dir, uid);
  const stamp = receipt.created_at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const file = join(dir, `zukujs-upload-${stamp}-${randomBytes(6).toString('hex')}.receipt.json`);
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(bytes);
    await handle.sync().catch(() => {});
  } catch { throw new UploadError('UPLOAD_RECEIPT_UNSAFE'); }
  finally { await handle?.close().catch(() => {}); }
  const shown = relative(cwd, file);
  return shown && !shown.startsWith('..') && !isAbsolute(shown) ? shown.split(sep).join('/') : file;
}
