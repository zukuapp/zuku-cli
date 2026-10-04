# 게임 범위 제한과 에이전트 도구

`zuku`와 `zukujs`는 같은 CLI이고, CLI·ZUKU Studio·Browser Adapter는 모두 하나의 ZUKU Agent Core를 사용합니다. 이 문서는 Agent Core가 쓰는 게임 범위 제한 서비스(`lib/agent/scope/`)를 설명합니다. 이 서비스는 기존 ZUKU/ZUKUJS 게임·SDK·도구 프로젝트를 유지보수하는 도구 루프입니다. 새 게임을 만드는 기존 파이프라인(필수 스킬 5개, 실제 브라우저 플레이테스트)은 바뀌지 않습니다.

범위 제한은 시스템 프롬프트에만 의존하지 않고 다음 계층을 차례로 적용합니다.

```text
요청 ─▶ classifyWorkspace ─▶ admitGameRequest ─▶ (YOLO 사전 확인) ─▶ 스킬 해시 확인 ─▶ 공급자
                                                                                     │
      host 검증 ◀─ 관찰 ◀─ 실행 ◀─ 경로·명령 검증 ◀─ 도구 입력 검증 ◀─ 모델 JSON 행동 ◀┘
```

모델은 권한을 갖지 않습니다(`MODEL != AUTHORITY`). 도구 런타임에는 공급자 정보가 전혀 입력되지 않으므로, 공급자를 바꿔도 허용되는 작업은 같습니다. 테스트로 공식·실험 공급자에서 같은 정책 결과가 나오는지 확인합니다.

## 공개 API

`lib/agent/scope/index.mjs`

| 함수 | 설명 |
| --- | --- |
| `classifyWorkspace({ cwd, request, signal })` | 작업 공간을 `zuku`, `zukujs`, `zuku-compatible`, `unknown`, `out-of-scope` 중 하나로 분류합니다. 결과는 동결된 host 객체입니다. `request`는 받지만 근거로 쓰지 않습니다. |
| `admitGameRequest(request, classification, { forceCreate })` | 요청의 목적을 판정합니다. 허용하면 `{ admitted: true, route: 'new-game' \| 'scoped', intent }`를 반환합니다. 거부하면 `AGENT_REQUEST_OUT_OF_SCOPE` 오류를 던집니다(Agent Core는 반환값을 쓰지 않으므로 거부는 반드시 예외입니다). |
| `createScopedToolRuntime(options)` | 고정된 도구 9종의 실행기입니다. `execute({ tool, input })`(모델 경로), `execute(name, input)`(Agent Core 직접 호출), `verify()`, `capabilities`, `journal`, `receipts`, `close()`를 제공합니다. |
| `runScopedGameAgent(options, context)` | 정해진 한도 안에서 inspect → plan → 도구 → build/test → 오류 관찰 → repair → verify 루프를 실행합니다. |
| `verifyScopedResult(result, { skills })` | Agent Core의 `verifyResult` 연결점입니다. 이 모듈이 만든 결과만 받고, 현재 파일을 다시 해시해 증거를 반환합니다. |
| `SCOPE_STAGES`, `STAGE_DEFINITIONS`, `admitStageSchema`, `toWireSchema` | 공급자에 보내는 스테이지 스키마와 크기 한도, 스키마 승인 |

거부 메시지는 항상 다음 문장입니다.

```text
This agent is restricted to ZUKU/ZUKUJS game-development tasks.
```

`error.details.hint`가 있으면 같은 기능을 ZUKU 게임 안에서 구현하는 방법을 고정된 문장으로 안내합니다. 범위 제한을 우회하는 명령·플래그는 없습니다.

오류의 `code`는 항상 Agent Protocol `safeError`가 아는 코드입니다. 세부 원인은 `error.scopeCode`에 남습니다.

