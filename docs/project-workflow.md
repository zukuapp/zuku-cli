# 프로젝트 작업 흐름

`create` → `validate` → `package`는 로컬에서만 동작합니다. `upload`는 패키지를 올리고 **초안** JUMP 콘텐츠를 만듭니다. 공개(publish)는 CLI가 하지 않는 별도 동작입니다.

`validate`, `package`, `upload`는 같은 코어(`checkProject`, `inspectProject`, `inspectPackageFile`)를 공유하므로 세 명령의 검사 결과가 일치합니다.

## create

```sh
zukujs create catch-game
```

이름 규칙: 소문자 영문·숫자·`_`·`-`, 최대 64자. 생성 파일:

| 파일 | 내용 |
| --- | --- |
| `zukujs.json` | 프로젝트 매니페스트(`zukujs-project/1`) |
| `src/index.html` | 진입점 |
| `src/game.js` | 플레이 가능한 캔버스 받기 게임 |
| README | 프로젝트 안내 |
| `.gitignore` | 출력물·로컬 파일 제외 |

## 매니페스트 `zukujs.json` (`zukujs-project/1`)

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `schema` | 예 | `"zukujs-project/1"` |
| `name` | 예 | 프로젝트 이름 |
| `title` | 예 | 표시 제목 |
| `version` | 예 | 패키지 버전 |
| `description` | 아니요 | 설명 |
| `tags` | 아니요 | 태그 목록 |
| `age_rating` | 아니요 | `all`, `12`, `15`, `18` |
| `source` | 아니요 | 소스 디렉터리, 기본 `src` |
| `entry` | 아니요 | 진입 파일, 기본 `index.html` |
| `jump` | 아니요 | `{ game_id, genre, platform: { pc, mobile?, tablet? } }` |
| `package` | 아니요 | `{ format: "zwf" \| "zip", exclude: [상대 경로...] }` |

예시(값은 설명용):

```json
{
  "schema": "zukujs-project/1",
  "name": "catch-game",
  "title": "Catch Game",
  "version": "1.0.0",
  "jump": { "game_id": "catch-game", "genre": "arcade", "platform": { "pc": true, "mobile": true } },
  "package": { "format": "zwf", "exclude": [] }
}
```

`zukujs.json`은 CLI 로컬 형식입니다. Next2D `jump-manifest.schema.json`, ZWF2 컨테이너 매니페스트, API `jump` 메타데이터와 다른 스키마입니다.

## validate

```sh
zukujs validate .                 # 프로젝트 디렉터리
zukujs validate dist/game.zwf     # 패키지 파일(.zwf 또는 .zip)
```

## package

```sh
zukujs package . --format zwf
zukujs package . --format zip -o build/game.zip --force
```

기본 출력은 `dist/<name>-<version>.<format>`입니다. 기존 파일은 `--force` 없이 덮어쓰지 않습니다.

### 패키지 규칙

- 경로 정렬, 고정 타임스탬프로 결정적(재현 가능) 출력. ZWF2는 MIT 라이선스 `zukuapp/zwf` 0.1.0 구현(고지 포함)으로 만듭니다.
- 거부: 심볼릭 링크, 하드 링크, 경로 탈출(traversal), 특수 파일, 네이티브 실행 파일, 대소문자 충돌, 압축 해제 예산을 넘는 아카이브.
- 프로젝트 코드나 메타데이터의 빌드 명령을 실행하지 않습니다.
- 해시 무결성은 게시자 서명이 아니며, 권한 선언은 방화벽 보장이 아닙니다.

### ZWF2 형식

16바이트 헤더(ASCII `ZWF2`, 리틀 엔디언 uint16 버전 `2`, uint16 플래그 `0`, uint32 JSON 길이, uint32 ZIP 길이) + UTF-8 JSON 매니페스트 + ZIP, 뒤에 남는 바이트 없음. 매니페스트는 `format: "zwf"`, `version: 2`, `profile: "html5-sandbox/2"`, `entry_point`, `title`, `permissions: { network: "package-only", storage: "none" }`, `zip_sha256`, `files[{ path, size, sha256 }]`을 담습니다.

