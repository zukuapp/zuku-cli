# 통합 CLI 앞문과 Agent Core

`zuku`와 `zukujs`는 같은 `index.mjs`를 실행하는 같은 CLI입니다. 두 이름은 같은 Agent Core, 같은 제공자 설정(`~/.config/zukujs/providers`), 같은 인증 저장소, 같은 세션 기록을 씁니다. 호출 이름은 어디에서도 읽지 않습니다.

CLI 명령은 Agent Core의 얇은 앞문입니다. 에이전트 루프, 세션 저장소, 제공자 설정, 자격 증명 저장소는 Agent Core와 그 안의 기존 ProviderRuntime만 가집니다. 연결 코드는 `lib/cli-core-runtime.mjs` 한 곳에 있고, 전송·투영만 합니다.

## 연결

- 기본 실행은 사용자별 Agent Core에 네이티브 actor로 붙습니다. Core가 없으면 `createCoreClient`가 자동으로 시작합니다(`~/.config/zukujs/core`, 0700, 보호된 로컬 IPC).
- 명령이 끝나거나 실패하면 연결만 끊습니다. 연결을 끊어도 Core 세션은 취소되지 않습니다.
- Ctrl-C는 진행 중인 요청에 `session.cancel`을 명시적으로 보낸 뒤 종료 이벤트까지 따라갑니다. 15초 안에 종료 이벤트가 오지 않으면 Core의 최종 상태를 확인하지 않고 130으로 끝납니다. 이때 상태는 `session.get`이나 Studio에서 확인합니다.
- 한 Core 세션이 요청 128개로 가득 차면 CLI가 그 세션을 닫고 같은 프로젝트에 새 세션을 만듭니다.
- `run`·`studio`는 Ctrl-C가 정상 종료이며 종료 코드는 0입니다. Core 세션은 그대로 남습니다.

## 명령

| 명령 | Core 동작 |
| --- | --- |
| `agent [설명]` (기본, 맨 앞 산문·`--yolo` 등 agent 플래그도 같음) | 현재 폴더를 `project.grant`(네이티브 전용)로 등록하고 `session.create`/`session.input` 후 세션 저널을 끝까지 따라갑니다. ZUKU 게임 폴더는 `game.maintain`, 그 밖이거나 `--name`·`--resume`이 있으면 `game.init`입니다. |
| `init [설명] [--name]` | 항상 `game.init`(새 게임). |
| `chat [메시지]` | ZUKU 게임 폴더를 `game.maintain`으로 유지보수합니다. 메시지가 없으면 터미널에서 빈 줄이 나올 때까지 같은 세션으로 대화합니다. |
| `test` | Core의 선언된 테스트(`game.test`, OS 샌드박스). |
| `build` | 설치된 ZukuJS 프레임워크가 있으면 항상 프레임워크로 넘깁니다. 프레임워크가 없고 현재 폴더가 실제 ZUKU 게임으로 분류될 때만 Core `game.build`를 실행합니다. 그 밖은 기존처럼 `FRAMEWORK_UNAVAILABLE`입니다. |
| `run [--port n] [--once]` | Core `game.run` 스냅샷을 읽기 전용 미리보기로 127.0.0.1에서 제공합니다. `--once`는 미리보기 정보만 반환합니다. |
| `studio [--port n]` | 공식 로컬 브라우저 화면(`https://ai.zuzunza.com`)이 쓰는 Browser Adapter를 127.0.0.1:43127에서 시작합니다. 페어링·세션 이어받기·브라우저 인증 요청은 이 터미널에서만 승인합니다. |
| `doctor [--no-start]` | CLI·Core·활성 제공자/모델·인증 상태(메타데이터만)·프레임워크·작업 폴더 분류 보고. |
| `provider`, `model`, `auth` | 기존 명령 그대로이며, 실행 기반만 Core 디스패치로 바뀌었습니다. |

로컬 브라우저 화면은 공식 지원입니다. 원격 클라우드 실행은 정해지지 않았습니다.

`login zuku|codex`, `deploy`, `account`, `upload`는 원래 인증·API 경로를 그대로 씁니다. Core로 우회하지 않습니다.

### agent 옵션

