import { checkProject, withFsErrors } from '../commands/validate.mjs';

// Shares the exact local validation and ZWF2/ZIP admission used by `package`.
// Upload receives the inspected bytes directly, without writing a temporary
// package into the source tree or trusting an earlier command's output.
export const projectPackager = Object.freeze({
  async packageProject(root, { signal } = {}) {
    return withFsErrors(async () => {
      const { project, result } = await checkProject(root, undefined, () => Boolean(signal?.aborted));
      return { bytes: result.bytes, metadata: project };
    });
  },
});
