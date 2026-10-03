import { mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ProjectError } from '../lib/project-errors.mjs';
import { NAME_PATTERN, PROJECT_MANIFEST, PROJECT_SCHEMA, validateManifest } from '../lib/manifest-reader.mjs';
import { parsePathArgs } from './validate.mjs';

const TEMPLATE = new URL('../lib/templates/zukujs-html5/', import.meta.url);
const escapeHtml = value => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

export function projectManifest(name) {
  return {
    schema: PROJECT_SCHEMA,
    name,
    title: name,
    version: '0.1.0',
    description: 'ZukuJS로 만든 최소 HTML5 점프 게임입니다.',
    tags: [],
    age_rating: 'all',
    source: 'src',
    entry: 'index.html',
    jump: { game_id: `game_${name.replace(/-/g, '_')}`, genre: 'arcade', platform: { pc: true, mobile: true, tablet: true } },
    package: { format: 'zwf' },
  };
}

/** ZukuJS create <name>: new ./<name>/ playable HTML5 project; never touches existing paths. */
export default async function create(args = [], { cwd = process.cwd() } = {}) {
  const { path: name } = parsePathArgs(args);
  if (!NAME_PATTERN.test(name)) throw new ProjectError('INVALID_INPUT');
  const root = resolve(cwd, name);
  const manifest = projectManifest(name);
  if (validateManifest(manifest).length) throw new ProjectError('COMMAND_FAILED');
  const fill = async file => (await readFile(new URL(file, TEMPLATE), 'utf8')).replaceAll('{{TITLE}}', escapeHtml(name)).replaceAll('{{NAME}}', name);
  const files = [
    [PROJECT_MANIFEST, JSON.stringify(manifest, null, 2) + '\n'],
    ['README.md', await fill('README.md')],
    ['.gitignore', await fill('gitignore.txt')],
    ['src/index.html', await fill('src/index.html')],
    ['src/game.js', await fill('src/game.js')],
  ];
  try { await lstat(root); throw new ProjectError('PROJECT_EXISTS'); } catch (error) {
    if (error instanceof ProjectError) throw error;
    if (error?.code !== 'ENOENT') throw new ProjectError(error?.code === 'ENOTDIR' ? 'PROJECT_NOT_FOUND' : 'COMMAND_FAILED');
  }
  // Non-recursive mkdir fails atomically with EEXIST if anything appeared meanwhile.
  try { await mkdir(root, { mode: 0o755 }); } catch (error) {
    throw new ProjectError(error?.code === 'EEXIST' ? 'PROJECT_EXISTS' : error?.code === 'ENOENT' ? 'PROJECT_NOT_FOUND' : 'COMMAND_FAILED');
  }
  try {
    await mkdir(join(root, 'src'), { mode: 0o755 });
    for (const [file, content] of files) await writeFile(join(root, file), content, { flag: 'wx', mode: 0o644 });
  } catch {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw new ProjectError('COMMAND_FAILED');
  }
  return { path: root, name, files: files.map(([file]) => file).sort(), project: { name, title: manifest.title, version: manifest.version, source: manifest.source, entry: manifest.entry, format: manifest.package.format, game_id: manifest.jump.game_id } };
}
