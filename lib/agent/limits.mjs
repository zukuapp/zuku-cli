// Hard, non-configurable bounds for one `zukujs agent` run. Every model stage, generated file
// and browser step is checked against these before anything is written or sent.
export const LIMITS = Object.freeze({
  requestChars: 4000,
  modelCalls: 10,
  stageAttempts: 2,
  repairs: 1,
  totalTokens: 600_000,
  stageOutputBytes: 96 * 1024,
  implementationOutputBytes: 1_600_000,
  files: 48,
  fileBytes: 512 * 1024,
  totalGeneratedBytes: 1_500_000,
  stageTimeoutMs: 240_000,
  playtestTimeoutMs: 120_000,
  browserLaunchTimeoutMs: 30_000,
  browserInstallTimeoutMs: 600_000,
  diagnosticBytes: 4096,
  receiptBytes: 256 * 1024,
  engineBundleBytes: 12 * 1024 * 1024,
});

export const RUN_ID = /^run_[0-9]{14}_[0-9a-f]{8}$/;
// Keep legacy bare IDs; provider/model suffixes are validated by the shared registry.
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/;
