# ZukuJS 게임 개발 에이전트 (`zukujs agent`)

`zukujs agent`는 **로컬에서 실행되는** HTML5 게임 개발 에이전트입니다. 새 게임 요청은 설계 → 구조 → 구현 → 검증 → **실제 브라우저 플레이테스트** → 패키징까지 진행하고, `--yolo`를 붙이면 업로드와 **프로덕션 게시**까지 한 번에 끝냅니다. 기존 게임 폴더는 Core의 유지보수 작업으로 처리합니다([통합 CLI](unified-cli.md)). 이 문서는 CLI 0.3.1 기준입니다.

- 로컬 CLI 전용 기능입니다. 호스팅된 웹/클라우드 추론 제공 여부는 정해지지 않았습니다.
- 모델 연결(Codex OAuth)은 **Experimental**이며 ZukuJS의 **비공식(unofficial) 연동**입니다. Codex 자체가 비공식이라는 뜻이 아닙니다.
- `version27` 프레임워크 식별자와 이 CLI 버전(0.3.1)은 서로 다른 값입니다.

## 처음 한 번

```sh
zukujs login zuku                    # ZUKU 계정 (OAuth2 기기 인증, games 범위)
zukujs login codex --experimental    # Codex OAuth 연동 (Experimental, 1회 동의)
```

Codex 로그인은 ZukuJS 자체 OAuth 클라이언트(PKCE/state/nonce)를 쓰며, 기존 Codex CLI 로그인 파일을 읽지 않습니다. 두 자격 증명은 생성된 게임 코드, 모델 입력, 브라우저에 절대 전달되지 않습니다.

## 사용법

```sh
zukujs agent "세 갈래 길에서 떨어지는 블록을 피하는 아케이드 게임"          # 로컬: 검증·플레이테스트·패키지까지
zukujs agent "..." --name lane-dodger                                      # 프로젝트 이름 지정
zukujs agent "..." --draft                                                 # 로컬 + 초안 업로드 (게시 안 함)
zukujs agent "..." --yolo                                                  # 한 번에 게시까지 (아래 참고)
zukujs agent --resume run_20261003120000_0123abcd [--yolo | --draft]       # 기록된 실행 재개
```

| 옵션 | 의미 |
| --- | --- |
| `--name <name>` | 새 프로젝트 디렉터리 이름 (`[a-z0-9][a-z0-9_-]{0,63}`). 이미 있으면 모델 호출 전에 거부합니다. 생략하면 게임 제목에서 만들고, 겹치면 `-2` 같은 접미사를 붙입니다. |
| `--model <id>` | 모델 ID를 제공자에 그대로 전달합니다. 생략하면 제공자 기본값. |
| `--yolo` | 게시까지 진행하는 사용자의 명시적 승인. 추가 확인 질문이 없습니다. |
| `--draft` | 패키지 후 기존 `upload` 경로로 **초안**만 만듭니다. `--yolo`와 함께 쓸 수 없습니다. |
| `--browser <절대경로>` | 설치된 Chromium 실행 파일을 플레이테스트에 사용합니다. |
| `--resume <run_id>` | 기록된 실행을 재검증해 이어 갑니다 (아래 참고). 요청·`--name`·`--model`과 함께 쓸 수 없습니다. |
| `--json` | 루트 진입점이 처리하는 공통 출력 형식입니다. |

알 수 없는 옵션(`--no-skills`, `--skip-playtest` 등), 중복·충돌 옵션, 잘못된 값은 파일 시스템이나 네트워크를 건드리기 전에 `INVALID_INPUT`(종료 코드 2)으로 거부합니다.

**입력과 출력.** 요청을 생략하면 stdin과 stderr가 모두 터미널일 때만 한 줄을 묻고(Ctrl+C로 취소), 비대화형 실행은 기다리지 않고 `AGENT_REQUEST_REQUIRED`로 끝납니다. 결과 데이터는 루트 진입점이 stdout에만 쓰고, 진행 상황(`[zukujs agent] 설계(design) 시작` 등)은 stderr로만 나갑니다. 오류 메시지는 허용된 한국어 코드 메시지뿐이며 모델·제공자·API·브라우저 원문이나 토큰을 담지 않습니다.

