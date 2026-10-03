# 인증과 서비스 엔드포인트

## 토큰 기밀성 원칙

- 사용자 bearer 토큰을 명령 인수, 프로젝트 파일, 패키지, 저장소, 이슈, 로그, 화면 공유에 넣지 마세요. CLI는 토큰을 인수로 받지 않습니다.
- CLI는 토큰을 출력·저장·갱신·발급하지 않으며 응답 쿠키를 저장하지 않습니다. 업로드 영수증에도 자격 증명이 들어가지 않습니다.
- 서비스 HMAC 비밀키(내부 프로토콜 `zuku-hmac/1`)는 CLI에서 읽거나 전송하지 않습니다.
- 개발자 API 키는 업로드에 쓸 수 없습니다. 업로드와 초안 생성은 같은 사용자 bearer 토큰을 씁니다.

## 토큰을 읽는 순서

1. `ZUKUJS_ACCESS_TOKEN`
2. `ZUKU_ACCESS_TOKEN` (이전 이름, 명시적 별칭)
3. 자격 증명 파일: `ZUKUJS_CREDENTIALS_FILE` → `ZUKU_CREDENTIALS_FILE`(이전 이름, 명시적 별칭) → 기본값 `~/.config/zukujs/credentials.json`

이전 기본 경로 `~/.config/zuku/credentials.json`은 자동으로 읽지 않습니다. 기존 파일을 새 경로로 옮기거나 `ZUKUJS_CREDENTIALS_FILE`로 지정하세요.

## 자격 증명 파일 (Linux/macOS)

```json
{ "access_token": "<사용자 토큰>" }
```

- 절대 경로, 현재 사용자 소유의 일반 파일, 권한 `0600`, 심볼릭·하드 링크 아님, 16 KiB 이하, 키는 `access_token` 하나.
- 기본 경로에 파일이 없으면 토큰 없이 진행합니다. 환경 변수로 지정한 파일이 없으면 오류입니다.
- 처음부터 소유자 전용으로 만드세요. 예: `mkdir -p ~/.config/zukujs && (umask 077 && touch ~/.config/zukujs/credentials.json)` 후 편집기로 토큰을 입력합니다. `echo`로 쓰면 셸 기록에 남습니다.
- Windows에서는 파일 권한을 검증할 수 없으므로 환경 변수를 사용하세요.

## API 주소

`https://www.zuzunza.com/api/v1`로 고정되어 있으며 바꿀 수 없습니다. 자격 증명이 실린 요청은 리디렉션을 따르지 않고, 쿠키·브라우저 기능 보고·CSRF 토큰을 보내지 않습니다.

## CLI가 호출하는 엔드포인트

| 요청 | 명령 | 인증 |
| --- | --- | --- |
| `GET /billing/catalog` | `status --check-api` | 항상 익명 |
| `GET /auth/me` | `status --check-api`(토큰이 있을 때) | Bearer |
| `POST /uploads` | `upload` | Bearer |
| `POST /contents` | `upload` | Bearer |
| `GET /contents/{id}` | `upload --verify` | Bearer(소유자) |

`POST /contents/{id}/publish`(공개)는 호출하지 않습니다. 자세한 요청·응답 확인 규칙은 [프로젝트 작업 흐름](project-workflow.md#upload-초안-생성)에 있습니다.

## 참고 자료

- 서비스 API 안내: <https://docs.zuzunza.com/>
- 공개 API 초안 [`zukuapp/zuku-api`](https://github.com/zukuapp/zuku-api)는 기본 경로가 운영 `/api/v1`과 다르고 업로드 API가 빠져 있습니다. CLI는 운영 `/api/v1` 경로를 따릅니다.