- `--model <provider/model>`: 첫 `/`에서 나눕니다. `auto`는 `zuku/auto`이고, 제공자 없는 모델 ID는 현재 활성 제공자에 붙습니다. 실패해도 다른(유료) 제공자로 자동 전환하지 않습니다. 생략하면 Core가 활성 모델(기본 `zuku/auto`)을 씁니다.
- `--experimental`: Experimental·비공식 인증 방식(`(exp!)`, 예: Codex, 사용자 지정 엔드포인트)으로 실행하려면 반드시 명시해야 합니다. 없으면 `AUTH_EXPERIMENTAL_OPT_IN`입니다.
- `--yolo` / `--draft`: 세션 모드입니다. YOLO 계정 확인과 서버 한도(계정별 6시간 3회 프로덕션 게시)는 Core/오케스트레이터가 판정합니다.
- `--resume <run_id>`: 같은 폴더의 기록으로 Core `session.input`의 `resume`을 보냅니다.
- `--browser /절대/경로/chrome`: 네이티브 CLI가 먼저 등록된 게임 프로젝트에 실행 파일을 승인합니다. Core는 경로와 파일 신원·SHA-256을 보호된 저장소에 보관하고, 요청에는 프로젝트에 묶인 불투명 핸들만 전달합니다. Core 재시작 뒤에도 파일을 다시 확인하며, 실행 전에 파일이 바뀌면 `BROWSER_EXECUTABLE_CHANGED`로 실패합니다. 브라우저 화면이나 Studio 렌더러는 이 승인을 만들거나 사용할 수 없습니다.
- 새 게임과 `--resume`은 게임 계획에 따른 실제 샌드박스 플레이테스트를 수행합니다. 기존 게임 유지보수의 `--browser`는 로드·렌더링·입력 검사를 수행하며, 게임 전체 규칙 검증을 의미하지 않습니다. Chromium 샌드박스, 최소 환경 변수, 네트워크·CSP 제한은 그대로 적용됩니다.
- 범위 판정(게임 개발 목적만 허용)은 Core가 공급자 호출 전에 합니다. 거부 문구는 `This agent is restricted to ZUKU/ZUKUJS game-development tasks.`입니다.

## 제공자·모델·인증

- `provider add --type`은 정식 이름(`openai-chat`, `openai-responses`, `anthropic`)과 이전 이름(`anthropic-messages`)을 모두 받습니다. 카탈로그의 `normalizeApiType`으로 정규화합니다.
- `--option KEY=VALUE`는 정해진 어휘만 받습니다.

| 키 | 처리 |
| --- | --- |
| `region`, `profile` | Bedrock 설정을 Core에 저장하고 SDK 요청에 적용 |
| `project`(이전 이름 `projectId`), `location` | Vertex 프로젝트·위치 설정 |
| `resourceName`, `deployment`, `apiVersion`, `wire` | Azure OpenAI 설정; `wire`는 `chat` 또는 `responses` |
| `accountId`, `gatewayId` | Cloudflare AI Gateway 계정·게이트웨이 설정 |
| `catalog` | 사용자 지정 OpenAI 호환 제공자의 모델 검색; `openai` 또는 `none` |
| `maxOutputTokens`(이전 이름 `outputTokens`, `defaultMaxOutputTokens`) | 정수 출력 상한; ZUKU·Codex 이외 어댑터 |
| `allowLoopbackHttp` | 사용자 지정 제공자의 루프백 HTTP 허용 여부(불리언); 엔드포인트 검사도 적용 |
| `model` | `add`에서는 첫 모델, `configure`에서는 기본 모델 |

  각 옵션은 타입·길이·형식을 검사합니다. 알 수 없는 키, 중복 키, 잘못된 값은 `INVALID_INPUT`이고, 해당 어댑터가 지원하지 않는 옵션은 `PROVIDER_OPTION_UNSUPPORTED`입니다. 비밀처럼 보이는 CLI 옵션 값은 `AUTH_SECRET_ARGUMENT`이며 다시 출력하지 않습니다. 옵션 검증에 실패한 설정 요청은 저장하지 않습니다.
