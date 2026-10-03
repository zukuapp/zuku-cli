#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { identity, cliVersion, meta, success } from './lib/identity.mjs';
import { CommandError } from './lib/errors.mjs';

const COMMANDS = Object.freeze([
  { name: 'system.help', alias: 'help', usage: 'zuku help', description: '사용 가능한 명령 안내' },
  { name: 'system.version', alias: 'version', usage: 'zuku version', description: 'ZukuJS·명령 규격·CLI 버전' },
  { name: 'app.status', alias: 'status', usage: 'zuku status [--check-api]', description: 'CLI 연결과 인증 설정 진단' },
  { name: 'diagnostics', alias: 'diagnostics', usage: 'zuku diagnostics [--check-api]', description: '읽기 전용 API 진단' },
  ...['create', 'validate', 'package', 'upload'].map(name => ({ name, alias: name, usage: `zuku ${name} <${name === 'create' ? 'name' : 'path'}>`, description: '미구현 시제품: NOT_IMPLEMENTED로 종료' })),
]);
const helpText = () => `ZukuJS v${identity.version} — zuku CLI ${cliVersion}\n\nUsage: zuku <command> [options]\n\n${COMMANDS.map(item => `  ${item.usage.padEnd(36)} ${item.description}`).join('\n')}\n\nOptions:\n  --help, -h       도움말\n  --version, -v    버전\n  --json           success/data/error/meta 응답\n  --check-api      공개 API GET 진단 (자동 로그인·결제·업로드 없음)\n\n인증: ZUKU_ACCESS_TOKEN 또는 사용자 소유 0600 credentials.json.\n내부 서비스 키는 CLI에서 사용하지 않습니다.\n`;

export async function run(args = [], { stdout = process.stdout, stderr = process.stderr, signal, diagnostics: diagnosticOverride } = {}) {
  const json = args.includes('--json');
  const positional = args.filter(arg => arg !== '--json');
  const requested = positional[0];
  const aliases = { '--help': 'help', '-h': 'help', '--version': 'version', '-v': 'version', 'system.help': 'help', 'system.version': 'version', 'app.status': 'status' };
  const command = aliases[requested] ?? requested ?? 'help';
  try {
    if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
    let data;
    if (command === 'help') {
      if (positional.length > 1) throw new CommandError('INVALID_INPUT');
      data = COMMANDS;
      if (!json) { stdout.write(helpText()); return 0; }
    } else if (command === 'version') {
      if (positional.length > 1) throw new CommandError('INVALID_INPUT');
      data = { runtime: identity.name, version: identity.version, command_protocol: identity.command_protocol, cli_version: cliVersion };
    } else if (command === 'status' || command === 'diagnostics') {
      if (positional.slice(1).some(arg => arg !== '--check-api') || positional.filter(arg => arg === '--check-api').length > 1) throw new CommandError('INVALID_INPUT');
      const diagnostics = diagnosticOverride ?? (await import('./commands/diagnostics.mjs')).default;
      data = await diagnostics({ checkApi: positional.includes('--check-api'), signal });
    } else if (['create', 'validate', 'package', 'upload'].includes(command)) {
      const execute = (await import(`./commands/${command}.mjs`)).default;
      await execute(positional.slice(1));
    } else throw new CommandError('UNKNOWN_COMMAND');
    if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
    stdout.write(json ? JSON.stringify(success(data)) + '\n' : JSON.stringify(data, null, 2) + '\n');
    return 0;
  } catch (error) {
    const safe = error instanceof CommandError ? error : new CommandError('COMMAND_FAILED');
    const result = { success: false, error: safe.toJSON(), meta: meta() };
    stderr.write(json ? JSON.stringify(result) + '\n' : `${safe.code}: ${safe.message}\n`);
    return safe.code === 'COMMAND_CANCELLED' ? 130 : ['INVALID_INPUT', 'UNKNOWN_COMMAND'].includes(safe.code) ? 2 : 1;
  }
}
let entrypoint = false;
if (process.argv[1]) {
  try { entrypoint = await realpath(new URL(import.meta.url)) === await realpath(process.argv[1]); } catch { /* Imported modules do not run the CLI. */ }
}
if (entrypoint) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  process.exitCode = await run(process.argv.slice(2), { signal: controller.signal });
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
