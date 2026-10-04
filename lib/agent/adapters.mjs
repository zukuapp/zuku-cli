import { AgentError } from './errors.mjs';

/*
 * Dependency boundary between the agent and modules owned by other integrators.
 *
 * provider  { runStage({experimental:true, stage, model, instructions, input, outputSchema, signal})
 *             -> {stage, output, usage, provider, experimental:true, unofficial:true} }
 *   default: lib/providers/codex-oauth.mjs createCodexOAuth() +
 *            lib/providers/codex-responses.mjs createCodexResponsesProvider({oauth})
 * deploy    { preflight({signal}) -> quota | {quota, account?}
 *             run(packagePath, {signal, yolo:true, receiptDir, thumbnail, package_sha256, project_root})
 *               -> {status:'published', content_id, url?, idempotent?, quota?}
 *             recover?({run_id, package_sha256, signal}) -> {status:'published'|'not_published', content_id?} }
 *   default: lib/accounts/deploy-quota.mjs readDeployQuota + commands/deploy.mjs runDeploy (root finalizes).
 * Root injects these through the agent context; defaults are imported lazily only when absent.
 */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,47}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function resolveProvider(provided) {
  let provider = provided;
  if (!provider) {
    try {
      const [{ createCodexOAuth }, { createCodexResponsesProvider }] = await Promise.all([import('../providers/codex-oauth.mjs'), import('../providers/codex-responses.mjs')]);
      provider = createCodexResponsesProvider({ oauth: createCodexOAuth() });
    } catch { throw new AgentError('AGENT_PROVIDER_UNAVAILABLE'); }
  }
  if (typeof provider?.runStage !== 'function') throw new AgentError('AGENT_PROVIDER_UNAVAILABLE');
  return provider;
}

export async function resolveDeploy(provided, context = {}) {
  let deploy = provided;
  if (!deploy) {
    try {
      const { createGameDeployAdapter } = await import('../accounts/deploy-quota.mjs');
      deploy = createGameDeployAdapter(context);
    } catch { throw new AgentError('AGENT_DEPLOY_UNAVAILABLE'); }
  }
  if (typeof deploy?.preflight !== 'function' || typeof deploy?.run !== 'function') throw new AgentError('AGENT_DEPLOY_UNAVAILABLE');
  return deploy;
}

const LOGIN_CODES = new Set(['UNAUTHORIZED', 'LOGIN_REQUIRED', 'CODEX_LOGIN_REQUIRED', 'CODEX_NOT_LOGGED_IN', 'CODEX_AUTH_REQUIRED', 'CODEX_REAUTH_REQUIRED', 'CODEX_EXPERIMENTAL_REQUIRED', 'EXPERIMENTAL_OPT_IN_REQUIRED', 'PROVIDER_UNAVAILABLE', 'OAUTH_REQUIRED', 'TOKEN_EXPIRED']);

/** Maps any provider failure to an allowlisted agent code; provider text is discarded. */
export function providerFailure(error, signal) {
  if (signal?.aborted || ['COMMAND_CANCELLED', 'CODEX_AUTH_CANCELLED'].includes(error?.code)) return new AgentError('COMMAND_CANCELLED');
  if (error instanceof AgentError) return error;
  const code = typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : undefined;
  if (code && LOGIN_CODES.has(code)) return new AgentError('AGENT_PROVIDER_UNAVAILABLE', { provider_code: code });
  if (error?.name === 'TimeoutError') return new AgentError('AGENT_PROVIDER_FAILED', { reason: 'stage_timeout' });
  return new AgentError('AGENT_PROVIDER_FAILED', code ? { provider_code: code } : undefined);
}

const nonNegative = value => Number.isSafeInteger(value) && value >= 0;
const isoDate = value => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));