| scopeCode | code |
| --- | --- |
| `SCOPE_REJECTED` | `AGENT_REQUEST_OUT_OF_SCOPE` |
| `SCOPE_PATH_DENIED` | `PERMISSION_REQUIRED` |
| `SCOPE_CONFLICT` | `REQUEST_CONFLICT` |
| `SCOPE_LIMIT` | `REQUEST_LIMIT` |
| `SCOPE_LOCKED` | `SESSION_BUSY` |
| `SCOPE_VERIFY_FAILED`, `SCOPE_PROVIDER_INVALID` | `AGENT_GATE_FAILED` |
| `SCOPE_SOURCE_CHANGED` | `AGENT_SOURCE_CHANGED` |
| `SCOPE_PUBLISH_BLOCKED` | `AGENT_PLAYTEST_UNAVAILABLE` |
| `SCOPE_PUBLISH_UNKNOWN` | `AGENT_PUBLISH_OUTCOME_UNKNOWN` |
| `SANDBOX_UNAVAILABLE`, `SCOPE_TOOL_DENIED`, `DOCS_UNAVAILABLE` | `TOOL_UNAVAILABLE` |
| `SCOPE_PROVIDER_UNAVAILABLE` | `AGENT_PROVIDER_UNAVAILABLE` |
| `SCOPE_WORKSPACE_UNSAFE` | `PROJECT_CHANGED` |
| `SCOPE_SKILLS_INVALID`, `SCOPE_STATE_UNSAFE` | `CORE_STATE_UNSAFE` |

## 1. 작업 공간 분류

lstat으로 디렉터리를 순회합니다. 한도는 깊이 6, 항목 5000개, 읽기 300개 파일, 파일당 64 KiB입니다. 작업 공간은 링크가 아닌 현재 사용자 소유 디렉터리여야 합니다. 링크가 아닌 단일 링크 일반 파일만 읽습니다. 점(.)으로 시작하는 항목과 `node_modules`·`dist`·`build`는 근거로 쓰지 않습니다. 예외로 루트의 `.zukujs/`는 존재만 약한 신호로 봅니다.

| 신호 | 가중치 | 근거 |
| --- | --- | --- |
| `MANIFEST_VALID` | 3 | `zukujs.json`이 `zukujs-project/1` 검증 통과 |
| `DEP_ZUKUJS` / `DEP_ZUKU` | 3 | `package.json` 의존성 `zukujs`, `@zukujs/*`, `zuku`, `@zuku/*` |
| `IMPORT_ZUKUJS` / `IMPORT_ZUKU` | 3 | 소스의 `import`/`require` 대상 |
| `SOURCE_ENTRY` | 2 | 매니페스트의 `source/entry` 파일이 실제로 존재 |
| `BIN_ZUKU` | 2 | `package.json` `bin`에 `zuku`/`zukujs` |
| `PACKAGE_NAME_ZUKU`, `KEYWORD_ZUKU`, `ZWF_ARTIFACT`, `AGENT_STATE`, `MANIFEST_INVALID` | 1 | 약한 신호 |
| `GAME_ENGINE_DEP` | 3 | phaser, pixi.js, three 등 게임 엔진 의존성 |
| `GAME_RENDER_LOOP` | 2 | 같은 파일에 `getContext(2d/webgl/webgpu)`와 `requestAnimationFrame` |
| `SHADER_SOURCE`, `WASM_MODULE`, `GAME_ASSETS` | 1 | 셰이더, WASM, 이미지와 오디오 에셋 |
| `GENERIC_DEP`, `GENERIC_PYTHON` | 2 | express, stripe, prisma, discord.js, puppeteer, django 등 |

판정 규칙은 다음과 같습니다.

- `zukujs` / `zuku`: 생태계 점수 4 이상, 신호 종류 2개 이상이고 해당하는 강한 신호(매니페스트·의존성·import)가 있어야 합니다.
- `zuku-compatible`: 위 생태계 조건을 만족하거나, 게임 점수 4 이상(종류 2개 이상), 또는 생태계 점수 2 이상이면서 게임 점수 2 이상입니다.
- `out-of-scope`: 범용 점수 2 이상, 생태계 점수 1 이하, 게임 점수 2 미만입니다.
- 나머지는 `unknown`이고, 표시되는 항목이 없으면 `empty: true`입니다.

파일 이름 하나, 디렉터리 이름, 요청 문구, 모델의 주장은 근거가 될 수 없습니다. host가 발급한 분류 객체만 받으므로, 위조하거나 복사한 객체는 거부됩니다.

## 2. 목적 판정

목적 판정은 공급자·모델·토큰·네트워크를 쓰기 전에 실행합니다. Agent Core는 `session.input`과 `project.grant`에서 공급자를 확인하기 전에 이 판정을 호출합니다.

