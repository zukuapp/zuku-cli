// Public browser-safe renderer entry. No Node built-ins, network or credential APIs:
// another frontend may reuse the pure view by supplying its own protocol client.
export { mountStudio } from './app.mjs';
export { createStudioClient, createRequestId, validateParams, RENDERER_METHODS, NATIVE_ONLY, StudioClientError } from './client.mjs';
export { applyEvent, emptySessionView, admitInput, authBadge, describeError, normalizeProviders, normalizeModels, normalizeAuth } from './state.mjs';
export { diffLines, toHunks, DIFF_LIMITS } from './diff.mjs';
export { previewRect } from './preview.mjs';
