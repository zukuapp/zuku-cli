import { ProviderError } from './errors.mjs';
import { validateStageSchema, validateStageOutput } from '../providers/codex-responses.mjs';

export const HARD_STAGE_OUTPUT_BYTES = 1_600_000;

/** Host-owned finite game schemas only; never execute arbitrary regex from a model. */
export function admitStageSchema(schema) {
  let text;
  try { text = JSON.stringify(schema); } catch { throw new ProviderError('STAGE_SCHEMA_REJECTED'); }
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) throw new ProviderError('STAGE_SCHEMA_REJECTED');
  try { validateStageSchema(schema); } catch { throw new ProviderError('STAGE_SCHEMA_REJECTED'); }
  return true;
}

export function stageOutputBudget(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ProviderError('STAGE_SCHEMA_REJECTED');
  return Math.min(value, HARD_STAGE_OUTPUT_BYTES);
}

export async function admitStageRequest(request, host) {
  const maxOutputBytes = stageOutputBudget(request.maxOutputBytes);
  admitStageSchema(request.outputSchema);
  try {
    if (host?.admit && await host.admit(request.outputSchema) === false) throw Error();
  } catch { throw new ProviderError('STAGE_SCHEMA_REJECTED'); }
  return maxOutputBytes;
}

export async function admitStageResult(output, request, host) {
  try {
    if (Buffer.byteLength(JSON.stringify(output) ?? '') > request.maxOutputBytes) throw Error();
    validateStageOutput(output, request.outputSchema);
    if (host?.validate && await host.validate(request.outputSchema, output) === false) throw Error();
  } catch { throw new ProviderError('STAGE_OUTPUT_INVALID'); }
}