- **거부하는 주 목적**: 전자상거래, 회계·급여·ERP·CRM, SaaS, 메신저 봇, 스크래퍼·크롤러, 블로그·홈페이지, 트레이딩 봇, 서버 관리(Linux·VPS·nginx·Docker 관리), 범용 코딩 에이전트 대체, 제한 해제·셸 접근 요구. 요청에 "game"이 들어가도 결과는 같습니다("게임 쇼핑몰", "game-themed accounting SaaS").
- **범용 백엔드·서버·API**: 리더보드, 멀티플레이, 매치메이킹, 세이브, ZUKU API/SDK 같은 구체적인 게임 도메인 용어가 함께 있을 때만 허용합니다.
- **기존 생태계 프로젝트**: 게임·생태계 목적이나 유지보수 동사(fix, build, test, optimize, 수정, 추가…)가 있으면 `scoped`로 보냅니다. TS, GLSL, WASM, 네이티브 글루, 빌드 설정도 목적이 맞으면 허용합니다. `--name`(forceCreate)이 있으면 `new-game`으로 보냅니다.
- **`unknown` + 빈 디렉터리**: 생성·초기화·이전 요청과 빈 요청을 `new-game`으로 보냅니다.
- **`unknown` + 비어 있지 않은 디렉터리**: ZUKU로 이전하는 요청만 `scoped`(intent `migrate`)로 보내고, 게임 생성은 `new-game`으로 보냅니다. 그 밖은 거부합니다.
- **`out-of-scope`**: 명시적인 새 게임 생성만 허용합니다.

## 3. 도구 capability

도구는 다음 9가지 고정 enum입니다. 공급자의 네이티브 도구 목록이 이 enum을 늘릴 수 없습니다. 모든 입력은 닫힌 스키마로 검증하며, 알 수 없는 필드·제어 문자·길이 초과가 있으면 실행하지 않고 `invalid_arguments` 관찰로 돌려줍니다.

| 도구 | 프로토콜 capability | 실행 위치 | 제한 |
| --- | --- | --- | --- |
| `read_file` | `project.read` | host | 64 KiB 텍스트 창. 반환된 `sha256`이 수정의 전제 조건 |
| `write_file` | `project.write` | host | 새 파일은 `expected_sha256: null`, 기존 파일은 현재 SHA 일치 필수. 256 KiB |
| `patch_file` | `project.patch` | host | 정확·유일 일치 치환만, 최대 20개 |
| `search_project` | `project.search` | host | 리터럴 검색, 2000파일·100결과, 비밀 의심 파일 제외 |
| `inspect_asset` | `asset.inspect` | host | 형식·크기·SHA·이미지 크기 |
| `run_zuku` | `zuku.build` / `game.preview` | host | `validate`/`package`는 내장 검사기(프로젝트 코드 실행 없음). `playtest`는 root가 주입한 실제 샌드박스 브라우저만 |
| `run_tests` / `run_build` | `zuku.test` / `zuku.build` | OS 샌드박스 | host가 선언한 `script_id`만 |
| `query_zuku_docs` | `docs.search` | host | 패키지에 포함된 문서와 root가 주입한 고정 HTTPS 문서 |

명령 문자열, 셸, npm 스크립트 이름, 임의 플래그는 받지 않습니다.

Agent Core의 직접 호출은 다음처럼 처리합니다.

- `project.read` → `read_file`
- `project.search` → `search_project`(`{ matches, truncated }`)
- `project.patch` → `{ path, content, expectedSha256 }` 전체 교체(현재 SHA 필수)
- `game.build` / `game.test` → 선언된 첫 형식

정책 위반은 프로토콜 코드로 던집니다.

### 경로 정책

