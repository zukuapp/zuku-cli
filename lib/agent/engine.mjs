import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { LIMITS } from './limits.mjs';

/*
 * Engine bundles. Phaser is the default 2D engine, but only when the CLI installation carries a
 * local `phaser` package: its dist/phaser.min.js is copied into the generated project as
 * src/vendor/phaser.min.js, so games never depend on a network CDN. Without the bundle the
 * agent offers only the plain Canvas engine (the `zukujs create` scaffold family) and records why.
 */
const require = createRequire(import.meta.url);

async function readBounded(path, max) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > max) throw new Error('unsafe');
  return readFile(path);
}

/** Returns { name, version, bytes, license, sha256 } or undefined when no local bundle exists. */
export async function resolvePhaser({ resolvePackage = id => require.resolve(id) } = {}) {
  let root;
  try { root = dirname(resolvePackage('phaser/package.json')); } catch { return undefined; }
  try {
    const pkg = JSON.parse((await readBounded(join(root, 'package.json'), 64 * 1024)).toString('utf8'));
    if (pkg?.name !== 'phaser' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(pkg.version ?? '')) return undefined;
    const bytes = await readBounded(join(root, 'dist', 'phaser.min.js'), LIMITS.engineBundleBytes);
    let license;
    for (const name of ['LICENSE.md', 'LICENSE', 'license.txt']) {
      try { license = (await readBounded(join(root, name), 64 * 1024)).toString('utf8'); break; } catch { /* try next */ }
    }
    return Object.freeze({ name: 'phaser', version: pkg.version, bytes, license, sha256: createHash('sha256').update(bytes).digest('hex') });
  } catch { return undefined; }
}

export async function availableEngines(injected) {
  const phaser = injected === null ? undefined : injected ?? await resolvePhaser();
  return { phaser, names: phaser ? ['phaser', 'canvas'] : ['canvas'] };
}
