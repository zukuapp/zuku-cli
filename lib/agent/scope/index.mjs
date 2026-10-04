// Unified ZUKU/ZUKUJS game scope for the shared Agent Core: workspace classification,
// purpose admission, the capability-scoped tool runtime and the bounded existing-project
// agent loop. CLI, Studio and the Browser Adapter reach these only through Agent Core.
export { classifyWorkspace, CLASSIFICATIONS, CLASSIFICATION_SCHEMA } from './classify.mjs';
export { admitGameRequest, decideGameRequest, ADMISSION_SCHEMA } from './purpose.mjs';
export { createScopedToolRuntime } from './runtime.mjs';
export { runScopedGameAgent, verifyScopedResult, loadMandatorySkills, LOOP_LIMITS, SCOPE_STAGES } from './loop.mjs';
export { detectSandbox, createSandboxRunner } from './sandbox.mjs';
export { TOOL_IDS, STAGE_DEFINITIONS, admitStageSchema, toWireSchema } from './schema.mjs';
export { CAPABILITY } from './events.mjs';
export { ScopeError, SCOPE_REJECTED_MESSAGE } from './errors.mjs';
export { STATE_DIR, LOCK_FILE, RUN_SCHEMA, RECEIPT_SCHEMA } from './state.mjs';
