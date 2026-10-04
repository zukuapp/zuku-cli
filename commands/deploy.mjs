import { DEFAULT_BASE_URL } from '../lib/api-client.mjs';
import { accountClient, oauthAccessToken, readQuota, readIdentity, readDeployment } from '../lib/accounts/client.mjs';
import { readZukuAccessToken } from '../lib/accounts/store.mjs';
import { AccountError } from '../lib/accounts/errors.mjs';
import { prepareReceiptDir, writeReceipt, DEFAULT_RECEIPT_DIR } from '../lib/upload-receipt.mjs';
import { newDeploymentKey, loadDeploymentOperation, saveDeploymentOperation, withDeploymentLock } from '../lib/accounts/deployment-store.mjs';
import { runUpload, parseUploadArgs } from './upload.mjs';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectPackageFile } from '../lib/project-package.mjs';
import { projectPackager } from '../lib/upload-project.mjs';

const ID = /^cnt_[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;
function parse(args) {
  if (!Array.isArray(args) || args.filter(x => x === '--yolo').length !== 1) throw new AccountError('DEPLOY_YOLO_REQUIRED');
  const rest = args.filter(x => x !== '--yolo');
  if (rest[0] === '--content') {
    if (![2, 4].includes(rest.length) || !ID.test(rest[1] ?? '') || rest.length === 4 && rest[2] !== '--receipt-dir') throw new AccountError('INVALID_INPUT');
    return { contentId: rest[1], receiptDir: rest[3] ?? DEFAULT_RECEIPT_DIR };
  }
  const upload = parseUploadArgs(rest);
  return { uploadArgs: rest, receiptDir: upload.receiptDir ?? DEFAULT_RECEIPT_DIR };
}
async function localPackage(parsed, context, cwd) {
  const fail = () => { throw new AccountError('DEPLOY_SOURCE_CHANGED', { definite: true }); };
  if (context.expectedPackageSha256 !== undefined && !SHA.test(context.expectedPackageSha256)) fail();
  if (parsed.contentId) return;
  const target = resolve(cwd, parseUploadArgs(parsed.uploadArgs).path);
  try {
    const stat = await lstat(target); if (stat.isSymbolicLink()) fail();
    let sha256, size;
    if (stat.isDirectory()) {
      const p = await (context.core ?? projectPackager).packageProject(target, { signal: context.signal });
      if (!(p?.bytes instanceof Uint8Array)) fail();
      sha256 = createHash('sha256').update(p.bytes).digest('hex'); size = p.bytes.byteLength;
    } else if (stat.isFile()) {
      const p = await inspectPackageFile(target); if (!p.valid) fail(); sha256 = p.sha256; size = p.bytes;
    } else fail();
    if (!size || size > 100 * 1024 * 1024 || context.expectedPackageSha256 !== undefined && sha256 !== context.expectedPackageSha256) fail();
    return { package_sha256: sha256, size_bytes: size };
  } catch (e) { if (context.signal?.aborted) throw new AccountError('COMMAND_CANCELLED', { definite: true }); if (e instanceof AccountError) throw e; fail(); }
}
function bound(op, identity, expected, baseUrl) {
  if (op.owner_id !== identity.id) throw new AccountError('ZUKU_ACCOUNT_CHANGED', { definite: true });
  if (op.api_base !== baseUrl || expected && (op.package_sha256 !== expected.package_sha256 || op.size_bytes !== expected.size_bytes)) throw new AccountError('DEPLOY_SOURCE_CHANGED', { definite: true });
}
async function connection(context) {
  const { signal, baseUrl = DEFAULT_BASE_URL, accountClientFactory = accountClient, zukuCredentials = readZukuAccessToken, accountStoreOptions = {}, now = Date.now } = context;
  if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED', { definite: true });
  const token = await zukuCredentials({ ...accountStoreOptions, baseUrl, signal, accountClientFactory, now });
  if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED', { definite: true });
  if (!oauthAccessToken(token)) throw new AccountError('ZUKU_LOGIN_REQUIRED');
  const client = await accountClientFactory(baseUrl, { accessToken: token, signal, timeoutMs: 600000 });
  const identity = readIdentity(await client.me());
  return { token, client, identity, baseUrl };
}
const showReceipt = async (dir, op, state, context) => {
  const receipt = { schema: 'zukujs-deploy-receipt/2', created_at: new Date((context.now ?? Date.now)()).toISOString(), api_origin: op.api_base, mode: 'yolo', state, published: state === 'published', owner_id: op.owner_id, idempotency_key: op.idempotency_key, content_id: op.content_id, package_sha256: op.package_sha256, size_bytes: op.size_bytes, source_verified: state === 'published' };
  try { return { saved: true, path: await writeReceipt(dir, receipt, { cwd: context.cwd }) }; } catch { return { saved: false, ...receipt }; }
};
function success(op, receipt, { recovered = false, idempotent = false, uploadReceipt } = {}) {
  return { status: 'published', published: true, mode: 'yolo', content: { id: op.content_id, status: 'published' }, package: { sha256: op.package_sha256, size_bytes: op.size_bytes }, idempotency_key: op.idempotency_key, owner_id: op.owner_id, source_verified: true, recovered, quota_consumed: idempotent ? false : null, idempotent, receipt, ...(uploadReceipt ? { upload_receipt: uploadReceipt } : {}) };
}
/** Read-only recovery, never a draft or publication retry. */
export async function recoverDeploy({ receiptDir = DEFAULT_RECEIPT_DIR, package_sha256, content_id, ...context } = {}) {
  const cwd = context.cwd ?? process.cwd();
  const dir = await prepareReceiptDir(receiptDir, { cwd });
  return withDeploymentLock(dir, async () => {
    const op = await loadDeploymentOperation(dir, { ...context, cwd });
    if (!op || package_sha256 !== undefined && op.package_sha256 !== package_sha256 || content_id !== undefined && op.content_id !== content_id) throw new AccountError('DEPLOY_RECOVERY_REQUIRED');
    const { client, identity, baseUrl } = await connection(context); bound(op, identity, undefined, baseUrl);
    const read = readDeployment(await client.deployment(op.idempotency_key), op, { complete: true });
    if (read.state === 'unknown') throw new AccountError('DEPLOY_OUTCOME_UNKNOWN');
    const next = { ...op, content_id: read.content_id, state: read.state === 'published' ? 'published' : 'draft' };
    await saveDeploymentOperation(dir, next, { ...context, cwd });
    if (read.state === 'not_published') return { status: 'not_published', content_id: next.content_id, package_sha256: next.package_sha256, size_bytes: next.size_bytes, idempotency_key: next.idempotency_key, source_verified: true };
    return success(next, await showReceipt(dir, next, 'published', { ...context, cwd }), { recovered: true, idempotent: true });
  }, { ...context, cwd });
}
/** One explicit --yolo, one durable owner/source-bound key, no mutation replay on ambiguity. */
export async function runDeploy(args, context = {}) {
  const parsed = parse(args); const cwd = context.cwd ?? process.cwd(); const signal = context.signal;
  if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED', { definite: true });
  const dir = await prepareReceiptDir(parsed.receiptDir, { cwd });
  const expected = await localPackage(parsed, context, cwd);
  return withDeploymentLock(dir, async () => {
    const { token, client, identity, baseUrl } = await connection(context);
    let op = await loadDeploymentOperation(dir, { ...context, cwd }); let uploaded;
    if (parsed.contentId && (!op || op.content_id !== parsed.contentId)) throw new AccountError('DEPLOY_RECOVERY_REQUIRED', { definite: true });
    if (op && op.owner_id !== identity.id) throw new AccountError('ZUKU_ACCOUNT_CHANGED', { definite: true });
    if (op && !['published', 'rejected'].includes(op.state)) bound(op, identity, expected, baseUrl);
    if (op && (!expected || op.package_sha256 === expected.package_sha256 && op.size_bytes === expected.size_bytes)) {
      bound(op, identity, expected, baseUrl);
      const read = readDeployment(await client.deployment(op.idempotency_key), op, { complete: true });
      if (read.state === 'published') {
        op = { ...op, content_id: read.content_id, state: 'published' }; await saveDeploymentOperation(dir, op, { ...context, cwd });
        return success(op, await showReceipt(dir, op, 'published', { ...context, cwd }), { recovered: true, idempotent: true });
      }
      if (read.state !== 'not_published') throw new AccountError('DEPLOY_OUTCOME_UNKNOWN');
      op = { ...op, content_id: read.content_id, state: 'draft' };
    } else {
      if (op && !['published', 'rejected'].includes(op.state)) throw new AccountError('DEPLOY_RECOVERY_REQUIRED');
      if (!expected) throw new AccountError('DEPLOY_RECOVERY_REQUIRED');
      const quota = readQuota(await client.quota());
      if (!quota.remaining) throw new AccountError('DEPLOY_QUOTA_EXCEEDED', { retryAfter: quota.retry_after, definite: true });
      op = { schema: 'zukujs-deployment/2', api_base: baseUrl, owner_id: identity.id, idempotency_key: newDeploymentKey(), ...expected, content_id: null, state: 'prepared', created_at: new Date((context.now ?? Date.now)()).toISOString() };
      await saveDeploymentOperation(dir, op, { ...context, cwd });
      await context.beforeGameMutation?.({ signal });
      if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED', { definite: true });
      let thumbnailUrl;
      if (context.thumbnail !== undefined) {
        const uploader = context.thumbnailUploader ?? (await import('../lib/game-cover.mjs')).uploadGameCover;
        const cover = await uploader(context.thumbnail, { cwd, thumbnailDirectory: context.thumbnailDirectory, baseUrl, accessToken: token, signal, clientFactory: context.clientFactory });
        if (cover?.verified !== true || !/^\/uploads\/[0-9]{4}-[0-9]{2}\/[A-Za-z0-9_-]{1,128}\.png$/.test(cover.url ?? '')) throw new AccountError('DEPLOY_REJECTED', { definite: true });
        thumbnailUrl = cover.url;
      }
      try {
        uploaded = await (context.runUpload ?? runUpload)(parsed.uploadArgs, { ...context, cwd, baseUrl, idempotencyKey: op.idempotency_key, credentials: async () => token, ...(thumbnailUrl ? { thumbnailUrl } : {}) });
        if (!ID.test(uploaded?.content?.id ?? '') || uploaded.content.status !== 'draft' || uploaded.package?.sha256 !== op.package_sha256 || uploaded.package?.size_bytes !== op.size_bytes) throw new AccountError('DEPLOY_SOURCE_CHANGED', { definite: true });
        op = { ...op, content_id: uploaded.content.id, state: 'draft' };
        const read = readDeployment(await client.deployment(op.idempotency_key), op, { complete: true });
        if (read.state !== 'not_published') throw new AccountError('DEPLOY_OUTCOME_UNKNOWN');
        await saveDeploymentOperation(dir, op, { ...context, cwd });
      } catch (e) {
        op.state = 'unknown'; await saveDeploymentOperation(dir, op, { ...context, cwd });
        if (e instanceof AccountError && e.definite) throw e;
        throw new AccountError('DEPLOY_OUTCOME_UNKNOWN', { receipt: await showReceipt(dir, op, 'unknown', { ...context, cwd }) });
      }
    }
    await context.beforeGameMutation?.({ signal });
    if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED', { definite: true });
    op.state = 'publishing'; await saveDeploymentOperation(dir, op, { ...context, cwd });
    await context.onProgress?.({ phase: 'publishing', content_id: op.content_id });
    let result;
    try { result = await client.publish(op.content_id, op.idempotency_key); } catch { /* Outcome remains unknown until bound readback. */ }
    let read;
    try { read = readDeployment(result, op, { complete: true }); } catch { /* Malformed or missing response is ambiguous. */ }
    const definite = result && result.status >= 400 && result.status < 500 && result.status !== 408 && result.data?.success === false && result.data.error?.code !== 'DEPLOY_OUTCOME_UNCERTAIN';
    if (read?.state !== 'published' && !definite && !signal?.aborted) {
      try { read = readDeployment(await client.deployment(op.idempotency_key), op, { complete: true }); } catch { /* No mutation retry. */ }
    }
    if (read?.state === 'published') {
      op.state = 'published'; await saveDeploymentOperation(dir, op, { ...context, cwd });
      return success(op, await showReceipt(dir, op, 'published', { ...context, cwd }), { recovered: result?.status !== 200, uploadReceipt: uploaded?.receipt });
    }
    const serverCode = result?.data?.error?.code;
    op.state = definite ? 'rejected' : 'unknown'; await saveDeploymentOperation(dir, op, { ...context, cwd });
    throw new AccountError(definite ? serverCode === 'PRODUCTION_DEPLOY_LIMIT' ? 'DEPLOY_QUOTA_EXCEEDED' : 'DEPLOY_REJECTED' : 'DEPLOY_OUTCOME_UNKNOWN', { definite: !!definite, serverCode, retryAfter: result?.retryAfter, receipt: await showReceipt(dir, op, op.state, { ...context, cwd }) });
  }, { ...context, cwd });
}
export default runDeploy;
