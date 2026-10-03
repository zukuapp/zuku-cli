import { CommandError } from './errors.mjs';
// Prototype APIs must not claim a project is valid until the owned schema is implemented.
export function readManifest() { throw new CommandError('NOT_IMPLEMENTED'); }
export function validateManifest() { throw new CommandError('NOT_IMPLEMENTED'); }
