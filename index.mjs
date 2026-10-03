#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { identity, cliVersion, meta, success } from './lib/identity.mjs';
import { CommandError } from './lib/errors.mjs';

const COMMANDS = Object.freeze([
  { name: 'system.help', alias: 'help', usage: 'zukujs help', description: '사용 가능한 명령 안내' },
  { name: 'system.version', alias: 'version', usage: 'zukujs version', description: 'ZukuJS·명령 규격·CLI 버전' },
  { name: 'app.status', alias: 'status', usage: 'zukujs status [--check-api]', description: 'CLI 연결과 인증 설정 진단' },
  { name: 'diagnostics', alias: 'diagnostics', usage: 'zukujs diagnostics [--check-api]', description: '읽기 전용 API 진단' },
  { name: 'create', alias: 'create', usage: 'zukujs create <name>', description: '실행 가능한 HTML5 게임 프로젝트 생성' },
  { name: 'validate', alias: 'validate', usage: 'zukujs validate <path>', description: '프로젝트·ZWF2·ZIP 구조와 안전성 검증' },
  { name: 'package', alias: 'package', usage: 'zukujs package <path> [options]', description: '검증된 프로젝트를 ZWF2 또는 ZIP으로 패키징' },
  { name: 'upload', alias: 'upload', usage: 'zukujs upload <path> [options]', description: '패키지 업로드·서버 응답 검증·게임 초안 생성' },
]);
const helpText = () => `ZukuJS v${identity.version} — CLI ${cliVersion}\n\nUsage: zukujs <command> [options]\n\n${COMMANDS.map(item => `  ${item.usage.padEnd(36)} ${item.description}`).join('\n')}\n\nOptions:\n  --help, -h       도움말\n  --version, -v    버전\n  --json           success/data/error/meta 응답\n  --check-api      공개 API GET 진단\n\npackage: --format zwf|zip, --output <file>, --force\nupload:  --title <title>, --game-id <id>, --description <text>,\n         --genre <slug>, --version <version>, --age-rating all|12|15|18,\n         --tag <tag>, --platform pc,mobile,tablet, --receipt-dir <dir>, --verify\n\n인증: ZUKUJS_ACCESS_TOKEN 또는 사용자 소유 0600 credentials.json.\n업로드는 초안으로 저장하며 영수증은 .zukujs/receipts에 보관합니다.\n`;

export async function run(args = [], { stdout = process.stdout, stderr = process.stderr, signal, cwd = process.cwd(), diagnostics: diagnosticOverride, upload: uploadOverride } = {}) {
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
      const execute = command === 'upload' && uploadOverride ? uploadOverride : (await import(`./commands/${command}.mjs`)).default;
      const context = { signal, cwd };
      if (command === 'upload') {
        context.core = (await import('./lib/upload-project.mjs')).projectPackager;
        context.validator = await import('./lib/vendor/zwf/format.mjs');
      }
      data = await execute(positional.slice(1), context);
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
