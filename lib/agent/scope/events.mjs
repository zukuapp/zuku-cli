// Host events for Agent Core (lib/agent-core publicEvent) and the CLI renderer. The
// vocabulary is the shared protocol's (lib/agent-protocol EVENTS): tool.*, build.*, game.*
// as { type, data } and phase progress as { type: 'stage', stage, status }, which Agent Core
// maps to a fixed agent.reasoning_status phase. Payloads carry only fixed codes, ids,
// project-relative paths, digests and redacted bounded build output. Model text, private
// reasoning, absolute paths and secrets never appear.
import { ScopeError } from './errors.mjs';

export const EVENT_LIMIT = 10_000;
export const CAPABILITY = Object.freeze({
  read_file: 'project.read', write_file: 'project.write', patch_file: 'project.patch', search_project: 'project.search',
  run_build: 'zuku.build', run_tests: 'zuku.test', inspect_asset: 'asset.inspect', query_zuku_docs: 'docs.search',
});
export const capabilityFor = (tool, input) => (tool === 'run_zuku' ? (input?.action === 'playtest' ? 'game.preview' : 'zuku.build') : CAPABILITY[tool] ?? null);
// Stage names Agent Core maps to phases: architecture→analyzing, implementation→editing,
// package→building, playtest→testing, validate→verifying; status 'repair'→repairing.
export const STAGE_FOR_TOOL = Object.freeze({
  read_file: 'architecture', search_project: 'architecture', inspect_asset: 'architecture', query_zuku_docs: 'architecture',
  write_file: 'implementation', patch_file: 'implementation', run_build: 'package', run_tests: 'playtest', run_zuku: 'validate',
});
const TYPES = new Set(['stage', 'tool.requested', 'tool.started', 'tool.completed', 'tool.failed', 'build.started', 'build.output', 'build.completed', 'game.started', 'game.stopped']);
const STAGES = new Set(['architecture', 'implementation', 'package', 'playtest', 'validate', 'design']);
const STATUSES = new Set(['started', 'done', 'failed', 'repair']);

/**
 * Sink in front of context.onEvent. Host transitions (tool.*, build.*, game.*) are policy
 * events that Agent Core appends to its fsynced session journal: emit() awaits delivery and
 * rejects with SCOPE_STATE_UNSAFE when the host callback throws or rejects, so the runtime
 * never mutates a file or launches a command the journal did not accept. Only build.output
 * beyond `limit` is dropped. `stage` is coarse legacy progress that the loop does not await:
 * its delivery is best effort here (Agent Core's own sink still records a rejection and
 * aborts the run). The stderr line is a separate best-effort terminal render.
 */
export function createEventSink({ onEvent, stderr, quiet = true, limit = EVENT_LIMIT } = {}) {
  let count = 0, dropped = 0;
  const render = event => {
    if (!quiet && stderr?.write && event.type === 'stage') { try { stderr.write(`[zuku scope] ${event.stage} ${event.status}\n`); } catch { /* best effort */ } }
  };
  const deliver = async event => {
    render(event);
    if (typeof onEvent !== 'function') return;
    try { await onEvent(Object.freeze(event)); } catch { throw new ScopeError('SCOPE_STATE_UNSAFE', { reason: 'event_delivery' }); }
  };
  return {
    get dropped() { return dropped; },
    stage(stage, status) {
      if (!STAGES.has(stage) || !STATUSES.has(status)) return;
      if (++count > limit) { dropped++; return; }
      deliver({ type: 'stage', stage, status }).catch(() => {});
    },
    async emit(type, data = {}) {
      if (!TYPES.has(type) || type === 'stage') return;
      if (++count > limit && type === 'build.output') { dropped++; return; }
      await deliver({ type, data: Object.freeze({ ...data }) });
    },
  };
}
export const NULL_SINK = Object.freeze({ dropped: 0, stage() {}, async emit() {} });