- 상대 경로만 받습니다. `..`, 절대 경로, `\`, `:`, 제어 문자는 거부하고, 깊이는 16단계까지입니다.
- 프로젝트 루트의 dev/ino를 고정하고 매 호출마다 다시 확인합니다(루트 바꿔치기 방지).
- 모든 상위 경로는 링크가 아닌 디렉터리여야 하고, 대상은 단일 링크 일반 파일이어야 합니다. 파일은 O_NOFOLLOW로 열고, 열린 inode가 확인한 inode와 같아야 합니다. 심볼릭 링크와 하드 링크는 읽기·쓰기 모두 거부합니다.
- **비공개 경로**는 모델이 읽거나 쓸 수 없고 검색·샌드박스 스냅샷·모델 입력에도 넣지 않습니다. 점(.)으로 시작하는 모든 경로(`.git`, `.env*`, `.zukujs`, `.ssh`, `.npmrc`, `.codex` 등), `node_modules`, 키·인증서, `credentials*`, `secrets*`, `auth.json`, `providers.json`, `provider-keys*`, `service-account*.json`이 해당합니다.
- 개인 키나 토큰처럼 보이는 내용이 든 파일은 읽기·검색·자산 검사·교체를 모두 거부하고, 그런 내용을 쓰는 것도 거부합니다. 관찰과 이벤트 텍스트는 모두 마스킹합니다.
- **쓰기 허용**: 신뢰된 소스 디렉터리(매니페스트 `source`, `src`, `assets`, `shaders`, `tests`, `scripts`, `native`, `wasm`, `types`, `lib`, `packages`, `examples`) 아래의 게임 관련 확장자, 그리고 루트 빌드 설정(`zukujs.json`, `package.json`, `tsconfig*.json`, vite·rollup·esbuild·webpack 설정, `Cargo.toml`, README).
- **쓰기 금지**: lock 파일, `dist`/`build`/`out`/`coverage`, `Makefile`, 셸 스크립트.
- `zukujs.json`은 스키마를 통과해야 저장합니다. `package.json`의 `scripts`, `bin`, `main`, `exports`, `imports`, `type`, `workspaces`, `config`는 host가 신뢰하는 정의이므로 모델이 바꿀 수 없습니다.

### 쓰기와 되돌리기

같은 디렉터리에 O_EXCL 임시 파일을 만들고 fsync합니다. 기존 파일은 SHA를 다시 확인한 뒤 `rename`으로 교체하고, 새 파일은 `link`로 만들어 덮어쓰지 않습니다.

원본 보관은 수정보다 먼저 일어납니다. `ChangeJournal.write/patch`는 host 전용 `{ beforeWrite }` 훅을 받습니다. 이 훅은 모델 도구 입력의 일부가 아니며 runtime이 내부에서만 넘깁니다. 실행에서 경로를 처음 바꿀 때 훅은 `expected_sha256`과 일치한, inode를 확인한 원본 바이트를 받습니다. runtime은 이 바이트를 실행 store(`state.mjs createRunStore().backup`, 검증된 run 디렉터리에 0600 원자적 쓰기)를 통해 `.zukujs/agent/runs/<run>/backup-NNN.bin`에 저장하고 SHA-256을 확인합니다. 이 과정은 프로젝트에 임시 파일을 만들기 전에 끝납니다. 보관이 실패하면 프로젝트에는 아무것도 쓰지 않습니다(`SCOPE_STATE_UNSAFE`, 보관 개수 한도는 `SCOPE_LIMIT` 관찰). 마지막 `rename` 직전에는 파일이 여전히 보관한 바이트와 같은지 다시 확인합니다. 따라서 수정 후 영수증 기록이 실패하거나 프로세스가 중단되어도 원본 해시와 같은 backup은 run 디렉터리에 남아 있습니다. 새로 만든 파일은 원본이 없으므로 backup을 만들지 않습니다. 같은 경로를 다시 고쳐도 첫 원본만 보관합니다.

알려진 한계: `lib/agent/state.mjs writeAtomic`은 임시 파일과 디렉터리를 fsync하지 않습니다. 이 모듈의 소유자가 아니므로 이 서비스는 수정하지 않았습니다. 따라서 OS 크래시가 나면 backup이 page cache에만 있었을 수 있습니다. 순서(보관 완료 → 수정)는 보장하지만 전원 손실 내구성은 root가 `writeAtomic`에 fsync를 추가해야 완성됩니다.

실패나 취소 시에는 현재 바이트가 이 실행이 쓴 바이트와 같은 파일만 되돌립니다. 다른 쪽이 바꾼 파일은 건드리지 않고 `rollback.conflicts`에 남깁니다. 검토용 diff는 항상 보존합니다.

## 4. OS 샌드박스 (run_tests / run_build)

프로젝트 테스트와 빌드는 프로젝트 코드를 실행하므로 **Linux bubblewrap(`/usr/bin/bwrap`) 안에서만** 실행합니다. 샌드박스 없이 실행하는 대체 경로는 없습니다.

- **사용 가능 판정**: Linux여야 하고, bwrap은 root 또는 현재 사용자 소유이며 group/other 쓰기 권한이 없어야 합니다. 실제 bwrap으로 Node를 실행해 네트워크가 차단되는지 확인하는 probe도 통과해야 합니다. 조건이 맞지 않으면 `run_tests`/`run_build`를 `available: false`로 선언하고 실행을 거부합니다. Windows와 macOS는 검증된 격리 방법이 생길 때까지 사용할 수 없습니다. 내장 `validate`/`package`와 root의 브라우저 플레이테스트는 이와 별개로 동작합니다.
- **격리**:
  - 네임스페이스·세션: `--unshare-all`(네트워크 포함), `--die-with-parent`, `--new-session`
  - 권한·환경: `--clearenv`, `--cap-drop ALL`. 환경 변수는 PATH/HOME/TMPDIR/CI/NO_COLOR/LANG만 설정
  - 파일 시스템: `/usr`·`/lib*`·Node 설치 경로는 읽기 전용, `/tmp`과 HOME은 tmpfs
- **프로젝트**: 비공개가 아닌 단일 링크 일반 파일만 일회용 스냅샷(`/work`)에 복사합니다(최대 5000파일, 64 MiB). `node_modules`는 링크가 아닌 디렉터리일 때만 읽기 전용으로 바인드합니다. 샌드박스 안에서 쓴 내용은 원본에 반영되지 않습니다.
- **한도**: 120초가 지나면 프로세스 그룹에 SIGKILL을 보냅니다. 출력은 스트림당 64 KiB만 보관하고, 합계 8 MiB를 넘으면 종료합니다. `/usr/bin/prlimit`이 있으면 nproc·nofile·fsize·core 한도를 겁니다. abort signal이 오면 즉시 종료합니다.
- **명령 형식**:
  - `node-test`: `tests/`·`test/`의 `*.test.{mjs,cjs,js}`를 `node --test`로 실행합니다.
  - `tsc-check`: 로컬 `node_modules/typescript`와 `tsconfig.json`이 있을 때 사용할 수 있습니다.
  - root 선언 `{ id, kind, file, args }`: 프로그램은 항상 신뢰된 Node 바이너리입니다. `--eval`, `--import`, `--require`, `--loader`, `--env-file`, `--inspect`, `-e`, `-r` 등의 인수와 비공개 파일은 거부합니다.
- `passed`는 host가 관찰한 값입니다. 종료 코드 0이고 시간 초과·시그널·출력 초과가 없어야 참입니다. 출력은 줄 단위로 마스킹해 `build.output`으로 실시간 전송합니다.

## 5. 스테이지 계약

| 스테이지 | 스키마 | `maxOutputBytes` |
| --- | --- | --- |
| `scope.plan` | 요약·목적·아키텍처·검증 계획(참고용)·단계 | 98,304 |
| `scope.act` | `{ actions: [{ tool, input_json }], done }`(행동 최대 4개) | 1,600,000 |

- `outputSchema`는 표준 JSON Schema입니다. 모든 객체가 닫혀 있고 모든 속성이 `required`입니다. `pattern`, `$ref`, `oneOf`, `anyOf`, `format`을 쓰지 않으므로 공유 공급자 승인(`lib/provider-system/stage-schema.mjs`, 게임 패턴 허용 목록)을 그대로 통과합니다. 모듈을 불러올 때 이를 검사하며, 테스트는 공유 승인 함수로도 확인합니다.
- 도구 입력은 문자열 `input_json`으로 전달하므로 열린 객체 없이 모든 공급자의 strict 모드에서 같은 스키마를 씁니다. host가 디코드하고 도구별 스키마로 다시 검증합니다.
- 공급자는 Agent Core가 `resolveStageProvider`로 묶은 stage client입니다. 이 서비스는 주소를 파싱하거나 공급자를 바꾸지 않으며, 공급자를 자동으로 가져오지도 않습니다(Codex 등 암묵적 대체 없음).
- 스키마 위반 출력은 한 번만 다시 요청합니다. 전송·공급자 실패는 재시도하지 않고, 다른 공급자로 넘어가지도 않습니다.
- 실험·비공식 표시는 client의 신뢰된 `authMethod { official, experimental }`가 정하며(`provider.source: 'auth-method'`), 어댑터나 모델이 반환한 `experimental`/`unofficial` 필드로는 바꿀 수 없습니다.
- 모델 원시 출력과 비공개 추론은 이벤트·영수증·상태 파일에 넣지 않습니다. 영수증에는 SHA-256만 기록합니다.

## 6. 이벤트

`context.onEvent`는 Agent Core `publicEvent`가 받는 형식만 보냅니다. Agent Core가 프로토콜 스키마로 다시 검증하고 텍스트를 정리합니다.

- `{ type: 'stage', stage, status }`: 단계 진행. `architecture`→analyzing, `implementation`→editing, `package`→building, `playtest`→testing, `validate`→verifying, status `repair`→repairing.
- `tool.requested|started|completed|failed`: `{ callId, capability, status, path?, beforeSha256?, afterSha256?, code? }`
- `build.started|output|completed`: `{ buildId, scriptId }`, `{ buildId, stream, text }`, `{ buildId, exitCode, status, sourceSha256? }`
- `game.started|stopped`: `{ gameHandle, state, code? }`

이벤트에는 절대 경로, 모델 텍스트, 비공개 추론, 비밀이 들어가지 않습니다.

전달 규칙(`events.mjs createEventSink`):

- `tool.*`, `build.*`, `game.*`는 host 정책 전이입니다. Agent Core는 이를 fsync한 세션 저널에 추가합니다. `emit`은 비동기 함수이며 host 콜백이 끝날 때까지 기다립니다. 콜백이 예외를 던지거나 reject하면 `SCOPE_STATE_UNSAFE`(`CORE_STATE_UNSAFE`)로 실패하고, runtime은 그 실패를 삼키지 않습니다.
  - `tool.requested`: 닫힌 스키마 승인 뒤, 어떤 handler보다 먼저 기다립니다.
  - `tool.started`: 파일 수정이나 명령 실행 전에 기다립니다. 둘 중 하나가 거부되면 수정 0건, 명령 0건입니다.
  - `tool.completed|failed`: 영수증 기록 뒤에 기다립니다.
  - `build.started`: 샌드박스 프로세스 시작 전에 기다립니다.
  - `build.completed`: 관찰한 종료 뒤에 기다립니다. 출력 전달이 실패해도 종료 사실은 기록을 시도합니다.
  - `game.started|stopped`도 같은 방식으로 기다립니다.
- 이벤트 한도(`EVENT_LIMIT`)를 넘으면 `build.output`만 버립니다. 전이 이벤트는 버리지 않습니다(도구 호출 한도로 수가 제한됩니다).
- `stage`는 기존 단계 진행 표시입니다. 루프가 기다리지 않으므로 이쪽 전달은 best effort입니다. 그래도 Agent Core 자체 sink가 거부를 기록하고 실행을 중단합니다. stderr 진행 줄도 별도의 best effort 표시입니다. 비대화형 실행에서는 stderr에 진행 상황을 쓰지 않습니다(`quiet` 기본값 true).
- 샌드박스 출력(`sandbox.mjs`)은 줄 단위로 순서대로 하나씩 기다려 전달합니다.
  - 상한: 줄당 `lineChars`, 스트림당 `outputBytes`, 실행당 `outputLines`(4000줄).
  - 대기 줄이 `outputQueue`(64)를 넘으면 자식 파이프를 일시 정지합니다.
  - 한 줄 전달이 reject되거나 `sinkTimeoutMs`(10초)를 넘기면 프로세스 그룹을 종료합니다. 이 경우 실행은 `SCOPE_STATE_UNSAFE`로 실패합니다.
  - 완료 결과는 모든 대기 줄이 전달된 뒤에만 반환합니다. host 검증(`verify`)도 이 실패를 "검사 실패"로 바꾸지 않고 그대로 전달합니다.

## 7. 에이전트 루프

1. **분류와 목적 판정**: 거부되면 스킬·공급자·잠금·상태 파일을 전혀 건드리지 않습니다. `new-game`이나 `resume`이면 `{ handled: false }`를 반환해 기존 파이프라인이 처리합니다.
2. **`mode: 'yolo'` 사전 확인**: `zukujs.json` 게임이어야 하고, root가 주입한 플레이테스트가 있어야 합니다. 기존 배포 어댑터(`lib/agent/adapters.mjs resolveDeploy`)의 `preflight()`와 서버의 6시간 3회 한도도 여기서 확인합니다. 어느 하나라도 실패하면 모델을 호출하지 않습니다.
3. **필수 스킬 5개**: `lib/agent/skills.mjs`의 해시 잠금 스킬 팩을 매 실행 불러와 지시문에 넣고, 스킬별 SHA를 상태 파일에 기록합니다.
4. **실행 준비**: 공유 `.zukujs/agent/run.lock`을 잡고(기존 파이프라인과 같은 잠금), `runs/<run_id>`를 만듭니다.
5. **`scope.plan`**: 목적·설계·아키텍처·검증 계획을 받습니다. 입력은 host가 만든 분류 신호, 매니페스트, 비공개를 뺀 트리 300항목, capability 목록입니다.
6. **`scope.act` 반복**(최대 20턴, 턴당 행동 4개): 각 행동은 host가 검증한 뒤 실행하고, 결과를 관찰로 돌려줍니다. 같은 호출이 3번 연속 나오면 중단합니다.
7. **host 검증**(`done: true`일 때): 내장 validate·package, 사용 가능한 모든 샌드박스 테스트·빌드, root 플레이테스트를 실행합니다. 모든 결과는 하나의 소스 digest에 묶이고, 검증 도중 소스가 바뀌면 실패로 처리합니다. 실패하면 관찰을 돌려주고 수리를 최대 3회 반복합니다.
8. **`draft`/`yolo` 마무리**:
   - 검증된 SHA와 같은 결정적 패키지를 run 디렉터리에 쓰고 소스 digest를 다시 확인합니다.
   - `draft`는 기존 업로드 경로를 사용합니다.
   - `yolo`는 실제 PNG로 디코드되는 썸네일과 함께 `deploy.run`을 **정확히 한 번** 호출합니다. 결과를 알 수 없으면 `AGENT_PUBLISH_OUTCOME_UNKNOWN`으로 기록하고 다시 시도하지 않습니다.
9. **성공과 실패**: 성공하면 diff, 상태 파일, 해시 체인 영수증을 남기고 branded 결과를 반환합니다. 실패하거나 취소되면 3절 방식으로 되돌리고 `verified: false`로 기록합니다.

모델 출력 스키마에는 `tests_passed`, `verified` 같은 주장을 넣을 필드가 없습니다. 그런 필드가 오면 스키마 위반입니다.

기본 한도(`LOOP_LIMITS`):

| 항목 | 기본값 |
| --- | --- |
| 모델 호출 | 26 |
| 토큰 | 2,000,000 |
| 턴 | 20 |
| 수리 | 3 |
| 스키마 재요청 | 1 |
| 스테이지 시간 | 240초 |
| 전체 시간 | 30분 |
| 프롬프트 입력 | 192 KiB(오래된 관찰부터 제거) |
| 도구 호출 | 64 |
| 변경 파일 | 64 |

## 8. 상태와 영수증

```text
.zukujs/agent/run.lock                              단일 실행 잠금(기존 파이프라인과 공유)
.zukujs/agent/runs/<run_id>/scope-run.json          zuku.scope.run/1
.zukujs/agent/runs/<run_id>/scope-receipts.json     zuku.scope.receipt/1, prev 해시 체인
.zukujs/agent/runs/<run_id>/changes.diff            검토용 unified diff
.zukujs/agent/runs/<run_id>/backup-NNN.bin          원본 바이트
.zukujs/agent/runs/<run_id>/scope-package.zwf       배포·업로드용 결정적 패키지(draft/yolo)
.zukujs/agent/runs/<run_id>/thumbnail.png           yolo 플레이테스트 썸네일
```

모든 파일은 기존 `lib/agent/state.mjs`의 검증된 0700 디렉터리에 0600 원자적 쓰기로 저장합니다. `receipt.json`은 만들지 않으므로 기존 `--resume`이 이 실행을 자기 것으로 오인하지 않습니다. 호출 명령 이름(`zuku`/`zukujs`)으로 상태를 나누지 않습니다.

## 9. root 통합 메모

Agent Core(`lib/agent-core/index.mjs`)는 이미 이 모듈을 기본으로 불러옵니다(`classifyWorkspace`, `admitGameRequest`, `createScopedToolRuntime`, `runScopedGameAgent`). 이 서비스는 해당 파일을 수정하지 않았습니다. root가 연결할 항목:

1. **검증 증거**: `createAgentCore({ verifyResult: verifyScopedResult })`. 연결하지 않으면 scoped 실행도 기존 `verifyLegacyResult`만 거치므로 공개 결과가 `verified: false`로 표시됩니다.
2. **YOLO 플레이테스트**: `agentContext.playtest = ({ root, snapshot, signal }) => ({ passed, thumbnail: PNG bytes, observations })`. 기존 `createBrowserPlaytest().run`은 새 게임 계획(`plan`/`script`, `__zukuGame` 훅)이 필요하므로 그대로 넘기지 마세요. 함수가 아니면 무시하고 YOLO를 막습니다.
3. **빌드 형식**: 프로젝트별 빌드 스크립트는 `agentContext.forms`, `toolContext.forms`로 `{ id, kind, file, args }` 형식으로 선언해야 쓸 수 있습니다.
4. **공식 문서 원본**: URL이 확정되면 `docs.sources`로 주입하세요. 기본값은 패키지에 포함된 문서만 씁니다.
5. **draft 업로드**: 기존 `commands/upload.mjs` 경로를 지연 로드합니다. 테스트에서는 `context.upload`로 대체할 수 있습니다.

## 10. 테스트 범위

| 파일 | 종류 |
| --- | --- |
| `tests/agent-scope-classify.test.mjs` | 실제 임시 프로젝트 분류, 목적 판정(거부·단어 우회·허용), 위조 분류 |
| `tests/agent-scope-tools.test.mjs` | 실제 파일 시스템 도구, 경로·링크·비밀·쓰기·매니페스트 정책, Agent Core 직접 호출, 공급자 무관성. 샌드박스는 **명시적 스텁**(실행 안 함) |
| `tests/agent-scope-loop.test.mjs` | **모의 공급자**와 실제 파일·스킬·내장 검증·영수증·잠금·이벤트·YOLO 바인딩. **실제 공급자 레지스트리 + openai-chat 어댑터**를 loopback HTTP로 실행하는 테스트 1개, **실제 bwrap** 검증 테스트 1개 포함 |
| `tests/agent-scope-sandbox.test.mjs` | **실제 bwrap** 실행: 통과·실패, 호스트 비밀·환경·HOME·네트워크 차단, 스냅샷 격리, 시간 초과, 취소, 악성 빌드 스크립트. 대체 경로가 없다는 것은 스텁으로 확인 |
| `tests/agent-scope-durability.test.mjs` | 실제 파일 시스템과 실제 run store에서 순서 보장 확인: 기다린 `tool.requested/started` 거부 시 수정·명령 0건, backup 실패 시 수정 0건, rename 전 원본 backup 완료(영수증 실패 후에도 남음), **실제 bwrap** 빌드 출력의 순서·상한·완료 전 flush, 출력 거부·지연 시 프로세스 종료, 처리되지 않은 Promise 거부 없음. 스텁 샌드박스는 실행 횟수만 셉니다 |
| `tests/agent-scope-core.test.mjs` | **실제 Agent Core**와 모의 공급자로 `game.maintain` 완료·검증 증거, 공급자 확인 전 범위 거부, 브라우저 actor 도구 정책 |

bwrap을 쓸 수 없는 환경에서는 네이티브 테스트를 건너뛰고 사유를 표시합니다. 가짜로 통과시키지 않습니다.

## 11. 출처

Kilo Code(`Kilo-Org/kilocode`, MIT, 커밋 `76bcfd40be616a72f4697b3041565f322245b462`)의 다음 설계를 참고했습니다. 코드는 복사하지 않았고 이 저장소에서 새로 구현했습니다.

| Kilo 경로 | 적용한 패턴 |
| --- | --- |
| `packages/opencode/src/tool/tool.ts` | 도구 정의 = id·설명·매개변수 스키마·execute. 잘못된 인수는 모델에게 "입력을 다시 작성하라"는 관찰로 반환 |
| `packages/opencode/src/permission/index.ts` | deny 우선 평가와 hard ruleset. 여기서는 사용자 확인 없이 host 정책만 적용 |
| `packages/opencode/src/tool/external-directory.ts` | 작업 공간 밖 경로를 기본 허용하지 않음 |
| `packages/opencode/src/session/processor.ts` | 같은 도구·입력이 3회 반복되면 doom-loop로 보고 중단 |
| `packages/opencode/src/session/prompt.ts` | 에이전트 단계 수 상한 |