- `--header-env NAME=ENV`와 `--header-secret NAME`은 헤더 값 대신 참조만 저장합니다. `configure --remove-header NAME`은 참조를 제거하고 `--clear-api-key-env`는 환경 변수 참조를 해제합니다. 모델 검색 결과와 제공자 JSON은 검색 상태·가격·설정 메타데이터를 보존하며 비밀 값은 포함하지 않습니다.
- 모델 검색과 캐시는 기존 모델 레지스트리(Core 안)가 맡습니다.
- `auth login`은 Core `auth.request`를 보내고 `auth.list`를 비동기로 확인합니다(최대 16분). 키·토큰은 이 프로세스의 숨김 입력(`askSecret`)이나 `--api-key-stdin` 한 줄로 받습니다. `auth login --header NAME`은 대화형 숨김 입력으로 헤더 값을 받으며 여러 번 지정할 수 있고, `--verify`는 저장 전에 제공자 검증을 요청합니다. 헤더 입력과 `--api-key-stdin`을 함께 쓸 수 없습니다. 비밀 값은 Core의 네이티브 전용 보조 채널로만 전달되며 일반·브라우저 RPC, JSON 출력, 이벤트, 저널에는 들어가지 않습니다. 여러 비밀은 모두 입력·검증된 뒤 함께 저장하며 취소되면 저장하지 않습니다.
- ZUKU 로그인은 기기 코드 URL만 표시하며 `games:generate` 범위를 요청합니다. `--no-browser`가 없으면 공식 URL을 브라우저로 엽니다. Codex는 `--experimental`이 있어야 합니다. 사용자가 등록한 사용자 지정 엔드포인트는 메타데이터상 `(exp!)`입니다. 그 엔드포인트의 키 저장(`auth login`, `provider add`)은 사용자가 이 네이티브 명령으로 직접 등록한 것이므로 opt-in으로 봅니다.
- 사람용 출력의 `(exp!)` 표시(TTY에서 주황색)는 인증 방식 메타데이터에서만 나옵니다. `--json`에는 ANSI 코드가 없습니다.

## 라이브러리·테스트 연결점

- `provider`/`model`/`auth`에 `providerRuntime`, `providerContext`, `home`, `environment`를 명시하면 이전처럼 ProviderRuntime을 직접 씁니다.
- `agent`에 `provider`, `deploy`, `playtest`, `upload`를 명시하면 이전처럼 프로세스 안 오케스트레이터를 씁니다. `parseAgentArgs`, `runGameAgent`, `resumeGameAgent` 내보내기는 바뀌지 않았습니다.
- `run(args, { core: { stateDir, autostart: false } })` 또는 `{ coreClient }`로 격리된 Core에 붙일 수 있습니다(`tests/cli-unified-core.test.mjs`).

## Core 호환성과 남은 경계

0.3.1은 `zuku-agent/1` 프로토콜을 유지하며 `hello`의 `provider-config/2`, `provider-header-auth/1`, `browser-grant/1` 기능으로 확장 지원을 확인합니다. 제공자 옵션·헤더 참조·환경 변수 참조 해제는 같은 Core 설정 저장소에 보존되고 재시작 후 실제 어댑터 요청에 적용됩니다. 공개 결과는 설정·모델 가격·검색 상태와 제거 결과를 전달하고, 제공자 오류는 안전한 고정 오류 코드로 보고합니다.

이전 Core가 필요한 기능을 광고하지 않으면 고급 설정, 헤더 인증·검증, 브라우저 승인을 보내기 전에 `CORE_PROTOCOL_GAP`로 실패합니다. Core를 최신 소스로 다시 시작한 뒤 실행하세요. 브라우저 실행 파일은 네이티브 승인 경로에서만 전달되며 `session.input`의 원시 경로·인수·환경 변수는 허용하지 않습니다.

- 프로젝트 등록은 경로마다 처음 목적(`game.maintain`/`game.init`)이 고정됩니다. 한 번 유지보수용으로 등록한 폴더에서 `agent --name`(새 게임)을 실행하면 `PERMISSION_REQUIRED`입니다. 새 게임은 별도 폴더에서 만드세요.
- 이전 `agent`는 ZUKU 게임 폴더에서도 항상 새 게임을 만들었습니다. 지금은 Core 판정에 따라 그 폴더를 유지보수합니다. 새 게임은 `--name`이나 `init`으로 만듭니다.
- Windows·macOS 네이티브 GUI의 실제 실행 검증과 배포 자산 버전은 [플랫폼 검증 기록](verification.md)을 따릅니다. CLI 0.3.1이 기존 0.3.0 Studio 자산을 교체하거나 새 GUI 인증을 뜻하지 않습니다.
