# 명령 참조

명령 이름은 `zukujs`입니다(`@zukujs/cli` 0.2.0). 모든 명령에 `--json`을 붙이면 `zuku-command/1` 봉투로 출력합니다.

## 명령 요약

| 명령 | 네트워크 | 설명 |
| --- | --- | --- |
| `zukujs help` (`--help`, `-h`) | 없음 | 명령 안내 |
| `zukujs version` (`--version`, `-v`) | 없음 | ZukuJS 런타임 버전과 CLI 버전 |
| `zukujs status`, `zukujs diagnostics` | 없음 | 로컬 설정·자격 증명 상태 |
| `zukujs status --check-api` | 읽기 전용 GET | 공개 목록과(토큰이 있으면) 사용자 인증 확인 |
| `zukujs create <name>` | 없음 | 새 프로젝트 생성 |
| `zukujs validate <path>` | 없음 | 프로젝트 디렉터리 또는 `.zwf`/`.zip` 검사 |
| `zukujs package <dir>` | 없음 | 재현 가능한 `.zwf`/`.zip` 생성 |
| `zukujs upload <path>` | 업로드·초안 생성 | 패키지 업로드 후 초안 JUMP 콘텐츠 생성 |

## create

```sh
zukujs create <name>
```

- `<name>`: 소문자 영문·숫자·`_`·`-`, 최대 64자.
- 새 디렉터리 `<name>/`에 `zukujs.json`, `src/index.html`, `src/game.js`, README, `.gitignore`를 만듭니다. 결과물은 플레이 가능한 캔버스 받기 게임입니다.

## validate

```sh
zukujs validate <dir | file.zwf | file.zip>
```

- 디렉터리: `zukujs.json`을 정규화하고 소스 파일을 패키지 규칙으로 검사합니다.
- `.zwf`/`.zip`: 공개 ZWF 검증 규칙으로 패키지를 검사합니다.
- 프로젝트 코드를 실행하지 않습니다.

## package

```sh
zukujs package <dir> [--format zwf|zip] [--output <file> | -o <file>] [--force]
```

| 플래그 | 기본값 | 설명 |
| --- | --- | --- |
| `--format` | 매니페스트 값, 없으면 `zwf` | 출력 형식(`zwf` 또는 `zip`). 명시한 플래그가 매니페스트 `package.format`보다 우선합니다 |
| `--output`, `-o` | `dist/<name>-<version>.<format>` | 출력 파일 경로 |
| `--force` | 꺼짐 | 기존 출력 파일 덮어쓰기 |

경로 정렬과 고정 타임스탬프로 같은 입력에서 같은 바이트를 만듭니다. 거부 규칙은 [프로젝트 작업 흐름](project-workflow.md#패키지-규칙)을 보세요.

## upload

```sh
zukujs upload <dir | file.zwf | file.zip> [옵션]
```

| 플래그 | 설명 |
| --- | --- |
| `--title <text>` | 제목(1–100자) |
| `--description <text>` | 설명(500자 이하) |
| `--game-id <id>` | `jump.game_id`(클라이언트 메타데이터, 콘텐츠 ID 아님) |
| `--genre <genre>` | `jump.genre` |
| `--version <version>` | 패키지 버전(`jump.package.version`) |
| `--age-rating all\|12\|15\|18` | 연령 등급 |
| `--tag <tag>` | 태그, 반복 지정, 최대 10개 |
| `--platform pc,mobile,tablet` | 실제 지원하는 플랫폼(쉼표 구분) |
| `--receipt-dir <dir>` | 영수증 디렉터리(기본 `.zukujs/receipts`) |
| `--verify` | 생성 후 소유자 권한으로 초안을 다시 조회해 확인 |

- 디렉터리를 주면 `package`와 같은 코어로 패키지를 만든 뒤 업로드합니다. 메타데이터는 정규화된 `zukujs.json`에서 가져오고, 플래그가 있으면 플래그가 우선합니다.
- `upload`는 공개(publish)하지 않습니다. 자세한 흐름은 [프로젝트 작업 흐름](project-workflow.md#upload-초안-생성)을 보세요.

## status / diagnostics

```sh
zukujs status [--check-api]
```

기본 실행은 네트워크 없이 런타임·CLI 버전, API 주소, 자격 증명 설정 여부를 보고합니다. `--check-api`는 `GET /billing/catalog`(익명)과, 토큰이 있으면 `GET /auth/me`를 호출합니다. 계정 ID·이메일·토큰은 출력하지 않습니다.

## 출력 형식 (`zuku-command/1`)

| 경우 | 스트림 | 형식 |
| --- | --- | --- |
| 성공, `--json` | stdout | `{"success":true,"data":...,"meta":{...}}` 한 줄 |
| 성공, 일반 | stdout | 봉투 없는 출력 |
| 실패, `--json` | stderr | `{"success":false,"error":{"code","message"},"meta":{...}}` 한 줄 |
| 실패, 일반 | stderr | `CODE: message` |

## 종료 코드

| 코드 | 의미 |
| --- | --- |
| 0 | 성공 |
| 1 | 실패(검증·패키지·자격 증명·API 오류 등) |
| 2 | 인수 오류(`INVALID_INPUT`), 알 수 없는 명령(`UNKNOWN_COMMAND`) |
| 130 | 사용자 취소(`COMMAND_CANCELLED`, Ctrl+C) |

서버 오류는 HTTP 상태와 검증된 API 오류 코드(예: `UNAUTHORIZED`, `INVALID_PACKAGE`, `PAYLOAD_TOO_LARGE`, `VALIDATION_ERROR`)로 보고하며, 원격 응답 전문이나 헤더를 출력하지 않습니다.