## 한 번의 실행 흐름

1. **로컬 검사**: 인수, 요청(4000자 이하, 제어 문자·비밀 값 금지), 스킬 팩 무결성, `--name` 충돌.
2. **`--yolo`만**: 모델 토큰을 쓰기 전에 ZUKU 계정과 권한 있는 `GET /api/v1/oauth/deploy-quota`를 확인합니다. 남은 한도가 0이면 `DEPLOY_QUOTA_EXCEEDED`(+`retry_after`)로 즉시 끝나며 모델을 호출하지 않습니다.
3. **실행 잠금**: `<cwd>/.zukujs/agent/run.lock`으로 같은 디렉터리의 동시 실행을 막습니다(`AGENT_BUSY`). 죽은 로컬 프로세스의 잠금은 한 번 회수합니다.
4. **모델 단계** (도구 호출 없음, 스키마 검증된 JSON만): `design` → `architecture` → `implementation` → `playtest`(입력 스크립트) → `publish`(메타데이터). 각 단계는 필수 스킬 하나에 묶여 있습니다 — [game-skills.md](game-skills.md).
5. **게이트**: 계획·구조·구현·스크립트·메타데이터를 코드가 검사합니다. 실패 코드를 피드백으로 한 번 더 요청할 수 있고, 그래도 실패하면 `AGENT_GATE_FAILED`. 경로 탈출·명령 실행·네트워크·비밀 값이 보이면 재시도 없이 `AGENT_ARTIFACT_UNSAFE`이며 아무것도 쓰지 않습니다.
6. **스테이징**: `.zukujs/agent/runs/<run_id>/staging/<name>`에 실제 `zukujs create` 스캐폴드를 만든 뒤 생성 파일을 `src/` 아래에만 씁니다(`O_EXCL|O_NOFOLLOW`). `zukujs.json`과 README는 CLI가 씁니다. 이어서 `zukujs validate`와 같은 `checkProject`/zwf 승인으로 검증합니다.
7. **실제 플레이테스트**(아래). 실패하면 실패 코드와 함께 구현을 한 번 수정하고, 그래도 실패하면 편집 가능한 프로젝트만 남기고 **패키지·업로드·게시를 하지 않습니다**(`AGENT_PLAYTEST_FAILED`).
8. **게시 정보 → 확정**: 메타데이터를 `zukujs.json`에 반영하고, 플레이테스트한 `src` 다이제스트가 그대로인지 확인한 뒤, 미리 비어 있는 상태로 확보한 `<cwd>/<name>`으로 한 번의 `rename`으로 옮깁니다. 기존 프로젝트는 절대 덮어쓰지 않습니다.
9. **패키징**: 기존 `zukujs package`(결정적 ZWF2)를 그대로 사용합니다.
10. **모드별 마무리**
    - 기본: `status: "packaged"`에서 멈춥니다. **게시하지 않습니다.**
    - `--draft`: 기존 업로드 파이프라인으로 초안을 만듭니다(게시 안 함).
    - `--yolo`: 소스·패키지 다이제스트를 다시 계산해 플레이테스트한 바이트와 같을 때만 `deploy.run(package, { yolo: true, thumbnail, package_sha256 })`을 **정확히 한 번** 호출합니다.

## 실제 브라우저 플레이테스트

플레이테스트는 모델 리뷰가 아니며, Node `vm`을 샌드박스로 쓰지 않습니다.

