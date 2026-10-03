import { readFile } from 'node:fs/promises';
// Portable byte-identical snapshot of config/zukujs.json; provenance records its SHA.
export const identity = Object.freeze(JSON.parse(await readFile(new URL('./zukujs-metadata.json', import.meta.url), 'utf8')));
export const cliVersion = JSON.parse((await readFile(new URL('../package.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, '')).version;
export const meta = () => ({ runtime: identity.version, protocol: identity.command_protocol });
export const success = data => ({ success: true, data, meta: meta() });
