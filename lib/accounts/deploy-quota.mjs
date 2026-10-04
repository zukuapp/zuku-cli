import { DEFAULT_BASE_URL } from '../api-client.mjs';
import { accountClient, oauthAccessToken, readQuota } from './client.mjs';
import { readZukuAccessToken, captureZukuAccountGeneration } from './store.mjs';
import { AccountError } from './errors.mjs';
import { resolve } from 'node:path';

const SHA = /^[a-f0-9]{64}$/;
const ID = /^cnt_[A-Za-z0-9_-]{1,128}$/;
const RUN_ID = /^run_[0-9]{14}_[a-f0-9]{8}$/;
export async function readDeployQuota(context = {}) {
  const { baseUrl = DEFAULT_BASE_URL, signal, accountClientFactory = accountClient, zukuCredentials = readZukuAccessToken, accountStoreOptions = {} } = context;
  if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
  const token = await zukuCredentials({ ...accountStoreOptions, baseUrl, signal, accountClientFactory });
  if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED');
  if (!oauthAccessToken(token)) throw new AccountError('ZUKU_LOGIN_REQUIRED');
  const client = await accountClientFactory(baseUrl, { accessToken: token, signal });
  return readQuota(await client.quota());
}
function normalize(result, expected) {
  if (result?.status !== 'published' || result.published !== true || result.source_verified !== true || !ID.test(result.content?.id ?? '') || result.content.status !== 'published' || !SHA.test(result.package?.sha256 ?? '') || !Number.isSafeInteger(result.package?.size_bytes) || result.package.size_bytes < 1 || expected !== undefined && result.package.sha256 !== expected) throw new AccountError('DEPLOY_OUTCOME_UNKNOWN', { receipt: result?.receipt });
  return { status: 'published', content_id: result.content.id, url: null, idempotent: result.idempotent === true, quota: null, package_sha256: result.package.sha256, size_bytes: result.package.size_bytes, idempotency_key: result.idempotency_key, source_verified: true, receipt: result.receipt, ...(result.upload_receipt ? { upload_receipt: result.upload_receipt } : {}) };
}
export function createGameDeployAdapter(context = {}) {
  const cwd = resolve(context.cwd ?? process.cwd()); const baseUrl = context.baseUrl ?? DEFAULT_BASE_URL;
  const readCredentials = context.zukuCredentials ?? readZukuAccessToken;
  const ownStore = context.zukuCredentials === undefined;
  let snapshot;
  const checkedToken = async signal => {
    if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED', { definite: true });
    const before = ownStore ? await captureZukuAccountGeneration(context.accountStoreOptions) : undefined;
    const token = await readCredentials({ ...context.accountStoreOptions, baseUrl, signal, accountClientFactory: context.accountClientFactory });
    if (signal?.aborted) throw new AccountError('COMMAND_CANCELLED', { definite: true });
    const after = ownStore ? await captureZukuAccountGeneration(context.accountStoreOptions) : undefined;
    if (!oauthAccessToken(token)) throw new AccountError('ZUKU_LOGIN_REQUIRED', { definite: true });
    if (ownStore && before !== after || snapshot && (ownStore ? snapshot.generation !== after : snapshot.token !== token)) throw new AccountError('ZUKU_ACCOUNT_CHANGED', { definite: true });
    snapshot = { token, generation: after }; return token;
  };
  const mutationGuard = signal => async () => { await context.beforeGameMutation?.({ signal }); await checkedToken(signal); };
  return Object.freeze({
    async preflight(options = {}) {
      const signal = options.signal ?? context.signal; const token = await checkedToken(signal);
      return readDeployQuota({ ...context, signal, zukuCredentials: async () => token });
    },
    async run(path, { signal = context.signal, yolo, receiptDir, thumbnail, package_sha256, project_root } = {}) {
      if (yolo !== true) throw new AccountError('DEPLOY_YOLO_REQUIRED');
      if (package_sha256 !== undefined && !SHA.test(package_sha256)) throw new AccountError('DEPLOY_SOURCE_CHANGED', { definite: true });
      const token = await checkedToken(signal); const { runDeploy } = await import('../../commands/deploy.mjs');
      const result = await runDeploy([project_root ?? path, '--yolo', ...(receiptDir ? ['--receipt-dir', receiptDir] : [])], { ...context, cwd, signal, thumbnail, expectedPackageSha256: package_sha256, thumbnailDirectory: context.thumbnailDirectory ?? resolve(cwd, '.zukujs', 'agent'), zukuCredentials: async () => token, beforeGameMutation: mutationGuard(signal) });
      return normalize(result, package_sha256);
    },
    async recover({ run_id, signal = context.signal, package_sha256, receiptDir } = {}) {
      if (!SHA.test(package_sha256 ?? '') || receiptDir === undefined && !RUN_ID.test(run_id ?? '')) throw new AccountError('DEPLOY_RECOVERY_REQUIRED');
      const token = await checkedToken(signal); const { recoverDeploy } = await import('../../commands/deploy.mjs');
      const result = await recoverDeploy({ ...context, cwd, signal, receiptDir: receiptDir ?? resolve(cwd, '.zukujs', 'agent', 'runs', run_id), package_sha256, zukuCredentials: async () => token });
      return result.status === 'not_published' ? result : normalize(result, package_sha256);
    },
  });
}