- 고정 버전 `playwright-core`가 **샌드박스를 켠 Chromium**(`chromiumSandbox: true`; Playwright 기본값은 false)을 실행합니다. `--no-sandbox`로 물러서지 않으므로 root로 실행하면 `AGENT_PLAYTEST_SANDBOX`로 안전하게 실패합니다. 가짜 브라우저 대체 경로는 없습니다.
- 검증된 스냅숏 **바이트**만 `127.0.0.1`의 임의 포트에서 메모리로 제공합니다. Host 헤더를 엄격히 확인하고, `default-src 'none'; script-src 'self'; connect-src 'self'; worker-src 'none' …` CSP를 붙입니다.
- 루프백이 아닌 모든 요청과 WebSocket은 차단(route abort)되고, 서비스 워커는 막혀 있습니다. CSP 위반이나 차단된 외부 요청이 하나라도 있으면 실패입니다.
- 브라우저 자식 프로세스 환경은 `PATH`/로캘 등 최소 허용 목록과 일회용 `HOME`뿐입니다. ZUKU·Codex·API 자격 증명, 실제 홈, 프록시 설정은 전달되지 않습니다.
- 관찰 항목: 진입 페이지 로드, 페이지 오류·콘솔 오류·실패한 같은 출처 요청, DOM HUD/메뉴 존재와 가시성, `window.__zukuGame`(`zuku-hooks/1`) 상태를 **실제 키 입력 후** 읽은 값(menu → 시작 키 → running, tick 증가, HUD 텍스트 변화, `forceLoss()` 후 over + 게임 오버 메뉴 표시, 리셋 키 → running + tick 초기화), 두 스크린샷의 실제 픽셀 차이. 판정은 러너가 아닌 `evaluatePlaytest()`가 관찰값과 PNG 디코딩 결과로만 내립니다.
- 플레이 중 스크린샷(960×540 PNG)이 썸네일이 되며 `.zukujs/agent/runs/<run_id>/thumbnail.png`(패키지 밖)에 SHA-256과 함께 저장되어 `deploy.run`에 전달됩니다.

**브라우저 준비.** `--browser`가 없으면 `playwright-core`가 고정한 Chromium을 찾고, 없으면 그 패키지의 CLI(`node <playwright-core>/cli.js install chromium`)를 셸 없이, 출력 상한과 10분 제한을 두고 한 번 실행합니다(약 150MB 다운로드, 네트워크 필요). 설치가 막힌 환경에서는 `--browser /절대/경로/chrome`을 쓰세요. 브라우저를 쓸 수 없으면 편집 가능한 프로젝트는 남기되 패키지·게시는 하지 않습니다(`AGENT_PLAYTEST_UNAVAILABLE`/`AGENT_PLAYTEST_SANDBOX`). Linux에서 비특권 사용자 네임스페이스가 막힌 경우(일부 AppArmor 설정) Chromium 샌드박스가 시작되지 않을 수 있습니다.

## 엔진

- 기본 2D 엔진은 **Phaser**입니다. CLI 설치본에 `phaser` 패키지가 있을 때만 제공되며, `dist/phaser.min.js`와 라이선스를 프로젝트의 `src/vendor/`에 복사합니다. 게임은 CDN에 의존하지 않습니다.
- 번들이 없거나 게임이 충분히 단순하면 `zukujs create`의 Canvas 스캐폴드 계열을 의도적으로 선택할 수 있고, 선택 이유가 영수증과 README에 남습니다.
- 어느 엔진이든 시뮬레이션 상태는 렌더러 밖(`simulation` 모듈)에 두고, 입력은 `KeyboardEvent.code` 매핑으로 명시하며, HUD·메뉴는 DOM입니다.

## `--yolo`, 한도와 복구

- `--yolo`는 계획부터 게시까지 전체 흐름에 대한 사용자의 명시적 승인입니다. 중간 확인이나 최종 승인 단계가 없습니다. `--yolo`가 없으면 어떤 경우에도 게시하지 않습니다.
- 게시 한도는 **ZUKU 계정당 최근 6시간 동안 성공한 프로덕션 게시 3회**이며 서버가 원자적으로 강제합니다. 같은 계정·콘텐츠·검증된 전체 패키지 SHA-256의 재시도는 한도를 쓰지 않고, 실패하거나 거부된 게시도 한도를 쓰지 않습니다. 네 번째는 `429 DEPLOY_QUOTA_EXCEEDED`와 `Retry-After`를 받습니다. 클라이언트 측 숫자는 보안 경계가 아니며 서버 판정이 우선합니다.
- 게시 요청 전에 영수증 상태를 `publish_attempting`으로 먼저 기록합니다. 시간 초과, 네트워크 오류, 요청 중 취소, 형식이 맞지 않는 응답은 **결과 불명**(`AGENT_PUBLISH_OUTCOME_UNKNOWN`)으로 기록하고 **자동 재시도하지 않습니다**.
- 복구: `zukujs agent --resume <run_id> --yolo`는 먼저 서버에 상태를 조회합니다(`deploy.recover`). 게시됨이면 성공으로 기록하고 다시 보내지 않으며, 게시 안 됨이 확인될 때만 재검증 후 한 번 게시합니다. 조회할 수 없으면 `AGENT_RECOVERY_REQUIRED`로 멈춥니다.
- `--resume`은 프로젝트가 확정된 실행(`packaged`, `publish_rejected`, 결과 불명, `draft_created`)만 재개합니다. 소스와 `zukujs.json` 다이제스트가 기록과 같아야 하고(아니면 `AGENT_SOURCE_CHANGED`), 실제 플레이테스트를 다시 통과해야 하며, 다시 만든 패키지 SHA-256이 기록과 같아야 합니다. 모델은 호출하지 않습니다.
- `SIGINT`/`SIGTERM`은 진행 중인 모델·브라우저 작업을 중단하고, 게시 전이면 아무것도 게시되지 않습니다.