/** Validates the authoritative quota snapshot; anything malformed fails closed. */
export function normalizeQuota(value) {
  const quota = record(value?.quota) ? value.quota : value;
  const pending = quota?.pending;
  if (!record(quota) || quota.limit !== 3 || quota.window_seconds !== 21600
    || !nonNegative(quota.used) || !nonNegative(pending) || !nonNegative(quota.remaining)
    || quota.used + pending > 3 || quota.remaining !== 3 - quota.used - pending
    || (quota.reset_at != null && !isoDate(quota.reset_at))
    || (quota.retry_after != null && (!nonNegative(quota.retry_after) || quota.retry_after > 21600 || (quota.remaining > 0 && quota.retry_after !== 0)))) {
    throw new AgentError('AGENT_DEPLOY_UNAVAILABLE', { reason: 'quota_invalid' });
  }
  return {
    limit: quota.limit, window_seconds: quota.window_seconds, used: quota.used, pending, remaining: quota.remaining,
    reset_at: isoDate(quota.reset_at) ? quota.reset_at : null,
    retry_after: nonNegative(quota.retry_after) ? quota.retry_after : null,
  };
}

export function preflightFailure(error, signal) {
  if (signal?.aborted || error?.code === 'COMMAND_CANCELLED') return new AgentError('COMMAND_CANCELLED');
  if (error instanceof AgentError) return error;
  if (error?.code === 'DEPLOY_QUOTA_EXCEEDED') return quotaExceeded(error);
  return new AgentError('AGENT_DEPLOY_UNAVAILABLE', typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? { deploy_code: error.code } : undefined);
}

export const quotaExceeded = source => new AgentError('DEPLOY_QUOTA_EXCEEDED', {
  retry_after: nonNegative(source?.retry_after ?? source?.retryAfter) ? (source.retry_after ?? source.retryAfter) : undefined,
  reset_at: isoDate(source?.reset_at) ? source.reset_at : undefined,
});

const CONTENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const safeUrl = value => {
  if (typeof value !== 'string' || value.length > 300) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
};

/** A successful publish must be explicit and well-formed; anything else is an unknown outcome. */
export function normalizePublish(result) {
  if (!record(result) || result.status !== 'published' || typeof result.content_id !== 'string' || !CONTENT_ID.test(result.content_id)) return undefined;
  let quota = null;
  try { if (result.quota) quota = normalizeQuota(result.quota); } catch { quota = null; }
  return { status: 'published', content_id: result.content_id, url: safeUrl(result.url), idempotent: result.idempotent === true, quota };
}

/**
 * Classifies a failed publish mutation. Only explicit, definite rejections are "rejected";
 * timeouts, network errors, cancellation mid-request and anything unclassifiable are "unknown"
 * and are never retried automatically.
 */
export function classifyPublishFailure(error, signal) {
  const status = Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : Number.isSafeInteger(error?.status) ? error.status : undefined;
  const code = typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : undefined;
  if (code === 'DEPLOY_QUOTA_EXCEEDED' || status === 429) return { outcome: 'rejected', error: quotaExceeded(error) };
  if (error?.definite === true && error?.ambiguous !== true && error?.code === 'COMMAND_CANCELLED') {
    return { outcome: 'rejected', error: new AgentError('COMMAND_CANCELLED') };
  }
  if (error?.definite === true && error?.ambiguous !== true) {
    return { outcome: 'rejected', error: new AgentError('AGENT_PUBLISH_REJECTED', code ? { deploy_code: code } : undefined) };
  }
  if (signal?.aborted || error?.ambiguous === true || code === 'DEPLOY_OUTCOME_UNKNOWN') return { outcome: 'unknown', error: new AgentError('AGENT_PUBLISH_OUTCOME_UNKNOWN') };
  if (error?.definite === true || (status !== undefined && status >= 400 && status < 500 && status !== 408)) {
    return { outcome: 'rejected', error: new AgentError('AGENT_PUBLISH_REJECTED', code ? { deploy_code: code } : undefined) };
  }
  return { outcome: 'unknown', error: new AgentError('AGENT_PUBLISH_OUTCOME_UNKNOWN') };
}
