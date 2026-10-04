// Shared transport metadata; importing this module needs no Node runtime.
export const ADAPTER_PROTOCOL = 1;
export const ADAPTER_PORT = 43127;
export const ADAPTER_ORIGIN = 'https://ai.zuzunza.com';
export const ADAPTER_LIMITS = Object.freeze({
  bodyBytes: 65536, responseBytes: 256 * 1024, promptChars: 4000, challengeMs: 120000, tokenMs: 1800000,
  pendingChallenges: 1, tokens: 16, sessions: 32, activeInputs: 1,
  requestIds: 4096, inputsPerSession: 128, eventBytes: 16384,
  retainedEvents: 256, retainedBytes: 1024 * 1024, streamsPerSession: 2,
  heartbeatMs: 15000, inputMs: 3600000,
});
export const ADAPTER_EVENT_TYPES = Object.freeze([
  'session.created', 'session.closed', 'agent.started', 'agent.delta', 'agent.reasoning_status',
  'agent.completed', 'agent.cancelled', 'agent.error', 'tool.requested', 'tool.started',
  'tool.completed', 'tool.failed', 'build.started', 'build.output', 'build.completed',
  'game.started', 'game.stopped', 'preview.started', 'preview.updated', 'provider.changed',
  'model.changed', 'auth.required', 'permission.required',
]);