## 상한

| 항목 | 상한 |
| --- | --- |
| 요청 | 4000자 |
| 모델 호출 | 실행당 10회 (단계당 최대 2회, 플레이테스트 수정 1회) |
| 토큰 | 보고된 사용량 합계 600,000 |
| 단계 출력 | 96 KiB (구현 단계 1.6 MB) |
| 생성 파일 | 48개, 파일당 512 KiB, 합계 1.5 MB, `src/` 아래 텍스트 확장자만 |
| 단계 시간 | 단계당 240초, 플레이테스트 120초, 브라우저 실행 30초 |

## 로컬 상태와 영수증

`<cwd>/.zukujs/agent/`(0700, 링크 불가)에는 `run.lock`과 `runs/<run_id>/receipt.json`(0600, 원자적 쓰기), `thumbnail.png`가 있습니다. 영수증에는 상태, 단계별 결과·출처·스킬 이름/버전/SHA-256·사용량·출력 SHA-256·게이트 코드, 플레이테스트 판정과 측정값, 다이제스트, 한도 스냅숏, 안전한 게시 ID만 기록됩니다. 요청 원문은 저장하지 않고 SHA-256만 남기며, 비밀 값처럼 보이는 내용이 있으면 쓰기를 거부합니다.

## 통합 경계 (루트 진입점용)

`commands/agent.mjs`는 `export default agent(args, context)`와 `parseAgentArgs`, `runGameAgent`, `resumeGameAgent`를 내보냅니다. `context`는 `{ cwd, signal, stdin, stdout, stderr, provider, deploy, playtest, upload, onEvent, interactive }`이며, 주입되지 않은 기본 어댑터만 지연 로딩합니다.

- `provider.runStage({ experimental: true, stage, model, instructions, input, outputSchema, signal })` → `{ stage, output, usage, provider, experimental: true, unofficial: true }`
- `deploy.preflight({ signal })` → 한도 객체 또는 `{ quota }`; `deploy.run(packagePath, { signal, yolo: true, receiptDir, thumbnail, package_sha256, project_root })` → `{ status: 'published', content_id, url?, idempotent? }`; 선택 `deploy.recover({ run_id, package_sha256, signal })` → `{ status: 'published' | 'not_published', content_id? }`
- `playtest.run({ snapshot, plan, script, signal })` → 관찰값. 주입된 러너는 영수증에 `injected`로 기록되어 실제 브라우저 QA와 구분됩니다.

## 검증 범위

- 자동 테스트: `tests/agent-*.test.mjs`. 오케스트레이션·남용 테스트는 스크립트된 제공자와 **모의(mock) 플레이테스트 러너**를 씁니다.
- 실제 브라우저 테스트(`ZUKUJS_LIVE_BROWSER=1`, root가 아닌 사용자)는 샌드박스 Chromium으로 고정 게임, 적대적 게임(외부 요청·WebSocket·서비스 워커), 깨진 게임, Phaser 변형, 전체 에이전트 흐름을 실행합니다.
- 실제 Codex OAuth 제공자와 실제 ZUKU 게시·한도 API를 상대로 한 종단 간 실행은 이 모듈의 테스트에 포함되지 않습니다.
