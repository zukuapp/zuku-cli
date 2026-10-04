#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { identity, cliVersion, meta, success } from './lib/identity.mjs';
import { CommandError } from './lib/errors.mjs';

const COMMANDS = Object.freeze([
  { name: 'system.help', alias: 'help', usage: 'zukujs help', description: '사용 가능한 명령 안내' },
  { name: 'system.version', alias: 'version', usage: 'zukujs version', description: 'ZukuJS·명령 규격·CLI 버전' },
  { name: 'app.status', alias: 'status', usage: 'zukujs status [--check-api]', description: 'CLI 연결과 인증 설정 진단' },
  { name: 'diagnostics', alias: 'diagnostics', usage: 'zukujs diagnostics [--check-api]', description: '읽기 전용 API 진단' },
  { name: 'agent', alias: 'agent', usage: 'zukujs agent [게임 설명] [--yolo]', description: '필수 스킬로 게임 제작·검증·배포 (기본 동작)' },
  { name: 'init', alias: 'init', usage: 'zukujs init [게임 설명] [--name <name>]', description: 'Agent Core로 현재 폴더에 새 게임 생성' },
  { name: 'chat', alias: 'chat', usage: 'zukujs chat [메시지]', description: '현재 ZUKU 게임을 Agent Core 세션으로 유지보수' },
  { name: 'test', alias: 'test', usage: 'zukujs test', description: 'Agent Core 샌드박스에서 선언된 게임 테스트 실행' },
  { name: 'run', alias: 'run', usage: 'zukujs run [--port <n>] [--once]', description: 'Agent Core 스냅샷 미리보기를 로컬에서 실행' },
  { name: 'studio', alias: 'studio', usage: 'zukujs studio [--port <n>]', description: '공식 로컬 브라우저 화면용 어댑터 시작' },
  { name: 'doctor', alias: 'doctor', usage: 'zukujs doctor [--no-start]', description: 'CLI·Agent Core·제공자·프로젝트 상태 점검' },
  { name: 'provider', alias: 'provider', usage: 'zukujs provider [list|show|use|add|configure|remove|enable|disable]', description: 'AI 제공자 설정 (Agent Core 공유)' },
  { name: 'model', alias: 'model', usage: 'zukujs model [list|use|info|refresh|current]', description: '모델 검색·선택 (<provider>/<model>)' },
  { name: 'auth', alias: 'auth', usage: 'zukujs auth [list|login|logout] [--provider <id>]', description: '제공자 인증 상태·로그인 (비밀 값은 출력 안 함)' },
  { name: 'login', alias: 'login', usage: 'zukujs login zuku|codex [options]', description: 'ZUKU 계정 또는 Experimental·비공식 Codex 연결' },
  { name: 'deploy', alias: 'deploy', usage: 'zukujs deploy <path> --yolo', description: 'ZUKU OAuth로 즉시 배포 · 6시간 3회' },
  { name: 'account', alias: 'account', usage: 'zukujs account [--quota]', description: 'ZUKU OAuth 연결·서버 배포 한도 확인' },
  { name: 'completion', alias: 'completion', usage: 'zukujs completion bash|zsh|fish', description: '셸 자동완성 출력' },
  { name: 'create', alias: 'create', usage: 'zukujs create <name>', description: '실행 가능한 HTML5 게임 프로젝트 생성' },
  { name: 'validate', alias: 'validate', usage: 'zukujs validate <path>', description: '프로젝트·ZWF2·ZIP 구조와 안전성 검증' },
  { name: 'package', alias: 'package', usage: 'zukujs package <path> [options]', description: '검증된 프로젝트를 ZWF2 또는 ZIP으로 패키징' },
  { name: 'upload', alias: 'upload', usage: 'zukujs upload <path> [options]', description: '패키지 업로드·서버 응답 검증·게임 초안 생성' },
  ...['dev', 'build', 'start', 'info', 'analyze', 'typegen', 'telemetry', 'upgrade'].map(alias => ({ name: `framework.${alias}`, alias, usage: `zukujs ${alias} [options]`, description: alias === 'build' ? '설치된 ZukuJS 웹 프레임워크 명령 (없으면 ZUKU 게임을 Agent Core로 빌드)' : '설치된 ZukuJS 웹 프레임워크 명령', required_package: 'zukujs' })),
]);
// Agent flags may lead a bare invocation (`zuku --yolo "…"`); prose is never a command name.
const AGENT_LEADING_FLAGS = Object.freeze(['--yolo', '--draft', '--name', '--model', '--resume', '--browser', '--experimental']);
const isAgentLead = value => typeof value === 'string' && (AGENT_LEADING_FLAGS.includes(value.split('=')[0]) || !value.startsWith('-') && /\s|[^\x00-\x7f]/.test(value));
const LONG_RUNNING = Object.freeze(['run', 'studio']);
function renderKey(command, sub = 'list') {
  if (command === 'provider') return sub === 'list' ? 'provider.list' : ['show', 'add', 'configure'].includes(sub) ? 'provider.show' : 'provider.result';
  if (command === 'model') return ['list', 'refresh'].includes(sub) ? 'model.list' : sub === 'info' ? 'model.info' : 'model.result';
  return sub === 'list' ? 'auth.list' : 'auth.result';
}
const helpText = () => `ZukuJS v${identity.version} — CLI ${cliVersion}\n\nUsage: zukujs [command] [options]\n기본 동작은 로컬 게임 개발 에이전트입니다.\n\n${COMMANDS.map(item => `  ${item.usage.padEnd(36)} ${item.description}`).join('\n')}\n\nOptions:\n  --help, -h       도움말\n  --version, -v    버전\n  --json           success/data/error/meta 응답\n  --check-api      공개 API GET 진단\n\nagent:   --name <name>, --model <provider/model>, --yolo | --draft, --experimental,\n         --resume <run_id>, --browser <path>\nprovider: add --id <id> --type openai-chat|openai-responses|anthropic --base-url <url>,\n         configure <id> [--option KEY=VALUE] [--model <id>] [--api-key-env <VAR>]\nmodel:   use <provider/model> (기본 zuku/auto, 자동 유료 전환 없음)\nauth:    login --provider <id> [--api-key-stdin | --api-key-env <VAR>] [--experimental]\nlogin:   zuku [--no-browser] | codex --experimental\npackage: --format zwf|zip, --output <file>, --force\nupload:  --title <title>, --game-id <id>, --description <text>,\n         --genre <slug>, --version <version>, --age-rating all|12|15|18,\n         --tag <tag>, --platform pc,mobile,tablet, --receipt-dir <dir>, --verify\n\nZUKU 계정: zukujs login zuku. Codex 연결: zukujs login codex --experimental.\nCodex 연결은 Experimental·비공식이며 (exp!)로 표시합니다.\nzuku와 zukujs는 같은 CLI·Agent Core·제공자·인증 상태를 씁니다.\n공식 로컬 브라우저 화면(https://ai.zuzunza.com)은 zukujs studio로 이 컴퓨터의 Agent Core에 연결합니다.\n원격 클라우드 실행은 정해지지 않았습니다.\nYOLO는 추가 확인 없이 프로덕션 배포하며 계정별 최근 6시간 성공 3회로 제한됩니다.\nupload는 초안으로 저장하며 영수증은 .zukujs/receipts에 보관합니다.\n`;

