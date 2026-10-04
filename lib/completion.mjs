import { CommandError } from './errors.mjs';

export function completion(args, commands) {
  if (args.length !== 1 || !['bash', 'zsh', 'fish'].includes(args[0])) throw new CommandError('INVALID_INPUT');
  const shell = args[0];
  // All words originate in the finite command registry, never user text.
  if (!commands.every(word => /^[a-z][a-z0-9-]*$/.test(word))) throw new CommandError('COMMAND_FAILED');
  const words = [...commands, '--help', '--version', '--json'].join(' ');
  const script = shell === 'bash'
    ? `complete -W '${words}' zuku zukujs\n`
    : shell === 'zsh'
      ? `#compdef zuku zukujs\n_arguments '1:command:(${words})' '*:path:_files'\n`
      : ['zuku', 'zukujs'].flatMap(alias => commands.map(word => `complete -c ${alias} -n '__fish_use_subcommand' -a '${word}'`)).join('\n') + '\n';
  return { shell, script };
}
