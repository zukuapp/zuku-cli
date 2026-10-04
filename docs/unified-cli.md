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
- 범위 판정(게임 개발 목적만 허용)은 Core가 공급자 호출 전에 합니다. 거부 문구는 `This agent is restricted to ZUKU/ZUKUJS game-development tasks.`입니다.

## 제공자·모델·인증

- `provider add --type`은 정식 이름(`openai-chat`, `openai-responses`, `anthropic`)과 이전 이름(`anthropic-messages`)을 모두 받습니다. 카탈로그의 `normalizeApiType`으로 정규화합니다.
- `--option KEY=VALUE`는 정해진 어휘만 받습니다.

| 키 | 처리 |
| --- | --- |
| `region`, `location` | 저장(Core 경유) |
| `project`, `catalog`, `accountId`, `gatewayId` | 런타임은 저장할 수 있지만 현재 Core 프로토콜로는 보낼 수 없습니다 → `CORE_PROTOCOL_GAP` |
| `model` | `add`에서는 첫 모델, `configure`에서는 기본 모델 |
| `resourceName`, `wire`, `apiVersion`, `profile`, `outputTokens`, `allowLoopbackHttp` | 어댑터 옵션이지만 설정 저장소가 보존하지 않습니다 → `PROVIDER_OPTION_UNSUPPORTED`(`allowLoopbackHttp`는 루프백 `--base-url`에서 자동으로 정해짐) |

  알 수 없는 키, 중복 키, URL·경로·공백이 들어간 값은 `INVALID_INPUT`입니다. 비밀처럼 보이는 값은 `AUTH_SECRET_ARGUMENT`이며 다시 출력하지 않습니다. 거부된 요청은 아무것도 쓰지 않습니다.
- 모델 검색과 캐시는 기존 모델 레지스트리(Core 안)가 맡습니다.
- `auth login`은 Core `auth.request`를 보내고 `auth.list`를 비동기로 확인합니다(최대 16분). 키·토큰은 이 프로세스의 숨김 입력(`askSecret`)이나 `--api-key-stdin` 한 줄로만 받습니다. 그 값은 Core의 네이티브 전용 보조 채널로만 전달되며 JSON 출력, 이벤트, 저널에는 들어가지 않습니다. 입력을 취소하면 저장 전에 작업이 취소됩니다.
- ZUKU 로그인은 기기 코드 URL만 표시하며 `games:generate` 범위를 요청합니다. `--no-browser`가 없으면 공식 URL을 브라우저로 엽니다. Codex는 `--experimental`이 있어야 합니다. 사용자가 등록한 사용자 지정 엔드포인트는 메타데이터상 `(exp!)`입니다. 그 엔드포인트의 키 저장(`auth login`, `provider add`)은 사용자가 이 네이티브 명령으로 직접 등록한 것이므로 opt-in으로 봅니다.
- 사람용 출력의 `(exp!)` 표시(TTY에서 주황색)는 인증 방식 메타데이터에서만 나옵니다. `--json`에는 ANSI 코드가 없습니다.

## 라이브러리·테스트 연결점

- `provider`/`model`/`auth`에 `providerRuntime`, `providerContext`, `home`, `environment`를 명시하면 이전처럼 ProviderRuntime을 직접 씁니다.
- `agent`에 `provider`, `deploy`, `playtest`, `upload`를 명시하면 이전처럼 프로세스 안 오케스트레이터를 씁니다. `parseAgentArgs`, `runGameAgent`, `resumeGameAgent` 내보내기는 바뀌지 않았습니다.
- `run(args, { core: { stateDir, autostart: false } })` 또는 `{ coreClient }`로 격리된 Core에 붙일 수 있습니다(`tests/cli-unified-core.test.mjs`).

## Core 호환성 공백 (root 결정 필요)

다음 항목은 현재 `zuku-agent/1` 스키마나 투영이 받지 않습니다. CLI는 몰래 우회하지 않고 명시적인 오류로 실패합니다.

1. `provider.configure` options 허용 키는 `region|projectId|location|deployment|apiVersion`입니다. 런타임이 저장하는 키는 `region|project|location|catalog|accountId|gatewayId`입니다. 그래서 Vertex `project`, Cloudflare `accountId`/`gatewayId`, 사용자 지정 `catalog`는 Core로 설정할 수 없습니다(`CORE_PROTOCOL_GAP`). 반대로 `apiVersion`은 런타임이 거부합니다.
2. `provider.add`/`configure`에는 `headers`(`--header-env`, `--header-secret`, `--remove-header`)와 `apiKeyEnv: null`(`--clear-api-key-env`) 전달 수단이 없습니다.
3. 네이티브 인증 작업은 API 키 한 개만 받고 `verify: false`로 고정되어 있습니다. 그래서 `auth login --header`와 `--verify`를 쓸 수 없습니다.
4. `session.input`에는 플레이테스트 Chromium 경로가 없어 `agent --browser`를 쓸 수 없습니다.
5. `projectPublicResult`가 `apiType`, `baseUrl`, `options`, `apiKeyEnv`, `missingConfiguration`, `envVar`, `headers`, `discovery`, `inputCost`/`outputCost`, `removed`/`activeReset`를 지웁니다. 그래서 Core 경유 `provider show/list`, `model list/info`, `provider remove`의 JSON은 이전 직접 실행보다 필드가 적습니다.
6. `safeError` 허용 목록에 `ZUKU_LOGIN_REQUIRED`, `PROVIDER_EXISTS`, `PROVIDER_CONFIG_INVALID`, `AUTH_SECRET_INVALID` 같은 제공자 코드가 없습니다. 그래서 이 오류들은 `CORE_OPERATION_FAILED`로 보입니다.
7. 프로젝트 등록은 경로마다 처음 목적(`game.maintain`/`game.init`)이 고정됩니다. 한 번 유지보수용으로 등록한 폴더에서 `agent --name`(새 게임)을 실행하면 `PERMISSION_REQUIRED`입니다.
8. 이전 `agent`는 ZUKU 게임 폴더에서도 항상 새 게임을 만들었습니다. 지금은 Core 판정에 따라 그 폴더를 유지보수합니다. 새 게임은 `--name`이나 `init`으로 만듭니다.
