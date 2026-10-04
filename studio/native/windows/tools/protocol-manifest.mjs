// Derives the Windows shell's protocol tables from the shared sources so the C#
// gate cannot drift: lib/agent-protocol/schema.mjs (methods, events, public keys,
// redaction patterns) and studio/native/bridge.js (renderer method allowlist).
// Usage: node protocol-manifest.mjs [--write|--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..', '..', '..');
export const MANIFEST = join(here, '..', 'src', 'ZukuStudio.Core', 'protocol-manifest.json');
// Never callable from the renderer, whatever bridge.js lists.
const NATIVE_PRIVATE = ['browser.grant', 'project.grant', 'preview.read', 'studio.open', 'native.projectChosen', 'native.resolvePreview', 'native.pairingDecision', 'native.authResponse'];

function extract(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) throw new Error(`protocol-manifest: cannot locate ${label}; update tools/protocol-manifest.mjs with the shared source`);
  return match[1];
}
const strings = list => [...list.matchAll(/'([^']+)'/g)].map(match => match[1]);

export async function buildManifest() {
  const schemaPath = join(ROOT, 'lib', 'agent-protocol', 'schema.mjs');
  const schemaText = readFileSync(schemaPath, 'utf8');
  const bridgeText = readFileSync(join(ROOT, 'studio', 'native', 'bridge.js'), 'utf8');
  const schema = await import(pathToFileURL(schemaPath).href);
  const allowed = strings(extract(bridgeText, /const allowed = new Set\(\[([^\]]+)\]\)/, 'bridge.js allowed set'));
  for (const method of allowed) {
    if (!Object.hasOwn(schema.METHODS, method)) throw new Error(`protocol-manifest: bridge method ${method} is not in schema METHODS`);
    if (NATIVE_PRIVATE.includes(method)) throw new Error(`protocol-manifest: bridge exposes private method ${method}`);
  }
  const methods = {};
  for (const method of [...allowed].sort()) {
    const spec = schema.METHODS[method];
    methods[method] = { required: Object.keys(spec.required).sort(), optional: Object.keys(spec.optional).filter(key => !spec.nativeOptional?.includes(key)).sort() };
  }
  const events = {};
  for (const type of Object.keys(schema.EVENTS).sort()) {
    const [required, optional] = schema.EVENTS[type];
    events[type] = { required: Object.keys(required).sort(), optional: Object.keys(optional).sort() };
  }
  return {
    generatedFrom: ['lib/agent-protocol/schema.mjs', 'studio/native/bridge.js'],
    protocolVersion: schema.PROTOCOL_VERSION,
    limits: { ...schema.LIMITS },
    rendererMethods: methods,
    nativePrivate: [...NATIVE_PRIVATE].sort(),
    events,
    publicKeys: [...schema.PUBLIC_RESULT_KEYS].sort(),
    secretKeyPattern: extract(schemaText, /^const SECRET_KEY = \/(.+)\/i;$/m, 'SECRET_KEY'),
    secretTextPattern: extract(schemaText, /^const SECRET_TEXT = \/(.+)\/;$/m, 'SECRET_TEXT'),
    credentialAssignmentPattern: extract(schemaText, /hasSecret\(text\) \|\| \/(.+?)\/i\.test\(text\)/, 'credential assignment pattern'),
    localPathPattern: extract(schemaText, /text = text\.replace\(\/(.+?)\/g, '\[local path\]'\)/, 'local path pattern'),
  };
}

export const serialize = manifest => JSON.stringify(manifest, null, 2) + '\n';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = serialize(await buildManifest());
  if (process.argv.includes('--write')) { writeFileSync(MANIFEST, text); console.log('protocol-manifest.json written'); }
  else if (readFileSync(MANIFEST, 'utf8') !== text) { console.error('protocol-manifest.json is stale; run: node studio/native/windows/tools/protocol-manifest.mjs --write'); process.exit(1); }
  else console.log('protocol-manifest.json matches schema.mjs and bridge.js');
}