/**
 * Single front door for both `zuku` and `zukujs`. `core`/`coreClient` select the Agent Core
 * connection (createCoreClient context or an attached client); production autostarts the
 * per-user Core.
 */
export async function run(args = [], { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, signal, cwd = process.cwd(), diagnostics: diagnosticOverride, upload: uploadOverride, agent: agentOverride, loginZuku: loginZukuOverride, loginCodex: loginCodexOverride, deploy: deployOverride, account: accountOverride, core, coreClient } = {}) {
  const json = args.includes('--json');
  const positional = args.filter(arg => arg !== '--json');
  const requested = positional[0];
  const aliases = { '--help': 'help', '-h': 'help', '--version': 'version', '-v': 'version', 'system.help': 'help', 'system.version': 'version', 'app.status': 'status' };
  let command = aliases[requested] ?? requested ?? 'agent';
  const coreContext = { cwd, signal, stdin, stderr, ...(core ? { core } : {}), ...(coreClient ? { coreClient } : {}) };
  try {
    if (signal?.aborted) throw new CommandError('COMMAND_CANCELLED');
    const { FRAMEWORK_COMMANDS, runFramework, frameworkEntry } = await import('./lib/framework-command.mjs');
    if (FRAMEWORK_COMMANDS.includes(requested)) {
      // An installed framework always wins; only an actual ZUKU game falls back to Core's build.
      if (requested !== 'build') return await runFramework(args, { cwd, stdout, stderr, signal });
      let installed = true;
      try { await frameworkEntry(cwd); } catch (error) {
        if (error?.code !== 'FRAMEWORK_UNAVAILABLE') throw error;
        const { isZukuGame } = await import('./lib/cli-core-runtime.mjs');
        if (!await isZukuGame(cwd, { signal })) throw error;
        installed = false;
      }
      if (installed) return await runFramework(args, { cwd, stdout, stderr, signal });
    }
    const commandHelp = COMMANDS.some(item => item.alias === command) && positional.slice(1).some(arg => arg === '--help' || arg === '-h');
    if (commandHelp) command = 'help';
    let data;
    if (command === 'agent' || isAgentLead(requested)) {
      command = 'agent';
      const execute = agentOverride ?? (await import('./commands/agent.mjs')).default;
      data = await execute(requested === 'agent' ? positional.slice(1) : positional, { cwd, signal, stdin, stdout, stderr, ...(core ? { core } : {}), ...(coreClient ? { coreClient } : {}) });
    } else if (command === 'build') {
      const { runProjectOperation } = await import('./commands/test.mjs');
      data = await runProjectOperation('game.build', positional.slice(1), coreContext);
    } else if (['init', 'chat', 'test', 'run', 'studio', 'doctor'].includes(command)) {
      const execute = (await import(`./commands/${command}.mjs`)).default;
      data = await execute(positional.slice(1), coreContext);
    } else if (['provider', 'model', 'auth'].includes(command)) {
      const execute = (await import(`./commands/${command}.mjs`)).default;
      data = await execute(positional.slice(1), coreContext);
      if (!json && !signal?.aborted) {
        const { renderProviderOutput, colorEnabled } = await import('./lib/provider-system/render.mjs');
        // Human view only: (exp!) comes from auth-method metadata; JSON never carries ANSI.
        stdout.write(renderProviderOutput(renderKey(command, positional[1]), data, { color: colorEnabled({ stream: stdout, environment: process.env }) }));
        return 0;
      }
    } else if (command === 'login') {
      const provider = positional[1] ?? 'zuku';
      if (!['zuku', 'codex'].includes(provider)) throw new CommandError('INVALID_INPUT');
      const execute = (provider === 'zuku' ? loginZukuOverride : loginCodexOverride) ?? (await import(`./commands/login-${provider}.mjs`)).default;
      data = await execute(positional.slice(2), { cwd, signal, stderr, onDeviceCode: code => stderr.write(`ZUKU 계정 연결: ${code.verification_uri_complete ?? code.verification_uri}\n승인 코드: ${code.user_code}\n`) });
    } else if (command === 'deploy' || command === 'account') {
      const execute = (command === 'deploy' ? deployOverride : accountOverride) ?? (await import(`./commands/${command}.mjs`)).default;
      data = await execute(positional.slice(1), { cwd, signal, stderr });
    } else if (command === 'completion') {
      const { completion } = await import('./lib/completion.mjs');
      data = completion(positional.slice(1), COMMANDS.map(item => item.alias));
      if (!json) { stdout.write(data.script); return 0; }
    } else if (command === 'help') {
      if (positional.length > 1 && !commandHelp) throw new CommandError('INVALID_INPUT');
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
    const published = ['agent', 'init', 'chat', 'deploy'].includes(command) && data?.published === true;
    // Ctrl-C is the normal end of a foreground preview/adapter; it never cancels Core sessions.
    if (signal?.aborted && !published && !LONG_RUNNING.includes(command)) throw new CommandError('COMMAND_CANCELLED');
    stdout.write(json ? JSON.stringify(success(data)) + '\n' : JSON.stringify(data, null, 2) + '\n');
    return 0;
  } catch (error) {
    const safe = error instanceof CommandError ? error : new CommandError('COMMAND_FAILED');
    const result = { success: false, error: safe.toJSON(), meta: meta() };
    stderr.write(json ? JSON.stringify(result) + '\n' : `${safe.code}: ${safe.message}\n`);
    return ['COMMAND_CANCELLED', 'CODEX_AUTH_CANCELLED'].includes(safe.code) ? 130 : ['INVALID_INPUT', 'UNKNOWN_COMMAND'].includes(safe.code) ? 2 : 1;
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
  // A short CLI invocation owns no background work once run() returns. Close its
  // private Windows peer explicitly rather than waiting for the idle deadline.
  if (process.platform === 'win32') (await import('./lib/accounts/windows-protected-store.mjs')).closeProtectedStorePeer();
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