공개 검증 예산: 항목 8,000개, ZIP 500 MiB, 멤버당 압축 해제 128 MiB, 전체 압축 해제 512 MiB, JSON 2 MiB, 1 MiB 이상 멤버의 압축비 80:1.

## upload (초안 생성)

```sh
zukujs upload .                                    # 디렉터리: 같은 코어로 패키지 생성 후 업로드
zukujs upload dist/game.zwf --title "Catch Game" --platform pc,mobile --tag arcade --verify
```

1. **패키지 준비**: 디렉터리는 `package`와 같은 코어로 패키지를 만듭니다. 메타데이터는 정규화된 `zukujs.json`에서 가져오고 플래그가 우선합니다.
2. **`POST /api/v1/uploads`**: multipart 파일 파트 하나, 길이를 미리 계산한 요청(전체 500 MiB 이하). 응답 `data.upload`의 `size`·`sha256`·`kind`·`mime`·진입점·검사(`scan`)·파일 수, 그리고 업로드 URL이 같은 서비스 origin의 `/uploads/...`인지 로컬 파일과 대조합니다. 응답의 `package.format`은 서비스가 판정한 **실행(승인) 형식**입니다. ZIP은 `html5`(검증된 `.wasm` 멤버가 있으면 `wasm`), ZWF는 `zwf`이며, CLI는 로컬에서 검증한 파일로 기대 형식을 계산해 정확히 일치하는지 확인합니다. ZIP의 `kind`는 `archive`, MIME은 `application/zip`입니다.
3. **`POST /api/v1/contents`**: `jump.status: "draft"`, `publish_to_thread: false`로 초안을 만들고 `data.content.id`와 초안 상태를 확인합니다. 초안의 `jump.package.format`은 패키지 파일 형식(`zip` 또는 `zwf`)이며, 업로드 응답의 실행 형식(`html5`/`wasm`/`zwf`)과 다른 값입니다.
4. **`--verify`(선택)**: 소유자 권한으로 `GET /api/v1/contents/{id}`를 호출해 초안을 다시 확인합니다.

`POST /contents/{id}/publish`는 호출하지 않습니다. 초안은 공개 목록에 나타나지 않지만 `/uploads/...` 파일 URL은 공개 주소입니다.

### 재시도와 영수증

- 두 요청은 원자적이지 않으며 서버에 멱등 키·롤백 엔드포인트가 없습니다. CLI는 변경 요청을 자동으로 재시도하지 않습니다.
- 결과가 모호한 경우(5xx, 408, 전송 실패)는 재시도하지 않고 그 결과를 영수증에 기록합니다. 다시 실행하기 전에 초안이 이미 생겼는지 확인하세요.
- 영수증은 기본 `.zukujs/receipts`(또는 `--receipt-dir`)에 현재 사용자 소유, 권한 `0600` 파일로 저장합니다. 정리된 결과만 담고 토큰·자격 증명·개인화된 전체 응답은 담지 않습니다.
- 프로젝트를 저장소에 올린다면 `.zukujs/`를 커밋하지 마세요.

### 오류

HTTP 상태와 검증된 API 오류 코드를 그대로 보고합니다. 주요 코드: 400 `BAD_REQUEST`/`UNSAFE_PACKAGE`/`INVALID_PACKAGE`, 401 `UNAUTHORIZED`, 403 `ACCOUNT_SUSPENDED`/`GAME_UPLOAD_UNSUPPORTED`/`CSRF_REJECTED`, 413 `PAYLOAD_TOO_LARGE`, 415 `UNSUPPORTED_MEDIA_TYPE`, 422 `VALIDATION_ERROR`/`MALWARE_DETECTED`, 500 `INTERNAL_ERROR`, 503 `STORAGE_UNAVAILABLE`/`UPLOAD_UNAVAILABLE`. 모든 422를 같은 원인으로 가정하지 마세요.

## 공개(publish)

공개는 이 CLI 범위 밖입니다. 서비스의 `POST /api/v1/contents/{id}/publish`는 소유자가 명시적으로 호출해야 하며, 첫 공개 시각을 유지하고 Thread 글을 중복 생성하지 않습니다.
